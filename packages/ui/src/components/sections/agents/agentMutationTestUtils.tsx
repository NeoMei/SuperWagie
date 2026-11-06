import { afterAll, afterEach, spyOn } from 'bun:test';
import { Window } from 'happy-dom';
import { plugin } from 'bun';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AgentWithExtras, AgentEntityEnvelope } from '@/stores/useAgentsStore';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement, HTMLTextAreaElement: browser.HTMLTextAreaElement,
  Event: browser.Event, FocusEvent: browser.FocusEvent, CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
interface RequestEntry { host: string; path: string; directory: string | null; method: string; body: string | null }
export const requests: RequestEntry[] = [];
let respond: (entry: RequestEntry) => Promise<Response> = async () => Response.json({});
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
  const entry: RequestEntry = {
    host: url.host, path: url.pathname, directory: url.searchParams.get('directory'),
    method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
    body: typeof init?.body === 'string' ? init.body : null,
  };
  requests.push(entry);
  return respond(entry);
});
export const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
export const useAgentsStore: typeof import('@/stores/useAgentsStore').useAgentsStore = (await import('@/stores/useAgentsStore')).useAgentsStore;
export const { selectAgentsForDirectory } = await import('@/stores/useAgentsStore');
export const useProjectsStore: typeof import('@/stores/useProjectsStore').useProjectsStore = (await import('@/stores/useProjectsStore')).useProjectsStore;
export const useUIStore: typeof import('@/stores/useUIStore').useUIStore = (await import('@/stores/useUIStore')).useUIStore;
const { switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
const { toast } = await import('@/components/ui');
const { useI18nStore } = await import('@/lib/i18n/store');
const original = useAgentsStore.getState();
export const success = spyOn(toast, 'success').mockImplementation(() => 'success');
export const error = spyOn(toast, 'error').mockImplementation(() => 'error');
export const agent = (name = 'lab'): AgentWithExtras => ({
  id: name, name, displayName: name, mode: 'subagent', hidden: false,
  request: { settings: {}, headers: {}, body: {} }, permissions: [], scope: 'project', native: false,
});
export const envelope = (system = 'initial'): AgentEntityEnvelope => ({
  source: 'json', scope: 'project', path: '/fixture/config.json', legacy: false,
  config: { system, mode: 'subagent', permissions: [{ action: 'shell', resource: '*', effect: 'ask' }] },
});
export const deferred = <T,>() => {
  let finish: (value: T) => void = () => { throw new Error('deferred not initialized'); };
  let fail: (reason: Error) => void = () => { throw new Error('deferred not initialized'); };
  const promise = new Promise<T>((resolve, reject) => { finish = resolve; fail = reject; });
  return { promise, finish, fail };
};
export const setResponder = (handler: typeof respond) => { respond = handler; };
export const defaultResponse = async (entry: RequestEntry): Promise<Response> => {
  if (entry.path.endsWith('/auth/url-token')) return Response.json({});
  if (entry.path.endsWith('/permissions')) return Response.json({ global: [], agent: [], effective: [], source: 'json', path: '/fixture/config.json' });
  if (entry.path.startsWith('/api/config/agents/')) {
    if (entry.path.endsWith('/config')) return Response.json(envelope());
    if (entry.method !== 'GET') return Response.json({});
    return Response.json({ scope: 'project', sources: { json: { exists: true, scope: 'project', path: '/fixture/config.json' } }, isBuiltIn: false });
  }
  if (entry.path.endsWith('/disabled-agents')) return Response.json({ agents: [] });
  if (entry.path.endsWith('/agent')) return Response.json({ data: [agent()] });
  if (entry.path.endsWith('/integration')) return Response.json({ location: { directory: '/fixture' }, data: [] });
  if (entry.path.includes('/session')) return Response.json({ data: [], pagination: {} });
  if (entry.path.includes('/location')) return Response.json({ directory: '/fixture', project: { directory: '/fixture' } });
  if (entry.path.endsWith('/config/mcp') || entry.path.endsWith('/mcp') || entry.path.endsWith('/config')) return Response.json([]);
  if (entry.path.includes('/settings') || entry.path.includes('/home') || entry.path.includes('/system')) return Response.json({ home: '/fixture' });
  throw new Error(`Unexpected fixture request ${entry.method} ${entry.path}`);
};
export const switchTo = (id: string) => {
  switchRuntimeEndpoint({ apiBaseUrl: `http://agent-${id}.invalid`, runtimeKey: `agent-${id}` });
  useAgentsStore.getState().resetForRuntimeSwitch();
};
export const setup = () => {
  respond = defaultResponse;
  useAgentsStore.setState(original);
  switchTo('a');
  useProjectsStore.setState({ projects: [{ id: 'fixture', path: '/fixture' }, { id: 'other', path: '/other' }], activeProjectId: 'fixture' });
  useUIStore.setState({ settingsProjectPath: '/fixture' });
  useAgentsStore.setState({ selectedAgentName: 'lab', agentDraft: null, agents: [agent()], agentsByDirectory: { '/fixture': [agent()], '/other': [agent()] } });
  useI18nStore.getState().setLocale('en');
  requests.length = 0; success.mockClear(); error.mockClear();
};
export const mutations = () => requests.filter((entry) => entry.path.startsWith('/api/config/agents/') && entry.method !== 'GET');
export const button = (label: string, selector = 'button'): HTMLButtonElement => {
  const found = [...document.querySelectorAll<HTMLButtonElement>(selector)].find((node) => node.textContent?.trim() === label);
  if (!found) throw new Error(`Missing ${label} button`);
  return found;
};
export const change = async (field: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (!setter) throw new Error('Missing native input setter');
  await act(async () => { setter.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
};
export const until = async (condition: () => boolean) => {
  const deadline = Date.now() + 2000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Fixture condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};
plugin({ name: 'agent-owner-provider-logos', setup(build) {
  build.onLoad({ filter: /useProviderLogo\.ts$/ }, ({ path }) => {
    const directory = resolve(dirname(path), '../assets/provider-logos');
    const logos = Object.fromEntries(readdirSync(directory).filter((name) => name.endsWith('.svg')).map((name) => [`../assets/provider-logos/${name}`, pathToFileURL(resolve(directory, name)).href]));
    return { contents: readFileSync(path, 'utf8').replace(/import\.meta\.glob<string>\([\s\S]*?\);/, `${JSON.stringify(logos)};`), loader: 'ts' };
  });
} });
let root: ReturnType<typeof createRoot> | null = null;
export const mount = async (node: React.ReactNode) => {
  const container = document.createElement('div'); document.body.replaceChildren(container);
  root = createRoot(container);
  await act(async () => { root?.render(<I18nProvider><ThemeSystemProvider>{node}</ThemeSystemProvider></I18nProvider>); });
};
export const unmount = async () => { await act(async () => root?.unmount()); root = null; };
afterEach(async () => { await unmount(); respond = defaultResponse; useAgentsStore.setState(original); });
afterAll(() => { success.mockRestore(); error.mockRestore(); fetchSpy.mockRestore(); browser.close(); });
