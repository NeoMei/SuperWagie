import { describe, expect, test } from 'bun:test';
import { readConversationSegments, sanitizeMemoryText } from './reader.js';

const user = (id, created, text = 'Fix the failing parser') => ({ id, type: 'user', text, time: { created } });
const answer = (id, created, options = {}) => ({
  id, type: 'assistant', agent: 'build', model: { providerID: 'fixture', id: 'small' },
  content: [{ type: 'text', text: 'The parser now handles empty input.' }],
  finish: 'stop', time: { created, completed: created + 1 }, ...options,
});
const idle = (id, created, outcome = 'succeeded') => ({ id, type: 'idle', outcome, time: { created } });

function source(records, sessionPatch = {}) {
  const state = { records, session: { id: 's1', title: 'Parser work', location: { directory: '/repo' }, ...sessionPatch }, calls: [] };
  const client = {
    session: {
      get: async () => state.session,
      message: { get: async ({ messageID }) => {
        const record = state.records.find((entry) => entry.id === messageID);
        if (!record) throw Object.assign(new Error('Missing fixture message'), { _tag: 'MessageNotFoundError' });
        return record;
      } },
    },
    message: { list: async (query) => {
      state.calls.push(query);
      const start = query.cursor ? state.records.findIndex((entry) => `after:${entry.id}` === query.cursor) + 1 : 0;
      const data = state.records.slice(start, start + query.limit);
      return { data, cursor: { next: data.length ? `after:${data.at(-1).id}` : undefined } };
    } },
  };
  return { state, read: (options = {}) => readConversationSegments({ client, sessionId: 's1', directory: '/repo', projectId: 'p1', ...options }) };
}

