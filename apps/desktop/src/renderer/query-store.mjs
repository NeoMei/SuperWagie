export function createQueryState() {
  return {
    status: 'idle',
    canWrite: false,
    snapshot: null,
    activeProjectId: null,
    requestGeneration: 0,
  };
}

export function reduceQueryState(state, event) {
  if (!event || typeof event !== 'object') return state;
  if (event.message_type === 'subscription.resync_required') {
    return {
      ...state,
      status: 'resync_required',
      canWrite: false,
      snapshot: null,
    };
  }
  if (event.message_type !== 'query.snapshot'
    || event.project_id !== state.activeProjectId
    || event.request_generation !== state.requestGeneration) {
    return state;
  }
  return {
    ...state,
    status: 'ready',
    canWrite: true,
    snapshot: event.snapshot,
  };
}
