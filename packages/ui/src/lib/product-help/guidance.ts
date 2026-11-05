import type { StateCreator } from 'zustand';
import type { I18nKey } from '@/lib/i18n';
import type { SettingsPageSlug } from '@/lib/settings/metadata';
import type { ProductHelpNavigationAction } from './client';
import type { ProductHelpSurface } from './surface-navigation';

export type GuidanceTarget = ProductHelpNavigationAction['target'];
type GuidanceMode = 'locate' | 'guide';
type GuidanceFailure = 'not-found' | 'hidden' | 'unsupported';
export type GuidanceAction = 'models.connection.selected' | 'models.connection.saved' | 'models.connection.tested'
  | 'appearance.language.opened' | 'appearance.language.changed';
type GuidanceActionToken = { requestId: number; attempt: number; action: GuidanceAction };
type GuidanceStep = {
  destination: { kind: 'settings'; page: SettingsPageSlug } | { kind: 'surface'; surface: ProductHelpSurface } | { kind: 'about' };
  itemId: string;
  titleKey: I18nKey;
  descriptionKey: I18nKey;
  action?: GuidanceAction;
};

const LOCATIONS = {
  models: { destination: { kind: 'settings', page: 'models' }, itemId: 'models.overview', titleKey: 'productHelp.models', descriptionKey: 'productHelp.guidance.modelsOverview' },
  knowledge: { destination: { kind: 'settings', page: 'knowledge-library' }, itemId: 'knowledge-library.backend', titleKey: 'knowledgeLibrary.status.title', descriptionKey: 'productHelp.guidance.knowledgeBackend' },
  appearance: { destination: { kind: 'settings', page: 'appearance' }, itemId: 'appearance.language', titleKey: 'settings.appearance.language.label', descriptionKey: 'productHelp.guidance.appearanceLanguage' },
  theme: { destination: { kind: 'settings', page: 'appearance' }, itemId: 'appearance.themes', titleKey: 'settings.openchamber.visual.section.colorModeAndTheme', descriptionKey: 'productHelp.guidance.appearanceTheme' },
  shortcuts: { destination: { kind: 'settings', page: 'shortcuts' }, itemId: 'shortcuts.keyboard-shortcuts', titleKey: 'settings.openchamber.keyboardShortcuts.title', descriptionKey: 'productHelp.guidance.shortcuts' },
  'model-purposes': { destination: { kind: 'settings', page: 'models' }, itemId: 'models.overview', titleKey: 'modelConfiguration.title', descriptionKey: 'productHelp.guidance.productLocation' },
  'model-tests': { destination: { kind: 'settings', page: 'models' }, itemId: 'models.connections', titleKey: 'modelConfiguration.title', descriptionKey: 'productHelp.guidance.productLocation' },
  'font': { destination: { kind: 'settings', page: 'appearance' }, itemId: 'appearance.interface-font-size', titleKey: 'settings.openchamber.visual.field.interfaceFontSize', descriptionKey: 'productHelp.guidance.productLocation' },
  'skills': { destination: { kind: 'settings', page: 'skills.installed' }, itemId: 'settings-page.skills.installed', titleKey: 'settings.page.skills.title', descriptionKey: 'productHelp.guidance.productLocation' },
  'plugins': { destination: { kind: 'settings', page: 'plugins' }, itemId: 'settings-page.plugins', titleKey: 'settings.page.plugins.title', descriptionKey: 'productHelp.guidance.productLocation' },
  'mcp': { destination: { kind: 'settings', page: 'mcp' }, itemId: 'settings-page.mcp', titleKey: 'settings.page.mcp.title', descriptionKey: 'productHelp.guidance.productLocation' },
  'permissions': { destination: { kind: 'settings', page: 'sessions' }, itemId: 'sessions.permission-default', titleKey: 'settings.sessions.permissions.defaultMode', descriptionKey: 'productHelp.guidance.productLocation' },
  'voice': { destination: { kind: 'settings', page: 'voice' }, itemId: 'voice.speech-recognition', titleKey: 'settings.page.voice.title', descriptionKey: 'productHelp.guidance.productLocation' },
  'memory': { destination: { kind: 'settings', page: 'knowledge-library' }, itemId: 'knowledge-library.conversation-memory-enabled', titleKey: 'conversationMemory.enabled', descriptionKey: 'productHelp.guidance.productLocation' },
  'remote': { destination: { kind: 'settings', page: 'remote-instances' }, itemId: 'settings-page.remote-instances', titleKey: 'settings.page.remoteInstances.title', descriptionKey: 'productHelp.guidance.productLocation' },
  'tunnel': { destination: { kind: 'settings', page: 'tunnel' }, itemId: 'tunnel.provider', titleKey: 'settings.page.tunnel.title', descriptionKey: 'productHelp.guidance.productLocation' },
  'chat': { destination: { kind: 'surface', surface: 'chat' }, itemId: 'chat', titleKey: 'layout.mainTab.chat', descriptionKey: 'productHelp.guidance.productLocation' },
  'sessions': { destination: { kind: 'surface', surface: 'sessions' }, itemId: 'sessions', titleKey: 'settings.page.sessions.title', descriptionKey: 'productHelp.guidance.productLocation' },
  'scheduled-tasks': { destination: { kind: 'surface', surface: 'scheduled-tasks' }, itemId: 'scheduled-tasks', titleKey: 'sessions.scheduledTasks.dialog.title', descriptionKey: 'productHelp.guidance.productLocation' },
  'worktrees': { destination: { kind: 'surface', surface: 'worktrees' }, itemId: 'worktrees', titleKey: 'mobile.sessions.section.worktrees', descriptionKey: 'productHelp.guidance.productLocation' },
  'workbench': { destination: { kind: 'surface', surface: 'workbench' }, itemId: 'workbench', titleKey: 'builtins.workbench.page', descriptionKey: 'productHelp.guidance.productLocation' },
  'files': { destination: { kind: 'surface', surface: 'files' }, itemId: 'files', titleKey: 'contextPanel.mode.files', descriptionKey: 'productHelp.guidance.productLocation' },
  'terminal': { destination: { kind: 'surface', surface: 'terminal' }, itemId: 'terminal', titleKey: 'layout.mainTab.terminal', descriptionKey: 'productHelp.guidance.productLocation' },
  'changes': { destination: { kind: 'surface', surface: 'changes' }, itemId: 'changes', titleKey: 'contextPanel.mode.diff', descriptionKey: 'productHelp.guidance.productLocation' },
  'context': { destination: { kind: 'surface', surface: 'context' }, itemId: 'context', titleKey: 'contextPanel.mode.context', descriptionKey: 'productHelp.guidance.productLocation' },
  'workflows': { destination: { kind: 'surface', surface: 'workflows' }, itemId: 'workflows', titleKey: 'contextPanel.mode.workflows', descriptionKey: 'productHelp.guidance.productLocation' },
  updates: { destination: { kind: 'about' }, itemId: 'about', titleKey: 'settings.page.about.title', descriptionKey: 'productHelp.guidance.productLocation' },
} satisfies Record<GuidanceTarget, GuidanceStep>;

