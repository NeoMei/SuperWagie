import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { Window } from '../../../ui/node_modules/happy-dom/lib/index.js';
import { guestMessageSchema } from '../../../sdk/src/schemas.ts';
import type { GuestMessage, GuestProject, HostMessage, HostReadyContext, HostResultPayload } from '../../../sdk/src/index.ts';

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

describe('workbench composer draft', () => {
  test('keeps the typed task through a background refresh and carries it into execution', async () => {
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
    expect(bundle.success).toBe(true);
    const script = bundle.outputs[0];
    if (!script) throw new Error('Missing workbench bundle');
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
        if (message.type === 'start-session') reply(message, { sessionId: 'ses-1', sent: 'skipped' });
      });
    });
    runInNewContext(await script.text(), {
      window, document: window.document, HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement,
      HTMLTextAreaElement: window.HTMLTextAreaElement, HTMLStyleElement: window.HTMLStyleElement,
      MessageEvent: window.MessageEvent, Image: window.Image, console, URL, TextEncoder, crypto, performance,
      setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window),
      setInterval: (callback: () => void, delay: number) => window.setInterval(callback, delay),
      ResizeObserver: window.ResizeObserver,
    });
    send({ channel: 'openchamber.sdk', v: 1, type: 'ready', payload: { ...context, features: {} } });
    for (let index = 0; index < 5; index++) await tick();
    const doc = window.document;
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
});
