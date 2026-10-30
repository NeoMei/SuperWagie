import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import constants from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

import { createCompletionJournal, bindingSchema, storageSchema, discoverSchema, useSchema, indexBindingFields, parseCanonicalJSON, parseStrictJSON, verifyCompletionReply, verifySearchReply } from './managed-completion.js';

import { MAX_FILE_BYTES, shouldIndex } from './scan.js';
import { MANAGED_TEXT_EMBEDDING, managedEmbeddingCatalogEntry } from './managed-embedding-catalog.js';
import { createManagedKeyStorage } from './managed-key-storage.js';

const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const fail = (code, status) => { throw Object.assign(new Error(code), { code, status }); };
const equalScope = (a, b) => a?.actingUserId === b?.actingUserId && a?.billingAccountId === b?.billingAccountId && a?.authSession === b?.authSession && a?.expiresAt === b?.expiresAt && b.expiresAt > Date.now();
const secretFile = 'key-v1';
const keyStorage = createManagedKeyStorage();
const MAX_SNAPSHOT_BYTES = Math.min(MAX_FILE_BYTES, 8 * 1024 * 1024);
// This bounded pilot supports one plain CJK or ASCII text chunk only.
const pilotText = (text, multiline = false) => z.string().safeParse(text).success && (multiline ? /^[\n\x20-\x7e\u3400-\u9fff\u3000-\u303f\uff01-\uff5e]+$/u : /^[\x20-\x7e\u3400-\u9fff\u3000-\u303f\uff01-\uff5e]+$/u).test(text) && !text.includes('#') && (multiline ? text.trim().length > 0 : text === text.trim());
const pilotFilename = (name) => /^[A-Za-z0-9._ \-\u3400-\u9fff]+\.txt$/u.test(name);

async function keyFor(directory) {
  await keyStorage.prepareDirectory(directory);
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) fail('knowledge_work_storage_unavailable', 503);
  const filename = path.join(directory, secretFile);
  let file;
  try {
    const entries = await fs.readdir(directory);
    if (!entries.includes(secretFile) && entries.some((entry) => entry.startsWith('kbw_') || entry.startsWith('snapshot_kbw_') || entry.startsWith('completion-') || entry.startsWith('storage-anchor'))) fail('knowledge_work_storage_unavailable', 503);
    try {
      file = await keyStorage.createFile(filename);
      await file.writeFile(crypto.randomBytes(32));
      await file.sync();
      await file.close(); file = null;
      if (process.platform !== 'win32') { const parent = await fs.open(directory, 'r'); try { await parent.sync(); } finally { await parent.close(); } }
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await keyStorage.verifyFile(filename);
    const keyHandle = await fs.open(filename, constants.constants.O_RDONLY | constants.constants.O_NOFOLLOW);
    try {
      const keyInfo = await keyHandle.stat();
      if (!keyInfo.isFile() || keyInfo.size !== 32 || (process.platform !== 'win32' && (keyInfo.mode & 0o077) !== 0)) fail('knowledge_work_storage_unavailable', 503);
      const key = await keyHandle.readFile();
      if (key.length !== 32) fail('knowledge_work_storage_unavailable', 503);
      return key;
    } finally { await keyHandle.close(); }
  } finally { await file?.close(); }
}

async function documentDigest(document, key) {
  if (!document || !z.string().safeParse(document.root).success || !path.isAbsolute(document.root) || !z.string().safeParse(document.relPath).success || document.relPath.includes('\\') || path.isAbsolute(document.relPath)) fail('knowledge_work_document_invalid', 409);
  const segments = document.relPath.split('/');
  if (segments.some((value) => !value || value === '.' || value === '..') || !shouldIndex(document.relPath).ok) fail('knowledge_work_document_invalid', 409);
  const root = await fs.realpath(document.root);
  let target = root;
  for (const segment of segments) {
    target = path.join(target, segment);
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) fail('knowledge_work_document_invalid', 409);
  }
  const real = await fs.realpath(target);
  if (real !== target || !real.startsWith(root + path.sep)) fail('knowledge_work_document_invalid', 409);
  const file = await fs.open(target, constants.constants.O_RDONLY | constants.constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 1 || before.size > MAX_SNAPSHOT_BYTES) fail('knowledge_work_document_invalid', 409);
    const hash = crypto.createHmac('sha256', key).update('knowledge-work-content-v1\0');
    const buffer = Buffer.alloc(64 * 1024);
    const chunks = []; let bytes = 0;
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > MAX_SNAPSHOT_BYTES) fail('knowledge_work_document_invalid', 409);
      const chunk = Buffer.from(buffer.subarray(0, bytesRead));
      hash.update(chunk); chunks.push(chunk);
    }
    const after = await file.stat();
    const targetInfo = await fs.lstat(target);
    if (targetInfo.isSymbolicLink() || targetInfo.dev !== after.dev || targetInfo.ino !== after.ino || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || bytes !== after.size || await fs.realpath(target) !== real) fail('knowledge_work_document_changed', 409);
    return { content: hash.digest('hex'), source: crypto.createHmac('sha256', key).update('knowledge-work-source-v1\0').update(real).digest('hex'), bytes: Buffer.concat(chunks) };
  } catch (error) {
    if (error?.status) throw error;
    fail('knowledge_work_document_invalid', 409);
  } finally { await file.close(); }
}

async function readSnapshot(directory, workId, key) {
  const file = await fs.open(path.join(directory, `snapshot_${workId}`), constants.constants.O_RDONLY | constants.constants.O_NOFOLLOW);
  let data;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 29 || info.size > MAX_SNAPSHOT_BYTES + 28) fail('knowledge_work_storage_unavailable', 503);
    data = await file.readFile();
  } finally { await file.close(); }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
    decipher.setAAD(Buffer.from(`snapshot:${workId}`)); decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]);
  } catch { fail('knowledge_work_storage_unavailable', 503); }
}

async function readWorkRecord(directory, workId, key) {
  const file = await fs.open(path.join(directory, workId), constants.constants.O_RDONLY | constants.constants.O_NOFOLLOW);
  let bytes;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 29 || info.size > 8192) fail('knowledge_work_storage_unavailable', 503);
    bytes = await file.readFile();
  } finally { await file.close(); }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(workId)); decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'));
  } catch { fail('knowledge_work_storage_unavailable', 503); }
}

