import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { Window } from '../../../ui/node_modules/happy-dom/lib/index.js';
import { guestMessageSchema } from '../../../sdk/src/schemas.ts';
import type { GuestMessage, GuestProject, HostMessage, HostReadyContext, HostResultPayload, JsonValue, StartSessionSent } from '../../../sdk/src/index.ts';

const windows: Window[] = [];
const context: HostReadyContext = {
  locale: 'zh-CN', directory: '/work', session: null, surface: 'page', connection: { connected: false, account: '' }, settings: {}, item: null,
  theme: { mode: 'light', tokens: {
    background: '#fff', elevated: '#fff', foreground: '#111', muted: '#666', subtle: '#eee', border: '#ccc', hover: '#eee',
    selection: '#ddd', focus: '#444', primary: '#444', font: 'sans-serif', mutedSurface: '#eee', elevatedForeground: '#111',
    active: '#ddd', selectionForeground: '#111', primaryForeground: '#fff', primaryText: '#444', successText: '#444',
    warningText: '#444', errorText: '#444', infoText: '#444', success: '#444', warning: '#444', error: '#444', info: '#444', mono: 'monospace', radius: '8px',
  } },
};
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(async () => {
  for (const window of windows.splice(0)) await window.happyDOM.close();
});

const bundle = await Bun.build({
  entrypoints: [fileURLToPath(new URL('./app.ts', import.meta.url))],
  target: 'browser', format: 'iife', write: false,
  plugins: [{
    name: 'public-sdk-entrypoints',
    setup(build) {
      build.onResolve({ filter: /^@openchamber\/sdk(?:\/ui)?$/ }, ({ path }) => ({
        path: fileURLToPath(new URL(`../../../sdk/src/${path.endsWith('/ui') ? 'ui/index.ts' : 'index.ts'}`, import.meta.url)),
      }));
    },
  }],
});
if (!bundle.success || !bundle.outputs[0]) throw new Error('Missing workbench bundle');
const script = await bundle.outputs[0].text();

const draftKey = 'oc.workbench.composerDraft';

interface Device {
  values: Map<string, JsonValue>;
  holdDraftRead?: boolean;
  releaseDraftRead?: () => void;
}

const mount = async (device?: Device, sent: StartSessionSent = 'sent') => {
  const parent = new Window();
  const window = new Window({ settings: { disableJavaScriptEvaluation: false } });
  windows.push(window, parent);
  Object.defineProperty(window, 'parent', { value: parent });
  window.document.body.innerHTML = '<div id="root"></div>';
  const messages: GuestMessage[] = [];
  const projects: GuestProject[] = [{ id: 'p1', name: 'Project', directory: '/work' }];
  const send = (message: HostMessage) => window.dispatchEvent(new window.MessageEvent('message', { source: parent, data: message }));
  const reply = (message: GuestMessage, payload?: HostResultPayload) => {
    if (!('id' in message)) throw new Error('Cannot reply to hello');
    send({ channel: 'openchamber.sdk', v: 1, type: 'result', id: message.id, ok: true, payload });
  };
  spyOn(parent, 'postMessage').mockImplementation((data) => {
    const message = guestMessageSchema.parse(data);
    messages.push(message);
    queueMicrotask(() => {
      if (message.type === 'workspace-read' && message.payload.kind === 'projects') reply(message, { kind: 'projects', state: 'ready', projects });
      if (message.type === 'workspace-subscribe') reply(message);
      if (message.type === 'file-stat') reply(message, { kind: 'missing', size: 0, mtime: 0 });
      if (message.type === 'file-read') reply(message, { content: '' });
      if (message.type === 'request') reply(message, { status: 503, body: '{}' });
      if (message.type === 'start-session') reply(message, { sessionId: 'ses-1', sent });
      if (message.type === 'open-session') reply(message);
      if (message.type === 'storage') {
        const { payload } = message;
        if (payload.op === 'get') {
          const value = device?.values.get(payload.key);
          const respond = () => reply(message, value === undefined
            ? { storage: true, op: 'get', found: false }
            : { storage: true, op: 'get', found: true, value });
          if (device?.holdDraftRead && payload.key === draftKey) device.releaseDraftRead = respond;
          else respond();
        } else if (payload.op === 'set') {
          device?.values.set(payload.key, payload.value);
          reply(message, { storage: true, op: 'set' });
        } else if (payload.op === 'delete') {
          const deleted = device?.values.delete(payload.key) ?? false;
          reply(message, { storage: true, op: 'delete', deleted });
        }
      }
    });
  });
  runInNewContext(script, {
    window, document: window.document, HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement, HTMLStyleElement: window.HTMLStyleElement,
    MessageEvent: window.MessageEvent, Image: window.Image, console, URL, TextEncoder, crypto, performance,
    setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window),
    setInterval: (callback: () => void, delay: number) => window.setInterval(callback, delay),
    ResizeObserver: window.ResizeObserver,
  });
  send({ channel: 'openchamber.sdk', v: 1, type: 'ready', payload: { ...context, features: device ? { deviceStorage: true } : {} } });
  for (let index = 0; index < 5; index++) await tick();
  const document = window.document;
  const composer = () => {
    const input = document.querySelector<HTMLInputElement>('#wb-composer');
    if (!input) throw new Error('Missing composer');
    return input;
  };
  const type = (value: string) => {
    const input = composer();
    input.value = value;
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  return { window, document, messages, composer, type, send };
};

