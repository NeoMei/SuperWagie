import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import { createPlatformModelRuntime } from '../packages/web/server/lib/platform-model/runtime.js';
import { createManagedWorkAdmission, createKnowledgeAuthorizationServer } from '../packages/web/server/lib/knowledge-library/managed-work.js';
import { createEmbeddedKnowledgeClient } from '../packages/web/server/lib/embedded-knowledge/client.js';
import { provisionKnowledgeBackend } from '../packages/web/server/lib/embedded-knowledge/provision.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-managed-pilot-'));
const source = process.env.WEKNORA_PILOT_SOURCE;
const binary = process.env.WEKNORA_PILOT_BINARY;
if (!source || !binary || !path.isAbsolute(source) || !path.isAbsolute(binary)) throw new Error('Set absolute WEKNORA_PILOT_SOURCE and WEKNORA_PILOT_BINARY paths for an isolated fixture');
const fixture = path.join(dir, 'fixture'); await fs.mkdir(fixture);
const filename = process.env.WEKNORA_PILOT_CHINESE === '1' ? '收益分析.txt' : 'pilot.txt';
const documentPath = path.join(fixture, filename);
const chinese = process.env.WEKNORA_PILOT_CHINESE === '1';
const sample = process.env.WEKNORA_PILOT_MULTILINE === '1'
  ? (chinese ? `${'收益折现率'.repeat(10)}\n${'收益折现率'.repeat(9)}收益折现` : `${'0123456789'.repeat(15)}\n${'0123456789'.repeat(14)}012345678`)
  : (chinese ? '收益折现率'.repeat(20) : '0123456789'.repeat(30));
