import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { constants } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import fixture from './testdata/completion-contract-v1.json';
import { createManagedWorkAdmission, createKnowledgeAuthorizationServer } from './managed-work.js';
const cleanups = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const decode = (token) => JSON.parse(Buffer.from(token.split('.')[2], 'base64url'));
async function setup(document = 'confirmed synthetic text') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-work-v2-')); cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'source'); await fs.mkdir(root); await fs.writeFile(path.join(root, 'fixture.txt'), document);
  let actor = { actingUserId: 'actor', billingAccountId: 'payer', authSession: 'login-one', expiresAt: Date.now() + 7_200_000 };
  const identity = { type: 'session', token: 'synthetic-local-session' }; const context = { directory: root };
  let sends = 0; let reranks = 0; let preflights = 0; let reads = 0; let unknown = false; let pin = '4'.repeat(64); let receiptPin = null;
  const route = (model = 'unihub-text-embedding-v4', wireOperation = 'embeddings.create') => ({ instanceId: 'default', actorId: actor.actingUserId, accountId: actor.billingAccountId, model, wireOperation, policyDigest: pin, routeGeneration: '6'.repeat(64), embeddingSpace: { provider: 'aliyun', model: 'text-embedding-v4', version: 'v4', dimensions: 1024, input_semantics: 'text' } });
  const bytes = Buffer.from(JSON.stringify({ object: 'list', model: 'text-embedding-v4', data: [{ index: 0, embedding: Array(1024).fill(0.1) }] }));
  const account = {
    actor: () => ({ ...actor }), instancePrincipal: () => ({ issuer: 'https://synthetic.invalid', userId: actor.actingUserId }),
    captureCommerceSession: () => ({ actingUserId: actor.actingUserId, billingAccountId: actor.billingAccountId, serviceId: 'service' }),
    preflightKnowledgeRoute: async (_identity, input) => { preflights++; return route(input.model, input.wireOperation); },
    readCurrentKnowledgeRoute: async (_identity, input) => { reads++; return route(input.model, input.wireOperation); },
    dispatchKnowledgeEmbeddingPinned: async (_identity, input) => { expect(JSON.parse(input.body)).toMatchObject({ model: 'unihub-text-embedding-v4', dimensions: 1024, encoding_format: 'float' }); sends++; if (unknown) throw new Error('unknown'); },
    dispatchKnowledgeRerankPinned: async () => { reranks++; },
    readKnowledgeResultWithEvidence: async (_identity, input) => ({ rawBytes: bytes, receipt: { ...route(input.model, input.wireOperation), policyDigest: receiptPin ?? pin, taskId: input.taskId, callId: input.callId, attemptId: 1, producerCredentialId: 'historical-producer', authorizedCredentialId: 'new-reader', contentSha256: sha(bytes) } }),
  };
  const dependencies = { dataDir: dir, enabled: () => true, authorizeOwner: (principal) => principal.userId === 'actor', getAccountRuntime: () => account,
    resolveNamespace: async (_identity, ctx) => { if (ctx?.directory !== root) throw new Error('bad scope'); return { projectId: 'project', spaceId: 'host', directory: root }; },
    resolveDocument: async (id) => ({ id, libraryId: 'library', root, relPath: 'fixture.txt', tenantId: 1, knowledgeBaseId: 'kb' }),
    resolveModelBinding: async (purpose) => ({ purpose, protocol: 'managed-media', providerId: 'unihub', model: purpose === 'embedding' ? 'unihub-text-embedding-v4' : 'qwen3-rerank', parameters: { dimensions: 1024 } }),
  };
  let work = createManagedWorkAdmission(dependencies);
  let callback = await createKnowledgeAuthorizationServer(work); cleanups.push(() => callback.close());
  await work.workerConfiguration(callback.url, callback.workerKeyFile);
  const callbackPost = async (suffix, fields, search = false) => {
    const nonce = crypto.randomBytes(32).toString('hex'); const body = JSON.stringify({ ...fields, nonce }); const seconds = String(Math.floor(Date.now() / 1000)); const url = new URL(callback.url.replace('/authorize', suffix).replace('/knowledge-work/', search ? '/knowledge-search/' : '/knowledge-work/'));
    const signature = crypto.createHmac('sha256', await fs.readFile(callback.workerKeyFile)).update(`weknora-callback-v2\nPOST\n${url.pathname}\n${sha(body)}\n${nonce}\n${seconds}`).digest('hex');
    return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-weknora-worker-signature': signature, 'x-weknora-worker-time': seconds }, body });
  };
  const reply = async (request, kind) => {
    const map = { storage: 'storage', discovery: 'discover', completion: 'use' }; const value = { ...fixture.replies[map[kind]], scope: request.scope, nonce: request.nonce, issued_at: request.scope.issued_at, expires_at: request.scope.expires_at };
    if (kind === 'discovery') { value.call_id = 'wk_' + 'a'.repeat(60); value.producer_credential_id = 'historical-producer'; value.attempt_id = '1'; value.index_revision = request.scope.binding.index_revision; }
    delete value.mac;
    const key = crypto.createHmac('sha256', await fs.readFile(callback.workerKeyFile)).update('managed-completion-response-v1').digest();
    value.mac = crypto.createHmac('sha256', key).update(JSON.stringify(value)).digest('hex');
    const raw = Buffer.from(JSON.stringify({ success: true, data: { [kind]: value } }));
    return work.acceptResponse(request.scope.work_id ?? request.scope.binding.work_id, request, raw);
  };
  const prepared = async () => {
    const prepared = await work.prepare(identity, 'doc', 'confirmed-import', context);
    await reply(await work.workerRequest(identity, prepared.workId, 'storage', context), 'storage');
    const ingest = await work.workerRequest(identity, prepared.workId, 'ingest', context);
    return { workId: prepared.workId, ingest };
  };
  return { dir, root, identity, context, account, get work() { return work; }, prepared, reply, callbackPost, counters: () => ({ sends, reranks, preflights, reads }),
    unknown: () => { unknown = true; }, switchActor: (value) => { actor = { ...actor, ...value }; }, drift: () => { pin = '9'.repeat(64); }, badReceipt: () => { receiptPin = '8'.repeat(64); },
    restart: async () => { await callback.close(); work = createManagedWorkAdmission(dependencies); callback = await createKnowledgeAuthorizationServer(work); await work.workerConfiguration(callback.url, callback.workerKeyFile); },
  };
}
const input = Buffer.from(JSON.stringify({ model: 'unihub-text-embedding-v4', input: ['fixture.txt\nconfirmed synthetic text'], dimensions: 1024 })).toString('base64');
const approvedSHA = '646f1958415b538106574a3ad57fcfc3dad30c93f248387bf21845a739bb6c6b';
const approvedTXT = async () => {
  const raw = await fs.readFile(process.env.SUPERWAGIE_APPROVED_TXT_FIXTURE || new URL('./testdata/approved-300-byte-acceptance.txt', import.meta.url));
  expect(raw.length).toBe(300); expect(sha(raw)).toBe(approvedSHA); expect(raw.toString()).not.toBe(raw.toString().trim()); return raw;
};
it('accepts the exact approved TXT with its raw snapshot, trimmed embedding and raw rerank', async () => {
  const raw = await approvedTXT(); const text = raw.toString(); const f = await setup(raw);
  await expect(f.work.prepare(f.identity, 'doc', 'wrong-sha', f.context, '0'.repeat(64))).rejects.toMatchObject({ code: 'knowledge_work_document_changed' });
  expect(f.counters().preflights).toBe(0);
  const { workId } = await f.prepared();
  const snapshot = await f.callbackPost('/snapshot', { work_id: workId }); expect(snapshot.status).toBe(200);
  const value = await snapshot.json(); expect(Buffer.from(value.content, 'base64')).toEqual(raw); expect(decode(value.assertion).content_sha256).toBe(approvedSHA);
  const fields = { work_id: workId, call_id: 'wk_' + 'a'.repeat(60) };
  const embedding = (content) => Buffer.from(JSON.stringify({ model: 'unihub-text-embedding-v4', input: [`fixture.txt\n${content}`], dimensions: 1024 })).toString('base64');
  expect((await f.callbackPost('/dispatch', { ...fields, content: embedding(text) })).status).toBe(403); expect(f.counters().sends).toBe(0);
  for (let attempt = 0; attempt < 2; attempt++) expect((await f.callbackPost('/dispatch', { ...fields, content: embedding(text.trim()) })).status).toBe(200);
  expect(f.counters().sends).toBe(1);
  await f.reply(await f.work.workerRequest(f.identity, workId, 'discover', f.context), 'discovery');
  const before = f.counters().preflights;
  await expect(f.work.prepareSearch(f.identity, workId, ' query ', 'invalid-query', f.context)).rejects.toMatchObject({ code: 'knowledge_work_request_invalid' });
  expect(f.counters().preflights).toBe(before);
  const search = await f.work.prepareSearch(f.identity, workId, 'query', 'explicit-search', f.context); await f.work.issueSearch(f.identity, search.workId, f.context);
  const rerank = (content) => Buffer.from(JSON.stringify({ model: 'qwen3-rerank', input: { query: 'query', documents: [content] }, parameters: { top_n: 1, return_documents: false } })).toString('base64');
  const query = { work_id: search.workId, call_id: 'wk_' + 'b'.repeat(60), operation: 'rerank' };
  expect((await f.callbackPost('/dispatch', { ...query, content: rerank(text.trim()) }, true)).status).toBe(403); expect(f.counters().reranks).toBe(0);
  for (let attempt = 0; attempt < 2; attempt++) expect((await f.callbackPost('/dispatch', { ...query, content: rerank(text) }, true)).status).toBe(200);
  expect(f.counters().reranks).toBe(1);
  await fs.writeFile(path.join(f.root, 'fixture.txt'), text.trim());
  expect((await f.callbackPost('/dispatch', { ...fields, content: embedding(text.trim()) })).status).toBe(403); expect(f.counters().sends).toBe(1);
});
it('rejects oversized, invalid or changed approved TXT bytes before preflight and dispatch', async () => {
  const raw = await approvedTXT(); const f = await setup();
  for (const invalid of [Buffer.concat([raw, Buffer.from('\n')]), Buffer.from([0xff]), Buffer.from('text🙂'), Buffer.from('text\t'), Buffer.from('text\r\n'), Buffer.from('text#heading'), Buffer.from(' \n\u3000')]) {
    await fs.writeFile(path.join(f.root, 'fixture.txt'), invalid);
    await expect(f.work.prepare(f.identity, 'doc', 'invalid-document', f.context)).rejects.toMatchObject({ code: 'knowledge_work_plan_unsupported' });
  }
  const changed = Buffer.from(raw); changed[0] = 88; await fs.writeFile(path.join(f.root, 'fixture.txt'), changed);
  await expect(f.work.prepare(f.identity, 'doc', 'changed-sha', f.context, approvedSHA)).rejects.toMatchObject({ code: 'knowledge_work_document_changed' });
  expect(f.counters().preflights).toBe(0); expect(f.counters().sends).toBe(0);
});
it('starts callbacks with no grant, signs exact requests, dispatches once and preserves same-response producer provenance', async () => {
  const f = await setup(); expect(f.counters().preflights).toBe(0);
  const { workId, ingest } = await f.prepared();
  expect(decode(ingest.proof).body_sha256).toBe(sha(ingest.body));
  expect(decode(JSON.parse(ingest.body).capability).storage_id).toBe('2'.repeat(64));
  const fields = { work_id: workId, call_id: 'wk_' + 'a'.repeat(60), content: input };
  expect((await f.callbackPost('/dispatch', fields)).status).toBe(200);
  expect((await f.callbackPost('/dispatch', fields)).status).toBe(200);
  expect(f.counters().sends).toBe(1);
  const response = await f.callbackPost('/result', { work_id: workId, call_id: fields.call_id });
  expect(response.status).toBe(200);
  const result = await response.json(); const claims = decode(result.assertion);
  expect(claims.producer_credential_id).toBe('historical-producer'); expect(claims.attempt_id).toBe('1'); expect(claims.content_sha256).toBe(sha(Buffer.from(result.content, 'base64')));
  f.badReceipt(); expect((await f.callbackPost('/result', { work_id: workId, call_id: fields.call_id })).status).toBe(403);
});
it('holds UNKNOWN without resending or accepting another call ID', async () => {
  const f = await setup(); const { workId } = await f.prepared(); f.unknown();
  const fields = { work_id: workId, call_id: 'wk_' + 'a'.repeat(60), content: input };
  expect((await f.callbackPost('/dispatch', fields)).status).toBe(403);
  expect((await f.callbackPost('/dispatch', fields)).status).toBe(200);
  expect((await f.callbackPost('/dispatch', { ...fields, call_id: 'wk_' + 'b'.repeat(60) })).status).toBe(403);
  expect(f.counters().sends).toBe(1);
});
it('discovers exact pending after restart and uses completion after ingest expiry with zero paid work', async () => {
  const f = await setup(); const { workId } = await f.prepared(); const before = f.counters();
  await f.restart();
  const realNow = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(realNow + 700_000);
  await f.reply(await f.work.workerRequest(f.identity, workId, 'storage', f.context), 'storage');
  await f.reply(await f.work.workerRequest(f.identity, workId, 'discover', f.context), 'discovery');
  await f.reply(await f.work.workerRequest(f.identity, workId, 'use', f.context), 'completion');
  expect(f.counters().preflights).toBe(before.preflights); expect(f.counters().sends).toBe(0);
  await expect(f.work.issue(f.identity, workId, f.context)).rejects.toMatchObject({ code: 'knowledge_work_expired' });
});
it('rejects current account switch, namespace injection, changed bytes and pin drift', async () => {
  const f = await setup(); const { workId } = await f.prepared();
  await expect(f.work.workerRequest(f.identity, workId, 'storage', { directory: '/other' })).rejects.toThrow();
  f.switchActor({ billingAccountId: 'other-payer', authSession: 'changed' });
  expect((await f.callbackPost('/dispatch', { work_id: workId, call_id: 'wk_' + 'a'.repeat(60), content: input })).status).toBe(403);
  f.switchActor({ billingAccountId: 'payer', authSession: 'login-one' }); f.drift();
  await expect(f.work.workerRequest(f.identity, workId, 'storage', f.context)).rejects.toMatchObject({ code: 'knowledge_work_space_unverified' });
  expect(f.counters().sends).toBe(0);
});
it('rejects missing persistent worker keys instead of recreating identity', async () => {
  const f = await setup(); await f.prepared();
  await fs.rm(path.join(f.dir, 'knowledge-managed-work', 'callback-v1.key'));
  await expect(f.restart()).rejects.toMatchObject({ code: 'knowledge_work_storage_unavailable' });
});

