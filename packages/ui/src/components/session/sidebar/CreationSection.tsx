import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { CREATION_ENTRIES, CREATION_GUEST_ID } from '@/lib/creation';
import { useGuestsStore } from '@/lib/guests/store';
import { useUIStore } from '@/stores/useUIStore';

/**
 * The four creation entries at the top of the session list. They open the
 * creation page with the type already chosen, so the sidebar is the entry and
 * the page never asks the user to pick a type twice.
 *
 * It follows the session list's own type scale and row rhythm: a section
 * header the size of 聊天, then one compact row per entry, not a menu.
 */
export const CreationSection: React.FC = () => {
  const available = useGuestsStore((state) => state.guests.some(
    (guest) => guest.id === CREATION_GUEST_ID && guest.enabled && Boolean(guest.pageEntry),
  ));
  if (!available) return null;
  return (
    <div className="px-2.5 pb-1 pt-2">
      <div className="flex items-center gap-1.5 px-1.5 py-1">
        <Icon name="pencil-ai" className="h-3.5 w-3.5 shrink-0 text-muted-foreground/80" />
        <span className="typography-ui-header font-semibold text-foreground">创作</span>
      </div>
      <div>
        {CREATION_ENTRIES.map((entry) => (
          <button
            key={entry.kind}
            type="button"
            onClick={() => useUIStore.getState().openCreation(entry.kind)}
            className="group flex w-full items-center gap-1.5 rounded-md py-[3px] pe-2.5 ps-1.5 text-start typography-ui-label text-foreground/90 hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
          >
            <Icon name={entry.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{entry.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
};
