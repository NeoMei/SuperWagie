import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readConversationSource } from './source.js';

test('projects the authoritative v2 source and passes an abort deadline', async () => {
  let options;
  const client = { session: { get: async (input, request) => {
    options = request;
    expect(input).toEqual({ sessionID: 's1' });
    return { id: 's1', location: { directory: '/work/a' }, revert: { messageID: 'm2' } };
  } } };
  expect(await readConversationSource({ client, sessionId: 's1' })).toEqual({ directory: '/work/a', revertId: 'm2' });
  expect(options.signal).toBeInstanceOf(AbortSignal);
});

test('distinguishes an authoritative missing session from failed or malformed reads', async () => {
  const clientFor = (error) => ({ session: { get: async () => { throw error; } } });
  expect(await readConversationSource({ client: clientFor({ _tag: 'SessionNotFoundError' }), sessionId: 's1' })).toBeNull();
  await expect(readConversationSource({ client: clientFor(new Error('temporary failure')), sessionId: 's1' })).rejects.toThrow('temporary failure');
  await expect(readConversationSource({ client: { session: { get: async () => ({ id: 'other', location: { directory: '/work/a' } }) } }, sessionId: 's1' })).rejects.toThrow('Source session does not match');
  await expect(readConversationSource({ client: { session: { get: async () => ({}) } }, sessionId: 's1' })).rejects.toThrow();
});

test('detects a committed offline revert through the captured message anchor', async () => {
  const anchor = { id: 'idle1', time: { created: 2 }, type: 'idle', outcome: 'succeeded' };
  const checkpoint = { version: 1, sessionId: 's1', projectId: 'p1', directory: '/work/a', revertId: null,
    cursor: 'cursor1', anchorId: 'idle1', anchorHash: createHash('sha256').update(JSON.stringify(anchor)).digest('hex'), pending: null };
  let message = anchor;
  let unavailable = false;
  let deleted = false;
  const client = { session: {
    get: async () => ({ id: 's1', location: { directory: '/work/a' } }),
    message: { get: async () => {
      if (deleted) throw { _tag: 'MessageNotFoundError' };
      if (unavailable) throw new Error('temporary read failure');
      return message;
    } },
  } };
  expect(await readConversationSource({ client, sessionId: 's1', checkpoint })).toMatchObject({ anchorMatches: true, revertId: null });
  message = { ...anchor, outcome: 'interrupted' };
  expect(await readConversationSource({ client, sessionId: 's1', checkpoint })).toMatchObject({ anchorMatches: false });
  deleted = true;
  expect(await readConversationSource({ client, sessionId: 's1', checkpoint })).toMatchObject({ anchorMatches: false });
  deleted = false; unavailable = true;
  await expect(readConversationSource({ client, sessionId: 's1', checkpoint })).rejects.toThrow('temporary read failure');
});
