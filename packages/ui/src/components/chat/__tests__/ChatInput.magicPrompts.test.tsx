import { afterAll, beforeEach, expect, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import { z } from 'zod';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import type { RuntimeAPIs } from '@/lib/api/types';

/**
 * A magic prompt command typed in the composer reads the prompts that apply
 * in the directory the send lands in: the session's worktree here. The
 * server decides which project owns it.
 */

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  sessionStorage: browser.sessionStorage,
  Node: browser.Node,
  Text: browser.Text,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement,
  HTMLTextAreaElement: browser.HTMLTextAreaElement,
  HTMLFormElement: browser.HTMLFormElement,
  Range: browser.Range,
  Selection: browser.Selection,
  DocumentFragment: browser.DocumentFragment,
  Event: browser.Event,
  KeyboardEvent: browser.KeyboardEvent,
  MouseEvent: browser.MouseEvent,
  FocusEvent: browser.FocusEvent,
  InputEvent: browser.InputEvent,
  CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver,
  IntersectionObserver: browser.IntersectionObserver,
  matchMedia: browser.matchMedia.bind(browser),
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  customElements: browser.customElements,
  HTMLDivElement: browser.HTMLDivElement,
  HTMLSpanElement: browser.HTMLSpanElement,
  SVGElement: browser.SVGElement,
  ShadowRoot: browser.ShadowRoot,
  CSSStyleSheet: browser.CSSStyleSheet,
  DOMParser: browser.DOMParser,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const WORKTREE = '/elsewhere/feature';

let promptReads: URL[] = [];
let fileReads: URL[] = [];
let rawFileContents = new Map<string, string>();
let promptBodies: string[] = [];
let promptsStatus = 200;

spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost/');
  if (url.pathname === '/api/session-warming') return Response.json({ revision: 0, enabled: false, minutes: 60, sessions: [] });
  if (url.pathname === '/api/config' || url.pathname === '/api/project') return Response.json([]);
  if (url.pathname === '/api/fs/raw') {
    fileReads.push(url);
    const content = rawFileContents.get(url.searchParams.get('path') ?? '');
    if (content !== undefined) return new Response(content);
  }
  if (url.pathname.endsWith('/sensitive/prompt')) {
    promptBodies.push(await new Request(input, init).text());
    return Response.json({ data: { id: 'sent' } });
  }
  if (url.pathname === '/api/magic-prompts') {
    promptReads.push(url);
    return Response.json(promptsStatus === 200
      ? { version: 1, overrides: { 'session.review.visible': 'Project review', 'session.review.instructions': 'Project review rules' } }
      : { error: 'Project prompts are invalid', code: 'project_prompts_invalid' }, { status: promptsStatus });
  }
  if (url.pathname.endsWith('/location')) {
    return Response.json({ directory: WORKTREE, project: { id: 'project', directory: WORKTREE, canonical: WORKTREE } });
  }
  if (url.pathname.endsWith('/session')) return Response.json({ data: [] });
  return Response.json({});
});

// Vite-only module forms the composer's import graph reaches, loaded as the keystroke test does.
plugin({
  name: 'composer-magic-prompts-vite-modules',
  setup(build) {
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, () => ({ contents: 'export default "";', loader: 'js' }));
    build.onLoad({ filter: /useProviderLogo\.ts$/ }, ({ path }) => {
      const directory = resolve(dirname(path), '../assets/provider-logos');
      const logos = Object.fromEntries(readdirSync(directory).filter((name) => name.endsWith('.svg')).map((name) => [
        `../assets/provider-logos/${name}`, pathToFileURL(resolve(directory, name)).href,
      ]));
      return { contents: readFileSync(path, 'utf8').replace(/import\.meta\.glob<string>\([\s\S]*?\);/, `${JSON.stringify(logos)};`), loader: 'ts' };
    });
  },
});

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { EditorView } = await import('@codemirror/view');
const { isolateHistory, undo } = await import('@codemirror/commands');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { ChatInput } = await import('../ChatInput');
const { SyncProvider } = await import('@/sync/sync-context');
const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
const { useConfigStore } = await import('@/stores/useConfigStore');
const { useSkillsStore } = await import('@/stores/useSkillsStore');
const { useSessionUIStore, DraftSendError } = await import('@/sync/session-ui-store');
const { useInputStore } = await import('@/sync/input-store');
const { getSyncChildStores } = await import('@/sync/sync-refs');
const { useMessageQueueStore } = await import('@/stores/messageQueueStore');
const { toast } = await import('@/components/ui');
const { OpenCode } = await import('@opencode/client');

