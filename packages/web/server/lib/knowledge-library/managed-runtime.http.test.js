import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import express from 'express';
import request from 'supertest';
import { afterEach, expect, it, vi } from 'vitest';
import fixture from './testdata/completion-contract-v1.json';
import { createKnowledgeLibraryRuntime } from './runtime.js';
import { createManagedWorkAdmission } from './managed-work.js';
import { createAgentToolRuntime } from '../agent-tool/runtime.js';
import { createOpenChamberControlService } from '../openchamber-control/service.js';
import { createManagedKnowledgeContext, createManagedKnowledgeMiddleware } from './managed-context.js';
import { registerKnowledgeLibraryRoutes } from './routes.js';
const cleanups = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const decode = (token) => JSON.parse(Buffer.from(token.split('.')[2], 'base64url'));
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
async function setup({ dictionary = false } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-normal-managed-'));
  cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
  const root = path.join(dataDir, 'project'); const binaryDir = path.join(dataDir, 'packaged');
  await fs.mkdir(root); await fs.writeFile(path.join(root, 'fixture.txt'), 'confirmed synthetic text');
  for (const resource of ['config', 'migrations']) await fs.mkdir(path.join(binaryDir, resource), { recursive: true });
  const dictionaryPath = path.join(binaryDir, 'jieba-dict');
  if (dictionary) {
    await fs.mkdir(dictionaryPath);
    for (const name of ['jieba.dict.utf8', 'hmm_model.utf8', 'user.dict.utf8', 'idf.utf8', 'stop_words.utf8']) await fs.writeFile(path.join(dictionaryPath, name), 'fixture');
  }
  const listener = net.createServer(); await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port; await new Promise((resolve) => listener.close(resolve));
  let child = null; let env; let boot = '7'.repeat(64); let runtime;
  let actor = { actingUserId: 'actor', billingAccountId: 'payer', authSession: 'login', expiresAt: Date.now() + 7_200_000 };
  const identity = { type: 'session', token: 'ui-synthetic' };
  const settings = { knowledgeLibraryEnabled: true, embeddedKnowledgePort: port, projects: [{ id: 'project', path: root }], activeProjectId: 'project' };
  const sends = []; const preflights = []; const calls = []; const registrations = new Map();
  let beforeStatus = async () => {}; let beforeFetch = async () => {}; let rerankCandidate; let nativeBinding = false; let tamperSearch = false; let loseIngestReply = false; let loseSearchReply = false; let nativeTool = null; let beforeSearchReply = () => {};
  const route = (input) => ({ instanceId: 'default', actorId: actor.actingUserId, accountId: actor.billingAccountId, model: input.model, wireOperation: input.wireOperation, policyDigest: '4'.repeat(64), routeGeneration: '6'.repeat(64), embeddingSpace: { provider: 'aliyun', model: 'text-embedding-v4', version: 'v4', dimensions: 1024, input_semantics: 'text' } });
  const account = {
    actor: () => ({ ...actor }), instancePrincipal: () => ({ issuer: 'https://synthetic.invalid', userId: actor.actingUserId }),
    captureCommerceSession: () => ({ ...actor, serviceId: 'service' }),
    preflightKnowledgeRoute: async (_id, input) => { preflights.push(input); return route(input); },
    readCurrentKnowledgeRoute: async (_id, input) => route(input),
    dispatchKnowledgeEmbeddingPinned: async (_id, input) => { sends.push({ ...input, operation: 'embedding' }); },
    dispatchKnowledgeRerankPinned: async (_id, input) => { sends.push({ ...input, operation: 'rerank' }); },
    readKnowledgeResultWithEvidence: async (_id, input) => {
      const rawBytes = Buffer.from(JSON.stringify(input.wireOperation === 'rerank.create' ? { output: { results: [{ index: 0, relevance_score: 1 }] } } : { data: [{ index: 0, embedding: Array(1024).fill(0.1) }] }));
      return { rawBytes, receipt: { ...route(input), taskId: input.taskId, callId: input.callId, attemptId: 1, producerCredentialId: 'original-producer', authorizedCredentialId: 'current-reader', contentSha256: sha(rawBytes) } };
    },
  };
  const binding = async (purpose) => nativeBinding ? (nativeBinding === 'cleared' ? null : { purpose, protocol: 'openai', model: 'native', baseUrl: 'http://127.0.0.1:1/v1', parameters: {} }) : ({ purpose, protocol: 'managed-media', providerId: 'unihub', model: purpose === 'embedding' ? 'unihub-text-embedding-v4' : 'qwen3-rerank', parameters: { dimensions: 1024 } });
  const context = createManagedKnowledgeContext({ readSettings: async () => settings, resolveProjectId: async () => 'project', resolvePrimaryWorktreeRoot: async () => null, getAccountRuntime: () => account, readSession: async (id) => ({ id, location: { directory: root } }), readMessages: async () => ({ data: [{ type: 'assistant', content: nativeTool ? [nativeTool] : [] }] }) });
  const callback = async (suffix, fields, search = false) => {
    const nonce = crypto.randomBytes(32).toString('hex'); const body = JSON.stringify({ ...fields, nonce }); const timestamp = String(Math.floor(Date.now() / 1000));
    const url = new URL(env.WEKNORA_MANAGED_KNOWLEDGE_AUTH_URL.replace('/authorize', suffix).replace('/knowledge-work/', search ? '/knowledge-search/' : '/knowledge-work/'));
    const key = await fs.readFile(env.WEKNORA_MANAGED_CALLBACK_KEY_FILE);
    const mac = crypto.createHmac('sha256', key).update(`weknora-callback-v2\nPOST\n${url.pathname}\n${sha(body)}\n${nonce}\n${timestamp}`).digest('hex');
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-weknora-worker-time': timestamp, 'x-weknora-worker-signature': mac }, body });
    expect(response.status, `${suffix} callback`).toBe(200); return response.json();
  };
  const fetchImpl = async (url, options = {}) => {
    const pathname = new URL(url).pathname; calls.push(pathname); await beforeFetch(pathname);
    if (pathname === '/health') return json({ status: child ? 'ok' : 'stopped' }, child ? 200 : 503);
    if (pathname === '/api/v1/auth/login') return json({ token: 'local-only-session', user: { tenant_id: 1 } });
    if (pathname === '/api/v1/models') return options.method === 'POST' ? json({ data: { ...JSON.parse(options.body), id: 'model' } }) : json({ data: [] });
    if (pathname === '/api/v1/knowledge-bases') return options.method === 'POST' ? json({ data: { id: 'kb' } }) : json({ data: [] });
    if (pathname === '/api/v1/knowledge-bases/kb' && options.method === 'PUT') return json({ data: { id: 'kb', ...JSON.parse(options.body) } });
    if (pathname === '/api/v1/tenants/1/api-keys') return json({ data: { token: 'local-only-api-key' } });
    if (pathname.endsWith('/hybrid-search')) return json({ data: [] });
    if (options.method === 'DELETE') return json({ success: true });
    const proof = decode(options.headers['X-WeKnora-Managed-Proof']);
    expect(proof.body_sha256).toBe(sha(options.body));
    const claims = decode(JSON.parse(options.body).capability);
    const { issuer: _issuer, audience: _audience, issued_at: _issued, expires_at: _expires, ...scope } = claims;
    if (pathname.endsWith('/managed-ref')) {
      expect(await fs.readFile(path.join(dataDir, 'knowledge-managed-work', 'completion-journal-v1'), 'utf8')).toContain('PENDING');
      const snapshot = await callback('/snapshot', { work_id: claims.work_id });
      const text = Buffer.from(snapshot.content, 'base64').toString();
      const callId = `wk_${sha(claims.work_id).slice(0, 60)}`;
      const fields = { work_id: claims.work_id, call_id: callId };
      await callback('/dispatch', { ...fields, content: Buffer.from(JSON.stringify({ model: claims.embedding_model, input: [`fixture.txt\n${text.trim()}`], dimensions: 1024 })).toString('base64') });
      await callback('/result', fields); registrations.set(claims.work_id, { scope, text, callId });
      if (loseIngestReply) throw new Error('synthetic lost ingest reply');
      return json({ success: true });
    }
    if (pathname.endsWith('/managed-status')) {
      await beforeStatus(claims);
      const kind = claims.version === 'managed-storage-v1' ? 'storage' : claims.version === 'completed-index-discover-v1' ? 'discovery' : 'completion';
      await callback(kind === 'storage' ? '/storage-authorize' : '/completed-authorize', { scope: claims });
      if (kind !== 'storage' && !registrations.has(claims.work_id ?? claims.binding.work_id)) return json({ error: 'pending' }, 409);
      const template = fixture.replies[{ storage: 'storage', discovery: 'discover', completion: 'use' }[kind]];
      const reply = { ...template, scope: claims, nonce: proof.nonce, issued_at: proof.issued_at, expires_at: Math.min(proof.expires_at, claims.expires_at) };
      if (kind === 'storage') reply.worker_boot_id = boot;
      if (kind === 'discovery') { reply.index_revision = claims.binding.index_revision; reply.call_id = registrations.get(claims.binding.work_id).callId; reply.attempt_id = '1'; reply.producer_credential_id = 'original-producer'; }
      delete reply.mac; const key = crypto.createHmac('sha256', await fs.readFile(env.WEKNORA_MANAGED_CALLBACK_KEY_FILE)).update('managed-completion-response-v1').digest();
      reply.mac = crypto.createHmac('sha256', key).update(JSON.stringify(reply)).digest('hex');
      return json({ success: true, data: { [kind]: reply } });
    }
    if (pathname.endsWith('/managed-hybrid-search')) {
      const snapshot = await callback('/snapshot', { work_id: claims.work_id }, true); const query = Buffer.from(snapshot.content, 'base64').toString();
      for (const operation of ['embedding', 'rerank']) {
        const callId = `wk_${sha(claims.work_id + operation).slice(0, 60)}`;
        const body = operation === 'embedding' ? { model: claims.embedding_model, input: [query], dimensions: 1024 } : { model: 'qwen3-rerank', input: { query, documents: [rerankCandidate ?? registrations.get(claims.index_work_id).text] }, parameters: { top_n: 1, return_documents: false } };
        await callback('/dispatch', { work_id: claims.work_id, call_id: callId, operation, content: Buffer.from(JSON.stringify(body)).toString('base64') }, true);
        await callback('/result', { work_id: claims.work_id, call_id: callId, operation }, true);
      }
      const result = Buffer.from(JSON.stringify({ Results: [{ knowledge_id: claims.knowledge_id, content: 'confirmed <synthetic> text', score: 1 }] }).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e'));
      const payload = Buffer.from(JSON.stringify({ version: 'managed-search-response-v1', scope, nonce: proof.nonce, worker_boot_id: boot, result_base64: result.toString('base64'), content_sha256: sha(result), issued_at: proof.issued_at, expires_at: proof.expires_at }));
      const key = crypto.createHmac('sha256', await fs.readFile(env.WEKNORA_MANAGED_CALLBACK_KEY_FILE)).update('managed-search-response-v1').digest();
      if (loseSearchReply) throw new Error('synthetic lost search reply');
      beforeSearchReply();
      return json({ success: true, data: { payload: payload.toString('base64'), mac: tamperSearch ? '0'.repeat(64) : crypto.createHmac('sha256', key).update(payload).digest('hex') } });
    }
    throw new Error(`Unexpected synthetic worker path ${pathname}`);
  };
  const initialize = () => {
    runtime = createKnowledgeLibraryRuntime({ dataDir, readSettings: async () => settings, saveSettings: async (patch) => Object.assign(settings, patch), resolveBinaryPath: () => path.join(binaryDir, 'synthetic-worker'), resolveModelBinding: binding, fetchImpl, spawnImpl: (_binary, _args, options) => {
      env = options.env; child = new EventEmitter(); child.exitCode = null; child.stderr = new EventEmitter();
      child.kill = () => { const current = child; child = null; current.exitCode = 0; current.emit('exit', 0, null); };
      return child;
    } });
    const work = createManagedWorkAdmission({ dataDir, enabled: () => true, authorizeOwner: () => true, getAccountRuntime: () => account, resolveDocument: (id) => runtime.managedWorkDocument(id), resolveModelBinding: binding, resolveNamespace: context.resolve });
    runtime.configureManaged(work, context);
  };
  initialize(); cleanups.push(() => runtime.stop());
  const app = express();
  app.use(createManagedKnowledgeMiddleware({ enabled: () => true, resolveModelBinding: binding, resolveIdentity: async () => identity, isRequestOriginAllowed: async () => true, readSettings: async () => settings, getAccountRuntime: () => account, context }));
  app.post('/api/session/:id/prompt', (_req, res) => res.json({ forwarded: true }));
  const control = createOpenChamberControlService({ knowledgeLibraryRuntime: new Proxy({}, { get: (_target, property) => (...args) => runtime[property](...args) }), isLibraryToolEnabled: () => true });
  const agent = createAgentToolRuntime({ crypto, fsPromises: fs, path, instanceDir: dataDir, getActivePort: () => port, resolveSessionDirectory: async () => root, executeAction: (...args) => control.execute(...args) });
  // Keep the actual route adapter while allowing a fresh runtime after restart.
  registerKnowledgeLibraryRoutes(app, { runtime: new Proxy({}, { get: (_target, property) => (...args) => runtime[property](...args) }) });
  const preview = () => request(app).post('/api/knowledge-library/libraries/preview').send({ path: root });
  const importFile = async (intentId = 'explicit-import') => { const p = await preview(); expect(p.status).toBe(200); return request(app).post('/api/knowledge-library/libraries').set('idempotency-key', intentId).send({ path: root, previewId: p.body.previewId, confirmed: true }); };
  return { app, agent, beforeFetch: (callback) => { beforeFetch = callback; }, beforeStatus: (callback) => { beforeStatus = callback; }, changeBinding: (value) => { nativeBinding = value; }, candidate: (value) => { rerankCandidate = value; }, exitChild: () => { child.exitCode = 1; child.emit('exit', 1, null); }, beforeSearchReply: (callback) => { beforeSearchReply = callback; }, setTool: (tool) => { nativeTool = tool; }, loseSearch: (value) => { loseSearchReply = value; }, root, dataDir, dictionaryPath, sends, preflights, calls, preview, importFile, get runtime() { return runtime; }, get env() { return env; }, tamper: () => { tamperSearch = true; }, loseReply: () => { loseIngestReply = true; }, changeActor: (patch) => { actor = { ...actor, ...patch }; }, restart: async () => { await runtime.stop(); initialize(); boot = '8'.repeat(64); return runtime.start(); } };
}
it('managed backend uses portable dictionaries while retaining authenticated host callbacks', async () => {
  const f = await setup({ dictionary: true });
  await f.runtime.start();
  expect(f.env.JIEBA_DICT_DIR).toBe(f.dictionaryPath);
  expect(f.env.WEKNORA_MANAGED_KNOWLEDGE_AUTH_URL).toMatch(/^http:\/\/127\.0\.0\.1:/);
  expect(f.env.SSRF_WHITELIST_EXTRA).toBe('');
  expect(f.preflights).toHaveLength(0); expect(f.sends).toHaveLength(0);
  const imported = await f.importFile();
  expect(imported.status, JSON.stringify(imported.body)).toBe(201);
  expect(f.sends).toHaveLength(1);
});
it('managed backend rejects incomplete portable dictionaries before spawning or model admission', async () => {
  const f = await setup({ dictionary: true });
  await fs.rm(path.join(f.dictionaryPath, 'hmm_model.utf8'));
  await expect(f.runtime.start()).rejects.toMatchObject({ code: 'backend_dictionary_missing' });
  expect(f.env).toBeUndefined();
  expect(f.preflights).toHaveLength(0); expect(f.sends).toHaveLength(0);
});
it('normal approved 300-byte TXT import and search preserve source bytes and actual model transforms', async () => {
  const raw = await fs.readFile(process.env.SUPERWAGIE_APPROVED_TXT_FIXTURE || new URL('./testdata/approved-300-byte-acceptance.txt', import.meta.url));
  expect(raw.length).toBe(300); expect(sha(raw)).toBe('646f1958415b538106574a3ad57fcfc3dad30c93f248387bf21845a739bb6c6b');
  const f = await setup(); await fs.writeFile(path.join(f.root, 'fixture.txt'), raw);
  const imported = await f.importFile(); expect(imported.status, JSON.stringify(imported.body)).toBe(201);
  const documents = await request(f.app).get('/api/knowledge-library/documents'); const document = documents.body.documents[0]; expect(document.state).toBe('ready');
  const content = await request(f.app).get(`/api/knowledge-library/documents/${document.id}/content`); expect(content.body.content).toBe(raw.toString());
  expect(JSON.parse(f.sends[0].body).input).toEqual([`fixture.txt\n${raw.toString().trim()}`]);
  const search = await request(f.app).post('/api/knowledge-library/search').set('idempotency-key', 'approved-search').send({ query: 'needle' });
  expect(search.status, JSON.stringify(search.body)).toBe(200); expect(f.sends.map((entry) => entry.operation)).toEqual(['embedding', 'embedding', 'rerank']);
  expect(JSON.parse(f.sends[2].body).input.documents).toEqual([raw.toString()]);
  await fs.writeFile(path.join(f.root, 'fixture.txt'), raw.toString().trim());
  const changed = await request(f.app).post('/api/knowledge-library/search').set('idempotency-key', 'changed-source').send({ query: 'needle' });
  expect(changed.status).toBeGreaterThanOrEqual(400); expect(f.sends).toHaveLength(3);
});
it('normal preview-confirm import, restart status and explicit search use actual host callbacks and authenticated replies', async () => {
  const f = await setup(); await f.runtime.start();
  expect(f.env.OPENAI_API_KEY).toBeUndefined(); expect(f.env.HTTP_PROXY).toBeUndefined(); expect(f.env.SSRF_WHITELIST_EXTRA).toBe('');
  expect(f.preflights).toHaveLength(0); expect(f.sends).toHaveLength(0);
  const preview = await f.preview(); expect(preview.status).toBe(200); expect(f.preflights).toHaveLength(0);
  const unconfirmed = await request(f.app).post('/api/knowledge-library/libraries').send({ path: f.root }); expect(unconfirmed.status).toBe(503);
  const imported = await f.importFile(); expect(imported.status, JSON.stringify(imported.body)).toBe(201); expect(f.sends).toHaveLength(1);
  const listed = await request(f.app).get('/api/knowledge-library/documents'); expect(listed.body.documents[0].state).toBe('ready');
  const content = await request(f.app).get(`/api/knowledge-library/documents/${listed.body.documents[0].id}/content`); expect(content.body.content).toBe('confirmed synthetic text');
  await fs.writeFile(path.join(f.dataDir, 'embedded-knowledge', 'embedded-knowledge.db'), 'synthetic owned storage');
  await f.restart(); expect(f.sends).toHaveLength(1); expect(f.preflights).toHaveLength(1);
  const recovered = await request(f.app).get('/api/knowledge-library/documents'); expect(recovered.body.documents[0].state).toBe('ready'); expect(f.sends).toHaveLength(1);
  const search = await request(f.app).post('/api/knowledge-library/search').set('idempotency-key', 'explicit-search').send({ query: 'needle' });
  expect(search.status, JSON.stringify(search.body)).toBe(200); expect(search.body.passages[0].content).toBe('confirmed <synthetic> text'); expect(f.sends.map((entry) => entry.operation)).toEqual(['embedding', 'embedding', 'rerank']);
  expect(JSON.parse(f.sends[2].body)).toEqual({ model: 'qwen3-rerank', input: { query: 'needle', documents: ['confirmed synthetic text'] }, parameters: { top_n: 1, return_documents: false } });
  f.tamper(); const bad = await request(f.app).post('/api/knowledge-library/search').set('idempotency-key', 'explicit-search').send({ query: 'needle' }); expect(bad.status).toBe(503); expect(bad.body.passages).toBeUndefined(); expect(f.sends).toHaveLength(3);
});
it('changed bytes require a fresh confirmation, preserve document identity and advance the journal revision', async () => {
  const f = await setup(); const imported = await f.importFile(); expect(imported.status, JSON.stringify(imported.body)).toBe(201);
  const original = (await request(f.app).get('/api/knowledge-library/documents')).body.documents[0];
  await fs.writeFile(path.join(f.root, 'fixture.txt'), 'changed synthetic text');
  const rescan = await request(f.app).post(`/api/knowledge-library/libraries/${imported.body.library.id}/rescan`); expect(rescan.status).toBe(503); expect(f.sends).toHaveLength(1);
  const next = await f.importFile('explicit-new-revision'); expect(next.status, JSON.stringify(next.body)).toBe(201);
  const updated = (await request(f.app).get('/api/knowledge-library/documents')).body.documents[0]; expect(updated.id).toBe(original.id); expect(updated.state).toBe('ready'); expect(f.sends).toHaveLength(2);
  const journal = await fs.readFile(path.join(f.dataDir, 'knowledge-managed-work', 'completion-journal-v1'), 'utf8'); expect(journal).toContain('index_revision\\\":2');
});
it('lost ingest response recovers without resending and cross-project reads fail before paid work', async () => {
  const f = await setup(); f.loseReply(); expect((await f.importFile()).status).toBe(500); expect(f.sends).toHaveLength(1);
  const recovered = await request(f.app).get('/api/knowledge-library/documents'); expect(recovered.body.documents[0].state).toBe('ready'); expect(f.sends).toHaveLength(1);
  const forged = await request(f.app).post('/api/knowledge-library/search').set('x-opencode-directory', '/injected').set('idempotency-key', 'forged').send({ query: 'needle' }); expect(forged.status).toBe(403); expect(f.sends).toHaveLength(1);
  f.changeActor({ billingAccountId: 'other', authSession: 'new' }); expect((await request(f.app).get('/api/knowledge-library/documents')).body.documents).toEqual([]);
});

it('a fresh UI intent recovers unresolved search across restart without dispatching new calls', async () => {
  const f = await setup(); expect((await f.importFile()).status).toBe(201);
  f.loseSearch(true);
  const search = (query, intent) => request(f.app).post('/api/knowledge-library/search').set('idempotency-key', intent).send({ query });
  expect((await search('needle', 'first-ui-intent')).status).toBe(500);
  expect(f.sends).toHaveLength(3); const preflights = f.preflights.length;
  await fs.writeFile(path.join(f.dataDir, 'embedded-knowledge', 'embedded-knowledge.db'), 'synthetic owned storage');
  await f.restart(); f.loseSearch(false);
  expect((await search('different query', 'new-other-intent')).status).toBe(409);
  expect((await search('needle', 'new-ui-intent')).status).toBe(200);
  expect(f.sends).toHaveLength(3); expect(f.preflights).toHaveLength(preflights);
});
it('native agent search shares the normal paid runtime after exact running call and prompt validation', async () => {
  const f = await setup(); expect((await f.importFile()).status).toBe(201);
  const input = { action: 'library.search', query: 'needle', limit: 1 };
  const payload = { tool: 'openchamber_library', sessionID: 'session', callID: 'native-call', input, contextDirectory: '/injected', contextSessionId: 'forged' };
  expect((await f.agent.execute(payload)).ok).toBe(false); expect(f.sends).toHaveLength(1);
  expect((await request(f.app).post('/api/session/session/prompt').send({})).status).toBe(200);
  f.setTool({ type: 'tool', id: 'native-call', name: 'openchamber_library', state: { status: 'running', input: { action: 'search', parameters: { query: 'needle', limit: 1 } } } });
  const result = await f.agent.execute(payload);
  expect(result.ok, JSON.stringify(result)).toBe(true); expect(result.data.passages[0].path).toBe(path.join(f.root, 'fixture.txt'));
  expect(f.sends.map((entry) => entry.operation)).toEqual(['embedding', 'embedding', 'rerank']);
  expect((await f.agent.execute({ ...payload, callID: 'forged-call' })).ok).toBe(false);
  f.changeActor({ authSession: 'logged-out', expiresAt: 0 });
  expect((await f.agent.execute(payload)).ok).toBe(false); expect(f.sends).toHaveLength(3);
});
it('missing worker database refuses restart without creating paid work', async () => {
  const f = await setup(); expect((await f.importFile()).status).toBe(201);
  await f.runtime.stop(); const status = await f.runtime.reconnect();
  expect(status.backend.state).not.toBe('running'); expect(f.sends).toHaveLength(1); expect(f.preflights).toHaveLength(1);
});

it('changed preview bytes and logout during a search response cannot be adopted', async () => {
  const f = await setup(); const preview = await f.preview();
  await fs.writeFile(path.join(f.root, 'fixture.txt'), 'changed before confirmation');
  const changed = await request(f.app).post('/api/knowledge-library/libraries').set('idempotency-key', 'stale-preview').send({ path: f.root, previewId: preview.body.previewId, confirmed: true });
  expect(changed.status).toBe(503); expect(f.preflights).toHaveLength(0); expect(f.sends).toHaveLength(0);
  expect((await f.importFile()).status).toBe(201);
  f.beforeSearchReply(() => f.changeActor({ billingAccountId: 'switched', authSession: 'switched' }));
  const result = await request(f.app).post('/api/knowledge-library/search').set('idempotency-key', 'race-search').send({ query: 'needle' });
  expect(result.status).toBe(409); expect(result.body.passages).toBeUndefined(); expect(f.sends).toHaveLength(3);
});
it('unsupported files and isolated space addresses refuse before a paid preflight', async () => {
  const f = await setup();
  await fs.writeFile(path.join(f.root, 'fixture.txt'), 'x'.repeat(301));
  expect((await f.preview()).status).toBe(503);
  expect(f.sends).toHaveLength(0); expect(f.preflights).toHaveLength(0);
  await fs.writeFile(path.join(f.root, 'fixture.txt'), 'small again');
  const isolated = await request(f.app).post('/api/knowledge-library/libraries/preview').set('x-opencode-directory', '/spaces/isolated/project').send({ path: f.root });
  expect(isolated.status).toBe(403); expect(isolated.body.error).toBe('knowledge_work_space_unsupported'); expect(f.sends).toHaveLength(0); expect(f.preflights).toHaveLength(0);
});

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const journalEvents = async (f) => (await fs.readFile(path.join(f.dataDir, 'knowledge-managed-work/completion-journal-v1'), 'utf8')).trim().split('\n').map((line) => JSON.parse(JSON.parse(line).payload));
it('rejects a rerank candidate changed from the literal worker chunk before rerank dispatch', async () => {
  const f = await setup(); expect((await f.importFile()).status).toBe(201);
  f.candidate('fixture.txt\n\nconfirmed synthetic text');
  const result = await request(f.app).post('/api/knowledge-library/search').set('idempotency-key', 'changed-candidate').send({ query: 'needle' });
  expect(result.status).toBeGreaterThanOrEqual(400); expect(f.sends.map((send) => send.operation)).toEqual(['embedding', 'embedding']);
});
it('concurrent normal polling, content read and import recovery keep one monotone completion', async () => {
  const f = await setup(); f.loseReply(); expect((await f.importFile()).status).toBe(500);
  const ledger = JSON.parse(await fs.readFile(path.join(f.dataDir, 'knowledge-library/documents.json'), 'utf8'));
  const id = Object.keys(ledger.documents)[0]; const reached = deferred(); const release = deferred(); let first = true;
  f.beforeStatus(async () => { if (first) { first = false; reached.resolve(); await release.promise; } });
  const poll = request(f.app).get('/api/knowledge-library/documents').then((r) => r); await reached.promise;
  const others = [request(f.app).get('/api/knowledge-library/documents'), request(f.app).get(`/api/knowledge-library/documents/${id}/content`)].map((r) => r.then((response) => response));
  const imported = f.importFile(); release.resolve();
  const results = await Promise.all([poll, ...others, imported]);
  expect(results.map((r) => r.status)).toEqual([200, 200, 200, 201]);
  expect(results[0].body.documents[0].state).toBe('ready'); expect(results[2].body.content).toBe('confirmed synthetic text');
  const events = await journalEvents(f); expect(events.map((event) => event.sequence)).toEqual([1, 2, 3]);
  expect(events.map((event) => event.type)).toEqual(['ANCHOR', 'PENDING', 'COMMITTED']); expect(f.sends).toHaveLength(1);
});
it.each(['delete', 'revision'])('a held poll cannot overwrite a subsequent %s mutation', async (mutation) => {
  const f = await setup(); expect((await f.importFile()).status).toBe(201);
  const id = (await request(f.app).get('/api/knowledge-library/documents')).body.documents[0].id;
  const reached = deferred(); const release = deferred(); let first = true;
  f.beforeStatus(async () => { if (first) { first = false; reached.resolve(); await release.promise; } });
  const poll = request(f.app).get('/api/knowledge-library/documents').then((r) => r); await reached.promise;
  let mutationRequest;
  if (mutation === 'delete') mutationRequest = request(f.app).delete(`/api/knowledge-library/documents/${id}`).then((r) => r);
  else { await fs.writeFile(path.join(f.root, 'fixture.txt'), 'new confirmed revision'); mutationRequest = f.importFile('new-revision'); }
  // Both requests have reached the runtime while recovery is held. The mutation
  // may queue or finish, but the poll must never restore its earlier ledger.
  await Promise.race([mutationRequest, new Promise((resolve) => setTimeout(resolve, 500))]); release.resolve();
  const [response, changed] = await Promise.all([poll, mutationRequest]); expect(response.status).toBe(200); expect(changed.status).toBe(mutation === 'delete' ? 200 : 201);
  const ledger = JSON.parse(await fs.readFile(path.join(f.dataDir, 'knowledge-library/documents.json'), 'utf8')).documents;
  if (mutation === 'delete') { expect(ledger).toEqual({}); expect((await request(f.app).get('/api/knowledge-library/documents')).body.documents).toEqual([]); }
  else { expect(ledger[id].sha256).toBe(sha('new confirmed revision')); expect(ledger[id].state).toBe('ready'); expect((await journalEvents(f)).at(-1).value.binding.index_revision).toBe(2); }
});
it.each(['cleared', 'changed'])('persisted managed storage refuses ordinary consumers after %s bindings', async (mode) => {
  const f = await setup(); expect((await f.importFile()).status).toBe(201);
  const before = await fs.readFile(path.join(f.dataDir, 'knowledge-library/documents.json'), 'utf8');
  f.changeBinding(mode); f.changeActor({ actingUserId: 'other', billingAccountId: 'other', authSession: 'other' });
  const calls = f.calls.length;
  const search = await request(f.app).post('/api/knowledge-library/search').set('x-opencode-directory', '/another-project').send({ query: 'fixture.txt' });
  expect(search.status).toBe(503); expect(search.body.documents).toBeUndefined();
  await expect(f.runtime.rebuild()).rejects.toMatchObject({ code: 'knowledge_work_storage_unavailable' });
  await expect(f.runtime.retryFailed()).rejects.toMatchObject({ code: 'knowledge_work_storage_unavailable' });
  await expect(f.runtime.prepareModelBindingChange('embedding', null)).rejects.toMatchObject({ code: 'knowledge_work_storage_unavailable' });
  await f.runtime.stop(); await expect(f.runtime.start()).rejects.toMatchObject({ code: 'knowledge_work_storage_unavailable' });
  expect(f.calls.slice(calls)).toEqual([]); expect(f.sends).toHaveLength(1);
  expect(await fs.readFile(path.join(f.dataDir, 'knowledge-library/documents.json'), 'utf8')).toBe(before);
  expect((await request(f.app).get('/api/knowledge-library/documents')).body.documents).toEqual([]);
});
it('native agent search then read carries private current execution and rejects substituted calls and paths', async () => {
  const f = await setup(); expect((await f.importFile()).status).toBe(201); await request(f.app).post('/api/session/session/prompt').send({});
  f.setTool({ type: 'tool', id: 'search-call', name: 'openchamber_library', state: { status: 'running', input: { action: 'search', parameters: { query: 'needle', limit: 1 } } } });
  const result = await f.agent.execute({ tool: 'openchamber_library', sessionID: 'session', callID: 'search-call', input: { action: 'library.search', query: 'needle', limit: 1 } });
  expect(result.ok).toBe(true); const source = result.data.passages[0].path;
  f.setTool({ type: 'tool', id: 'read-call', name: 'openchamber_library', state: { status: 'running', input: { action: 'read', parameters: { path: source } } } });
  const payload = { tool: 'openchamber_library', sessionID: 'session', callID: 'read-call', input: { action: 'library.read', path: source } };
  const read = await f.agent.execute(payload); expect(read.ok, JSON.stringify(read)).toBe(true); expect(read.data.content).toBe('confirmed synthetic text');
  for (const changed of [{ sessionID: 'other' }, { callID: 'other' }, { input: { action: 'library.read', path: '/another-file' } }]) expect((await f.agent.execute({ ...payload, ...changed })).ok).toBe(false);
  let finishCall = true;
  f.beforeStatus(async (claims) => { if (finishCall && claims.version === 'completed-index-use-v1') { finishCall = false; f.setTool({ type: 'tool', id: 'read-call', name: 'openchamber_library', state: { status: 'completed', input: { action: 'read', parameters: { path: source } } } }); } });
  const ended = await f.agent.execute(payload); expect(ended.ok).toBe(false); expect(ended.data).toBeUndefined();
  f.setTool({ type: 'tool', id: 'read-call', name: 'openchamber_library', state: { status: 'running', input: { action: 'read', parameters: { path: source } } } });
  f.changeActor({ billingAccountId: 'other', authSession: 'other' }); expect((await f.agent.execute(payload)).ok).toBe(false); expect(f.sends).toHaveLength(3);
});
it('a managed child exiting during recovery prevents further worker requests and disclosure', async () => {
  const f = await setup(); expect((await f.importFile()).status).toBe(201);
  const id = (await request(f.app).get('/api/knowledge-library/documents')).body.documents[0].id;
  let once = true; f.beforeStatus(async () => { if (once) { once = false; f.exitChild(); } });
  const result = await request(f.app).get(`/api/knowledge-library/documents/${id}/content`);
  expect(result.status).toBe(503); expect(result.body.content).toBeUndefined(); expect(f.runtime.isReady()).toBe(false); expect(f.sends).toHaveLength(1);
});

it('does not continue managed provisioning after the child exits during local login', async () => {
  const f = await setup(); f.beforeFetch(async (pathname) => { if (pathname === '/api/v1/auth/login') f.exitChild(); });
  await expect(f.runtime.start()).rejects.toThrow();
  expect(f.calls).not.toContain('/api/v1/models'); expect(f.calls).not.toContain('/api/v1/knowledge-bases');
  expect(f.runtime.isReady()).toBe(false); expect(f.sends).toHaveLength(0); expect(f.preflights).toHaveLength(0);
});
