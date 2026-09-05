import test from 'node:test';
import assert from 'node:assert/strict';

import { runUiLifecycle } from '../scripts/ui-lifecycle.mjs';

test('real Electron UI completes the local Markdown lifecycle', {
  skip: process.env.SUPERWAGIE_RUN_UI_TESTS !== '1',
  timeout: 120_000,
}, async () => {
  const result = await runUiLifecycle();
  assert.equal(Object.values(result.checks).every(Boolean), true);
  assert.equal(result.admission_effect, 'none');
});
