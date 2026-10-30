/**
 * Embedded knowledge HTTP client.
 *
 * This module is the only place that knows the backend's wire shapes. It is
 * deliberately thin: request assembly, auth headers, timeout, and a typed
 * error for every failure the callers branch on. Product logic (what to
 * upload, when to replace a document, how to merge results) lives in
 * `../knowledge-library/`.
 */

import crypto from 'node:crypto';

import { isRecord } from '../shared/guards.js';

export class EmbeddedKnowledgeError extends Error {
  constructor(code, message, { status, cause } = {}) {
    super(message);
    this.name = 'EmbeddedKnowledgeError';
    this.code = code;
    this.status = status;
    this.cause = cause;
  }
}

const unwrap = (payload) => (isRecord(payload) && 'data' in payload ? payload.data : payload);

const mapStatus = (status) => {
  if (status === 401 || status === 403) return new EmbeddedKnowledgeError('unauthorized', 'The knowledge backend rejected the credentials', { status });
  if (status === 404) return new EmbeddedKnowledgeError('not_found', 'Knowledge record not found', { status });
  if (status === 409) return new EmbeddedKnowledgeError('conflict', 'The knowledge backend reported a conflict', { status });
  if (status >= 400 && status < 500) return new EmbeddedKnowledgeError('bad_request', 'The knowledge backend rejected the request', { status });
  return new EmbeddedKnowledgeError('backend_error', 'The knowledge backend failed to handle the request', { status });
};

