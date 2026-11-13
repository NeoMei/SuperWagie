import React from 'react';

import { InlineDictationButton } from '@/components/dictation/InlineDictationButton';
import { Icon } from '@/components/icon/Icon';
import { isIMECompositionEvent } from '@/lib/ime';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import type { ProjectRef } from '@/lib/projectContextApi';
import { KNOWLEDGE_ICON_BUTTON_CLASS } from './knowledgeRowStyle';
import { useKnowledgeDraft } from './knowledgeDrafts';

/** The counter appears only once the text gets close to the limit. */
const COUNTER_THRESHOLD = 0.8;

/**
 * The one way every section adds an entry: a single line that grows with its
 * text. Enter adds. A multiline field follows the chat composer: Shift+Enter
 * starts a new line on desktop, and on a phone, whose keyboard has no
 * Shift+Enter, Return starts a new line and the add button adds. A one-line
 * field turns pasted line breaks into spaces.
 *
 * Drafts belong to their runtime, project and form until a confirmed save.
 */
export const KnowledgeComposer: React.FC<{
  projectRef: ProjectRef;
  form: 'notes' | 'todos' | 'plans';
  placeholder: string;
  addLabel: string;
  maxLength: number;
  multiline?: boolean;
  dictation?: boolean;
  disabled?: boolean;
  /** Resolves false when the entry was not added; the text then stays. */
  onSubmit: (text: string) => Promise<boolean> | boolean;
  /** Extra controls before the add button, such as an import action. */
  extraActions?: React.ReactNode;
}> = ({ projectRef, form, placeholder, addLabel, maxLength, multiline = false, dictation = true, disabled = false, onSubmit, extraActions }) => {
  const { key: draftKey, text, setText, updateText, saving: submitting, save } = useKnowledgeDraft(projectRef, form);
  const isMobile = useUIStore((state) => state.isMobile);

  const normalize = React.useCallback((value: string) => (
    (multiline ? value : value.replace(/\r?\n/g, ' ')).slice(0, maxLength)
  ), [maxLength, multiline]);

  const submit = React.useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || submitting) return;
    await save((value) => onSubmit(value.trim()));
  }, [onSubmit, save, submitting, text]);

  const showCounter = text.length >= maxLength * COUNTER_THRESHOLD;
  // The field itself stays enabled while an entry saves: disabling it would
  // drop the focus, and the next entry typed right away would go nowhere.
  const blocked = disabled || submitting;

  return (
    <div
      className={cn(
        'oc-surface-elevated flex items-end gap-1 rounded-lg bg-[var(--surface-elevated)] py-1 pe-1 ps-3',
        'oc-raised oc-field',
        disabled && 'opacity-50',
      )}
    >
      <textarea
        rows={1}
        value={text}
        onChange={(event) => setText(normalize(event.target.value))}
        onKeyDown={(event) => {
          if (isIMECompositionEvent(event)) return;
          if (event.key !== 'Enter') return;
          const modified = event.ctrlKey || event.metaKey;
          const submits = !multiline || modified || (!isMobile && !event.shiftKey);
          if (submits) {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder={placeholder}
        disabled={disabled}
        spellCheck={multiline}
        autoComplete="off"
        className={cn(
          'block min-h-6 w-full min-w-0 resize-none field-sizing-content bg-transparent py-0.5 typography-markdown md:typography-ui-label text-foreground outline-none placeholder:text-muted-foreground',
          multiline ? 'max-h-[calc(12lh+0.25rem)]' : 'max-h-[calc(6lh+0.25rem)]',
          'focus-visible:outline-none disabled:cursor-not-allowed',
        )}
      />
      {showCounter ? (
        <span className="flex h-6 flex-shrink-0 items-center typography-micro text-muted-foreground" dir="auto">
          {text.length}/{maxLength}
        </span>
      ) : null}
      {dictation ? (
        // Dictation continues the draft instead of adding it, so a misheard
        // word can be fixed before it lands.
        <InlineDictationButton
          key={draftKey}
          onTranscript={(spoken) => updateText((current) => normalize(current.trim() ? `${current.trimEnd()} ${spoken}` : spoken))}
          disabled={disabled}
          buttonClassName={KNOWLEDGE_ICON_BUTTON_CLASS}
        />
      ) : null}
      {extraActions}
      <button
        type="button"
        onClick={() => void submit()}
        disabled={blocked || text.trim().length === 0}
        className={KNOWLEDGE_ICON_BUTTON_CLASS}
        aria-label={addLabel}
        title={addLabel}
      >
        <Icon name="add" className="h-4 w-4" />
      </button>
    </div>
  );
};
