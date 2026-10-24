import { CREATION_GUEST_ID } from '@/lib/creation';
import type { I18nKey } from '@/lib/i18n';
import type { GuestActionContribution } from '@openchamber/sdk';
import type { InstalledGuest } from './types';

/** App-owned manifest copy follows the host language; external manifests stay literal. */
export const localizeBuiltInGuest = (
  guest: InstalledGuest,
  t: (key: I18nKey) => string,
): InstalledGuest => {
  if (guest.source !== 'bundled') return guest;
  if (guest.id === 'openchamber-builtin-workbench') {
    return {
      ...guest,
      name: t('builtins.workbench.name'),
      pageTitle: t('builtins.workbench.page'),
    };
  }
  if (guest.id === CREATION_GUEST_ID) {
    return { ...guest, name: t('builtins.creation.name'), pageTitle: t('builtins.creation.name') };
  }
  return guest;
};

/** Display copy is separate from the manifest declaration checked by the executor. */
export const guestActionLabel = (guest: InstalledGuest, action: GuestActionContribution, t: (key: I18nKey) => string): string => (
  guest.source === 'bundled' && guest.id === 'openchamber-builtin-workbench' && action.id === 'save-task'
    ? t('builtins.workbench.saveTask')
    : action.label
);
