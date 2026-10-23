import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildSwapScript,
  findAppBundle,
  hashFile,
  validateStagedApp,
  verifyDownload,
} from './macos-self-update.mjs';

const withTemp = async (fn) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sw-mac-update-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test('accepts a download that matches the feed and rejects tampering', async () => {
  await withTemp(async (dir) => {
    const file = path.join(dir, 'update.zip');
    await writeFile(file, 'release-bytes');
    const { sha256, size } = await hashFile(file);
    assert.equal(size, 13);

    await verifyDownload({ file, sha256, size });

    await assert.rejects(
      verifyDownload({ file, sha256: 'a'.repeat(64), size }),
      /checksum/,
    );
    await assert.rejects(
      verifyDownload({ file, sha256, size: size + 1 }),
      /expected 14/,
    );
  });
});

test('finds exactly one app bundle in the unpacked update', async () => {
  await withTemp(async (dir) => {
    await mkdir(path.join(dir, '犇马.app'));
    assert.equal(await findAppBundle(dir), path.join(dir, '犇马.app'));

    await mkdir(path.join(dir, 'second.app'));
    await assert.rejects(findAppBundle(dir), /found 2/);
  });
});

test('rejects a staged bundle that is a different app or version', async () => {
  const readPlist = async () => ({ CFBundleIdentifier: 'com.superwagie.app', CFBundleShortVersionString: '2.8.0' });

  await validateStagedApp({
    stagedAppPath: '/tmp/any.app',
    expectedVersion: '2.8.0',
    expectedBundleId: 'com.superwagie.app',
    readPlist,
  });

  await assert.rejects(
    validateStagedApp({
      stagedAppPath: '/tmp/any.app',
      expectedVersion: '2.8.1',
      expectedBundleId: 'com.superwagie.app',
      readPlist,
    }),
    /expected 2.8.1/,
  );
  await assert.rejects(
    validateStagedApp({ stagedAppPath: '/tmp/any.app', expectedBundleId: 'com.other.app', readPlist }),
    /Unexpected app/,
  );
});

test('the swap script replaces the bundle and restores it when the copy fails', async () => {
  await withTemp(async (dir) => {
    const appPath = path.join(dir, 'SuperWagie.app');
    const stagedAppPath = path.join(dir, 'staged.app');
    const backupPath = path.join(dir, 'backup.app');
    const logPath = path.join(dir, 'swap.log');
    const scriptPath = path.join(dir, 'swap.sh');

    await mkdir(appPath);
    await writeFile(path.join(appPath, 'old.txt'), 'old');
    await mkdir(stagedAppPath);
    await writeFile(path.join(stagedAppPath, 'new.txt'), 'new');

    const script = buildSwapScript({
      appPath,
      stagedAppPath,
      backupPath,
      pid: 999999,
      logPath,
      openCommand: '/usr/bin/true',
    });
    await writeFile(scriptPath, script);

    const run = spawnSync('/bin/sh', [scriptPath], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);

    assert.equal(await readFile(path.join(appPath, 'new.txt'), 'utf8'), 'new');
    await assert.rejects(readFile(path.join(appPath, 'old.txt'), 'utf8'));
    assert.match(await readFile(logPath, 'utf8'), /installed/);
  });
});

test('the swap script puts the old bundle back when copying the new one fails', async () => {
  await withTemp(async (dir) => {
    const appPath = path.join(dir, 'SuperWagie.app');
    const backupPath = path.join(dir, 'backup.app');
    const logPath = path.join(dir, 'swap.log');
    const scriptPath = path.join(dir, 'swap.sh');

    await mkdir(appPath);
    await writeFile(path.join(appPath, 'old.txt'), 'old');

    const script = buildSwapScript({
      appPath,
      stagedAppPath: path.join(dir, 'missing.app'),
      backupPath,
      pid: 999999,
      logPath,
      openCommand: '/usr/bin/true',
    });
    await writeFile(scriptPath, script);

    const run = spawnSync('/bin/sh', [scriptPath], { encoding: 'utf8' });
    assert.notEqual(run.status, 0);
    assert.equal(await readFile(path.join(appPath, 'old.txt'), 'utf8'), 'old');
    assert.match(await readFile(logPath, 'utf8'), /restoring/);
  });
});
