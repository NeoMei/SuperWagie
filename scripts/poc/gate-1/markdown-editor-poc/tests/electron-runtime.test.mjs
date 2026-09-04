import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

test('resolves the packaged Electron executable on Windows, macOS and Linux', async () => {
  const runtime = await import('../scripts/electron-runtime.mjs').catch(() => null);
  assert.ok(runtime, 'cross-platform Electron runtime resolver must exist');

  const root = join('workspace', 'markdown-editor-poc');
  assert.equal(
    runtime.resolveElectronBinary(root, 'win32'),
    join(root, 'node_modules/electron/dist/electron.exe'),
  );
  assert.equal(
    runtime.resolveElectronBinary(root, 'darwin'),
    join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
  );
  assert.equal(
    runtime.resolveElectronBinary(root, 'linux'),
    join(root, 'node_modules/electron/dist/electron'),
  );
});
