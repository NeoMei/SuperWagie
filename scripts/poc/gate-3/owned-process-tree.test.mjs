import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { runOwnedCapture } from './review-isolation-gate.mjs';

test('owned capture follows delayed descendants and detects a forbidden path held only by a child', async () => {
  const fixture = await processFixture('owned');
  const result = await runOwnedCapture(fixture.executable, {
    ...process.env, ...fixture.environment, TEST_HELD_PATH: fixture.forbidden
  }, 8_000);
  assert.equal(result.code, 0);
  assert.ok(result.ownedPidCount >= 2, `ownedPidCount=${result.ownedPidCount}`);
  assert.ok(result.ownedPidCount <= 4, `owned process fixture recursively expanded: ${result.ownedPidCount}`);
  const childEvidence = process.platform === 'win32' ? result.probes.process : result.probes.paths;
  assert.ok(
    childEvidence.forbidden_matches.some((value) => value.includes('.codex')),
    JSON.stringify(result)
  );
  assert.doesNotMatch(JSON.stringify(result.probes), new RegExp(fixture.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('owned capture keeps following the process group after its leader exits', async () => {
  const fixture = await processFixture('leader-exit', { leaderExitsImmediately: true });
  const result = await runOwnedCapture(fixture.executable, {
    ...process.env, ...fixture.environment, TEST_HELD_PATH: fixture.forbidden
  }, 5_000);
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.probeFailed, false);
  assert.ok(result.ownedPidCount >= 2, `ownedPidCount=${result.ownedPidCount}`);
  assert.ok(
    result.probes.paths.forbidden_matches.some((value) => value.includes('.codex')),
    JSON.stringify(result)
  );
});

test('owned capture does not scan or interrupt an unrelated process with a forbidden open path', async () => {
  const fixture = await processFixture('unrelated');
  const unrelated = spawn(process.execPath, ['-e', 'const fs=require("fs"); fs.openSync(process.env.TEST_HELD_PATH,"r"); setTimeout(()=>process.exit(0),800)'], {
    env: { ...process.env, TEST_HELD_PATH: fixture.forbidden }, stdio: 'ignore'
  });
  const unrelatedExit = new Promise((resolve, reject) => unrelated.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`unrelated exit ${code}`))));
  const clean = path.join(fixture.root, 'clean-parent.mjs');
  await writeFile(clean, 'setTimeout(() => process.exit(0), 450);\n');
  const result = await runOwnedCapture(process.execPath, {
    ...process.env,
    NODE_OPTIONS: `--import=${pathToFileURL(clean).href}`
  }, 4_000);
  assert.equal(result.code, 0);
  assert.deepEqual(result.probes.paths.forbidden_matches, []);
  await unrelatedExit;
});

async function processFixture(label, { leaderExitsImmediately = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), `superwagie-process-tree-${label}-`));
  const forbiddenRoot = path.join(root, '.codex');
  const forbidden = path.join(forbiddenRoot, 'held.txt');
  await mkdir(forbiddenRoot);
  await writeFile(forbidden, 'held');
  const parent = path.join(root, 'parent.mjs');
  await writeFile(parent, leaderExitsImmediately ? `
import { spawn } from 'node:child_process';
const descendant = spawn(process.execPath, ['-e', 'const fs=require("fs"); fs.openSync(process.argv[1],"r"); setTimeout(()=>process.exit(0),1500)', process.env.TEST_HELD_PATH], { env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'ignore' });
descendant.unref();
setTimeout(() => process.exit(0), 20);
` : `
import { spawn } from 'node:child_process';
spawn(process.execPath, ['-e', 'setTimeout(()=>{const fs=require("fs"); fs.openSync(process.argv[1],"r")},150); setTimeout(()=>process.exit(0),4500)', process.env.TEST_HELD_PATH], { env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'ignore' });
setTimeout(() => process.exit(0), 3000);
`);
  return {
    root,
    forbidden,
    executable: process.execPath,
    environment: { NODE_OPTIONS: `--import=${pathToFileURL(parent).href}` }
  };
}
