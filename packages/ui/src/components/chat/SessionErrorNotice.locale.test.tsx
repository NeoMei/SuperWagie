import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import { I18nProvider, useI18nStore } from '@/lib/i18n';
import { dict as zh } from '@/lib/i18n/messages/zh-CN';
import type { Message, Session, StructuredError } from '@/lib/opencode/model';
import { appendErrorNotification, useNotificationStore } from '@/sync/notification-store';
import { summarizeOpenCodeError } from '@/sync/session-error-log';
import { SyncProvider } from '@/sync/sync-context';
import { getSyncChildStores } from '@/sync/sync-refs';
import { SessionErrorNotice } from './SessionErrorNotice';

const directory = '/model-error-locale-test';
const sessionId = 'session-model-error-locale';
const session: Session = {
  id: sessionId, projectID: 'project', directory, title: 'test', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 }, outcome: 'failed',
};

const DOM_GLOBAL_NAMES = ['window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'IS_REACT_ACT_ENVIRONMENT'] as const;
const installDom = () => {
  const win = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  const values = { window: win, document: win.document, navigator: win.navigator, Node: win.Node, Element: win.Element,
    HTMLElement: win.HTMLElement, localStorage: win.localStorage, getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win), cancelAnimationFrame: win.cancelAnimationFrame.bind(win), IS_REACT_ACT_ENVIRONMENT: true };
  for (const name of DOM_GLOBAL_NAMES) Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  const container = document.createElement('div');
  document.body.appendChild(container);
  return { container, restore: async () => {
    await win.happyDOM.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  } };
};

describe('SessionErrorNotice locale', () => {
  let root: Root;
  let dom: ReturnType<typeof installDom>;
  let restoreFetch: () => void;
  const previousI18n = useI18nStore.getState();
  const previousNotifications = useNotificationStore.getState().list;
  // Network reads remain pending so the test owns the authoritative store contents.
  const pendingFetch = () => new Promise<Response>(() => undefined);
  const sdk = OpenCode.make({ baseUrl: 'http://model-error.test', fetch: pendingFetch });
  const store = () => {
    const result = getSyncChildStores().getChild(directory);
    if (!result) throw new Error('Expected mounted directory store');
    return result;
  };

  beforeEach(async () => {
    dom = installDom();
    const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(pendingFetch);
    restoreFetch = () => fetchSpy.mockRestore();
    useI18nStore.setState({ locale: 'zh-CN', dictionary: zh, loadingLocale: null });
    useNotificationStore.setState({ list: [] });
    root = createRoot(dom.container);
    await act(async () => root.render(
      <SyncProvider sdk={sdk} directory={directory}>
        <I18nProvider><SessionErrorNotice sessionId={sessionId} directory={directory} /></I18nProvider>
      </SyncProvider>,
    ));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    useI18nStore.setState(previousI18n);
    useNotificationStore.setState({ list: previousNotifications });
    restoreFetch();
    await dom.restore();
  });

  const stageHistory = (error: StructuredError) => act(async () => {
    const messages: Message[] = [
      { id: 'prompt', sessionID: sessionId, role: 'user', time: { created: 1 } },
      { id: 'idle', sessionID: sessionId, role: 'idle', outcome: 'failed', time: { created: 2 }, error },
    ];
    store().setState({ session: [session], session_status: { [sessionId]: { type: 'idle' } }, message: { [sessionId]: messages } });
  });

  test('updates a stored authentication error when the locale changes and preserves expanded details', async () => {
    const message = 'Authentication failed for this provider. Please re-authenticate and retry.';
    await stageHistory({ type: 'UnknownError', message });
    expect(dom.container.textContent).toContain(zh['chat.assistantError.modelAuthenticationFailed']);
    expect(dom.container.textContent).not.toContain(message);
    await act(async () => dom.container.querySelector('button')?.click());
    expect(dom.container.querySelector('pre')?.textContent).toBe(`UnknownError: ${message}`);

    await act(async () => useI18nStore.getState().setLocale('en'));
    expect(dom.container.textContent).toContain('The model connection could not be verified.');
    expect(dom.container.textContent).not.toContain(zh['chat.assistantError.modelAuthenticationFailed']);
    expect(dom.container.querySelector('pre')?.textContent).toBe(`UnknownError: ${message}`);
    expect(store().getState().message[sessionId]?.at(-1)).toMatchObject({ error: { message } });
  });

  test('uses HTTP 429 from a live error even when its detail is not English', async () => {
    await act(async () => {
      store().setState({ session_status: { [sessionId]: { type: 'idle' } } });
      appendErrorNotification({
        session: sessionId, directory, time: Date.now(),
        error: summarizeOpenCodeError({ type: 'ProviderRequestError', status: 429, message: '调用频率超出上限' }),
      });
    });
    expect(dom.container.textContent).toContain(zh['chat.assistantError.rateLimited']);
    expect(dom.container.textContent).toContain(zh['chat.sessionError.modelReplyTitle']);
    expect(dom.container.textContent).not.toContain(zh['chat.assistantError.modelAuthenticationFailed']);
    await act(async () => useI18nStore.getState().setLocale('en'));
    expect(dom.container.textContent).toContain('The model is receiving too many requests.');
  });
});
