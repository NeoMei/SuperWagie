import { describe, expect, test } from 'bun:test';
import { isManagedModelScopeRestartRequired, isManagedModelDispatchSuspended, isManagedModelFundingRequired, isManagedModelRequestTooLarge } from './managedModelError';

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

test('recognizes the owned funding refusal without treating other payment errors as recoverable', () => {
  expect(isManagedModelFundingRequired('', '{"error":{"code":"platform_model_funding_required"}}')).toBe(true);
  expect(isManagedModelFundingRequired('session.prompt failed (402): platform_model_funding_required')).toBe(true);
  expect(isManagedModelFundingRequired('', '{"error":{"message":"platform_model_funding_required"}}')).toBe(false);
  expect(isManagedModelFundingRequired('402 insufficient_quota')).toBe(false);
  expect(isManagedModelFundingRequired('platform_gateway_request_too_large')).toBe(false);
  expect(isManagedModelFundingRequired('', '{"error":{"code":"platform_gateway_request_too_large"}}')).toBe(false);
});

test('recognizes the owned gateway size refusal in messages and response bodies', () => {
  expect(isManagedModelRequestTooLarge('platform_gateway_request_too_large')).toBe(true);
  expect(isManagedModelRequestTooLarge('session.prompt failed (413): platform_gateway_request_too_large')).toBe(true);
  expect(isManagedModelRequestTooLarge('', '{"error":{"code":"platform_gateway_request_too_large"}}')).toBe(true);
});

test('keeps unrelated or malformed size errors outside the managed gateway explanation', () => {
  for (const message of ['413 Request Entity Too Large', 'platform_request_too_large', 'platform_gateway_request_too_large_extra', 'platform_model_funding_required']) {
    expect(isManagedModelRequestTooLarge(message)).toBe(false);
  }
  for (const body of ['{', '{"error":{"message":"platform_gateway_request_too_large"}}', '{"error":{"code":"platform_gateway_request_too_large_extra"}}', '{"error":{"code":"platform_gateway_request_too_large"},"padding":"' + 'x'.repeat(4096) + '"}']) {
    expect(isManagedModelRequestTooLarge('', body)).toBe(false);
  }
});

test('credit funding evidence selects credits while legacy cash and unrelated errors retain their targets', async () => {
  expect(isManagedModelFundingRequired('platform_model_credits_required')).toBe(true);
  const { managedModelFundingMode } = await import('./managedModelError');
  expect(managedModelFundingMode('platform_model_credits_required')).toBe('credits');
  expect(managedModelFundingMode('', '{"error":{"code":"platform_model_funding_required","asset":"CREDIT/6"}}')).toBe('credits');
  expect(managedModelFundingMode('platform_model_funding_required')).toBe('prepaid_cash');
  expect(managedModelFundingMode('platform_model_credits_required_extra')).toBe('prepaid_cash');
});
