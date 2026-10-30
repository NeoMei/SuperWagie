import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectMachO, runtimeFiles, verifySourceArchive } from './prepare-intel-opencode.mjs';

const macho = (architecture, major) => {
  const buffer = Buffer.alloc(56);
  buffer.writeUInt32LE(0xfeedfacf, 0);
  buffer.writeUInt32LE(architecture === 'x64' ? 0x01000007 : 0x0100000c, 4);
  buffer.writeUInt32LE(1, 16);
  buffer.writeUInt32LE(24, 20);
  buffer.writeUInt32LE(1, 40);
  buffer.writeUInt32LE(0x32, 32);
  buffer.writeUInt32LE(24, 36);
  buffer.writeUInt32LE(major << 16, 44);
  return buffer;
};

test('reads architecture and deployment target from retained Mach-O assets', () => {
  assert.deepEqual(inspectMachO(macho('x64', 12)), { architecture: 'x64', minimumVersion: '12.0.0' });
  assert.deepEqual(inspectMachO(macho('arm64', 13)), { architecture: 'arm64', minimumVersion: '13.0.0' });
  assert.equal(inspectMachO(Buffer.from('JavaScript')), undefined);
  const truncated = macho('x64', 12);
  truncated.writeUInt32LE(64, 36);
  assert.throws(() => inspectMachO(truncated), /load.command/);
});

test('rejects a modified upstream source archive before extraction', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intel-source-lock-'));
  try {
    const file = path.join(root, 'source.tar.gz');
    fs.writeFileSync(file, 'modified archive');
    assert.throws(() => verifySourceArchive(file), /SHA-256 mismatch/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('fixed launcher removes Electron flag and supports child_process.fork through its sibling node', async () => {
  if (process.platform === 'win32') return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'intel-wrapper-'));
  try {
    const resources = path.join(root, '犇马.app/Contents/Resources/opencode-cli');
    const executable = path.join(root, '犇马.app/Contents/MacOS/犇马');
    fs.mkdirSync(resources, { recursive: true });
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
    fs.writeFileSync(executable, `#!/bin/sh\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o755 });
    for (const [name, contents] of Object.entries(runtimeFiles())) fs.writeFileSync(path.join(resources, name), contents, { mode: 0o755 });
    fs.writeFileSync(path.join(resources, 'child.mjs'), `process.send({flag:process.env.ELECTRON_RUN_AS_NODE??null,executable:process.execPath});`);
    fs.writeFileSync(path.join(resources, 'opencode.mjs'), `
      import {fork} from 'node:child_process';
      import path from 'node:path';
      const child = fork(path.join(import.meta.dirname,'child.mjs'), [], {stdio:['ignore','ignore','pipe','ipc']});
      child.on('message', (result) => console.log(JSON.stringify({parentFlag:process.env.ELECTRON_RUN_AS_NODE??null,...result})));
    `);
    const result = spawnSync(path.join(resources, 'opencode'), ['--version'], { encoding: 'utf8', timeout: 10000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', OPENCODE_BINARY: '/invalid/not-used' } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { parentFlag: null, flag: null, executable: fs.realpathSync(path.join(resources, 'node')) });
    const tui = spawnSync(path.join(resources, 'opencode'), [], { encoding: 'utf8' });
    assert.equal(tui.status, 64);
    assert.match(tui.stderr, /Use SuperWagie/);
    const updater = spawnSync(path.join(resources, 'opencode'), ['upgrade'], { encoding: 'utf8' });
    assert.equal(updater.status, 64);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
