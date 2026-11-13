import { afterEach, expect, spyOn, test } from 'bun:test';
import { previewHyMemoryTidy, applyHyMemoryTidy, previewHyMemoryExport, confirmHyMemoryExport, readHyMemoryRevisions } from './hyMemoryTidy';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from './runtime-url';

const resolver = getRuntimeUrlResolver();
let fixture: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>> | null = null;
afterEach(() => { fixture?.mockRestore(); fixture = null; setRuntimeUrlResolver(resolver); });
const item = { id: 'a', kind: 'manual', type: 'fact', version: 'v', sourceVersion: 's', sourceSessionIds: [], sourceHash: null, sourceReferences: [], verification: 'unverified', before: { title: ' A ', body: ' B ' }, after: { title: 'A', body: 'B' }, reasons: ['whitespace'] };
const preview = { previewId: 'preview', items: [item], unavailable: 0, truncated: false };

test('keeps selected item identity and separate explicit export confirmation in the runtime transport', async () => {
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://memory.test' });
  const calls: Array<{ url: URL; body: string; signal: AbortSignal | null | undefined }> = [];
  fixture = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({ url, body: String(init?.body ?? ''), signal: init?.signal });
    if (url.pathname.endsWith('/apply')) return Response.json({ results: [{ id: 'a', kind: 'manual', state: 'applied', revisionId: 'r' }] });
    if (url.pathname.endsWith('/export/preview')) return Response.json({ exportId: 'e', target: '/repo/AGENTS.md', before: 'old', after: 'new' });
    if (url.pathname.endsWith('/export/confirm')) return Response.json({ written: true, target: '/repo/AGENTS.md' });
    if (url.pathname.endsWith('/revisions')) return Response.json({ revisions: [], unavailable: 0 });
    return Response.json(preview);
  });
  const controller = new AbortController();
  expect(await previewHyMemoryTidy('/repo', controller.signal)).toEqual(preview);
  await applyHyMemoryTidy('/repo', 'preview', ['manual:a'], controller.signal);
  await previewHyMemoryExport('/repo', [{ id: 'a', kind: 'manual' }], controller.signal);
  await confirmHyMemoryExport('/repo', 'e', controller.signal);
  await readHyMemoryRevisions('C:/my project', controller.signal);
  expect(JSON.parse(calls[1].body)).toEqual({ directory: '/repo', previewId: 'preview', selectedIds: ['manual:a'] });
  expect(JSON.parse(calls[2].body)).toEqual({ directory: '/repo', items: [{ id: 'a', kind: 'manual' }] });
  expect(JSON.parse(calls[3].body)).toEqual({ directory: '/repo', exportId: 'e', confirmed: true });
  expect(calls[4].url.searchParams.get('directory')).toBe('C:/my project');
  expect(calls.every((call) => call.signal === controller.signal)).toBe(true);
});

test('unavailable and malformed responses stay failures and isolated scopes never dispatch', async () => {
  fixture = spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: 'memory_backend_unavailable' }, { status: 503 }));
  const signal = new AbortController().signal;
  await expect(previewHyMemoryTidy('/repo', signal)).rejects.toThrow('memory_backend_unavailable');
  fixture.mockResolvedValue(Response.json({ items: [] }));
  await expect(previewHyMemoryTidy('/repo', signal)).rejects.toThrow('bad_response');
  fixture.mockClear();
  await expect(previewHyMemoryTidy('/spaces/0123456789ab/project', signal)).rejects.toThrow('hy_tidy_isolated_unsupported');
  expect(fixture).not.toHaveBeenCalled();
});

test('rejects late responses after runtime change and abort', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const runtimeWindow = { __OPENCHAMBER_API_BASE_URL__: 'https://old.test', location: { origin: 'https://app.test', href: 'https://app.test/' } };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: runtimeWindow });
  let complete: ((value: Response) => void) | undefined;
  fixture = spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>((resolve) => { complete = resolve; }));
  try {
    const read = previewHyMemoryTidy('/repo', new AbortController().signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    runtimeWindow.__OPENCHAMBER_API_BASE_URL__ = 'https://new.test'; complete?.(Response.json(preview));
    await expect(read).rejects.toThrow('runtime_changed');
    const controller = new AbortController(); const aborted = previewHyMemoryTidy('/repo', controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0)); controller.abort(); complete?.(Response.json(preview));
    await expect(aborted).rejects.toThrow('The request was aborted');
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('review copy is complete and translated in both supported languages', async () => {
  const { dict: english } = await import('./i18n/messages/en');
  const { dict: chinese } = await import('./i18n/messages/zh-CN');
  const source = Object.entries(english).filter(([key]) => key.startsWith('hyTidy.'));
  const translated = new Map(Object.entries(chinese).filter(([key]) => key.startsWith('hyTidy.')));
  expect(source.map(([key]) => key).sort()).toEqual([...translated.keys()].sort());
  for (const [key, value] of source) {
    expect(value.trim()).not.toBe('');
    expect(translated.get(key)?.trim()).toBeTruthy();
    expect(translated.get(key)).not.toBe(value);
  }
});
