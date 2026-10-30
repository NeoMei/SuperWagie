import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import constants from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { z } from 'zod';

import { MAX_FILE_BYTES, shouldIndex } from './scan.js';
import { MANAGED_TEXT_EMBEDDING, managedEmbeddingCatalogEntry } from './managed-embedding-catalog.js';

const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const fail = (code, status) => { throw Object.assign(new Error(code), { code, status }); };
const equalScope = (a, b) => a?.actingUserId === b?.actingUserId && a?.billingAccountId === b?.billingAccountId && a?.authSession === b?.authSession && a?.expiresAt === b?.expiresAt && b.expiresAt > Date.now();
const secretFile = 'key-v1';
const MAX_SNAPSHOT_BYTES = Math.min(MAX_FILE_BYTES, 8 * 1024 * 1024);
// This bounded pilot supports one plain CJK or ASCII text chunk only.
const pilotText = (text, multiline = false) => z.string().safeParse(text).success && (multiline ? /^[\n\x20-\x7e\u3400-\u9fff\u3000-\u303f\uff01-\uff5e]+$/u : /^[\x20-\x7e\u3400-\u9fff\u3000-\u303f\uff01-\uff5e]+$/u).test(text) && !text.includes('#') && text === text.trim();
const pilotFilename = (name) => /^[A-Za-z0-9._ \-\u3400-\u9fff]+\.txt$/u.test(name);

