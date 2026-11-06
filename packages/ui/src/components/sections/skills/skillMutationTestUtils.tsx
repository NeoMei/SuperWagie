import { afterAll, afterEach, expect, spyOn } from 'bun:test';
import { Window } from 'happy-dom';
import { plugin } from 'bun';
import type { DiscoveredSkill } from '@/stores/useSkillsStore';
import type { SkillsCatalogItem, SkillsCatalogSource } from '@/lib/api/types';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage, customElements: browser.customElements,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement, HTMLTextAreaElement: browser.HTMLTextAreaElement,
  DocumentFragment: browser.DocumentFragment, Text: browser.Text, NodeList: browser.NodeList,
  Event: browser.Event, FocusEvent: browser.FocusEvent, CustomEvent: browser.CustomEvent,
  MouseEvent: browser.MouseEvent, PointerEvent: browser.PointerEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
interface RequestEntry { host: string; path: string; directory: string | null; method: string; body: string | null; query: string }
export const requests: RequestEntry[] = [];
export const unexpected: string[] = [];
let respond: (entry: RequestEntry) => Promise<Response> = async () => Response.json({});
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
  const body = init?.body ? String(init.body) : input instanceof Request && input.body ? await input.clone().text() : null;
  const entry: RequestEntry = { host: url.host, path: url.pathname, directory: url.searchParams.get('directory'),
    query: url.search, method: init?.method ?? (input instanceof Request ? input.method : 'GET'), body };
  requests.push(entry);
  return respond(entry);
});
plugin({ name: 'ca17-scratch-worker-url', setup(build) {
  build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, () => ({ contents: 'export default "http://localhost/fixture-worker.js";', loader: 'js' }));
} });
export const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { TooltipProvider } = await import('@/components/ui/tooltip');
export const useSkillsStore: typeof import('@/stores/useSkillsStore').useSkillsStore = (await import('@/stores/useSkillsStore')).useSkillsStore;
export const useSkillsCatalogStore: typeof import('@/stores/useSkillsCatalogStore').useSkillsCatalogStore = (await import('@/stores/useSkillsCatalogStore')).useSkillsCatalogStore;
const useProjectsStore: typeof import('@/stores/useProjectsStore').useProjectsStore = (await import('@/stores/useProjectsStore')).useProjectsStore;
export const useUIStore: typeof import('@/stores/useUIStore').useUIStore = (await import('@/stores/useUIStore')).useUIStore;
const { switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
const { toast } = await import('@/components/ui');
const { useI18nStore } = await import('@/lib/i18n/store');
const originalSkills = useSkillsStore.getState();
const originalCatalog = useSkillsCatalogStore.getState();
export const success = spyOn(toast, 'success').mockImplementation(() => 'success');
export const error = spyOn(toast, 'error').mockImplementation(() => 'error');
export const skill = (name = 'lab'): DiscoveredSkill => ({ id: name, name,
  path: `/fixture/.opencode/skills/${name}/SKILL.md`, scope: 'project', source: 'opencode',
  description: `${name} description`, renamable: true });
export const source: SkillsCatalogSource = { id: 'fixture', label: 'Fixture skills', source: 'fixture/skills', sourceType: 'github' };
export const item = (name: string): SkillsCatalogItem => ({ sourceId: 'fixture', repoSource: 'fixture/skills',
  skillDir: name, skillName: name, description: `${name} description`, installable: true,
  installed: { isInstalled: true, scope: 'user', source: 'opencode' } });
export const detail = (name = 'lab', instructions = 'initial') => ({ name, scope: 'project', source: 'opencode', sources: {
  md: { exists: true, path: `/fixture/.opencode/skills/${name}/SKILL.md`, dir: `/fixture/.opencode/skills/${name}`,
    fields: ['description', 'instructions'], scope: 'project', source: 'opencode', supportingFiles: [],
    name, description: `${name} description`, instructions, disableModelInvocation: false } } });
export const deferred = <T,>() => {
  let finish: (value: T) => void = () => { throw new Error('deferred not initialized'); };
  let fail: (reason: Error) => void = () => { throw new Error('deferred not initialized'); };
  const promise = new Promise<T>((resolve, reject) => { finish = resolve; fail = reject; });
  return { promise, finish, fail };
};
export const setResponder = (handler: typeof respond) => { respond = handler; };
export const defaultResponse = async (entry: RequestEntry): Promise<Response> => {
  if (entry.path.endsWith('/auth/url-token')) return Response.json({});
  if (entry.path === '/api/config/skill-switch') return Response.json({ changed: ['/fixture/opencode.json'] });
  if (entry.path === '/api/config/skills/catalog') return Response.json({ ok: true, sources: [source], itemsBySource: { fixture: [item('one'), item('two')] } });
  if (entry.path === '/api/config/skills/catalog/source') return Response.json({ ok: true, items: [item('one'), item('two')] });
  if (entry.path === '/api/config/skills') return Response.json({ skills: [skill(), skill('renamed'), skill('one'), skill('two')] });
  if (entry.path === '/api/opencode/health') return Response.json({ healthy: true });
  if (entry.path.startsWith('/api/config/skills/')) return entry.method === 'GET' ? Response.json(detail(entry.path.split('/').at(-1))) : Response.json({});
  if (entry.path === '/api/config') return Response.json([]);
  if (entry.path === '/api/config/settings') return Response.json({ skillCatalogs: [] });
  if (entry.path === '/api/config/themes') return Response.json({ themes: [] });
  if (entry.path === '/api/git/identities') return Response.json([]);
  if (entry.path === '/api/git/global-identity') return Response.json({ userName: null, userEmail: null });
  if (entry.path === '/api/fs/home') return Response.json({ home: '/fixture' });
  if (entry.path.includes('/session')) return Response.json({ data: [], pagination: {} });
  if (entry.path === '/api/location') return Response.json({ directory: '/fixture', project: { directory: '/fixture' } });
  unexpected.push(`${entry.method} ${entry.host}${entry.path}`);
  throw new Error(`Unexpected fixture request ${entry.method} ${entry.path}`);
};
export const switchTo = (id: string) => {
  switchRuntimeEndpoint({ apiBaseUrl: `http://skill-${id}.invalid`, runtimeKey: `skill-${id}` });
  useSkillsStore.getState().resetForRuntimeSwitch();
};
export const setup = () => {
  respond = defaultResponse;
  useSkillsStore.setState(originalSkills); useSkillsCatalogStore.setState(originalCatalog);
  switchTo('a');
  useProjectsStore.setState({ projects: [{ id: 'fixture', path: '/fixture' }, { id: 'other', path: '/other' }], activeProjectId: 'fixture' });
  useUIStore.setState({ settingsProjectPath: '/fixture' });
  useSkillsStore.setState({ selectedSkillName: 'lab', skillDraft: null, skills: [skill()],
    skillsByDirectory: { '/fixture': [skill()] }, policiesByDirectory: { '/fixture': [] } });
  useI18nStore.getState().setLocale('en');
  requests.length = 0; unexpected.length = 0; success.mockClear(); error.mockClear();
};
export const mutations = () => requests.filter((entry) => (entry.path.startsWith('/api/config/skills/') || entry.path === '/api/config/skill-switch') && entry.method !== 'GET');
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
  while (!condition()) { if (Date.now() > deadline) throw new Error('Fixture condition not reached'); await new Promise((resolve) => setTimeout(resolve, 1)); }
};
let root: ReturnType<typeof createRoot> | null = null;
export const mount = async (node: React.ReactNode) => {
  const container = document.createElement('div'); document.body.replaceChildren(container);
  root = createRoot(container);
  await act(async () => { root?.render(<I18nProvider><ThemeSystemProvider><TooltipProvider>{node}</TooltipProvider></ThemeSystemProvider></I18nProvider>); });
};
export const unmount = async () => { await act(async () => root?.unmount()); root = null; };
afterEach(async () => { await unmount(); useSkillsStore.getState().resetForRuntimeSwitch(); respond = defaultResponse;
  useSkillsStore.setState(originalSkills); useSkillsCatalogStore.setState(originalCatalog); expect(unexpected).toEqual([]); });
afterAll(() => { success.mockRestore(); error.mockRestore(); fetchSpy.mockRestore(); browser.close(); });
