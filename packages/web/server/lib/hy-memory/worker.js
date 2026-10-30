import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';

const messageSchema = z.object({ id: z.union([z.string(), z.number()]), method: z.string().optional(), params: z.json().optional(), result: z.json().optional(), error: z.object({ code: z.string(), message: z.string().optional() }).optional() });
const capabilitiesSchema = z.object({ engine: z.literal('hy-memory'), version: z.string(), source_sha: z.literal('988667cd876fb80bee6d618482f78a2fe426402c'), features: z.array(z.string()).optional() }).passthrough();
const failure = (code) => Object.assign(new Error(code), { code });
const safeEnvironment = () => Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR', 'SYSTEMDRIVE'].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
const defaultScript = fileURLToPath(new URL('./python/worker.py', import.meta.url));
const developmentRuntime = fileURLToPath(new URL('../../../../electron/resources/hy-memory/runtime', import.meta.url));

/** One owned stdio process. No provider keys or local API credentials cross this boundary. */
export function createHyMemoryWorker({ command, script = process.env.OPENCHAMBER_HY_MEMORY_WORKER_SCRIPT || defaultScript, runtimeDirectory = process.env.OPENCHAMBER_HY_MEMORY_RUNTIME_DIR,
  handlers = {}, spawnImpl = spawn, onState = () => {}, timeoutMs = 900_000 } = {}) {
  let active = null; let nextId = 0; let state = 'stopped'; let error = null; let stopped = false; let closing = Promise.resolve();
  const setState = (value, code = null) => { state = value; error = code; onState({ state, error }); };
  const retire = (generation, reason) => {
    if (generation.closed) return generation.exited;
    generation.closed = true;
    for (const work of generation.pending.values()) work.reject(reason);
    generation.pending.clear();
    if (active === generation) {
      active = null;
      if (!stopped) setState('unavailable', reason.code);
    }
    const exiting = new Promise((resolve) => {
      if (generation.didExit) { resolve(); return; }
      const timer = setTimeout(() => { generation.child.kill('SIGKILL'); resolve(); }, 2000); timer.unref?.();
      generation.child.once('exit', () => { clearTimeout(timer); resolve(); });
      generation.child.kill();
    });
    generation.exited = exiting;
    closing = Promise.all([closing, exiting]).then(() => {});
    return exiting;
  };
  const send = (generation, value) => {
    if (active !== generation || generation.closed || !generation.child.stdin?.writable) throw failure('hy_worker_unavailable');
    const line = JSON.stringify(value);
    if (Buffer.byteLength(line) > 16 * 1024 * 1024) throw failure('hy_message_too_large');
    generation.child.stdin.write(`${line}\n`);
  };
  const receive = async (generation, raw) => {
    if (generation.closed || active !== generation) return;
    const parsed = messageSchema.safeParse(raw);
    if (!parsed.success) { void retire(generation, failure('hy_protocol_invalid')); return; }
    const message = parsed.data;
    if (message.method) {
      if (!message.method.startsWith('host.') || !handlers[message.method]) { send(generation, { id: message.id, error: { code: 'hy_host_operation_unsupported' } }); return; }
      let response;
      try { response = { id: message.id, result: await handlers[message.method](message.params ?? {}) }; }
      catch (cause) { response = { id: message.id, error: { code: /^[a-z][a-z0-9_:-]{0,79}$/.test(cause?.code ?? '') ? cause.code : 'hy_host_operation_failed' } }; }
      if (!generation.closed && active === generation) send(generation, response);
      return;
    }
    const work = generation.pending.get(String(message.id));
    if (!work) return;
    generation.pending.delete(String(message.id));
    if (message.error) work.reject(failure(message.error.code));
    else if (Object.hasOwn(message, 'result')) work.resolve(message.result);
    else { work.reject(failure('hy_protocol_invalid')); void retire(generation, failure('hy_protocol_invalid')); }
  };
  const request = (generation, method, params, { signal, deadlineMs = timeoutMs } = {}) => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(failure('hy_cancelled')); return; }
    const id = String(++nextId);
    const finish = (settle) => (value) => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); settle(value); };
    const cancel = () => { void retire(generation, failure('hy_cancelled')); };
    const timer = setTimeout(() => { void retire(generation, failure('hy_generation_timeout')); }, deadlineMs);
    timer.unref?.();
    generation.pending.set(id, { resolve: finish(resolve), reject: finish(reject) });
    signal?.addEventListener('abort', cancel, { once: true });
    try { send(generation, { id, method, params }); } catch (cause) { generation.pending.delete(id); finish(reject)(cause); }
  });
  const start = async () => {
    if (stopped) throw failure('hy_worker_stopped');
    if (active) return active.ready;
    await closing;
    if (stopped) throw failure('hy_worker_stopped');
    if (active) return active.ready;
    setState('starting');
    const runtime = runtimeDirectory || (existsSync(developmentRuntime) ? developmentRuntime : null);
    const binary = command || process.env.OPENCHAMBER_HY_MEMORY_PYTHON || (runtime ? path.join(runtime, process.platform === 'win32' ? 'python.exe' : 'bin/python3') : 'python3');
    let child;
    try { child = spawnImpl(binary, [script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...safeEnvironment(), PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1' } }); }
    catch { setState('unavailable', 'hy_runtime_not_installed'); throw failure('hy_runtime_not_installed'); }
    const generation = { child, buffer: '', decoder: new StringDecoder('utf8'), pending: new Map(), closed: false, didExit: false, exited: null, ready: null };
    active = generation;
    generation.ready = (async () => {
      child.stdout.on('data', (chunk) => {
        if (generation.closed || active !== generation) return;
        generation.buffer += generation.decoder.write(chunk);
        if (Buffer.byteLength(generation.buffer) > 16 * 1024 * 1024) { void retire(generation, failure('hy_message_too_large')); return; }
        let at;
        while ((at = generation.buffer.indexOf('\n')) >= 0) {
          const line = generation.buffer.slice(0, at); generation.buffer = generation.buffer.slice(at + 1);
          if (!line.trim()) continue;
          try { void receive(generation, JSON.parse(line)).catch(() => retire(generation, failure('hy_protocol_invalid'))); }
          catch { void retire(generation, failure('hy_protocol_invalid')); }
          if (generation.closed) break;
        }
      });
      // Diagnostic output may contain model text; it is never forwarded to app logs.
      child.stderr.on('data', () => {});
      child.stdin.on?.('error', () => { void retire(generation, failure('hy_worker_unavailable')); });
      child.on('error', () => { void retire(generation, failure('hy_runtime_not_installed')); });
      child.on('exit', () => { generation.didExit = true; void retire(generation, failure('hy_worker_exited')); });
      try {
        const result = await request(generation, 'capabilities', {}, { deadlineMs: 30_000 });
        const parsed = capabilitiesSchema.safeParse(result);
        if (!parsed.success) throw failure('hy_capabilities_invalid');
        if (active !== generation || generation.closed || stopped) throw failure('hy_worker_stopped');
        setState('ready'); return parsed.data;
      } catch (cause) { void retire(generation, cause?.code ? cause : failure('hy_protocol_invalid')); throw cause; }
    })();
    return generation.ready;
  };
  return {
    capabilities: start,
    async call(method, params, options) { await start(); if (!active) throw failure('hy_worker_unavailable'); return request(active, method, params, options); },
    status: () => ({ engine: 'hy-memory', state, error }),
    async stop() {
      stopped = true;
      setState('stopped');
      if (active) await retire(active, failure('hy_worker_stopped'));
      await closing;
    },
  };
}