const buildForm = ({ fileName, metadata, bytes, contentType }) => {
  const boundary = `----sw-${crypto.randomUUID()}`;
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="fileName"\r\n\r\n${fileName}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="channel"\r\n\r\napi\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="upload.bin"\r\n` +
      `Content-Type: ${contentType || 'application/octet-stream'}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([head, bytes, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
};

export function createEmbeddedKnowledgeClient({
  baseUrl,
  apiKey = null,
  tenantId = null,
  sessionToken = null,
  timeoutMs = 15_000,
  fetchImpl = fetch,
} = {}) {
  if (!baseUrl) throw new Error('Embedded knowledge client requires a base URL');

  const authHeaders = () => {
    if (sessionToken) return { Authorization: `Bearer ${sessionToken}` };
    if (apiKey) {
      const headers = { 'X-API-Key': apiKey };
      if (tenantId !== null && tenantId !== undefined) headers['X-Tenant-ID'] = String(tenantId);
      return headers;
    }
    return {};
  };

  const request = async (path, { method = 'GET', body, form, raw = false, redirect = 'follow', managedProof, signedBody } = {}) => {
    const headers = { ...authHeaders() };
    if (managedProof) headers['X-WeKnora-Managed-Proof'] = managedProof;
    let payload;
    if (signedBody !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = signedBody;
    } else if (form) {
      headers['Content-Type'] = form.contentType;
      payload = form.body;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        redirect,
        headers,
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw new EmbeddedKnowledgeError('timeout', 'The knowledge backend did not answer in time', { cause: error });
      }
      throw new EmbeddedKnowledgeError('unavailable', 'The knowledge backend is unreachable', { cause: error });
    }

    if (raw) {
      if (!response.ok) throw mapStatus(response.status);
      return response;
    }

    if (!response.ok) {
      const error = mapStatus(response.status);
      try {
        const payload = await response.json();
        const code = isRecord(payload?.error) ? payload.error.code : payload?.code;
        if (/^[a-z][a-z0-9_:-]{0,79}$/.test(code ?? '')) error.code = code;
      } catch { /* Preserve the status-derived error for non-JSON failures. */ }
      throw error;
    }

    try {
      return await response.json();
    } catch (error) {
      throw new EmbeddedKnowledgeError('bad_response', 'The knowledge backend returned an unreadable body', {
        status: response.status,
        cause: error,
      });
    }
  };

  return {
    baseUrl,
    async memoryIndex({ knowledgeBaseId, action, input = {} }) {
      const actions = ['capabilities', 'state/read', 'state/commit', 'nodes/upsert', 'nodes/get', 'nodes/list', 'nodes/search', 'nodes/delete', 'nodes/payload', 'embed'];
      if (!knowledgeBaseId || !actions.includes(action)) throw new EmbeddedKnowledgeError('invalid_memory_operation', 'Unsupported memory index operation');
      return unwrap(await request(`/api/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/memory-index/${action}`, { method: 'POST', body: input }));
    },

    // The host signs these exact bytes. Keep the reply intact for inner DTO MAC verification.
    async managedRequest({ path, body, proof }) {
      const origin = new URL(baseUrl);
      if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.username || origin.password || origin.search || origin.hash || !['', '/'].includes(origin.pathname)
        || !/^\/api\/v1\/knowledge-bases\/[A-Za-z0-9_-]{1,128}\/(?:knowledge\/(?:managed-ref|managed-status)|managed-hybrid-search)$/.test(path)
        || typeof body !== 'string' || Buffer.byteLength(body) > 32768 || typeof proof !== 'string' || proof.length > 16384) {
        throw new EmbeddedKnowledgeError('bad_request', 'Invalid managed knowledge request');
      }
      const response = await request(path, { method: 'POST', signedBody: body, managedProof: proof, raw: true, redirect: 'error' });
      if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
        await response.body?.cancel();
        throw new EmbeddedKnowledgeError('bad_response', 'Invalid managed knowledge response');
      }
      const chunks = []; let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > 2 * 1024 * 1024) throw new EmbeddedKnowledgeError('bad_response', 'Managed knowledge response too large');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    },

    async health() {
      const payload = await request('/health');
      return payload?.status === 'ok';
    },

    async login(email, password) {
      const payload = await request('/api/v1/auth/login', { method: 'POST', body: { email, password } });
      const user = payload?.user ?? null;
      const token = payload?.token ?? null;
      if (!token) throw new EmbeddedKnowledgeError('bad_response', 'The knowledge backend did not return a session token');
      return { token, user };
    },

    async register({ email, password, username }) {
      const payload = await request('/api/v1/auth/register', {
        method: 'POST',
        body: { email, password, username },
      });
      // Registration answers the created user but no token; the caller logs in.
      return { user: payload?.user ?? null };
    },

    async listModels() {
      return unwrap(await request('/api/v1/models'));
    },

    async updateModel(id, model) {
      return unwrap(await request(`/api/v1/models/${encodeURIComponent(id)}`, { method: 'PUT', body: model }));
    },

    async getKnowledgeBase(id) {
      return unwrap(await request(`/api/v1/knowledge-bases/${encodeURIComponent(id)}`));
    },

    async listKnowledgeBases() {
      return unwrap(await request('/api/v1/knowledge-bases'));
    },

    async createModel(model) {
      return unwrap(await request('/api/v1/models', { method: 'POST', body: model }));
    },

    async listImages({ knowledgeBaseId, page = 1, pageSize = 24 } = {}) {
      return request(
        `/api/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/images?page=${page}&page_size=${pageSize}`,
      );
    },

    async wikiPages({ knowledgeBaseId, page = 1, pageSize = 50 } = {}) {
      return request(
        `/api/v1/knowledgebase/${encodeURIComponent(knowledgeBaseId)}/wiki/pages?page=${page}&page_size=${pageSize}`,
      );
    },

    async wikiFolders({ knowledgeBaseId } = {}) {
      return request(`/api/v1/knowledgebase/${encodeURIComponent(knowledgeBaseId)}/wiki/folders`);
    },

    async wikiPage({ knowledgeBaseId, slug }) {
      const pathSegments = String(slug).split('/').map(encodeURIComponent).join('/');
      return request(
        `/api/v1/knowledgebase/${encodeURIComponent(knowledgeBaseId)}/wiki/pages/${pathSegments}`,
      );
    },

    async wikiPage({ knowledgeBaseId, slug }) {
      const pathSegments = String(slug).split('/').map(encodeURIComponent).join('/');
      return unwrap(
        await request(
          `/api/v1/knowledgebase/${encodeURIComponent(knowledgeBaseId)}/wiki/pages/${pathSegments}`,
        ),
      );
    },

    async wikiGraph({ knowledgeBaseId, mode = 'overview' } = {}) {
      return request(
        `/api/v1/knowledgebase/${encodeURIComponent(knowledgeBaseId)}/wiki/graph?mode=${encodeURIComponent(mode)}`,
      );
    },

    async fetchFile({ knowledgeBaseId, filePath }) {
      const query = new URLSearchParams({ file_path: filePath });
      return request(
        `/api/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/files?${query.toString()}`,
        { raw: true },
      );
    },

    async listParserEngines() {
      return unwrap(await request('/api/v1/system/parser-engines'));
    },

    async updateKnowledgeBase(id, payload) {
      return unwrap(
        await request(`/api/v1/knowledge-bases/${encodeURIComponent(id)}`, { method: 'PUT', body: payload }),
      );
    },

    async getTenantParserConfig() {
      const config = unwrap(await request('/api/v1/tenants/kv/parser-engine-config'));
      if (!isRecord(config)) throw new EmbeddedKnowledgeError('bad_response', 'The knowledge backend returned unreadable parser configuration');
      return config;
    },

    async updateTenantParserConfig(config) {
      return unwrap(await request('/api/v1/tenants/kv/parser-engine-config', { method: 'PUT', body: config }));
    },

    async createKnowledgeBase({ name, embeddingModelId }) {
      return unwrap(
        await request('/api/v1/knowledge-bases', {
          method: 'POST',
          body: { name, embedding_model_id: embeddingModelId },
        }),
      );
    },

    async createApiKey(tenantIdValue, { name, capabilities, knowledgeBaseIds }) {
      const created = unwrap(
        await request(`/api/v1/tenants/${encodeURIComponent(tenantIdValue)}/api-keys`, {
          method: 'POST',
          body: { name, capabilities, knowledge_base_ids: knowledgeBaseIds },
        }),
      );
      // The response carries `api_key` (a non-secret display id) and `token`
      // (the credential). Only the token authenticates requests.
      return { id: created?.id ?? null, apiKey: created?.token ?? null, capabilities: created?.capabilities ?? [] };
    },

    async uploadFile({ knowledgeBaseId, fileName, metadata, bytes, contentType }) {
      return unwrap(
        await request(`/api/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/knowledge/file`, {
          method: 'POST',
          form: buildForm({ fileName, metadata, bytes, contentType }),
        }),
      );
    },

    // Reference ingest (SuperWagie fork): the backend indexes a file where it
    // lives. No bytes cross the socket, and the call is idempotent per
    // (knowledge base, path).
    async registerReference({ knowledgeBaseId, path: filePath, title, folderPath, metadata }) {
      return unwrap(
        await request(`/api/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/knowledge/ref`, {
          method: 'POST',
          body: {
            path: filePath,
            title,
            folder_path: folderPath,
            metadata,
            tag_ids: [],
            channel: 'api',
          },
        }),
      );
    },

    // Managed registration is separate from the automatic reference queue.
    // The worker verifies the signed scope and reads the host's frozen snapshot.
    async registerManagedReference({ knowledgeBaseId, path: filePath, capability, proof }) {
      const target = new URL(baseUrl);
      if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.username || target.password || (target.pathname !== '/' && target.pathname !== '') || target.search || target.hash) throw new EmbeddedKnowledgeError('unavailable', 'Managed knowledge requires the local backend');
      if (!proof) throw new EmbeddedKnowledgeError('unavailable', 'Managed knowledge requires an authorized request');
      return unwrap(await request(`/api/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/knowledge/managed-ref`, {
        method: 'POST', body: { path: filePath, capability }, redirect: 'error', managedProof: proof,
      }));
    },

    // Re-reads a record's file in place. The knowledge id is unchanged, so a
    // content change keeps its citations.
    async reparseKnowledge(id) {
      return request(`/api/v1/knowledge/${encodeURIComponent(id)}/reparse`, { method: 'POST', body: {} });
    },

    async getKnowledge(id) {
      return unwrap(await request(`/api/v1/knowledge/${encodeURIComponent(id)}`));
    },

    async listKnowledge({ knowledgeBaseId, keyword, folderPath, page = 1, pageSize = 50 }) {
      const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
      if (keyword) params.set('keyword', keyword);
      if (folderPath !== undefined && folderPath !== null) params.set('folder_path', folderPath);
      const payload = await request(
        `/api/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/knowledge?${params.toString()}`,
      );
      return { data: Array.isArray(payload?.data) ? payload.data : [], total: payload?.total ?? 0 };
    },

    async hybridSearch({ knowledgeBaseId, queryText, matchCount = 8, knowledgeIds, rerank = true }) {
      const body = {
        query_text: queryText,
        match_count: matchCount,
        vector_threshold: 0.5,
        keyword_threshold: 0.3,
      };
      if (knowledgeIds?.length) body.knowledge_ids = knowledgeIds;
      if (rerank) body.rerank = { enabled: true };
      const payload = await request(
        `/api/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/hybrid-search`,
        { method: 'POST', body },
      );
      return Array.isArray(payload?.data) ? payload.data : [];
    },

    async listChunks(knowledgeId) {
      return unwrap(await request(`/api/v1/chunks/${encodeURIComponent(knowledgeId)}`));
    },

    async deleteKnowledge(id) {
      return request(`/api/v1/knowledge/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },

    async previewKnowledge(id) {
      return request(`/api/v1/knowledge/${encodeURIComponent(id)}/preview`, { raw: true });
    },
  };
}