describe('conversation source reader', () => {
  test('resumes bounded ascending pages and emits one stable source-backed turn', async () => {
    const fixture = source([user('u1', 1), answer('a1', 2), idle('i1', 4)]);
    const first = await fixture.read({ pageSize: 2, maxPages: 1 });
    expect(first.segments).toEqual([]);
    expect(first.complete).toBe(false);
    const second = await fixture.read({ checkpoint: first.checkpoint, pageSize: 2, maxPages: 1 });
    expect(second.complete).toBe(true);
    expect(second.segments).toHaveLength(1);
    expect(second.segments[0]).toMatchObject({ sessionId: 's1', projectId: 'p1', directory: '/repo', outcome: 'succeeded', messageIds: ['u1', 'a1', 'i1'] });
    expect(fixture.state.calls[0]).toMatchObject({ order: 'asc' });
    expect(fixture.state.calls[1]).toMatchObject({ cursor: 'after:a1' });
    const repeated = await fixture.read({ checkpoint: second.checkpoint });
    expect(repeated.segments).toEqual([]);
    const full = await fixture.read();
    expect(full.segments[0].id).toBe(second.segments[0].id);
    expect(full.segments[0].sourceHash).toBe(second.segments[0].sourceHash);
  });

  test('rereads an unfinished response after it settles without consuming its partial text', async () => {
    const unfinished = answer('a1', 2, { time: { created: 2 }, content: [{ type: 'text', text: 'unfinished' }] });
    const fixture = source([user('u1', 1), unfinished]);
    const before = await fixture.read();
    expect(before.segments).toEqual([]);
    expect(JSON.stringify(before.checkpoint)).not.toContain('unfinished');
    fixture.state.records = [user('u1', 1), answer('a1', 2), idle('i1', 4)];
    const after = await fixture.read({ checkpoint: before.checkpoint });
    expect(after.segments).toHaveLength(1);
    expect(after.segments[0].messages.map((message) => message.text).join('\n')).toContain('handles empty input');
  });

  test('retains failed and interrupted outcomes without interpreting idle as validation', async () => {
    const fixture = source([user('u1', 1), answer('a1', 2), idle('i1', 4, 'interrupted'), user('u2', 5), answer('a2', 6), idle('i2', 8, 'failed')]);
    expect((await fixture.read()).segments.map((segment) => segment.outcome)).toEqual(['interrupted', 'failed']);
  });

  test('includes only bounded tool result excerpts and preserves exact tool provenance', async () => {
    const fixture = source([user('u1', 1, 'Use token sk-fixture-abcdefghijklmnopqrstuvwxyz'), answer('a1', 2, { content: [
      { type: 'reasoning', text: 'private reasoning' },
      { type: 'text', text: 'Tests passed.' },
      { type: 'tool', id: 'part1', name: 'bash', executed: true, time: { created: 2, completed: 3 }, state: { status: 'completed', input: { command: 'do not store this' }, content: [{ type: 'text', text: '4 tests passed\nAuthorization: Bearer secret-fixture-value\n' + 'x'.repeat(6000) }] } },
    ] }), { id: 'synthetic1', type: 'synthetic', text: 'injected source', time: { created: 3 } }, idle('i1', 4)]);
    const [segment] = (await fixture.read()).segments;
    expect(segment.messages.find((message) => message.role === 'tool')).toMatchObject({ id: 'a1', partId: 'part1', tool: 'bash', status: 'completed' });
    expect(segment.messages.find((message) => message.role === 'tool').text.length).toBeLessThan(5000);
    const serialized = JSON.stringify(segment);
    expect(serialized).not.toContain('private reasoning');
    expect(serialized).not.toContain('injected source');
    expect(serialized).not.toContain('do not store this');
    expect(serialized).not.toContain('secret-fixture-value');
    expect(serialized).not.toContain('sk-fixture-abcdefghijklmnopqrstuvwxyz');
    expect(serialized).toContain('[redacted]');
  });

  test('resets after a revert and excludes its boundary even with equal timestamps', async () => {
    const fixture = source([user('u1', 1), answer('a1', 2), idle('i1', 4), user('u2', 4), answer('a2', 6), idle('i2', 8)]);
    const initial = await fixture.read();
    fixture.state.session.revert = { messageID: 'u2' };
    const reverted = await fixture.read({ checkpoint: initial.checkpoint });
    expect(reverted.reset).toBe(true);
    expect(reverted.segments).toHaveLength(1);
    expect(reverted.sourceMessageIds).toEqual(['u1', 'a1', 'i1']);
  });

  test('resets when an incremental source anchor was deleted', async () => {
    const fixture = source([user('u1', 1), answer('a1', 2), idle('i1', 4)]);
    const initial = await fixture.read();
    fixture.state.records = [user('u2', 5), answer('a2', 6), idle('i2', 8)];
    const changed = await fixture.read({ checkpoint: initial.checkpoint });
    expect(changed.reset).toBe(true);
    expect(changed.segments[0].messageIds).toEqual(['u2', 'a2', 'i2']);
  });

  test('does not capture child sessions or history before activation unless explicitly asked', async () => {
    const child = source([user('u1', 1), answer('a1', 2), idle('i1', 4)], { parentID: 'parent' });
    expect((await child.read()).segments).toEqual([]);
    expect(child.state.calls).toHaveLength(0);
    const fixture = source([user('u1', 1), answer('a1', 2), idle('i1', 4), user('u2', 5), answer('a2', 6), idle('i2', 8)]);
    expect((await fixture.read({ after: 6 })).segments.map((segment) => segment.messageIds[0])).toEqual(['u2']);
    expect((await fixture.read({ after: 6, includeHistory: true })).segments).toHaveLength(2);
  });

  test('fails visibly for malformed or failed pages and unreadable revert boundaries', async () => {
    const fixture = source([user('u1', 1), answer('a1', 2), idle('i1', 4)]);
    fixture.state.records = [{ id: 'broken', type: 'assistant', time: { created: 2 }, content: 'bad' }];
    await expect(fixture.read()).rejects.toMatchObject({ code: 'conversation_memory_source_invalid' });
    fixture.state.session.revert = { messageID: 'gone' };
    await expect(fixture.read()).rejects.toMatchObject({ code: 'conversation_memory_source_unavailable' });
  });

  test('keeps queued user instructions in the same settled execution', async () => {
    const fixture = source([user('u1', 1, 'Fix the parser'), user('u2', 2, 'Also preserve whitespace'), answer('a1', 3), idle('i1', 5)]);
    const [segment] = (await fixture.read()).segments;
    expect(segment.messageIds).toEqual(['u1', 'u2', 'a1', 'i1']);
    expect(segment.messages.filter((message) => message.role === 'user').map((message) => message.text)).toEqual(['Fix the parser', 'Also preserve whitespace']);
  });

  test('uses distinct immutable revision IDs when an anchor edit changes captured source', async () => {
    const fixture = source([user('u1', 1), answer('a1', 2), idle('i1', 4)]);
    const initial = await fixture.read();
    fixture.state.records[2] = idle('i1', 4, 'failed');
    const changed = await fixture.read({ checkpoint: initial.checkpoint });
    expect(changed.reset).toBe(true);
    expect(changed.segments[0].sourceHash).not.toBe(initial.segments[0].sourceHash);
    expect(changed.segments[0].id).not.toBe(initial.segments[0].id);
  });

  test('refuses a supplied project scope when the official session directory differs', async () => {
    const fixture = source([user('u1', 1), answer('a1', 2), idle('i1', 4)], { location: { directory: '/other-private-repo' } });
    await expect(fixture.read()).rejects.toMatchObject({ code: 'source_directory_changed' });
    expect(fixture.state.calls).toHaveLength(0);
  });

  test('does not expose partial settled results as a successful read after a later page fails', async () => {
    const fixture = source([user('u1', 1), answer('a1', 2), idle('i1', 4), user('u2', 5), answer('a2', 6), idle('i2', 8)]);
    const client = {
      session: { get: async () => fixture.state.session },
      message: { list: async ({ cursor }) => {
        if (cursor) throw new Error('source disconnected');
        return { data: fixture.state.records.slice(0, 3), cursor: { next: 'next' } };
      } },
    };
    await expect(readConversationSegments({ client, sessionId: 's1', directory: '/repo', projectId: 'p1', pageSize: 3 }))
      .rejects.toMatchObject({ code: 'conversation_memory_source_unavailable' });
  });

  test('omits file and network dumps while retaining bounded local verification result lines', async () => {
    const tool = (id, name, text) => ({ type: 'tool', id, name, executed: true, state: { status: 'completed', content: [{ type: 'text', text }] } });
    const fixture = source([user('u1', 1), answer('a1', 2, { content: [
      tool('read1', 'read', 'Private document text'), tool('fetch1', 'webfetch', 'Remote page text'),
      tool('bash1', 'bash', 'unrelated raw output\n4 tests passed\n0 tests failed'),
    ] }), idle('i1', 4)]);
    const [segment] = (await fixture.read()).segments;
    const tools = segment.messages.filter((message) => message.role === 'tool');
    expect(tools.map((message) => message.partId)).toEqual(['bash1']);
    expect(tools[0].text).toContain('4 tests passed');
    expect(JSON.stringify(segment)).not.toContain('unrelated raw output');
    expect(JSON.stringify(segment)).not.toContain('Private document text');
    expect(JSON.stringify(segment)).not.toContain('Remote page text');
  });

  test('removes access-bearing URL user information and named token assignments', () => {
    const text = sanitizeMemoryText('token=local-fixture-token\nhttps://single-fixture-token@example.test/?client_secret=fixture-secret&auth=fixture-auth');
    expect(text).not.toContain('local-fixture-token');
    expect(text).not.toContain('single-fixture-token');
    expect(text).not.toContain('fixture-secret');
    expect(text).not.toContain('fixture-auth');
  });

  test('rejects a revert staged during source paging rather than publishing a stale segment', async () => {
    const fixture = source([user('u1', 1), answer('a1', 2), idle('i1', 4)]);
    const client = {
      session: { get: async () => fixture.state.session },
      message: { list: async () => {
        fixture.state.session.revert = { messageID: 'u1' };
        return { data: fixture.state.records, cursor: { next: 'after:i1' } };
      } },
    };
    await expect(readConversationSegments({ client, sessionId: 's1', directory: '/repo', projectId: 'p1' }))
      .rejects.toMatchObject({ code: 'conversation_memory_source_changed' });
  });

  test('keeps a revert cutoff before the unread page instead of accumulating duplicate pending text', async () => {
    const fixture = source([user('u1', 1), answer('a1', 2), user('u2', 4)], { revert: { messageID: 'u2' } });
    const first = await fixture.read();
    const second = await fixture.read({ checkpoint: first.checkpoint });
    expect(first.segments).toEqual([]);
    expect(second.checkpoint).toEqual(first.checkpoint);
    expect(second.checkpoint.pending).toBeNull();
  });
});
