import type { ReviewAutomationStage } from './review-automation';

export const AUTOMATION_CLIENT_FAILURE_EVENT = 'review-automation-client-failed';

export interface AutomationClientFailurePayload {
  sessionId: string;
  stage: ReviewAutomationStage;
}

type EmitEvent = (
  event: typeof AUTOMATION_CLIENT_FAILURE_EVENT,
  payload: AutomationClientFailurePayload
) => Promise<void>;

export function reportAutomationClientFailure(
  emit: EmitEvent,
  payload: AutomationClientFailurePayload
): Promise<void> {
  return emit(AUTOMATION_CLIENT_FAILURE_EVENT, payload);
}
