import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveElectronDevMode, resolveElectronDevEnvironment } from './electron-dev-mode.mjs';

test('desktop development keeps HMR manual by default', () => {
  assert.deepEqual(resolveElectronDevMode({}), {
    startHmr: false,
    useBundledUi: true,
  });
});

test('explicit HMR development starts the HMR server', () => {
  assert.deepEqual(resolveElectronDevMode({ OPENCHAMBER_ELECTRON_AUTO_START_HMR: '1' }), {
    startHmr: true,
    useBundledUi: false,
  });
});

test('bundled UI remains selected when explicitly requested', () => {
  assert.deepEqual(resolveElectronDevMode({
    OPENCHAMBER_ELECTRON_USE_BUNDLED_UI: '1',
    OPENCHAMBER_ELECTRON_AUTO_START_HMR: '1',
  }), {
    startHmr: false,
    useBundledUi: true,
  });
});

test('HMR and bundled development share private storage and require a staged engine', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'superwagie-dev-private-'));
  const electronDir = path.join(root, 'electron');
  const cliDir = path.join(electronDir, 'resources', 'opencode-cli');
  const dataDir = path.join(root, 'data');
  const env = { OPENCHAMBER_DATA_DIR: dataDir, OPENCODE_HOST: 'http://127.0.0.1:4096', OPENCHAMBER_BUNDLED_OPENCODE_CLI_DIR: '/system/bin' };
  try {
    assert.throws(() => resolveElectronDevEnvironment({ env, electronDir }), /bundled OpenCode CLI missing/);
    fs.mkdirSync(cliDir, { recursive: true });
    fs.writeFileSync(path.join(cliDir, process.platform === 'win32' ? 'opencode.exe' : 'opencode'), 'test engine');
    for (const mode of [{ OPENCHAMBER_ELECTRON_AUTO_START_HMR: '1' }, { OPENCHAMBER_ELECTRON_USE_BUNDLED_UI: '1' }]) {
      const child = resolveElectronDevEnvironment({ env: { ...env, ...mode }, electronDir });
      assert.equal(child.OPENCHAMBER_RUNTIME, 'desktop');
      assert.equal(child.OPENCHAMBER_BUNDLED_OPENCODE_CLI_DIR, cliDir);
      assert.equal(child.OPENCODE_CONFIG_DIR, path.join(dataDir, 'opencode-private', 'config'));
      assert.equal(child.OPENCODE_HOST, undefined);
    }
    assert.equal(env.OPENCODE_HOST, 'http://127.0.0.1:4096');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
