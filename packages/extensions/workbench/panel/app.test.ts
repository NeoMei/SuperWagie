import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { Window } from '../../../ui/node_modules/happy-dom/lib/index.js';
import { guestMessageSchema } from '../../../sdk/src/schemas.ts';
import type { GuestMessage, GuestProject, HostMessage, HostReadyContext, HostResultPayload } from '../../../sdk/src/index.ts';

const windows: Window[] = [];
const context: HostReadyContext = {
  locale: 'zh-CN', directory: null, session: null, surface: 'page', connection: { connected: false, account: '' }, settings: {}, item: null,
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

describe('built-in workbench language updates', () => {
  test('updates the mounted page without reloading task data or losing user edits', async () => {
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
    let directory: string | null = null;
    let projects: GuestProject[] = [];
    let projectContent = '';
    let holdNextProjectRead = false;
    let delayedProjectRead: GuestMessage | null = null;
    const send = (message: HostMessage) => window.dispatchEvent(new window.MessageEvent('message', { source: parent, data: message }));
    const reply = (message: GuestMessage, payload?: HostResultPayload) => {
      if (!('id' in message)) throw new Error('Cannot reply to hello');
      send({ channel: 'openchamber.sdk', v: 1, type: 'result', id: message.id, ok: true, payload });
    };
    const taskFile = '- [ ] 用户任务 <!-- sw {"id":"tsk_test","state":"planned","note":"原有说明"} -->\n';
    spyOn(parent, 'postMessage').mockImplementation((data) => {
      const message = guestMessageSchema.parse(data);
      messages.push(message);
      queueMicrotask(() => {
        if (message.type === 'workspace-read' && message.payload.kind === 'projects') reply(message, { kind: 'projects', state: 'ready', projects });
        if (message.type === 'workspace-subscribe') reply(message);
        if (message.type === 'file-stat') reply(message, { kind: message.payload.path.includes('tasks.md') || projectContent ? 'file' : 'missing', size: taskFile.length, mtime: 1 });
        if (message.type === 'file-read') {
          if (message.payload.path.includes('tasks.md')) reply(message, { content: taskFile });
          else if (holdNextProjectRead) { holdNextProjectRead = false; delayedProjectRead = message; }
          else reply(message, { content: projectContent });
        }
        if (message.type === 'request') reply(message, { status: 200, body: JSON.stringify({ weather: { label: '多云', temp: '18°' } }) });
        if (message.type === 'start-session') reply(message, { sessionId: 'qa-new-session', sent: 'skipped' });
      });
    });
    runInNewContext(await script.text(), {
      window, document: window.document, HTMLElement: window.HTMLElement, HTMLInputElement: window.HTMLInputElement,
      HTMLTextAreaElement: window.HTMLTextAreaElement, HTMLStyleElement: window.HTMLStyleElement,
      MessageEvent: window.MessageEvent, Image: window.Image, console, URL, TextEncoder, crypto, performance,
      setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window), setInterval: window.setInterval.bind(window),
      ResizeObserver: window.ResizeObserver,
    });
    const ready = (locale: string) => send({ channel: 'openchamber.sdk', v: 1, type: 'ready', payload: { ...context, locale, directory } });
    ready('zh-CN');
    for (let index = 0; index < 5; index++) await tick();
    const document = window.document;
    expect(document.body.textContent).toContain('写文档');
    expect(document.body.textContent).toContain('用户任务');
    document.querySelector<HTMLElement>('.task')?.click();
    const composer = document.querySelector<HTMLInputElement>('#wb-composer');
    const note = document.querySelector<HTMLTextAreaElement>('.note-composer textarea');
    const title = document.querySelector<HTMLInputElement>('.editor input');
    if (!composer || !note || !title) throw new Error('Missing workbench draft fields');
    composer.value = 'Keep my prompt';
    note.value = '客户 note';
    title.value = 'Unsaved task title';
    document.querySelector<HTMLElement>('.editor .seg button[data-value="waiting"]')?.click();
    title.focus();
    title.setSelectionRange(2, 7);
    const quote = document.querySelector('.soup-quote')?.textContent;
    const reads = messages.filter((message) => ['file-read', 'file-stat', 'workspace-read', 'request'].includes(message.type)).length;
    ready('en');
    for (let index = 0; index < 3; index++) await tick();
    expect(document.body.textContent).toContain('Write a document');
    expect(document.body.textContent).toContain('Create a presentation');
    expect(document.body.textContent).toContain('Task details');
    expect(document.body.textContent).not.toContain('最近成果');
    expect(document.querySelector('.soup-quote')?.textContent).not.toBe(quote);
    expect(/\p{Script=Han}/u.test(document.querySelector('.soup-quote')?.textContent ?? '')).toBe(false);
    expect(document.querySelector<HTMLInputElement>('#wb-composer')?.value).toBe('Keep my prompt');
    expect(document.querySelector<HTMLTextAreaElement>('.note-composer textarea')?.value).toBe('客户 note');
    const restored = document.querySelector<HTMLInputElement>('.editor input');
    expect(restored?.value).toBe('Unsaved task title');
    expect(restored?.selectionStart).toBe(2);
    expect(restored?.selectionEnd).toBe(7);
    expect(document.activeElement).toBe(restored);
    expect(document.querySelector('.editor .seg')?.getAttribute('data-value')).toBe('waiting');
    document.querySelector<HTMLElement>('.editor .seg button[data-value="planned"]')?.click();
    expect(document.querySelector('.editor .seg')?.getAttribute('data-value')).toBe('planned');
    expect(messages.filter((message) => ['file-read', 'file-stat', 'workspace-read', 'request'].includes(message.type))).toHaveLength(reads);
    expect(messages.some((message) => message.type === 'file-write')).toBe(false);
    const start = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Start');
    if (!start) throw new Error('Missing English Start button');
    start.click();
    await tick();
    expect(messages.find((message) => message.type === 'start-session')).toMatchObject({ payload: { id: 'Task', title: 'Keep my prompt', text: 'Keep my prompt' } });
    ready('zh-CN');
    expect(document.body.textContent).toContain('任务详情');
    expect(document.querySelector('.soup-quote')?.textContent).toBe(quote);
    expect(document.querySelector<HTMLInputElement>('.editor input')?.value).toBe('Unsaved task title');
    const catalogReads = messages.filter((message) => message.type === 'workspace-read' && message.payload.kind === 'projects').length;
    directory = '/new-customer-project';
    projects = [{ id: 'new-project', name: 'New customer', directory }];
    ready('en');
    for (let index = 0; index < 5; index++) await tick();
    expect(messages.filter((message) => message.type === 'workspace-read' && message.payload.kind === 'projects')).toHaveLength(catalogReads + 1);
    expect(messages.find((message) => message.type === 'workspace-subscribe')).toMatchObject({ payload: { query: { kind: 'sessions', projectId: 'new-project' } } });
    const nextComposer = document.querySelector<HTMLInputElement>('#wb-composer');
    if (!nextComposer) throw new Error('Missing composer after directory change');
    nextComposer.value = 'Work in the new project';
    [...document.querySelectorAll('button')].find((button) => button.textContent === 'Start')?.click();
    await tick();
    expect(messages.filter((message) => message.type === 'start-session').at(-1)).toMatchObject({ payload: { id: 'Task', projectId: 'new-project', title: 'Work in the new project' } });
    projectContent = '- [ ] Previous project task <!-- sw {"id":"previous_task"} -->\n';
    holdNextProjectRead = true;
    send({ channel: 'openchamber.sdk', v: 1, type: 'session', payload: { session: { id: 'old-session', title: 'Previous project', busy: true } } });
    for (let index = 0; index < 3; index++) await tick();
    if (!delayedProjectRead) throw new Error('Missing delayed project refresh');
    directory = '/second-customer-project';
    projects = [{ id: 'second-project', name: 'Second customer', directory }];
    projectContent = '- [ ] Current project task <!-- sw {"id":"current_task"} -->\n';
    ready('en');
    for (let index = 0; index < 5; index++) await tick();
    expect(document.body.textContent).toContain('Current project task');
    reply(delayedProjectRead, { content: '- [ ] Previous project task <!-- sw {"id":"previous_task"} -->\n' });
    for (let index = 0; index < 3; index++) await tick();
    expect(document.body.textContent).toContain('Current project task');
    expect(document.body.textContent).not.toContain('Previous project task');
    window.dispatchEvent(new window.Event('pagehide'));
  });
});
