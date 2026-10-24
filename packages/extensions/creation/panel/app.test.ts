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
  connection: { connected: false, account: '' }, settings: {}, item: null,
});

test('host language updates translate the mounted wizard and preserve input, selection and choices', async () => {
  const panel = new Window({ url: 'http://localhost/#intent=doc', settings: { enableJavaScriptEvaluation: true } });
  const parent = new Window({ url: 'http://localhost' });
  Object.defineProperty(panel, 'parent', { value: parent });
  panel.document.body.innerHTML = '<div id="root"></div>';
  const files = new Map([
    ['需求.md', '# Existing work\n- Type: doc\n'],
    ['协作状态.json', JSON.stringify(writer)],
    ['chapters/03.md', '# User chapter\nUser-authored content remains unchanged.'],
  ]);
  let fileReads = 0;
  Object.defineProperty(parent, 'postMessage', { value: (message: GuestMessage) => {
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
    entrypoints: [import.meta.dir + '/app.ts'], target: 'browser', format: 'iife',
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
