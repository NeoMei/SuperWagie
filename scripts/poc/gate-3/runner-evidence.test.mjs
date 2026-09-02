import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { copyChecklistEvidence, redactedGateCommand } from './runner-evidence.mjs';

test('standard command evidence hashes checklist bytes and redacts its path', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'superwagie-runner-checklist-command-'));
  const checklist = path.join(root, 'private-checklist.json');
  await writeFile(checklist, '{"ok":true}\n');
  const command = redactedGateCommand({
    gate: 'gate-3', platform: 'macos-15-arm64', fixture: 'G3-REVIEW-001',
    wpsPython: '/Users/private/WpsComposer/.venv/bin/python',
    wpsComposerRoot: '/Users/private/WpsComposer',
    wpsApplication: '/Applications/WPS Office.app',
    checklist, baselineResults: '/Users/private/results.json'
  });
  assert.doesNotMatch(command, /\/Users\/|WpsComposer\/|checklist\.json|results\.json/);
  assert.match(command, /wps-python-sha256:[0-9a-f]{64}/);
  assert.match(command, /checklist-content-sha256:e5f1eb4d806641698a35efe20e098efd20d7d57a9b90ee69079d5bb650920726/);
  assert.doesNotMatch(command, /checklist-sha256:|checklist-path-sha256:/);
  assert.match(command, /wps-application-sha256:[0-9a-f]{64}/);
});

test('evaluation command evidence hashes file bytes rather than the private path token', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'superwagie-runner-command-'));
  const evaluationResult = path.join(root, 'private-evaluation.json');
  await writeFile(evaluationResult, '{"fixture":"G3-PPT-WPS-MACOS-SMOKE-001"}\n');
  const command = redactedGateCommand({
    gate: 'gate-3',
    platform: 'macos-15-arm64',
    fixture: 'G3-PPT-WPS-MACOS-SMOKE-001',
    evaluationResult,
  });
  assert.match(command, /evaluation-result-content-sha256:de111a68ed1da908f388771939800cabae21174a77b51eb6cea8d4bf0c51444b/);
  assert.doesNotMatch(command, /evaluation-result-sha256:/);
  assert.doesNotMatch(command, /private-evaluation/);
});

test('command evidence file creation is exclusive and cannot overwrite a collision', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'superwagie-command-exclusive-'));
  const destination = path.join(root, 'command.txt');
  await writeFile(destination, 'sentinel\n');
  const args = [
    path.resolve(import.meta.dirname, 'runner-evidence.mjs'),
    'redact-command-file', destination,
    'gate-1', 'macos-15-arm64', 'G1-MARKDOWN-001', '', '', '', '', '', '', '', '', '', '', '', '', ''
  ];
  const collision = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.notEqual(collision.status, 0, collision.stdout);
  assert.equal(await readFile(destination, 'utf8'), 'sentinel\n');

  const fresh = path.join(root, 'fresh-command.txt');
  const created = spawnSync(process.execPath, [args[0], args[1], fresh, ...args.slice(3)], { encoding: 'utf8' });
  assert.equal(created.status, 0, created.stderr || created.stdout);
  assert.match(await readFile(fresh, 'utf8'), /^gate:gate-1 platform:macos-15-arm64 fixture:G1-MARKDOWN-001/);
});

test('screenshot copying rejects symlink escape and destination basename collisions', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'superwagie-runner-evidence-'));
  const checklistRoot = path.join(root, 'checklist');
  const destination = path.join(root, 'screenshots');
  await mkdir(checklistRoot);
  await mkdir(destination);
  await writeFile(path.join(root, 'outside.png'), 'outside');
  await symlink(path.join(root, 'outside.png'), path.join(checklistRoot, 'escape.png'));
  const checklist = path.join(checklistRoot, 'checklist.json');
  await writeFile(checklist, JSON.stringify({ evidence: ['escape.png'] }));
  await assert.rejects(copyChecklistEvidence(checklist, destination), /symlink|regular|contain/i);
  await assert.rejects(readFile(path.join(destination, 'escape.png')));

  await mkdir(path.join(checklistRoot, 'one'));
  await mkdir(path.join(checklistRoot, 'two'));
  await writeFile(path.join(checklistRoot, 'one', 'same.png'), 'one');
  await writeFile(path.join(checklistRoot, 'two', 'same.png'), 'two');
  await writeFile(checklist, JSON.stringify({ evidence: ['one/same.png', 'two/same.png'] }));
  await assert.rejects(copyChecklistEvidence(checklist, destination), /collision/i);
});

test('screenshot copying accepts only contained regular files and returns path-free receipts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'superwagie-runner-contained-'));
  const checklistRoot = path.join(root, 'checklist');
  const destination = path.join(root, 'screenshots');
  await mkdir(checklistRoot);
  await mkdir(destination);
  await writeFile(path.join(checklistRoot, 'page.png'), 'page');
  const checklist = path.join(checklistRoot, 'checklist.json');
  await writeFile(checklist, JSON.stringify({ evidence: ['page.png'] }));
  assert.deepEqual(await copyChecklistEvidence(checklist, destination), [
    { name: 'page.png', sha256: '3660315a9af3df255d8f19ab077e4797822b41488a0e2a04bc6af71213c23274' }
  ]);
});
