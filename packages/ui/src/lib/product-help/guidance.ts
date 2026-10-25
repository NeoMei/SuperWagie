import type { StateCreator } from 'zustand';
import type { I18nKey } from '@/lib/i18n';
import type { SettingsPageSlug } from '@/lib/settings/metadata';

export type GuidanceTarget = 'models' | 'knowledge' | 'appearance' | 'theme' | 'shortcuts';
type GuidanceMode = 'locate' | 'guide';
type GuidanceFailure = 'not-found' | 'hidden' | 'unsupported';
export type GuidanceAction = 'models.connection.selected' | 'models.connection.saved' | 'models.connection.tested'
  | 'appearance.language.opened' | 'appearance.language.changed';
type GuidanceActionToken = { requestId: number; attempt: number; action: GuidanceAction };
type GuidanceStep = {
  page: SettingsPageSlug;
  itemId: string;
  titleKey: I18nKey;
  descriptionKey: I18nKey;
  action?: GuidanceAction;
};

const LOCATIONS = {
  models: { page: 'models', itemId: 'models.overview', titleKey: 'productHelp.models', descriptionKey: 'productHelp.guidance.modelsOverview' },
  knowledge: { page: 'knowledge-library', itemId: 'knowledge-library.backend', titleKey: 'knowledgeLibrary.status.title', descriptionKey: 'productHelp.guidance.knowledgeBackend' },
  appearance: { page: 'appearance', itemId: 'appearance.language', titleKey: 'settings.appearance.language.label', descriptionKey: 'productHelp.guidance.appearanceLanguage' },
  theme: { page: 'appearance', itemId: 'appearance.themes', titleKey: 'settings.openchamber.visual.section.colorModeAndTheme', descriptionKey: 'productHelp.guidance.appearanceTheme' },
  shortcuts: { page: 'shortcuts', itemId: 'shortcuts.keyboard-shortcuts', titleKey: 'settings.openchamber.keyboardShortcuts.title', descriptionKey: 'productHelp.guidance.shortcuts' },
} satisfies Record<GuidanceTarget, GuidanceStep>;

const FLOWS = {
  knowledge: null,
  theme: null,
  shortcuts: null,
  models: [
    { page: 'models', itemId: 'models.connection-preset', titleKey: 'productHelp.guidance.connectionSelectTitle', descriptionKey: 'productHelp.guidance.connectionSelect', action: 'models.connection.selected' },
    { page: 'models', itemId: 'models.connection-details', titleKey: 'productHelp.guidance.connectionSaveTitle', descriptionKey: 'productHelp.guidance.connectionSave', action: 'models.connection.saved' },
    { page: 'models', itemId: 'models.connection-test', titleKey: 'modelConfiguration.testConnection', descriptionKey: 'productHelp.guidance.connectionTest', action: 'models.connection.tested' },
  ],
  appearance: [
    { ...LOCATIONS.appearance, descriptionKey: 'productHelp.guidance.languageOpen', action: 'appearance.language.opened' },
    { ...LOCATIONS.appearance, descriptionKey: 'productHelp.guidance.languageChoose', action: 'appearance.language.changed' },
  ],
} satisfies Record<GuidanceTarget, readonly GuidanceStep[] | null>;

type GuidancePosition = { target: GuidanceTarget; mode: GuidanceMode; stepIndex: number; requestId: number };
export type GuidanceSession = GuidancePosition & (
  | { status: 'locating' | 'ready' | 'working' | 'failed' | 'completed'; reason: null }
  | { status: 'unavailable'; reason: GuidanceFailure }
);

export function getGuidanceStep(session: GuidanceSession): GuidanceStep {
  const step = session.mode === 'guide' ? FLOWS[session.target]?.[session.stepIndex] : LOCATIONS[session.target];
  if (!step) throw new Error('Invalid product help guidance step');
  return step;
}

export function getGuidanceStepCount(target: GuidanceTarget): number {
  return FLOWS[target]?.length ?? 1;
}

export type GuidanceState = {
  session: GuidanceSession | null;
  start: (target: GuidanceTarget, mode: GuidanceMode) => void;
  back: () => void;
  stop: () => void;
  retry: () => void;
  beginAction: (action: GuidanceAction) => GuidanceActionToken | null;
  reportAction: (token: GuidanceActionToken | null, outcome: 'complete' | 'failed') => void;
  markReady: (requestId: number) => void;
  markUnavailable: (requestId: number, reason: GuidanceFailure) => void;
};

export function createGuidanceState(dependencies: {
  navigate: (step: GuidanceStep) => void;
  isSupported: (target: GuidanceTarget) => boolean;
}): StateCreator<GuidanceState> {
  return (set, get) => {
    let requestId = 0;
    let attempt = 0;
    const visit = (target: GuidanceTarget, mode: GuidanceMode, stepIndex: number, navigate = true) => {
      requestId += 1;
      const position = { target, mode, stepIndex, requestId };
      if (!dependencies.isSupported(target)) {
        set({ session: { ...position, status: 'unavailable', reason: 'unsupported' } });
        return;
      }
      const session: GuidanceSession = { ...position, status: 'locating', reason: null };
      set({ session });
      if (navigate) dependencies.navigate(getGuidanceStep(session));
    };
    return {
      session: null,
      // Unimplemented tasks stay locations; the UI never claims to complete them.
      start: (target, mode) => visit(target, mode === 'guide' && FLOWS[target] ? 'guide' : 'locate', 0),
      back: () => {
        const session = get().session;
        if (session && session.stepIndex > 0) visit(session.target, session.mode, session.stepIndex - 1);
      },
      stop: () => set({ session: null }),
      retry: () => {
        const session = get().session;
        if (session) visit(session.target, session.mode, session.stepIndex);
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
          visit(session.target, session.mode, session.stepIndex + 1, false);
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