async function keyFor(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) fail('knowledge_work_storage_unavailable', 503);
  const filename = path.join(directory, secretFile);
  let file;
  try {
    const entries = await fs.readdir(directory);
    if (!entries.includes(secretFile) && entries.some((entry) => entry.startsWith('kbw_') || entry.startsWith('snapshot_kbw_'))) fail('knowledge_work_storage_unavailable', 503);
    try {
      file = await fs.open(filename, constants.constants.O_WRONLY | constants.constants.O_CREAT | constants.constants.O_EXCL | constants.constants.O_NOFOLLOW, 0o600);
      await file.writeFile(crypto.randomBytes(32));
      await file.sync();
      await file.close(); file = null;
      if (process.platform !== 'win32') { const parent = await fs.open(directory, 'r'); try { await parent.sync(); } finally { await parent.close(); } }
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
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
  const derived = crypto.createHmac('sha256', key).update(`knowledge-work-worker-${name}-v1\0`).digest();
  let file;
  try {
    try {
      file = await fs.open(filename, constants.constants.O_WRONLY | constants.constants.O_CREAT | constants.constants.O_EXCL | constants.constants.O_NOFOLLOW, 0o600);
      await file.writeFile(derived); await file.sync(); await file.close(); file = null;
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
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

/** Records a prepared work intent. It does not authorize or dispatch a model call. */
export function createManagedWorkAdmission({ dataDir, enabled = () => false, authorizeOwner, getAccountRuntime, resolveDocument, resolveModelBinding, verifyEmbeddingEvidence }) {
  if (!dataDir || ![enabled, authorizeOwner, getAccountRuntime, resolveDocument, resolveModelBinding].every((value) => z.function().safeParse(value).success)) throw new TypeError('managed work dependencies required');
  const directory = path.join(dataDir, 'knowledge-managed-work');
  // This callback is an internal, trusted verifier, never data supplied by the
  // browser. No production verifier is wired yet; missing means unavailable.
  const evidence = async (identity, scope) => {
    if (!z.function().safeParse(verifyEmbeddingEvidence).success) fail('knowledge_work_space_unverified', 503);
    let value;
    try { value = await verifyEmbeddingEvidence(identity, scope); } catch { fail('knowledge_work_space_unverified', 503); }
    if (!value || value.verified !== true || value.phase !== scope.phase || value.actorId !== scope.actorId || value.accountId !== scope.accountId || value.model !== MANAGED_TEXT_EMBEDDING.publicModel || value.space !== MANAGED_TEXT_EMBEDDING.space || value.provider !== MANAGED_TEXT_EMBEDDING.provider || value.upstreamModel !== MANAGED_TEXT_EMBEDDING.upstreamModel || value.version !== MANAGED_TEXT_EMBEDDING.version || value.dimensions !== MANAGED_TEXT_EMBEDDING.dimensions || value.inputSemantics !== MANAGED_TEXT_EMBEDDING.inputSemantics || !/^[a-f0-9]{64}$/.test(value.policyDigest ?? '') || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now() || (scope.policyDigest && value.policyDigest !== scope.policyDigest) || (scope.phase === 'receipt' && (value.taskId !== scope.taskId || value.callId !== scope.callId || value.contentSHA256 !== scope.contentSHA256))) fail('knowledge_work_space_unverified', 503);
    return value;
  };
  let tail = Promise.resolve();
  const active = new Map();
  const prepare = (identity, documentId, idempotencyKey) => {
    const run = tail.then(async () => {
      if (!enabled()) fail('knowledge_work_unavailable', 503);
      if (!idPattern.test(documentId) || !idPattern.test(idempotencyKey)) fail('knowledge_work_request_invalid', 400);
      const account = getAccountRuntime();
      if (!identity || !account) fail('knowledge_work_auth_required', 401);
      if (!z.function().safeParse(account.dispatchKnowledgeEmbeddingPinned).success) fail('knowledge_work_space_unverified', 503);
      const actor = account.actor(identity);
      const principal = account.instancePrincipal(identity);
      const capture = account.captureCommerceSession(identity);
      if (!actor?.actingUserId || !actor.billingAccountId || !actor.authSession || !Number.isFinite(actor.expiresAt) || actor.expiresAt <= Date.now() || principal?.userId !== actor.actingUserId || !principal?.issuer || capture.actingUserId !== actor.actingUserId || capture.billingAccountId !== actor.billingAccountId || !capture.serviceId) fail('knowledge_work_auth_required', 401);
      if (authorizeOwner(principal) !== true) fail('knowledge_work_owner_forbidden', 403);
      const binding = await resolveModelBinding('embedding');
      const embedding = managedEmbeddingCatalogEntry(binding);
      if (!embedding) fail('knowledge_work_model_unavailable', 503);
      const route = await evidence(identity, { phase: 'route', actorId: actor.actingUserId, accountId: actor.billingAccountId });
      const accounts = await capture.request('/v1/accounts');
      if (!Array.isArray(accounts) || !accounts.some((item) => item?.id === actor.billingAccountId)) fail('knowledge_work_account_forbidden', 403);
      const document = await resolveDocument(documentId);
      if (!document || document.id !== documentId || !idPattern.test(document.libraryId ?? '') || !Number.isSafeInteger(document.tenantId) || document.tenantId < 1 || !idPattern.test(document.knowledgeBaseId ?? '') || document.knowledgeId) fail('knowledge_work_document_invalid', 409);
      const key = await keyFor(directory);
      const { content, source, bytes } = await documentDigest(document, key);
      if (!equalScope(actor, account.actor(identity)) || authorizeOwner(account.instancePrincipal(identity)) !== true) fail('knowledge_work_auth_changed', 409);
      const requestScope = [principal.issuer, capture.serviceId, actor.actingUserId, idempotencyKey];
      const workId = 'kbw_' + crypto.createHmac('sha256', key).update('knowledge-work-id-v1\0').update(JSON.stringify(requestScope)).digest('hex');
      const record = { version: 1, issuer: principal.issuer, service: capture.serviceId, actor: actor.actingUserId, payer: actor.billingAccountId, library: document.libraryId, document: document.id, tenant: document.tenantId, knowledgeBase: document.knowledgeBaseId, model: embedding.publicModel, embeddingSpace: embedding.space, policyDigest: route.policyDigest, source, content, expiresAt: Math.min(Date.now() + 600_000, actor.expiresAt) };
      await saveSnapshot(directory, workId, key, bytes);
      const target = path.join(directory, workId);
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(Buffer.from(workId));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(record)), cipher.final()]);
      const encoded = Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
      const temp = path.join(directory, `.${crypto.randomUUID()}.tmp`);
      let handle;
      try {
        handle = await fs.open(temp, 'wx', 0o600);
        await handle.writeFile(encoded); await handle.sync(); await handle.close(); handle = null;
        try { await fs.link(temp, target); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const existingFile = await fs.open(target, constants.constants.O_RDONLY | constants.constants.O_NOFOLLOW);
          let existing;
          try {
            const info = await existingFile.stat();
            if (!info.isFile() || info.size < 29 || info.size > 8192) fail('knowledge_work_storage_unavailable', 503);
            existing = await existingFile.readFile();
          } finally { await existingFile.close(); }
          try {
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, existing.subarray(0, 12));
            decipher.setAAD(Buffer.from(workId)); decipher.setAuthTag(existing.subarray(12, 28));
            const actual = JSON.parse(Buffer.concat([decipher.update(existing.subarray(28)), decipher.final()]).toString('utf8'));
            if (!Number.isFinite(actual.expiresAt) || actual.expiresAt <= Date.now()) fail('knowledge_work_expired', 409);
            if (JSON.stringify({ ...actual, expiresAt: null }) !== JSON.stringify({ ...record, expiresAt: null })) fail('knowledge_work_conflict', 409);
          } catch (error) { if (error?.status) throw error; fail('knowledge_work_storage_unavailable', 503); }
        }
        if (process.platform !== 'win32') { const parent = await fs.open(directory, 'r'); try { await parent.sync(); } finally { await parent.close(); } }
      } finally { await handle?.close(); await fs.rm(temp, { force: true }); }
      if (!equalScope(actor, account.actor(identity)) || authorizeOwner(account.instancePrincipal(identity)) !== true) fail('knowledge_work_auth_changed', 409);
      return { status: 'prepared', workId, dispatchable: false };
    });
    tail = run.catch(() => {});
    return run;
  };
  // Only host code may use this. The browser route returns a work ID, never a
  // capability or a private signing key. A worker must independently recheck
  // current authorization before dispatch and before returning a result.
  const issue = async (identity, workId) => {
    if (!enabled() || !/^kbw_[a-f0-9]{64}$/.test(workId) || !identity) fail('knowledge_work_unavailable', 503);
    const key = await keyFor(directory);
    const record = await readWorkRecord(directory, workId, key);
    const account = getAccountRuntime();
    const actor = account.actor(identity);
    const principal = account.instancePrincipal(identity);
    const capture = account.captureCommerceSession(identity);
    if (!actor?.actingUserId || !actor.billingAccountId || !actor.authSession || !Number.isFinite(actor.expiresAt) || actor.expiresAt <= Date.now() || !principal?.issuer || principal?.userId !== actor.actingUserId || authorizeOwner(principal) !== true || record.issuer !== principal.issuer || record.service !== capture.serviceId || record.actor !== actor.actingUserId || record.payer !== actor.billingAccountId || capture.actingUserId !== record.actor || capture.billingAccountId !== record.payer) fail('knowledge_work_owner_forbidden', 403);
    if (!Number.isFinite(record.expiresAt) || record.expiresAt <= Date.now()) fail('knowledge_work_expired', 409);
    const binding = await resolveModelBinding('embedding');
    const embedding = managedEmbeddingCatalogEntry(binding);
    if (!embedding || embedding.publicModel !== record.model || embedding.space !== record.embeddingSpace) fail('knowledge_work_model_unavailable', 503);
    if (!/^[a-f0-9]{64}$/.test(record.policyDigest ?? '')) fail('knowledge_work_space_unverified', 503);
    if (!z.function().safeParse(account.dispatchKnowledgeEmbeddingPinned).success) fail('knowledge_work_space_unverified', 503);
    await evidence(identity, { phase: 'route', actorId: record.actor, accountId: record.payer, policyDigest: record.policyDigest });
    const accounts = await capture.request('/v1/accounts');
    if (!Array.isArray(accounts) || !accounts.some((item) => item?.id === actor.billingAccountId)) fail('knowledge_work_account_forbidden', 403);
    const derive = (domain) => crypto.createHmac('sha256', key).update(domain + '\0').update(workId).digest('hex');
    const hex = derive('knowledge-work-id-v1').slice(0, 32);
    const knowledgeId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
    const document = await resolveDocument(record.document);
    if (!document || document.id !== record.document || document.libraryId !== record.library || document.tenantId !== record.tenant || document.knowledgeBaseId !== record.knowledgeBase || (document.knowledgeId && document.knowledgeId !== knowledgeId)) fail('knowledge_work_document_changed', 409);
    const current = await documentDigest(document, key);
    if (current.content !== record.content || current.source !== record.source || !equalScope(actor, account.actor(identity)) || authorizeOwner(account.instancePrincipal(identity)) !== true) fail('knowledge_work_document_changed', 409);
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = Math.min(Math.floor(record.expiresAt / 1000), Math.floor(actor.expiresAt / 1000), now + 600);
    if (expiresAt <= now) fail('knowledge_work_expired', 409);
    const claims = { issuer: 'superwagie-knowledge-v1', audience: 'weknora', tenant_id: record.tenant, actor_id: record.actor, account_id: record.payer, task_id: `ktask_${derive('knowledge-work-task-v1')}`, work_id: workId, grant_id: `kgrant_${derive('knowledge-work-grant-v1')}`, knowledge_base_id: record.knowledgeBase, knowledge_id: knowledgeId, purpose: 'document-ingest', input_digest: record.content, embedding_model: record.model, embedding_space: record.embeddingSpace, issued_at: now, expires_at: expiresAt };
    const seed = crypto.createHmac('sha256', key).update('knowledge-work-ed25519-v1\0').digest();
    const privateKey = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
    const encoded = `weknora-cap-v1.host-v1.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
    for (const [id, current] of active) if (current.expiresAt <= Date.now()) active.delete(id);
    if (!active.has(workId) && active.size >= 4096) fail('knowledge_work_capacity', 503);
    active.set(workId, { identity, expiresAt: claims.expires_at * 1000 });
    return { token: `${encoded}.${crypto.sign(null, Buffer.from(encoded), privateKey).toString('base64url')}`, publicKey: crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url'), model: record.model };
  };
  const authorize = async (workId, nonce) => {
    if (!z.string().safeParse(nonce).success || !/^[a-f0-9]{64}$/.test(nonce)) fail('knowledge_work_request_invalid', 400);
    const live = active.get(workId);
    if (!live || live.expiresAt <= Date.now()) { active.delete(workId); fail('knowledge_work_auth_required', 401); }
    const capability = await issue(live.identity, workId);
    const claims = JSON.parse(Buffer.from(capability.token.split('.')[2], 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    const assertion = { ...claims, nonce, issued_at: now, expires_at: Math.min(now + 30, claims.expires_at) };
    const key = await keyFor(directory);
    const seed = crypto.createHmac('sha256', key).update('knowledge-work-ed25519-v1\0').digest();
    const privateKey = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
    const encoded = `weknora-auth-v1.host-v1.${Buffer.from(JSON.stringify(assertion)).toString('base64url')}`;
    return `${encoded}.${crypto.sign(null, Buffer.from(encoded), privateKey).toString('base64url')}`;
  };
  const snapshot = async (workId, nonce) => {
    await authorize(workId, nonce);
    const key = await keyFor(directory);
    const bytes = await readSnapshot(directory, workId, key);
    const current = await authorize(workId, nonce);
    const claims = JSON.parse(Buffer.from(current.split('.')[2], 'base64url').toString('utf8'));
    const content = crypto.createHmac('sha256', key).update('knowledge-work-content-v1\0').update(bytes).digest('hex');
    if (content !== claims.input_digest) fail('knowledge_work_storage_unavailable', 503);
    const assertion = { ...claims, content_sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    const seed = crypto.createHmac('sha256', key).update('knowledge-work-ed25519-v1\0').digest();
    const privateKey = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
    const encoded = `weknora-snapshot-v1.host-v1.${Buffer.from(JSON.stringify(assertion)).toString('base64url')}`;
    return { assertion: `${encoded}.${crypto.sign(null, Buffer.from(encoded), privateKey).toString('base64url')}`, content: bytes.toString('base64') };
  };
  const result = async (workId, nonce, callId) => {
    if (!idPattern.test(callId ?? '')) fail('knowledge_work_request_invalid', 400);
    let assertion = await authorize(workId, nonce);
    const before = JSON.parse(Buffer.from(assertion.split('.')[2], 'base64url').toString('utf8'));
    const live = active.get(workId);
    if (!live) fail('knowledge_work_auth_required', 401);
    const account = getAccountRuntime();
    // The work ID derives the task ID; gateway independently requires that
    // the requested call belongs to that exact task, actor and payer.
    const capability = await issue(live.identity, workId);
    const issued = JSON.parse(Buffer.from(capability.token.split('.')[2], 'base64url').toString('utf8'));
    if (issued.task_id !== before.task_id || issued.actor_id !== before.actor_id || issued.account_id !== before.account_id || !z.function().safeParse(account.readKnowledgeResult).success) fail('knowledge_work_auth_changed', 409);
    const key = await keyFor(directory);
    const dispatchRecord = await readDispatch(directory, workId, key);
    if (dispatchRecord.work !== workId || dispatchRecord.call !== callId || dispatchRecord.task !== issued.task_id || dispatchRecord.actor !== issued.actor_id || dispatchRecord.payer !== issued.account_id || dispatchRecord.model !== capability.model) fail('knowledge_work_auth_changed', 409);
    const bytes = await account.readKnowledgeResult(live.identity, { taskId: issued.task_id, callId, model: capability.model });
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 16 * 1024 * 1024) fail('knowledge_work_result_invalid', 503);
    const workRecord = await readWorkRecord(directory, workId, key);
    await evidence(live.identity, { phase: 'receipt', actorId: issued.actor_id, accountId: issued.account_id, policyDigest: workRecord.policyDigest, taskId: issued.task_id, callId, contentSHA256: crypto.createHash('sha256').update(bytes).digest('hex') });
    assertion = await authorize(workId, nonce);
    const claims = JSON.parse(Buffer.from(assertion.split('.')[2], 'base64url').toString('utf8'));
    if (claims.task_id !== before.task_id || claims.actor_id !== before.actor_id || claims.account_id !== before.account_id || claims.input_digest !== before.input_digest) fail('knowledge_work_auth_changed', 409);
    const seed = crypto.createHmac('sha256', key).update('knowledge-work-ed25519-v1\0').digest();
    const privateKey = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
    const payload = { ...claims, call_id: callId, model: capability.model, operation: 'embedding', wire_operation: 'embeddings.create', status: 'SETTLED', content_sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    const encoded = `weknora-result-v1.host-v1.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
    return { assertion: `${encoded}.${crypto.sign(null, Buffer.from(encoded), privateKey).toString('base64url')}`, content: bytes.toString('base64') };
  };
  const dispatch = async (workId, nonce, callId, content) => {
    if (!/^wk_[a-f0-9]{60}$/.test(callId ?? '') || !z.string().safeParse(content).success || content.length > 3 * 1024 * 1024) fail('knowledge_work_request_invalid', 400);
    const raw = Buffer.from(content, 'base64');
    if (raw.length < 1 || raw.length > 2 * 1024 * 1024 || raw.toString('base64') !== content) fail('knowledge_work_request_invalid', 400);
    const live = active.get(workId);
    if (!live) fail('knowledge_work_auth_required', 401);
    const capability = await issue(live.identity, workId);
    const claims = JSON.parse(Buffer.from(capability.token.split('.')[2], 'base64url').toString('utf8'));
    const inputSnapshot = await snapshot(workId, nonce);
    const source = Buffer.from(inputSnapshot.content, 'base64');
    const sourceText = source.toString('utf8');
    if (source.length > 300 || !Buffer.from(sourceText, 'utf8').equals(source) || !pilotText(sourceText, true)) fail('knowledge_work_plan_unsupported', 409);
    const key = await keyFor(directory);
    const record = await readWorkRecord(directory, workId, key);
    const document = await resolveDocument(record.document);
    if (!document || !pilotFilename(path.basename(document.relPath))) fail('knowledge_work_plan_unsupported', 409);
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { fail('knowledge_work_request_invalid', 400); }
    const parsed = z.object({ model: z.literal(capability.model), input: z.array(z.string()).length(1), encoding_format: z.literal('float').optional(), dimensions: z.literal(MANAGED_TEXT_EMBEDDING.dimensions).optional() }).strict().safeParse(body);
    if (!parsed.success || parsed.data.input[0] !== `${path.basename(document.relPath).trim()}\n${sourceText}`) fail('knowledge_work_plan_unsupported', 409);
    const canonical = Buffer.from(JSON.stringify(parsed.data));
    const callRecord = { version: 1, work: workId, call: callId, task: claims.task_id, actor: claims.actor_id, payer: claims.account_id, model: capability.model, digest: crypto.createHmac('sha256', key).update('knowledge-work-call-v1\0').update(canonical).digest('hex') };
    await authorize(workId, nonce);
    const fresh = await claimDispatch(directory, workId, key, callRecord);
    if (fresh) {
      const account = getAccountRuntime();
      if (!z.function().safeParse(account.dispatchKnowledgeEmbeddingPinned).success) fail('knowledge_work_space_unverified', 503);
      await account.dispatchKnowledgeEmbeddingPinned(live.identity, { taskId: claims.task_id, callId, model: capability.model, policyDigest: record.policyDigest, body: canonical });
    }
    return { status: 'submitted' };
  };
  // Search is a separate user-confirmed scope. The query is sealed in the
  // host ledger and is never accepted back from the worker as authority.
  const prepareSearch = async (identity, indexWorkId, query, idempotencyKey) => {
    if (!z.string().safeParse(query).success || Buffer.byteLength(query) > 300 || !pilotText(query) || !idPattern.test(idempotencyKey ?? '')) fail('knowledge_work_request_invalid', 400);
    const index = await issue(identity, indexWorkId);
    const indexClaims = JSON.parse(Buffer.from(index.token.split('.')[2], 'base64url').toString('utf8'));
    const key = await keyFor(directory);
    const indexedCall = await readDispatch(directory, indexWorkId, key);
    await result(indexWorkId, crypto.randomBytes(32).toString('hex'), indexedCall.call);
    const model = await resolveModelBinding('rerank');
    if (model?.protocol !== 'managed-media' || model.providerId !== 'unihub' || model.purpose !== 'rerank' || model.model !== 'qwen3-rerank' || index.model !== MANAGED_TEXT_EMBEDDING.publicModel || indexClaims.embedding_space !== MANAGED_TEXT_EMBEDDING.space) fail('knowledge_work_model_unavailable', 503);
    const account = getAccountRuntime();
    const principal = account.instancePrincipal(identity);
    const capture = account.captureCommerceSession(identity);
    const workId = 'kbs_' + crypto.createHmac('sha256', key).update('knowledge-search-id-v1\0').update(JSON.stringify([principal.issuer, capture.serviceId, indexClaims.actor_id, idempotencyKey])).digest('hex');
    const record = { version: 1, indexWorkId, actor: indexClaims.actor_id, payer: indexClaims.account_id, tenant: indexClaims.tenant_id, knowledgeBase: indexClaims.knowledge_base_id, knowledge: indexClaims.knowledge_id, query, queryDigest: crypto.createHmac('sha256', key).update('knowledge-search-query-v1\0').update(query).digest('hex'), embeddingModel: index.model, embeddingSpace: indexClaims.embedding_space, rerankModel: model.model, expiresAt: indexClaims.expires_at * 1000 };
    await claimDispatch(directory, workId, key, record);
    await issue(identity, indexWorkId);
    return { status: 'prepared', workId, dispatchable: false };
  };
  const issueSearch = async (identity, workId) => {
    if (!enabled() || !/^kbs_[a-f0-9]{64}$/.test(workId ?? '') || !identity) fail('knowledge_work_unavailable', 503);
    const key = await keyFor(directory);
    const record = await readDispatch(directory, workId, key);
    if (!Number.isFinite(record.expiresAt) || record.expiresAt <= Date.now()) fail('knowledge_work_expired', 409);
    const index = await issue(identity, record.indexWorkId);
    const indexClaims = JSON.parse(Buffer.from(index.token.split('.')[2], 'base64url').toString('utf8'));
    const model = await resolveModelBinding('rerank');
    if (indexClaims.actor_id !== record.actor || indexClaims.account_id !== record.payer || indexClaims.tenant_id !== record.tenant || indexClaims.knowledge_base_id !== record.knowledgeBase || indexClaims.knowledge_id !== record.knowledge || index.model !== record.embeddingModel || indexClaims.embedding_space !== record.embeddingSpace || record.embeddingSpace !== MANAGED_TEXT_EMBEDDING.space || model?.protocol !== 'managed-media' || model.providerId !== 'unihub' || model.purpose !== 'rerank' || model.model !== record.rerankModel) fail('knowledge_work_auth_changed', 409);
    const derive = (domain) => crypto.createHmac('sha256', key).update(domain + '\0').update(workId).digest('hex');
    const now = Math.floor(Date.now() / 1000);
    const claims = { issuer: 'superwagie-knowledge-v1', audience: 'weknora', tenant_id: record.tenant, actor_id: record.actor, account_id: record.payer, task_id: `ktask_${derive('knowledge-search-task-v1')}`, work_id: workId, grant_id: `kgrant_${derive('knowledge-search-grant-v1')}`, knowledge_base_id: record.knowledgeBase, knowledge_id: record.knowledge, query_digest: record.queryDigest, embedding_model: record.embeddingModel, embedding_space: record.embeddingSpace, rerank_model: record.rerankModel, issued_at: now, expires_at: Math.min(indexClaims.expires_at, Math.floor(record.expiresAt / 1000)) };
    if (claims.expires_at <= now) fail('knowledge_work_expired', 409);
    const seed = crypto.createHmac('sha256', key).update('knowledge-work-ed25519-v1\0').digest();
    const privateKey = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
    const encoded = `weknora-search-v1.host-v1.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
    if (!active.has(workId) && active.size >= 4096) fail('knowledge_work_capacity', 503);
    active.set(workId, { identity, expiresAt: claims.expires_at * 1000 });
    return { token: `${encoded}.${crypto.sign(null, Buffer.from(encoded), privateKey).toString('base64url')}` };
  };
  const authorizeSearch = async (workId, nonce) => {
    if (!/^[a-f0-9]{64}$/.test(nonce ?? '')) fail('knowledge_work_request_invalid', 400);
    const live = active.get(workId);
    if (!live || live.expiresAt <= Date.now()) fail('knowledge_work_auth_required', 401);
    const capability = await issueSearch(live.identity, workId);
    const claims = JSON.parse(Buffer.from(capability.token.split('.')[2], 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    return signSearch('weknora-search-auth-v1', { ...claims, nonce, issued_at: now, expires_at: Math.min(now + 30, claims.expires_at) });
  };
  const signSearch = async (prefix, claims) => {
    const key = await keyFor(directory);
    const seed = crypto.createHmac('sha256', key).update('knowledge-work-ed25519-v1\0').digest();
    const privateKey = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
    const encoded = `${prefix}.host-v1.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
    return `${encoded}.${crypto.sign(null, Buffer.from(encoded), privateKey).toString('base64url')}`;
  };
  const searchSnapshot = async (workId, nonce) => {
    await authorizeSearch(workId, nonce);
    const key = await keyFor(directory);
    const record = await readDispatch(directory, workId, key);
    const bytes = Buffer.from(record.query);
    if (crypto.createHmac('sha256', key).update('knowledge-search-query-v1\0').update(bytes).digest('hex') !== record.queryDigest) fail('knowledge_work_storage_unavailable', 503);
    const auth = await authorizeSearch(workId, nonce);
    const claims = JSON.parse(Buffer.from(auth.split('.')[2], 'base64url').toString('utf8'));
    return { assertion: await signSearch('weknora-search-snapshot-v1', { ...claims, content_sha256: crypto.createHash('sha256').update(bytes).digest('hex') }), content: bytes.toString('base64') };
  };
  const dispatchSearch = async (workId, nonce, callId, operation, content) => {
    if (!/^wk_[a-f0-9]{60}$/.test(callId ?? '') || !['embedding', 'rerank'].includes(operation) || !z.string().safeParse(content).success || content.length > 3 * 1024 * 1024) fail('knowledge_work_request_invalid', 400);
    const raw = Buffer.from(content, 'base64');
    if (!raw.length || raw.toString('base64') !== content) fail('knowledge_work_request_invalid', 400);
    const signedQuery = await searchSnapshot(workId, nonce);
    const claims = JSON.parse(Buffer.from(signedQuery.assertion.split('.')[2], 'base64url').toString('utf8'));
    const key = await keyFor(directory);
    const record = await readDispatch(directory, workId, key);
    const indexRecord = await readWorkRecord(directory, record.indexWorkId, key);
    const document = await resolveDocument(indexRecord.document);
    const source = await readSnapshot(directory, record.indexWorkId, key);
    const sourceText = source.toString('utf8');
    if (source.length > 300 || !Buffer.from(sourceText, 'utf8').equals(source) || !pilotText(sourceText, true) || !document || !pilotFilename(path.basename(document.relPath))) fail('knowledge_work_plan_unsupported', 409);
    let parsed;
    try { parsed = JSON.parse(raw.toString('utf8')); } catch { fail('knowledge_work_request_invalid', 400); }
    const model = operation === 'embedding' ? record.embeddingModel : record.rerankModel;
    const schema = operation === 'embedding' ? z.object({ model: z.literal(model), input: z.array(z.string()).length(1), encoding_format: z.literal('float').optional(), dimensions: z.literal(MANAGED_TEXT_EMBEDDING.dimensions).optional() }).strict() : z.object({ model: z.literal(model), input: z.object({ query: z.literal(record.query), documents: z.tuple([z.literal(`${path.basename(document.relPath).trim()}\n\n${sourceText}`)]) }).strict(), parameters: z.object({ top_n: z.literal(1), return_documents: z.literal(false) }).strict() }).strict();
    const valid = schema.safeParse(parsed);
    if (!valid.success || (operation === 'embedding' && valid.data.input[0] !== record.query)) fail('knowledge_work_plan_unsupported', 409);
    const canonical = Buffer.from(JSON.stringify(valid.data));
    const call = { version: 1, work: workId, call: callId, task: claims.task_id, actor: claims.actor_id, payer: claims.account_id, model, operation, digest: crypto.createHmac('sha256', key).update('knowledge-search-call-v1\0').update(canonical).digest('hex') };
    await authorizeSearch(workId, nonce);
    const fresh = await claimDispatch(directory, `${workId}_${operation}`, key, call);
    if (fresh) {
      const live = active.get(workId); const account = getAccountRuntime();
      const send = operation === 'embedding' ? account.dispatchKnowledgeEmbeddingPinned : account.dispatchKnowledgeRerank;
      if (!live || !z.function().safeParse(send).success) fail('knowledge_work_unavailable', 503);
      await send(live.identity, { taskId: claims.task_id, callId, model, policyDigest: indexRecord.policyDigest, body: canonical });
    }
    return { status: 'submitted' };
  };
  const searchResult = async (workId, nonce, callId, operation) => {
    if (!/^wk_[a-f0-9]{60}$/.test(callId ?? '') || !['embedding', 'rerank'].includes(operation)) fail('knowledge_work_request_invalid', 400);
    const before = JSON.parse(Buffer.from((await authorizeSearch(workId, nonce)).split('.')[2], 'base64url').toString('utf8'));
    const key = await keyFor(directory); const record = await readDispatch(directory, `${workId}_${operation}`, key);
    const model = operation === 'embedding' ? before.embedding_model : before.rerank_model;
    if (record.work !== workId || record.call !== callId || record.task !== before.task_id || record.actor !== before.actor_id || record.payer !== before.account_id || record.model !== model || record.operation !== operation) fail('knowledge_work_auth_changed', 409);
    const live = active.get(workId); const account = getAccountRuntime();
    if (!live || !z.function().safeParse(account.readKnowledgeResult).success) fail('knowledge_work_auth_required', 401);
    const bytes = await account.readKnowledgeResult(live.identity, { taskId: before.task_id, callId, model });
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 16 * 1024 * 1024) fail('knowledge_work_result_invalid', 503);
    if (operation === 'embedding') {
      const searchRecord = await readDispatch(directory, workId, key);
      const indexRecord = await readWorkRecord(directory, searchRecord.indexWorkId, key);
      await evidence(live.identity, { phase: 'receipt', actorId: before.actor_id, accountId: before.account_id, policyDigest: indexRecord.policyDigest, taskId: before.task_id, callId, contentSHA256: crypto.createHash('sha256').update(bytes).digest('hex') });
    }
    const claims = JSON.parse(Buffer.from((await authorizeSearch(workId, nonce)).split('.')[2], 'base64url').toString('utf8'));
    if (claims.task_id !== before.task_id || claims.actor_id !== before.actor_id || claims.account_id !== before.account_id || claims.query_digest !== before.query_digest) fail('knowledge_work_auth_changed', 409);
    return { assertion: await signSearch('weknora-search-result-v1', { ...claims, call_id: callId, model, operation, wire_operation: operation === 'embedding' ? 'embeddings.create' : 'rerank.create', status: 'SETTLED', content_sha256: crypto.createHash('sha256').update(bytes).digest('hex') }), content: bytes.toString('base64') };
  };
  // Construct both the body and its proof server-side after rechecking the
  // user and payer; callers cannot supply a path, scope, or capability.
  const workerRequest = async (identity, workId, purpose) => {
    if (!['ingest', 'search', 'status'].includes(purpose)) fail('knowledge_work_request_invalid', 400);
    const capability = purpose !== 'search' ? await issue(identity, workId) : await issueSearch(identity, workId);
    const claims = JSON.parse(Buffer.from(capability.token.split('.')[2], 'base64url').toString('utf8'));
    const key = await keyFor(directory);
    const indexWorkId = purpose !== 'search' ? workId : (await readDispatch(directory, workId, key)).indexWorkId;
    const record = await readWorkRecord(directory, indexWorkId, key);
    const document = await resolveDocument(record.document);
    if (!document) fail('knowledge_work_document_changed', 409);
    const requestPath = purpose === 'ingest' ? `/api/v1/knowledge-bases/${claims.knowledge_base_id}/knowledge/managed-ref` : purpose === 'status' ? `/api/v1/knowledge-bases/${claims.knowledge_base_id}/knowledge/managed-status` : `/api/v1/knowledge-bases/${claims.knowledge_base_id}/managed-hybrid-search`;
    const payload = purpose === 'ingest' ? { path: path.join(await fs.realpath(document.root), document.relPath), capability: capability.token } : { capability: capability.token };
    const body = JSON.stringify(payload);
    if (purpose !== 'search') await issue(identity, workId); else await issueSearch(identity, workId);
    const now = Math.floor(Date.now() / 1000);
    if (claims.expires_at <= now) fail('knowledge_work_expired', 409);
    const proof = await signSearch('weknora-request-v1', { issuer: claims.issuer, audience: claims.audience, method: 'POST', path: requestPath, body_sha256: crypto.createHash('sha256').update(body).digest('hex'), nonce: crypto.randomBytes(32).toString('hex'), work_id: workId, actor_id: claims.actor_id, account_id: claims.account_id, issued_at: now, expires_at: Math.min(now + 30, claims.expires_at) });
    return { path: requestPath, body, proof };
  };
  const pilotConfiguration = async (authorizationURL, callbackKeyFile) => {
    if (!enabled() || ![...active.values()].some((item) => item.expiresAt > Date.now())) fail('knowledge_work_auth_required', 401);
    let url;
    try { url = new URL(authorizationURL); } catch { fail('knowledge_work_request_invalid', 400); }
    if (!path.isAbsolute(callbackKeyFile ?? '')) fail('knowledge_work_request_invalid', 400);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/internal/knowledge-work/authorize') fail('knowledge_work_request_invalid', 400);
    const key = await keyFor(directory);
    const seed = crypto.createHmac('sha256', key).update('knowledge-work-ed25519-v1\0').digest();
    const privateKey = crypto.createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
    const publicKey = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
    const journal = await workerKeyFile(directory, key, 'journal');
    const call = await workerKeyFile(directory, key, 'call');
    const binding = await workerKeyFile(directory, key, 'binding');
    if (process.platform !== 'win32') { const parent = await fs.open(directory, 'r'); try { await parent.sync(); } finally { await parent.close(); } }
    return { WEKNORA_MANAGED_KNOWLEDGE_PILOT: '1', WEKNORA_MANAGED_KNOWLEDGE_PUBLIC_KEY: publicKey, WEKNORA_MANAGED_KNOWLEDGE_AUTH_URL: url.toString(), WEKNORA_MANAGED_JOURNAL_KEY_FILE: journal, WEKNORA_MANAGED_CALL_KEY_FILE: call, WEKNORA_MANAGED_BINDING_KEY_FILE: binding, WEKNORA_MANAGED_CALLBACK_KEY_FILE: callbackKeyFile };
  };
  return { prepare, issue, authorize, snapshot, result, dispatch, prepareSearch, issueSearch, authorizeSearch, searchSnapshot, dispatchSearch, searchResult, workerRequest, pilotConfiguration };
}

