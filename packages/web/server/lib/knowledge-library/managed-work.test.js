import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';

import { createManagedWorkAdmission, createKnowledgeAuthorizationServer, registerManagedWorkRoutes } from './managed-work.js';
import { createKnowledgeLibraryRuntime } from './runtime.js';

async function signedCallback(callback, url, body, nonce = crypto.randomBytes(32).toString('hex'), timestamp = Math.floor(Date.now() / 1000)) {
  const payload = JSON.stringify({ ...body, nonce });
  const key = await fs.readFile(callback.workerKeyFile);
  const digest = crypto.createHash('sha256').update(payload).digest('hex');
  const signature = crypto.createHmac('sha256', key).update(`weknora-callback-v2\nPOST\n${new URL(url).pathname}\n${digest}\n${nonce}\n${timestamp}`).digest('hex');
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-weknora-worker-signature': signature, 'x-weknora-worker-time': String(timestamp) }, body: payload });
}

const fixtureEvidence = async (_identity, scope) => ({ ...scope, verified: true, model: 'unihub-text-embedding-v4', space: 'aliyun/text-embedding-v4/v4/1024/text', provider: 'aliyun', upstreamModel: 'text-embedding-v4', version: 'v4', dimensions: 1024, inputSemantics: 'text', policyDigest: scope.policyDigest ?? 'a'.repeat(64), expiresAt: Date.now() + 60_000 });

const dirs = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });

async function fixture({ filename = 'a.txt' } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-work-'));
  dirs.push(dir);
  const root = path.join(dir, 'files');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, filename), 'private document');
  let current = { actingUserId: 'alice', billingAccountId: 'payer-a', authSession: 'session-a', expiresAt: Date.now() + 60_000 };
  let embeddingBinding = { protocol: 'managed-media', providerId: 'unihub', purpose: 'embedding', model: 'unihub-text-embedding-v4', parameters: { dimensions: 1024 } };
  let evidenceOverride = {};
  let accounts = [{ id: 'payer-a', kind: 'personal', role: 'owner' }]; let sends = 0; let reranks = 0;
  const account = {
    actor: () => ({ ...current }),
    instancePrincipal: () => ({ issuer: 'https://authority.example', userId: current.actingUserId }),
    captureCommerceSession: () => ({ actingUserId: current.actingUserId, billingAccountId: current.billingAccountId, serviceId: 'service-a', request: async () => accounts }),
    readKnowledgeResult: async (_identity, { taskId, callId, model }) => {
      if (!taskId.startsWith('ktask_') || !['a', 'b', 'c'].some((v) => callId === 'wk_' + v.repeat(60)) || !['unihub-text-embedding-v4', 'qwen3-rerank'].includes(model)) throw new Error('unknown call');
      return Buffer.from(JSON.stringify({ model, data: [{ index: 0, embedding: [0.5] }], usage: { prompt_tokens: 1 } }));
    },
    dispatchKnowledgeEmbeddingPinned: async (_identity, { callId, policyDigest }) => {
      if (policyDigest !== 'a'.repeat(64)) throw new Error('unbound policy');
      if (!['a', 'b'].some((v) => callId === 'wk_' + v.repeat(60))) throw new Error('unexpected call');
      sends++;
    },
    dispatchKnowledgeRerank: async () => { reranks++; },
  };
  const runtime = createManagedWorkAdmission({
    dataDir: dir,
    enabled: () => true,
    authorizeOwner: (principal) => principal.issuer === 'https://authority.example' && principal.userId === 'alice',
    getAccountRuntime: () => account,
    verifyEmbeddingEvidence: async (identity, scope) => ({ ...await fixtureEvidence(identity, scope), ...evidenceOverride }),
    resolveDocument: async (id) => id === 'doc-1' ? { id, libraryId: 'library-1', relPath: filename, root, tenantId: 7, knowledgeBaseId: 'kb-1' } : null,
    resolveModelBinding: async (purpose) => purpose === 'embedding' ? embeddingBinding : ({ protocol: 'managed-media', providerId: 'unihub', purpose, model: 'qwen3-rerank' }),
  });
  const app = express();
  registerManagedWorkRoutes(app, { runtime, resolveIdentity: async (req) => ({ session: req.header('x-test-session') }), isRequestOriginAllowed: async (req) => req.header('origin') === 'https://app.example' });
  const send = (key = 'request-one') => request(app).post('/api/knowledge-library/documents/doc-1/managed-work').set('Origin', 'https://app.example').set('Idempotency-Key', key).set('x-test-session', 'alice').send({ confirmed: true });
  const restart = () => createManagedWorkAdmission({ dataDir: dir, enabled: () => true, authorizeOwner: (principal) => principal.issuer === 'https://authority.example' && principal.userId === 'alice', getAccountRuntime: () => account, verifyEmbeddingEvidence: fixtureEvidence, resolveDocument: async (id) => id === 'doc-1' ? { id, libraryId: 'library-1', relPath: filename, root, tenantId: 7, knowledgeBaseId: 'kb-1' } : null, resolveModelBinding: async () => ({ protocol: 'managed-media', providerId: 'unihub', purpose: 'embedding', model: 'unihub-text-embedding-v4' }) });
  return { dir, root, runtime, app, send, restart, sends: () => sends, reranks: () => reranks, changeActor: (v) => { current = { ...current, ...v }; }, changeAccounts: (v) => { accounts = v; }, changeEmbedding: (v) => { embeddingBinding = v; }, changeEvidence: (v) => { evidenceOverride = v; } };
}

