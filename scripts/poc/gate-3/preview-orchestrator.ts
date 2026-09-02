import {
  assertTransition,
  type PreviewAdapter,
  type PreviewOrchestrator,
  type PreviewRequest,
  type PreviewRunResult,
  type PreviewState
} from './review-contract';

interface ActiveSession {
  adapter: PreviewAdapter;
  sessionId: string;
}

export function createPreviewOrchestrator(
  fastAdapter: PreviewAdapter | null,
  truthAdapter: PreviewAdapter,
  onState: (state: PreviewState) => void
): PreviewOrchestrator {
  let activeSessions: ActiveSession[] = [];
  let cancellationGeneration = 0;

  return {
    async run(request: PreviewRequest): Promise<PreviewRunResult> {
      const states: PreviewState[] = [];
      let currentState: PreviewState | null = null;
      const runGeneration = cancellationGeneration;
      const isCancelled = (): boolean => runGeneration !== cancellationGeneration;
      const cancelledResult = (): PreviewRunResult => ({ states, canAccept: false });

      const emit = (nextState: PreviewState): boolean => {
        if (isCancelled()) return false;
        if (currentState !== null) assertTransition(currentState, nextState);
        currentState = nextState;
        states.push(nextState);
        onState(nextState);
        return true;
      };

      emit('queued');

      if (request.mediaType.includes('wordprocessingml.document') && fastAdapter !== null) {
        emit('loading_fast');
        try {
          const fastSession = await fastAdapter.open(request);
          if (isCancelled()) {
            await fastAdapter.cancel(fastSession.sessionId);
            return cancelledResult();
          }
          activeSessions.push({ adapter: fastAdapter, sessionId: fastSession.sessionId });
          emit('fast_ready');
        } catch {
          if (isCancelled()) return cancelledResult();
          emit('failed_recoverable');
        }
      }

      if (!emit('rendering_authoritative')) return cancelledResult();

      let truthAvailable: boolean;
      try {
        truthAvailable = (await truthAdapter.probe()).available;
      } catch {
        if (isCancelled()) return cancelledResult();
        emit('failed_recoverable');
        return { states, canAccept: false };
      }

      if (isCancelled()) return cancelledResult();

      if (!truthAvailable) {
        emit('dependency_missing');
        return { states, canAccept: false };
      }

      try {
        const truthSession = await truthAdapter.open(request);
        if (isCancelled()) {
          await truthAdapter.cancel(truthSession.sessionId);
          return cancelledResult();
        }
        activeSessions.push({ adapter: truthAdapter, sessionId: truthSession.sessionId });
        emit('authoritative_ready');
        return { states, canAccept: true };
      } catch {
        if (isCancelled()) return cancelledResult();
        emit('failed_terminal');
        return { states, canAccept: false };
      }
    },

    async cancel(): Promise<void> {
      cancellationGeneration += 1;
      const sessionsToCancel = activeSessions;
      activeSessions = [];
      await Promise.all(sessionsToCancel.map(({ adapter, sessionId }) => adapter.cancel(sessionId)));
    }
  };
}
