import type { I18nKey } from '@/lib/i18n/messages/en';
import { formatMessage, useI18nStore } from '@/lib/i18n/store';

/**
 * Desktop update failures cross the IPC boundary as plain strings, so the main
 * process tags them with a code the interface can translate. Anything without
 * the tag (Squirrel's own text, a filesystem error) is shown as it arrived.
 */
const CODE_PREFIX = 'E_UPDATE:';

const UPDATE_ERROR_KEYS = new Map<string, I18nKey>([
  ['checkFailed', 'update.error.checkFailed'],
  ['feedInvalid', 'update.error.feedInvalid'],
  ['downloadFailed', 'update.error.downloadFailed'],
  ['checksum', 'update.error.checksum'],
  ['size', 'update.error.size'],
  ['unpack', 'update.error.unpack'],
  ['bundle', 'update.error.bundle'],
  ['noPackage', 'update.error.noPackage'],
]);

export const isCodedUpdateError = (message: string): boolean =>
  message.startsWith(CODE_PREFIX);

export const formatUpdateError = (error: Error | string): string => {
  const raw = error instanceof Error ? error.message : error;
  if (!raw.startsWith(CODE_PREFIX)) return raw.trim();

  const rest = raw.slice(CODE_PREFIX.length);
  const separator = rest.indexOf(':');
  const code = separator >= 0 ? rest.slice(0, separator) : rest;
  const detail = separator >= 0 ? rest.slice(separator + 1).trim() : '';
  const key = UPDATE_ERROR_KEYS.get(code);
  if (!key) return raw.trim();

  return formatMessage(useI18nStore.getState().dictionary, key, { detail });
};
