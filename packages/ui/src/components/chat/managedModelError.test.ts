import { describe, expect, test } from 'bun:test';
import { isManagedModelScopeRestartRequired, isManagedModelDispatchSuspended } from './managedModelError';

describe('managed model restart refusal', () => {
  test('identifies the session API error without classifying other failures', () => {
    expect(isManagedModelScopeRestartRequired('session.prompt failed (403): platform_model_scope_restart_required')).toBe(true);
    expect(isManagedModelScopeRestartRequired('platform_model_scope_restart_required')).toBe(true);
    expect(isManagedModelScopeRestartRequired('platform_model_scope_restart_required_extra')).toBe(false);
    expect(isManagedModelScopeRestartRequired('unexpected status')).toBe(false);
  });
});

describe('managed dispatch suspension', () => {
  test('recognizes the exact refusal without matching other codes', () => {
    expect(isManagedModelDispatchSuspended('session.prompt failed (503): platform_dispatch_suspended')).toBe(true);
    expect(isManagedModelDispatchSuspended('platform_dispatch_suspended_extra')).toBe(false);
    expect(isManagedModelDispatchSuspended('unexpected status')).toBe(false);
  });
});
