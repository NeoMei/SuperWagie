/** Only the exact managed model refusal has the restart recovery path. */
export const isManagedModelScopeRestartRequired = (message: string): boolean => {
  return /(?:^|[^a-z0-9_])platform_model_scope_restart_required(?:$|[^a-z0-9_])/i.test(message);
};

export const isManagedModelDispatchSuspended = (message: string): boolean => {
  return /(?:^|[^a-z0-9_])platform_dispatch_suspended(?:$|[^a-z0-9_])/i.test(message);
};