describe('managed knowledge work preparation', () => {
  it('rejects route drift, semantic mismatch and unbound result receipts', async () => {
    const f = await fixture();
    f.changeEvidence({ inputSemantics: 'text/query-document-v1' });
    await f.send('wrong-semantics').expect(503);
    f.changeEvidence({});
    const { body: { workId } } = await f.send('proof').expect(201);
    const identity = { session: 'alice' }; const nonce = 'f'.repeat(64); const callId = 'wk_' + 'a'.repeat(60);
    await f.runtime.issue(identity, workId);
    f.changeEvidence({ policyDigest: 'b'.repeat(64) });
    await expect(f.runtime.dispatch(workId, nonce, callId, Buffer.from(JSON.stringify({ model: 'unihub-text-embedding-v4', input: ['a.txt\nprivate document'] })).toString('base64'))).rejects.toMatchObject({ code: 'knowledge_work_space_unverified' });
    expect(f.sends()).toBe(0);
    f.changeEvidence({});
    await f.runtime.dispatch(workId, nonce, callId, Buffer.from(JSON.stringify({ model: 'unihub-text-embedding-v4', input: ['a.txt\nprivate document'] })).toString('base64'));
    f.changeEvidence({ contentSHA256: '0'.repeat(64) });
    await expect(f.runtime.result(workId, nonce, callId)).rejects.toMatchObject({ code: 'knowledge_work_space_unverified' });
    f.changeEvidence({});
    await expect(f.runtime.result(workId, nonce, callId)).resolves.toHaveProperty('assertion');
  });
  it('rechecks the indexed policy and receipt during search and recovery', async () => {
    const f = await fixture();
    const { body: { workId } } = await f.send('search-evidence').expect(201);
    const identity = { session: 'alice' }; const nonce = 'e'.repeat(64);
    const callId = 'wk_' + 'a'.repeat(60);
    await f.runtime.issue(identity, workId);
    await f.runtime.dispatch(workId, nonce, callId, Buffer.from(JSON.stringify({ model: 'unihub-text-embedding-v4', input: ['a.txt\nprivate document'] })).toString('base64'));
    const search = await f.runtime.prepareSearch(identity, workId, 'private', 'search-evidence');
    await f.runtime.issueSearch(identity, search.workId);
    const queryCall = 'wk_' + 'b'.repeat(60);
    const queryBody = Buffer.from(JSON.stringify({ model: 'unihub-text-embedding-v4', input: ['private'] })).toString('base64');
    await f.runtime.dispatchSearch(search.workId, nonce, queryCall, 'embedding', queryBody);
    f.changeEvidence({ contentSHA256: '0'.repeat(64) });
    await expect(f.runtime.searchResult(search.workId, nonce, queryCall, 'embedding')).rejects.toMatchObject({ code: 'knowledge_work_space_unverified' });
    f.changeEvidence({ policyDigest: 'b'.repeat(64) });
    await expect(f.runtime.issueSearch(identity, search.workId)).rejects.toMatchObject({ code: 'knowledge_work_space_unverified' });
    f.changeEvidence({});
    await expect(f.runtime.searchResult(search.workId, nonce, queryCall, 'embedding')).resolves.toHaveProperty('assertion');
  });
  it('rejects uncertified aliases and dimensions before dispatch and after preparation', async () => {
    const f = await fixture();
    f.changeEmbedding({ protocol: 'managed-media', providerId: 'unihub', purpose: 'embedding', model: 'text-embedding-v4', parameters: { dimensions: 1024 } });
    await f.send('legacy').expect(503);
    f.changeEmbedding({ protocol: 'managed-media', providerId: 'unihub', purpose: 'embedding', model: 'unihub-text-embedding-v4', parameters: { dimensions: 512 } });
    await f.send('wrong-dimension').expect(503);
    f.changeEmbedding({ protocol: 'managed-media', providerId: 'unihub', purpose: 'embedding', model: 'unihub-text-embedding-v4', parameters: { dimensions: 1024 } });
    const { body: { workId } } = await f.send('valid').expect(201);
    await f.runtime.issue({ session: 'alice' }, workId);
    const invalidDimensions = Buffer.from(JSON.stringify({ model: 'unihub-text-embedding-v4', dimensions: 512, input: ['a.txt\nprivate document'] })).toString('base64');
    await expect(f.runtime.dispatch(workId, 'f'.repeat(64), 'wk_' + 'a'.repeat(60), invalidDimensions)).rejects.toMatchObject({ code: 'knowledge_work_plan_unsupported' });
    f.changeEmbedding({ protocol: 'managed-media', providerId: 'unihub', purpose: 'embedding', model: 'unihub-text-embedding-v4', parameters: { dimensions: 512 } });
    await expect(f.runtime.issue({ session: 'alice' }, workId)).rejects.toMatchObject({ code: 'knowledge_work_model_unavailable' });
    expect(f.sends()).toBe(0);
  });
  it('does not infer a space for an older work record', async () => {
    const f = await fixture();
    const { body: { workId } } = await f.send('old-record').expect(201);
    const directory = path.join(f.dir, 'knowledge-managed-work');
    const key = await fs.readFile(path.join(directory, 'key-v1'));
    const file = path.join(directory, workId);
    const raw = await fs.readFile(file);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(workId)); decipher.setAuthTag(raw.subarray(12, 28));
    const old = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
    delete old.embeddingSpace;
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(Buffer.from(workId));
    const body = Buffer.concat([cipher.update(JSON.stringify(old)), cipher.final()]);
    await fs.writeFile(file, Buffer.concat([nonce, cipher.getAuthTag(), body]));
    await expect(f.runtime.issue({ session: 'alice' }, workId)).rejects.toMatchObject({ code: 'knowledge_work_model_unavailable' });
    expect(f.sends()).toBe(0);
  });
  it('binds a separate search to the confirmed query and indexed document and never re-dispatches calls', async () => {
    const f = await fixture();
    const { body: { workId } } = await f.send().expect(201);
    const nonce = 'f'.repeat(64);
    const index = await f.runtime.issue({ session: 'alice' }, workId);
    const indexClaims = JSON.parse(Buffer.from(index.token.split('.')[2], 'base64url').toString());
    expect(indexClaims).toMatchObject({ embedding_model: 'unihub-text-embedding-v4', embedding_space: 'aliyun/text-embedding-v4/v4/1024/text' });
    await f.runtime.dispatch(workId, nonce, 'wk_' + 'a'.repeat(60), Buffer.from(JSON.stringify({ model: 'unihub-text-embedding-v4', input: ['a.txt\nprivate document'] })).toString('base64'));
    const search = await f.runtime.prepareSearch({ session: 'alice' }, workId, 'private', 'query-one');
    const grant = await f.runtime.issueSearch({ session: 'alice' }, search.workId);
    expect(grant.token).toMatch(/^weknora-search-v1\.host-v1\./);
    const searchClaims = JSON.parse(Buffer.from(grant.token.split('.')[2], 'base64url').toString());
    expect(searchClaims).toMatchObject({ embedding_model: 'unihub-text-embedding-v4', embedding_space: 'aliyun/text-embedding-v4/v4/1024/text' });
    const request = await f.runtime.workerRequest({ session: 'alice' }, search.workId, 'search');
    const parts = request.proof.split('.');
    const proof = JSON.parse(Buffer.from(parts[2], 'base64url').toString());
    const { createPublicKey, verify } = await import('node:crypto');
    const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from((await f.runtime.issue({ session: 'alice' }, workId)).publicKey, 'base64url')]), format: 'der', type: 'spki' });
    expect(verify(null, Buffer.from(parts.slice(0, 3).join('.')), publicKey, Buffer.from(parts[3], 'base64url'))).toBe(true);
    expect(proof).toMatchObject({ method: 'POST', path: request.path, work_id: search.workId, actor_id: 'alice', account_id: 'payer-a' });
    expect(proof.body_sha256).toBe((await import('node:crypto')).createHash('sha256').update(request.body).digest('hex'));
    expect(proof.expires_at - proof.issued_at).toBeLessThanOrEqual(30);
    expect((await f.runtime.workerRequest({ session: 'alice' }, search.workId, 'search')).proof).not.toBe(request.proof);
    const snapshot = await f.runtime.searchSnapshot(search.workId, nonce);
    expect(Buffer.from(snapshot.content, 'base64').toString()).toBe('private');
    const status = await f.runtime.workerRequest({ session: 'alice' }, workId, 'status');
    expect(status.path).toBe('/api/v1/knowledge-bases/kb-1/knowledge/managed-status');
    expect(JSON.parse(status.body)).toHaveProperty('capability');
    expect((await f.runtime.workerRequest({ session: 'alice' }, workId, 'status')).proof).not.toBe(status.proof);
    const callback = await createKnowledgeAuthorizationServer(f.runtime);
    try {
      const unauthorized = await fetch(callback.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ work_id: workId, nonce }) });
      expect(unauthorized.status).toBe(403);
      const sameNonce = crypto.randomBytes(32).toString('hex');
      expect((await signedCallback(callback, callback.url, { work_id: workId }, sameNonce)).status).toBe(200);
      expect((await signedCallback(callback, callback.url, { work_id: workId }, sameNonce)).status).toBe(403);
      const forged = await fetch(callback.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-weknora-worker-signature': '0'.repeat(64) }, body: JSON.stringify({ work_id: workId, nonce: crypto.randomBytes(32).toString('hex') }) });
      expect(forged.status).toBe(403);
      const key = await fs.readFile(callback.workerKeyFile);
      const tamperNonce = crypto.randomBytes(32).toString('hex');
      const original = JSON.stringify({ work_id: workId, nonce: tamperNonce });
      const timestamp = Math.floor(Date.now() / 1000);
      const hash = crypto.createHash('sha256').update(original).digest('hex');
      const signature = crypto.createHmac('sha256', key).update(`weknora-callback-v2\nPOST\n${new URL(callback.url).pathname}\n${hash}\n${tamperNonce}\n${timestamp}`).digest('hex');
      const tampered = await fetch(callback.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-weknora-worker-signature': signature, 'x-weknora-worker-time': String(timestamp) }, body: original + ' ' });
      expect(tampered.status).toBe(403);
      const moved = await fetch(callback.url.replace('/authorize', '/snapshot'), { method: 'POST', headers: { 'content-type': 'application/json', 'x-weknora-worker-signature': signature, 'x-weknora-worker-time': String(timestamp) }, body: original });
      expect(moved.status).toBe(403);
      expect((await fs.stat(callback.workerKeyFile)).mode & 0o077).toBe(0);
      expect((await fs.stat(path.dirname(callback.workerKeyFile))).mode & 0o077).toBe(0);
      const searchURL = callback.url.replace('/knowledge-work/authorize', '/knowledge-search/snapshot');
      const response = await signedCallback(callback, searchURL, { work_id: search.workId });
      expect(response.status).toBe(200);
      expect((await response.json()).assertion).toMatch(/^weknora-search-snapshot-v1\.host-v1\./);
      const injected = await signedCallback(callback, searchURL, { work_id: search.workId, query: 'other' });
      expect(injected.status).toBe(400);
    } finally { await callback.close(); }
    const embedding = Buffer.from(JSON.stringify({ model: 'unihub-text-embedding-v4', input: ['private'] })).toString('base64');
    const rerank = Buffer.from(JSON.stringify({ model: 'qwen3-rerank', input: { query: 'private', documents: ['a.txt\n\nprivate document'] }, parameters: { top_n: 1, return_documents: false } })).toString('base64');
    await f.runtime.dispatchSearch(search.workId, nonce, 'wk_' + 'b'.repeat(60), 'embedding', embedding);
    await f.runtime.dispatchSearch(search.workId, nonce, 'wk_' + 'b'.repeat(60), 'embedding', embedding);
    await f.runtime.dispatchSearch(search.workId, nonce, 'wk_' + 'c'.repeat(60), 'rerank', rerank);
    expect(f.sends()).toBe(2); expect(f.reranks()).toBe(1);
    const result = await f.runtime.searchResult(search.workId, nonce, 'wk_' + 'c'.repeat(60), 'rerank');
    expect(result.assertion).toMatch(/^weknora-search-result-v1\.host-v1\./);
    await expect(f.runtime.dispatchSearch(search.workId, nonce, 'wk_' + 'c'.repeat(60), 'rerank', Buffer.from(JSON.stringify({ model: 'qwen3-rerank', input: { query: 'private', documents: ['other'] }, parameters: { top_n: 1, return_documents: false } })).toString('base64'))).rejects.toMatchObject({ status: 409 });
    f.changeAccounts([]);
    await expect(f.runtime.searchSnapshot(search.workId, nonce)).rejects.toMatchObject({ status: 403 });
  });
  it('binds a confirmed work item to the current central actor and payer without persisting file content or credentials', async () => {
    const f = await fixture();
    const result = await f.send().expect(201);
    expect(result.body.status).toBe('prepared');
    expect(result.body.dispatchable).toBe(false);
    expect(result.body.workId).toMatch(/^kbw_[a-f0-9]{64}$/);
    expect((await f.send().expect(201)).body.workId).toBe(result.body.workId);
    expect((await f.restart().prepare({ session: 'alice' }, 'doc-1', 'request-one')).workId).toBe(result.body.workId);
    const files = await fs.readdir(path.join(f.dir, 'knowledge-managed-work'));
    const stored = await Promise.all(files.map((name) => fs.readFile(path.join(f.dir, 'knowledge-managed-work', name))));
    const text = Buffer.concat(stored).toString('utf8');
    expect(text).not.toContain('private document');
    expect(text).not.toContain('session-a');
    expect(text).not.toContain('payer-a');
    expect(text).not.toContain('alice');
    f.changeActor({ actingUserId: 'bob', authSession: 'session-b' });
    await f.send().expect(403);
  });
  it('refuses the same idempotency key after switching the payer', async () => {
    const f = await fixture();
    await f.send().expect(201);
    f.changeActor({ billingAccountId: 'payer-b', authSession: 'session-b' });
    f.changeAccounts([{ id: 'payer-b', kind: 'team', role: 'member' }]);
    await f.send().expect(409);
  });
  it('issues a short-lived signed capability only after current user and file are rechecked', async () => {
    const { createPublicKey, verify } = await import('node:crypto');
    const f = await fixture();
    const prepared = await f.send().expect(201);
    const grant = await f.runtime.issue({ session: 'alice' }, prepared.body.workId);
    const parts = grant.token.split('.');
    expect(parts.slice(0, 2)).toEqual(['weknora-cap-v1', 'host-v1']);
    const pub = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(grant.publicKey, 'base64url')]), format: 'der', type: 'spki' });
    expect(verify(null, Buffer.from(parts.slice(0, 3).join('.')), pub, Buffer.from(parts[3], 'base64url'))).toBe(true);
    const claims = JSON.parse(Buffer.from(parts[2], 'base64url').toString());
    expect(claims).toMatchObject({ issuer: 'superwagie-knowledge-v1', audience: 'weknora', tenant_id: 7, actor_id: 'alice', account_id: 'payer-a', knowledge_base_id: 'kb-1', purpose: 'document-ingest', work_id: prepared.body.workId });
    expect(claims.expires_at - claims.issued_at).toBeLessThanOrEqual(600);
    expect(claims.input_digest).not.toBe((await import('node:crypto')).createHash('sha256').update('private document').digest('hex'));
    const nonce = 'a'.repeat(64);
    const assertion = await f.runtime.authorize(prepared.body.workId, nonce);
    const assertionParts = assertion.split('.');
    expect(assertionParts.slice(0, 2)).toEqual(['weknora-auth-v1', 'host-v1']);
    expect(verify(null, Buffer.from(assertionParts.slice(0, 3).join('.')), pub, Buffer.from(assertionParts[3], 'base64url'))).toBe(true);
    const assertionClaims = JSON.parse(Buffer.from(assertionParts[2], 'base64url').toString());
    expect(assertionClaims).toMatchObject({ nonce, work_id: claims.work_id, actor_id: claims.actor_id, account_id: claims.account_id, knowledge_id: claims.knowledge_id, input_digest: claims.input_digest });
    expect(assertionClaims.expires_at - assertionClaims.issued_at).toBeLessThanOrEqual(30);
    const callback = await createKnowledgeAuthorizationServer(f.runtime);
    try {
      const config = await f.runtime.pilotConfiguration(callback.url, callback.workerKeyFile);
      expect(config).toMatchObject({ WEKNORA_MANAGED_KNOWLEDGE_PILOT: '1', WEKNORA_MANAGED_KNOWLEDGE_AUTH_URL: callback.url, WEKNORA_MANAGED_KNOWLEDGE_PUBLIC_KEY: Buffer.from(grant.publicKey, 'base64url').toString('base64') });
      for (const field of ['WEKNORA_MANAGED_JOURNAL_KEY_FILE', 'WEKNORA_MANAGED_CALL_KEY_FILE', 'WEKNORA_MANAGED_BINDING_KEY_FILE']) {
        const info = await fs.stat(config[field]);
        expect(info.size).toBe(32);
        expect(info.mode & 0o077).toBe(0);
      }
      expect(new Set(await Promise.all(['WEKNORA_MANAGED_JOURNAL_KEY_FILE', 'WEKNORA_MANAGED_CALL_KEY_FILE', 'WEKNORA_MANAGED_BINDING_KEY_FILE'].map((field) => fs.readFile(config[field], 'hex')))).size).toBe(3);
      const response = await signedCallback(callback, callback.url, { work_id: prepared.body.workId });
      expect(response.status).toBe(200);
      expect((await response.json()).assertion).toMatch(/^weknora-auth-v1\.host-v1\./);
      const invalid = await signedCallback(callback, callback.url, { work_id: prepared.body.workId, actor_id: 'someone-else' });
      expect(invalid.status).toBe(400);
      const snapshotURL = callback.url.replace('/authorize', '/snapshot');
      const snapshotResponse = await signedCallback(callback, snapshotURL, { work_id: prepared.body.workId });
      expect(snapshotResponse.status).toBe(200);
      const snapshot = await snapshotResponse.json();
      const snapshotParts = snapshot.assertion.split('.');
      expect(snapshotParts.slice(0, 2)).toEqual(['weknora-snapshot-v1', 'host-v1']);
      expect(verify(null, Buffer.from(snapshotParts.slice(0, 3).join('.')), pub, Buffer.from(snapshotParts[3], 'base64url'))).toBe(true);
      const snapClaims = JSON.parse(Buffer.from(snapshotParts[2], 'base64url').toString());
      const bytes = Buffer.from(snapshot.content, 'base64');
      expect(bytes.toString()).toBe('private document');
      expect(snapClaims).toMatchObject({ work_id: claims.work_id, actor_id: claims.actor_id, account_id: claims.account_id, knowledge_id: claims.knowledge_id });
      expect(snapClaims.content_sha256).toBe((await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'));
      const resultURL = callback.url.replace('/authorize', '/result');
      const dispatchURL = callback.url.replace('/authorize', '/dispatch');
      const callId = 'wk_' + 'a'.repeat(60);
      const body = Buffer.from(JSON.stringify({ model: 'unihub-text-embedding-v4', input: ['a.txt\nprivate document'] })).toString('base64');
      const dispatched = await signedCallback(callback, dispatchURL, { work_id: prepared.body.workId, call_id: callId, content: body });
      expect(dispatched.status).toBe(200);
      const replay = await signedCallback(callback, dispatchURL, { work_id: prepared.body.workId, call_id: callId, content: body });
      expect(replay.status).toBe(200);
      expect(f.sends()).toBe(1);
      const resultResponse = await signedCallback(callback, resultURL, { work_id: prepared.body.workId, call_id: callId });
      expect(resultResponse.status).toBe(200);
      const result = await resultResponse.json();
      const resultParts = result.assertion.split('.');
      expect(resultParts.slice(0, 2)).toEqual(['weknora-result-v1', 'host-v1']);
      expect(verify(null, Buffer.from(resultParts.slice(0, 3).join('.')), pub, Buffer.from(resultParts[3], 'base64url'))).toBe(true);
      const resultClaims = JSON.parse(Buffer.from(resultParts[2], 'base64url').toString());
      expect(resultClaims).toMatchObject({ work_id: claims.work_id, actor_id: claims.actor_id, account_id: claims.account_id, task_id: claims.task_id, call_id: callId, model: 'unihub-text-embedding-v4', operation: 'embedding', wire_operation: 'embeddings.create', status: 'SETTLED' });
      expect(resultClaims.content_sha256).toBe((await import('node:crypto')).createHash('sha256').update(Buffer.from(result.content, 'base64')).digest('hex'));
      const unknown = await signedCallback(callback, resultURL, { work_id: prepared.body.workId, call_id: 'unknown' });
      expect(unknown.status).toBe(403);
    } finally { await callback.close(); }
    await expect(f.runtime.authorize(prepared.body.workId, 'short')).rejects.toMatchObject({ status: 400 });
    f.changeActor({ actingUserId: 'bob', authSession: 'session-b' });
    await expect(f.runtime.authorize(prepared.body.workId, nonce)).rejects.toMatchObject({ status: 403 });
    await expect(f.runtime.issue({ session: 'bob' }, prepared.body.workId)).rejects.toMatchObject({ status: 403 });
    f.changeActor({ actingUserId: 'alice', authSession: 'session-a' });
    await fs.writeFile(path.join(f.root, 'a.txt'), 'changed after confirmation');
    await expect(f.runtime.issue({ session: 'alice' }, prepared.body.workId)).rejects.toMatchObject({ status: 409 });
  });
  it('preserves the work ID after the work record is restored from an older backup when the original key survives', async () => {
    const f = await fixture();
    const result = await f.send().expect(201);
    await fs.rm(path.join(f.dir, 'knowledge-managed-work', result.body.workId));
    expect((await f.restart().prepare({ session: 'alice' }, 'doc-1', 'request-one')).workId).toBe(result.body.workId);
  });
  it('fails closed if the encryption key is lost while work records remain', async () => {
    const f = await fixture();
    await f.send().expect(201);
    await fs.rm(path.join(f.dir, 'knowledge-managed-work', 'key-v1'));
    await f.send('new-request').expect(503);
  });
  it('fails closed on changed content, missing payer membership and path escape', async () => {
    const f = await fixture();
    await f.send().expect(201);
    await fs.writeFile(path.join(f.root, 'a.txt'), 'changed');
    await f.send().expect(409);
    f.changeAccounts([]);
    await f.send('other').expect(403);
    f.changeAccounts([{ id: 'payer-a', kind: 'personal', role: 'owner' }]);
    await fs.rm(path.join(f.root, 'a.txt'));
    await fs.symlink(path.join(f.dir, 'secret.txt'), path.join(f.root, 'a.txt'));
    await fs.writeFile(path.join(f.dir, 'secret.txt'), 'outside');
    await f.send('escape').expect(409);
  });
  it('requires explicit confirmation and origin before touching work records', async () => {
    const f = await fixture();
    await request(f.app).post('/api/knowledge-library/documents/doc-1/managed-work').set('Origin', 'https://app.example').set('Idempotency-Key', 'one').send({ confirmed: false }).expect(400);
    await request(f.app).post('/api/knowledge-library/documents/doc-1/managed-work').set('Origin', 'https://other.example').set('Idempotency-Key', 'one').send({ confirmed: true }).expect(403);
    await expect(fs.stat(path.join(f.dir, 'knowledge-managed-work'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('resolves source document IDs from the real library ledger only', async () => {
    const f = await fixture();
    const ledger = path.join(f.dir, 'knowledge-library');
    await fs.mkdir(ledger);
    await fs.writeFile(path.join(ledger, 'libraries.json'), JSON.stringify({ version: 1, libraries: [{ id: 'library-1', root: f.root, enabled: true }] }));
    await fs.writeFile(path.join(ledger, 'documents.json'), JSON.stringify({ version: 1, documents: { 'doc-1': { id: 'doc-1', libraryId: 'library-1', relPath: 'a.txt', state: 'queued' } } }));
    const library = createKnowledgeLibraryRuntime({ dataDir: f.dir, readSettings: async () => ({ embeddedKnowledgeTenantId: 7, embeddedKnowledgeBaseId: 'kb-1' }) });
    expect(await library.managedWorkDocument('doc-1')).toEqual({ id: 'doc-1', libraryId: 'library-1', relPath: 'a.txt', root: f.root, tenantId: 7, knowledgeBaseId: 'kb-1', knowledgeId: null });
    expect(await library.managedWorkDocument('../secret')).toBeNull();
    await fs.writeFile(path.join(ledger, 'libraries.json'), JSON.stringify({ version: 1, libraries: [{ id: 'library-1', root: f.root, enabled: false }] }));
    expect(await library.managedWorkDocument('doc-1')).toBeNull();
  });
});

it('uses the real platform account session and checks current central membership before preparing', async () => {
  const { default: http } = await import('node:http');
  const { createHash } = await import('node:crypto');
  const { exportJWK, generateKeyPair, SignJWT } = await import('jose');
  const { createPlatformAccountRuntime } = await import('../platform-account/runtime.js');
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'fixture', alg: 'RS256' };
  const hub = express(); hub.use(express.json());
  const server = http.createServer(hub);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let authorization; let accessToken; let membership = true;
  hub.get('/.well-known/openid-configuration', (_req, res) => res.json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, jwks_uri: `${origin}/keys` }));
  hub.get('/keys', (_req, res) => res.json({ keys: [jwk] }));
  hub.post('/v1/identity/authorize/password', (req, res) => { authorization = req.body; res.json({ authorization_id: 'A'.repeat(43), code: 'a'.repeat(64), state: authorization.state }); });
  hub.post('/v1/identity/token', async (req, res) => {
    expect(createHash('sha256').update(req.body.code_verifier).digest('base64url')).toBe(authorization.code_challenge);
    accessToken = await new SignJWT({ tokenType: 'access-token', scope: 'openid profile email' }).setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).setIssuer(origin).setSubject('subject-a').setAudience('headless-test').setIssuedAt().setExpirationTime('1h').sign(privateKey);
    const idToken = await new SignJWT({ tokenType: 'id-token', nonce: authorization.nonce }).setProtectedHeader({ alg: 'RS256', kid: 'fixture' }).setIssuer(origin).setSubject('subject-a').setAudience('headless-test').setIssuedAt().setExpirationTime('1h').sign(privateKey);
    res.json({ access_token: accessToken, id_token: idToken, token_type: 'Bearer', scope: 'openid profile email', expires_in: 3600 });
  });
  hub.use('/v1', (req, res, next) => req.get('Authorization') === `Bearer ${accessToken}` ? next() : res.status(401).json({ error: 'unauthenticated' }));
  hub.get('/v1/me', (_req, res) => res.json({ id: 'actor-a', name: 'Alice', email: '' }));
  hub.get('/v1/accounts', (_req, res) => res.json(membership ? [{ id: 'personal-a', kind: 'personal', name: 'Alice', role: 'owner' }] : []));
  hub.get('/v1/accounts/:id/subscriptions', (_req, res) => res.json([]));
  hub.get('/v1/accounts/:id/credits', (_req, res) => res.json([]));
  hub.post('/v1/accounts/:id/model-credentials', (req, res) => res.status(201).json({ id: 'credential-test', token: 'model-test-secret', actor_id: 'actor-a', account_id: req.params.id, origin_product_id: 'superwagie', task_id: req.body.task_id, models: req.body.models, expires_at: new Date(Date.now() + 60_000).toISOString() }));
  let supplierCalls = 0;
  hub.post('/platform/v1/embeddings', (req, res) => {
    expect(req.get('Authorization')).toBe('Bearer model-test-secret');
    expect(req.get('X-UniHub-Actor-Authorization')).toBeUndefined();
    expect(req.get('Idempotency-Key')).toBe('wk_' + 'b'.repeat(60));
    supplierCalls++;
    res.json({ ok: true });
  });
  hub.post('/platform/api/v1/services/rerank/text-rerank/text-rerank', (req, res) => {
    expect(req.get('Authorization')).toBe('Bearer model-test-secret');
    expect(req.get('X-UniHub-Actor-Authorization')).toBeUndefined();
    expect(req.get('Idempotency-Key')).toBe('wk_' + 'c'.repeat(60));
    supplierCalls++;
    res.json({ ok: true });
  });
  hub.post('/platform/v1/knowledge/results/:id', (req, res) => {
    expect(req.get('Authorization')).toBe('Bearer model-test-secret');
    expect(req.get('X-UniHub-Actor-Authorization')).toBe(`Bearer ${accessToken}`);
    expect(req.get('X-UniHub-Task-ID')).toBe('task-1');
    res.set('Cache-Control', 'no-store').json({ model: 'unihub-text-embedding-v4', data: [{ index: 0, embedding: [0.5] }], usage: { prompt_tokens: 1 } });
  });
  try {
    const f = await fixture();
    const env = { OPENCHAMBER_UNIHUB_ISSUER: origin, OPENCHAMBER_UNIHUB_API_URL: origin, OPENCHAMBER_UNIHUB_HEADLESS_CLIENT_ID: 'headless-test', OPENCHAMBER_UNIHUB_REDIRECT_URI: `${origin}/api/platform-account/callback`, OPENCHAMBER_UNIHUB_GATEWAY_URL: `${origin}/platform/v1` };
    const account = createPlatformAccountRuntime({ env });
    const identity = { type: 'client', token: 'real-fixture-device' };
    await account.passwordLogin(identity, { username: 'alice', password: 'SyntheticPassword9!' });
    await account.selectAccount(identity, 'personal-a');
    const dependencies = { dataDir: f.dir, enabled: () => true, authorizeOwner: (principal) => principal.issuer === origin && principal.userId === 'actor-a', resolveDocument: async () => ({ id: 'doc-1', libraryId: 'library-1', relPath: 'a.txt', root: f.root, tenantId: 7, knowledgeBaseId: 'kb-1' }), resolveModelBinding: async () => ({ protocol: 'managed-media', providerId: 'unihub', purpose: 'embedding', model: 'unihub-text-embedding-v4' }) };
    const unavailable = createManagedWorkAdmission({ ...dependencies, getAccountRuntime: () => account });
    await expect(unavailable.prepare(identity, 'doc-1', 'unverified')).rejects.toMatchObject({ code: 'knowledge_work_space_unverified', status: 503 });
    const fixtureAccount = { ...account, dispatchKnowledgeEmbeddingPinned: async () => { throw new Error('not used by admission fixture'); } };
    const runtime = createManagedWorkAdmission({ ...dependencies, getAccountRuntime: () => fixtureAccount, verifyEmbeddingEvidence: fixtureEvidence });
    const item = await runtime.prepare(identity, 'doc-1', 'real-session');
    expect(item).toMatchObject({ status: 'prepared', dispatchable: false });
    await account.dispatchKnowledgeEmbedding(identity, { taskId: 'task-1', callId: 'wk_' + 'b'.repeat(60), model: 'unihub-text-embedding-v4', body: Buffer.from('{"model":"unihub-text-embedding-v4","input":["x"]}') });
    await account.dispatchKnowledgeRerank(identity, { taskId: 'task-1', callId: 'wk_' + 'c'.repeat(60), model: 'qwen3-rerank', body: Buffer.from('{"model":"qwen3-rerank"}') });
    expect(supplierCalls).toBe(2);
    const result = await account.readKnowledgeResult(identity, { taskId: 'task-1', callId: 'call-1', model: 'unihub-text-embedding-v4' });
    expect(JSON.parse(result.toString())).toMatchObject({ model: 'unihub-text-embedding-v4', data: [{ index: 0, embedding: [0.5] }] });
    membership = false;
    await expect(runtime.prepare(identity, 'doc-1', 'next-request')).rejects.toMatchObject({ code: 'knowledge_work_account_forbidden', status: 403 });
    account.logout(identity);
    await expect(runtime.prepare(identity, 'doc-1', 'another-request')).rejects.toMatchObject({ code: 'platform_session_expired' });
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});


