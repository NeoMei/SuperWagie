import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs, { watch as importedWatch } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { fixWindowsFolderWatches } from './windows-folder-watch.mjs';

const withPatch = async (platform, run, original = fs.watch) => {
  const real = fs.watch;
  fs.watch = original;
  try {
    fixWindowsFolderWatches(platform);
    await run();
  } finally {
    fs.watch = real;
    syncBuiltinESMExports();
  }
};

test('closes a Windows watch that reports its own deleted folder and keeps one that reports a file', async () => {
  let closed = 0;
  const fake = () => Object.assign(new EventEmitter(), { close: () => { closed += 1; } });
  await withPatch('win32', () => {
    const watcher = importedWatch('C:\\work\\project', () => {});
    watcher.emit('change', 'rename', 'HEAD');
    watcher.emit('change', 'change', null);
    assert.equal(closed, 0);
    watcher.emit('change', 'rename', '\\\\?\\C:\\work\\project');
    assert.equal(closed, 1);
    importedWatch('C:\\work\\project', { encoding: 'ascii' }).emit('change', 'rename', '\\file');
    assert.equal(closed, 1);
  }, fake);
});

test('leaves other platforms alone', async () => {
  const real = fs.watch;
  await withPatch('linux', () => assert.equal(fs.watch, real));
});

test('installs the close listener only for default and utf8 watch encodings', async () => {
  const folder = fs.mkdtempSync(path.join(tmpdir(), 'oc-watch-encoding-'));
  try {
    await withPatch('win32', () => {
      const cases = [
        [undefined, 1], [{}, 1], ['utf8', 1], [{ encoding: 'utf8' }, 1],
        ['ascii', 0], [{ encoding: 'ascii' }, 0], ['buffer', 0], [{ encoding: 'buffer' }, 0], ['utf-8', 0],
      ];
      for (const [options, listeners] of cases) {
        const watcher = importedWatch(folder, options);
        try {
          assert.equal(watcher.listenerCount('change'), listeners);
        } finally {
          watcher.close();
        }
      }
      assert.throws(() => importedWatch(folder, 'not-an-encoding'), { code: 'ERR_INVALID_ARG_VALUE' });
    });
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('a deleted folder stops sending events', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  await withPatch('win32', async () => {
    const folder = fs.mkdtempSync(path.join(tmpdir(), 'oc-deleted-watch-'));
    const names = [];
    let closed = false;
    const watcher = importedWatch(folder, { recursive: false }, (_event, name) => { names.push(name); });
    watcher.on('close', () => { closed = true; });
    try {
      await sleep(200);
      fs.writeFileSync(path.join(folder, 'HEAD'), 'x');
      await sleep(300);
      assert.ok(names.includes('HEAD'));
      assert.equal(closed, false);
      fs.rmSync(folder, { recursive: true });
      for (let waited = 0; !closed && waited < 5000; waited += 50) await sleep(50);
      assert.equal(closed, true);
    } finally {
      watcher.close();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});
