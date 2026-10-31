import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import constants from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const fail = () => { throw Object.assign(new Error('knowledge_work_storage_unavailable'), { code: 'knowledge_work_storage_unavailable', status: 503 }); };
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const integer = z.number().int().positive();
const times = { issued_at: integer, expires_at: integer };
export const indexBindingFields = { namespace_id: hex, storage_id: hex, storage_generation: hex, embedding_policy_digest: hex, opaque_pin: hex, route_generation: hex, index_revision: integer };
export const bindingSchema = z.object({ ...indexBindingFields, tenant_id: integer, actor_id: id, account_id: id, task_id: id, work_id: id, grant_id: id, knowledge_base_id: id, knowledge_id: id, purpose: z.literal('document-ingest'), input_digest: hex, embedding_model: z.literal('unihub-text-embedding-v4'), embedding_space: z.literal('aliyun/text-embedding-v4/v4/1024/text') }).strict();
export const storageSchema = z.object({ version: z.literal('managed-storage-v1'), namespace_id: hex, tenant_id: integer, actor_id: id, account_id: id, knowledge_base_id: id, work_id: id, host_boot_id: hex, ...times }).strict();
export const discoverSchema = z.object({ version: z.literal('completed-index-discover-v1'), purpose: z.literal('completion_discover'), binding: bindingSchema, snapshot_sha256: hex, host_boot_id: hex, worker_boot_id: hex, ...times }).strict();
export const useSchema = z.object({ version: z.literal('completed-index-use-v1'), purpose: z.literal('completed_index_read'), namespace_id: hex, tenant_id: integer, actor_id: id, account_id: id, knowledge_base_id: id, knowledge_id: id, work_id: id, storage_id: hex, storage_generation: hex, index_revision: integer, completion_digest: hex, host_boot_id: hex, worker_boot_id: hex, ...times }).strict();
const replies = {
  storage: z.object({ version: z.literal('managed-storage-response-v1'), scope: storageSchema, nonce: hex, storage_id: hex, storage_generation: hex, worker_boot_id: hex, driver: z.literal('sqlite'), ...times, mac: hex }).strict(),
  discovery: z.object({ version: z.literal('completed-index-discovery-response-v1'), scope: discoverSchema, nonce: hex, completion_digest: hex, reference_digest: hex, index_revision: integer, call_id: id, attempt_id: id, producer_credential_id: id, input_sha256: hex, raw_result_sha256: hex, float32_sha256: hex, state: z.literal('ready'), ...times, mac: hex }).strict(),
  completion: z.object({ version: z.literal('completed-index-response-v1'), scope: useSchema, nonce: hex, reference_digest: hex, state: z.literal('ready'), ...times, mac: hex }).strict(),
};

