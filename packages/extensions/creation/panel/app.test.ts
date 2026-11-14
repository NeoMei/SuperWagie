import { expect, test } from 'bun:test';
import path from 'node:path';
import { Window } from '../../../ui/node_modules/happy-dom/lib/index.js';
import writer from './fixtures/superwriter.json';
import type { GuestMessage, HostReadyContext } from '../../../sdk/src/index.ts';

const ready = (locale: string): HostReadyContext => ({
  theme: {
    mode: 'light',
    tokens: {
      background: '#fff', elevated: '#fafafa', foreground: '#111', muted: '#666',
      subtle: '#eee', border: '#ddd', hover: '#eee', selection: '#ddf', focus: '#4af',
      primary: '#4af', primaryForeground: '#fff', mutedSurface: '#f4f4f5',
      elevatedForeground: '#111', active: '#e5e5e5', selectionForeground: '#111',
      success: '#16a34a', warning: '#d97706', error: '#dc2626', info: '#2563eb',
      primaryText: '#123456', errorText: '#654321', warningText: '#112233', successText: '#445566', infoText: '#778899',
      font: 'sans-serif', mono: 'monospace', radius: '9px',
    },
  },
  locale, directory: '/repo', session: { id: 'session-1', title: 'Existing work', busy: false }, surface: 'page',
  connection: { connected: false, account: '' }, settings: {}, item: null, features: { resultCards: true },
});

test('mounted approval uses coordinated submit once and displays the retained admission receipt', async () => {
  const panel = new Window({ url: 'http://localhost/', settings: { enableJavaScriptEvaluation: true } });
  const parent = new Window({ url: 'http://localhost' });
  Object.defineProperty(panel, 'parent', { value: parent });
  panel.document.body.innerHTML = '<div id="root"></div>';
  const files = new Map([['需求.md', '# Work\n- Type: doc\n'], ['协作状态.json', JSON.stringify(writer)], ['章节/第三章.md', '# Current chapter']]);
  const inspection = { kind: 'doc', stage: 'doc-review', decisionId: '12', artifactVersion: 'a'.repeat(64) };
  let submissions = 0; let ordinaryPrompts = 0;
  let retained: null | { id: string; status: string; acceptedAt: number } = null;
  const reply = (id: string, payload?: { content: string } | { sent: 'sent' } | { status: number; body: string }) => panel.dispatchEvent(new panel.MessageEvent('message', { source: parent, data: { channel: 'openchamber.sdk', v: 1, type: 'result', id, ok: true, payload } }));
  Object.defineProperty(parent, 'postMessage', { value: (message: GuestMessage) => {
    if (message.type === 'file-read') { reply(message.id, { content: files.get(message.payload.path) ?? '' }); return; }
    if (message.type === 'result-cards') { reply(message.id); return; }
    if (message.type === 'prompt') { ordinaryPrompts++; reply(message.id, { sent: 'sent' }); return; }
    if (message.type === 'request' && message.payload.path === '/api/creation/decision') {
      const input: { action: string } = JSON.parse(message.payload.body ?? '{}');
      if (input.action === 'inspect') reply(message.id, { status: 200, body: JSON.stringify({ type: 'inspection', inspection, receipt: retained }) });
      else { submissions++; retained = { id: 'b'.repeat(64), status: 'accepted', acceptedAt: 1 }; reply(message.id, { status: 200, body: JSON.stringify({ type: 'receipt', receipt: retained }) }); }
    }
  } });
  const build = await Bun.build({ entrypoints: [import.meta.dir + '/app.ts'], target: 'browser', format: 'iife', plugins: [{ name: 'public-sdk-entrypoints', setup(builder) {
    builder.onResolve({ filter: /^@openchamber\/sdk(?:\/ui)?$/ }, ({ path: specifier }) => ({ path: path.resolve(import.meta.dir, '../../../sdk/src', specifier.endsWith('/ui') ? 'ui/index.ts' : 'index.ts') }));
  } }] });
  expect(build.success).toBe(true);
  panel.eval(await build.outputs[0].text());
  try {
    panel.dispatchEvent(new panel.MessageEvent('message', { source: parent, data: { channel: 'openchamber.sdk', v: 1, type: 'ready', payload: ready('en') } }));
    for (let index = 0; index < 20 && !panel.document.body.textContent.includes('This host coordinates'); index++) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(panel.document.body.textContent).toContain('This host coordinates');
    const confirm = panel.document.querySelector<HTMLButtonElement>('button.cr-primary');
    if (!confirm) throw new Error('approval button missing');
    confirm.click(); confirm.click();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(submissions).toBe(1);
    expect(ordinaryPrompts).toBe(0);
    expect(panel.document.body.textContent).toContain('Decision accepted. Generation completion is unverified.');
    expect(panel.document.querySelector<HTMLButtonElement>('button.cr-primary')?.disabled).toBe(true);
  } finally { await panel.happyDOM.abort(); await parent.happyDOM.abort(); }
});