export function registerManagedWorkRoutes(app, { runtime, resolveIdentity, isRequestOriginAllowed }) {
  if (!runtime || !z.function().safeParse(resolveIdentity).success || !z.function().safeParse(isRequestOriginAllowed).success) throw new TypeError('managed work route dependencies required');
  app.post('/api/knowledge-library/documents/:id/managed-work', express.json({ limit: '1kb' }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (!await isRequestOriginAllowed(req)) fail('knowledge_work_origin_forbidden', 403);
      if (!z.object({ confirmed: z.literal(true) }).strict().safeParse(req.body).success) fail('knowledge_work_confirmation_required', 400);
      if (req.headersDistinct?.['idempotency-key']?.length !== 1 || !z.string().safeParse(req.headers['idempotency-key']).success) fail('knowledge_work_request_invalid', 400);
      const identity = await resolveIdentity(req, res);
      res.status(201).json(await runtime.prepare(identity, req.params.id, req.headers['idempotency-key']));
    } catch (error) {
      if (error?.code === 'enterprise_mode') return res.status(403).json({ error: 'enterprise_mode' });
      res.status(Number.isInteger(error?.status) && error.status >= 400 && error.status <= 599 ? error.status : 503).json({ error: z.string().safeParse(error?.code).success && /^knowledge_work_[a-z_]+$/.test(error.code) ? error.code : 'knowledge_work_unavailable' });
    }
  });
}