// Canonical worker JSON is fixed Go struct order. Equality rejects duplicate keys,
// unknown fields and alternate encodings before any untrusted scope is consumed.
// Accept JSON string escapes emitted by Go while rejecting duplicate object keys.
// Parsing occurs only after the raw-byte response MAC has been verified.
export function parseStrictJSON(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const parsed = JSON.parse(text);
  let offset = 0;
  const whitespace = () => { while (/\s/.test(text[offset] ?? '') && offset < text.length) offset++; };
  const string = () => {
    const start = offset++;
    while (offset < text.length) {
      if (text[offset++] === '\\') { offset++; continue; }
      if (text[offset - 1] === '"') return JSON.parse(text.slice(start, offset));
    }
    fail();
  };
  const value = (depth) => {
    if (depth > 64) fail();
    whitespace();
    if (text[offset] === '"') { string(); return; }
    if (text[offset] === '{') {
      offset++; whitespace(); const keys = new Set();
      if (text[offset] === '}') { offset++; return; }
      for (;;) {
        whitespace(); if (text[offset] !== '"') fail();
        const key = string(); if (keys.has(key)) fail(); keys.add(key);
        whitespace(); if (text[offset++] !== ':') fail(); value(depth + 1); whitespace();
        if (text[offset++] === '}') return;
        if (text[offset - 1] !== ',') fail();
      }
    }
    if (text[offset] === '[') {
      offset++; whitespace(); if (text[offset] === ']') { offset++; return; }
      for (;;) { value(depth + 1); whitespace(); if (text[offset++] === ']') return; if (text[offset - 1] !== ',') fail(); }
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(offset));
    if (!token) fail(); offset += token[0].length;
  };
  value(0); whitespace(); if (offset !== text.length) fail();
  return parsed;
}
export function parseCanonicalJSON(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const parsed = JSON.parse(text);
  if (JSON.stringify(parsed) !== text) fail();
  return parsed;
}
export function verifyCompletionReply(raw, kind, expected, callbackKey, now = Date.now()) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  const marker = `"${kind}":`;
  const start = text.indexOf(marker) + marker.length;
  if (start < marker.length || text[start] !== '{') fail();
  let depth = 0; let quoted = false; let escaped = false; let end = start;
  for (; end < text.length; end++) {
    const character = text[end];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '{') depth++;
    else if (character === '}' && --depth === 0) { end++; break; }
  }
  const inner = text.slice(start, end);
  const suffix = /,"mac":"([a-f0-9]{64})"}$/.exec(inner);
  if (!suffix) fail();
  const unsigned = inner.slice(0, suffix.index) + '}';
  const key = crypto.createHmac('sha256', callbackKey).update('managed-completion-response-v1').digest();
  const mac = crypto.createHmac('sha256', key).update(unsigned).digest();
  if (!crypto.timingSafeEqual(mac, Buffer.from(suffix[1], 'hex'))) fail();
  const transport = parseCanonicalJSON(raw);
  const value = transport?.data?.[kind];
  const parsed = replies[kind]?.safeParse(value);
  if (!parsed?.success || JSON.stringify(parsed.data) !== inner || value.nonce !== expected.nonce || JSON.stringify(value.scope) !== JSON.stringify(expected.scope)) fail();
  const seconds = Math.floor(now / 1000);
  if (value.issued_at > seconds || value.expires_at <= seconds || value.expires_at <= value.issued_at || value.expires_at - value.issued_at > 30 || value.expires_at > expected.scope.expires_at) fail();
  if (kind === 'discovery' && value.index_revision !== expected.scope.binding.index_revision) fail();
  return parsed.data;
}

const syncDirectory = async (directory) => {
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
};
const privateRead = async (filename, max = 16 * 1024 * 1024) => {
  const file = await fs.open(filename, constants.constants.O_RDONLY | constants.constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > max || (process.platform !== 'win32' && (stat.mode & 0o077))) fail();
    return await file.readFile();
  } finally { await file.close(); }
};
const durableWrite = async (filename, bytes, exclusive = false) => {
  const temporary = exclusive ? filename : `${filename}.${crypto.randomUUID()}.tmp`;
  const file = await fs.open(temporary, 'wx', 0o600);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  if (!exclusive) await fs.rename(temporary, filename);
  await syncDirectory(path.dirname(filename));
};

