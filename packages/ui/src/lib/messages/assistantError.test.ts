import { describe, expect, test } from 'bun:test';

import type { AssistantMessage, StructuredError } from '@/lib/opencode/model';

import { dict as en } from '@/lib/i18n/messages/en';
import { dict as zh } from '@/lib/i18n/messages/zh-CN';

import { assistantErrorNotice, isStoppedTurnError } from './assistantError';

const assistant = (error?: StructuredError): AssistantMessage => ({
  id: 'msg_1',
  sessionID: 'ses_1',
  role: 'assistant',
  time: { created: 1 },
  agent: 'build',
  providerID: 'anthropic',
  modelID: 'claude',
  error,
});

describe('isStoppedTurnError', () => {
  test('reads the abort OpenCode records for a stopped step as a stop', () => {
    // Pressing Stop makes OpenCode record an error on the assistant message:
    // type `MessageAbortedError`, message "Step interrupted". It is not a send
    // failure, so the transcript must not call it one.
    expect(isStoppedTurnError('MessageAbortedError', 'Step interrupted')).toBe(true);
    expect(isStoppedTurnError('MessageAbortedError', '')).toBe(true);
  });

  test('recognises the interruption by its message when only the v2 type survives', () => {
    // A reload projects the stored error, which carries `type` but no `name`;
    // the detail is all the classifier sees.
    expect(isStoppedTurnError(undefined, 'Step interrupted')).toBe(true);
    expect(isStoppedTurnError(undefined, 'Step interrupted.')).toBe(true);
  });

  test('keeps the locally synthesized stop shape', () => {
    // `interruptedTurnToolParts` closes an interrupted turn itself with
    // `{ type: "aborted", message: "aborted" }`.
    expect(isStoppedTurnError(undefined, 'aborted')).toBe(true);
    expect(isStoppedTurnError(undefined, '  ABORTED  ')).toBe(true);
  });

  test('leaves a real failure that merely mentions aborting as a failure', () => {
    // A dropped connection is not the user pressing Stop, and telling them it
    // was would hide the reason their turn ended.
    expect(isStoppedTurnError(undefined, 'Connection aborted')).toBe(false);
    expect(isStoppedTurnError('UnknownError', 'Stream aborted by the provider')).toBe(false);
    expect(isStoppedTurnError(undefined, 'Model unavailable')).toBe(false);
  });

});

describe('assistantErrorNotice', () => {
  test('does not call a stopped turn a failed send', () => {
    // The reported symptom: Stop produced "Opencode failed to send message
    // with error: Step interrupted" even though the message was delivered and
    // the user stopped the step on purpose.
    const notice = assistantErrorNotice(assistant({ type: 'MessageAbortedError', message: 'Step interrupted' }));
    expect(notice).toEqual({ key: 'chat.assistantError.stopped', detail: 'Step interrupted' });
  });

  test('keeps the stop sentence for the local close this client writes', () => {
    expect(assistantErrorNotice(assistant({ type: 'aborted', message: 'aborted' })))
      .toEqual({ key: 'chat.assistantError.stopped', detail: 'aborted' });
  });

  test('still names a real failure as one', () => {
    expect(assistantErrorNotice(assistant({ type: 'UnknownError', message: 'Model unavailable' })))
      .toEqual({ key: 'chat.assistantError.failed', detail: 'Model unavailable' });
  });

  test('keeps the retry notice ahead of the stop classification', () => {
    expect(assistantErrorNotice(assistant({ type: 'SessionRetry', message: 'Retrying in 5s' })))
      .toEqual({ key: 'chat.assistantError.retry', detail: 'Retrying in 5s' });
  });

  test('names an authentication failure the way the rest of the product does', () => {
    expect(assistantErrorNotice(assistant({ type: 'ProviderAuthError', message: 'invalid token' })))
      .toEqual({ key: 'chat.assistantError.modelAuthenticationFailed', detail: 'invalid token' });
  });

  test('recognises structured authentication errors without requiring English detail', () => {
    expect(assistantErrorNotice(assistant({ type: 'ProviderAuthError', message: '连接验证失败' }))?.key)
      .toBe('chat.assistantError.modelAuthenticationFailed');
  });

  test.each([
    'No API key found for this model',
    'API key is missing. Configure a key to continue.',
    'API key is required. Pass it using the apiKey parameter.',
  ])('explains missing model credentials: %s', (message) => {
    expect(assistantErrorNotice(assistant({ type: 'ProviderAuthError', message }))?.key)
      .toBe('chat.assistantError.modelNotConfigured');
  });

  test('localizes an existing authentication error using the current dictionary', () => {
    const message = assistant({ type: 'UnknownError', message: 'Authentication failed for this provider. Please re-authenticate and retry.' });
    const notice = assistantErrorNotice(message);
    expect(notice).not.toBeNull();
    if (!notice) return;
    expect(zh[notice.key]).toContain('模型');
    expect(zh[notice.key]).toContain('连接');
    expect(zh[notice.key]).not.toContain('Authentication');
    expect(en[notice.key]).toContain('model');
    expect(en[notice.key]).not.toContain('provider');
    expect(message.error?.message).toBe(notice.detail);
  });

  test.each([
    '403 insufficient quota',
    'Connection aborted',
    'The model service is unavailable',
    'The provider returned 503',
  ])('keeps other failures separate from missing model configuration: %s', (message) => {
    expect(assistantErrorNotice(assistant({ type: 'ProviderRequestError', message })))
      .toEqual({ key: 'chat.assistantError.failed', detail: message });
  });

  test('explains the real OpenCode free usage refusal without requesting authentication', () => {
    const detail = 'Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go';
    const notice = assistantErrorNotice(assistant({ type: 'ProviderRequestError', status: 429, message: detail }));
    expect(notice).toEqual({ key: 'chat.assistantError.freeUsageLimited', detail });
    if (!notice) return;
    expect(zh[notice.key]).toContain('免费模型');
    expect(en[notice.key]).toContain('free model');
    expect(en[notice.key]).not.toContain('subscribe');
  });

  test('uses structured HTTP 429 even when rate-limit detail is not English', () => {
    expect(assistantErrorNotice(assistant({ type: 'ProviderRequestError', status: 429, message: '请求过于频繁' })))
      .toEqual({ key: 'chat.assistantError.rateLimited', detail: '请求过于频繁' });
  });

  test('recognises a recorded textual rate limit without treating it as missing configuration', () => {
    expect(assistantErrorNotice(assistant({ type: 'ProviderRequestError', message: '429 rate limit exceeded' })))
      .toEqual({ key: 'chat.assistantError.rateLimited', detail: '429 rate limit exceeded' });
  });

  test('shows nothing for a message without an error', () => {
    expect(assistantErrorNotice(assistant())).toBeNull();
  });
});