export function getGuidanceLocation(target: GuidanceTarget): GuidanceStep { return LOCATIONS[target]; }

const FLOWS = {
  models: [
    { destination: { kind: 'settings', page: 'models' }, itemId: 'models.connection-preset', titleKey: 'productHelp.guidance.connectionSelectTitle', descriptionKey: 'productHelp.guidance.connectionSelect', action: 'models.connection.selected' },
    { destination: { kind: 'settings', page: 'models' }, itemId: 'models.connection-details', titleKey: 'productHelp.guidance.connectionSaveTitle', descriptionKey: 'productHelp.guidance.connectionSave', action: 'models.connection.saved' },
    { destination: { kind: 'settings', page: 'models' }, itemId: 'models.connection-test', titleKey: 'modelConfiguration.testConnection', descriptionKey: 'productHelp.guidance.connectionTest', action: 'models.connection.tested' },
  ],
  appearance: [
    { ...LOCATIONS.appearance, descriptionKey: 'productHelp.guidance.languageOpen', action: 'appearance.language.opened' },
    { ...LOCATIONS.appearance, descriptionKey: 'productHelp.guidance.languageChoose', action: 'appearance.language.changed' },
  ],
} satisfies Partial<Record<GuidanceTarget, readonly GuidanceStep[]>>;

function getGuidanceFlow(target: GuidanceTarget): readonly GuidanceStep[] | undefined {
  if (target === 'models' || target === 'appearance') return FLOWS[target];
  return undefined;
}