it('removes the worker callback key when the authorization server closes', async () => {
  const callback = await createKnowledgeAuthorizationServer({ authorize: async () => 'ok' });
  const keyDirectory = path.dirname(callback.workerKeyFile);
  expect((await fs.stat(callback.workerKeyFile)).isFile()).toBe(true);
  await Promise.all([callback.close(), callback.close()]);
  await expect(fs.stat(keyDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('expires nonce records without accepting stale requests or clock rollback', async () => {
  let now = Math.floor(Date.now() / 1000);
  const initial = now;
  const callback = await createKnowledgeAuthorizationServer({ authorize: async () => 'ok' }, { now: () => now * 1000, maxNonces: 2 });
  try {
    const body = { work_id: 'kbw_' + 'a'.repeat(64) };
    const first = '1'.repeat(64);
    expect((await signedCallback(callback, callback.url, body, '4'.repeat(64), initial - 31)).status).toBe(403);
    expect((await signedCallback(callback, callback.url, body, '5'.repeat(64), initial + 6)).status).toBe(403);
    expect((await signedCallback(callback, callback.url, body, first, initial)).status).toBe(200);
    expect((await signedCallback(callback, callback.url, body, '2'.repeat(64), initial)).status).toBe(200);
    expect((await signedCallback(callback, callback.url, body, '3'.repeat(64), initial)).status).toBe(403);
    now += 31;
    expect((await signedCallback(callback, callback.url, body, '3'.repeat(64), now)).status).toBe(200);
    expect((await signedCallback(callback, callback.url, body, first, initial)).status).toBe(403);
    now = initial;
    expect((await signedCallback(callback, callback.url, body, first, initial)).status).toBe(403);
  } finally { await callback.close(); }
});

it('binds a Chinese filename, content and query to the same confirmed pilot document', async () => {
  const f = await fixture({ filename: '收益分析.txt' });
  const text = '收益法以预期收益为基础，结合折现率评估资产价值。';
  await fs.writeFile(path.join(f.root, '收益分析.txt'), text);
  const prepared = await f.runtime.prepare({ session: 'alice' }, 'doc-1', 'chinese-pilot');
  const nonce = 'd'.repeat(64);
  await f.runtime.issue({ session: 'alice' }, prepared.workId);
  const call = 'wk_' + 'a'.repeat(60);
  const wrongName = Buffer.from(JSON.stringify({ model: 'unihub-text-embedding-v4', input: ['其他资料.txt\n' + text] })).toString('base64');
  await expect(f.runtime.dispatch(prepared.workId, nonce, call, wrongName)).rejects.toMatchObject({ code: 'knowledge_work_plan_unsupported' });
  expect(f.sends()).toBe(0);
  const embedding = Buffer.from(JSON.stringify({ model: 'unihub-text-embedding-v4', input: ['收益分析.txt\n' + text] })).toString('base64');
  await f.runtime.dispatch(prepared.workId, nonce, call, embedding);
  const search = await f.runtime.prepareSearch({ session: 'alice' }, prepared.workId, '折现率如何影响估值？', 'chinese-query');
  await f.runtime.issueSearch({ session: 'alice' }, search.workId);
  const query = Buffer.from(JSON.stringify({ model: 'unihub-text-embedding-v4', input: ['折现率如何影响估值？'] })).toString('base64');
  await f.runtime.dispatchSearch(search.workId, nonce, 'wk_' + 'b'.repeat(60), 'embedding', query);
  const rerank = Buffer.from(JSON.stringify({ model: 'qwen3-rerank', input: { query: '折现率如何影响估值？', documents: ['收益分析.txt\n\n' + text] }, parameters: { top_n: 1, return_documents: false } })).toString('base64');
  await f.runtime.dispatchSearch(search.workId, nonce, 'wk_' + 'c'.repeat(60), 'rerank', rerank);
  expect(f.sends()).toBe(2);
  expect(f.reranks()).toBe(1);
  const altered = Buffer.from(JSON.stringify({ model: 'qwen3-rerank', input: { query: '折现率如何影响估值？', documents: ['收益分析.txt\n\n其他内容'] }, parameters: { top_n: 1, return_documents: false } })).toString('base64');
  await expect(f.runtime.dispatchSearch(search.workId, nonce, 'wk_' + 'c'.repeat(60), 'rerank', altered)).rejects.toMatchObject({ status: 409 });
});

it('binds a short multiline document exactly and rejects altered line breaks before dispatch', async () => {
  const f = await fixture({ filename: '收益分析.txt' });
  const text = '收益法以预期收益为基础。\n折现率影响资产价值。';
  await fs.writeFile(path.join(f.root, '收益分析.txt'), text);
  const prepared = await f.runtime.prepare({ session: 'alice' }, 'doc-1', 'multiline-pilot');
  const nonce = 'd'.repeat(64); const call = 'wk_' + 'a'.repeat(60);
  await f.runtime.issue({ session: 'alice' }, prepared.workId);
  const body = (input) => Buffer.from(JSON.stringify({ model: 'unihub-text-embedding-v4', input: [input] })).toString('base64');
  await expect(f.runtime.dispatch(prepared.workId, nonce, call, body('收益分析.txt\n' + text.replace('\n', ' ')))).rejects.toMatchObject({ code: 'knowledge_work_plan_unsupported' });
  expect(f.sends()).toBe(0);
  await f.runtime.dispatch(prepared.workId, nonce, call, body('收益分析.txt\n' + text));
  expect(f.sends()).toBe(1);
  const search = await f.runtime.prepareSearch({ session: 'alice' }, prepared.workId, '折现率', 'multiline-query');
  await f.runtime.issueSearch({ session: 'alice' }, search.workId);
  const rerank = (document) => Buffer.from(JSON.stringify({ model: 'qwen3-rerank', input: { query: '折现率', documents: [document] }, parameters: { top_n: 1, return_documents: false } })).toString('base64');
  const rerankCall = 'wk_' + 'c'.repeat(60);
  await expect(f.runtime.dispatchSearch(search.workId, nonce, rerankCall, 'rerank', rerank('收益分析.txt\n\n' + text.replace('\n', ' ')))).rejects.toMatchObject({ code: 'knowledge_work_plan_unsupported' });
  expect(f.reranks()).toBe(0);
  await f.runtime.dispatchSearch(search.workId, nonce, rerankCall, 'rerank', rerank('收益分析.txt\n\n' + text));
  expect(f.reranks()).toBe(1);
});

it('rejects malformed UTF-8 and unsupported Chinese pilot content before dispatch', async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.root, 'a.txt'), Buffer.from([0xff, 0xfe]));
  const prepared = await f.runtime.prepare({ session: 'alice' }, 'doc-1', 'invalid-utf8');
  await f.runtime.issue({ session: 'alice' }, prepared.workId);
  const body = Buffer.from(JSON.stringify({ model: 'unihub-text-embedding-v4', input: ['a.txt\n非法'] })).toString('base64');
  await expect(f.runtime.dispatch(prepared.workId, 'e'.repeat(64), 'wk_' + 'a'.repeat(60), body)).rejects.toMatchObject({ status: 409 });
  expect(f.sends()).toBe(0);
});
