import { describe, expect, it, vi } from 'vitest';
import {
  AUTOMATION_ARTIFACT_RECEIVED_EVENT,
  reportAutomationArtifactReceived
} from './automation-artifact-receipt';

describe('automation artifact receipt', () => {
  it('emits only the fixed path-free session-bound receipt', async () => {
    const emit = vi.fn(async () => {});
    await reportAutomationArtifactReceived(emit, {
      sessionId: 'ab'.repeat(16),
      automationIndex: 2,
      bufferComplete: true
    });

    expect(emit).toHaveBeenCalledWith(AUTOMATION_ARTIFACT_RECEIVED_EVENT, {
      schemaVersion: 1,
      sessionId: 'ab'.repeat(16),
      automationIndex: 2,
      bufferComplete: true
    });
  });
});
