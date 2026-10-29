/** Only the exact managed model refusal has the restart recovery path. */
export const isManagedModelScopeRestartRequired = (error: unknown): boolean => {
  const value = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /(?:^|[^a-z0-9_])platform_model_scope_restart_required(?:$|[^a-z0-9_])/i.test(value);
};
