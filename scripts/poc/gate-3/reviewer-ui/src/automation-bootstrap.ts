import {
  normalizeHostArtifactOpened,
  type HostArtifactOpened,
  type OpenedArtifact
} from './host-bridge';

export interface BufferedAutomationStart {
  sessionId: string;
  artifacts: OpenedArtifact[];
}

type AutomationRunner = (start: BufferedAutomationStart) => Promise<void> | void;
type AutomationFailure = (failure: { sessionId: string }) => Promise<void> | void;
type RegisterArtifactListener = (
  receive: (payload: unknown) => void
) => Promise<() => void>;
type ReportClientReady = () => Promise<void>;
type ReportArtifactReceived = (receipt: {
  sessionId: string;
  automationIndex: number;
  bufferComplete: boolean;
}) => Promise<void>;

export interface BufferedAutomationListener {
  markReady(
    run: AutomationRunner,
    onFailure: AutomationFailure,
    reportReady?: ReportClientReady
  ): Promise<void>;
}

/**
 * Registers the host listener before adapter loading and retains at most one
 * automation session with three de-duplicated audited artifact indexes.
 */
export async function installBufferedAutomationListener(
  register: RegisterArtifactListener,
  reportArtifactReceived: ReportArtifactReceived = async () => {}
): Promise<BufferedAutomationListener> {
  let sessionId: string | null = null;
  const artifactsByIndex = new Map<number, OpenedArtifact>();
  let runner: AutomationRunner | null = null;
  let failure: AutomationFailure | null = null;
  let started = false;
  let activeRun: Promise<void> | null = null;

  const drain = (): Promise<void> => {
    if (activeRun) return activeRun;
    if (started || !runner || !failure || sessionId === null || artifactsByIndex.size !== 3) {
      return Promise.resolve();
    }
    const artifacts = [0, 1, 2].map((index) => artifactsByIndex.get(index));
    if (artifacts.some((artifact) => artifact === undefined)) return Promise.resolve();
    const activeSessionId = sessionId;
    started = true;
    activeRun = Promise.resolve(runner({
      sessionId: activeSessionId,
      artifacts: artifacts as OpenedArtifact[]
    })).catch(async () => {
      if (failure) await failure({ sessionId: activeSessionId });
    });
    return activeRun;
  };

  await register((payload: unknown) => {
    if (started) return;
    let opened: OpenedArtifact;
    try {
      opened = normalizeHostArtifactOpened(payload as HostArtifactOpened);
    } catch {
      return;
    }
    if (opened.automationSessionId === undefined || opened.automationIndex === undefined) return;
    if (sessionId === null) sessionId = opened.automationSessionId;
    if (opened.automationSessionId !== sessionId || artifactsByIndex.has(opened.automationIndex)) return;
    artifactsByIndex.set(opened.automationIndex, opened);
    void reportArtifactReceived({
      sessionId,
      automationIndex: opened.automationIndex,
      bufferComplete: artifactsByIndex.size === 3 && [0, 1, 2].every((index) => artifactsByIndex.has(index))
    }).catch(() => {});
    void drain();
  });

  return {
    async markReady(run, onFailure, reportReady = async () => {}) {
      if (runner === null) {
        runner = run;
        failure = onFailure;
        // Host readiness means listener + adapters + shell + runner/failure
        // handling are all installed, not merely that event subscription won.
        await reportReady();
      }
      return drain();
    }
  };
}
