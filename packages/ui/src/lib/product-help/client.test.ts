import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test';
import { loadProductHelpArticles, requestProductHelp } from './client';

const fetchFixture = spyOn(globalThis, 'fetch');
afterEach(() => { fetchFixture.mockReset(); });
afterAll(() => { fetchFixture.mockRestore(); });

describe('product help catalog transport', () => {
  test('returns the parsed catalog version beside articles and forwards locale and cancellation', async () => {
    const controller = new AbortController();
    const catalog = { catalogVersion: 'release-independent-2', articles: [{ id: 'models', title: 'Models', text: 'Updated help', actions: [] }] };
    fetchFixture.mockImplementation(async (input, init) => {
      expect(String(input)).toBe('/api/product-help/articles?locale=zh-CN');
      expect(init?.signal).toBe(controller.signal);
      return Response.json(catalog);
    });
    expect(await loadProductHelpArticles('zh-CN', controller.signal)).toEqual(catalog);
  });
  test('rejects invalid dynamic article actions instead of treating them as an empty catalog', async () => {
    fetchFixture.mockResolvedValue(Response.json({ catalogVersion: 'second', articles: [{ id: 'bad', title: 'Bad', text: 'Bad', actions: [{ id: 'run', kind: 'execute', operation: 'shell' }] }] }));
    await expect(loadProductHelpArticles('en', new AbortController().signal)).rejects.toMatchObject({ name: 'ProductHelpError', code: 'invalid-response' });
  });
  test('retains the answer version from the backend', async () => {
    fetchFixture.mockResolvedValue(Response.json({ kind: 'answer', text: 'Help', sources: [], actions: [], mode: 'local', modelStatus: 'not-used', catalogVersion: 'second' }));
    const answer = await requestProductHelp({ question: 'Help', locale: 'en', context: { page: 'chat' }, history: [] }, new AbortController().signal);
    expect(answer.catalogVersion).toBe('second');
  });
});