test('host language updates translate the mounted wizard and preserve input, selection and choices', async () => {
  const panel = new Window({ url: 'http://localhost/#intent=doc', settings: { enableJavaScriptEvaluation: true } });
  const parent = new Window({ url: 'http://localhost' });
  Object.defineProperty(panel, 'parent', { value: parent });
  panel.document.body.innerHTML = '<div id="root"></div>';
  const files = new Map([
    ['需求.md', '# Existing work\n- Type: doc\n'],
    ['协作状态.json', JSON.stringify(writer)],
    ['章节/第三章.md', '# User chapter\nUser-authored content remains unchanged.'],
  ]);
  let fileReads = 0;
  const cards: Array<Extract<GuestMessage, { type: 'result-cards' }>> = [];
  Object.defineProperty(parent, 'postMessage', { value: (message: GuestMessage) => {
    if (message.type === 'result-cards') {
      cards.push(message);
      panel.dispatchEvent(new panel.MessageEvent('message', { source: parent, data: { channel: 'openchamber.sdk', v: 1, type: 'result', id: message.id, ok: true } }));
      return;
    }
    if (message.type === 'close') {
      panel.dispatchEvent(new panel.MessageEvent('message', { source: parent, data: {
        channel: 'openchamber.sdk', v: 1, type: 'result', id: message.id, ok: false, code: 'HOST_REJECTED', error: 'Fixture keeps the panel open',
      } }));
      return;
    }
    if (message.type !== 'file-read') return;
    fileReads++;
    const content = files.get(message.payload.path) ?? '';
    panel.dispatchEvent(new panel.MessageEvent('message', { source: parent, data: {
      channel: 'openchamber.sdk', v: 1, type: 'result', id: message.id, ok: true, payload: { content },
    } }));
  } });
  const build = await Bun.build({
    entrypoints: [process.env.OC_CREATION_APP_MODULE || import.meta.dir + '/app.ts'], target: 'browser', format: 'iife',
    plugins: [{ name: 'public-sdk-entrypoints', setup(builder) {
      builder.onResolve({ filter: /^@openchamber\/sdk(?:\/ui)?$/ }, ({ path: specifier }) => ({
        path: path.resolve(import.meta.dir, '../../../sdk/src', specifier.endsWith('/ui') ? 'ui/index.ts' : 'index.ts'),
      }));
    } }],
  });
  expect(build.success).toBe(true);
  panel.eval(await build.outputs[0].text());
  let currentDirectory = '/repo';
  const push = (locale: string, directory = currentDirectory, busy = false) => {
    currentDirectory = directory;
    const context = ready(locale);
    panel.dispatchEvent(new panel.MessageEvent('message', {
      source: parent, data: { channel: 'openchamber.sdk', v: 1, type: 'ready', payload: {
        ...context, directory, session: { ...context.session, id: 'session-1', title: 'Existing work', busy },
      } },
    }));
  };
  try {
    push('zh-CN');
    expect(panel.document.body.textContent).toContain('写文档');
    const content = panel.document.querySelector<HTMLTextAreaElement>('[data-control="content"]');
    if (!content) throw new Error('Content field missing');
    content.value = '用户资料不应翻译';
    content.dispatchEvent(new panel.Event('input', { bubbles: true }));
    content.focus();
    content.setSelectionRange(2, 5);
    push('en');
    expect(panel.document.documentElement.lang).toBe('en');
    expect(panel.document.title).toBe('Create');
    expect(panel.document.body.textContent).toContain('Write a document');
    expect(panel.document.body.textContent).toContain('Document type');
    expect(panel.document.body.textContent).toContain('Clients');
    expect(panel.document.body.textContent).not.toContain('写文档');
    const translated = panel.document.querySelector<HTMLTextAreaElement>('[data-control="content"]');
    expect(translated?.value).toBe('用户资料不应翻译');
    expect(panel.document.activeElement).toBe(translated);
    expect(translated?.selectionStart).toBe(2);
    expect(translated?.selectionEnd).toBe(5);
    expect(panel.document.querySelector<HTMLInputElement>('[data-control="length"]')?.value).toBe('Medium length, 6–10 pages');
    const clients = [...panel.document.querySelectorAll('button')].find((button) => button.textContent === 'Clients');
    clients?.click();
    push('zh-CN');
    expect(panel.document.body.textContent).toContain('写文档');
    const selected = [...panel.document.querySelectorAll('button')].find((button) => button.textContent === '客户');
    expect(selected?.getAttribute('aria-pressed')).toBe('true');
    expect(panel.document.querySelector<HTMLTextAreaElement>('[data-control="content"]')?.value).toBe('用户资料不应翻译');
    // Reopen a work whose brief was created by the English sidebar path.
    [...panel.document.querySelectorAll('button')].find((button) => button.textContent === '重来')?.click();
    push('en', '/existing-work');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(panel.document.body.textContent).toContain('Chapter 3 of 3');
    expect(cards.at(-1)?.payload).toMatchObject({ directory: '/existing-work', cards: [{ path: '章节/第三章.md' }] });
    expect(panel.document.body.textContent).toContain('Approve Chapter 3 of 3');
    const revision = panel.document.querySelector<HTMLTextAreaElement>('[data-control="revision"]');
    if (!revision) throw new Error('Revision field missing');
    revision.value = 'Keep my revision draft';
    revision.dispatchEvent(new panel.Event('input'));
    const readsBeforeLanguageSwitch = fileReads;
    push('zh-CN');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fileReads).toBe(readsBeforeLanguageSwitch);
    expect(panel.document.querySelector<HTMLTextAreaElement>('[data-control="revision"]')?.value).toBe('Keep my revision draft');
    // Real busy/completed transitions still refresh persisted progress.
    push('zh-CN', currentDirectory, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fileReads).toBeGreaterThan(readsBeforeLanguageSwitch);
    const readsWhileBusy = fileReads;
    push('zh-CN', currentDirectory, false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fileReads).toBeGreaterThan(readsWhileBusy);
    const readsAfterCompletion = fileReads;
    push('en');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fileReads).toBe(readsAfterCompletion);
    push('zh-CN');
    // Repeated ready includes a directory event. It must not abandon a fresh wizard.
    [...panel.document.querySelectorAll('button')].find((button) => button.textContent === '新作品')?.click();
    [...panel.document.querySelectorAll('button')].find((button) => button.textContent?.startsWith('做 PPT'))?.click();
    const next = panel.document.querySelector<HTMLTextAreaElement>('[data-control="content"]');
    if (!next) throw new Error('New work field missing');
    next.value = 'A fresh draft'; next.dispatchEvent(new panel.Event('input', { bubbles: true }));
    push('en');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(panel.document.body.textContent).toContain('Make a presentation');
    expect(cards.at(-1)?.payload.cards).toEqual([]);
    expect(panel.document.body.textContent).toContain('What will the presentation cover?');
    expect(panel.document.querySelector<HTMLTextAreaElement>('[data-control="content"]')?.value).toBe('A fresh draft');
    [...panel.document.querySelectorAll('button')].find((button) => button.textContent === 'Exit')?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(panel.document.querySelector('.cr-note')?.textContent).toContain('Could not exit.');
    push('zh-CN');
    expect(panel.document.querySelector('.cr-note')?.getAttribute('data-tone')).toBe('error');
    expect(panel.document.querySelector('.cr-note')?.textContent).toContain('退出失败');
  } finally {
    await panel.happyDOM.abort();
    await parent.happyDOM.abort();
    panel.close(); parent.close();
  }
});