const sdk = OpenCode.make({
  baseUrl: 'https://sync.test',
  fetch: async (request) => {
    const path = new URL(request instanceof Request ? request.url : request.toString()).pathname;
    if (path.endsWith('/event')) {
      return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    }
    const body = path.endsWith('/config') ? []
      : path.endsWith('/location')
      ? { directory: WORKTREE, project: { id: 'project', directory: WORKTREE, canonical: WORKTREE } }
      : path.endsWith('/session/active') ? {}
      : { data: [] };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  },
});

// SAFETY: The composer reads only the runtime descriptor and the source-control
// object's identity here; no runtime API method is invoked.
const runtimeAPIs = { runtime: { platform: 'web', isDesktop: false, isVSCode: false }, sourceControl: {} } as RuntimeAPIs;

type SentMessage = { content: string; synthetic: string[] };
let sent: SentMessage[] = [];

beforeEach(() => {
  promptReads = [];
  fileReads = [];
  rawFileContents = new Map();
  promptBodies = [];
  promptsStatus = 200;
  sent = [];
  useDirectoryStore.setState({ currentDirectory: WORKTREE });
  useSessionUIStore.setState({
    newSessionDraft: { ...useSessionUIStore.getState().newSessionDraft, open: false },
    pendingDraftSends: new Map(),
    currentSessionId: 'ses_feature',
    currentSessionDirectory: WORKTREE,
    sendMessage: async (content, _providerID, _modelID, _agent, _attachments, _agentMention, additionalParts) => {
      sent.push({ content, synthetic: (additionalParts ?? []).filter((part) => part.synthetic).map((part) => part.text) });
    },
  });
  useConfigStore.setState({
    currentProviderId: 'provider',
    currentModelId: 'model',
    isConnected: true,
    hasEverConnected: true,
  });
});

afterAll(() => {
  browser.close();
});

