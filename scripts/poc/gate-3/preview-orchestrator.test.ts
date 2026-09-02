import { describe, expect, it } from 'vitest';
import type {
  PageSurfaceRef,
  PreviewAdapter,
  PreviewManifest,
  PreviewRequest,
  PreviewSession,
  PreviewState,
  TextLayer
} from './review-contract';
import { createPreviewOrchestrator } from './preview-orchestrator';

type Scenario = { fast: 'success' | 'failure'; truth: 'pending_then_success' | 'dependency_missing' | 'failure' };

class FakePreviewAdapter implements PreviewAdapter {
  readonly cancelledSessionIds: string[] = [];
  openCount = 0;

  constructor(
    readonly id: string,
    private readonly available: boolean,
    private readonly opensSuccessfully: boolean
  ) {}

  async probe(): Promise<{ available: boolean; reason?: string }> {
    return this.available ? { available: true } : { available: false, reason: 'WPS is missing' };
  }

  async open(_request: PreviewRequest): Promise<PreviewSession> {
    this.openCount += 1;
    if (!this.opensSuccessfully) throw new Error(`${this.id} failed`);
    return { sessionId: `${this.id}-session`, state: 'queued' };
  }

  async getManifest(_sessionId: string): Promise<PreviewManifest> {
    throw new Error('not used in orchestrator contract tests');
  }

  async getPage(_sessionId: string, _pageId: string, _scaleBucket: number): Promise<PageSurfaceRef> {
    throw new Error('not used in orchestrator contract tests');
  }

  async getThumbnail(_sessionId: string, _pageId: string): Promise<PageSurfaceRef> {
    throw new Error('not used in orchestrator contract tests');
  }

  async getTextLayer(_sessionId: string, _pageId: string): Promise<TextLayer | null> {
    throw new Error('not used in orchestrator contract tests');
  }

  async cancel(sessionId: string): Promise<void> {
    this.cancelledSessionIds.push(sessionId);
  }
}

class DeferredOpenAdapter extends FakePreviewAdapter {
  readonly openStarted: Promise<void>;
  private readonly pendingSession: Promise<PreviewSession>;
  private markOpenStarted!: () => void;
  private releasePendingSession!: (session: PreviewSession) => void;

  constructor(id: string) {
    super(id, true, true);
    this.openStarted = new Promise((resolve) => {
      this.markOpenStarted = resolve;
    });
    this.pendingSession = new Promise((resolve) => {
      this.releasePendingSession = resolve;
    });
  }

  override async open(_request: PreviewRequest): Promise<PreviewSession> {
    this.openCount += 1;
    this.markOpenStarted();
    return this.pendingSession;
  }

  release(sessionId: string): void {
    this.releasePendingSession({ sessionId, state: 'queued' });
  }
}

const DOCX_REQUEST: PreviewRequest = {
  artifactRevisionId: `artifact-sha256:${'11'.repeat(32)}`,
  artifactHandle: '/output/review.docx',
  mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  preferredFidelity: 'authoritative',
  deadlineMs: 5_000
};

async function runScenario(input: Scenario): Promise<{ states: PreviewState[]; canAccept: boolean }> {
  const states: PreviewState[] = [];
  const fast = new FakePreviewAdapter('fast', true, input.fast === 'success');
  const truth = new FakePreviewAdapter(
    'truth',
    input.truth !== 'dependency_missing',
    input.truth !== 'failure'
  );
  const orchestrator = createPreviewOrchestrator(fast, truth, (state) => states.push(state));

  const result = await orchestrator.run(DOCX_REQUEST);
  return { states, canAccept: result.canAccept };
}

describe('PreviewOrchestrator', () => {
  it('keeps fast preview visible while authoritative rendering runs', async () => {
    const result = await runScenario({ fast: 'success', truth: 'pending_then_success' });
    expect(result.states).toEqual(['queued', 'loading_fast', 'fast_ready', 'rendering_authoritative', 'authoritative_ready']);
  });

  it('keeps DOCX readable but unaccepted when WPS is missing', async () => {
    const result = await runScenario({ fast: 'success', truth: 'dependency_missing' });
    expect(result.states.at(-1)).toBe('dependency_missing');
    expect(result.canAccept).toBe(false);
  });

  it('skips the fast adapter for PDF', async () => {
    const states: PreviewState[] = [];
    const fast = new FakePreviewAdapter('fast', true, true);
    const truth = new FakePreviewAdapter('truth', true, true);
    const orchestrator = createPreviewOrchestrator(fast, truth, (state) => states.push(state));

    const result = await orchestrator.run({ ...DOCX_REQUEST, mediaType: 'application/pdf' });

    expect(states).toEqual(['queued', 'rendering_authoritative', 'authoritative_ready']);
    expect(fast.openCount).toBe(0);
    expect(result.canAccept).toBe(true);
  });

  it('cancels every active adapter session without publishing a new state', async () => {
    const states: PreviewState[] = [];
    const fast = new FakePreviewAdapter('fast', true, true);
    const truth = new FakePreviewAdapter('truth', true, true);
    const orchestrator = createPreviewOrchestrator(fast, truth, (state) => states.push(state));
    await orchestrator.run(DOCX_REQUEST);
    const publishedStates = [...states];

    await orchestrator.cancel();

    expect(fast.cancelledSessionIds).toEqual(['fast-session']);
    expect(truth.cancelledSessionIds).toEqual(['truth-session']);
    expect(states).toEqual(publishedStates);
  });

  it('makes cancellation a barrier while the fast adapter is opening', async () => {
    const states: PreviewState[] = [];
    const fast = new DeferredOpenAdapter('fast');
    const truth = new FakePreviewAdapter('truth', true, true);
    const orchestrator = createPreviewOrchestrator(fast, truth, (state) => states.push(state));
    const runPromise = orchestrator.run(DOCX_REQUEST);
    await fast.openStarted;

    await orchestrator.cancel();
    fast.release('late-fast-session');
    const result = await runPromise;

    expect(states).toEqual(['queued', 'loading_fast']);
    expect(truth.openCount).toBe(0);
    expect(result.canAccept).toBe(false);
    expect(fast.cancelledSessionIds).toEqual(['late-fast-session']);
  });
});
