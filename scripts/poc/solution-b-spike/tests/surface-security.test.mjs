import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const root = resolve(import.meta.dirname, '..');

function exposedPreloadBridge(additionalArguments = []) {
  const source = readFileSync(join(root, 'src', 'surface-preload.cjs'), 'utf8');
  let exposed;
  const context = vm.createContext({
    process: { argv: ['electron', 'surface', ...additionalArguments] },
    require(name) {
      assert.equal(name, 'electron');
      return {
        contextBridge: { exposeInMainWorld(_name, value) { exposed = value; } },
        ipcRenderer: { invoke() { throw new Error('not invoked'); } },
      };
    },
  });
  vm.runInContext(source, context);
  return exposed;
}

test('production surface preferences do not enable Node in subframes or the attack bridge', () => {
  const manager = readFileSync(join(root, 'src', 'surface-manager.mjs'), 'utf8');
  const main = readFileSync(join(root, 'src', 'electron-main.mjs'), 'utf8');

  assert.doesNotMatch(manager, /nodeIntegrationInSubFrames\s*:\s*true/);
  assert.match(manager, /constructor\(\{\s*root,\s*core,\s*selfTest\s*=\s*false\s*\}\)/);
  assert.match(manager, /selfTest\s*\?\s*\[['"]--surface-self-test=true['"]\]\s*:\s*\[\]/);
  assert.match(main, /selfTest:\s*process\.argv\.includes\(['"]--self-test['"]\)/);
  assert.match(manager, /if\s*\(!this\.selfTest\)\s*throw new Error\(['"]SURFACE_SELF_TEST_DISABLED['"]\)/);
});

test('preload exposes the attack bridge only with the explicit self-test argument', () => {
  const productionBridge = exposedPreloadBridge([
    '--surface-identity=app_ui:surface-1',
    '--surface-nonce=nonce',
    '--surface-type=app_ui',
  ]);
  assert.equal(productionBridge.attack, undefined);
  assert.equal(typeof productionBridge.probe, 'function');
  assert.equal(typeof productionBridge.snapshot, 'function');

  const testBridge = exposedPreloadBridge([
    '--surface-identity=app_ui:surface-1',
    '--surface-nonce=nonce',
    '--surface-type=app_ui',
    '--surface-self-test=true',
  ]);
  assert.equal(typeof testBridge.attack?.invoke, 'function');
});