/** Mounts the composer, types `text`, submits it and returns the editor text afterwards. */
const submitInComposer = async (text: string, beforeSubmit?: (view: InstanceType<typeof EditorView>, form: HTMLFormElement) => Promise<void>): Promise<string> => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <RuntimeAPIContext.Provider value={runtimeAPIs}>
          <ThemeSystemProvider>
            <I18nProvider>
              <SyncProvider sdk={sdk} directory={WORKTREE}>
                <ChatInput />
              </SyncProvider>
            </I18nProvider>
          </ThemeSystemProvider>
        </RuntimeAPIContext.Provider>,
      );
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

    const content = container.querySelector<HTMLElement>('.cm-content');
    const view = content ? EditorView.findFromDOM(content) : null;
    const form = container.querySelector('form');
    if (!view || !form) throw new Error('The composer did not mount');
    await act(async () => {
      // Replaces the whole draft: a draft an earlier send gave back is restored on mount.
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: 'input.type' });
    });
    if (beforeSubmit) await beforeSubmit(view, form);
    await act(async () => {
      useConfigStore.setState({ isConnected: true, hasEverConnected: true });
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    return view.state.doc.toString();
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
};

test("sends the command with the prompts that apply in the session's directory", async () => {
  await submitInComposer('/workspace-review');

  expect(promptReads.map((url) => url.searchParams.get('sessionDirectory'))).toEqual([WORKTREE]);
  expect(sent).toHaveLength(1);
  expect(sent[0].content).toBe('Project review');
  expect(sent[0].synthetic).toContain('Project review rules');
});

test('loads a cold Skill catalog for a pasted mention before submitting', async () => {
  const previous = useSkillsStore.getState();
  const loadDirectories: Array<string | null | undefined> = [];
  const submittedSkills: string[][] = [];
  useSessionUIStore.setState({ sendMessage: async (...args) => {
    submittedSkills.push([...(args[9]?.skills?.names ?? [])]);
  } });
  try {
    await submitInComposer('Run $fixture-review on this change.', async () => {
      await act(async () => {
        useSkillsStore.setState({
          skillsByDirectory: {},
          policiesByDirectory: {},
          loadSkills: async (directory) => {
            loadDirectories.push(directory);
            useSkillsStore.setState({ skillsByDirectory: { [WORKTREE]: [{
              id: 'fixture-review', name: 'fixture-review', description: 'Fixture review',
              scope: 'project', source: 'opencode', path: `${WORKTREE}/.opencode/skills/fixture-review/SKILL.md`,
            }] } });
            return true;
          },
        });
      });
    });
    expect(loadDirectories).toEqual([WORKTREE]);
    expect(submittedSkills).toEqual([['fixture-review']]);
  } finally {
    useSkillsStore.setState(previous);
  }
});

for (const readOutcome of ['loaded', 'failed', 'queued'] as const) {
  test(`submit during attachment intake handles a ${readOutcome} image`, async () => {
    const submissions: { via: 'send' | 'queue'; text: string; files: string[] }[] = [];
    const withImage = { via: readOutcome === 'queued' ? 'queue' : 'send', text: '[review.png] Review this image.', files: ['review.png'] };
    useSessionUIStore.setState({ sendMessage: async (text, _provider, _model, _agent, attachments) => {
      submissions.push({ via: 'send', text, files: (attachments ?? []).map((file) => file.filename) });
    } });
    const previousQueue = useMessageQueueStore.getState();
    useMessageQueueStore.setState({
      followUpBehavior: 'queue',
      addToQueue: async (_target, { content, text, attachments }) => {
        submissions.push({ via: 'queue', text: text ?? content, files: (attachments ?? []).map((file) => file.filename) });
      },
    });
    const previousReader = Object.getOwnPropertyDescriptor(globalThis, 'FileReader');
    let finishRead: (() => void) | undefined;
    class DeferredImageReader {
      result = 'data:image/png;base64,AQID';
      error = new Error('Image could not be read');
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL() {
        finishRead = () => readOutcome === 'failed' ? this.onerror?.() : this.onload?.();
      }
    }
    Object.defineProperty(globalThis, 'FileReader', { configurable: true, value: DeferredImageReader });
    try {
      await submitInComposer('Review this image.', async (view, form) => {
        const image = new File([new Uint8Array([1, 2, 3])], 'review.png', { type: 'image/png' });
        if (readOutcome === 'queued') {
          await act(async () => {
            getSyncChildStores().update(WORKTREE, () => ({ session_status: { ses_feature: { type: 'busy' } } }));
          });
        }
        await act(async () => {
          useConfigStore.setState({ isConnected: true, hasEverConnected: true });
          const drop = new Event('drop', { bubbles: true, cancelable: true });
          Object.defineProperty(drop, 'dataTransfer', { value: { types: ['Files'], files: [image], items: [], getData: () => '' } });
          view.contentDOM.dispatchEvent(drop);
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          await new Promise((resolve) => setTimeout(resolve, 30));
        });
        if (!finishRead) throw new Error('The image did not start reading');
        expect(submissions).toEqual([]);
        await act(async () => {
          finishRead?.();
          await new Promise((resolve) => setTimeout(resolve, 50));
        });
        expect(submissions).toEqual(readOutcome === 'failed' ? [] : [withImage]);
        if (readOutcome === 'failed') expect(view.state.doc.toString()).toBe('Review this image.');
      });
      expect(submissions).toEqual(readOutcome === 'failed'
        ? [{ via: 'send', text: 'Review this image.', files: [] }]
        : [withImage]);
    } finally {
      useMessageQueueStore.setState({ addToQueue: previousQueue.addToQueue, followUpBehavior: previousQueue.followUpBehavior });
      if (previousReader) Object.defineProperty(globalThis, 'FileReader', previousReader);
      else Reflect.deleteProperty(globalThis, 'FileReader');
      useInputStore.setState({ attachmentDraftKey: null, attachedFiles: [], attachmentDrafts: new Map() });
    }
  });
}

for (const entry of ['picker', 'drop', 'paste'] as const) {
  test(`${entry} adds an inline file whose editor deletion and undo control delivery`, async () => {
    const sentFiles: string[][] = [];
    useSessionUIStore.setState({ sendMessage: async (_text, _provider, _model, _agent, attachments) => {
      sentFiles.push((attachments ?? []).map((file) => file.filename));
    } });
    const previousReader = Object.getOwnPropertyDescriptor(globalThis, 'FileReader');
    class AttachmentFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      readAsDataURL(file: File) {
        void file.arrayBuffer().then((bytes) => {
          this.result = `data:text/plain;base64,${Buffer.from(bytes).toString('base64')}`;
          this.onload?.();
        });
      }
    }
    Object.defineProperty(globalThis, 'FileReader', { configurable: true, value: AttachmentFileReader });
    try {
      await submitInComposer('Review this file.', async (view, form) => {
        const file = new File(['fixture'], 'review.txt', { type: 'text/plain' });
        await act(async () => {
          if (entry === 'picker') {
            const input = form.parentElement?.parentElement?.querySelector('input[type="file"]') ?? document.querySelector('input[type="file"]');
            if (!input) throw new Error('Missing attachment picker');
            Object.defineProperty(input, 'files', { configurable: true, value: [file] });
            input.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            const transfer = {
              types: ['Files'], files: [file], items: [{ kind: 'file', type: file.type, getAsFile: () => file }],
              getData: () => '',
            };
            const event = new Event(entry, { bubbles: true, cancelable: true });
            Object.defineProperty(event, entry === 'paste' ? 'clipboardData' : 'dataTransfer', { value: transfer });
            view.contentDOM.dispatchEvent(event);
          }
          await new Promise((resolve) => setTimeout(resolve, 30));
        });
        const citation = '[review.txt]';
        const from = view.state.doc.toString().indexOf(citation);
        expect(from >= 0).toBe(true);
        expect(view.contentDOM.querySelector('[title="review.txt"]')).not.toBeNull();
        await act(async () => {
          view.dispatch({ changes: { from, to: from + citation.length, insert: '' }, userEvent: 'delete.backward', annotations: isolateHistory.of('full') });
          expect(view.state.doc.toString()).not.toContain(citation);
          if (entry !== 'drop') expect(undo(view)).toBe(true);
        });
      });
      expect(sentFiles).toEqual([entry === 'drop' ? [] : ['review.txt']]);
    } finally {
      if (previousReader) Object.defineProperty(globalThis, 'FileReader', previousReader);
      else Reflect.deleteProperty(globalThis, 'FileReader');
      useInputStore.setState({ attachmentDraftKey: null, attachedFiles: [], attachmentDrafts: new Map() });
    }
  });
}

