import { describe, expect, it, vi } from 'vitest';
import { reportAutomationReady } from './automation-ready';

describe('automation ready reporter', () => {
  it('emits the fixed exact finite readiness payload', async () => {
    const emit = vi.fn(async () => {});

    await reportAutomationReady(emit);

    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith('review-automation-ready', {
      schemaVersion: 1,
      state: 'listener_installed'
    });
  });
});