test('result cards retire the previous directory and session before delayed or failed reads', async () => {
  const panel = new Window({ url: 'http://localhost', settings: { enableJavaScriptEvaluation: true } });
  const parent = new Window({ url: 'http://localhost' });
  Object.defineProperty(panel, 'parent', { value: parent });
  panel.document.body.innerHTML = '<div id="root"></div>';
  const cards: Array<Extract<GuestMessage, { type: 'result-cards' }>> = [];
  let hold = false;
  const delayed: GuestMessage[] = [];
  const files = new Map([
    ['需求.md', '# Existing work\n- Type: doc\n'],
    ['协作状态.json', JSON.stringify(writer)],
    ['章节/第三章.md', '# A confidential chapter\nOnly A text.'],
  ]);
  const reply = (message: GuestMessage, ok = true) => {
    if (message.type !== 'file-read') return;
    panel.dispatchEvent(new panel.MessageEvent('message', { source: parent, data: {
      channel: 'openchamber.sdk', v: 1, type: 'result', id: message.id, ok,
      ...(ok ? { payload: { content: files.get(message.payload.path) ?? '' } } : { code: 'HOST_REJECTED', error: 'Read failed' }),
    } }));
  };
  Object.defineProperty(parent, 'postMessage', { value: (message: GuestMessage) => {
    if (message.type === 'result-cards') {
      cards.push(message);
      panel.dispatchEvent(new panel.MessageEvent('message', { source: parent, data: { channel: 'openchamber.sdk', v: 1, type: 'result', id: message.id, ok: true } }));
    } else if (message.type === 'file-read') {
      if (hold) delayed.push(message); else reply(message);
    }
  } });
  const build = await Bun.build({
    entrypoints: [process.env.OC_CREATION_APP_MODULE || import.meta.dir + '/app.ts'], target: 'browser', format: 'iife',
    plugins: [{ name: 'public-sdk-entrypoints', setup(builder) {
      builder.onResolve({ filter: /^@openchamber\/sdk(?:\/ui)?$/ }, ({ path: specifier }) => ({
        path: path.resolve(import.meta.dir, '../../../sdk/src', specifier.endsWith('/ui') ? 'ui/index.ts' : 'index.ts'),
      }));
    } }],
  });
  expect(build.success).toBe(true);
  panel.eval(await build.outputs[0].text());
  const push = (directory: string, sessionId: string) => {
    const context = ready('en');
    panel.dispatchEvent(new panel.MessageEvent('message', { source: parent, data: { channel: 'openchamber.sdk', v: 1, type: 'ready', payload: {
      ...context, directory, session: { ...context.session, id: sessionId },
    } } }));
  };
  try {
    push('/project-a', 'session-a');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cards.at(-1)?.payload.cards[0]?.text).toContain('Only A text.');
    hold = true;
    let start = cards.length;
    push('/project-b', 'session-b');
    expect(cards.slice(start)[0]?.payload).toEqual({ directory: '/project-b', cards: [] });
    expect(cards.slice(start).every((entry) => entry.payload.cards.length === 0)).toBe(true);
    for (const read of delayed.splice(0)) reply(read, false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cards.slice(start).every((entry) => entry.payload.cards.length === 0)).toBe(true);
    hold = false;
    push('/project-a', 'session-a');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cards.at(-1)?.payload.cards[0]?.text).toContain('Only A text.');
    hold = true;
    start = cards.length;
    push('/project-a', 'session-other');
    expect(cards.slice(start)[0]?.payload.cards).toEqual([]);
    expect(cards.slice(start).every((entry) => entry.payload.cards.length === 0)).toBe(true);
  } finally { panel.happyDOM.abort(); parent.happyDOM.abort(); panel.close(); parent.close(); }
});
