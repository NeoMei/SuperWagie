import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { ChildStoreManager } from '@/sync/child-store';
import { setActionRefs } from '@/sync/session-actions';
import { setSyncRefs } from '@/sync/sync-refs';
import { sendUiBlockReplyAnswer } from './replyAnswer';

const originalBase = getRuntimeApiBaseUrl();
const originalKey = getRuntimeKey();
const directory = '/ui-answer/project';
const target = { sessionId: 'session', messageId: 'reply', block: 'block', directory };
const answer = { picks: [], values: { scope: 'API' }, skipped: [] };
const record = (path = directory): Session => ({
  id: 'session', projectID: 'project', directory: path, title: 'Reply', cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 2 }, revert: { messageID: 'boundary' },
});
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let stores: ChildStoreManager;
let managers: ChildStoreManager[];
let commitResponse: Promise<Response> | undefined;
let syntheticResponse: Promise<Response> | undefined;
let commitStarted: ReturnType<typeof deferred<void>>;
let syntheticStarted: ReturnType<typeof deferred<void>>;
let requests: Array<{ url: URL; body: string; directory: string | null }>;
let fetch: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;
let tokenMints: Array<Promise<PromiseSettledResult<string>[]>>;
const switchEndpoint = (base: string, key: string) => {
  switchRuntimeEndpoint({ apiBaseUrl: base, runtimeKey: key });
  tokenMints.push(Promise.allSettled([refreshRuntimeUrlAuthToken(base)]));
  opencodeClient.reconnectToRuntimeBaseUrl();
};
const seed = (manager: ChildStoreManager, path = directory) => {
  const owner = manager.ensureChild(path, { bootstrap: false });
  owner.setState({ session: [record(path)], status: 'complete' });
  setActionRefs(manager, () => path);
  setSyncRefs(opencodeClient.getSdkClient(), manager, path);
  return owner;
};

beforeEach(async () => {
  managers = [];
  stores = new ChildStoreManager();
  managers.push(stores);
  requests = [];
  tokenMints = [];
  commitResponse = undefined;
  syntheticResponse = undefined;
  commitStarted = deferred<void>();
  syntheticStarted = deferred<void>();
  fetch = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://ui-answer.test');
    if (url.pathname === '/auth/url-token') return new Response(null, { status: 404 });
    const request = new Request(url, init ?? (input instanceof Request ? input : undefined));
    requests.push({ url, body: await request.text(), directory: request.headers.get('x-opencode-directory') });
    if (url.pathname.endsWith('/revert/commit')) {
      commitStarted.resolve();
      return commitResponse ?? new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith('/synthetic')) {
      syntheticStarted.resolve();
      return syntheticResponse ?? Response.json({ id: 'admitted' });
    }
    throw new Error(`Unexpected UI answer fixture request: ${url.pathname}`);
  });
  switchEndpoint('https://ui-answer-a.test', 'ui-answer-a');
  await Promise.all(tokenMints);
  seed(stores);
});

afterEach(async () => {
  switchEndpoint(originalBase, originalKey);
  await Promise.all(tokenMints);
  fetch.mockRestore();
  for (const manager of managers) manager.disposeAll();
});

test('real SDK admission keeps retry ids stable and scopes them to the directory', async () => {
  await sendUiBlockReplyAnswer(target, answer, 'Selected API');
  await sendUiBlockReplyAnswer(target, answer, 'Selected API');
  const otherDirectory = '/ui-answer/other';
  seed(stores, otherDirectory);
  await sendUiBlockReplyAnswer({ ...target, directory: otherDirectory }, answer, 'Selected API');
  const admitted = requests.filter((request) => request.url.pathname.endsWith('/synthetic'));
  const first = JSON.parse(admitted[0].body);
  const retry = JSON.parse(admitted[1].body);
  const other = JSON.parse(admitted[2].body);
  expect(first.id).toBe(retry.id);
  expect(other.id).not.toBe(first.id);
  expect(first).toMatchObject({ text: 'Selected API', resume: true, metadata: { openchamberUiBlockAnswer: { messageId: 'reply', block: 'block', answer } } });
  expect(admitted.map((request) => request.directory)).toEqual([directory, directory, otherDirectory].map(encodeURIComponent));
});

test('an A-to-B-to-A switch during the staged commit prevents synthetic admission', async () => {
  const pending = deferred<Response>();
  commitResponse = pending.promise;
  const sending = sendUiBlockReplyAnswer(target, answer, 'Selected API');
  await commitStarted.promise;
  switchEndpoint('https://ui-answer-b.test', 'ui-answer-b');
  switchEndpoint('https://ui-answer-a.test', 'ui-answer-a');
  pending.resolve(new Response(null, { status: 204 }));
  await expect(sending).rejects.toThrow('changed');
  expect(requests.filter((request) => request.url.pathname.endsWith('/synthetic'))).toHaveLength(0);
});

test('a replacement manager during the staged commit prevents synthetic admission', async () => {
  const pending = deferred<Response>();
  commitResponse = pending.promise;
  const sending = sendUiBlockReplyAnswer(target, answer, 'Selected API');
  await commitStarted.promise;
  const replacement = new ChildStoreManager();
  managers.push(replacement);
  seed(replacement);
  pending.resolve(new Response(null, { status: 204 }));
  await expect(sending).rejects.toThrow('changed');
  expect(requests.filter((request) => request.url.pathname.endsWith('/synthetic'))).toHaveLength(0);
});

test('a replaced directory store during the staged commit prevents synthetic admission', async () => {
  const pending = deferred<Response>();
  commitResponse = pending.promise;
  const sending = sendUiBlockReplyAnswer(target, answer, 'Selected API');
  await commitStarted.promise;
  expect(stores.disposeDirectory(directory)).toBe(true);
  seed(stores);
  pending.resolve(new Response(null, { status: 204 }));
  await expect(sending).rejects.toThrow('changed');
  expect(requests.filter((request) => request.url.pathname.endsWith('/synthetic'))).toHaveLength(0);
});

test('the client rejects a synthetic result from a retired runtime instance', async () => {
  const pending = deferred<Response>();
  syntheticResponse = pending.promise;
  const sending = opencodeClient.resumeWithSyntheticInput({ ...target, runtimeKey: getRuntimeKey(), id: 'input', text: 'Selected API', metadata: {} });
  await syntheticStarted.promise;
  switchEndpoint('https://ui-answer-b.test', 'ui-answer-b');
  switchEndpoint('https://ui-answer-a.test', 'ui-answer-a');
  pending.resolve(Response.json({ id: 'admitted' }));
  await expect(sending).rejects.toThrow('changed');
});
