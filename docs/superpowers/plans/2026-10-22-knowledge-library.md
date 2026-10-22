# Knowledge Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a user's local folders searchable — by name and by meaning — from a right-rail panel and from one agent tool, on top of a bundled the embedded knowledge backend instance the user never sees.

**Architecture:** A web-server module (`lib/embedded-knowledge`) owns the backend process, its provisioning and its HTTP contract. A second module (`lib/knowledge-library`) owns the product: library records, a per-document ledger, folder scanning, ingest, parse polling, merged search, and the HTTP routes the UI and the agent tool call. The UI is one context surface and one settings page; the agent tool is one action group in the existing managed plugin.

**Tech Stack:** Node 24 ESM, Express 5, vitest + supertest (server), React + TypeScript (UI), Electron extra resources, upstream v0.8.3 headless binary.

**Spec:** `docs/specs/2026-10-22-knowledge-library.md`

**Execution status (2026-10-22):** Tasks 1–11 implemented; focused tests pass (301 server + 35 UI). Ingest registers references and reparses in place; the backend is spawned on 127.0.0.1:17808 with its own working directory. The panel, settings page, add-folder preview and agent tool are in place, and both new server modules have DOCUMENTATION.md. A dev-browser click-through confirmed the rail surface and the settings page; the tree with real documents needs a desktop run with a provisioned key. Task 12 is verified end to end: a full electron-builder run produced 犇马.app, a DMG and a zip, and the packaged app's Resources/embedded-knowledge holds the binary, config (127.0.0.1:17808), migrations, licences and manifest. Commit steps are deferred: repository policy forbids git commands without an explicit request.

## Global Constraints

- No new dependencies. Node builtins, Express, and what the workspace already installs.
- The feature is desktop-only. Every other surface reports `unsupported` and hides the UI.
- The backend binds loopback only. Its URL, API key, account password and model key never reach the browser; responses expose presence only.
- A document is registered by absolute path (reference ingest): no bytes cross the loopback socket and no copy is written. The absolute path reaches the backend as the record's file path; it is never returned in search results or rendered in the UI.
- Files above 50 MB are never registered; they are recorded as `skipped` with a reason.
- Symlinks are never followed. Hidden entries, dependency/build directories and temp files are skipped.
- `/api` auth applies to every new route; `express.json()` is mounted explicitly per route module.
- Desktop-only source changes need a real app check; static checks alone do not prove runtime behaviour.
- Server modules follow the `lib/<feature>/{routes,runtime}.js` + `DOCUMENTATION.md` + `*.test.js` shape.
- The pre-commit gate is `bun run check:changed`. Run it once on the finished diff, not per task.

---

## File Structure

```
packages/web/server/lib/embedded-knowledge/
  client.js                 HTTP client for every endpoint we use (session and API-key auth)
  supervisor.js             binary resolution, spawn, health, restart ladder, stop
  provision.js              first-run account, models, KB, API key (idempotent)
  DOCUMENTATION.md
  client.test.js
  supervisor.test.js
  provision.test.js
  test-fixtures/fake-embedded-knowledge.mjs

packages/web/server/lib/knowledge-library/
  store.js                  atomic JSON stores for libraries and the document ledger
  scan.js                   whitelist/ignore rules, directory walk, ledger diff
  ingest.js                 reference registration + reparse + parse-polling state machine
  watcher.js                fs.watch + debounce + periodic reconcile
  search.js                 merged file-name + hybrid search
  runtime.js                composition: settings, status, orchestration, events
  routes.js                 HTTP surface
  DOCUMENTATION.md
  store.test.js
  scan.test.js
  ingest.test.js
  watcher.test.js
  search.test.js
  routes.http.test.js

packages/ui/src/lib/knowledge-library/
  client.ts                 runtimeFetch wrappers
  types.ts                  shared response types

packages/ui/src/components/layout/panels/KnowledgeLibraryPanel.tsx
packages/ui/src/components/layout/panels/knowledge-library/   (tree, search, rows)
packages/ui/src/components/sections/library/LibrarySettings.tsx

packages/web/server/lib/openchamber-control/library.js   agent-tool dispatch
packages/electron/scripts/build-embedded-knowledge.mjs              CI binary staging
```

---

### Task 1: the knowledge backend HTTP client

**Files:**
- Create: `packages/web/server/lib/embedded-knowledge/client.js`
- Test: `packages/web/server/lib/embedded-knowledge/client.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `createEmbeddedKnowledgeClient(options)` with the methods below; `EmbeddedKnowledgeError` carrying `code` and optional `status`.

```js
export class EmbeddedKnowledgeError extends Error {
  constructor(code, message, { status, cause } = {}) { super(message); this.name = 'EmbeddedKnowledgeError'; this.code = code; this.status = status; this.cause = cause; }
}

export function createEmbeddedKnowledgeClient({
  baseUrl,                 // 'http://127.0.0.1:17808'
  apiKey = null,
  tenantId = null,
  sessionToken = null,
  timeoutMs = 15_000,
  fetchImpl = fetch,
}) { /* ... */ }
```

Methods and shapes (verified against upstream v0.8.3):

- `health()` → `true` on `GET /health` `{status:'ok'}`.
- `login(email, password)` → `{ token, user }` (`POST /api/v1/auth/login`; token is in the body's `token`).
- `register({ email, password, username })` → `{ token, user }` (`POST /api/v1/auth/register`).
- `listModels()` → `data[]` (`GET /api/v1/models`).
- `createModel({ name, type, source, parameters })` → `data` (`POST /api/v1/models`).
- `createKnowledgeBase({ name, embeddingModelId })` → `data` (`POST /api/v1/knowledge-bases`).
- `createApiKey(tenantId, { name, capabilities, knowledgeBaseIds })` → `data` (`POST /api/v1/tenants/:id/api-keys`).
- `registerReference({ knowledgeBaseId, path, title, folderPath, metadata })` → `data` (`POST /api/v1/knowledge-bases/:id/knowledge/ref`; body `{path, title, folder_path, metadata, tag_ids: [], channel: 'api'}`). Idempotent per (KB, path); the backend stores `ref://<absolute path>` and writes no copy.
- `reparseKnowledge(id)` → `POST /api/v1/knowledge/:id/reparse`; re-reads the file in place and keeps the id.
- `uploadFile(...)` stays in the client for completeness but no feature code calls it.
- `getKnowledge(id)` → `data` (`GET /api/v1/knowledge/:id`).
- `listKnowledge({ knowledgeBaseId, keyword, folderPath, page = 1, pageSize = 50 })` → `{ data, total }` (`GET /api/v1/knowledge-bases/:id/knowledge`).
- `hybridSearch({ knowledgeBaseId, queryText, matchCount = 8, knowledgeIds, rerank = true })` → `data[]` (`POST /api/v1/knowledge-bases/:id/hybrid-search`).
- `listChunks(knowledgeId)` → `data[]` (`GET /api/v1/chunks/:knowledgeId`).
- `deleteKnowledge(id)` (`DELETE /api/v1/knowledge/:id`).
- `previewKnowledge(id)` → `{ status, headers, stream }` (`GET /api/v1/knowledge/:id/preview`).

