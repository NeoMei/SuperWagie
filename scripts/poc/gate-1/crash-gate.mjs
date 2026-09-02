import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Checker, argValue, writeResults, envFail, rmrf } from './lib.mjs';

const FIXTURE_ID = 'G1-CRASH-001';
const selfPath = fileURLToPath(import.meta.url);
const FILES = ['a.md', 'b.md', 'c.md'];

function journalPath(project) {
  return path.join(project, '.superwagie', 'journal.json');
}

function fsyncFile(p) {
  const fd = fs.openSync(p, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function tryFsyncDir(p) {
  try {
    const fd = fs.openSync(p, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (e) {
    // directory fsync is not supported on all platforms; noted in evidence
  }
}

function writeJournal(project, journal) {
  const jp = journalPath(project);
  fs.mkdirSync(path.dirname(jp), { recursive: true });
  fs.writeFileSync(jp, JSON.stringify(journal, null, 2));
  fsyncFile(jp);
  tryFsyncDir(path.dirname(jp));
}

function killSelf() {
  process.kill(process.pid, 'SIGKILL');
}

function workerMain(project, payload) {
  const txn = payload.phase + '-' + crypto.randomUUID();
  const tdir = path.join(project, '.superwagie', 'tmp', txn);
  fs.mkdirSync(tdir, { recursive: true });
  const ops = [];
  for (let i = 0; i < FILES.length; i++) {
    const tmp = path.join(tdir, String(i) + '.tmp');
    fs.writeFileSync(tmp, 'NEW-' + i + '-' + txn.slice(0, 8));
    fsyncFile(tmp);
    ops.push({ temp: tmp, target: path.join(project, FILES[i]) });
  }
  tryFsyncDir(tdir);
  writeJournal(project, { txn: txn, state: 'prepared', ops: ops });
  if (payload.phase === 'prepared') killSelf();
  writeJournal(project, { txn: txn, state: 'committing', ops: ops });
  let applied = 0;
  for (const op of ops) {
    fs.renameSync(op.temp, op.target);
    applied++;
    if (payload.phase === 'committing' && applied === payload.crashAfter) killSelf();
  }
  writeJournal(project, { txn: txn, state: 'committed', ops: ops });
  if (payload.phase === 'committed') killSelf();
  fs.rmSync(tdir, { recursive: true, force: true });
  fs.rmSync(journalPath(project), { force: true });
}

function runWorker(project, phase, crashAfter) {
  const payload = JSON.stringify({ phase: phase, crashAfter: crashAfter || 0 });
  return spawnSync(process.execPath, [selfPath, '--worker', '--project', project, '--payload', payload], { encoding: 'utf8' });
}

function recover(project) {
  const jp = journalPath(project);
  if (!fs.existsSync(jp)) return 'clean';
  const j = JSON.parse(fs.readFileSync(jp, 'utf8'));
  if (j.state === 'prepared') {
    for (const op of j.ops) rmrf(path.dirname(op.temp));
    fs.rmSync(jp, { force: true });
    return 'rolled-back';
  }
  if (j.state === 'committing' || j.state === 'committed') {
    for (const op of j.ops) {
      if (fs.existsSync(op.temp)) {
        fs.renameSync(op.temp, op.target);
      } else {
        const content = fs.readFileSync(op.target, 'utf8');
        if (content.indexOf('NEW-') !== 0) throw new Error('inconsistent target: ' + op.target);
      }
    }
    rmrf(path.join(project, '.superwagie', 'tmp'));
    fs.rmSync(jp, { force: true });
    return j.state === 'committing' ? 'rolled-forward' : 'committed-confirmed';
  }
  throw new Error('unknown journal state: ' + j.state);
}

const fixture = argValue(process.argv, '--fixture');
const resultsPath = argValue(process.argv, '--results-json');
const isWorker = argValue(process.argv, '--worker');

if (isWorker) {
  const project = argValue(process.argv, '--project');
  const payload = JSON.parse(argValue(process.argv, '--payload'));
  if (!project || !payload) envFail('worker requires --project and --payload');
  workerMain(project, payload);
  process.exit(0);
}

if (fixture !== FIXTURE_ID || !resultsPath) {
  envFail('usage: crash-gate.mjs --fixture ' + FIXTURE_ID + ' --results-json <path>');
}

const startedAt = new Date().toISOString();
const checker = new Checker();
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'superwagie-g1-crash-'));

try {
  function freshProject(tag) {
    const project = path.join(tmpBase, 'proj-' + tag);
    fs.mkdirSync(project, { recursive: true });
    for (let i = 0; i < FILES.length; i++) fs.writeFileSync(path.join(project, FILES[i]), 'BASE-' + i);
    return project;
  }

  function contentState(project) {
    return FILES.map(function (f) {
      return fs.readFileSync(path.join(project, f), 'utf8').split('-')[0];
    });
  }

  const scenarios = [
    { tag: 'prepared', phase: 'prepared', expect: 'BASE', expectRecovery: 'rolled-back' },
    { tag: 'committing', phase: 'committing', crashAfter: 1, expect: 'NEW', expectRecovery: 'rolled-forward' },
    { tag: 'committed', phase: 'committed', expect: 'NEW', expectRecovery: 'committed-confirmed' },
    { tag: 'clean', phase: null, expect: 'NEW', expectRecovery: 'clean' }
  ];

  let noPartial = true;
  for (const sc of scenarios) {
    const project = freshProject(sc.tag);
    const run = runWorker(project, sc.phase, sc.crashAfter || 0);
    const workerEndedAsExpected = sc.phase ? run.signal === 'SIGKILL' : run.status === 0;
    const preState = contentState(project);
    let recovery = 'error';
    let recoveryError = null;
    try {
      recovery = recover(project);
    } catch (e) {
      recoveryError = e.message;
    }
    const postState = contentState(project);
    const uniform = postState.every(function (s) { return s === sc.expect; });
    const baseLike = preState.every(function (s) { return s === 'BASE' || s === 'NEW'; });
    if (!baseLike) noPartial = false;
    checker.check(
      'crash:' + sc.tag,
      workerEndedAsExpected && recovery === sc.expectRecovery && uniform,
      sc.tag + ' endedAsExpected=' + workerEndedAsExpected + ' recovery=' + recovery +
        (recoveryError ? ' recoveryError=' + recoveryError : '') +
        ' state=' + postState.join(',') + ' preRecovery=' + preState.join(',')
    );
    const again = recover(project);
    const stateAfter2 = contentState(project);
    const idempotent = again === 'clean' && stateAfter2.join(',') === postState.join(',');
    checker.check('crash:idempotent-' + sc.tag, idempotent, 'secondRecovery=' + again + ' state=' + stateAfter2.join(','));
    if (!uniform) noPartial = false;
  }
  checker.check('crash:invariant-no-partial', noPartial, 'after recovery every scenario is all-old or all-new; no mixed state');
} finally {
  rmrf(tmpBase);
}

const pass = writeResults(resultsPath, {
  gate: 'gate-1',
  fixture: FIXTURE_ID,
  startedAt: startedAt,
  checker: checker,
  decisionHint: 'GO',
  limitation: null
});
process.exitCode = pass ? 0 : 1;