describe('workbench composer draft', () => {
  test('keeps the typed task through a background refresh and carries it into execution', async () => {
    const { window, document: doc, messages, send } = await mount();
    const composer = doc.querySelector<HTMLInputElement>('#wb-composer');
    if (!composer) throw new Error('Missing composer');
    composer.value = '整理周五评审材料';
    composer.dispatchEvent(new window.Event('input', { bubbles: true }));
    composer.focus();
    composer.setSelectionRange(3, 3);

    // A session state change triggers refresh() -> render(), which rebuilds the page.
    send({ channel: 'openchamber.sdk', v: 1, type: 'session', payload: { session: { id: 'ses-x', title: 'Background', busy: true } } });
    for (let index = 0; index < 5; index++) await tick();

    const afterRefresh = doc.querySelector<HTMLInputElement>('#wb-composer');
    expect(afterRefresh?.value).toBe('整理周五评审材料');
    expect(doc.activeElement).toBe(afterRefresh);
    expect(afterRefresh?.selectionStart).toBe(3);

    const createTask = [...doc.querySelectorAll('button')].find((button) => button.textContent === '创建任务');
    if (!createTask) throw new Error('Missing Create task button');
    createTask.click();
    await tick();
    const started = messages.find((message) => message.type === 'start-session');
    expect(started).toBeDefined();
    expect(started && 'payload' in started ? String(started.payload?.text ?? '') : '').toContain('整理周五评审材料');
  });

  test('restores committed edits after leaving the page and removes a manually emptied draft', async () => {
    const device: Device = { values: new Map() };
    const page = await mount(device);
    page.type('整理周五评审材料');
    page.window.dispatchEvent(new page.window.Event('pagehide'));
    const reopened = await mount(device);
    expect(reopened.composer().value).toBe('整理周五评审材料');
    reopened.type('');
    await tick();
    expect((await mount(device)).composer().value).toBe('');
    expect(reopened.messages.filter((message) => message.type === 'storage').every((message) => message.payload.scope === 'device')).toBe(true);
  });

  test('a pending restore cannot overwrite typing in a new page', async () => {
    const device: Device = { values: new Map([[draftKey, 'Old draft']]), holdDraftRead: true };
    const page = await mount(device);
    page.type('New draft');
    device.releaseDraftRead?.();
    await tick();
    expect(page.composer().value).toBe('New draft');
    expect(device.values.get(draftKey)).toBe('New draft');
  });

  test('keeps a draft when the prompt fails and clears it before opening a successful session', async () => {
    const device: Device = { values: new Map() };
    const failed = await mount(device, 'failed');
    failed.type('Keep until sent');
    await tick();
    failed.composer().dispatchEvent(new failed.window.KeyboardEvent('keydown', { key: 'Enter' }));
    await tick();
    expect(device.values.get(draftKey)).toBe('Keep until sent');

    const retry = await mount(device);
    expect(retry.composer().value).toBe('Keep until sent');
    retry.composer().dispatchEvent(new retry.window.KeyboardEvent('keydown', { key: 'Enter' }));
    await tick();
    expect(retry.messages.find((message) => message.type === 'start-session')).toMatchObject({
      payload: { text: 'Keep until sent', navigation: 'preserve' },
    });
    expect(retry.messages.at(-1)).toMatchObject({ type: 'open-session', payload: { sessionId: 'ses-1' } });
    expect((await mount(device)).composer().value).toBe('');
  });

  test('IME keeps the focused node through refresh and Enter only confirms the candidate', async () => {
    const page = await mount();
    page.type('整理');
    const input = page.composer();
    input.focus();
    input.dispatchEvent(new page.window.Event('compositionstart', { bubbles: true }));
    page.send({ channel: 'openchamber.sdk', v: 1, type: 'session', payload: { session: { id: 'ses-x', title: 'Background', busy: true } } });
    await tick();
    expect(page.composer() === input).toBe(true);
    const enter = new page.window.KeyboardEvent('keydown', { key: 'Enter', cancelable: true, isComposing: true });
    input.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(false);
    input.dispatchEvent(new page.window.Event('compositionend', { bubbles: true }));
    page.type('整理材料');
    const fallback = new page.window.KeyboardEvent('keydown', { key: 'Enter', cancelable: true, keyCode: 229 });
    page.composer().dispatchEvent(fallback);
    await tick();
    expect(fallback.defaultPrevented).toBe(false);
    expect(page.composer().value).toBe('整理材料');
    expect(page.messages.filter((message) => message.type === 'start-session')).toHaveLength(0);
  });
});
