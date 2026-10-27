import { afterEach, expect, spyOn, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { Window } from '../../../ui/node_modules/happy-dom/lib/index.js';
import { guestMessageSchema } from '../../../sdk/src/schemas.ts';
import type { GuestMessage, HostMessage, HostReadyContext, HostResultPayload, JsonValue } from '../../../sdk/src/index.ts';

const windows: Window[] = [];
const ready: HostReadyContext = {
  locale: 'en', directory: null, session: null, surface: 'page', connection: { connected: false, account: '' }, settings: {}, item: null,
  theme: { mode: 'light', tokens: {
    background: '#fff', elevated: '#fff', foreground: '#111', muted: '#666', subtle: '#eee', border: '#ccc', hover: '#eee',
    selection: '#ddd', focus: '#444', primary: '#444', font: 'sans-serif', mutedSurface: '#eee', elevatedForeground: '#111',
    active: '#ddd', selectionForeground: '#111', primaryForeground: '#fff', primaryText: '#444', successText: '#444',
    warningText: '#444', errorText: '#444', infoText: '#444', success: '#444', warning: '#444', error: '#444', info: '#444', mono: 'monospace', radius: '8px',
  } },
};
const notes = [
  { id: 'second', body: 'Second note', createdAt: 2 },
  { id: 'first', body: 'First note', createdAt: 3 },
  { id: 'third', body: 'Third note', createdAt: 1 },
];
const notesKey = 'oc.workbench.notes';
const bundle = await Bun.build({
  entrypoints: [fileURLToPath(new URL('./app.ts', import.meta.url))], target: 'browser', format: 'iife', write: false,
  plugins: [{ name: 'public-sdk', setup(build) {
    build.onResolve({ filter: /^@openchamber\/sdk(?:\/ui)?$/ }, ({ path }) => ({
      path: fileURLToPath(new URL(`../../../sdk/src/${path.endsWith('/ui') ? 'ui/index.ts' : 'index.ts'}`, import.meta.url)),
    }));
  } }],
});
if (!bundle.success || !bundle.outputs[0]) throw new Error('Could not build the workbench');
const script = await bundle.outputs[0].text();

interface DeviceNotes {
  value: JsonValue;
  failRead?: boolean;
  failWrite?: boolean;
  holdFirstWrite?: boolean;
  releaseWrite?: () => void;
}

const mount = async (saved = JSON.stringify(notes), device?: DeviceNotes) => {
  const parent = new Window();
  const window = new Window({ url: 'http://workbench.test', settings: { disableJavaScriptEvaluation: false } });
  windows.push(window, parent);
  Object.defineProperty(window, 'parent', { value: parent });
  window.document.body.innerHTML = '<div id="root"></div>';
  window.localStorage.setItem(notesKey, saved);
  const messages: GuestMessage[] = [];
  const send = (message: HostMessage) => window.dispatchEvent(new window.MessageEvent('message', { source: parent, data: message }));
  spyOn(parent, 'postMessage').mockImplementation((data) => {
    const message = guestMessageSchema.parse(data);
    messages.push(message);
    if (!('id' in message)) return;
    if (message.type === 'storage') {
      const failed = message.payload.op === 'get' ? device?.failRead : device?.failWrite;
      // The device host commits accepted writes in receive order. Holding an
      // acknowledgement must not make the fixture commit an old write later.
      if (!failed && message.payload.op === 'set' && device) device.value = message.payload.value;
      const respond = () => {
        if (failed) {
          send({ channel: 'openchamber.sdk', v: 1, type: 'result', id: message.id, ok: false, code: 'HOST_REJECTED', error: 'Storage unavailable' });
          return;
        }
        const payload: HostResultPayload = message.payload.op === 'get'
          ? { storage: true, op: 'get', found: true, value: device?.value ?? [] }
          : { storage: true, op: 'set' };
        send({ channel: 'openchamber.sdk', v: 1, type: 'result', id: message.id, ok: true, payload });
      };
      if (message.payload.op === 'set' && device?.holdFirstWrite) {
        device.holdFirstWrite = false;
        device.releaseWrite = respond;
      } else queueMicrotask(respond);
      return;
    }
    const payload: HostResultPayload | undefined = message.type === 'workspace-read' ? { kind: 'projects', state: 'ready', projects: [] }
      : message.type === 'file-stat' ? { kind: 'missing' }
        : message.type === 'request' ? { status: 503, body: '{}' } : undefined;
    queueMicrotask(() => send({ channel: 'openchamber.sdk', v: 1, type: 'result', id: message.id, ok: true, payload }));
  });
  runInNewContext(script, {
    window, document: window.document, localStorage: window.localStorage,
    HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement, HTMLStyleElement: window.HTMLStyleElement,
    MessageEvent: window.MessageEvent, Image: window.Image, console, URL, TextEncoder, crypto, performance,
    setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window), clearInterval: window.clearInterval.bind(window),
    ResizeObserver: window.ResizeObserver,
  });
  const setLocale = (locale: string) => send({ channel: 'openchamber.sdk', v: 1, type: 'ready', payload: { ...ready, locale, features: { deviceStorage: !!device } } });
  setLocale('en');
  for (let index = 0; index < 5; index++) await new Promise((resolve) => setTimeout(resolve, 0));
  return { window, document: window.document, setLocale, messages };
};

afterEach(async () => {
  for (const window of windows.splice(0)) {
    window.dispatchEvent(new window.Event('pagehide'));
    await window.happyDOM.close();
  }
});

