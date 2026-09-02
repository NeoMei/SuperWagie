import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { runOwnedCapture } from './review-isolation-gate.mjs';

test('owned capture follows delayed descendants and detects a forbidden path held only by a child', async () => {
  const fixture = await processFixture('owned');
  const result = await runOwnedCapture(fixture.parent, { ...process.env, TEST_HELD_PATH: fixture.forbidden }, 8_000);
  assert.equal(result.code, 0);
  assert.ok(result.ownedPidCount >= 2, `ownedPidCount=${result.ownedPidCount}`);
  assert.ok(result.probes.paths.forbidden_matches.some((value) => value.includes('.codex')));
  assert.doesNotMatch(JSON.stringify(result.probes), new RegExp(fixture.root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('owned capture does not scan or interrupt an unrelated process with a forbidden open path', async () => {
  const fixture = await processFixture('unrelated');
  const unrelated = spawn(process.execPath, ['-e', 'const fs=require("fs"); fs.openSync(process.env.TEST_HELD_PATH,"r"); setTimeout(()=>process.exit(0),800)'], {
    env: { ...process.env, TEST_HELD_PATH: fixture.forbidden }, stdio: 'ignore'
  });
  const unrelatedExit = new Promise((resolve, reject) => unrelated.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`unrelated exit ${code}`))));
  const clean = path.join(fixture.root, 'clean-parent');
  await writeFile(clean, `#!${process.execPath}\nsetTimeout(() => process.exit(0), 450);\n`);
  await chmod(clean, 0o700);
  const result = await runOwnedCapture(clean, process.env, 4_000);
  assert.equal(result.code, 0);
  assert.deepEqual(result.probes.paths.forbidden_matches, []);
  await unrelatedExit;
});

async function processFixture(label) {
  const root = await mkdtemp(path.join(tmpdir(), `superwagie-process-tree-${label}-`));
  const forbiddenRoot = path.join(root, '.codex');
  const forbidden = path.join(forbiddenRoot, 'held.txt');
  await mkdir(forbiddenRoot);
  await writeFile(forbidden, 'held');
  const parent = path.join(root, 'parent');
  await writeFile(parent, `#!${process.execPath}
import { spawn } from 'node:child_process';
setTimeout(() => {
  spawn(process.execPath, ['-e', 'setTimeout(()=>{const fs=require("fs"); fs.openSync(process.env.TEST_HELD_PATH,"r")},150); setTimeout(()=>process.exit(0),1800)'], { env: process.env, stdio: 'ignore' });
  process.exit(0);
}, 180);
setTimeout(() => process.exit(3), 1200);
`);
  await chmod(parent, 0o700);
  return { root, forbidden, parent };
}
