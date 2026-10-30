import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { createEmbeddedKnowledgeClient } from '../server/lib/embedded-knowledge/client.js';

const requiredArguments = ['--backend=/absolute/binary', '--backend-root=/absolute/source', '--python=/absolute/python'];
export const smokeFailure = (code) => Object.assign(new Error(code), { code });
const safeCode = (error) => /^[a-z][a-z0-9_:-]{0,79}$/.test(error?.code ?? '') ? error.code : error?.code === 'ERR_ASSERTION' ? 'smoke_assertion_failed' : 'smoke_failed';
const diagnosticCode = (value) => value == null ? null : /^[a-z][a-z0-9_:-]{0,79}$/.test(value) ? value : 'smoke_unclassified_error';
const diagnosticsSchema = z.object({
  enabled: z.boolean(), generationCalls: z.number().int().nonnegative(), pending: z.number().int().nonnegative(), lastError: z.string().nullable(),
  snapshotFresh: z.boolean().optional(),
  generationBreakdown: z.object({ capture: z.number().int().nonnegative(), system2: z.number().int().nonnegative(), behavior: z.number().int().nonnegative() }).optional(),
  engine: z.object({ state: z.enum(['stopped', 'starting', 'ready', 'unavailable']), error: z.string().nullable() }),
  jobs: z.array(z.object({ state: z.enum(['queued', 'extracting', 'indexing', 'done', 'failed', 'unknown']), error: z.string().nullable(),
    attempts: z.number().int().nonnegative(), sourceRevision: z.number().int().nonnegative(), hasGeneratedReceipt: z.boolean() })).max(20),
  syntheses: z.array(z.object({ state: z.enum(['queued', 'extracting', 'indexing', 'done', 'failed', 'unknown']), error: z.string().nullable(),
    attempts: z.number().int().nonnegative(), automatic: z.boolean(), supportCount: z.number().int().nonnegative(), hasGeneratedReceipt: z.boolean() })).max(20),
  sessions: z.array(z.object({ revision: z.number().int().nonnegative(), reconciling: z.boolean(), deleted: z.boolean() })).max(20),
  entries: z.array(z.object({ kind: z.enum(['segment', 'experience', 'methodology']), status: z.enum(['candidate', 'active', 'superseded', 'forgotten']),
    indexState: z.enum(['pending', 'ready', 'failed']), error: z.string().nullable() })).max(20),
  projections: z.array(z.object({ state: z.enum(['pending', 'done', 'failed']), error: z.string().nullable() })).max(20),
  records: z.object({ trace: z.number().int().nonnegative(), code_history: z.number().int().nonnegative(), review: z.number().int().nonnegative(),
    'node-source': z.number().int().nonnegative(), relation: z.number().int().nonnegative(), 'model-space': z.number().int().nonnegative(), 'hy-withdrawal': z.number().int().nonnegative() }),
});

/** Fixture diagnostics expose bounded state transitions and codes without record identities or prose. */
export function smokeRuntimeFailure(code, { state, engine, generationCalls, generationBreakdown, snapshotFresh }) {
  const summary = {
    enabled: state.enabled, generationCalls, pending: state.pending.length, lastError: diagnosticCode(state.lastError),
    engine: { state: engine.state, error: diagnosticCode(engine.error) },
    jobs: state.jobs.slice(0, 20).map((job) => ({ state: job.state, error: diagnosticCode(job.error), attempts: job.attempts,
      sourceRevision: job.sourceRevision, hasGeneratedReceipt: job.generated !== null })),
    syntheses: (state.syntheses ?? []).slice(0, 20).map((job) => ({ state: job.state, error: diagnosticCode(job.error), attempts: job.attempts,
      automatic: job.automatic, supportCount: job.supports.length, hasGeneratedReceipt: job.generated !== null })),
    sessions: Object.values(state.sessions).slice(0, 20).map((session) => ({ revision: session.revision, reconciling: session.reconciling, deleted: session.deleted })),
    entries: state.entries.slice(0, 20).map((entry) => ({ kind: entry.kind, status: entry.status, indexState: entry.indexState, error: diagnosticCode(entry.error) })),
    projections: state.engine.projections.slice(0, 20).map((projection) => ({ state: projection.state, error: diagnosticCode(projection.error) })),
    records: Object.fromEntries(['trace', 'code_history', 'review', 'node-source', 'relation', 'model-space', 'hy-withdrawal']
      .map((collection) => [collection, state.engine.records.filter((record) => record.collection === collection).length])),
  };
  if (generationBreakdown) summary.generationBreakdown = generationBreakdown;
  if (snapshotFresh !== undefined) summary.snapshotFresh = snapshotFresh;
  const diagnostics = diagnosticsSchema.parse(summary);
  return Object.assign(smokeFailure(code), { diagnostics });
}

