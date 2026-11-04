import type { I18nKey, I18nParams, Locale } from '@/lib/i18n';

export type AgentStatus = { key: I18nKey; count?: number; name?: string; seed?: string };
type Translate = (key: I18nKey, params?: I18nParams) => string;

const THINKING_KEYS = [
  'chat.agentStatus.thinking.benmaRun', 'chat.agentStatus.thinking.benmaGroom',
  'chat.agentStatus.thinking.benmaFeed', 'chat.agentStatus.thinking.benmaReturn',
  'chat.agentStatus.thinking.benmaMeeting', 'chat.agentStatus.thinking.benmaTrail',
] satisfies I18nKey[];

const hash = (seed: string): number => {
  let value = 0;
  for (let i = 0; i < seed.length; i += 1) value = ((value << 5) - value + seed.charCodeAt(i)) | 0;
  return Math.abs(value);
};

export const formatAgentStatusPhrase = (t: Translate, _locale: Locale, status: AgentStatus): string => {
  const seed = status.key === 'chat.agentStatus.thinking' ? status.seed : undefined;
  const key = seed && hash(seed) % 4 === 0 ? THINKING_KEYS[Math.floor(hash(seed) / 4) % THINKING_KEYS.length] : status.key;
  return t(key, { count: status.count, name: status.name });
};

export const formatAgentStatus = (t: Translate, locale: Locale, status: AgentStatus, modelName?: string | null): string => {
  const phrase = formatAgentStatusPhrase(t, locale, status);
  const model = modelName?.trim();
  return model ? t('chat.statusRow.modelStatus', { model, status: phrase }) : phrase.charAt(0).toLocaleUpperCase(locale) + phrase.slice(1);
};

export const agentStatusSignature = (status: AgentStatus): string => JSON.stringify([status.key, status.count, status.name, status.seed]);
