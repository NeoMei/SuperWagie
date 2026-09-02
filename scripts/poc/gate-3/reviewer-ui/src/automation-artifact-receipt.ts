export const AUTOMATION_ARTIFACT_RECEIVED_EVENT = 'review-automation-artifact-received';

export interface AutomationArtifactReceipt {
  schemaVersion: 1;
  sessionId: string;
  automationIndex: number;
  bufferComplete: boolean;
}

type EmitReceipt = (
  event: typeof AUTOMATION_ARTIFACT_RECEIVED_EVENT,
  payload: AutomationArtifactReceipt
) => Promise<void>;

export function reportAutomationArtifactReceived(
  emit: EmitReceipt,
  receipt: Omit<AutomationArtifactReceipt, 'schemaVersion'>
): Promise<void> {
  return emit(AUTOMATION_ARTIFACT_RECEIVED_EVENT, {
    schemaVersion: 1,
    ...receipt
  });
}
