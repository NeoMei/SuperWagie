import { expect, it } from 'vitest';
import { isWorkflowFeatureAvailable } from './feature-flag.js';
it('makes workflows available without the legacy environment gate', () => {
  expect(isWorkflowFeatureAvailable()).toBe(true);
});
