import { describe, expect, test } from 'bun:test';
import { isManagedModelScopeRestartRequired } from './managedModelError';

describe('managed model restart refusal', () => {
  test('identifies the session API error without classifying other failures', () => {
    expect(isManagedModelScopeRestartRequired(new Error('session.prompt failed (403): platform_model_scope_restart_required'))).toBe(true);
    expect(isManagedModelScopeRestartRequired('platform_model_scope_restart_required')).toBe(true);
    expect(isManagedModelScopeRestartRequired(new Error('platform_model_scope_restart_required_extra'))).toBe(false);
    expect(isManagedModelScopeRestartRequired(new Error('unexpected status'))).toBe(false);
  });
});
