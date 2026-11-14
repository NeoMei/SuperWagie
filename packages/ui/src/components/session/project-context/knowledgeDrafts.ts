import { useCallback, useSyncExternalStore } from 'react';
import { resolveProjectContextId, type ProjectRef } from '@/lib/projectContextApi';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

type Draft = { text: string; revision: number; saving: boolean };
type Form = 'notes' | 'todos' | 'plans' | 'note-body';

// User-authored project drafts have no cache retention limit. They survive
// panel remounts in this process and are released only by confirmed saves.
const drafts = new Map<string, Draft>();
const listeners = new Set<() => void>();
const publish = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function useKnowledgeDraft(projectRef: ProjectRef, form: Form, entryId = 'new', initialText = '') {
  const runtimeKey = useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeKey, getRuntimeKey);
  const key = JSON.stringify([runtimeKey, resolveProjectContextId(projectRef), form, entryId]);
  const draft = useSyncExternalStore(subscribe, () => drafts.get(key), () => drafts.get(key));
  const updateText = useCallback((update: (text: string) => string) => {
    const current = drafts.get(key);
    const text = update(current?.text ?? initialText);
    drafts.set(key, { text, revision: (current?.revision ?? 0) + 1, saving: current?.saving ?? false });
    publish();
  }, [initialText, key]);
  const setText = useCallback((text: string) => updateText(() => text), [updateText]);
  const save = useCallback(async (persist: (text: string) => Promise<boolean> | boolean): Promise<boolean> => {
    const current = drafts.get(key);
    if (getRuntimeKey() !== runtimeKey || !current || current.saving || !current.text.trim()) return false;
    drafts.set(key, { ...current, saving: true });
    publish();
    let saved = false;
    try {
      saved = await persist(current.text);
      return saved;
    } finally {
      const latest = drafts.get(key);
      if (latest) {
        if (saved && latest.revision === current.revision) drafts.delete(key);
        else drafts.set(key, { ...latest, saving: false });
        publish();
      }
    }
  }, [key, runtimeKey]);
  return { key, text: draft?.text ?? initialText, dirty: draft !== undefined, saving: draft?.saving ?? false, setText, updateText, save };
}
