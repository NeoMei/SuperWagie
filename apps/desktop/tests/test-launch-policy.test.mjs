import assert from 'node:assert/strict';
import test from 'node:test';
import { isBackgroundUiTest } from '../src/main/test-launch-policy.mjs';

test('only an explicit unpackaged UI test can suppress native activation', () => {
  const enabled = { SUPERWAGIE_TEST_MODE: '1', SUPERWAGIE_TEST_BACKGROUND: '1' };
  assert.equal(isBackgroundUiTest(false, enabled), true);
  assert.equal(isBackgroundUiTest(true, enabled), false);
  for (const env of [{}, { SUPERWAGIE_TEST_BACKGROUND: '1' },
    { SUPERWAGIE_TEST_MODE: '1' },
    { ...enabled, SUPERWAGIE_TEST_BACKGROUND: '0' },
    { ...enabled, SUPERWAGIE_TEST_MODE: 'true' }]) {
    assert.equal(isBackgroundUiTest(false, env), false);
  }
});
