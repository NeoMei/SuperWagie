import { expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { useSidebarBulkActions } from './useSidebarBulkActions';
import { SessionRowOrderProvider } from '../sessions/sessionRowOrder';
import { I18nProvider } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionMultiSelectStore } from '@/stores/useSessionMultiSelectStore';
import { getEffectiveShortcutCombo, ShortcutDispatcher, shortcutRegistry } from '@/lib/shortcuts';
import type { BulkDeleteSessionsConfirmState } from '../shell/ConfirmDialogs';

test('bulk overrides retain project descendants, editable guards and confirmation ownership', async () => {
  const dom = new Window({ url: 'http://bulk.test' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({ window: dom, document: dom.document, navigator: dom.navigator, Element: dom.Element, HTMLElement: dom.HTMLElement, Event: dom.Event, KeyboardEvent: dom.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  const previous = useSessionMultiSelectStore.getState();
  const overrides = useUIStore.getState().shortcutOverrides;
  useSessionMultiSelectStore.setState({ enabled: true, selectedIds: new Set(['a']), scopeKey: 'project', anchorId: 'a' });
  useUIStore.setState({ shortcutOverrides: { sessions_select_all: 'ctrl+y', sessions_bulk_delete: 'ctrl+u' } });
  const confirmations: BulkDeleteSessionsConfirmState[] = [];
  function Owner({ editing }: { editing: boolean }) {
    const [confirm, setConfirm] = React.useState<BulkDeleteSessionsConfirmState>(null);
    React.useEffect(() => { if (confirm) confirmations.push(confirm); }, [confirm]);
    useSidebarBulkActions({ isInlineEditing: editing, showDeletionDialog: true, foldersMap: {}, getFolderScopesForProject: () => [], addSessionsToFolder() {}, removeSessionsFromFolders() {}, createFolderAndStartRename: () => null,
      archiveSessions: async () => ({ archivedIds: [], failedIds: [] }), unarchiveSessions: async () => ({ restoredIds: [], failedIds: [] }), deleteSessions: async () => ({ deletedIds: [], failedIds: [] }),
      bulkDeleteConfirm: confirm, setBulkDeleteConfirm: setConfirm,
    });
    return <input id="editable" />;
  }
  const root = createRoot(document.body.appendChild(document.createElement('div')));
  const dispatcher = new ShortcutDispatcher({ registry: shortcutRegistry, getBinding: id => getEffectiveShortcutCombo(id, useUIStore.getState().shortcutOverrides) });
  const listener = (event: KeyboardEvent) => { dispatcher.dispatch(event); };
  window.addEventListener('keydown', listener);
  const render = async (editing: boolean) => act(async () => root.render(<I18nProvider><SessionRowOrderProvider
    entries={[{ id: 'a', rowKey: 'a', scopeKey: 'project', archived: false, descendantRange: [0, 1] }, { id: 'b', rowKey: 'b', scopeKey: 'project', archived: false }, { id: 'foreign', rowKey: 'foreign', scopeKey: 'elsewhere', archived: false }]}
    descendantIds={['child']} sessionsById={new Map([['a', {}], ['child', {}], ['b', {}]])}><Owner editing={editing} /></SessionRowOrderProvider></I18nProvider>));
  const press = (key: string, input = false) => (input ? document.getElementById('editable')! : document.body).dispatchEvent(new KeyboardEvent('keydown', { key, code: `Key${key.toUpperCase()}`, ctrlKey: true, bubbles: true, cancelable: true }));
  try {
    await render(false);
    await act(async () => { press('a'); press('y', true); });
    expect([...useSessionMultiSelectStore.getState().selectedIds]).toEqual(['a']);
    await act(async () => { press('y'); });
    expect([...useSessionMultiSelectStore.getState().selectedIds]).toEqual(['a', 'child', 'b']);
    await render(true);
    await act(async () => { press('u'); });
    expect(confirmations).toEqual([]);
    await render(false);
    await act(async () => { press('u'); });
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]?.sessionIds).toEqual(['a', 'child', 'b']);
    await act(async () => { press('u'); });
    expect(confirmations).toHaveLength(1);
  } finally {
    window.removeEventListener('keydown', listener);
    await act(async () => root.unmount());
    useSessionMultiSelectStore.setState(previous, true);
    useUIStore.setState({ shortcutOverrides: overrides });
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name);
    }
    await dom.happyDOM.close();
  }
});