/** Native fixture deadlines report their phase, then cancel owned work without changing assertions. */
export async function smokePhase(progress, stage, operation, { timeoutMs = 60_000, diagnose = null, cancel = null } = {}) {
  progress.stage = stage;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      void (async () => {
        let failure = smokeFailure('smoke_phase_timeout'); let diagnosticTimer;
        if (diagnose) {
          try {
            failure = await Promise.race([diagnose(), new Promise((resolve) => { diagnosticTimer = setTimeout(() => resolve(failure), 1000); })]);
          } catch { /* The phase deadline survives a blocked diagnostics read. */ }
          finally { clearTimeout(diagnosticTimer); }
        }
        reject(failure);
        if (cancel) { try { void Promise.resolve(cancel()).catch(() => {}); } catch { /* Cleanup also runs through the fixture owner. */ } }
      })();
    }, timeoutMs);
  });
  try { return await Promise.race([Promise.resolve().then(operation), deadline]); }
  finally { clearTimeout(timer); }
}
const listen = (server) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); });
const executable = async (file) => { const stat = await fs.stat(file); if (!stat.isFile()) throw smokeFailure('smoke_input_unavailable'); await fs.access(file, fs.constants.X_OK); };

async function parseArguments(args) {
  if (args.length === 1 && args[0] === '--help') return null;
  const flags = new Map();
  for (const arg of args) {
    const match = /^--(backend|backend-root|python)=(.+)$/.exec(arg);
    if (!match || flags.has(match[1]) || !path.isAbsolute(match[2])) throw smokeFailure('smoke_arguments_invalid');
    flags.set(match[1], match[2]);
  }
  if (flags.size !== 3) throw smokeFailure('smoke_arguments_invalid');
  try {
    await Promise.all([executable(flags.get('backend')), executable(flags.get('python')),
      fs.access(path.join(flags.get('backend-root'), 'config', 'config.yaml'), fs.constants.R_OK),
      fs.access(path.join(flags.get('backend-root'), 'migrations', 'sqlite'), fs.constants.R_OK)]);
  } catch { throw smokeFailure('smoke_input_unavailable'); }
  return { backend: flags.get('backend'), backendRoot: flags.get('backend-root'), python: flags.get('python') };
}

const childEnvironment = (root, port) => ({
  ...Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR', 'SYSTEMDRIVE'].filter((name) => process.env[name]).map((name) => [name, process.env[name]])),
  DB_DRIVER: 'sqlite', RETRIEVE_DRIVER: 'sqlite', DB_PATH: path.join(root, 'backend.db'), SERVER_HOST: '127.0.0.1', SERVER_PORT: String(port),
  STORAGE_TYPE: 'local', LOCAL_STORAGE_BASE_DIR: path.join(root, 'files'), LOG_PATH: path.join(root, 'backend-app.log'),
  SYSTEM_AES_KEY: randomBytes(16).toString('hex'), JWT_SECRET: randomBytes(32).toString('hex'),
  SSRF_WHITELIST_EXTRA: '127.0.0.1', NEO4J_ENABLE: 'false', ENABLE_GRAPH_RAG: 'false', LOG_LEVEL: 'warn', STREAM_MANAGER_TYPE: 'memory', REDIS_ADDR: '',
});