it('serializes concurrent admission completion writers while the first durable append is held', async () => {
  const f = await setup(); const { workId } = await f.prepared();
  const requests = await Promise.all(Array.from({ length: 4 }, () => f.work.workerRequest(f.identity, workId, 'discover', f.context)));
  let release; let reached; const held = new Promise((resolve) => { release = resolve; }); const atAppend = new Promise((resolve) => { reached = resolve; });
  const open = fs.open.bind(fs); let first = true;
  vi.spyOn(fs, 'open').mockImplementation(async (filename, flags, ...args) => {
    const handle = await open(filename, flags, ...args);
    if (String(filename).endsWith('completion-journal-v1') && flags === (constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW) && first) {
      first = false; reached(); await held;
    }
    return handle;
  });
  const initial = f.reply(requests[0], 'discovery'); await atAppend;
  const concurrent = requests.slice(1).map((request) => f.reply(request, 'discovery'));
  // A later completion may not finish while the prior append is held. Release
  // after the competing writer finishes on broken code, or a bounded deadline.
  await Promise.race([Promise.allSettled(concurrent), new Promise((resolve) => setTimeout(resolve, 100))]); release();
  const results = await Promise.allSettled([initial, ...concurrent]);
  const events = (await fs.readFile(path.join(f.dir, 'knowledge-managed-work/completion-journal-v1'), 'utf8')).trim().split('\n').map((line) => JSON.parse(JSON.parse(line).payload));
  expect(events.map((event) => [event.sequence, event.type])).toEqual([[1, 'ANCHOR'], [2, 'PENDING'], [3, 'COMMITTED']]);
  expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
  await expect(f.work.revisionState(f.identity, workId, f.context)).resolves.toMatchObject({ committed: true });
  expect(f.counters().sends).toBe(0);
});
