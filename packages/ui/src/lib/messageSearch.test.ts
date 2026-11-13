import { describe, expect, test } from 'bun:test';

import { isSearchableQuery, MATCH_END, MATCH_START, searchMessages, splitSnippet } from './messageSearch';

describe('message search helpers', () => {
  test('a query needs one word the index can look up', () => {
    expect(isSearchableQuery('ab')).toBe(false);
    expect(isSearchableQuery('ab cd')).toBe(false);
    expect(isSearchableQuery('ab світ')).toBe(true);
    expect(isSearchableQuery('   ')).toBe(false);
    expect(isSearchableQuery('报价')).toBe(false);
    expect(isSearchableQuery('报价单')).toBe(true);
  });

  test('splits a snippet into plain runs and matches', () => {
    expect(splitSnippet(`…see ${MATCH_START}portless${MATCH_END} and ${MATCH_START}git${MATCH_END}hub`)).toEqual([
      { text: '…see ', matched: false },
      { text: 'portless', matched: true },
      { text: ' and ', matched: false },
      { text: 'git', matched: true },
      { text: 'hub', matched: false },
    ]);
  });

  test('keeps markup-looking text as text', () => {
    expect(splitSnippet('<b>not bold</b>')).toEqual([{ text: '<b>not bold</b>', matched: false }]);
  });

  test('tolerates an unterminated match', () => {
    expect(splitSnippet(`a ${MATCH_START}b`)).toEqual([{ text: 'a ', matched: false }, { text: 'b', matched: true }]);
  });
});

test('grouped body results carry their archived scope and exact message target', async () => {
  const originalFetch = globalThis.fetch;
  const requests: URL[] = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    requests.push(new URL(input instanceof Request ? input.url : String(input), 'http://localhost'));
    return Response.json({ status: 'ok', hits: [{ messageId: 'message-a', sessionId: 'session-a', sessionTitle: '预算', directory: '/a', role: 'user', createdAt: 1, snippet: '报价单', matchCount: 3, archived: true }], next: null, index: null });
  }, originalFetch);
  try {
    const result = await searchMessages({ query: '报价单', limit: 20, lifecycle: 'archived', groupBySession: true, includeReasoning: false });
    expect(requests[0]?.pathname).toBe('/api/openchamber/message-search/sessions');
    expect(requests[0]?.searchParams.get('lifecycle')).toBe('archived');
    expect(requests[0]?.searchParams.get('reasoning')).toBe('0');
    expect(result.status === 'ok' && result.hits[0]).toMatchObject({ id: 'message-a', directory: '/a', archived: true, matchCount: 3 });
  } finally { globalThis.fetch = originalFetch; }
});