async function withNativeBackend(options, progress, scenario, vectorForText) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hy-native-smoke-'));
  const runtimes = new Map();
  let model; let child; let log; let childFailure = null;
  try {
    await fs.cp(path.join(options.backendRoot, 'config'), path.join(root, 'config'), { recursive: true });
    await fs.cp(path.join(options.backendRoot, 'migrations', 'sqlite'), path.join(root, 'migrations', 'sqlite'), { recursive: true });
    log = await fs.open(path.join(root, 'backend-process.log'), 'w', 0o600);
    model = http.createServer(async (request, response) => {
      try {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const input = JSON.parse(Buffer.concat(chunks).toString());
        if (request.method !== 'POST' || !request.url?.endsWith('/embeddings')) { response.writeHead(404); response.end('{}'); return; }
        const texts = Array.isArray(input.input) ? input.input : [input.input];
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ object: 'list', data: texts.map((text, index) => ({ object: 'embedding', index, embedding: vectorForText(text) })),
          model: 'synthetic-embedding', usage: { prompt_tokens: 1, total_tokens: 1 } }));
      } catch { response.writeHead(400); response.end('{}'); }
    });
    await listen(model);
    const slot = net.createServer(); await listen(slot); const port = slot.address().port; await close(slot);
    child = spawn(options.backend, [], { cwd: root, stdio: ['ignore', log.fd, log.fd], windowsHide: true, env: childEnvironment(root, port) });
    child.once('error', () => { childFailure = 'smoke_backend_spawn_failed'; });
    child.once('exit', () => { childFailure ??= 'smoke_backend_exited'; });
    const baseUrl = `http://127.0.0.1:${port}`;
    progress.stage = 'backend_start';
    let healthy = false;
    for (let attempt = 0; attempt < 150; attempt++) {
      if (childFailure) throw smokeFailure(childFailure);
      try { healthy = (await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1000) })).ok; if (healthy) break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!healthy) throw smokeFailure('smoke_backend_start_timeout');
    progress.stage = 'backend_register';
    const anonymous = createEmbeddedKnowledgeClient({ baseUrl });
    const email = `hy-smoke-${randomBytes(8).toString('hex')}@example.test`; const password = `Fixture-1${randomBytes(8).toString('hex')}!`;
    await anonymous.register({ email, password, username: 'Hy smoke fixture' });
    progress.stage = 'backend_login';
    const auth = await anonymous.login(email, password);
    const client = createEmbeddedKnowledgeClient({ baseUrl, sessionToken: auth.token });
    progress.stage = 'embedding_model';
    const embedding = await client.createModel({ name: 'synthetic-embedding', display_name: 'Synthetic embedding', type: 'Embedding', source: 'remote',
      parameters: { provider: 'openai', base_url: `http://127.0.0.1:${model.address().port}/v1`, api_key: 'synthetic-fixture-value', embedding_parameters: { dimension: 2 } } });
    progress.stage = 'knowledge_base';
    const knowledgeBase = await client.createKnowledgeBase({ name: 'Hy native smoke fixture', embeddingModelId: embedding.id });
    const backend = (action, input) => client.memoryIndex({ knowledgeBaseId: knowledgeBase.id, action, input });
    progress.stage = 'memory_capabilities';
    const capabilities = await backend('capabilities', {}); assert(capabilities.features.includes('atomic-index-commit'));
    progress.stage = 'embedding_probe';
    const vectors = await backend('embed', { texts: ['synthetic dimension probe'] }); assert.equal(vectors.dimensions, 2);
    progress.stage = 'knowledge_strategy';
    await client.updateKnowledgeBase(knowledgeBase.id, { name: 'Hy native smoke fixture', config: { indexing_strategy: { vector_enabled: true, keyword_enabled: true, wiki_enabled: true, graph_enabled: false } } });
    assert.equal((await client.getKnowledgeBase(knowledgeBase.id)).indexing_strategy.wiki_enabled, true);
    const switchEmbeddingConfiguration = () => client.updateModel(embedding.id, { name: 'synthetic-embedding-next', type: 'Embedding', source: 'remote',
      parameters: { provider: 'openai', base_url: `http://127.0.0.1:${model.address().port}/v1`, embedding_parameters: { dimension: 2 } } });
    return await scenario({ root, backend, switchEmbeddingConfiguration, ownRuntime: (runtime, abort = async () => {}) => { runtimes.set(runtime, abort); return runtime; } }, options, progress);
  } finally {
    try {
      let timer;
      const stopping = Promise.allSettled([...runtimes].map(async ([runtime, abort]) => { await abort(); await runtime.stop(); }));
      try { await Promise.race([stopping, new Promise((resolve) => { timer = setTimeout(resolve, 5000); })]); }
      finally { clearTimeout(timer); }
    }
    finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        await new Promise((resolve) => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000); timer.unref(); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill(); });
      }
      if (model?.listening) await close(model);
      await log?.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  }
}

/** Both native fixtures share isolated process ownership and safe JSON output. */
export async function nativeSmokeMain(scenario, { vectorForText = () => [1, 0] } = {}) {
  const progress = { stage: 'arguments' };
  try {
    const options = await parseArguments(process.argv.slice(2));
    const result = options ? await withNativeBackend(options, progress, scenario, vectorForText) : { requiredArguments,
      output: 'One JSON summary; nonzero exit on failure', isolation: 'Temporary SQLite database, loopback backend and synthetic model responses' };
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const failure = { ok: false, stage: progress.stage, error: { code: safeCode(error) } };
    const diagnostics = diagnosticsSchema.safeParse(error?.diagnostics);
    if (diagnostics.success) failure.diagnostics = diagnostics.data;
    process.stdout.write(`${JSON.stringify(failure)}\n`);
    process.exitCode = 1;
  }
}
