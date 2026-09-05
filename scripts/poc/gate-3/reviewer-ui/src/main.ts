import './styles.css';
import { emit, listen } from '@tauri-apps/api/event';
import type { ReviewPerformanceSnapshot } from '../../review-contract';
import { selectReviewerHostBridge, type HostBridge } from './host-bridge';
import {
  markFirstPagePainted,
  markProgressVisible,
  markReviewStarted,
  resetMetrics,
  sampleInteraction,
  snapshotMetrics,
  type ReviewInteractionName
} from './performance-metrics';
import {
  REVIEW_AUTOMATION_SELECTORS,
  renderReviewShell,
  type ReviewShellController,
  type ReviewShellOptions
} from './review-shell';
import type { HostArtifactOpened } from './host-bridge';
import { installBufferedAutomationListener } from './automation-bootstrap';
import { executeBuiltShellAutomation } from './review-automation';
import type { ReviewAutomationStage } from './review-automation';
import { reportAutomationClientFailure } from './automation-client-failure';
import { reportAutomationReady } from './automation-ready';
import { reportAutomationArtifactReceived } from './automation-artifact-receipt';
import { measurePaintedAction, waitForPaintedFrames } from './painted-frame';

type MetricsHost = Pick<HostBridge, 'recordMetrics'>;

export async function recordCompletedInteraction(
  host: MetricsHost,
  name: ReviewInteractionName
): Promise<void> {
  const durationMs = await sampleInteraction(name);
  if (durationMs === null) return;
  await host.recordMetrics(snapshotMetrics());
}

export async function recordClosingMetrics(host: MetricsHost): Promise<void> {
  await host.recordMetrics(snapshotMetrics());
}

interface ReviewerPocApi {
  pdf: import('./pdf-adapter').PdfAdapter;
  docxFast: import('./docx-fast-adapter').DocxFastAdapter;
  shell: ReviewShellController;
  mountReview(options: Omit<
    ReviewShellOptions,
    'root' | 'host' | 'mountSurface' | 'onProgressVisible' | 'onFirstPageVisible' | 'onInteraction'
  >): ReviewShellController;
  snapshotMetrics(): ReviewPerformanceSnapshot;
}

declare global {
  var superwagieReviewerPoc: ReviewerPocApi | undefined;
}

async function bootstrapReviewer(): Promise<void> {
  const root = document.querySelector<HTMLElement>('#reviewer-root');
  const adapterHost = document.querySelector<HTMLElement>('#reviewer-styles');
  if (!root || !adapterHost) return;

  const tauriInternals = (globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  const hostBridge = selectReviewerHostBridge(tauriInternals);
  const automationListener = tauriInternals === undefined ? null
    : await installBufferedAutomationListener((receive) =>
      listen<HostArtifactOpened>('artifact-opened', ({ payload }) => receive(payload)),
    (receipt) => reportAutomationArtifactReceived(emit, receipt));
  let automationStage: ReviewAutomationStage = 'bootstrap';

  const [{ PdfAdapter }, { DocxFastAdapter }] = await Promise.all([
    import('./pdf-adapter'),
    import('./docx-fast-adapter')
  ]);
  const docxBodyContainer = document.createElement('div');
  const docxStyleContainer = document.createElement('div');
  adapterHost.replaceChildren(docxBodyContainer, docxStyleContainer);

  const pdf = new PdfAdapter(hostBridge, undefined, (stage) => { automationStage = stage; });
  const docxFast = new DocxFastAdapter(hostBridge, {
    bodyContainer: docxBodyContainer,
    styleContainer: docxStyleContainer
  });
  const mountSurface: NonNullable<ReviewShellOptions['mountSurface']> = (surface, target) => {
    if (pdf.mountSurface(surface.surfaceHandle, target)) return;
    if (docxFast.mountSurface(surface.surfaceHandle, target)) return;
    target.replaceChildren();
  };

  const interactionRecorder = (name: ReviewInteractionName): Promise<void> =>
    recordCompletedInteraction(hostBridge, name);
  let shell = renderReviewShell({
    root,
    manifest: null,
    state: 'queued',
    mode: 'word',
    host: hostBridge,
    artifactHandle: null,
    onInteraction: interactionRecorder
  });

  const api: ReviewerPocApi = {
    pdf,
    docxFast,
    shell,
    mountReview(reviewOptions) {
      shell.destroy();
      resetMetrics();
      markReviewStarted();
      root.hidden = false;
      shell = renderReviewShell({
        ...reviewOptions,
        root,
        host: hostBridge,
        mountSurface,
        onProgressVisible: markProgressVisible,
        onFirstPageVisible: markFirstPagePainted,
        onInteraction: interactionRecorder
      });
      api.shell = shell;
      return shell;
    },
    snapshotMetrics
  };

  globalThis.superwagieReviewerPoc = api;
  if (automationListener) {
    await automationListener.markReady(async ({ sessionId, artifacts }) => {
      await executeBuiltShellAutomation({
        sessionId,
        artifacts,
        host: hostBridge,
        pdf,
        docxFast,
        showProgress: async () => {
          api.mountReview({ manifest: null, state: 'rendering_authoritative', mode: 'word', artifactHandle: null });
          await waitForPaintedFrames();
        },
        presentReview: async (manifest, state, artifact, content) => {
          api.mountReview({
            manifest,
            state,
            mode: artifact.mediaType.includes('presentation') ? 'presentation' : 'word',
            artifactHandle: artifact.handle,
            pageSurfaces: content.pageSurfaces,
            textLayers: content.textLayers,
            loadPage: content.loadPage
          });
          await waitForPaintedFrames();
        },
        performActions: async () => {
          const viewport = root.querySelector<HTMLElement>(REVIEW_AUTOMATION_SELECTORS.viewport);
          const fitWidth = root.querySelector<HTMLButtonElement>(REVIEW_AUTOMATION_SELECTORS.fitWidth);
          const pageTwo = root.querySelector<HTMLButtonElement>(REVIEW_AUTOMATION_SELECTORS.pageTwo);
          const annotation = root.querySelector<HTMLButtonElement>(REVIEW_AUTOMATION_SELECTORS.annotation);
          if (!viewport || !fitWidth || !pageTwo || !annotation) throw new Error('automation action target missing');
          const durations: number[] = [];
          for (const action of [
            () => viewport.dispatchEvent(new Event('scroll')),
            () => fitWidth.click(),
            () => pageTwo.click(),
            () => viewport.dispatchEvent(new Event('pointerup')),
            () => annotation.click()
          ]) durations.push(await measurePaintedAction(action));
          return durations;
        },
        onStage: (stage) => { automationStage = stage; }
      });
    }, async ({ sessionId }) => {
      api.shell.setState('failed_terminal');
      try {
        await reportAutomationClientFailure(emit, { sessionId, stage: automationStage });
      } catch {
        // No fallback command or caller-controlled evidence path is permitted.
      }
    }, () => reportAutomationReady(emit));
  }
  window.addEventListener('beforeunload', () => {
    void recordClosingMetrics(hostBridge);
  }, { once: true });
}

void bootstrapReviewer();