test('sandboxed notes restore and save order through device storage without server storage', async () => {
  const device = { value: notes };
  const page = await mount('[]', device);
  expect([...page.document.querySelectorAll('.notes-list .note-body')].map((node) => node.textContent)).toEqual(['Second note', 'First note', 'Third note']);
  const handle = page.document.querySelector<HTMLElement>('.note-drag');
  if (!handle) throw new Error('Missing note reorder handle');
  handle.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  for (let index = 0; index < 3; index++) await new Promise((resolve) => setTimeout(resolve, 0));
  expect(device.value).toEqual([notes[1], notes[0], notes[2]]);
  const requests = page.messages.filter((message) => message.type === 'storage');
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((message) => message.payload.scope === 'device')).toBe(true);
  page.setLocale('zh-CN');
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(page.messages.filter((message) => message.type === 'storage' && message.payload.op === 'get')).toHaveLength(1);
  const reloaded = await mount('[]', device);
  expect([...reloaded.document.querySelectorAll('.notes-list .note-body')].map((node) => node.textContent)).toEqual(['First note', 'Second note', 'Third note']);
});

test('a failed device read retains local notes and does not overwrite the unread device snapshot', async () => {
  const device = { value: notes, failRead: true };
  const page = await mount(JSON.stringify(notes), device);
  expect([...page.document.querySelectorAll('.notes-list .note-body')].map((node) => node.textContent)).toEqual(['Second note', 'First note', 'Third note']);
  expect(page.document.querySelector('.notice')?.textContent).toContain('Could not load sticky notes');
  expect(page.messages.some((message) => message.type === 'storage' && message.payload.op === 'set')).toBe(false);
  expect(device.value).toEqual(notes);
});

test('rapid moves send every snapshot before prior acknowledgements and keep the final order', async () => {
  const device: DeviceNotes = { value: notes, holdFirstWrite: true };
  const page = await mount('[]', device);
  const move = () => {
    const handle = page.document.querySelector<HTMLElement>('[data-note-id="second"] .note-drag');
    if (!handle) throw new Error('Missing reorder handle');
    handle.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  };
  move();
  move();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(page.messages.filter((message) => message.type === 'storage' && message.payload.op === 'set')).toHaveLength(2);
  expect(page.document.querySelector('.note-save-state')?.textContent).toBe('');
  page.window.dispatchEvent(new page.window.Event('pagehide'));
  device.releaseWrite?.();
  for (let index = 0; index < 3; index++) await new Promise((resolve) => setTimeout(resolve, 0));
  expect(device.value).toEqual([notes[1], notes[2], notes[0]]);
  expect([...page.document.querySelectorAll('.notes-list .note-body')].map((node) => node.textContent)).toEqual(['First note', 'Third note', 'Second note']);
});

test('failed saves keep the visible order and allow the next move to save successfully', async () => {
  const device: DeviceNotes = { value: notes, failWrite: true };
  const page = await mount('[]', device);
  const move = () => {
    const handle = page.document.querySelector<HTMLElement>('[data-note-id="second"] .note-drag');
    if (!handle) throw new Error('Missing reorder handle');
    handle.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  };
  move();
  for (let index = 0; index < 3; index++) await new Promise((resolve) => setTimeout(resolve, 0));
  expect(page.document.querySelector('.notice')?.textContent).toContain('Could not save sticky notes');
  expect([...page.document.querySelectorAll('.notes-list .note-body')].map((node) => node.textContent)).toEqual(['First note', 'Second note', 'Third note']);
  expect(device.value).toEqual(notes);
  device.failWrite = false;
  move();
  for (let index = 0; index < 3; index++) await new Promise((resolve) => setTimeout(resolve, 0));
  expect(device.value).toEqual([notes[1], notes[2], notes[0]]);
  expect(page.document.querySelector<HTMLElement>('.notice')?.hidden).toBe(true);
});

test('notes keep their saved order across reorder, collapse, language change and reload', async () => {
  const page = await mount();
  const bodies = () => [...page.document.querySelectorAll('.notes-list .note-body')].map((node) => node.textContent);
  expect(bodies()).toEqual(['Second note', 'First note', 'Third note']);
  const draft = page.document.querySelector<HTMLTextAreaElement>('.note-composer textarea');
  if (!draft) throw new Error('Missing note composer');
  draft.value = 'Keep this draft';
  draft.dispatchEvent(new page.window.Event('input', { bubbles: true }));
  const handle = page.document.querySelector<HTMLElement>('.notes-list .note .note-drag');
  if (!handle) throw new Error('Missing note reorder handle');
  handle.focus();
  handle.dispatchEvent(new page.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(bodies()).toEqual(['First note', 'Second note', 'Third note']);
  expect(page.document.querySelector<HTMLTextAreaElement>('.note-composer textarea')?.value).toBe('Keep this draft');
  expect(page.document.activeElement?.closest<HTMLElement>('.note')?.dataset.noteId).toBe('second');
  page.document.querySelector<HTMLElement>('.note-toggle')?.click();
  expect([...page.document.querySelectorAll('.note-pile-card .note-body')].map((node) => node.textContent)).toEqual(['First note', 'Second note', 'Third note']);
  expect(page.document.querySelector('.note-drag')).toBeNull();
  page.document.querySelector<HTMLElement>('.note-toggle')?.click();
  page.setLocale('zh-CN');
  expect(bodies()).toEqual(['First note', 'Second note', 'Third note']);
  expect(page.document.querySelector('.note-drag')?.getAttribute('aria-label')).toContain('拖动');
  const saved = page.window.localStorage.getItem(notesKey);
  if (!saved) throw new Error('Missing saved note order');
  const reloaded = await mount(saved);
  expect([...reloaded.document.querySelectorAll('.notes-list .note-body')].map((node) => node.textContent)).toEqual(['First note', 'Second note', 'Third note']);
  expect(page.messages.some((message) => message.type === 'file-write' || message.type === 'storage')).toBe(false);
});
