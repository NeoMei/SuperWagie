import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveElectronDevMode } from './electron-dev-mode.mjs';

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
