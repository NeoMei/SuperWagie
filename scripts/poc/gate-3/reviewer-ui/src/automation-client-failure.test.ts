import { describe, expect, it, vi } from 'vitest';
import { reportAutomationClientFailure } from './automation-client-failure';

describe('automation client failure reporter', () => {
  it('emits only the fixed event with the current session and finite stage', async () => {
    const emit = vi.fn(async () => {});

    await reportAutomationClientFailure(emit, {
      sessionId: 'a'.repeat(32),
      stage: 'docx_authoritative'
    });

    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith('review-automation-client-failed', {
      sessionId: 'a'.repeat(32),
      stage: 'docx_authoritative'
    });
  });
});
