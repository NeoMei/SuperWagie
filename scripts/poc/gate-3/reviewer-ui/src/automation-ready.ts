export const AUTOMATION_READY_EVENT = 'review-automation-ready';

export const AUTOMATION_READY_PAYLOAD = {
  schemaVersion: 1,
  state: 'listener_installed'
} as const;

type EmitReady = (
  event: typeof AUTOMATION_READY_EVENT,
  payload: typeof AUTOMATION_READY_PAYLOAD
) => Promise<void>;

export function reportAutomationReady(emit: EmitReady): Promise<void> {
  return emit(AUTOMATION_READY_EVENT, AUTOMATION_READY_PAYLOAD);
}