type GuidancePosition = { target: GuidanceTarget; mode: GuidanceMode; stepIndex: number; requestId: number; instructions: string | null };
export type GuidanceSession = GuidancePosition & (
  | { status: 'locating' | 'ready' | 'working' | 'failed' | 'completed'; reason: null }
  | { status: 'unavailable'; reason: GuidanceFailure }
);

export function getGuidanceStep(session: GuidanceSession): GuidanceStep {
  const flow = getGuidanceFlow(session.target);
  const step = session.mode === 'guide' && flow ? flow[session.stepIndex] : LOCATIONS[session.target];
  if (!step) throw new Error('Invalid product help guidance step');
  return step;
}

export function getGuidanceStepCount(target: GuidanceTarget): number {
  return getGuidanceFlow(target)?.length ?? 1;
}

export type GuidanceState = {
  session: GuidanceSession | null;
  start: (target: GuidanceTarget, mode: GuidanceMode, instructions?: string) => void;
  back: () => void;
  stop: () => void;
  retry: () => void;
  beginAction: (action: GuidanceAction) => GuidanceActionToken | null;
  reportAction: (token: GuidanceActionToken | null, outcome: 'complete' | 'failed') => void;
  markReady: (requestId: number) => void;
  markUnavailable: (requestId: number, reason: GuidanceFailure) => void;
};

export function createGuidanceState(dependencies: {
  navigate: (step: GuidanceStep) => boolean | void;
  isSupported: (target: GuidanceTarget) => boolean;
}): StateCreator<GuidanceState> {
  return (set, get) => {
    let requestId = 0;
    let attempt = 0;
    const visit = (target: GuidanceTarget, mode: GuidanceMode, stepIndex: number, instructions: string | null, navigate = true) => {
      requestId += 1;
      const position = { target, mode, stepIndex, requestId, instructions };
      if (!dependencies.isSupported(target)) {
        set({ session: { ...position, status: 'unavailable', reason: 'unsupported' } });
        return;
      }
      const session: GuidanceSession = { ...position, status: 'locating', reason: null };
      set({ session });
      if (navigate && dependencies.navigate(getGuidanceStep(session)) === false) {
        set({ session: { ...position, status: 'unavailable', reason: 'unsupported' } });
      }
    };
    return {
      session: null,
      // Instruction guides retain reviewed text and never report task completion.
      start: (target, mode, instructions) => visit(target, mode === 'guide' && (getGuidanceFlow(target) || instructions?.trim()) ? 'guide' : 'locate', 0, instructions?.trim() || null),
      back: () => {
        const session = get().session;
        if (session && session.stepIndex > 0) visit(session.target, session.mode, session.stepIndex - 1, session.instructions);
      },
      stop: () => set({ session: null }),
      retry: () => {
        const session = get().session;
        if (session) visit(session.target, session.mode, session.stepIndex, session.instructions);
      },
      beginAction: (action) => {
        const session = get().session;
        if (!session || session.mode !== 'guide' || session.status === 'unavailable' || session.status === 'completed'
          || getGuidanceStep(session).action !== action) return null;
        attempt += 1;
        set({ session: { ...session, status: 'working', reason: null } });
        return { requestId: session.requestId, attempt, action };
      },
      reportAction: (token, outcome) => {
        const session = get().session;
        if (!token || !session || session.requestId !== token.requestId || token.attempt !== attempt
          || session.status !== 'working' || getGuidanceStep(session).action !== token.action) return;
        if (outcome === 'failed') {
          set({ session: { ...session, status: 'failed', reason: null } });
        } else if (session.stepIndex + 1 < getGuidanceStepCount(session.target)) {
          visit(session.target, session.mode, session.stepIndex + 1, session.instructions, false);
        } else {
          set({ session: { ...session, status: 'completed', reason: null } });
        }
      },
      markReady: (id) => {
        const session = get().session;
        if (session?.requestId === id && session.status === 'locating') {
          set({ session: { ...session, status: 'ready', reason: null } });
        }
      },
      markUnavailable: (id, reason) => {
        const session = get().session;
        if (session?.requestId === id && session.status !== 'unavailable' && session.status !== 'completed') {
          set({ session: { ...session, status: 'unavailable', reason } });
        }
      },
    };
  };
}
