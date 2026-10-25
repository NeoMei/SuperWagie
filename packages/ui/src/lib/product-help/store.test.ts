import { describe, expect, test } from 'bun:test';
import { createProductHelpStore } from './store';
import { ProductHelpError, productHelpAnswerSchema, type ProductHelpAnswer, type ProductHelpRequest } from './client';

const answer: ProductHelpAnswer = { kind: 'answer', text: 'Product help', sources: [], actions: [], mode: 'local', modelStatus: 'unconfigured' };
const request: Omit<ProductHelpRequest, 'history'> = { question: 'How do I configure models?', locale: 'en', context: { page: 'chat' } };
const articles = async () => [];

function deferred<T>() {
  let complete: (value: T) => void = () => { throw new Error('Promise not initialized'); };
  const promise = new Promise<T>((resolve) => { complete = resolve; });
  return { promise, resolve: (value: T) => complete(value) };
}

describe('product help conversation', () => {
  test('clearing a conversation rejects a late answer and cancels its request', async () => {
    let signal: AbortSignal | undefined;
    const pending = deferred<ProductHelpAnswer>();
    const store = createProductHelpStore({ articles, answer: async (_request, requestSignal) => { signal = requestSignal; return pending.promise; } });
    const asking = store.getState().ask(request);
    store.getState().clear();
    pending.resolve(answer); await asking;
    expect(signal?.aborted).toBe(true);
    expect(store.getState().messages).toEqual([]);
    expect(store.getState().pending).toBe(false);
  });
  test('runtime changes reject old answers and discard old draft and articles', async () => {
    const pending = deferred<ProductHelpAnswer>();
    const store = createProductHelpStore({ articles, answer: () => pending.promise });
    store.getState().syncRuntime('one');
    const asking = store.getState().ask(request);
    store.getState().setDraft('Private question');
    store.getState().syncRuntime('two');
    pending.resolve(answer); await asking;
    expect(store.getState().messages).toEqual([]);
    expect(store.getState().draft).toBe('');
    expect(store.getState().runtimeKey).toBe('two');
  });
  test('sends only bounded assistant history and prevents duplicate concurrent requests', async () => {
    const requests: ProductHelpRequest[] = [];
    const store = createProductHelpStore({ articles, answer: async input => { requests.push(input); return answer; } });
    for (let index = 0; index < 5; index++) await store.getState().ask({ ...request, question: `Question ${index}` });
    expect(requests.at(-1)?.history).toHaveLength(6);
    const pending = deferred<ProductHelpAnswer>();
    let calls = 0;
    const busy = createProductHelpStore({ articles, answer: async () => { calls++; return pending.promise; } });
    const first = busy.getState().ask(request);
    await busy.getState().ask(request);
    expect(calls).toBe(1);
    pending.resolve(answer); await first;
  });
  test('keeps a complete long answer while limiting the history sent with a follow-up', async () => {
    const longAnswer = { ...answer, text: 'Reviewed help. '.repeat(600) };
    const requests: ProductHelpRequest[] = [];
    const store = createProductHelpStore({ articles, answer: async input => {
      requests.push(input);
      return longAnswer;
    } });
    await store.getState().ask(request);
    await store.getState().ask({ ...request, question: 'What next?' });

    expect(requests[1].history).toEqual([
      { role: 'user', text: request.question },
      { role: 'assistant', text: longAnswer.text.slice(0, 4_000) },
    ]);
    expect(store.getState().messages[1]).toMatchObject({ role: 'assistant', answer: longAnswer });
  });
  test('failure preserves the question for retry without erasing previous answers', async () => {
    let failed = false;
    const store = createProductHelpStore({ articles, answer: async () => { if (failed) throw new ProductHelpError('unsupported'); return answer; } });
    await store.getState().ask(request); failed = true;
    await store.getState().ask({ ...request, question: 'Follow-up' });
    expect(store.getState().messages).toHaveLength(3);
    expect(store.getState().draft).toBe('Follow-up');
    expect(store.getState().failure).toBe('unsupported');
  });
  test('cancel restores the question and ignores an eventual completion', async () => {
    const pending = deferred<ProductHelpAnswer>();
    const store = createProductHelpStore({ articles, answer: () => pending.promise });
    const asking = store.getState().ask(request); store.getState().cancel();
    pending.resolve(answer); await asking;
    expect(store.getState().draft).toBe(request.question);
    expect(store.getState().messages).toHaveLength(1);
  });
  test('cancel preserves a new draft typed while waiting', async () => {
    const pending = deferred<ProductHelpAnswer>();
    const store = createProductHelpStore({ articles, answer: () => pending.promise });
    const asking = store.getState().ask(request);
    store.getState().setDraft('My next question');
    store.getState().cancel();
    pending.resolve(answer);
    await asking;
    expect(store.getState().draft).toBe('My next question');
  });
  test('a failed request preserves a new draft typed while waiting', async () => {
    const pending = deferred<ProductHelpAnswer>();
    const store = createProductHelpStore({ articles, answer: async () => {
      await pending.promise;
      throw new ProductHelpError('request');
    } });
    const asking = store.getState().ask(request);
    store.getState().setDraft('My next question');
    pending.resolve(answer);
    await asking;
    expect(store.getState().draft).toBe('My next question');
    expect(store.getState().failure).toBe('request');
  });
  test('a stale article response cannot replace the new language', async () => {
    const pending = deferred<[]>();
    const store = createProductHelpStore({ answer: async () => answer, articles: locale => locale === 'en' ? pending.promise : Promise.resolve([{id:'zh',title:'帮助',text:'说明',actions:[]}]) });
    const first = store.getState().loadArticles('en');
    await store.getState().loadArticles('zh-CN'); pending.resolve([]); await first;
    expect(store.getState().articles[0]?.id).toBe('zh');
  });
  test('panels sharing the same catalog request do not start a second fetch', async () => {
    const pending = deferred<[]>();
    let calls = 0;
    const store = createProductHelpStore({ answer: async () => answer, articles: () => {
      calls++;
      return pending.promise;
    } });
    const first = store.getState().loadArticles('en');
    await store.getState().loadArticles('en');
    expect(calls).toBe(1);
    pending.resolve([]);
    await first;
    expect(store.getState().articlesPending).toBe(false);
  });
  test('rejects a server-supplied arbitrary navigation target', () => {
    expect(productHelpAnswerSchema.safeParse({ ...answer, actions: [{id:'run',kind:'guide',target:'execute-shell'}] }).success).toBe(false);
  });
  test('rejects invented executable actions and extra executable parameters', () => {
    expect(productHelpAnswerSchema.safeParse({ ...answer, actions: [{ id: 'run', kind: 'execute', operation: 'execute-shell' }] }).success).toBe(false);
    expect(productHelpAnswerSchema.safeParse({ ...answer, actions: [{ id: 'run', kind: 'execute', operation: 'theme-dark', script: 'arbitrary' }] }).success).toBe(false);
  });
  test('executes only an offered operation and deduplicates concurrent panel clicks', async () => {
    const actionable: ProductHelpAnswer = { ...answer, actions: [{ id: 'dark', kind: 'execute', operation: 'theme-dark' }] };
    const store = createProductHelpStore({ articles, answer: async () => actionable });
    await store.getState().ask(request);
    const message = store.getState().messages.at(-1);
    if (!message) throw new Error('Missing message');
    const pending = deferred<'completed'>();
    const operations: string[] = [];
    const run = async (operation: string) => { operations.push(operation); return pending.promise; };
    await store.getState().execute(message.id, 'invented', run);
    expect(operations).toEqual([]);
    const first = store.getState().execute(message.id, 'dark', run);
    await store.getState().execute(message.id, 'dark', run);
    expect(operations).toEqual(['theme-dark']);
    expect(store.getState().operation?.status).toBe('running');
    pending.resolve('completed'); await first;
    expect(store.getState().operation?.status).toBe('completed');
  });
  test('a cleared conversation invalidates an operation completion', async () => {
    const actionable: ProductHelpAnswer = { ...answer, actions: [{ id: 'english', kind: 'execute', operation: 'language-en' }] };
    const store = createProductHelpStore({ articles, answer: async () => actionable });
    await store.getState().ask(request);
    const message = store.getState().messages.at(-1);
    if (!message) throw new Error('Missing message');
    const pending = deferred<'completed'>();
    let current = () => true;
    const running = store.getState().execute(message.id, 'english', async (_operation, isCurrent) => {
      current = isCurrent; return pending.promise;
    });
    store.getState().clear();
    expect(current()).toBe(false);
    pending.resolve('completed'); await running;
    expect(store.getState().operation).toBeNull();
  });
});
