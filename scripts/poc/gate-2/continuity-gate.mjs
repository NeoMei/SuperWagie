import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Checker, argValue, writeResults, envFail, rmrf } from '../gate-1/lib.mjs';

const FIXTURE_ID = 'G2-CONTINUITY-001';
const fixture = argValue(process.argv, '--fixture');
const resultsPath = argValue(process.argv, '--results-json');
const artifactsDir = argValue(process.argv, '--artifacts-dir');
if (fixture !== FIXTURE_ID || !resultsPath) {
  envFail('usage: continuity-gate.mjs --fixture ' + FIXTURE_ID + ' --results-json <path> [--artifacts-dir <dir>]');
}

const startedAt = new Date().toISOString();
const checker = new Checker();
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'superwagie-g2-continuity-'));

try {
  const eventLogPath = path.join(tmpBase, 'events.jsonl');
  const cursorPath = path.join(tmpBase, 'cursor.json');
  const auditPath = path.join(tmpBase, 'audit.jsonl');

  let appendSeq = 0;
  function appendEvent(type, payload) {
    appendSeq += 1;
    const ev = { seq: appendSeq, type: type, payload: payload, at: new Date().toISOString() };
    fs.appendFileSync(eventLogPath, JSON.stringify(ev) + '\n');
    return ev;
  }
  function readEvents() {
    return fs.readFileSync(eventLogPath, 'utf8').trim().split('\n').filter(Boolean).map(function (l) { return JSON.parse(l); });
  }
  function readCursor() {
    if (!fs.existsSync(cursorPath)) return { last_seq: 0 };
    return JSON.parse(fs.readFileSync(cursorPath, 'utf8'));
  }
  function writeCursor(seq) {
    fs.writeFileSync(cursorPath, JSON.stringify({ last_seq: seq }) + '\n');
  }
  function audit(entry) {
    fs.appendFileSync(auditPath, JSON.stringify(Object.assign({ at: new Date().toISOString() }, entry)) + '\n');
  }

  // ---- check 1: monotonic seq, cursor read returns only increments ----
  for (let i = 1; i <= 10; i += 1) appendEvent('note', { index: i });
  const events = readEvents();
  const seqs = events.map(function (e) { return e.seq; });
  let monotonic = seqs.length === 10;
  for (let i = 0; i < seqs.length; i += 1) {
    if (seqs[i] !== i + 1) monotonic = false;
  }
  const incremental = events.filter(function (e) { return e.seq > 6; }).map(function (e) { return e.seq; });
  const incrOk = monotonic && incremental.join(',') === '7,8,9,10';
  checker.check('ct:monotonic-seq', incrOk, 'seqs=' + seqs.join(',') + ' after_cursor6=' + incremental.join(','));

  // ---- check 2: crash mid-stream, resume from persisted cursor, exactly-once ----
  const run1 = [];
  let crashed = false;
  try {
    const cursor0 = readCursor().last_seq;
    const pending = events.filter(function (e) { return e.seq > cursor0; });
    for (const ev of pending) {
      run1.push(ev.seq);
      writeCursor(ev.seq);
      if (run1.length >= 4) throw new Error('simulated crash after 4 events');
    }
  } catch (e) {
    crashed = true;
  }
  const run2 = [];
  const cursorAfterCrash = readCursor().last_seq;
  const pending2 = events.filter(function (e) { return e.seq > cursorAfterCrash; });
  for (const ev of pending2) {
    run2.push(ev.seq);
    writeCursor(ev.seq);
  }
  const all = run1.concat(run2);
  const unique = new Set(all);
  const exactlyOnce = crashed && cursorAfterCrash === 4 && all.length === 10 && unique.size === 10 && readCursor().last_seq === 10;
  checker.check('ct:cursor-exactly-once', exactlyOnce, 'crash_after4=' + crashed + ' resume_from=' + cursorAfterCrash + ' processed=' + all.length + ' unique=' + unique.size);

  // ---- proposal/apply state machine ----
  const doc = { rev: 1, content: '初始项目回顾' };
  function createProposal(id, baseRev, newContent) {
    const p = { id: id, base_rev: baseRev, new_content: newContent, status: 'proposed' };
    audit({ kind: 'proposal', proposal_id: id, base_rev: baseRev });
    return p;
  }
  function applyProposal(p) {
    if (p.status !== 'proposed') {
      audit({ kind: 'rejected-duplicate', proposal_id: p.id, status: p.status });
      return { ok: false, reason: 'status:' + p.status };
    }
    if (p.base_rev !== doc.rev) {
      p.status = 'conflict';
      audit({ kind: 'conflict', proposal_id: p.id, expected_base: p.base_rev, actual_rev: doc.rev });
      return { ok: false, reason: 'conflict', actual_rev: doc.rev };
    }
    doc.content = p.new_content;
    doc.rev += 1;
    p.status = 'applied';
    audit({ kind: 'applied', proposal_id: p.id, new_rev: doc.rev });
    return { ok: true, new_rev: doc.rev };
  }

  // ---- check 3: first apply ok, duplicate apply rejected ----
  const p1 = createProposal('p1', 1, '第一次修订后的项目回顾');
  const a1 = applyProposal(p1);
  const dup = applyProposal(p1);
  const dupOk = a1.ok === true && doc.rev === 2 && dup.ok === false && p1.status === 'applied';
  checker.check('ct:apply-duplicate', dupOk, 'first=' + a1.ok + ' new_rev=' + doc.rev + ' duplicate_reason=' + dup.reason);

  // ---- check 4: stale base rejected as conflict, rebase then success ----
  const p2 = createProposal('p2', 1, '基于过期版本的修订');
  const c1 = applyProposal(p2);
  const conflictOk = c1.ok === false && c1.reason === 'conflict' && p2.status === 'conflict';
  p2.base_rev = doc.rev;
  p2.status = 'proposed';
  const a2 = applyProposal(p2);
  const rebaseOk = conflictOk && a2.ok === true && doc.rev === 3;
  checker.check('ct:conflict-rebase', rebaseOk, 'conflict=' + conflictOk + ' rebased_apply=' + a2.ok + ' final_rev=' + doc.rev);

  // ---- check 5: audit contains proposal/applied/conflict ----
  const auditLines = fs.readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean).map(function (l) { return JSON.parse(l); });
  const kinds = auditLines.map(function (a) { return a.kind; });
  const countKind = function (k) { return kinds.filter(function (x) { return x === k; }).length; };
  const auditOk = countKind('proposal') === 2 && countKind('applied') === 2 && countKind('conflict') === 1 && countKind('rejected-duplicate') === 1;
  checker.check('ct:audit-complete', auditOk, 'proposal=' + countKind('proposal') + ' applied=' + countKind('applied') + ' conflict=' + countKind('conflict') + ' rejected_dup=' + countKind('rejected-duplicate'));

  if (artifactsDir) {
    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.copyFileSync(auditPath, path.join(artifactsDir, 'audit.jsonl'));
    fs.writeFileSync(path.join(artifactsDir, 'continuity-summary.json'), JSON.stringify({
      events_total: seqs.length,
      run1_processed: run1,
      run2_processed: run2,
      final_cursor: readCursor().last_seq,
      doc_final: doc
    }, null, 2) + '\n');
  }

  const pass = writeResults(resultsPath, {
    gate: 'gate-2',
    fixture: FIXTURE_ID,
    startedAt: startedAt,
    checker: checker,
    decisionHint: 'GO',
    limitation: null,
    metrics: { checks: checker.summary, final_cursor: readCursor().last_seq }
  });
  console.log((pass ? 'PASS' : 'FAIL') + ' ' + FIXTURE_ID + ' checks=' + JSON.stringify(checker.summary));
  rmrf(tmpBase);
  process.exit(pass ? 0 : 1);
} catch (e) {
  console.error('ERROR executor: ' + (e && e.stack ? e.stack : String(e)));
  rmrf(tmpBase);
  process.exit(2);
}