test('the Office original picker keeps the bytes and citation after a send failure', async () => {
  const filesAtSend: AttachedFile[][] = [];
  useSessionUIStore.setState({ sendMessage: async (_text, _provider, _model, _agent, attachments) => {
    filesAtSend.push(attachments ?? []);
    throw new Error('Could not prepare attachment paths.');
  } });
  const previousReader = Object.getOwnPropertyDescriptor(globalThis, 'FileReader');
  class OfficeReader {
    result = 'data:application/octet-stream;base64,AAEC';
    onload: (() => void) | null = null;
    readAsDataURL() { queueMicrotask(() => this.onload?.()); }
  }
  Object.defineProperty(globalThis, 'FileReader', { configurable: true, value: OfficeReader });
  try {
    const remaining = await submitInComposer('Review this file.', async (_view, form) => {
      const trigger = form.querySelector<HTMLElement>('[aria-label="Add attachment"]');
      if (!trigger) throw new Error('Missing attachment menu');
      await act(async () => { trigger.click(); });
      const originals = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
        .find((entry) => entry.textContent?.includes('Attach Office originals'));
      if (!originals) throw new Error('Missing Office original picker action');
      await act(async () => {
        originals.click();
        await new Promise((resolve) => setTimeout(resolve, 40));
      });
      const picker = document.querySelector<HTMLInputElement>('input[type="file"]');
      expect(picker?.accept).toContain('.docx');
      if (!picker) throw new Error('Missing attachment picker');
      await act(async () => {
        const source = new File([new Uint8Array([0, 1, 2])], 'report.docx');
        Object.defineProperty(picker, 'files', { configurable: true, value: [source] });
        picker.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
    });
    expect(remaining).toContain('[report.docx]');
    expect(filesAtSend).toMatchObject([[{
      filename: 'report.docx',
      dataUrl: 'data:application/vnd.openxmlformats-officedocument.wordprocessingml.document;base64,AAEC',
    }]]);
    expect(useInputStore.getState().attachedFiles[0]?.dataUrl).toBe(filesAtSend[0][0].dataUrl);
  } finally {
    if (previousReader) Object.defineProperty(globalThis, 'FileReader', previousReader);
    else Reflect.deleteProperty(globalThis, 'FileReader');
    useInputStore.setState({ attachmentDraftKey: null, attachedFiles: [], attachmentDrafts: new Map() });
  }
});

test('failed Auto attachment preflight keeps pending composer context for one retry', async () => {
  const { OpencodeApiError } = await import('@/lib/opencode/client');
  const attachment: AttachedFile = {
    id: 'preflight-scan', file: new File(['fixture'], 'scan.pdf', { type: 'application/pdf' }),
    dataUrl: 'data:application/pdf;base64,Zml4dHVyZQ==', mimeType: 'application/pdf',
    filename: 'scan.pdf', composerAnchor: 'scan.pdf', size: 7, source: 'local',
  };
  const submissions: Array<{ context: string[]; attachments: string[] }> = [];
  useInputStore.setState({ attachmentDraftKey: null, attachedFiles: [attachment], attachmentDrafts: new Map() });
  useInputStore.getState().setPendingSyntheticParts([{ text: 'recovered context' }]);
  useSessionUIStore.setState({ sendMessage: async (_text, _provider, _model, _agent, files, _mention, context) => {
    submissions.push({ context: (context ?? []).map(({ text }) => text), attachments: (files ?? []).map(({ id }) => id) });
    if (submissions.length === 1) {
      throw new OpencodeApiError('routing.prepareSend', 'Could not prepare attachment paths.', { status: 400 });
    }
  } });
  try {
    const remaining = await submitInComposer('Read [scan.pdf].');
    expect(remaining).toBe('Read [scan.pdf].');
    await submitInComposer(remaining);
    const sentWithContext = { context: ['recovered context'], attachments: [attachment.id] };
    expect(submissions).toEqual([sentWithContext, sentWithContext]);
    await submitInComposer('next prompt');
    expect(submissions[2]).toEqual({ context: [], attachments: [] });
  } finally {
    useInputStore.setState({ attachmentDraftKey: null, attachedFiles: [], attachmentDrafts: new Map(), pendingSyntheticParts: null, pinnedSyntheticParts: new Map() });
  }
});

test('an action command keeps inline attachments and previously saved image links in the draft', async () => {
  const attachment = { id: 'action-image', file: new File(['fixture'], 'review.png', { type: 'image/png' }), dataUrl: 'data:image/png;base64,Zml4dHVyZQ==', mimeType: 'image/png', filename: 'review.png', composerAnchor: 'review.png', size: 7, source: 'local' as const };
  useInputStore.setState({ attachmentDraftKey: null, attachedFiles: [attachment], attachmentDrafts: new Map() });
  try {
    const context = '[review.png] [saved.png](/tmp/saved.png)';
    expect(await submitInComposer(`/timeline ${context}`)).toBe(context);
    expect(sent).toEqual([]);
    expect(useInputStore.getState().attachedFiles.map((file) => file.id)).toEqual([attachment.id]);
  } finally {
    useInputStore.setState({ attachmentDraftKey: null, attachedFiles: [], attachmentDrafts: new Map() });
  }
});

test('a large generic image keeps its desktop path when its inline name changes', async () => {
  const original = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'image.png', { type: 'image/png' });
  const originalPath = `${WORKTREE}/image.png`;
  const submissions: Array<{ text: string; paths: Array<string | undefined> }> = [];
  useSessionUIStore.setState({ sendMessage: async (text, _provider, _model, _agent, attachments) => {
    submissions.push({ text, paths: (attachments ?? []).map(({ agentPath }) => agentPath) });
  } });
  const previousReader = Object.getOwnPropertyDescriptor(globalThis, 'FileReader');
  class ReferenceFileReader {
    result = 'data:text/plain;base64,AQID';
    onload: (() => void) | null = null;
    readAsDataURL() { queueMicrotask(() => this.onload?.()); }
  }
  Object.defineProperty(globalThis, 'FileReader', { configurable: true, value: ReferenceFileReader });
  Object.defineProperty(window, '__OPENCHAMBER_ELECTRON__', { configurable: true, value: { runtime: 'electron' } });
  Object.defineProperty(window, '__OPENCHAMBER_DESKTOP__', { configurable: true, value: {
    invoke: async () => undefined,
    pathForFile: (file: File) => file === original ? originalPath : null,
  } });
  try {
    await submitInComposer('Review this image.', async (view) => {
      await act(async () => {
        const drop = new Event('drop', { bubbles: true, cancelable: true });
        Object.defineProperty(drop, 'dataTransfer', { value: { types: ['Files'], files: [original], items: [], getData: () => '' } });
        view.contentDOM.dispatchEvent(drop);
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
    });
    expect(submissions).toEqual([{ text: '[image-1.png] Review this image.', paths: [originalPath] }]);
  } finally {
    Reflect.deleteProperty(window, '__OPENCHAMBER_ELECTRON__');
    Reflect.deleteProperty(window, '__OPENCHAMBER_DESKTOP__');
    if (previousReader) Object.defineProperty(globalThis, 'FileReader', previousReader);
    else Reflect.deleteProperty(globalThis, 'FileReader');
    useInputStore.setState({ attachmentDraftKey: null, attachedFiles: [], attachmentDrafts: new Map() });
  }
});

test('a failed prompt read sends nothing and gives the text back', async () => {
  promptsStatus = 409;

  const remaining = await submitInComposer('/workspace-review');

  expect(promptReads).toHaveLength(1);
  expect(sent).toEqual([]);
  expect(remaining).toBe('/workspace-review');
});

test('a suspended managed model restores the draft and attachment without switching providers', async () => {
  const text = 'Please inspect this attachment';
  const attachment = { id: 'fixture-attachment', file: new File(['fixture'], 'fixture.txt', { type: 'text/plain' }), dataUrl: 'data:text/plain;base64,Zml4dHVyZQ==', mimeType: 'text/plain', filename: 'fixture.txt', size: 7, source: 'local' as const };
  useInputStore.setState({ attachmentDraftKey: null, attachedFiles: [attachment], attachmentDrafts: new Map() });
  useConfigStore.setState({ currentProviderId: 'unihub', currentModelId: 'managed-model' });
  const calls: string[] = [];
  useSessionUIStore.setState({ sendMessage: async (_content, providerID) => {
    calls.push(providerID ?? '');
    throw new Error('session.prompt failed (503): platform_dispatch_suspended');
  } });
  const notification = spyOn(toast, 'error').mockImplementation(() => 'fixture');
  try {
    expect(await submitInComposer(text)).toBe(text);
    expect(calls).toEqual(['unihub']);
    expect(useInputStore.getState().attachedFiles.map((file) => file.id)).toEqual(['fixture-attachment']);
    expect(notification.mock.calls.some(([message]) => typeof message === 'string' && /托管模型暂不可用|Managed models are temporarily unavailable/.test(message))).toBe(true);
  } finally {
    notification.mockRestore();
    useInputStore.setState({ attachmentDraftKey: null, attachedFiles: [], attachmentDrafts: new Map() });
  }
});

// The draft fields the composer routes a first send by.
type DraftTarget = { target: 'chat' | 'project'; directoryOverride: string | null; preparedChatDirectory?: string };

const promptDirectoryForDraft = async (draft: DraftTarget): Promise<string | null> => {
  useSessionUIStore.setState({
    currentSessionId: null,
    currentSessionDirectory: null,
    newSessionDraft: { draftId: 7, open: true, parentID: null, ...draft },
  });

  await submitInComposer('/workspace-review');

  expect(promptReads).toHaveLength(1);
  return promptReads[0].searchParams.get('sessionDirectory');
};

test('a new chat, which has no folder yet, reads the global prompts', async () => {
  expect(await promptDirectoryForDraft({ target: 'chat', directoryOverride: null, preparedChatDirectory: '/chats/today' })).toBeNull();
});

test('a project draft reads the prompts of the folder it opens in', async () => {
  expect(await promptDirectoryForDraft({ target: 'project', directoryOverride: '/repo' })).toBe('/repo');
});


for (const kind of ['existing', 'failed-creation', 'created-session'] as const) {
  test(`a ${kind} send failure restores composer text and attachment`, async () => {
    const attachment = { id: `failure-${kind}`, file: new File(['fixture'], 'fixture.txt', { type: 'text/plain' }), dataUrl: 'data:text/plain;base64,Zml4dHVyZQ==', mimeType: 'text/plain', filename: 'fixture.txt', size: 7, source: 'local' as const };
    useInputStore.setState({ attachmentDraftKey: null, attachedFiles: [attachment], attachmentDrafts: new Map() });
    useSessionUIStore.setState({ sendMessage: async () => {
      if (kind === 'existing') throw new Error('Failed to send message');
      throw new DraftSendError('ses_feature', WORKTREE, kind === 'created-session', new Error('Failed to send message'));
    } });
    try {
      const text = `restore ${kind} prompt`;
      expect(await submitInComposer(text)).toBe(text);
      expect(useInputStore.getState().attachedFiles.map((file) => file.id)).toEqual([attachment.id]);
    } finally { useInputStore.setState({ attachmentDraftKey: null, attachedFiles: [], attachmentDrafts: new Map() }); }
  });
}

for (const extension of ['log', 'docx']) {
  test(`large ${extension} reference suppresses duplicate @ bytes in the mounted composer`, async () => {
    const path = `${WORKTREE}/large.${extension}`;
    const note = `File on disk: ${path} (15 MB). Its content is not in this message.\n`;
    const attachment: AttachedFile = {
      id: `reference-${extension}`, file: new File([note], `large.${extension}`, { type: 'text/plain' }),
      dataUrl: `data:text/plain;base64,${Buffer.from(note).toString('base64')}`,
      mimeType: 'text/plain', filename: `large.${extension}`, size: 15 * 1024 * 1024,
      source: 'local', serverPath: path, agentPath: path,
    };
    useInputStore.setState({ attachmentDraftKey: null, attachedFiles: [attachment], attachmentDrafts: new Map() });
    const delivered: AttachedFile[][] = [];
    useSessionUIStore.setState({ sendMessage: async (_content, _provider, _model, _agent, attachments) => {
      delivered.push(attachments ?? []);
    } });
    try {
      await submitInComposer(`Inspect @${path}`);
      expect(fileReads).toEqual([]);
      expect(delivered).toHaveLength(1);
      expect(delivered[0]).toHaveLength(1);
      expect(delivered[0][0].dataUrl).toBe(attachment.dataUrl);
      expect(delivered[0][0].dataUrl).not.toContain('file://');
    } finally {
      useInputStore.setState({ attachmentDraftKey: null, attachedFiles: [], attachmentDrafts: new Map() });
    }
  });
}

class ContentFileReader {
  result: string | null = null;
  onload: (() => void) | null = null;
  readAsDataURL(file: File) {
    void file.arrayBuffer().then((bytes) => {
      this.result = `data:${file.type};base64,${Buffer.from(bytes).toString('base64')}`;
      this.onload?.();
    });
  }
}

for (const [name, raw, forbidden] of [
  ['capture.har', JSON.stringify({ log: { entries: [{ request: { headers: [{ name: 'authorization', value: 'Bearer private-secret' }] }, response: { content: { text: 'private-response-body' } } }] } }), ['private-secret', 'private-response-body']],
  ['analysis.ipynb', JSON.stringify({ cells: [{ cell_type: 'code', source: ['print(1)'], outputs: [{ data: { 'image/png': 'private-binary-output' } }] }] }), ['private-binary-output']],
] as const) {
  for (const withChip of [false, true]) {
    test(`sanitizes @${name} ${withChip ? 'alongside a dropped chip' : 'alone'} in the actual prompt request`, async () => {
      const { prepareLocalAttachments } = await import('@/sync/input-store');
      const { opencodeClient } = await import('@/lib/opencode/client');
      const { attachmentWireName } = await import('@/lib/attachmentIdentity');
      const path = `${WORKTREE}/${name}`;
      rawFileContents.set(path, raw);
      const originalReader = Object.getOwnPropertyDescriptor(globalThis, 'FileReader');
      Object.defineProperty(globalThis, 'FileReader', { configurable: true, value: ContentFileReader });
      try {
        const prepared = withChip ? await prepareLocalAttachments(new File([raw], name)) : [];
        useInputStore.setState({ attachmentDraftKey: null, attachedFiles: prepared ?? [], attachmentDrafts: new Map() });
        useSessionUIStore.setState({ sendMessage: async (content, _provider, _model, _agent, attachments) => {
          await opencodeClient.sendMessage({ id: 'sensitive', providerID: 'provider', text: content, directory: WORKTREE,
            files: attachments?.map((file) => ({ type: 'file', mime: file.mimeType, filename: attachmentWireName(file), url: file.dataUrl })),
          });
        } });
        const prompt = `Inspect @${path}`;
        await submitInComposer(prompt);
        expect(fileReads).toHaveLength(1);
        expect(promptBodies).toHaveLength(1);
        expect(promptBodies[0]).toContain(prompt);
        expect(promptBodies[0]).not.toContain('file://');
        const request = z.object({ files: z.array(z.object({ uri: z.string(), name: z.string() })) }).parse(JSON.parse(promptBodies[0]));
        expect(request.files).toHaveLength(withChip ? 2 : 1);
        for (const file of request.files) {
          expect(file.name).toBe(name);
          const text = Buffer.from(file.uri.split(',')[1], 'base64').toString();
          for (const value of forbidden) expect(text).not.toContain(value);
        }
      } finally {
        if (originalReader) Object.defineProperty(globalThis, 'FileReader', originalReader);
        else Reflect.deleteProperty(globalThis, 'FileReader');
        useInputStore.setState({ attachmentDraftKey: null, attachedFiles: [], attachmentDrafts: new Map() });
      }
    });
  }
}

for (const [name, content] of [['capture.har', '{"log":{"entries":[]}}'], ['analysis.ipynb', '{"cells":[]}']] as const) {
  test(`oversized @${name} preserves the composer and sends no raw path`, async () => {
    const prompt = `Inspect @${WORKTREE}/${name}`;
    rawFileContents.set(`${WORKTREE}/${name}`, content + ' '.repeat(10 * 1024 * 1024));
    const notification = spyOn(toast, 'error').mockImplementation(() => 'fixture');
    try {
      expect(await submitInComposer(prompt)).toBe(prompt);
      expect(fileReads).toHaveLength(1);
      expect(sent).toEqual([]);
      expect(promptBodies).toEqual([]);
    } finally {
      notification.mockRestore();
    }
  });
}

for (const extension of ['log', 'docx']) {
  test(`fork-replayed ${extension} note sends once and remains restorable in history`, async () => {
    const { opencodeClient } = await import('@/lib/opencode/client');
    const { getRuntimeKey } = await import('@/lib/runtime-switch');
    const { attachmentWireName } = await import('@/lib/attachmentIdentity');
    const { createInputHistorySubmission } = await import('@/stores/useInputHistoryStore');
    const { mapInputHistoryEntriesToValues } = await import('@/components/chat/inputHistory');
    const { isMentionAlreadyAttached } = await import('../composer/attachments/inlineMentionAttachments');
    const path = `${WORKTREE}/large.${extension}`;
    const note = `File on disk: ${path} (15 MB). Its content is not in this message. Read what you need from it with your tools.\n`;
    const url = `data:text/plain;base64,${Buffer.from(note).toString('base64')}`;
    const prompt = `Inspect @${path}`;
    useInputStore.setState({ attachmentDraftKey: null, attachedFiles: [], attachmentDrafts: new Map(), pendingComposerRestore: {
      target: { runtimeKey: getRuntimeKey(), directory: WORKTREE, sessionId: 'ses_feature' },
      text: prompt, files: [{ url, mimeType: 'text/plain', filename: path }],
    } });
    let delivered: AttachedFile[] = [];
    useSessionUIStore.setState({ sendMessage: async (content, _provider, _model, _agent, attachments) => {
      delivered = attachments ?? [];
      await opencodeClient.sendMessage({ id: 'sensitive', providerID: 'provider', text: content, directory: WORKTREE,
        files: attachments?.map((file) => ({ type: 'file', mime: file.mimeType, filename: attachmentWireName(file), url: file.dataUrl })),
      });
    } });
    try {
      await submitInComposer(prompt);
      expect(useInputStore.getState().pendingComposerRestore).toBeNull();
      expect(fileReads).toEqual([]);
      expect(delivered).toHaveLength(1);
      expect(promptBodies).toHaveLength(1);
      expect(promptBodies[0]).not.toContain('file://');
      expect(Buffer.byteLength(promptBodies[0])).toBeLessThan(1024);
      const request = z.object({ files: z.array(z.object({ uri: z.string(), name: z.string() })) }).parse(JSON.parse(promptBodies[0]));
      expect(request.files).toEqual([{ uri: url, name: path }]);
      const submission = createInputHistorySubmission(prompt, delivered);
      expect(submission.restorableAttachments).toHaveLength(1);
      const [restored] = mapInputHistoryEntriesToValues([{ ...submission, submittedAt: 1 }])[0].attachments;
      expect(restored.dataUrl).toBe(url);
      expect(isMentionAlreadyAttached({ serverPath: path, filename: `large.${extension}` }, [restored])).toBe(true);
    } finally {
      useInputStore.setState({ attachmentDraftKey: null, attachedFiles: [], attachmentDrafts: new Map(), pendingComposerRestore: null });
    }
  });
}