// The journal is authoritative. The ready projection also carries its observed
// head so restoring only an older journal cannot silently lower the high-water.
export function createCompletionJournal(directory, key) {
  const journalPath = path.join(directory, 'completion-journal-v1');
  const anchorPath = path.join(directory, 'storage-anchor-v1');
  const readyPath = path.join(directory, 'completion-ready-v1');
  let tail = Promise.resolve();
  const mac = (text) => crypto.createHmac('sha256', key).update('knowledge-host-journal-v1\0').update(text).digest('hex');
  const seal = (value) => { const payload = JSON.stringify(value); return JSON.stringify({ payload, mac: mac(payload) }); };
  const unseal = (bytes) => {
    const envelope = parseCanonicalJSON(bytes);
    if (!z.object({ payload: z.string(), mac: hex }).strict().safeParse(envelope).success || mac(envelope.payload) !== envelope.mac) fail();
    return parseCanonicalJSON(Buffer.from(envelope.payload));
  };
  const load = async () => {
    let bytes;
    try { bytes = await privateRead(journalPath); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const entries = await fs.readdir(directory);
      if (entries.includes('storage-anchor-v1') || entries.includes('completion-ready-v1') || entries.includes('completion-initialized-v1')) fail();
      return { events: [], sequence: 0, head: '0'.repeat(64), pending: new Map(), committed: new Map(), anchor: null };
    }
    if (!bytes.length || bytes.at(-1) !== 10) fail();
    const state = { events: [], sequence: 0, head: '0'.repeat(64), pending: new Map(), committed: new Map(), anchor: null };
    for (const line of bytes.toString('utf8').slice(0, -1).split('\n')) {
      const event = unseal(Buffer.from(line));
      if (event.sequence !== state.sequence + 1 || event.previous !== state.head || !['ANCHOR', 'PENDING', 'COMMITTED'].includes(event.type)) fail();
      if (event.type === 'ANCHOR') {
        if (state.sequence !== 0) fail();
        state.anchor = event.value;
      } else {
        const binding = bindingSchema.parse(event.value.binding);
        if (!state.anchor || binding.storage_id !== state.anchor.storage_id || binding.storage_generation !== state.anchor.storage_generation) fail();
        const prior = state.pending.get(binding.work_id);
        if (event.type === 'PENDING') {
          if (prior) fail();
          state.pending.set(binding.work_id, event.value);
        } else {
          if (!prior || JSON.stringify(prior.binding) !== JSON.stringify(binding) || prior.snapshotSHA256 !== event.value.snapshotSHA256 || state.committed.has(binding.work_id)) fail();
          state.committed.set(binding.work_id, event.value);
        }
      }
      state.events.push(event); state.sequence = event.sequence; state.head = mac(line);
    }
    const anchor = unseal(await privateRead(anchorPath, 8192));
    if (anchor.storage_id !== state.anchor.storage_id || anchor.storage_generation !== state.anchor.storage_generation || !Number.isSafeInteger(anchor.sequence) || anchor.sequence < 1 || anchor.sequence > state.sequence || anchor.head !== mac(bytes.toString('utf8').split('\n')[anchor.sequence - 1])) fail();
    try {
      const ready = unseal(await privateRead(readyPath));
      if (ready.sequence > state.sequence || ready.head !== (ready.sequence ? mac(bytes.toString('utf8').split('\n')[ready.sequence - 1]) : '0'.repeat(64))) fail();
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return state;
  };
  const append = async (state, type, value) => {
    const event = { sequence: state.sequence + 1, previous: state.head, type, value };
    const line = seal(event);
    const file = await fs.open(journalPath, constants.constants.O_WRONLY | constants.constants.O_APPEND | constants.constants.O_CREAT | constants.constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(`${line}\n`); await file.sync(); } finally { await file.close(); }
    await syncDirectory(directory);
    const head = { sequence: event.sequence, head: mac(line) };
    if (state.anchor) await durableWrite(anchorPath, seal({ ...state.anchor, ...head }));
    return head;
  };
  const serialize = (action) => { const run = tail.then(action); tail = run.catch(() => {}); return run; };
  return {
    load: () => serialize(load),
    anchor: (storage) => serialize(async () => {
      const state = await load();
      const anchor = { storage_id: storage.storage_id, storage_generation: storage.storage_generation };
      if (state.anchor) { if (JSON.stringify(state.anchor) !== JSON.stringify(anchor)) fail(); return; }
      // The first journal record and anchor are an indivisible initialization
      // expectation: a crash between them fails closed and never adopts a new DB.
      const head = await append(state, 'ANCHOR', anchor);
      await durableWrite(anchorPath, seal({ ...anchor, ...head }), true);
      await durableWrite(path.join(directory, 'completion-initialized-v1'), seal(anchor), true);
    }),
    pending: (value) => serialize(async () => {
      const state = await load();
      const existing = state.pending.get(value.binding.work_id);
      if (existing) { if (JSON.stringify(existing) !== JSON.stringify(value)) fail(); return existing; }
      bindingSchema.parse(value.binding); hex.parse(value.snapshotSHA256);
      if (!state.anchor || value.binding.storage_id !== state.anchor.storage_id || value.binding.storage_generation !== state.anchor.storage_generation) fail();
      const revisions = [...state.pending.values()].filter((item) => item.binding.namespace_id === value.binding.namespace_id && item.documentId === value.documentId).map((item) => item.binding.index_revision);
      if (value.binding.index_revision <= Math.max(0, ...revisions)) fail();
      await append(state, 'PENDING', value); return value;
    }),
    commit: (workId, completion) => serialize(async () => {
      const state = await load(); const pending = state.pending.get(workId);
      if (!pending || completion.index_revision !== pending.binding.index_revision || JSON.stringify(completion.scope.binding) !== JSON.stringify(pending.binding) || completion.scope.snapshot_sha256 !== pending.snapshotSHA256) fail();
      const value = { ...pending, completion };
      const prior = state.committed.get(workId);
      if (prior) {
        for (const field of ['completion_digest', 'reference_digest', 'call_id', 'attempt_id', 'producer_credential_id', 'input_sha256', 'raw_result_sha256', 'float32_sha256']) if (prior.completion[field] !== completion[field]) fail();
        return prior;
      }
      const head = await append(state, 'COMMITTED', value);
      await durableWrite(readyPath, seal({ ...head, ready: [...state.committed.values(), value] }));
      return value;
    }),
  };
}

export function verifySearchReply(raw, request, callbackKey, workerBootId, now = Date.now()) {
  const reject = (code, status) => { throw Object.assign(new Error(code), { code, status }); };
  const outer = z.object({ success: z.literal(true), data: z.object({ payload: z.string(), mac: z.string() }).strict() }).strict().parse(parseCanonicalJSON(raw));
  const envelope = z.object({ payload: z.string().max(1400000), mac: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(outer.data);
  const payload = Buffer.from(envelope.payload, 'base64');
  if (!callbackKey || payload.length > 1048576 || payload.toString('base64') !== envelope.payload) reject('knowledge_work_result_invalid', 503);
  const derived = crypto.createHmac('sha256', callbackKey).update('managed-search-response-v1').digest();
  const mac = crypto.createHmac('sha256', derived).update(payload).digest();
  if (!crypto.timingSafeEqual(mac, Buffer.from(envelope.mac, 'hex'))) reject('knowledge_work_result_invalid', 503);
  const reply = parseCanonicalJSON(payload);
  const { issuer: _issuer, audience: _audience, issued_at: _issued, expires_at: _expires, ...scope } = request.scope;
  if (Object.keys(reply).join(',') !== 'version,scope,nonce,worker_boot_id,result_base64,content_sha256,issued_at,expires_at' || reply.version !== 'managed-search-response-v1' || JSON.stringify(reply.scope) !== JSON.stringify(scope) || reply.nonce !== request.nonce || reply.worker_boot_id !== workerBootId) reject('knowledge_work_result_invalid', 503);
  const seconds = Math.floor(now / 1000);
  let proofExpiry;
  try {
    const proofValue = z.string().safeParse(request?.proof);
    const proofParts = proofValue.success ? proofValue.data.split('.') : [];
    if (proofParts.length !== 4 || proofParts[0] !== 'weknora-request-v1' || proofParts[1] !== 'host-v1') throw new Error('invalid proof');
    const proof = z.object({
      issuer: z.literal('superwagie-knowledge-v1'),
      audience: z.literal('weknora'),
      method: z.literal('POST'),
      path: z.string().min(1).max(512),
      body_sha256: hex,
      nonce: hex,
      work_id: id,
      actor_id: id,
      account_id: id,
      issued_at: integer,
      expires_at: integer,
    }).strict().parse(parseCanonicalJSON(Buffer.from(proofParts[2], 'base64url')));
    if (proof.nonce !== request.nonce || proof.work_id !== request.scope.work_id || proof.actor_id !== request.scope.actor_id || proof.account_id !== request.scope.account_id) throw new Error('invalid proof');
    proofExpiry = proof.expires_at;
  } catch {
    reject('knowledge_work_result_invalid', 503);
  }
  if (!Number.isSafeInteger(reply.issued_at) || !Number.isSafeInteger(reply.expires_at) || reply.issued_at > seconds || reply.expires_at <= seconds || reply.expires_at <= reply.issued_at || reply.expires_at - reply.issued_at > 30 || reply.expires_at > request.scope.expires_at || reply.expires_at > proofExpiry) reject('knowledge_work_expired', 409);
  const bytes = Buffer.from(reply.result_base64, 'base64');
  if (bytes.toString('base64') !== reply.result_base64 || crypto.createHash('sha256').update(bytes).digest('hex') !== reply.content_sha256) reject('knowledge_work_result_invalid', 503);
  return parseStrictJSON(bytes);
}