async function workerKeyFile(directory, key, name) {
  const filename = path.join(directory, `${name}-v1.key`);
  const names = await fs.readdir(directory);
  if (!names.includes(`${name}-v1.key`) && names.some((entry) => entry.startsWith('kbw_') || entry === 'completion-journal-v1')) fail('knowledge_work_storage_unavailable', 503);
  const derived = crypto.createHmac('sha256', key).update(`knowledge-work-worker-${name}-v1\0`).digest();
  let file;
  try {
    try {
      file = await keyStorage.createFile(filename);
      await file.writeFile(derived); await file.sync(); await file.close(); file = null;
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await keyStorage.verifyFile(filename);
    const existing = await fs.open(filename, constants.constants.O_RDONLY | constants.constants.O_NOFOLLOW);
    try {
      const info = await existing.stat();
      if (!info.isFile() || info.size !== 32 || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) fail('knowledge_work_storage_unavailable', 503);
      const bytes = await existing.readFile();
      if (bytes.length !== 32 || !crypto.timingSafeEqual(bytes, derived)) fail('knowledge_work_storage_unavailable', 503);
    } finally { await existing.close(); }
    return filename;
  } finally { await file?.close(); }
}

async function saveSnapshot(directory, workId, key, plaintext) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(`snapshot:${workId}`));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const sealed = Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
  const temp = path.join(directory, `.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temp, 'wx', 0o600);
    await handle.writeFile(sealed); await handle.sync(); await handle.close(); handle = null;
    try { await fs.link(temp, path.join(directory, `snapshot_${workId}`)); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await readSnapshot(directory, workId, key);
      if (!existing.equals(plaintext)) fail('knowledge_work_conflict', 409);
    }
  } finally { await handle?.close(); await fs.rm(temp, { force: true }); }
}

async function readDispatch(directory, workId, key) {
  const file = await fs.open(path.join(directory, `dispatch_${workId}`), constants.constants.O_RDONLY | constants.constants.O_NOFOLLOW);
  let data;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size < 29 || info.size > 8192) fail('knowledge_work_storage_unavailable', 503);
    data = await file.readFile();
  } finally { await file.close(); }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
    decipher.setAAD(Buffer.from(`dispatch:${workId}`)); decipher.setAuthTag(data.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8'));
  } catch { fail('knowledge_work_storage_unavailable', 503); }
}

async function claimDispatch(directory, workId, key, record) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(`dispatch:${workId}`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(record)), cipher.final()]);
  const sealed = Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
  const temp = path.join(directory, `.${crypto.randomUUID()}.tmp`);
  let handle; let fresh = false;
  try {
    handle = await fs.open(temp, 'wx', 0o600);
    await handle.writeFile(sealed); await handle.sync(); await handle.close(); handle = null;
    try { await fs.link(temp, path.join(directory, `dispatch_${workId}`)); fresh = true; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (JSON.stringify(await readDispatch(directory, workId, key)) !== JSON.stringify(record)) fail('knowledge_work_conflict', 409);
    }
    if (process.platform !== 'win32') { const parent = await fs.open(directory, 'r'); try { await parent.sync(); } finally { await parent.close(); } }
  } finally { await handle?.close(); await fs.rm(temp, { force: true }); }
  return fresh;
}

export function createManagedWorkAdmission({ dataDir, enabled = () => false, authorizeOwner, getAccountRuntime, resolveDocument, resolveModelBinding, resolveNamespace, instanceId = 'default' }) {
  if (!dataDir || ![enabled, authorizeOwner, getAccountRuntime, resolveDocument, resolveModelBinding, resolveNamespace].every((fn) => typeof fn === 'function')) throw new TypeError('managed work dependencies required');
  const directory = path.join(dataDir, 'knowledge-managed-work');
  const hostBootId = crypto.randomBytes(32).toString('hex');
  const active = new Map();
  let callbackKey; let tail = Promise.resolve();
  const serial = (action) => { const result = tail.then(action); tail = result.catch(() => {}); return result; };
  const key = () => keyFor(directory);
  let completionJournal;
  let journalKey;
  const journal = async () => {
    const secret = await key();
    if (!completionJournal) {
      journalKey = secret;
      completionJournal = createCompletionJournal(directory, secret);
    } else if (!crypto.timingSafeEqual(journalKey, secret)) fail('knowledge_work_storage_unavailable', 503);
    return completionJournal;
  };
  const derive = (secret, domain, value) => crypto.createHmac('sha256', secret).update(`${domain}\0`).update(value).digest('hex');
  const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
  const sign = async (kind, payload) => {
    const seed = derive(await key(), 'knowledge-work-ed25519-v1', '');
    const privateKey = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed, 'hex')]), format: 'der', type: 'pkcs8' });
    const encoded = `${kind}.host-v1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
    return `${encoded}.${crypto.sign(null, Buffer.from(encoded), privateKey).toString('base64url')}`;
  };
  const saveRecord = async (workId, value, secret) => {
    const nonce = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', secret, nonce);
    cipher.setAAD(Buffer.from(workId)); const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    const temporary = path.join(directory, `.${crypto.randomUUID()}.tmp`);
    const file = await fs.open(temporary, 'wx', 0o600);
    try { await file.writeFile(Buffer.concat([nonce, cipher.getAuthTag(), encrypted])); await file.sync(); } finally { await file.close(); }
    try { await fs.link(temporary, path.join(directory, workId)); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await readWorkRecord(directory, workId, secret);
      if (JSON.stringify({ ...existing, expiresAt: 0 }) !== JSON.stringify({ ...value, expiresAt: 0 })) fail('knowledge_work_conflict', 409);
    } finally { await fs.rm(temporary, { force: true }); }
    if (process.platform !== 'win32') { const parent = await fs.open(directory, 'r'); try { await parent.sync(); } finally { await parent.close(); } }
  };
  const capture = async (identity, context, expected) => {
    if (!enabled() || !identity) fail('knowledge_work_auth_required', 401);
    const account = getAccountRuntime(); const actor = account?.actor(identity); const principal = account?.instancePrincipal(identity);
    if (!actor?.actingUserId || !actor.billingAccountId || !actor.authSession || actor.expiresAt <= Date.now() || !principal?.issuer || principal.userId !== actor.actingUserId || authorizeOwner(principal) !== true) fail('knowledge_work_owner_forbidden', 403);
    if (context?.actorFence && !equalScope(context.actorFence, actor)) fail('knowledge_work_auth_changed', 409);
    if (expected && !equalScope(expected, actor)) fail('knowledge_work_auth_changed', 409);
    const commerce = account.captureCommerceSession(identity);
    if (commerce.actingUserId !== actor.actingUserId || commerce.billingAccountId !== actor.billingAccountId || !commerce.serviceId) fail('knowledge_work_auth_changed', 409);
    const scope = await resolveNamespace(identity, context);
    if (!scope?.projectId || !scope?.spaceId) fail('knowledge_work_scope_required', 403);
    const tuple = [1, principal.issuer, commerce.serviceId, instanceId, actor.actingUserId, actor.billingAccountId, scope.projectId, scope.spaceId];
    const secret = await key(); const namespace = derive(secret, 'knowledge-namespace-v1', JSON.stringify(tuple));
    if (!equalScope(actor, account.actor(identity)) || authorizeOwner(account.instancePrincipal(identity)) !== true) fail('knowledge_work_auth_changed', 409);
    return { actor, principal, account, commerce, tuple, namespace, scope };
  };
  const assertRoute = (route, current, expected) => {
    if (!route || route.instanceId !== instanceId || route.actorId !== current.actor.actingUserId || route.accountId !== current.actor.billingAccountId || route.model !== MANAGED_TEXT_EMBEDDING.publicModel || route.wireOperation !== 'embeddings.create' || !/^[a-f0-9]{64}$/.test(route.policyDigest ?? '') || !/^[a-f0-9]{64}$/.test(route.routeGeneration ?? '') || JSON.stringify(route.embeddingSpace) !== JSON.stringify({ provider: 'aliyun', model: 'text-embedding-v4', version: 'v4', dimensions: 1024, input_semantics: 'text' }) || (expected && (route.policyDigest !== expected.policyDigest || route.routeGeneration !== expected.routeGeneration))) fail('knowledge_work_space_unverified', 409);
  };
  const currentRecord = async (identity, context, workId, expectedActor, readRoute = true) => {
    const current = await capture(identity, context, expectedActor); const secret = await key();
    const record = await readWorkRecord(directory, workId, secret);
    if (record.namespace !== current.namespace || JSON.stringify(record.namespaceTuple) !== JSON.stringify(current.tuple)) fail('knowledge_work_scope_changed', 403);
    const revisions = [...(await (await journal()).load()).pending.values()].filter((entry) => entry.documentId === record.document && entry.binding.namespace_id === record.namespace);
    if (revisions.some((entry) => entry.binding.index_revision > record.indexRevision)) fail('knowledge_work_revision_changed', 409);
    if (readRoute) {
      const route = await current.account.readCurrentKnowledgeRoute(identity, { accountId: record.payer, model: record.model, wireOperation: 'embeddings.create', expectedPolicyDigest: record.policyDigest });
      assertRoute(route, current, record);
    }
    const document = await resolveDocument(record.document, current.scope);
    if (!document || document.libraryId !== record.library || document.tenantId !== record.tenant || document.knowledgeBaseId !== record.knowledgeBase) fail('knowledge_work_document_changed', 409);
    const bytes = await documentDigest(document, secret);
    if (bytes.content !== record.content || bytes.source !== record.source || digest(bytes.bytes) !== record.snapshotSHA256) fail('knowledge_work_document_changed', 409);
    await capture(identity, context, current.actor);
    return { ...current, record, document, bytes: bytes.bytes };
  };
  const activate = async (identity, context, workId) => {
    const current = await currentRecord(identity, context, workId);
    if (!active.has(workId) && active.size >= 4096) fail('knowledge_work_capacity', 503);
    active.set(workId, { identity, context, actor: current.actor }); return current;
  };
  const liveRecord = async (workId) => {
    const live = active.get(workId); if (!live) fail('knowledge_work_auth_required', 401);
    return { ...await currentRecord(live.identity, live.context, workId, live.actor), live };
  };
  const prepare = (identity, documentId, idempotencyKey, context, expectedSnapshotSHA256) => serial(async () => {
    if (!idPattern.test(documentId ?? '') || !idPattern.test(idempotencyKey ?? '')) fail('knowledge_work_request_invalid', 400);
    const current = await capture(identity, context); const secret = await key();
    const model = managedEmbeddingCatalogEntry(await resolveModelBinding('embedding'));
    if (!model) fail('knowledge_work_model_unavailable', 503);
    const document = await resolveDocument(documentId, current.scope);
    if (!document || document.id !== documentId || !idPattern.test(document.libraryId ?? '') || !Number.isSafeInteger(document.tenantId) || document.tenantId < 1 || !idPattern.test(document.knowledgeBaseId ?? '')) fail('knowledge_work_document_invalid', 409);
    const frozen = await documentDigest(document, secret); const text = frozen.bytes.toString('utf8');
    if (expectedSnapshotSHA256 && expectedSnapshotSHA256 !== digest(frozen.bytes)) fail('knowledge_work_document_changed', 409);
    if (frozen.bytes.length > 300 || !Buffer.from(text).equals(frozen.bytes) || !pilotText(text, true) || !pilotFilename(path.basename(document.relPath))) fail('knowledge_work_plan_unsupported', 409);
    const state = await (await journal()).load();
    const previous = [...state.pending.values()].filter((entry) => entry.documentId === documentId && entry.binding.namespace_id === current.namespace);
    const latest = previous.sort((a, b) => b.binding.index_revision - a.binding.index_revision)[0];
    const indexRevision = latest?.snapshotSHA256 === digest(frozen.bytes) ? latest.binding.index_revision : (latest?.binding.index_revision ?? 0) + 1;
    // A crash after preflight reuses the same revision task even if the UI lost
    // its request ID. A different request ID cannot escape an unresolved call.
    const workId = `kbw_${derive(secret, 'knowledge-work-id-v2', JSON.stringify([current.namespace, documentId, indexRevision, digest(frozen.bytes)]))}`;
    // A replay must preserve its pin/task and cannot issue another paid preflight.
    try {
      const existing = await readWorkRecord(directory, workId, secret);
      if (existing.content !== frozen.content || existing.source !== frozen.source || existing.namespace !== current.namespace) fail('knowledge_work_conflict', 409);
      await currentRecord(identity, context, workId, current.actor);
      return { status: 'prepared', workId, dispatchable: false };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous.some((entry) => !state.committed.has(entry.binding.work_id))) fail('knowledge_work_outcome_unknown', 409);
    const taskId = `ktask_${derive(secret, 'knowledge-work-task-v1', workId)}`;
    const route = await current.account.preflightKnowledgeRoute(identity, { taskId, model: model.publicModel, wireOperation: 'embeddings.create' });
    assertRoute(route, current); await capture(identity, context, current.actor);
    const hex = derive(secret, 'knowledge-work-id-v1', workId).slice(0, 32);
    const knowledgeId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
    const record = { version: 2, namespace: current.namespace, namespaceTuple: current.tuple, actor: current.actor.actingUserId, payer: current.actor.billingAccountId, library: document.libraryId, document: document.id, tenant: document.tenantId, knowledgeBase: document.knowledgeBaseId, knowledgeId, indexRevision, taskId, grantId: `kgrant_${derive(secret, 'knowledge-work-grant-v1', workId)}`, model: model.publicModel, embeddingSpace: model.space, policyDigest: route.policyDigest, routeGeneration: route.routeGeneration, source: frozen.source, content: frozen.content, snapshotSHA256: digest(frozen.bytes), expiresAt: Math.min(Date.now() + 600_000, current.actor.expiresAt) };
    await saveSnapshot(directory, workId, secret, frozen.bytes); await saveRecord(workId, record, secret); await capture(identity, context, current.actor);
    return { status: 'prepared', workId, dispatchable: false };
  });
  const getBinding = async (workId, record) => {
    const state = await (await journal()).load(); const pending = state.pending.get(workId);
    if (pending) return pending.binding;
    if (!state.anchor) fail('knowledge_work_storage_unavailable', 503);
    return bindingSchema.parse({ namespace_id: record.namespace, ...state.anchor, embedding_policy_digest: record.policyDigest, opaque_pin: record.policyDigest, route_generation: record.routeGeneration, index_revision: record.indexRevision, tenant_id: record.tenant, actor_id: record.actor, account_id: record.payer, task_id: record.taskId, work_id: workId, grant_id: record.grantId, knowledge_base_id: record.knowledgeBase, knowledge_id: record.knowledgeId, purpose: 'document-ingest', input_digest: record.content, embedding_model: record.model, embedding_space: record.embeddingSpace });
  };
  const paidClaims = async (workId, current) => {
    const now = Math.floor(Date.now() / 1000); const expires = Math.min(Math.floor(current.record.expiresAt / 1000), Math.floor(current.actor.expiresAt / 1000));
    if (expires <= now) fail('knowledge_work_expired', 409);
    return { issuer: 'superwagie-knowledge-v1', audience: 'weknora', ...await getBinding(workId, current.record), issued_at: now, expires_at: expires };
  };
  const issue = async (identity, workId, context) => {
    const current = await activate(identity, context, workId);
    return { token: await sign('weknora-cap-v1', await paidClaims(workId, current)), model: current.record.model };
  };
  const authorize = async (workId, nonce) => {
    if (!/^[a-f0-9]{64}$/.test(nonce ?? '')) fail('knowledge_work_request_invalid', 400);
    const claims = await paidClaims(workId, await liveRecord(workId)); const now = Math.floor(Date.now() / 1000);
    return sign('weknora-auth-v1', { ...claims, nonce, issued_at: now, expires_at: Math.min(now + 30, claims.expires_at) });
  };
  const decode = (token) => JSON.parse(Buffer.from(token.split('.')[2], 'base64url').toString('utf8'));
  const snapshot = async (workId, nonce) => {
    const claims = decode(await authorize(workId, nonce)); const bytes = await readSnapshot(directory, workId, await key());
    await liveRecord(workId);
    return { assertion: await sign('weknora-snapshot-v1', { ...claims, content_sha256: digest(bytes) }), content: bytes.toString('base64') };
  };
  const dispatch = async (workId, nonce, callId, content) => {
    if (!/^wk_[a-f0-9]{60}$/.test(callId ?? '')) fail('knowledge_work_request_invalid', 400);
    const current = await liveRecord(workId); await authorize(workId, nonce);
    let input; try { input = parseStrictJSON(Buffer.from(content, 'base64')); } catch { fail('knowledge_work_request_invalid', 400); }
    const schema = z.object({ model: z.literal(current.record.model), input: z.tuple([z.literal(`${path.basename(current.document.relPath).trim()}\n${current.bytes.toString('utf8').trim()}`)]), encoding_format: z.literal('float').optional(), dimensions: z.literal(1024).optional() }).strict();
    if (!schema.safeParse(input).success) fail('knowledge_work_plan_unsupported', 409);
    const body = Buffer.from(JSON.stringify({ model: current.record.model, input: input.input, dimensions: 1024, encoding_format: 'float' }));
    const record = { work: workId, call: callId, task: current.record.taskId, actor: current.record.actor, payer: current.record.payer, model: current.record.model, digest: digest(body) };
    const pending = (await (await journal()).load()).pending.get(workId);
    if (!pending) fail('knowledge_work_storage_unavailable', 503);
    const fresh = await claimDispatch(directory, workId, await key(), record);
    await liveRecord(workId);
    if (fresh) await current.account.dispatchKnowledgeEmbeddingPinned(current.live.identity, { taskId: record.task, callId, model: record.model, policyDigest: current.record.policyDigest, body });
    return { status: 'submitted' };
  };
  const result = async (workId, nonce, callId) => {
    const current = await liveRecord(workId); const claims = decode(await authorize(workId, nonce));
    const dispatch = await readDispatch(directory, workId, await key());
    if (dispatch.call !== callId || dispatch.task !== current.record.taskId) fail('knowledge_work_auth_changed', 409);
    const { rawBytes, receipt } = await current.account.readKnowledgeResultWithEvidence(current.live.identity, { taskId: dispatch.task, callId, model: current.record.model, wireOperation: 'embeddings.create' });
    if (receipt.instanceId !== instanceId || receipt.actorId !== current.record.actor || receipt.accountId !== current.record.payer || receipt.taskId !== dispatch.task || receipt.callId !== callId || receipt.model !== current.record.model || receipt.wireOperation !== 'embeddings.create' || receipt.policyDigest !== current.record.policyDigest || receipt.routeGeneration !== current.record.routeGeneration || receipt.contentSha256 !== digest(rawBytes) || !receipt.producerCredentialId || !Number.isSafeInteger(receipt.attemptId)) fail('knowledge_work_result_invalid', 503);
    await liveRecord(workId);
    return { assertion: await sign('weknora-result-v1', { attempt_id: String(receipt.attemptId), producer_credential_id: receipt.producerCredentialId, ...claims, call_id: callId, model: current.record.model, operation: 'embedding', wire_operation: 'embeddings.create', status: 'SETTLED', content_sha256: receipt.contentSha256 }), content: rawBytes.toString('base64') };
  };
  const completedScope = async (workId, purpose) => {
    const current = await liveRecord(workId); const state = await (await journal()).load(); const pending = state.pending.get(workId);
    const live = active.get(workId); const now = Math.floor(Date.now() / 1000); const times = { issued_at: now, expires_at: Math.min(now + 30, Math.floor(current.actor.expiresAt / 1000)) };
    if (purpose === 'storage') return storageSchema.parse({ version: 'managed-storage-v1', namespace_id: current.record.namespace, tenant_id: current.record.tenant, actor_id: current.record.actor, account_id: current.record.payer, knowledge_base_id: current.record.knowledgeBase, work_id: workId, host_boot_id: hostBootId, ...times });
    if (!pending || !live.workerBootId) fail('knowledge_work_storage_unavailable', 503);
    if (purpose === 'discover') return discoverSchema.parse({ version: 'completed-index-discover-v1', purpose: 'completion_discover', binding: pending.binding, snapshot_sha256: pending.snapshotSHA256, host_boot_id: hostBootId, worker_boot_id: live.workerBootId, ...times });
    const completed = state.committed.get(workId); if (!completed) fail('knowledge_work_not_ready', 409);
    const b = pending.binding;
    return useSchema.parse({ version: 'completed-index-use-v1', purpose: 'completed_index_read', namespace_id: b.namespace_id, tenant_id: b.tenant_id, actor_id: b.actor_id, account_id: b.account_id, knowledge_base_id: b.knowledge_base_id, knowledge_id: b.knowledge_id, work_id: b.work_id, storage_id: b.storage_id, storage_generation: b.storage_generation, index_revision: b.index_revision, completion_digest: completed.completion.completion_digest, host_boot_id: hostBootId, worker_boot_id: live.workerBootId, ...times });
  };
  const authorizeCompleted = async (scope, nonce) => {
    const kind = scope?.version === 'managed-storage-v1' ? 'storage' : scope?.version === 'completed-index-discover-v1' ? 'discover' : scope?.version === 'completed-index-use-v1' ? 'use' : null;
    if (!kind || !/^[a-f0-9]{64}$/.test(nonce ?? '')) fail('knowledge_work_request_invalid', 400);
    const parsed = (kind === 'storage' ? storageSchema : kind === 'discover' ? discoverSchema : useSchema).parse(scope);
    const workId = kind === 'discover' ? parsed.binding.work_id : parsed.work_id;
    const expected = await completedScope(workId, kind); const seconds = Math.floor(Date.now() / 1000);
    if (parsed.expires_at <= seconds || parsed.issued_at > seconds || parsed.expires_at - parsed.issued_at > 30 || JSON.stringify({ ...parsed, issued_at: 0, expires_at: 0 }) !== JSON.stringify({ ...expected, issued_at: 0, expires_at: 0 })) fail('knowledge_work_auth_changed', 409);
    return sign(kind === 'storage' ? 'managed-storage-auth-v1' : kind === 'discover' ? 'completed-index-discover-auth-v1' : 'completed-index-auth-v1', { scope: parsed, nonce, issued_at: seconds, expires_at: Math.min(seconds + 30, parsed.expires_at) });
  };
  const workerRequest = async (identity, workId, purpose, context) => {
    if (!['storage', 'ingest', 'discover', 'use', 'search'].includes(purpose)) fail('knowledge_work_request_invalid', 400);
    let scope; let current;
    if (purpose === 'search') {
      scope = decode((await issueSearch(identity, workId, context)).token); current = await liveSearch(workId);
    } else {
      const previous = active.get(workId); current = await activate(identity, context, workId);
      if (previous?.workerBootId) active.get(workId).workerBootId = previous.workerBootId;
      scope = purpose === 'ingest' ? await paidClaims(workId, current) : await completedScope(workId, purpose);
    }
    const kind = purpose === 'ingest' ? 'weknora-cap-v1' : purpose === 'search' ? 'weknora-search-v1' : scope.version;
    const capability = await sign(kind, scope);
    const kb = scope.knowledge_base_id ?? scope.binding?.knowledge_base_id;
    const requestPath = `/api/v1/knowledge-bases/${kb}/${purpose === 'ingest' ? 'knowledge/managed-ref' : purpose === 'search' ? 'managed-hybrid-search' : 'knowledge/managed-status'}`;
    const body = JSON.stringify(purpose === 'ingest' ? { path: path.join(await fs.realpath(current.document.root), current.document.relPath), capability } : { capability });
    if (purpose === 'ingest') await (await journal()).pending({ binding: await getBinding(workId, current.record), snapshotSHA256: current.record.snapshotSHA256, namespaceTuple: current.record.namespaceTuple, documentId: current.record.document });
    const seconds = Math.floor(Date.now() / 1000); const nonce = crypto.randomBytes(32).toString('hex'); const b = scope.binding ?? scope;
    const proof = await sign('weknora-request-v1', { issuer: 'superwagie-knowledge-v1', audience: 'weknora', method: 'POST', path: requestPath, body_sha256: digest(body), nonce, work_id: workId, actor_id: b.actor_id, account_id: b.account_id, issued_at: seconds, expires_at: Math.min(seconds + 30, scope.expires_at) });
    await currentRecord(identity, context, purpose === 'search' ? current.search.indexWorkId : workId, current.actor);
    return { path: requestPath, body, proof, scope, nonce, purpose };
  };
  const acceptResponse = async (workId, request, raw) => {
    await liveRecord(workId);
    const kind = request.purpose === 'storage' ? 'storage' : request.purpose === 'discover' ? 'discovery' : 'completion';
    if (!callbackKey || !['storage', 'discover', 'use'].includes(request.purpose)) fail('knowledge_work_request_invalid', 400);
    const reply = verifyCompletionReply(raw, kind, request, callbackKey);
    await liveRecord(workId);
    if (kind === 'storage') { await (await journal()).anchor(reply); active.get(workId).workerBootId = reply.worker_boot_id; }
    else if (kind === 'discovery') await (await journal()).commit(workId, reply);
    else {
      const prior = (await (await journal()).load()).committed.get(workId);
      if (!prior || prior.completion.reference_digest !== reply.reference_digest) fail('knowledge_work_storage_unavailable', 503);
    }
    await liveRecord(workId);
    return reply;
  };
  const searchCallId = async (workId, operation) => {
    const callKey = crypto.createHmac('sha256', await key()).update('knowledge-work-worker-call-v1\0').digest();
    return `wk_${crypto.createHmac('sha256', callKey).update('managed-journal:call-id:v1\0').update(JSON.stringify([workId, operation, 0])).digest('hex').slice(0, 60)}`;
  };
  const assertSearchRoute = async (identity, context, search, current) => {
    const route = await current.account.readCurrentKnowledgeRoute(identity, { accountId: current.record.payer, model: 'qwen3-rerank', wireOperation: 'rerank.create', expectedPolicyDigest: search.rerankPolicyDigest });
    if (route.instanceId !== instanceId || route.actorId !== current.record.actor || route.accountId !== current.record.payer || route.model !== 'qwen3-rerank' || route.wireOperation !== 'rerank.create' || route.policyDigest !== search.rerankPolicyDigest || route.routeGeneration !== search.rerankRouteGeneration) fail('knowledge_work_space_unverified', 409);
    await capture(identity, context, current.actor);
  };
  const searchLease = async (workId, search) => {
    const prefix = `dispatch_${workId}_lease_`;
    const names = (await fs.readdir(directory)).filter((name) => name.startsWith(prefix)).sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)));
    if (names.length > 128) fail('knowledge_work_capacity', 503);
    const recordDigest = digest(Buffer.from(JSON.stringify(search))); let previousDigest = recordDigest; let expiresAt = search.expiresAt; let issuedAt = 0;
    for (const [index, name] of names.entries()) {
      if (name !== `${prefix}${index + 1}`) fail('knowledge_work_storage_unavailable', 503);
      const lease = await readDispatch(directory, name.slice('dispatch_'.length), await key());
      if (lease.version !== 1 || lease.workId !== workId || lease.recordDigest !== recordDigest || lease.previousDigest !== previousDigest || !Number.isSafeInteger(lease.issuedAt) || !Number.isSafeInteger(lease.expiresAt) || lease.issuedAt < issuedAt || lease.issuedAt > Date.now() || lease.expiresAt <= lease.issuedAt || lease.expiresAt - lease.issuedAt > 600_000) fail('knowledge_work_storage_unavailable', 503);
      previousDigest = digest(Buffer.from(JSON.stringify(lease))); expiresAt = lease.expiresAt; issuedAt = lease.issuedAt;
    }
    return { expiresAt, previousDigest, recordDigest, sequence: names.length + 1 };
  };
  const resumeSearch = async (identity, context, workId, search, current) => {
    await assertSearchRoute(identity, context, search, current);
    const lease = await searchLease(workId, search);
    if (lease.expiresAt <= Date.now()) {
      const issuedAt = Date.now(); const expiresAt = Math.min(issuedAt + 600_000, current.actor.expiresAt);
      if (expiresAt <= issuedAt) fail('knowledge_work_expired', 409);
      const value = { version: 1, workId, recordDigest: lease.recordDigest, previousDigest: lease.previousDigest, issuedAt, expiresAt };
      await claimDispatch(directory, `${workId}_lease_${lease.sequence}`, await key(), value);
      await capture(identity, context, current.actor);
    }
    return { status: 'prepared', workId, dispatchable: false };
  };
  const prepareSearch = (identity, indexWorkId, query, idempotencyKey, context) => serial(async () => {
    if (!pilotText(query) || Buffer.byteLength(query) > 300 || !idPattern.test(idempotencyKey ?? '')) fail('knowledge_work_request_invalid', 400);
    const current = await activate(identity, context, indexWorkId); const secret = await key();
    const index = (await (await journal()).load()).committed.get(indexWorkId);
    if (!index || index.binding.namespace_id !== current.namespace) fail('knowledge_work_not_ready', 409);
    const rerank = await resolveModelBinding('rerank');
    if (rerank?.protocol !== 'managed-media' || rerank.providerId !== 'unihub' || rerank.model !== 'qwen3-rerank') fail('knowledge_work_model_unavailable', 503);
    const workId = `kbs_${derive(secret, 'knowledge-search-id-v2', JSON.stringify([current.namespace, indexWorkId, idempotencyKey]))}`;
    const taskId = `ktask_${derive(secret, 'knowledge-work-task-v1', workId)}`;
    try {
      const prior = await readDispatch(directory, workId, secret);
      if (prior.query !== query || prior.indexWorkId !== indexWorkId) fail('knowledge_work_conflict', 409);
      return resumeSearch(identity, context, workId, prior, current);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const names = (await fs.readdir(directory)).filter((name) => /^dispatch_kbs_[a-f0-9]{64}$/.test(name));
    if (names.length > 4096) fail('knowledge_work_capacity', 503);
    for (const name of names) {
      const previousWorkId = name.slice('dispatch_'.length);
      const prior = await readDispatch(directory, previousWorkId, secret);
      if (prior.indexWorkId !== indexWorkId) continue;
      try { await readDispatch(directory, `${previousWorkId}_completed`, secret); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (prior.query !== query) fail('knowledge_work_outcome_unknown', 409);
        return resumeSearch(identity, context, previousWorkId, prior, current);
      }
    }
    const embeddingRoute = await current.account.preflightKnowledgeRoute(identity, { taskId, model: current.record.model, wireOperation: 'embeddings.create' });
    assertRoute(embeddingRoute, current, current.record); await capture(identity, context, current.actor);
    const rerankRoute = await current.account.preflightKnowledgeRoute(identity, { taskId, model: rerank.model, wireOperation: 'rerank.create' });
    if (rerankRoute.actorId !== current.record.actor || rerankRoute.accountId !== current.record.payer || rerankRoute.instanceId !== instanceId || rerankRoute.model !== rerank.model || !/^[a-f0-9]{64}$/.test(rerankRoute.policyDigest ?? '')) fail('knowledge_work_space_unverified', 409);
    await capture(identity, context, current.actor);
    const record = { version: 2, indexWorkId, query, queryDigest: derive(secret, 'knowledge-search-query-v1', query), taskId, grantId: `kgrant_${derive(secret, 'knowledge-work-grant-v1', workId)}`, rerankPolicyDigest: rerankRoute.policyDigest, rerankRouteGeneration: rerankRoute.routeGeneration, expiresAt: Math.min(Date.now() + 600_000, current.actor.expiresAt) };
    await claimDispatch(directory, workId, secret, record);
    return { status: 'prepared', workId, dispatchable: false };
  });
  const liveSearch = async (workId) => {
    const live = active.get(workId); if (!live) fail('knowledge_work_auth_required', 401);
    const search = await readDispatch(directory, workId, await key());
    const current = await currentRecord(live.identity, live.context, search.indexWorkId, live.actor);
    await assertSearchRoute(live.identity, live.context, search, current);
    const index = (await (await journal()).load()).committed.get(search.indexWorkId);
    const lease = await searchLease(workId, search);
    if (!index || lease.expiresAt <= Date.now()) fail('knowledge_work_expired', 409);
    return { ...current, search, searchExpiresAt: lease.expiresAt, index, live };
  };
  const searchClaims = (workId, current) => {
    const b = current.index.binding; const indexFields = Object.fromEntries(Object.keys(indexBindingFields).map((field) => [field, b[field]])); const seconds = Math.floor(Date.now() / 1000);
    return { issuer: 'superwagie-knowledge-v1', audience: 'weknora', ...indexFields, completion_digest: current.index.completion.completion_digest, index_work_id: current.search.indexWorkId, tenant_id: b.tenant_id, actor_id: b.actor_id, account_id: b.account_id, task_id: current.search.taskId, work_id: workId, grant_id: current.search.grantId, knowledge_base_id: b.knowledge_base_id, knowledge_id: b.knowledge_id, query_digest: current.search.queryDigest, embedding_model: b.embedding_model, embedding_space: b.embedding_space, rerank_model: 'qwen3-rerank', issued_at: seconds, expires_at: Math.min(Math.floor(current.searchExpiresAt / 1000), Math.floor(current.actor.expiresAt / 1000)) };
  };
  const issueSearch = async (identity, workId, context) => {
    const search = await readDispatch(directory, workId, await key()); const current = await currentRecord(identity, context, search.indexWorkId);
    active.set(workId, { identity, context, actor: current.actor });
    return { token: await sign('weknora-search-v1', searchClaims(workId, await liveSearch(workId))) };
  };
  const authorizeSearch = async (workId, nonce) => {
    if (!/^[a-f0-9]{64}$/.test(nonce ?? '')) fail('knowledge_work_request_invalid', 400);
    const current = await liveSearch(workId); const claims = searchClaims(workId, current); const seconds = Math.floor(Date.now() / 1000);
    return sign('weknora-search-auth-v1', { ...claims, nonce, issued_at: seconds, expires_at: Math.min(seconds + 30, claims.expires_at) });
  };
  const searchSnapshot = async (workId, nonce) => {
    const current = await liveSearch(workId); const claims = decode(await authorizeSearch(workId, nonce)); const bytes = Buffer.from(current.search.query);
    return { assertion: await sign('weknora-search-snapshot-v1', { ...claims, content_sha256: digest(bytes) }), content: bytes.toString('base64') };
  };
  const dispatchSearch = async (workId, nonce, callId, operation, content) => {
    if (!/^wk_[a-f0-9]{60}$/.test(callId ?? '') || !['embedding', 'rerank'].includes(operation)) fail('knowledge_work_request_invalid', 400);
    const current = await liveSearch(workId); await authorizeSearch(workId, nonce);
    if (callId !== await searchCallId(workId, operation)) fail('knowledge_work_request_invalid', 400);
    let input; try { input = parseStrictJSON(Buffer.from(content, 'base64')); } catch { fail('knowledge_work_request_invalid', 400); }
    const model = operation === 'embedding' ? current.record.model : 'qwen3-rerank';
    const schema = operation === 'embedding'
      ? z.object({ model: z.literal(model), input: z.tuple([z.literal(current.search.query)]), dimensions: z.literal(1024).optional(), encoding_format: z.literal('float').optional() }).strict()
      : z.object({ model: z.literal(model), input: z.object({ query: z.literal(current.search.query), documents: z.tuple([z.literal(current.bytes.toString('utf8'))]) }).strict(), parameters: z.object({ top_n: z.literal(1), return_documents: z.literal(false) }).strict() }).strict();
    if (!schema.safeParse(input).success) fail('knowledge_work_plan_unsupported', 409);
    const body = Buffer.from(JSON.stringify(operation === 'embedding' ? { model, input: input.input, dimensions: 1024, encoding_format: 'float' } : input));
    const record = { work: workId, call: callId, task: current.search.taskId, model, operation, digest: digest(body) };
    const fresh = await claimDispatch(directory, `${workId}_${operation}`, await key(), record); await liveSearch(workId);
    if (fresh) await current.account[operation === 'embedding' ? 'dispatchKnowledgeEmbeddingPinned' : 'dispatchKnowledgeRerankPinned'](current.live.identity, { taskId: record.task, callId, model, policyDigest: operation === 'embedding' ? current.record.policyDigest : current.search.rerankPolicyDigest, body });
    return { status: 'submitted' };
  };
  const searchResult = async (workId, nonce, callId, operation, inputSHA256) => {
    if (!['embedding', 'rerank'].includes(operation)) fail('knowledge_work_request_invalid', 400);
    const current = await liveSearch(workId); const claims = decode(await authorizeSearch(workId, nonce));
    let dispatch;
    try { dispatch = await readDispatch(directory, `${workId}_${operation}`, await key()); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const input = operation === 'embedding'
        ? { model: current.record.model, input: [current.search.query], dimensions: 1024 }
        : { model: 'qwen3-rerank', input: { query: current.search.query, documents: [current.bytes.toString('utf8')] }, parameters: { top_n: 1, return_documents: false } };
      const original = JSON.stringify(input).replace(/[<>&\u2028\u2029]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
      if (inputSHA256 !== digest(Buffer.from(original)) || callId !== await searchCallId(workId, operation)) fail('knowledge_work_request_invalid', 400);
      // ENOENT is the sole positive evidence that this host never crossed its
      // durable pre-network claim. The worker verifies this distinct proof
      // before explicitly submitting the original stable call through dispatch.
      await liveSearch(workId);
      return { not_submitted_assertion: await sign('weknora-search-not-submitted-v1', { ...claims, call_id: callId, model: operation === 'embedding' ? current.record.model : 'qwen3-rerank', operation, wire_operation: operation === 'embedding' ? 'embeddings.create' : 'rerank.create', input_sha256: inputSHA256, status: 'NOT_SUBMITTED' }) };
    }
    if (dispatch.call !== callId || dispatch.task !== current.search.taskId) fail('knowledge_work_auth_changed', 409);
    const wire = operation === 'embedding' ? 'embeddings.create' : 'rerank.create';
    const { rawBytes, receipt } = await current.account.readKnowledgeResultWithEvidence(current.live.identity, { taskId: dispatch.task, callId, model: dispatch.model, wireOperation: wire });
    if (receipt.instanceId !== instanceId || receipt.actorId !== current.record.actor || receipt.accountId !== current.record.payer || receipt.taskId !== dispatch.task || receipt.callId !== callId || receipt.model !== dispatch.model || receipt.wireOperation !== wire || receipt.policyDigest !== (operation === 'embedding' ? current.record.policyDigest : current.search.rerankPolicyDigest) || receipt.routeGeneration !== (operation === 'embedding' ? current.record.routeGeneration : current.search.rerankRouteGeneration) || receipt.contentSha256 !== digest(rawBytes)) fail('knowledge_work_result_invalid', 503);
    await liveSearch(workId);
    return { assertion: await sign('weknora-search-result-v1', { ...claims, call_id: callId, model: dispatch.model, operation, wire_operation: wire, status: 'SETTLED', content_sha256: receipt.contentSha256 }), content: rawBytes.toString('base64') };
  };
  const acceptSearchResponse = async (workId, request, raw, workerBootId) => {
    await liveSearch(workId);
    const result = verifySearchReply(raw, request, callbackKey, workerBootId);
    const latest = await liveSearch(workId);
    await claimDispatch(directory, `${workId}_completed`, await key(), { workId, indexWorkId: latest.search.indexWorkId });
    await liveSearch(workId);
    return result;
  };
  const documentIdentity = async (identity, context, root, relPath) => {
    const current = await capture(identity, context); const secret = await key();
    const canonical = await fs.realpath(root);
    await capture(identity, context, current.actor);
    return { libraryId: `kbl_${derive(secret, 'knowledge-library-id-v1', JSON.stringify([current.namespace, canonical]))}`, documentId: `kbd_${derive(secret, 'knowledge-document-id-v1', JSON.stringify([current.namespace, canonical, relPath]))}` };
  };
  const revisionState = async (identity, workId, context) => {
    const current = await capture(identity, context);
    const record = await readWorkRecord(directory, workId, await key());
    if (record.namespace !== current.namespace || JSON.stringify(record.namespaceTuple) !== JSON.stringify(current.tuple)) fail('knowledge_work_scope_changed', 403);
    const state = await (await journal()).load();
    await capture(identity, context, current.actor);
    return { pending: state.pending.has(workId), committed: state.committed.has(workId), snapshotSHA256: record.snapshotSHA256, indexRevision: record.indexRevision };
  };
  const workerConfiguration = async (authorizationURL, callbackKeyFile) => {
    if (!enabled()) fail('knowledge_work_unavailable', 503);
    const url = new URL(authorizationURL);
    if (!path.isAbsolute(callbackKeyFile ?? '') || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/internal/knowledge-work/authorize') fail('knowledge_work_request_invalid', 400);
    const secret = await key(); await keyStorage.verifyFile(callbackKeyFile); callbackKey = await fs.readFile(callbackKeyFile); if (callbackKey.length !== 32) fail('knowledge_work_storage_unavailable', 503);
    const seed = crypto.createHmac('sha256', secret).update('knowledge-work-ed25519-v1\0').digest();
    const privateKey = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
    return { WEKNORA_MANAGED_KNOWLEDGE_PILOT: '1', WEKNORA_MANAGED_KNOWLEDGE_PUBLIC_KEY: crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'), WEKNORA_MANAGED_KNOWLEDGE_AUTH_URL: url.toString(), WEKNORA_MANAGED_JOURNAL_KEY_FILE: await workerKeyFile(directory, secret, 'journal'), WEKNORA_MANAGED_CALL_KEY_FILE: await workerKeyFile(directory, secret, 'call'), WEKNORA_MANAGED_BINDING_KEY_FILE: await workerKeyFile(directory, secret, 'binding'), WEKNORA_MANAGED_CALLBACK_KEY_FILE: callbackKeyFile };
  };
  return { prepare, documentIdentity, revisionState, issue, authorize, snapshot, dispatch, result, prepareSearch, issueSearch, authorizeSearch, searchSnapshot, dispatchSearch, searchResult, workerRequest, acceptResponse, acceptSearchResponse, authorizeCompleted, workerConfiguration, hasStorageAnchor: async () => Boolean((await (await journal()).load()).anchor), callbackKeyFile: async () => workerKeyFile(directory, await key(), 'callback'), captureScope: async (identity, context) => { const current = await capture(identity, context); return { namespace: current.namespace, actor: current.actor, scope: current.scope }; } };
}

// This listener is separate from the browser API. Its response is only useful
// to a worker that verifies the pinned signing key, nonce and full work scope.
export async function createKnowledgeAuthorizationServer(runtime, { now = Date.now, maxNonces = 100000 } = {}) {
  if (!z.function().safeParse(runtime?.authorize).success) throw new TypeError('managed work authorization required');
  const persistentKeyFile = runtime.callbackKeyFile ? await runtime.callbackKeyFile() : null;
  if (persistentKeyFile) await keyStorage.verifyFile(persistentKeyFile);
  const callbackKey = persistentKeyFile ? await fs.readFile(persistentKeyFile) : crypto.randomBytes(32);
  const keyDirectory = persistentKeyFile ? null : process.platform === 'win32' ? path.join(os.tmpdir(), `weknora-callback-${crypto.randomUUID()}`) : await fs.mkdtemp(path.join(os.tmpdir(), 'weknora-callback-'));
  let keyDirectoryOwned = Boolean(keyDirectory) && process.platform !== 'win32';
  const workerKeyFile = persistentKeyFile ?? path.join(keyDirectory, 'key');
  try {
    if (!persistentKeyFile) {
      if (process.platform === 'win32') {
        const created = await keyStorage.prepareDirectory(keyDirectory);
        if (!created) fail('knowledge_work_storage_unavailable', 503);
        keyDirectoryOwned = true;
        const file = await keyStorage.createFile(workerKeyFile);
        try { await file.writeFile(callbackKey); await file.sync(); } finally { await file.close(); }
        await keyStorage.verifyFile(workerKeyFile);
      } else {
        await fs.writeFile(workerKeyFile, callbackKey, { mode: 0o600, flag: 'wx' });
      }
    }
  }
  catch (error) { if (keyDirectoryOwned) await fs.rm(keyDirectory, { recursive: true, force: true }); throw error; }
  const seen = new Map();
  let latestTime = 0;
  const server = http.createServer((req, res) => {
    const respond = (status, payload) => {
      if (res.destroyed || res.headersSent) return;
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(payload));
    };
    void (async () => {
      const search = req.url?.startsWith('/internal/knowledge-search/');
      if (req.method !== 'POST' || !['/internal/knowledge-work/storage-authorize', '/internal/knowledge-work/completed-authorize', '/internal/knowledge-work/authorize', '/internal/knowledge-work/snapshot', '/internal/knowledge-work/result', '/internal/knowledge-work/dispatch', '/internal/knowledge-search/authorize', '/internal/knowledge-search/snapshot', '/internal/knowledge-search/result', '/internal/knowledge-search/dispatch'].includes(req.url)) return respond(404, { error: 'not_found' });
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) return respond(400, { error: 'invalid_request' });
      let size = 0; const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > (req.url.endsWith('/dispatch') ? 3 * 1024 * 1024 : 16384)) return respond(413, { error: 'invalid_request' });
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);
      let body;
      try { body = parseCanonicalJSON(raw); } catch { return respond(400, { error: 'invalid_request' }); }
      const signature = req.headers['x-weknora-worker-signature'];
      const timestamp = req.headers['x-weknora-worker-time'];
      if (req.headersDistinct?.['x-weknora-worker-signature']?.length !== 1 || req.headersDistinct?.['x-weknora-worker-time']?.length !== 1 || !/^[a-f0-9]{64}$/.test(signature ?? '') || !/^[a-f0-9]{64}$/.test(body?.nonce ?? '') || !/^[0-9]{1,12}$/.test(timestamp ?? '')) return respond(403, { error: 'authorization_unavailable' });
      const seconds = Number(timestamp);
      latestTime = Math.max(latestTime, Math.floor(now() / 1000));
      if (!Number.isSafeInteger(seconds) || seconds > latestTime + 5 || seconds + 30 < latestTime) return respond(403, { error: 'authorization_unavailable' });
      const digest = crypto.createHash('sha256').update(raw).digest('hex');
      const expected = crypto.createHmac('sha256', callbackKey).update(`weknora-callback-v2\n${req.method}\n${req.url}\n${digest}\n${body.nonce}\n${timestamp}`).digest();
      if (!crypto.timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return respond(403, { error: 'authorization_unavailable' });
      for (const [nonce, expires] of seen) if (expires < latestTime) seen.delete(nonce);
      if (seen.has(body.nonce) || seen.size >= maxNonces) return respond(403, { error: 'authorization_unavailable' });
      seen.set(body.nonce, seconds + 30);
      if (req.url.endsWith('/storage-authorize') || req.url.endsWith('/completed-authorize')) {
        const parsed = z.object({ nonce: z.string().regex(/^[a-f0-9]{64}$/), scope: req.url.endsWith('/storage-authorize') ? storageSchema : z.union([discoverSchema, useSchema]) }).strict().safeParse(body);
        if (!parsed.success) return respond(400, { error: 'invalid_request' });
        try { return respond(200, { assertion: await runtime.authorizeCompleted(parsed.data.scope, parsed.data.nonce) }); }
        catch { return respond(403, { error: 'authorization_unavailable' }); }
      }
      const schema = z.object({ work_id: z.string().regex(search ? /^kbs_[a-f0-9]{64}$/ : /^kbw_[a-f0-9]{64}$/), nonce: z.string().regex(/^[a-f0-9]{64}$/) });
      let requestSchema = req.url.endsWith('/dispatch') ? schema.extend({ call_id: z.string().regex(idPattern), content: z.string().max(3 * 1024 * 1024) }) : req.url.endsWith('/result') ? schema.extend({ call_id: z.string().regex(idPattern) }) : schema;
      if (search && (req.url.endsWith('/dispatch') || req.url.endsWith('/result'))) requestSchema = requestSchema.extend({ operation: z.enum(['embedding', 'rerank']) });
      if (search && req.url.endsWith('/result')) requestSchema = requestSchema.extend({ input_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() });
      const input = requestSchema.strict().safeParse(body);
      if (!input.success) return respond(400, { error: 'invalid_request' });
      if (search) {
        try { return respond(200, req.url.endsWith('/dispatch') ? await runtime.dispatchSearch(input.data.work_id, input.data.nonce, input.data.call_id, input.data.operation, input.data.content) : req.url.endsWith('/result') ? await runtime.searchResult(input.data.work_id, input.data.nonce, input.data.call_id, input.data.operation, input.data.input_sha256) : req.url.endsWith('/snapshot') ? await runtime.searchSnapshot(input.data.work_id, input.data.nonce) : { assertion: await runtime.authorizeSearch(input.data.work_id, input.data.nonce) }); }
        catch { return respond(403, { error: 'authorization_unavailable' }); }
      }
      try { return respond(200, req.url.endsWith('/dispatch') ? await runtime.dispatch(input.data.work_id, input.data.nonce, input.data.call_id, input.data.content) : req.url.endsWith('/result') ? await runtime.result(input.data.work_id, input.data.nonce, input.data.call_id) : req.url.endsWith('/snapshot') ? await runtime.snapshot(input.data.work_id, input.data.nonce) : { assertion: await runtime.authorize(input.data.work_id, input.data.nonce) }); }
      catch { return respond(403, { error: 'authorization_unavailable' }); }
    })().catch(() => respond(503, { error: 'authorization_unavailable' }));
  });
  server.maxConnections = 8;
  server.headersTimeout = 5000;
  server.requestTimeout = 10_000;
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); }
  catch (error) { if (keyDirectoryOwned) await fs.rm(keyDirectory, { recursive: true, force: true }); throw error; }
  let closing;
  const close = () => {
    closing ??= (async () => {
      try {
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      } finally { if (keyDirectoryOwned) await fs.rm(keyDirectory, { recursive: true, force: true }); }
    })();
    return closing;
  };
  return { url: `http://127.0.0.1:${server.address().port}/internal/knowledge-work/authorize`, workerKeyFile, close };
}
