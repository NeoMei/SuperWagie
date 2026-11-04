/** Workflow controls and reads require server support and the user's persisted opt-in. */
export const isWorkflowEnabled = (state: {
  agentWorkflowFeatureAvailable: boolean;
  agentWorkflowToolEnabled: boolean;
}): boolean => state.agentWorkflowFeatureAvailable && state.agentWorkflowToolEnabled;
