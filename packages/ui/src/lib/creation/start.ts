import { toast } from 'sonner';

import { CREATION_PROMPT_KEY, CREATION_TITLE_KEY, CREATION_WORK_URL_PREFIX, type CreationIntent } from '@/lib/creation';
import { startGuestSession } from '@/lib/guests/start-session';
import { formatMessage, useI18nStore, type I18nKey, type I18nParams } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';

type Translate = (key: I18nKey, params?: I18nParams) => string;

const today = (): string => {
  const date = new Date();
  return `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, '0')}-${`${date.getDate()}`.padStart(2, '0')}`;
};

const briefFor = (kind: CreationIntent, title: string, t: Translate): string => [
  `# ${title}`,
  '',
  `- ${t('creation.brief.kind', { kind })}`,
  `- ${t('creation.brief.created', { date: today() })}`,
  '',
  `## ${t('creation.brief.user')}`,
  '',
  t('creation.brief.empty'),
  '',
].join('\n');

type CreationStarter = (kind: CreationIntent) => Promise<void>;

/**
 * Serializes creation starts so an entry clicked while a previous one is
 * preparing is handled after it finishes instead of being dropped.
 */
export const createCreationIntentQueue = (start: CreationStarter) => {
  const pending: CreationIntent[] = [];
  let running = false;

  const drain = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      while (pending.length > 0) {
        const kind = pending.shift();
        if (kind === undefined) continue;
        await start(kind);
      }
    } finally {
      running = false;
      if (pending.length > 0) void drain();
    }
  };

  return {
    enqueue: (kind: CreationIntent) => {
      pending.push(kind);
      void drain();
    },
  };
};

/**
 * A creation entry starts the skill in a fresh work folder and lands in the
 * chat. The whole task is then the skill's own question-by-question flow; no
 * guide page stands between the user and the assistant.
 */
export const startCreationChat = async (kind: CreationIntent): Promise<void> => {
  const { dictionary } = useI18nStore.getState();
  const t: Translate = (key, params) => formatMessage(dictionary, key, params);
  const title = t(CREATION_TITLE_KEY[kind]);
  toast.loading(t('creation.start.loading'), { id: 'creation-start' });
  try {
    const response = await runtimeFetch('/api/creation/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, title, brief: briefFor(kind, title, t) }),
    });
    if (!response.ok) throw new Error(t('creation.start.projectFailed'));
    // SAFETY: the creation route returns this small envelope; a missing id is
    // checked on the next line and treated as a failed start.
    const created = await response.json() as { projectId?: string };
    if (!created.projectId) throw new Error(t('creation.start.missingProject'));
    const session = await startGuestSession({
      request: {
        providerId: 'creation',
        id: t('creation.workLabel'),
        title,
        url: `${CREATION_WORK_URL_PREFIX}${kind}`,
        text: t(CREATION_PROMPT_KEY[kind]),
        projectId: created.projectId,
        navigation: 'open',
      },
      directory: null,
      t: (key, params) => formatMessage(useI18nStore.getState().dictionary, key, params),
      assertAuthorized: () => {},
    });
    if (!session?.sessionId) throw new Error(t('creation.start.sessionFailed'));
    toast.success(t('creation.start.success'), { id: 'creation-start' });
  } catch (error) {
    const reason = error instanceof Error ? error.message : t('creation.start.connectionFailed');
    toast.error(t('creation.start.failed', { reason }), { id: 'creation-start' });
  }
};
