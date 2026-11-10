import type { I18nKey, I18nParams, Locale } from '@/lib/i18n';

export type AgentStatus = { key: I18nKey; count?: number; name?: string; seed?: string };
type Translate = (key: I18nKey, params?: I18nParams) => string;

/**
 * The phrasings each kind of work can say itself: six horse lines for
 * thinking, two for the rest. The status signature picks one and keeps it, so
 * the same work reads the same line while it runs and across the status row
 * and scroll pill handoff, and a new kind of work picks its own line.
 */
const STATUS_VARIANTS = new Map(Object.entries<readonly I18nKey[]>({
  'chat.agentStatus.working': ['chat.agentStatus.working', 'chat.agentStatus.working.trot'],
  'chat.agentStatus.thinking': [
    'chat.agentStatus.thinking.benmaRun', 'chat.agentStatus.thinking.benmaGroom',
    'chat.agentStatus.thinking.benmaFeed', 'chat.agentStatus.thinking.benmaReturn',
    'chat.agentStatus.thinking.benmaMeeting', 'chat.agentStatus.thinking.benmaTrail',
  ],
  'chat.agentStatus.composing': ['chat.agentStatus.composing', 'chat.agentStatus.composing.trot'],
  'chat.agentStatus.waitingPermission': ['chat.agentStatus.waitingPermission', 'chat.agentStatus.waitingPermission.trot'],
  'chat.agentStatus.waitingAnswer': ['chat.agentStatus.waitingAnswer', 'chat.agentStatus.waitingAnswer.trot'],
  'chat.agentStatus.usingTool': ['chat.agentStatus.usingTool', 'chat.agentStatus.usingTool.trot'],
  'chat.agentStatus.read': ['chat.agentStatus.read', 'chat.agentStatus.read.trot'],
  'chat.agentStatus.read.count': ['chat.agentStatus.read.count', 'chat.agentStatus.read.count.trot'],
  'chat.agentStatus.search': ['chat.agentStatus.search', 'chat.agentStatus.search.trot'],
  'chat.agentStatus.edit': ['chat.agentStatus.edit', 'chat.agentStatus.edit.trot'],
  'chat.agentStatus.edit.count': ['chat.agentStatus.edit.count', 'chat.agentStatus.edit.count.trot'],
  'chat.agentStatus.command': ['chat.agentStatus.command', 'chat.agentStatus.command.trot'],
  'chat.agentStatus.command.count': ['chat.agentStatus.command.count', 'chat.agentStatus.command.count.trot'],
  'chat.agentStatus.lookup': ['chat.agentStatus.lookup', 'chat.agentStatus.lookup.trot'],
  'chat.agentStatus.delegate': ['chat.agentStatus.delegate', 'chat.agentStatus.delegate.trot'],
  'chat.agentStatus.delegate.count': ['chat.agentStatus.delegate.count', 'chat.agentStatus.delegate.count.trot'],
  'chat.agentStatus.question': ['chat.agentStatus.question', 'chat.agentStatus.question.trot'],
  'chat.agentStatus.skill': ['chat.agentStatus.skill', 'chat.agentStatus.skill.trot'],
  'chat.agentStatus.skill.count': ['chat.agentStatus.skill.count', 'chat.agentStatus.skill.count.trot'],
}));

const hash = (seed: string): number => {
  let value = 0;
  for (let i = 0; i < seed.length; i += 1) value = ((value << 5) - value + seed.charCodeAt(i)) | 0;
  return Math.abs(value);
};

/** Same work, same signature: the count, the tool name and the reasoning seed change the line. */
export const agentStatusSignature = (status: AgentStatus): string => (
  JSON.stringify([status.key, status.count ?? null, status.name ?? null, status.seed ?? null])
);

/** The dictionary key a status reads as, its variant chosen by its signature. */
const agentStatusVariantKey = (status: AgentStatus): I18nKey => {
  const variants = STATUS_VARIANTS.get(status.key);
  if (!variants) return status.key;
  return variants[hash(agentStatusSignature(status)) % variants.length] ?? status.key;
};

export const formatAgentStatusPhrase = (t: Translate, _locale: Locale, status: AgentStatus): string => (
  t(agentStatusVariantKey(status), { count: status.count, name: status.name })
);

export const formatAgentStatus = (t: Translate, locale: Locale, status: AgentStatus, modelName?: string | null): string => {
  const phrase = formatAgentStatusPhrase(t, locale, status);
  const model = modelName?.trim();
  return model ? t('chat.statusRow.modelStatus', { model, status: phrase }) : phrase.charAt(0).toLocaleUpperCase(locale) + phrase.slice(1);
};
