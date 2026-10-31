import searchFixture from './testdata/search-response-golden-v1.json';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import fixture from './testdata/completion-contract-v1.json';
import { createCompletionJournal, verifyCompletionReply, verifySearchReply, parseStrictJSON } from './managed-completion.js';
const dirs = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });
const raw = (kind, reply) => Buffer.from(JSON.stringify({ data: { [kind]: reply }, success: true }));
it('authenticates the frozen Go MAC vectors without hashing the transport wrapper', () => {
  const key = Buffer.from(fixture.signing.callback_key_fixture_only);
  for (const [name, kind] of [['storage', 'storage'], ['discover', 'discovery'], ['use', 'completion']]) {
    const reply = fixture.replies[name];
    expect(verifyCompletionReply(raw(kind, reply), kind, { scope: reply.scope, nonce: reply.nonce }, key, reply.issued_at * 1000)).toEqual(reply);
    const wrong = { ...reply, nonce: 'a'.repeat(64) };
    expect(() => verifyCompletionReply(raw(kind, wrong), kind, { scope: reply.scope, nonce: reply.nonce }, key, reply.issued_at * 1000)).toThrow();
    expect(() => verifyCompletionReply(raw(kind, reply), kind, { scope: reply.scope, nonce: reply.nonce }, key, reply.expires_at * 1000)).toThrow();
    const reordered = { ...reply }; delete reordered.version; reordered.version = reply.version;
    expect(() => verifyCompletionReply(raw(kind, reordered), kind, { scope: reply.scope, nonce: reply.nonce }, key, reply.issued_at * 1000)).toThrow();
    expect(() => verifyCompletionReply(Buffer.from(raw(kind, reply).toString().replace('"nonce":', '"nonce":"' + 'a'.repeat(64) + '","nonce":')), kind, { scope: reply.scope, nonce: reply.nonce }, key, reply.issued_at * 1000)).toThrow();
  }
});
it('recovers exact pending completion after a host restart and refuses partial restore', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-host-journal-')); dirs.push(dir);
  const key = crypto.randomBytes(32); const journal = createCompletionJournal(dir, key);
  await journal.anchor(fixture.replies.storage);
  const pending = { binding: fixture.binding, snapshotSHA256: fixture.discover.snapshot_sha256, namespaceTuple: ['synthetic'], documentId: 'doc' };
  await journal.pending(pending);
  const beforeCommit = await fs.readFile(path.join(dir, 'completion-journal-v1'));
  const restarted = createCompletionJournal(dir, key);
  expect((await restarted.load()).committed.size).toBe(0);
  await restarted.commit(fixture.binding.work_id, fixture.replies.discover);
  expect((await createCompletionJournal(dir, key).load()).committed.get(fixture.binding.work_id).completion.float32_sha256).toBe(fixture.replies.discover.float32_sha256);
  await fs.writeFile(path.join(dir, 'completion-journal-v1'), beforeCommit);
  await expect(createCompletionJournal(dir, key).load()).rejects.toThrow();
  await expect(createCompletionJournal(dir, crypto.randomBytes(32)).load()).rejects.toThrow();
  await fs.rm(path.join(dir, 'storage-anchor-v1'));
  await expect(createCompletionJournal(dir, key).load()).rejects.toThrow();
});

it('accepts exact authenticated Go escapes but rejects duplicate JSON keys at every depth', () => {
  expect(parseStrictJSON(Buffer.from('{"content":"\\u003cgo\\u003e"}'))).toEqual({ content: '<go>' });
  for (const input of ['{"a":1,"a":2}', '{"a":{"b":1,"\\u0062":2}}', '{"a":[{"b":1,"b":2}]}']) expect(() => parseStrictJSON(Buffer.from(input))).toThrow();
});

it('verifies the literal frozen worker search response and rejects tampering, scope drift and expiry', () => {
  const payload = JSON.parse(searchFixture.raw_payload_utf8);
  const key = Buffer.from(searchFixture.callback_key_fixture_only);
  const scope = { issuer: 'superwagie-knowledge-v1', audience: 'weknora', ...searchFixture.expected_scope, issued_at: payload.issued_at, expires_at: payload.expires_at };
  const proofPayload = { issuer: 'superwagie-knowledge-v1', audience: 'weknora', method: 'POST', path: '/api/v1/knowledge-bases/fixture-kb/managed-hybrid-search', body_sha256: 'a'.repeat(64), nonce: searchFixture.expected_nonce, work_id: scope.work_id, actor_id: scope.actor_id, account_id: scope.account_id, issued_at: payload.issued_at, expires_at: payload.expires_at };
  const request = { scope, nonce: searchFixture.expected_nonce, proof: `weknora-request-v1.host-v1.${Buffer.from(JSON.stringify(proofPayload)).toString('base64url')}.fixture` };
  const raw = Buffer.from(JSON.stringify(searchFixture.response));
  expect(verifySearchReply(raw, request, key, payload.worker_boot_id, payload.issued_at * 1000)).toEqual(JSON.parse(searchFixture.expected_result_json_utf8));
  const tampered = structuredClone(searchFixture.response); tampered.data.mac = '0'.repeat(64);
  expect(() => verifySearchReply(Buffer.from(JSON.stringify(tampered)), request, key, payload.worker_boot_id, payload.issued_at * 1000)).toThrow();
  expect(() => verifySearchReply(raw, { ...request, nonce: '0'.repeat(64) }, key, payload.worker_boot_id, payload.issued_at * 1000)).toThrow();
  expect(() => verifySearchReply(raw, request, key, '0'.repeat(64), payload.issued_at * 1000)).toThrow();
  expect(() => verifySearchReply(raw, request, key, payload.worker_boot_id, payload.expires_at * 1000)).toThrow();
  try {
    verifySearchReply(raw, { ...request, proof: 'malformed' }, key, payload.worker_boot_id, payload.issued_at * 1000);
    throw new Error('expected malformed proof to be rejected');
  } catch (error) {
    expect(error).toMatchObject({ code: 'knowledge_work_result_invalid', status: 503 });
  }
});