const query = chinese ? '折现率' : '0123456789';
if (Buffer.byteLength(sample) > 300) throw new Error('fixture exceeds 300 bytes');
await fs.writeFile(documentPath, sample);
const socket = net.createServer(); await new Promise((resolve) => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port; await new Promise((resolve) => socket.close(resolve));
const baseUrl = `http://127.0.0.1:${port}`;
const env = {
  PATH: process.env.PATH, TMPDIR: dir, HOME: dir, LANG: 'C.UTF-8', GIN_MODE: 'release', LOG_LEVEL: 'warn', SERVER_HOST: '127.0.0.1', SERVER_PORT: String(port),
  DB_DRIVER: 'sqlite', DB_PATH: path.join(dir, 'embedded.db'), RETRIEVE_DRIVER: 'sqlite', STORAGE_TYPE: 'local', LOCAL_STORAGE_BASE_DIR: path.join(dir, 'files'),
  LOG_PATH: path.join(dir, 'weknora.log'), SYSTEM_AES_KEY: crypto.randomBytes(16).toString('hex'), JWT_SECRET: crypto.randomBytes(48).toString('base64url'), NEO4J_ENABLE: 'false', ENABLE_GRAPH_RAG: 'false', CONCURRENCY_POOL_SIZE: '3', SSRF_WHITELIST_EXTRA: 'localhost,127.0.0.1,example.invalid',
};
let child; let logs = '';
const start = async (extra = {}) => {
  child = spawn(binary, [], { cwd: source, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => { logs += chunk.toString(); }); child.stderr.on('data', (chunk) => { logs += chunk.toString(); });
  let started = false;
  for (let n=0;n<200;n++) {
    if (child.exitCode !== null) break;
    try { const r = await fetch(`${baseUrl}/health`); if (r.ok) { started = true; break; } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!started) throw new Error(`backend did not start; exit ${child.exitCode}; log ${logs.slice(-5000)}`);
};
const stop = async () => { if (child && child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 5000))]); if (child.exitCode === null) child.kill('SIGKILL'); } };
let authServer;
try {
  await start();
  const state = {};
  const provision = await provisionKnowledgeBackend({ createClient: (opts={}) => createEmbeddedKnowledgeClient({ baseUrl, ...opts }), getState: () => state, saveState: (patch) => Object.assign(state, patch), modelApiKey: null, localDefaults: null, modelBindings: { embedding: { name: 'unihub-text-embedding-v4', parameters: { base_url: 'http://127.0.0.1:1/v1', provider: 'aliyun', api_key: 'fixture-key', embedding_parameters: { dimension: 1024 } } }, rerank: { name: 'qwen3-rerank', parameters: { base_url: 'http://127.0.0.1:1', provider: 'aliyun', api_key: 'fixture-key' } } } });
  await stop();
  let attempts = 0; let reranks = 0; let dispatchedBody; let queryBody; let rerankBody; let unavailableRerankResult = true;
  const account = {
    actor: () => ({ actingUserId: 'actor-a', billingAccountId: 'account-a', authSession: 'mock-session', expiresAt: Date.now() + 300_000 }),
    instancePrincipal: () => ({ issuer: 'https://mock-authority.invalid', userId: 'actor-a' }),
    captureCommerceSession: () => ({ actingUserId: 'actor-a', billingAccountId: 'account-a', serviceId: 'mock-service', request: async () => [{ id: 'account-a', role: 'owner' }] }),
    dispatchKnowledgeEmbeddingPinned: async (_identity, call) => { if (call.policyDigest !== 'a'.repeat(64)) throw new Error('fixture policy mismatch'); attempts++; if (attempts === 1) dispatchedBody = JSON.parse(call.body.toString()); else queryBody = JSON.parse(call.body.toString()); },
    dispatchKnowledgeRerank: async (_identity, call) => { reranks++; rerankBody = JSON.parse(call.body.toString()); },
    readKnowledgeResult: async (_identity, call) => {
      if (call.model === 'qwen3-rerank' && unavailableRerankResult) { unavailableRerankResult = false; throw new Error('mock result unavailable'); }
      return Buffer.from(JSON.stringify(call.model === 'qwen3-rerank' ? { output: { results: [{ index: 0, relevance_score: 0.9 }] }, usage: { total_tokens: 100 } } : { model: 'unihub-text-embedding-v4', data: [{ index: 0, embedding: Array.from({length:1024},(_,i)=>i===0?0.5:0) }], usage: { prompt_tokens: 100, total_tokens: 100 } }));
    },
  };
  // Fixed expiry matches one valid session snapshot across the callback sequence.
  const expiresAt = Date.now() + 300_000; const priorActor = account.actor; account.actor = () => ({ ...priorActor(), expiresAt });
  const work = createManagedWorkAdmission({ dataDir: dir, enabled: () => true, authorizeOwner: p => p.issuer === 'https://mock-authority.invalid' && p.userId === 'actor-a', getAccountRuntime: () => account, verifyEmbeddingEvidence: async (_identity, scope) => ({ ...scope, verified: true, model: 'unihub-text-embedding-v4', space: 'aliyun/text-embedding-v4/v4/1024/text', provider: 'aliyun', upstreamModel: 'text-embedding-v4', version: 'v4', dimensions: 1024, inputSemantics: 'text', policyDigest: scope.policyDigest ?? 'a'.repeat(64), expiresAt: Date.now() + 60_000 }), resolveModelBinding: async (purpose) => ({ protocol: 'managed-media', providerId: 'unihub', purpose, model: purpose === 'rerank' ? 'qwen3-rerank' : 'unihub-text-embedding-v4' }), resolveDocument: async () => ({ id: 'doc-1', libraryId: 'lib-1', relPath: filename, root: fixture, tenantId: provision.tenantId, knowledgeBaseId: provision.knowledgeBaseId }) });
  const identity = { type: 'client', token: 'fixture-device' };
  const admitted = await work.prepare(identity, 'doc-1', 'fixture-300');
  const capability = await work.issue(identity, admitted.workId);
  const instrumented = Object.fromEntries(['authorize','snapshot','dispatch','result','authorizeSearch','searchSnapshot','dispatchSearch','searchResult'].map((name) => [name, async (...args) => { try { const value = await work[name](...args); console.log('host', name, 'ok'); return value; } catch (error) { if (name === 'dispatch') { try { const body = JSON.parse(Buffer.from(args[3], 'base64')); console.log('dispatch shape', JSON.stringify({model:body.model,inputLengths:body.input?.map(v=>v.length),keys:Object.keys(body)})); } catch {} } console.log('host', name, 'error', error?.code || error?.message); throw error; } }]));
  authServer = await createKnowledgeAuthorizationServer(instrumented);
  const options = await work.pilotConfiguration(authServer.url, authServer.workerKeyFile);
  await start(options);
  const client = createEmbeddedKnowledgeClient({ baseUrl, apiKey: provision.apiKey, tenantId: provision.tenantId });
  const registration = await work.workerRequest(identity, admitted.workId, 'ingest');
  const withoutProof = await fetch(baseUrl + registration.path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': provision.apiKey, 'X-Tenant-ID': String(provision.tenantId) }, body: registration.body });
  if (withoutProof.ok) throw new Error('shared tenant key bypassed proof');
  const tampered = await fetch(baseUrl + registration.path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': provision.apiKey, 'X-Tenant-ID': String(provision.tenantId), 'X-WeKnora-Managed-Proof': registration.proof }, body: registration.body + ' ' });
  if (tampered.ok) throw new Error('altered signed body accepted');
  const registrationResponse = await fetch(baseUrl + registration.path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': provision.apiKey, 'X-Tenant-ID': String(provision.tenantId), 'X-WeKnora-Managed-Proof': registration.proof }, body: registration.body });
  const registrationJSON = await registrationResponse.json();
  if (!registrationResponse.ok) throw new Error('registration proof failed: ' + JSON.stringify(registrationJSON));
  const created = registrationJSON.data;
  const registrationReplay = await fetch(baseUrl + registration.path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': provision.apiKey, 'X-Tenant-ID': String(provision.tenantId), 'X-WeKnora-Managed-Proof': registration.proof }, body: registration.body });
  if (registrationReplay.ok) throw new Error('registration proof replay accepted');
  if (!created?.id) throw new Error('registration returned no knowledge ID');
  let current;
  for (let i=0;i<30;i++) {
    const statusRequest = await work.workerRequest(identity, admitted.workId, 'status');
    const statusResponse = await fetch(baseUrl + statusRequest.path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': provision.apiKey, 'X-Tenant-ID': String(provision.tenantId), 'X-WeKnora-Managed-Proof': statusRequest.proof }, body: statusRequest.body });
    if (!statusResponse.ok) throw new Error('managed status authorization failed');
    current = (await statusResponse.json()).data;
    if (['completed','failed'].includes(current?.parse_status)) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (current?.parse_status !== 'completed') throw new Error('index not ready');
  const search = await work.prepareSearch(identity, admitted.workId, query, 'search-fixture');
  const searchRequest = await work.workerRequest(identity, search.workId, 'search');
  const response = await fetch(baseUrl + searchRequest.path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': provision.apiKey, 'X-Tenant-ID': String(provision.tenantId), 'X-WeKnora-Managed-Proof': searchRequest.proof }, body: searchRequest.body });
  const searchResponse = await response.json();
  const replay = await fetch(baseUrl + searchRequest.path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': provision.apiKey, 'X-Tenant-ID': String(provision.tenantId), 'X-WeKnora-Managed-Proof': searchRequest.proof }, body: searchRequest.body });
  if (replay.ok) throw new Error('search proof replay accepted');
  console.log('search', response.status, 'results', searchResponse.data?.length, 'rerankApplied', searchResponse.meta?.rerank?.applied, 'attempts', attempts, 'reranks', reranks, 'replay', replay.status);
  if (!response.ok || !searchResponse.data?.length || attempts !== 2 || reranks !== 1 || unavailableRerankResult) throw new Error('search acceptance or read-only result recovery failed');
  if (dispatchedBody?.input?.[0] !== filename + '\n' + sample || queryBody?.input?.[0] !== query || rerankBody?.input?.query !== query || rerankBody?.input?.documents?.length !== 1 || rerankBody.input.documents[0] !== filename + '\n\n' + sample) throw new Error('worker model inputs differ from authorized bytes');
  const selected = searchResponse.data[0];
  if (selected.knowledge_id !== created.id || selected.content !== sample) throw new Error('search scope mismatch');
  let chatCalls = 0; let observedContext = false;
  const chatServer = http.createServer(async (req, res) => {
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ call_id: 'answer-1', status: 'SETTLED' })); return; }
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw); chatCalls++;
    observedContext = body.messages?.some(message => message.content?.includes(selected.content) && message.content?.includes(filename));
    if (req.url !== '/platform/v1/chat/completions' || !observedContext || req.headers['idempotency-key'] !== 'answer-1') { res.writeHead(400); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: `The authorized document contains the fixture text (${filename}).` } }] })}\n\ndata: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110}}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => chatServer.listen(0, '127.0.0.1', resolve));
  const chatOrigin = `http://127.0.0.1:${chatServer.address().port}`;
  account.request = async (_identity, target, init) => { const body = JSON.parse(init.body); return { id:'mock-grant', token:'mock-chat-token', actor_id:'actor-a', account_id:'account-a', origin_product_id:'superwagie', task_id:body.task_id, models:body.models, expires_at:new Date(Date.now()+60000).toISOString() }; };
  const session = { id:'ses_pilot', model:{ providerID:'unihub', id:'fixture-chat' } };
  const chat = await createPlatformModelRuntime({ dataDir: path.join(dir,'chat'), instanceDir:path.join(dir,'run'), env:{ OPENCHAMBER_UNIHUB_GATEWAY_URL:`${chatOrigin}/platform/v1`, OPENCHAMBER_UNIHUB_MODELS:JSON.stringify([{ id:'fixture-chat', name:'Fixture chat', context:8192, maxOutput:100 }]) }, getAccountRuntime:()=>account, readExecution:async()=>({ promptID:'msg_pilot', idle:null, model:session.model }), isManaged:()=>true, enterprise:()=>false });
  try {
    await chat.materializePlugin(); await chat.admit(identity,session,'msg_pilot');
    const childEnv = chat.createChildEnv();
    const headers = { authorization:`Bearer ${childEnv.OPENCHAMBER_UNIHUB_PROXY_TOKEN}`, 'content-type':'application/json' };
    const prepared = await fetch(childEnv.OPENCHAMBER_UNIHUB_PROXY_URL + '/prepare', { method:'POST', headers, body:JSON.stringify({ sessionID:'ses_pilot', callID:'answer-1', model:'fixture-chat', kind:'primary' }) });
    if (!prepared.ok) throw new Error('chat prepare failed');
    const answer = await fetch(childEnv.OPENCHAMBER_UNIHUB_PROXY_URL + '/v1/chat/completions', { method:'POST', headers:{ ...headers, 'x-unihub-session-id':'ses_pilot', 'idempotency-key':'answer-1' }, body:JSON.stringify({ model:'fixture-chat', stream:true, messages:[{ role:'user', content:`Question: What does the document contain?\nSource ${filename}: ${selected.content}` }] }) });
    const stream = await answer.text();
    if (!answer.ok || !stream.includes('authorized document contains') || !stream.includes(filename) || chatCalls !== 1 || !observedContext) throw new Error('mock answer failed');
    console.log('answer', answer.status, 'mockChatCalls', chatCalls, 'authorizedSource', observedContext);
  } finally { await chat.close(); chatServer.closeAllConnections(); await new Promise(resolve=>chatServer.close(resolve)); }
  const workerLogs = logs + await fs.readFile(env.LOG_PATH, 'utf8');
  if (workerLogs.includes(registration.proof) || workerLogs.includes(searchRequest.proof) || workerLogs.includes(JSON.parse(registration.body).capability) || workerLogs.includes(JSON.parse(searchRequest.body).capability) || workerLogs.includes(sample.slice(0, 30))) throw new Error('sensitive material in worker logs');
  console.log('worker logs sensitive data absent');
  console.log(JSON.stringify({ root: dir, registration: 'ok', documentBytes: Buffer.byteLength(sample), parseStatus: current?.parse_status, providerAttempts: attempts, queryAndRerankMatch: true, inputMatches: dispatchedBody?.input?.[0] === filename + '\n' + sample, resultStored: current?.parse_status === 'completed', note: 'isolated fake authority and fake gateway, no production or paid calls' }));
  if (current?.parse_status !== 'completed' || attempts !== 2 || reranks !== 1) { console.error(logs.slice(-6000)); process.exitCode=1; }
} catch (error) { console.error('pilot failed', error?.stack ?? String(error), logs.slice(-6000)); process.exitCode=1; }
finally { await authServer?.close(); await stop(); }