// This listener is separate from the browser API. Its response is only useful
// to a worker that verifies the pinned signing key, nonce and full work scope.
export async function createKnowledgeAuthorizationServer(runtime, { now = Date.now, maxNonces = 100000 } = {}) {
  if (!z.function().safeParse(runtime?.authorize).success) throw new TypeError('managed work authorization required');
  const callbackKey = crypto.randomBytes(32);
  const keyDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'weknora-callback-'));
  const workerKeyFile = path.join(keyDirectory, 'key');
  try { await fs.writeFile(workerKeyFile, callbackKey, { mode: 0o600, flag: 'wx' }); }
  catch (error) { await fs.rm(keyDirectory, { recursive: true, force: true }); throw error; }
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
      if (req.method !== 'POST' || !['/internal/knowledge-work/authorize', '/internal/knowledge-work/snapshot', '/internal/knowledge-work/result', '/internal/knowledge-work/dispatch', '/internal/knowledge-search/authorize', '/internal/knowledge-search/snapshot', '/internal/knowledge-search/result', '/internal/knowledge-search/dispatch'].includes(req.url)) return respond(404, { error: 'not_found' });
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) return respond(400, { error: 'invalid_request' });
      let size = 0; const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > (req.url.endsWith('/dispatch') ? 3 * 1024 * 1024 : 1024)) return respond(413, { error: 'invalid_request' });
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);
      let body;
      try { body = JSON.parse(raw.toString('utf8')); } catch { return respond(400, { error: 'invalid_request' }); }
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
      const schema = z.object({ work_id: z.string().regex(search ? /^kbs_[a-f0-9]{64}$/ : /^kbw_[a-f0-9]{64}$/), nonce: z.string().regex(/^[a-f0-9]{64}$/) });
      let requestSchema = req.url.endsWith('/dispatch') ? schema.extend({ call_id: z.string().regex(idPattern), content: z.string().max(3 * 1024 * 1024) }) : req.url.endsWith('/result') ? schema.extend({ call_id: z.string().regex(idPattern) }) : schema;
      if (search && (req.url.endsWith('/dispatch') || req.url.endsWith('/result'))) requestSchema = requestSchema.extend({ operation: z.enum(['embedding', 'rerank']) });
      const input = requestSchema.strict().safeParse(body);
      if (!input.success) return respond(400, { error: 'invalid_request' });
      if (search) {
        try { return respond(200, req.url.endsWith('/dispatch') ? await runtime.dispatchSearch(input.data.work_id, input.data.nonce, input.data.call_id, input.data.operation, input.data.content) : req.url.endsWith('/result') ? await runtime.searchResult(input.data.work_id, input.data.nonce, input.data.call_id, input.data.operation) : req.url.endsWith('/snapshot') ? await runtime.searchSnapshot(input.data.work_id, input.data.nonce) : { assertion: await runtime.authorizeSearch(input.data.work_id, input.data.nonce) }); }
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
  catch (error) { await fs.rm(keyDirectory, { recursive: true, force: true }); throw error; }
  let closing;
  const close = () => {
    closing ??= (async () => {
      try {
        server.closeAllConnections();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      } finally { await fs.rm(keyDirectory, { recursive: true, force: true }); }
    })();
    return closing;
  };
  return { url: `http://127.0.0.1:${server.address().port}/internal/knowledge-work/authorize`, workerKeyFile, close };
}
