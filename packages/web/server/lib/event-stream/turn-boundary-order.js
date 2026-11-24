const TURN_STATUS_EVENTS = new Set([
  'session.execution.started',
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
  'session.retry.scheduled',
  'session.step.started',
]);

/** Host and isolated OpenCode instances own independent event sequences. */
export function createTurnBoundaryOrder() {
  const bySpace = new Map();
  const isStale = (payload, spaceId) => {
    const sessionId = payload?.data?.sessionID;
    const durable = payload?.durable;
    if (typeof sessionId !== 'string' || durable?.aggregateID !== sessionId || !Number.isSafeInteger(durable.seq)) {
      return false;
    }
    const scope = spaceId ?? null;
    let newestBySession = bySpace.get(scope);
    if (!newestBySession) {
      newestBySession = new Map();
      bySpace.set(scope, newestBySession);
    }
    const newest = newestBySession.get(sessionId);
    if (newest !== undefined && durable.seq <= newest) return TURN_STATUS_EVENTS.has(payload.type);
    if (payload.type === 'session.deleted') newestBySession.delete(sessionId);
    else newestBySession.set(sessionId, durable.seq);
    return false;
  };
  return Object.assign(isStale, { clear: () => bySpace.clear() });
}