Rules: auth headers are `Authorization: Bearer <sessionToken>` when a session token is set, else `X-API-Key` + `X-Tenant-ID`. Every call aborts at `timeoutMs`. Non-2xx maps to a `EmbeddedKnowledgeError` code: 401/403 → `unauthorized`, 404 → `not_found`, timeout → `timeout`, network error → `unavailable`, unparsable body → `bad_response`.

- [x] **Step 1: Write the failing test (auth + error mapping)**

```js
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createEmbeddedKnowledgeClient, EmbeddedKnowledgeError } from './client.js';

let server; let baseUrl; const seen = [];
beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    if (req.url === '/health') return res.end(JSON.stringify({ status: 'ok' }));
    if (req.url === '/api/v1/knowledge/missing') { res.statusCode = 404; return res.end(JSON.stringify({ error: 'not found' })); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [], total: 0, success: true }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => server.close());

describe('embedded-knowledge client', () => {
  it('uses the API-key headers and tenant id', async () => {
    const client = createEmbeddedKnowledgeClient({ baseUrl, apiKey: 'k', tenantId: 7 });
    await client.listKnowledge({ knowledgeBaseId: 'kb1' });
    expect(seen.at(-1).headers['x-api-key']).toBe('k');
    expect(seen.at(-1).headers['x-tenant-id']).toBe('7');
  });

  it('maps 404 to a not_found error', async () => {
    const client = createEmbeddedKnowledgeClient({ baseUrl, apiKey: 'k' });
    await expect(client.getKnowledge('missing')).rejects.toMatchObject({ code: 'not_found', status: 404 });
  });

  it('times out instead of hanging', async () => {
    const slow = http.createServer(() => {});
    await new Promise((r) => slow.listen(0, '127.0.0.1', r));
    const client = createEmbeddedKnowledgeClient({ baseUrl: `http://127.0.0.1:${slow.address().port}`, timeoutMs: 50 });
    await expect(client.health()).rejects.toMatchObject({ code: 'timeout' });
    slow.close();
  });

  it('reports an unreachable backend as unavailable', async () => {
    const client = createEmbeddedKnowledgeClient({ baseUrl: 'http://127.0.0.1:9' });
    await expect(client.health()).rejects.toBeInstanceOf(EmbeddedKnowledgeError);
    await expect(client.health()).rejects.toMatchObject({ code: 'unavailable' });
  });
});
```

- [x] **Step 2: Run it and confirm it fails**

Run: `bun run --cwd packages/web test -- server/lib/embedded-knowledge/client.test.js`
Expected: FAIL — `./client.js` cannot be resolved.

- [x] **Step 3: Implement the client**

Build one private `request(path, { method, body })`; all methods call it. Reference ingest is a plain JSON call — the path is the payload:

```js
async registerReference({ knowledgeBaseId, path: filePath, title, folderPath, metadata }) {
  return unwrap(await request(
    `/api/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/knowledge/ref`,
    { method: 'POST', body: { path: filePath, title, folder_path: folderPath, metadata, tag_ids: [], channel: 'api' } },
  ));
}
```

`uploadFile` and its hand-built multipart body stay in the client (tested), because the fork can be swapped back to an upstream binary; no feature code calls it.

- [x] **Step 4: Run the tests**

Run: `bun run --cwd packages/web test -- server/lib/embedded-knowledge/client.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/embedded-knowledge/client.js packages/web/server/lib/embedded-knowledge/client.test.js
git commit -m "feat(knowledge): add the knowledge backend HTTP client"
```

---

### Task 2: Backend supervisor

**Files:**
- Create: `packages/web/server/lib/embedded-knowledge/supervisor.js`
- Create: `packages/web/server/lib/embedded-knowledge/test-fixtures/fake-embedded-knowledge.mjs`
- Test: `packages/web/server/lib/embedded-knowledge/supervisor.test.js`

**Interfaces:**
- Consumes: `createEmbeddedKnowledgeClient` (Task 1).
- Produces: `createEmbeddedKnowledgeSupervisor(options)` with `start()`, `stop()`, `retry()`, `getState()`, `getBaseUrl()`; state one of `not-installed | stopped | starting | running | unavailable | port-conflict`.

```js
createEmbeddedKnowledgeSupervisor({
  resolveBinaryPath,        // () => string | null
  buildEnv,                 // () => Record<string,string>  (port, db, storage, keys)
  port,
  dataDir,
  spawnImpl = spawn,
  fetchImpl = fetch,
  onStateChange,            // (state, detail) => void
  backoffMs = [0, 5_000, 20_000, 60_000, 300_000],
});
```

Behaviour:
- `start()`: no binary → `not-installed`. `GET /health` already healthy → adopt, `running`. Otherwise spawn detached with `stdio: ['ignore','pipe','pipe']`, `SERVER_HOST=127.0.0.1` and `SERVER_PORT=17808` in the child environment (never rely on the backend finding `config/config.yaml`), poll health every 2 s for 30 s. Failure → next backoff step; after the last one → `unavailable`.
- An occupied port that answers `/health` with a non-the knowledge backend body is `port-conflict`; that is not retried.
- `stop()`: `SIGTERM`, wait 5 s, `SIGKILL`. Idempotent.
- While `running`, a 15 s health probe that fails twice in a row triggers the restart ladder from the current step.

- [x] **Step 1: Write the fake backend fixture**

```js
// used only by tests: a tiny server that answers /health and records its pid
import http from 'node:http';
import fs from 'node:fs';
const port = Number(process.argv[2]);
const pidFile = process.argv[3];
fs.writeFileSync(pidFile, String(process.pid));
http.createServer((req, res) => {
  if (req.url === '/health') { res.end(JSON.stringify({ status: 'ok' })); return; }
  res.statusCode = 404; res.end('{}');
}).listen(port, '127.0.0.1');
```

- [x] **Step 2: Write the failing test**

```js
it('starts the binary, reports running, and stops it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-wk-'));
  const pidFile = path.join(dir, 'pid');
  const port = 17901 + Math.floor(Math.random() * 80);
  const states = [];
  const supervisor = createEmbeddedKnowledgeSupervisor({
    resolveBinaryPath: () => process.execPath,
    buildEnv: () => ({}),
    spawnArgs: () => ['test-fixtures/fake-embedded-knowledge.mjs', String(port), pidFile],
    port, dataDir: dir, onStateChange: (s) => states.push(s),
  });
  await supervisor.start();
  expect(supervisor.getState()).toBe('running');
  expect(states).toContain('starting');
  const pid = Number(await fs.readFile(pidFile, 'utf8'));
  await supervisor.stop();
  expect(() => process.kill(pid, 0)).toThrow();
});
```

`spawnArgs` is a test-only seam; production spawns `<binary>` with no args, because the compiled Lite binary takes its configuration from the environment.

- [x] **Step 3: Run it and confirm it fails**

Run: `bun run --cwd packages/web test -- server/lib/embedded-knowledge/supervisor.test.js`
Expected: FAIL — `createEmbeddedKnowledgeSupervisor` is not defined.

- [x] **Step 4: Implement the supervisor**

Keep it a small state machine (`idle → starting → running → stopping → stopped`, `* → unavailable`). `getState()` is synchronous and reads the last emitted state. Use `AbortSignal.timeout` for the probe. Do not parse the child's stdout for readiness.

- [x] **Step 5: Run the tests**

Run: `bun run --cwd packages/web test -- server/lib/embedded-knowledge/supervisor.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/web/server/lib/embedded-knowledge/supervisor.js packages/web/server/lib/embedded-knowledge/supervisor.test.js packages/web/server/lib/embedded-knowledge/test-fixtures/fake-embedded-knowledge.mjs
git commit -m "feat(knowledge): supervise the bundled the knowledge backend process"
```

---

### Task 3: First-run provisioning

**Files:**
- Create: `packages/web/server/lib/embedded-knowledge/provision.js`
- Test: `packages/web/server/lib/embedded-knowledge/provision.test.js`

**Interfaces:**
- Consumes: `createEmbeddedKnowledgeClient` (Task 1).
- Produces: `provisionKnowledgeBackend({ createClient, getState, saveState, modelApiKey })` → `{ tenantId, knowledgeBaseId, apiKey }`, idempotent at every step.

State persisted by the caller (settings runtime), not this module: `{ tenantId, email, password, knowledgeBaseId, apiKey, embeddingModelId, rerankModelId }`.

Steps, each skipped when its artefact is already in state. Payloads below were
confirmed against a fresh v0.8.3 instance on a temporary data directory
(2026-10-22):

1. `POST /auth/login` with the stored generated credentials; on 401,
   `POST /auth/register` (`{username,email,password}`; returns the user but no
   token) then login. `user.tenant_id` comes from the login response.
2. `POST /models` for `text-embedding-v4` (`type: 'Embedding'`, `source: 'remote'`, parameters `{ base_url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', api_key: modelApiKey, embedding_parameters: { dimension: 1024 } }`) and for `qwen3-rerank` (`type: 'Rerank'`, same base URL and key). Reuse existing rows when a model with the same name and type exists. The backend's `SSRF_WHITELIST_EXTRA` must include `dashscope.aliyuncs.com`, otherwise creation is rejected before the payload is read.
3. `POST /knowledge-bases` `{ name: 'SuperWagie 资料库', embedding_model_id }`.
4. `POST /tenants/:id/api-keys` `{ name: 'superwagie-runtime', capabilities: ['retrieve','ingest'], knowledge_base_ids: [kbId] }`. The response's `token` is the credential; `api_key` is a display id. Runtime calls send `X-API-Key: <token>`; `X-Tenant-ID` is optional.

- [x] **Step 1: Write the failing test over a fake backend**

```js
it('creates the account, models, KB and a scoped API key once', async () => {
  const fake = await startFakeBackend();           // local helper: records calls, answers the four endpoints
  const state = {};
  const result = await provisionKnowledgeBackend({
    client: createEmbeddedKnowledgeClient({ baseUrl: fake.url }),
    getState: () => state,
    saveState: (next) => Object.assign(state, next),
    modelApiKey: 'sk-test',
  });
  expect(result.knowledgeBaseId).toBe('kb-1');
  expect(state.apiKey).toBe('key-1');
  const keyCall = fake.calls.find((c) => c.path.endsWith('/api-keys'));
  expect(keyCall.body.capabilities).toEqual(['retrieve', 'ingest']);
  await provisionKnowledgeBackend({ client: createEmbeddedKnowledgeClient({ baseUrl: fake.url }), getState: () => state, saveState: (n) => Object.assign(state, n), modelApiKey: 'sk-test' });
  expect(fake.calls.filter((c) => c.path === '/api/v1/knowledge-bases')).toHaveLength(1);
});
```

- [x] **Step 2: Run it and confirm it fails**

Run: `bun run --cwd packages/web test -- server/lib/embedded-knowledge/provision.test.js`
Expected: FAIL — module missing.

- [x] **Step 3: Implement provisioning**

Each step is `if (state.x) return state.x;` then create, then `saveState`. Errors surface as typed codes (`provision_unauthorized`, `provision_model_failed`, …) that the settings page renders as sentences.

- [x] **Step 4: Run the test**

Run: `bun run --cwd packages/web test -- server/lib/embedded-knowledge/provision.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/embedded-knowledge/provision.js packages/web/server/lib/embedded-knowledge/provision.test.js
git commit -m "feat(knowledge): provision the local knowledge backend"
```

---

### Task 4: Library store and scan rules

**Files:**
- Create: `packages/web/server/lib/knowledge-library/store.js`
- Create: `packages/web/server/lib/knowledge-library/scan.js`
- Test: `packages/web/server/lib/knowledge-library/store.test.js`
- Test: `packages/web/server/lib/knowledge-library/scan.test.js`

**Interfaces:**
- Produces: `createKnowledgeLibraryStore({ dataDir, fsPromises })` with `readLibraries()`, `writeLibraries(list)`, `readDocuments()`, `writeDocuments(map)`; atomic temp-file + rename, serialized writes.
- Produces: `shouldIndex(relPath, { size })` → `{ ok: true } | { ok: false, code }`; `walkLibrary(root)` → `Array<{ relPath, absPath, size, mtimeMs }>`.

Rules:
- Extensions: `pdf, doc, docx, ppt, pptx, xls, xlsx, odt, odp, ods, rtf, epub, md, markdown, txt, csv`.
- Skip: any segment starting with `.`, `node_modules`, `dist`, `build`, `target`, `.git`, `__pycache__`, `vendor`, files starting with `~$`, and `size > 50 * 1024 * 1024`.
- Never follow symlinks (`lstat`, not `stat`).

- [x] **Step 1: Write the failing tests**

```js
it('round-trips libraries and survives a corrupt file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-lib-'));
  const store = createKnowledgeLibraryStore({ dataDir: dir });
  await store.writeLibraries([{ id: 'l1', root: '/tmp/x' }]);
  expect(await store.readLibraries()).toEqual([{ id: 'l1', root: '/tmp/x' }]);
  await fs.writeFile(path.join(dir, 'knowledge-library', 'libraries.json'), '{oops');
  expect(await store.readLibraries()).toEqual([]);
});

it('applies the ignore rules', () => {
  expect(shouldIndex('docs/a.pdf', { size: 10 }).ok).toBe(true);
  expect(shouldIndex('node_modules/a.pdf', { size: 10 })).toMatchObject({ ok: false, code: 'ignored' });
  expect(shouldIndex('docs/.hidden/a.pdf', { size: 10 })).toMatchObject({ ok: false, code: 'ignored' });
  expect(shouldIndex('docs/big.pdf', { size: 51 * 1024 * 1024 })).toMatchObject({ ok: false, code: 'too_large' });
  expect(shouldIndex('docs/a.exe', { size: 10 })).toMatchObject({ ok: false, code: 'unsupported' });
});

it('walks a tree without following symlinks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sw-scan-'));
  await fs.mkdir(path.join(root, 'sub'));
  await fs.writeFile(path.join(root, 'a.md'), 'x');
  await fs.writeFile(path.join(root, 'sub', 'b.txt'), 'y');
  await fs.symlink(path.join(root, 'a.md'), path.join(root, 'link.md'));
  const files = await walkLibrary(root);
  expect(files.map((f) => f.relPath).sort()).toEqual(['a.md', 'sub/b.txt']);
});
```

- [x] **Step 2: Run and confirm failure**

Run: `bun run --cwd packages/web test -- server/lib/knowledge-library/store.test.js server/lib/knowledge-library/scan.test.js`
Expected: FAIL — modules missing.

- [x] **Step 3: Implement both modules**

`store.js` writes `libraries.json` and `documents.json` under `<dataDir>/knowledge-library/`, creating the directory, writing to `*.tmp` then `rename`, and chaining writes on a single promise. A corrupt or missing file reads as an empty collection and is logged once; it never throws to a route.

`scan.js` is pure over `fsPromises` injected for tests. `walkLibrary` iterates with `readdir(dir, { withFileTypes: true })` and `lstat`, normalizes separators to `/`, and returns sorted output.

- [x] **Step 4: Run the tests**

Run: `bun run --cwd packages/web test -- server/lib/knowledge-library/store.test.js server/lib/knowledge-library/scan.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/knowledge-library/store.js packages/web/server/lib/knowledge-library/scan.js packages/web/server/lib/knowledge-library/*.test.js
git commit -m "feat(knowledge): library store and folder scan rules"
```

---

### Task 5: Ingest state machine (reference mode)

**Files:**
- Create: `packages/web/server/lib/knowledge-library/ingest.js`
- Test: `packages/web/server/lib/knowledge-library/ingest.test.js`

**Interfaces:**
- Consumes: `EmbeddedKnowledgeError`, the client (Task 1), the store (Task 4).
- Produces: `createIngestQueue({ client, store, getLibraries, onDocumentChange, now, concurrency, maxParseMs })` with:
  - `processOnce()` → `{ registered, completed, failed, skipped }`
  - `getStats()` → `{ queued, parsing, ready, failed, skipped, missing }`

Document states: `pending → queued → parsing → ready | failed`, plus `skipped` and `missing`. There is no `uploading` state: registering a reference is one call that either returns the record or fails.

Rules:
- New document: `registerReference({ path: absPath, title: basename, folderPath: '<slug>/<dirs>', metadata })`. The backend reads the file in place; no bytes leave the process and no copy is written.
- `metadata` carries `sw_document_id`, `sw_library_id`, `sw_rel_path`, `sw_sha256`.
- Change detection is a local streaming sha256 computed immediately before the call. Same hash → `ready` with no backend call (a touch that leaves content identical must not reparse).
- Changed content: `reparseKnowledge(knowledgeId)` on the existing record. The id survives and nothing is deleted first; on failure the document is `failed` and retried, and the source file is never touched.
- Parse polling: `GET /knowledge/:id`; `parse_status === 'completed'` with no pending subtasks → `ready`; `failed` carries the backend message; over `maxParseMs` → `parse_timeout`.
- A file that vanished before hashing → `missing`, no backend call.
- A `skipped` document (too large, unsupported) never enters the queue.

- [x] **Step 1: Write the failing test with a fake client**

```js
it('registers the absolute path and folder without sending bytes', async () => {
  const { absPath, store, client, queue } = await setup();
  await queue.processOnce();
  expect(client.registers[0]).toMatchObject({ path: absPath, title: 'a.md', folderPath: 'lib/sub' });
  expect(client.registers[0]).not.toHaveProperty('bytes');
  expect(store.document('d1')).toMatchObject({ state: 'ready', knowledgeId: 'k1' });
});

it('reparses the same knowledge record when the content changes', async () => {
  const { absPath, store, client, queue } = await setup();
  await queue.processOnce();
  await fs.writeFile(absPath, 'second');
  const documents = store.all();
  documents.d1.state = 'queued';
  await store.writeDocuments(documents);
  await queue.processOnce();
  expect(client.reparses).toEqual(['k1']);
  expect(client.registers).toHaveLength(1);
  expect(client.deletes).toEqual([]);
});
```

- [x] **Step 2: Run it and confirm it fails**

Run: `bun run --cwd packages/web test -- server/lib/knowledge-library/ingest.test.js`
Expected: FAIL — `registerReference` is not a function.

- [x] **Step 3: Implement the queue**

A pass registers at most `concurrency` documents and polls each document already parsing. The hash is computed with a read stream so a 50 MB file is never buffered. Every transition writes the ledger before the next side effect; a crash leaves `parsing`, which the next pass polls rather than duplicates.

- [x] **Step 4: Run the test**

Run: `bun run --cwd packages/web test -- server/lib/knowledge-library/ingest.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/knowledge-library/ingest.js packages/web/server/lib/knowledge-library/ingest.test.js
git commit -m "feat(knowledge): register documents by reference"
```

---

### Task 6: Merged search

**Files:**
- Create: `packages/web/server/lib/knowledge-library/search.js`
- Test: `packages/web/server/lib/knowledge-library/search.test.js`

**Interfaces:**
- Produces: `createSearch({ client, store, getConfig })` with `search({ query, libraryId, limit = 8 })` → `{ query, documents, passages }` exactly as the spec's merged shape.

Rules:
- File-name matching runs over the ledger (`store.allDocuments()`), not the backend: it is instant, correct while the backend is down, and the backend's `?keyword=` matches titles only.
- The backend call is `hybridSearch({ queryText })` alone.
- Library scope resolves `knowledge_ids` from documents in that library whose state is `ready`; the global case omits the field.
- Documents first (max 20), then passages (max `limit`), each trimmed to 1,200 characters; a `ready`-state document that appears in both is kept in both, because the passage is the citation.
- Only `ready` documents are returned; a `parsing` document is invisible to search.

- [x] **Step 1: Write the failing test**

```js
it('merges name hits before passages and drops non-ready documents', async () => {
  const client = {
    hybridSearch: async () => ([{ knowledge_id: 'k1', knowledge_title: '收益法.png', knowledge_filename: '收益法.png', content: 'x'.repeat(2000), chunk_index: 0, start_at: 0, end_at: 2000 },
                                  { knowledge_id: 'k2', knowledge_title: '旧.pdf', knowledge_filename: '旧.pdf', content: 'y', chunk_index: 0, start_at: 0, end_at: 1 }]),
  };
  const store = { allDocuments: () => [
    { id: 'd1', knowledgeId: 'k1', relPath: 'q/收益法.png', absPath: '/a/q/收益法.png', state: 'ready' },
    { id: 'd2', knowledgeId: 'k2', relPath: '旧.pdf', absPath: '/a/旧.pdf', state: 'failed' },
  ] };
  const { documents, passages } = await createSearch({ client, store }).search({ query: '收益法', libraryId: 'l1' });
  expect(documents.map((d) => d.documentId)).toEqual(['d1']);
  expect(passages).toHaveLength(1);
  expect(passages[0].content).toHaveLength(1200);
});
```

- [x] **Step 2: Run and confirm failure**

Run: `bun run --cwd packages/web test -- server/lib/knowledge-library/search.test.js`
Expected: FAIL.

- [x] **Step 3: Implement the merge**

One `Promise.all`, then a map from `knowledgeId → document record`. Unknown knowledge ids (records registered outside SuperWagie) are dropped: the feature only cites documents it can open. Rerank stays on by default; a client failure on the rerank path surfaces as an error rather than silently degrading to keyword-only, because a silent degradation is indistinguishable from bad recall.

- [x] **Step 4: Run the test**

Run: `bun run --cwd packages/web test -- server/lib/knowledge-library/search.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/knowledge-library/search.js packages/web/server/lib/knowledge-library/search.test.js
git commit -m "feat(knowledge): merge file-name and semantic search"
```

---

### Task 7: Watcher

**Files:**
- Create: `packages/web/server/lib/knowledge-library/watcher.js`
- Test: `packages/web/server/lib/knowledge-library/watcher.test.js`

**Interfaces:**
- Produces: `createLibraryWatcher({ fsWatch = fs.watch, schedule = setTimeout, cancelSchedule = clearTimeout, onDirty, reconcileIntervalMs = 600_000, debounceMs = 2_000 })` with `watch(path)`, `unwatch(path)`, `stop()`, and an injectable `reconcile(path)` callback.

Rules:
- One recursive `fs.watch` per library root on macOS/Windows; when `fs.watch` throws `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`, fall back to the reconcile interval alone.
- Events only mark the root dirty. A debounced flush (2 s, min 30 s between flushes per root) calls `onDirty(root)`.
- The 10-minute reconcile runs for every watched root regardless of events.

- [x] **Step 1: Write the failing test with injected timers**

```js
it('coalesces bursts into one reconcile and survives a watcher that cannot recurse', async () => {
  const flushes = [];
  let handler;
  const watcher = createLibraryWatcher({
    fsWatch: (_p, _o, cb) => { handler = cb; return { close() {} }; },
    schedule: (fn, ms) => { if (ms === 2_000) flushes.push(fn); return 1; },
    cancelSchedule: () => {},
    onDirty: (p) => flushes.push(() => p),
  });
  await watcher.watch('/tmp/root');
  handler('rename', 'a.md');
  handler('rename', 'b.md');
  expect(flushes).toHaveLength(1);
});
```

- [x] **Step 2: Run and confirm failure**

Run: `bun run --cwd packages/web test -- server/lib/knowledge-library/watcher.test.js`
Expected: FAIL.

- [x] **Step 3: Implement the watcher**

Keep the debounce timer per root, not per event. `stop()` closes every handle and clears every timer; a stopped watcher never schedules again.

- [x] **Step 4: Run the test**

Run: `bun run --cwd packages/web test -- server/lib/knowledge-library/watcher.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/web/server/lib/knowledge-library/watcher.js packages/web/server/lib/knowledge-library/watcher.test.js
git commit -m "feat(knowledge): watch library folders"
```

---

### Task 8: Runtime, routes and wiring

**Files:**
- Create: `packages/web/server/lib/knowledge-library/runtime.js`
- Create: `packages/web/server/lib/knowledge-library/routes.js`
- Create: `packages/web/server/lib/knowledge-library/routes.http.test.js`
- Create: `packages/web/server/lib/knowledge-library/DOCUMENTATION.md`
- Modify: `packages/web/server/index.js` (create the runtime in the composition root, pass it to feature routes and shutdown)
- Modify: `packages/web/server/lib/opencode/feature-routes-runtime.js` (register the routes; emit the SSE event)
- Modify: `packages/web/server/lib/opencode/shutdown-runtime.js` (stop the runtime and the supervisor)
- Modify: `packages/ui/src/lib/settings/registry.ts` (instance keys)
- Regenerate: `packages/ui/src/lib/settings/registry-snapshot.ts` via `bun run settings-registry:generate`

**Interfaces:**
- Consumes: everything from Tasks 1–7 plus `openchamberDataDir`, `getOpenChamberEventClients`, `writeSseEvent`, `readSettings`.
- Produces: `createKnowledgeLibraryRuntime(deps)` with `start()`, `stop()`, `getStatus()`, `addLibrary(path)`, `removeLibrary(id, { deleteRemote })`, `setLibraryEnabled(id, enabled)`, `rescan(id)`, `listDocuments(filter)`, `retryDocument(id)`, `cleanMissing()`, `search(input)`, `readContent(documentId)`, `getFile(documentId)`, `provision(modelApiKey)`.

Runtime behaviour:
- Settings drive enablement: `knowledgeLibraryEnabled` (default true) and `hasWeknoraApiKey`. On `start()`: resolve binary; if absent → `not-installed`; if present, start supervisor, then provision if no key exists.
- `getStatus()` returns `{ supported, enabled, backend: { state, port }, provisioned, indexing: { queued, parsing, failed }, libraries: n }` and never includes secrets.
- `onDocumentChange` and library mutations emit `openchamber:knowledge-library-changed` through the injected emitter (routes own the SSE call, matching `project-context`).
- Routes mount `express.json({ limit: '64kb' })` themselves, validate with small hand-written guards (no new schema dependency), and return `{ error: code }` with 400/404/409/503.

Routes (all under `/api/knowledge-library`): `status`, `libraries` (GET/POST/PATCH/DELETE), `libraries/:id/rescan`, `documents`, `documents/:id/retry`, `documents/:id/content`, `documents/:id/file`, `clean-missing`, `search`, `provision`, `reconnect`, `rebuild`.

- [x] **Step 1: Write the failing HTTP test**

```js
it('reports unsupported without a backend and rejects a relative path', async () => {
  const app = express();
  const runtime = createFakeRuntime({ supported: false });
  registerKnowledgeLibraryRoutes(app, { runtime });
  await request(app).get('/api/knowledge-library/status').expect(200, { supported: false, enabled: false });
  await request(app).post('/api/knowledge-library/libraries').send({ path: 'relative/dir' }).expect(400, { error: 'path_not_absolute' });
});

it('never echoes the API key', async () => {
  const app = express();
  registerKnowledgeLibraryRoutes(app, { runtime: createFakeRuntime({ apiKey: 'secret' }) });
  const body = await request(app).get('/api/knowledge-library/status').expect(200);
  expect(JSON.stringify(body.body)).not.toContain('secret');
  expect(body.body.provisioned).toBe(true);
});
```

- [x] **Step 2: Run and confirm failure**

Run: `bun run --cwd packages/web test -- server/lib/knowledge-library/routes.http.test.js`
Expected: FAIL.

- [x] **Step 3: Implement runtime and routes; wire composition**

- `index.js`: `const knowledgeLibraryRuntime = createKnowledgeLibraryRuntime({ dataDir: OPENCHAMBER_DATA_DIR, readSettings, ... });` next to `messageSearchRuntime`, pass it into the feature-routes deps and the shutdown deps.
- `feature-routes-runtime.js`: `registerKnowledgeLibraryRoutes(app, { runtime: knowledgeLibraryRuntime })`, and publish `openchamber:knowledge-library-changed` from an `onChanged` callback copied from `project-context`'s block.
- `shutdown-runtime.js`: `() => knowledgeLibraryRuntime?.stop?.()` beside `messageSearchRuntime?.stop?.()`.
- `start()` is called once after the server listens (persisted settings are available then); a failure sets `unavailable` and never aborts startup.

- [x] **Step 4: Add the settings keys and regenerate snapshots**

Registry fields (instance scope, no UI binding except the two toggles):
`knowledgeLibraryEnabled` (boolean, default true), `embeddedKnowledgeBinaryPath` (nullable trimmed path), `embeddedKnowledgePort` (finite number, default 17808), `embeddedKnowledgeApiKey` (secret, nullable), `embeddedKnowledgeBaseId` (trimmed string), `embeddedKnowledgeTenantId` (finite number), `embeddedKnowledgeLocalEmail` (trimmed string), `embeddedKnowledgeLocalPassword` (secret, nullable), `hasWeknoraApiKey` (computed boolean), `agentLibraryToolEnabled` (boolean).

Run: `bun run settings-registry:generate`
Expected: `packages/web/server/lib/opencode/settings-registry.json` and `packages/vscode/src/settings-registry.json` both list the new keys; `registry.test.ts` passes.

- [x] **Step 5: Write `DOCUMENTATION.md`**

Ownership (what the module owns; what `embedded-knowledge` owns instead), invariants (ledger identity is relative path, the absolute path enters the backend only through the ref endpoint and is never returned to clients, one KB, non-ready documents are invisible, secrets are write-only), decisions: why one KB with folder paths, why relative path is identity, why a change reparses in place instead of delete-and-register, why the reconcile sweep exists, why scoping uses `knowledge_ids`, and why ingest is the only module that knows how a file enters the backend (so a different ingest contract swaps in without touching the ledger, search or UI).

- [x] **Step 6: Run the tests**

Run: `bun run --cwd packages/web test -- server/lib/knowledge-library/`
Expected: PASS (routes + runtime).

- [ ] **Step 7: Commit**

```bash
git add packages/web/server/lib/knowledge-library packages/web/server/index.js packages/web/server/lib/opencode/feature-routes-runtime.js packages/web/server/lib/opencode/shutdown-runtime.js packages/ui/src/lib/settings
git commit -m "feat(knowledge): knowledge library runtime, routes and settings"
```

---

### Task 9: Library panel (UI)

**Files:**
- Create: `packages/ui/src/lib/knowledge-library/types.ts`, `client.ts`
- Create: `packages/ui/src/components/layout/panels/KnowledgeLibraryPanel.tsx`
- Create: `packages/ui/src/components/layout/panels/knowledge-library/{LibraryTree,LibrarySearch,DocumentRow,LibraryStatusBanner}.tsx`
- Modify: `packages/ui/src/lib/surfaces/registry.ts` (add `library` surface)
- Modify: `packages/ui/src/lib/surfaces/modes.ts` (add `library` mode)
- Modify: `packages/ui/src/components/layout/ContextSurfacePanes.tsx` (render the panel)
- Modify: the UI string catalog used by `labelKey`/`descriptionKey`

**Interfaces:**
- Consumes: the routes from Task 8 through `runtimeFetch`.
- Produces: a surface with id `library`, `mode: 'library'`, `width: 'regular'`, availability desktop-only; opening it runs a reconcile and shows cached state immediately.

Behaviour:
- Header: one search input, an add-folder button (`requestDirectoryAccess()` on desktop, disabled elsewhere), and a refresh action.
- Tree: libraries → folders → documents; each document row shows state (dot + title) and opens the file preview on click; search results show two sections (文件 / 相关段落) and open the document at the passage for text formats.
- Banner when `status.backend.state !== 'running'`: sentence + `重试` + log path.
- Add flow: folder picker → confirm dialog with file count, skipped count and the sentence that indexing calls a remote model → `POST libraries`.
- Remove flow: confirm with a delete-remote checkbox (default off).

- [x] **Step 1: Add the surface descriptor and a rendering stub that shows the status banner**

Run the app, open the rail, confirm the new entry renders and reads live `status`.

- [x] **Step 2: Implement tree and document list**

Use existing list/virtualization patterns from `SidebarFilesTree`; do not add a tree library.

- [x] **Step 3: Implement search and result groups; wire opening a document**

Text formats open with a `:startLine` hint derived from `startAt`; other formats open the file preview.

- [ ] **Step 4: Verify manually in the desktop app**

Add a small folder with a `.md`, a `.pdf` and a skipped `.exe`; confirm progress, search by name, search by meaning, open a result, and reload the panel.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/lib/knowledge-library packages/ui/src/components/layout/panels packages/ui/src/lib/surfaces packages/ui/src/components/layout/ContextSurfacePanes.tsx
git commit -m "feat(knowledge): library context panel"
```

---

### Task 10: Settings page

**Files:**
- Create: `packages/ui/src/components/sections/library/LibrarySettings.tsx`
- Modify: `packages/ui/src/lib/settings/metadata.ts` (new `library` page, keywords)
- Modify: `packages/ui/src/components/views/SettingsView.tsx` (switch case)

Contents, in order: enable switch; backend status row (state, port, log path) with `重试`; embedding-key field only while `provisioned === false` (write-only, submit → `POST provision`); library list with the same remove flow as the panel; collapsed advanced group with ignore rules and `重建索引`; danger zone with `删除所有索引数据` (typed confirmation).

- [x] **Step 1: Add the page and enable switch; verify persistence across restart**
- [x] **Step 2: Add provisioning form and error rendering (codes → sentences)**
- [x] **Step 3: Add advanced and danger actions with confirmations** (rebuild shipped; ignore rules stay fixed and removing indexed data belongs to a library's own remove action)
- [ ] **Step 4: Manual check in desktop: first-run flow from an empty data directory**

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/components/sections/library packages/ui/src/lib/settings/metadata.ts packages/ui/src/components/views/SettingsView.tsx
git commit -m "feat(knowledge): library settings page"
```

---

### Task 11: Agent tool

**Files:**
- Create: `packages/web/server/lib/openchamber-control/library.js`
- Modify: `packages/web/server/lib/openchamber-control/actions.js` (two action definitions)
- Modify: `packages/web/server/lib/openchamber-control/service.js` (dispatch)
- Modify: `packages/web/server/lib/agent-tool/runtime.js` (tool declaration `openchamber_library`)
- Modify: `packages/ui/src/lib/settings/registry.ts` (already added `agentLibraryToolEnabled` in Task 8)
- Test: `packages/web/server/lib/openchamber-control/library.test.js`

**Interfaces:**
- Consumes: `knowledgeLibraryRuntime.search()` and `readContent()`.
- Produces: actions `library.search` and `library.read`; tool `openchamber_library` with inputs `{ action, query, library, documentId, path, maxChars }`.

Behaviour: the tool is declared only while the feature is enabled and the runtime reports `provisioned`; a call while the backend is down returns `{ error: 'library_unavailable' }`. Results are trimmed for the model: top 5 passages of at most 600 characters, plus every matching file with its absolute `path` so the chat renders a clickable reference. `library.read` returns at most `maxChars` (default 20,000) with an explicit truncation marker.

- [x] **Step 1: Write the failing unit test**

```js
it('returns path-bearing results and refuses when the backend is down', async () => {
  const runtime = { search: async () => ({ documents: [{ documentId: 'd1', path: '/a/b.md', title: 'b.md' }], passages: [] }), readContent: async () => 'body' };
  const call = createLibraryActions({ runtime });
  expect(await call('library.search', { query: 'x' })).toMatchObject({ documents: [{ path: '/a/b.md' }] });
  const down = createLibraryActions({ runtime: { ...runtime, isReady: () => false } });
  expect(await down('library.search', { query: 'x' })).toEqual({ error: 'library_unavailable' });
});
```

- [x] **Step 2: Implement dispatch and the tool declaration; follow the `openchamber_knowledge` pattern in `agent-tool/runtime.js`**

- [x] **Step 3: Manual check: ask the agent a question whose answer is only in an indexed file; confirm the tool call and a clickable citation in the answer**

- [ ] **Step 4: Commit**

```bash
git add packages/web/server/lib/openchamber-control packages/web/server/lib/agent-tool/runtime.js
git commit -m "feat(knowledge): expose the library to the agent"
```

---

### Task 12: Packaging and CI

**Files:**
- Create: `packages/electron/scripts/prepare-embedded-knowledge.mjs`
- Modify: `packages/electron/package.json` (`prepare:embedded-knowledge` script, `package` chain, extraResources `resources/embedded-knowledge → embedded-knowledge`)
- Modify: `packages/electron/.gitignore` (generated resource)
- Modify: `packages/electron/main.mjs` (`EMBEDDED_KNOWLEDGE_BIN` injected into the in-process server environment when the staged binary exists)

Behaviour: the script stages the bundled backend from the public fork — never
from a developer checkout. Source `https://github.com/NeoMei/embedded-knowledge`, branch
`embedded-knowledge`, pinned commit `f5adb9e` (upstream `v0.8.3` plus
`ref-ingest.patch`). It fetches that commit into `packages/electron/.cache/embedded-knowledge/src`,
builds with `EDITION=lite CGO_ENABLED=1 go build -tags sqlite_fts5 -o embedded-knowledge-server ./cmd/server`
(macOS also gets the cgo flags from the fork's build notes), and stages into
`resources/embedded-knowledge/`: the binary, `config/` (127.0.0.1:17808), `migrations/sqlite/`,
`LICENSE`, `THIRD_PARTY_NOTICES.md`, `REFERENCE_INGEST.md`, and a
`manifest.json` with repo/ref/commit/tags/binarySha256. A rerun with the same
pin and a present resource is a no-op; `--force` rebuilds. `OPENCHAMBER_EMBEDDED_KNOWLEDGE_REPO`
and `OPENCHAMBER_EMBEDDED_KNOWLEDGE_REF` override the pin for a rebuild on a new commit.

- [x] **Step 1: Write the script and wire the packaging entries**

Run: `bun run --cwd packages/electron prepare:embedded-knowledge`
Expected: clones the pinned commit, builds the Go binary, stages the resource
directory, prints the commit.

- [x] **Step 2: Build the desktop app and confirm both states**

With the resource staged the feature reports `supported`; remove
`resources/embedded-knowledge` and it reports `not-installed` with every other surface
unaffected.

- [x] **Step 3: Confirm the licence files and the manifest ship**

`resources/embedded-knowledge/LICENSE`, `THIRD_PARTY_NOTICES.md` and `manifest.json` are
present in the packaged app's `Resources/embedded-knowledge/`.

- [ ] **Step 4: Commit**

```bash
git add packages/electron/scripts/prepare-embedded-knowledge.mjs packages/electron/package.json packages/electron/.gitignore packages/electron/main.mjs
git commit -m "build(knowledge): bundle the backend reference backend"
```

---

## Self-Review

- Spec coverage: runtime scope (Task 8/10), bundling and first run (Tasks 2/3/12), supervision (Task 2), storage (Task 4), watch (Task 7), ingest (Task 5), search (Task 6), content retrieval (Tasks 5/8), agent tool (Task 11), UI (Tasks 9/10), settings (Task 8), security and failure behaviour (Tasks 1/5/8), testing seams (Tasks 1/6/8 run the three seams).
- No placeholders: every task names exact files, interfaces, test code, and a runnable command. Payloads that cannot be known before probing the backend are called out as a single verify-then-adjust step in Task 3.
- Type consistency: `documentId`, `knowledgeId`, `relPath`, `absPath`, `startAt`/`endAt`, `libraryId` are used identically across Tasks 4–11; `createEmbeddedKnowledgeClient` returns `data` consistently; `getStatus()` shape matches the route test and the UI reads.
- Deliberate omissions: no retry queue persistence, no partial-file hashing, no per-library concurrency beyond one global pool of two, no mobile/web surface.

## Out of Scope (from the spec)

Upstream-only builds (a binary without reference ingest loses ingest, not other features), migrating the user's pre-existing local knowledge installation, multiple KBs, the backend's chat/wiki/FAQ/agents, web/VS Code/mobile surfaces, graph RAG, media ingestion, cross-device sync.
