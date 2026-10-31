import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { z } from 'zod';
import request from 'supertest';
import { registerTtsRoutes } from '../tts/routes.js';
import { createPlatformModelRuntime } from './runtime.js';
import { registerPlatformModelRoutes } from './routes.js';
import { openModelStore } from './store.js';
import { createResilientPlatformModelRuntime } from './degraded.js';
import { readPlatformExecution } from './execution.js';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../../builtin-skills/supervideo-engine/src/providers/process.mjs';
import { requestConfiguredSpeech } from '../../builtin-skills/supervideo-engine/src/providers/model-configuration.mjs';
import { platformRequestSignature } from './ipc.js';

const cleanups = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const alice = { type: 'client', token: 'device-one-private' };
const other = { type: 'client', token: 'device-two-private' };
const session = (id = 'ses_one') => ({ id, model: { providerID: 'unihub', id: 'fixture' } });
const pauseJournalWrite = (callID, predicate) => {
  const started=Promise.withResolvers(), release=Promise.withResolvers(); let paused=false; const open=fs.open.bind(fs);
  vi.spyOn(fs,'open').mockImplementation(async (...args) => {
    const handle=await open(...args);
    const filename = String(args[0]).replaceAll('\\', '/');
    if (filename.includes('/unihub-model/state.json.') && filename.endsWith('.tmp')) {
      const write=handle.writeFile.bind(handle);
      handle.writeFile=async(data,...rest)=>{
        if (!paused && z.string().safeParse(data).success && predicate(JSON.parse(data).calls[callID])) {paused=true;started.resolve();await release.promise;}
        return write(data,...rest);
      };
    }
    return handle;
  });
  cleanups.push(()=>release.resolve());
  return {started:started.promise,release:()=>release.resolve()};
};
const fixture = async (options = {}) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'platform-model-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  let promptID = 'msg_test'; let idle = null;
  let selected = 'personal'; let currentActor = 'alice'; let authSession = 'login-1'; let enabled = true; let enterprise = false; let mode = 'ok';
  let requests = 0; const grants = []; const calls = new Map(); const grantModels = new Map(); const callModels = new Map(); let release; let waitForGrant; let waitForReceipt;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET') {
      const id = req.url.split('/').pop();
      if (req.url.includes('/calls/')) await waitForReceipt?.();
      if (calls.has(id) && grantModels.get(req.headers.authorization?.slice(7)) !== callModels.get(id)) {
        res.writeHead(403, { 'content-type': 'application/json' }); res.end('{"error":"wrong_model"}'); return;
      }
      if (req.url.includes('/videos/') && calls.has(id)) {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({id, task_id: 'provider-task', status: calls.get(id) === 'SETTLED' ? 'SUCCESS' : 'QUEUED'})); return;
      }
      res.writeHead(calls.has(id) ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(calls.has(id) ? { call_id: id, status: calls.get(id) } : { error: 'not_found' })); return;
    }
    requests += 1;
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (req.url === '/platform/v1/videos') {
      const id = req.headers['idempotency-key']; calls.set(id, 'UNKNOWN'); callModels.set(id, body.model);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({task_id: 'provider-task'})); return;
    }
    if (req.url === '/platform/v1/images/generations') {
      const id = req.headers['idempotency-key']; calls.set(id, 'SETTLED'); callModels.set(id, body.model);
      res.writeHead(200, { 'content-type':'application/json' }); res.end(JSON.stringify({data:[{b64_json:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL5WQAAAABJRU5ErkJggg=='}]})); return;
    }
    if (req.url === '/platform/v1/native/dashscope/audio/transcriptions') {
      const id=req.headers['idempotency-key']; calls.set(id,'SETTLED'); callModels.set(id,body.model);
      res.writeHead(200,{'content-type':'application/json'}); res.end(JSON.stringify({choices:[{message:{content:'heard'}}],usage:{seconds:1}})); return;
    }
    if (req.url === '/platform/v1/native/bailian/audio/speech') {
      if (grantModels.get(req.headers.authorization?.slice(7)) !== body.model || !req.headers['x-unihub-task-id'] || !req.headers['idempotency-key']) {
        res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"unauthorized"}'); return;
      }
      calls.set(req.headers['idempotency-key'], 'SETTLED'); callModels.set(req.headers['idempotency-key'], body.model);
      if (body.model !== 'qwen3-tts-flash' || body.input.text !== '你好' || body.input.voice !== 'Cherry') {
        res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"invalid"}'); return;
      }
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.end(Buffer.from('media-mp3-bytes')); return;
    }
    expect(grantModels.get(req.headers.authorization?.slice(7))).toBe(body.model);
    expect(req.headers['x-unihub-task-id']).toMatch(/^uh_task_/);
    expect(body.stream).toBe(true);
    expect(body.stream_options.include_usage).toBe(true);
    expect(body.max_tokens).toBe(100);
    const id = req.headers['idempotency-key']; calls.set(id, mode === 'ok' ? 'SETTLED' : 'UNKNOWN'); callModels.set(id, body.model);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
    if (mode === 'partial') { setTimeout(() => res.destroy(), 10); return; }
    if (mode === 'held') await new Promise((resolve) => { release = resolve; });
    res.end('data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\ndata: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const env = { OPENCHAMBER_UNIHUB_GATEWAY_URL: `http://127.0.0.1:${server.address().port}/platform/v1`, OPENCHAMBER_UNIHUB_REDIRECT_URI: 'http://localhost:57991/api/platform-account/callback', OPENCHAMBER_UNIHUB_MODELS: JSON.stringify([{ id: 'fixture', name: 'Fixture', context: 8192, maxOutput: 100 }]), OPENCHAMBER_UNIHUB_MEDIA_MODELS: JSON.stringify(['qwen3-tts-flash', 'qwen3-asr-flash', 'qwen-image-2.0', 'wan2.6-t2v']) };
  const account = {
    actor: () => { if (!enabled) throw new Error('expired'); return { actingUserId: currentActor, billingAccountId: selected, authSession };  },
    request: async (_identity, target, init) => {
      const body = JSON.parse(init.body); grants.push({ target, body });
      await waitForGrant?.();
      const token = `uh_model_${grants.length}_private`; grantModels.set(token, body.models[0]);
      return { id: 'credential', token, actor_id: 'alice', account_id: target.split('/')[3], task_id: body.task_id, origin_product_id: 'superwagie', models: body.models, expires_at: new Date(Date.now() + 600000).toISOString() };
    },
  };
  const create = async () => {
    const runtime = await createPlatformModelRuntime({ dataDir: dir, instanceDir: path.join(dir, 'run'), env, getAccountRuntime: () => account, readExecution: options.readExecution ?? (async () => ({ promptID, idle, model: session().model })), isManaged: () => true, enterprise: () => enterprise, trustedBoundary: options.trustedBoundary === true });
    cleanups.push(() => runtime.close());
    await runtime.materializePlugin();
    return runtime;
  };
  let runtime = await create();
  const internal = async (route, data, extra = {}) => {
    const child = runtime.createChildEnv();
    return fetch(child.OPENCHAMBER_UNIHUB_PROXY_URL + route, { method: 'POST', headers: { authorization: `Bearer ${child.OPENCHAMBER_UNIHUB_PROXY_TOKEN}`, 'content-type': 'application/json', ...extra }, body: JSON.stringify(data) });
  };
  const prepare = (callId, sid = 'ses_one') => internal('/prepare', { sessionID: sid, callID: callId, model: 'fixture', kind: 'primary' });
  const completion = (callId, sid = 'ses_one', content = 'hi') => internal('/v1/chat/completions', { model: 'fixture', stream: true, messages: [{ role: 'user', content }] }, { 'x-unihub-session-id': sid, 'idempotency-key': callId });
  return { runtime: () => runtime, internal, prepare, completion, dir, requests: () => requests, grants, calls, callModels,
    select: (value) => { selected = value; }, selectActor: (value) => { currentActor = value; }, relogin: () => { authSession = 'login-2'; }, expire: () => { enabled = false; }, enable: () => { enabled = true; }, enterprise: () => { enterprise = true; }, partial: () => { mode = 'partial'; }, hold: () => { mode = 'held'; }, release: () => release?.(), newUnadmittedPrompt: () => { promptID = 'msg_unadmitted'; }, setPrompt: (value) => { promptID = value; }, finished: () => { idle = Date.now(); },
    restart: async () => { await runtime.close(); runtime = await create(); },
    restartProduct: async () => {
      await runtime.close();
      const { createProductPlatformModelRuntime } = await import('./runtime.js');
      runtime = await createProductPlatformModelRuntime({ dataDir: dir, instanceDir: path.join(dir, 'run'), env, getAccountRuntime: () => account, readExecution: async () => null, isManaged: () => true, enterprise: () => enterprise });
      cleanups.push(() => runtime.close());
    },
    pauseGrant: () => {
      const started = Promise.withResolvers(); const done = Promise.withResolvers();
      waitForGrant = async () => { started.resolve(); await done.promise; };
      return { started: started.promise, resume: () => { waitForGrant = null; done.resolve(); } };
    },
    pauseReceipt: () => {
      const started = Promise.withResolvers(); const done = Promise.withResolvers();
      waitForReceipt = async () => { started.resolve(); await done.promise; };
      return { started: started.promise, resume: () => { waitForReceipt = null; done.resolve(); } };
    },
  };
};

describe('UniHub model transport', () => {
  it('rejects a shell child that only inherited the legacy callback environment', async () => {
    const f = await fixture({ trustedBoundary: true });
    await f.runtime().admit(alice, session(), 'msg_test');
    const legacyEnv = { ...process.env, ...f.runtime().createChildEnv() };
    const exploit = `const base=process.env.OPENCHAMBER_UNIHUB_PROXY_URL,token=process.env.OPENCHAMBER_UNIHUB_PROXY_TOKEN;
      const result=await fetch(base+'/prepare',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({sessionID:'ses_one',callID:'legacy-shell',model:'fixture',kind:'primary'})});
      console.log(result.status);`;
    const child = await runProcess(process.execPath, ['--input-type=module', '-e', exploit], { env: legacyEnv, timeoutMs: 5000 });
    expect(child.code).toBe(0);
    expect(child.stdout.trim()).toBe('401');
    expect(f.requests()).toBe(0);
  });

  it('requires the managed OpenCode parent IPC handshake before accepting signed product calls', async () => {
    const f = await fixture({ trustedBoundary: true });
    await f.runtime().admit(alice, session(), 'msg_test');
    const directory = await f.runtime().materializePlugin();
    const source = await fs.readFile(path.join(directory, 'index.js'), 'utf8');
    const bootstrap = source.match(/const bootstrap = ([^;]+);/)?.[1] && JSON.parse(source.match(/const bootstrap = ([^;]+);/)[1]);
    const secret = crypto.randomBytes(32).toString('base64url');
    const nonce = crypto.randomBytes(18).toString('base64url');
    let ack = null;
    expect(await f.runtime().handleManagedOpenCodeMessage({ type: 'unihub-platform-handshake', bootstrap, nonce, secret }, { send: (message) => { ack = message; } })).toBe(true);
    expect(ack?.sessionID).toBeTruthy();
    const bodyObject = { sessionID: 'ses_one', callID: 'ipc-prepared', model: 'fixture', kind: 'primary' };
    const body = JSON.stringify(bodyObject);
    const requestNonce = crypto.randomBytes(18).toString('base64url');
    const signature = platformRequestSignature({ secret: Buffer.from(secret, 'base64url'), sessionNonce: nonce, requestNonce, method: 'POST', pathname: '/prepare', body });
    const child = f.runtime().createChildEnv();
    const response = await fetch(child.OPENCHAMBER_UNIHUB_PROXY_URL + '/prepare', { method: 'POST', headers: { 'content-type': 'application/json', 'x-unihub-ipc-session': ack.sessionID, 'x-unihub-ipc-nonce': requestNonce, 'x-unihub-ipc-signature': signature }, body });
    expect(response.status).toBe(200);
    expect((await response.json()).callID).toBe('ipc-prepared');
    expect(await f.runtime().handleManagedOpenCodeMessage({ type: 'unihub-platform-handshake', bootstrap, nonce, secret }, { send: () => {} })).toBe(false);
  });

  it('constructs the product runtime with model dispatch suspended and account configuration intact', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'product-model-closed-'));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const { createProductPlatformModelRuntime } = await import('./runtime.js');
    expect(createProductPlatformModelRuntime).toBeTypeOf('function');
    const runtime = await createProductPlatformModelRuntime({ dataDir: dir, instanceDir: path.join(dir, 'run'), env: {}, usePublicDefaults: true, getAccountRuntime: () => null, readExecution: async () => null, isManaged: () => true, enterprise: () => false });
    cleanups.push(() => runtime.close());
    expect(runtime.enabled()).toBe(false); expect(runtime.historyAvailable()).toBe(true); expect(runtime.providerConfig()).toEqual({}); expect(runtime.createChildEnv()).toEqual({});
    await expect(runtime.admit(alice, session(), 'msg_test')).rejects.toMatchObject({ code: 'platform_dispatch_suspended' });
    await expect(runtime.materializePlugin()).rejects.toMatchObject({ code: 'platform_dispatch_suspended' });
  });
  it('does not advertise history when the gateway is unconfigured or the runtime is not managed', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'product-model-history-'));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const { createProductPlatformModelRuntime } = await import('./runtime.js');
    for (const [env, usePublicDefaults, managed] of [[{}, false, true], [{}, true, false]]) {
      const runtime = await createProductPlatformModelRuntime({ dataDir: dir, instanceDir: path.join(dir, 'run'), env, usePublicDefaults, getAccountRuntime: () => null, readExecution: async () => null, isManaged: () => managed, enterprise: () => false });
      expect(runtime.historyAvailable()).toBe(false);
      await runtime.close();
    }
  });
  it('recovers a historical prepared call with its owner after product restart without dispatching it', async () => {
    const f = await fixture(); await f.runtime().admit(alice, session(), 'msg_test');
    expect((await f.prepare('historical')).status).toBe(200);
    await f.runtime().close();
    const { createProductPlatformModelRuntime } = await import('./runtime.js');
    const runtime = await createProductPlatformModelRuntime({
      dataDir: f.dir, instanceDir: path.join(f.dir, 'product'), env: {}, usePublicDefaults: true,
      getAccountRuntime: () => ({ actor: () => ({ actingUserId: 'alice', billingAccountId: 'personal', authSession: 'login-1' }) }),
      readExecution: async () => null, isManaged: () => true, enterprise: () => false,
    });
    cleanups.push(() => runtime.close());
    expect(runtime.status(alice, 'ses_one').calls).toContainEqual({ callID: 'historical', status: 'PREPARED' });
    expect((await runtime.reconcile(alice, 'ses_one')).calls).toContainEqual({ callID: 'historical', status: 'REJECTED' });
    expect(() => runtime.status(other, 'ses_one')).toThrow();
    await expect(runtime.admit(alice, session(), 'msg_test')).rejects.toMatchObject({ code: 'platform_dispatch_suspended' });
    expect(f.requests()).toBe(0);
  });
  it('refreshes the original async receipt while dispatch is suspended without resubmitting the media task', async () => {
    const f = await fixture();
    await f.runtime().admit(alice, session(), 'msg_test');
    const submitted = await f.internal('/media/video', { sessionID: 'ses_one', callID: 'pending-video', model: 'wan2.6-t2v', prompt: 'cat', seconds: 5, size: '1280*720' });
    expect(submitted.status).toBe(200);
    await f.restartProduct();
    expect(f.runtime().historyAvailable()).toBe(true);
    expect(f.runtime().enabled()).toBe(false);
    expect((await f.runtime().reconcile(alice, 'ses_one')).calls).toContainEqual({ callID: 'pending-video', status: 'DELIVERED' });
    f.calls.set('pending-video', 'SETTLED');
    expect((await f.runtime().reconcile(alice, 'ses_one')).calls).toContainEqual({ callID: 'pending-video', status: 'SETTLED' });
    expect(f.requests()).toBe(1);
    expect(() => f.runtime().status(other, 'ses_one')).toThrow('platform_model_scope_restart_required');
  });
  it('retains the async state when receipt read fails and exposes recovery availability separately', async () => {
    const f = await fixture();
    await f.runtime().admit(alice, session(), 'msg_test');
    expect((await f.internal('/media/video', { sessionID: 'ses_one', callID: 'missing-video', model: 'wan2.6-t2v', prompt: 'cat', seconds: 5, size: '1280*720' })).status).toBe(200);
    await f.runtime().suspendNewCalls();
    f.calls.delete('missing-video');
    await expect(f.runtime().reconcile(alice, 'ses_one')).rejects.toMatchObject({ code: 'platform_reconciliation_required' });
    expect(f.runtime().status(alice, 'ses_one').calls).toContainEqual({ callID: 'missing-video', status: 'DELIVERED' });
    expect(f.requests()).toBe(1);
    f.enterprise();
    expect(f.runtime().historyAvailable()).toBe(false);
    await f.runtime().close();
    expect(f.runtime().historyAvailable()).toBe(false);
  });
  it('does not reveal or record a media receipt if the payer changes while it is read', async () => {
    const f = await fixture();
    await f.runtime().admit(alice, session(), 'msg_test');
    expect((await f.internal('/media/video', { sessionID: 'ses_one', callID: 'raced-video', model: 'wan2.6-t2v', prompt: 'cat', seconds: 5, size: '1280*720' })).status).toBe(200);
    await f.restartProduct();
    f.calls.set('raced-video', 'SETTLED');
    const held = f.pauseReceipt();
    const pending = f.runtime().reconcile(alice, 'ses_one');
    await held.started;
    f.select('other-account');
    held.resume();
    await expect(pending).rejects.toMatchObject({ code: 'platform_model_scope_restart_required' });
    const state = JSON.parse(await fs.readFile(path.join(f.dir, 'unihub-model', 'state.json'), 'utf8'));
    expect(state.calls['raced-video'].status).toBe('ASYNC_PENDING');
    expect(f.requests()).toBe(1);
  });
  it('does not abandon a prepared call when the payer changes while reconciliation waits for the journal', async () => {
    const f = await fixture();
    await f.runtime().admit(alice, session(), 'msg_test');
    expect((await f.prepare('prepared-race')).status).toBe(200);
    await f.runtime().admit(alice, session('ses_two'), 'msg_test');
    const held = pauseJournalWrite('other-pending', (call) => call?.status === 'PREPARED');
    const writer = f.prepare('other-pending', 'ses_two');
    await held.started;
    const pending = f.runtime().reconcile(alice, 'ses_one');
    const rejected = expect(pending).rejects.toMatchObject({ code: 'platform_model_scope_restart_required' });
    f.select('other-account');
    held.release();
    await writer;
    await rejected;
    const state = JSON.parse(await fs.readFile(path.join(f.dir, 'unihub-model', 'state.json'), 'utf8'));
    expect(state.calls['prepared-race'].status).toBe('PREPARED');
    expect(f.requests()).toBe(0);
  });
  it('prevents new task admission when safety suspension occurs while credentials are pending', async () => {
    const f = await fixture(); const held = f.pauseGrant();
    const pending = f.runtime().admit(alice, session(), 'msg_test');
    await held.started; const suspension = f.runtime().suspendNewCalls(); held.resume();
    await suspension;
    await expect(pending).rejects.toMatchObject({ code: 'platform_dispatch_suspended' });
    expect(f.requests()).toBe(0);
    expect(() => f.runtime().status(alice, 'ses_one')).toThrow('platform_task_unbound');
  });
  it('refuses a managed prompt without falling back and still forwards an explicitly selected BYOK provider', async () => {
    const f = await fixture(); await f.runtime().suspendNewCalls();
    const app = express(); app.use(express.json());
    let provider = 'unihub'; const forwarded = [];
    registerPlatformModelRoutes(app, { runtime: f.runtime(), resolveIdentity: () => alice,
      readSession: async (id) => ({ id, model: { providerID: provider, id: 'fixture' } }), isRequestOriginAllowed: () => true });
    app.post('/api/session/:sessionID/prompt', (_req, res) => { forwarded.push(provider); res.json({ provider }); });
    const denied = await request(app).post('/api/session/ses_one/prompt').send({ text: 'private prompt' });
    expect(denied.status).toBe(503); expect(denied.body.error).toBe('platform_dispatch_suspended'); expect(forwarded).toEqual([]);
    provider = 'byok'; const allowed = await request(app).post('/api/session/ses_one/prompt').send({ text: 'local prompt' });
    expect(allowed.status).toBe(200); expect(allowed.body.provider).toBe('byok'); expect(forwarded).toEqual(['byok']);
    expect(f.requests()).toBe(0);
  });
  it('revokes an inherited child capability and keeps historical reconciliation after the product safety gate closes', async () => {
    const f = await fixture(); await f.runtime().admit(alice, session(), 'msg_test');
    const childEnv = { ...process.env, ...f.runtime().createChildEnv() };
    const exploit = `const base=process.env.OPENCHAMBER_UNIHUB_PROXY_URL,token=process.env.OPENCHAMBER_UNIHUB_PROXY_TOKEN;
      const prepared=await fetch(base+'/prepare',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({sessionID:'ses_one',callID:'forged',model:'fixture',kind:'primary'})});
      const result=await fetch(base+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','x-unihub-session-id':'ses_one','idempotency-key':'forged'},body:JSON.stringify({model:'fixture',stream:true,messages:[{role:'user',content:'forged content'}]})});
      await result.text(); console.log(prepared.status+' '+result.status);`;
    const before = await runProcess(process.execPath, ['--input-type=module', '-e', exploit], { env: childEnv, timeoutMs: 5000 });
    expect(before.code).toBe(0); expect(before.stdout.trim()).toBe('200 200'); expect(f.requests()).toBe(1);
    expect((await f.prepare('legacy-prepared')).status).toBe(200);
    const attempt = `const base=process.env.OPENCHAMBER_UNIHUB_PROXY_URL,token=process.env.OPENCHAMBER_UNIHUB_PROXY_TOKEN;
      try { const res=await fetch(base+'/prepare',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({sessionID:'ses_one',callID:'spoofed',model:'fixture',kind:'primary'})}); console.log(res.status); }
      catch { console.log('closed'); }`;
    await f.runtime().suspendNewCalls();
    const spoof = await runProcess(process.execPath, ['--input-type=module', '-e', attempt], { env: childEnv, timeoutMs: 5000 });
    expect(spoof.code).toBe(0); expect(spoof.stdout.trim()).toBe('closed');
    expect(f.runtime().createChildEnv()).toEqual({});
    expect(f.runtime().enabled()).toBe(false); expect(f.runtime().providerConfig()).toEqual({});
    await expect(f.runtime().admit(alice, session(), 'msg_test')).rejects.toMatchObject({ code: 'platform_dispatch_suspended' });
    expect(() => f.runtime().mediaDispatch({ identity: alice, sessionID: 'ses_one', callID: 'spoof', model: 'wan2.6-t2v', operation: 'video', inputs: {} })).toThrow('platform_dispatch_suspended');
    expect(f.runtime().status(alice, 'ses_one').calls).toContainEqual({ callID: 'legacy-prepared', status: 'PREPARED' });
    expect((await f.runtime().reconcile(alice, 'ses_one')).calls).toContainEqual({ callID: 'legacy-prepared', status: 'REJECTED' });
    expect(f.requests()).toBe(1);
  });
  it.each([
    { route: '/media/speech', operation: 'speech', model: 'qwen3-tts-flash', input: { text: '你好', voice: 'Cherry' } },
    { route: '/media/image', operation: 'image_generation', model: 'qwen-image-2.0', input: { prompt: 'test image' } },
  ])('refuses $operation before admission or gateway dispatch while recovery is unavailable', async ({ route, operation, model, input }) => {
    const f = await fixture();
    await f.runtime().admit(alice, session(), 'msg_test');
    const initialGrants = f.grants.length;
    const result = await f.internal(route, { model, ...input });
    expect(result.status).toBe(503);
    expect((await result.json()).error.code).toBe('platform_media_recovery_unavailable');
    expect(() => f.runtime().mediaDispatch({ identity: alice, sessionID: 'ses_one', callID: 'disabled-media', model, operation, inputs: input })).toThrow('platform_media_recovery_unavailable');
    expect(f.runtime().isMediaOperationConfigured(model, operation)).toBe(false);
    expect(f.grants.length).toBe(initialGrants);
    expect(f.requests()).toBe(0);
    const state = JSON.parse(await fs.readFile(path.join(f.dir, 'unihub-model', 'state.json'), 'utf8'));
    expect(state.calls['disabled-media']).toBeUndefined();
  });
  it('refuses transcription in the central runtime before credentials or dispatch', async () => {
    const f = await fixture(); await f.runtime().admit(alice, session(), 'msg_test');
    const grants = f.grants.length;
    expect(() => f.runtime().mediaDispatch({ identity: alice, sessionID: 'ses_one', callID: 'disabled-transcription', model: 'qwen3-asr-flash', operation: 'transcription', inputs: {} })).toThrow('platform_media_recovery_unavailable');
    expect(f.runtime().isMediaOperationConfigured('qwen3-asr-flash', 'transcription')).toBe(false);
    expect(f.grants.length).toBe(grants); expect(f.requests()).toBe(0);
  });
  it('authorizes a long active prompt across pages and refuses an unreadable continuation', async () => {
    let broken=false;
    const client={session:{get:async()=>session()},message:{list:async({cursor})=>{
      if (cursor && broken) throw new Error('offline');
      return cursor ? {data:[{type:'user',id:'msg_test'}]} : {data:Array.from({length:100},(_,i)=>({type:'assistant',id:`a${i}`})),cursor:{next:'older'}};
    }}};
    const f=await fixture({readExecution:(id)=>readPlatformExecution(client,id)}); await f.runtime().admit(alice,session(),'msg_test');
    expect((await f.internal('/media/session',{})).status).toBe(200);
    broken=true; expect((await f.internal('/media/session',{})).status).toBe(409); expect(f.requests()).toBe(0);
  });

  it('rejects a stale prepare after a newer prompt is admitted during its execution read', async () => {
    const entered=Promise.withResolvers(), release=Promise.withResolvers(); let wait=false;
    const f=await fixture({readExecution:async()=>{if(wait){entered.resolve();await release.promise;}return {promptID:'msg_test',idle:null,model:session().model};}});
    await f.runtime().admit(alice,session(),'msg_test'); wait=true;
    const pending=f.prepare('old-prepare'); await entered.promise;
    await f.runtime().admit(alice,session(),'msg_new'); release.resolve();
    const response=await pending; expect(response.status).toBe(403);
    const state=JSON.parse(await fs.readFile(path.join(f.dir,'unihub-model','state.json'),'utf8')); expect(state.calls['old-prepare']).toBeUndefined(); expect(f.requests()).toBe(0);
  });

  it('rejects a prepared call when its prompt becomes idle during the journal write', async () => {
    const f=await fixture(); await f.runtime().admit(alice,session(),'msg_test');
    const held=pauseJournalWrite('old-idle',call=>call?.status==='PREPARED'); const pending=f.prepare('old-idle');
    await held.started; f.finished(); held.release();
    expect((await pending).status).toBe(403); expect(f.requests()).toBe(0);
    const state=JSON.parse(await fs.readFile(path.join(f.dir,'unihub-model','state.json'),'utf8')); expect(state.calls['old-idle'].status).toBe('REJECTED');
  });

  it('cannot dispatch an old prepared call after the prompt permit is replaced', async () => {
    const f=await fixture(); await f.runtime().admit(alice,session(),'msg_test');
    expect((await f.prepare('old-call')).status).toBe(200);
    await f.runtime().admit(alice,session(),'msg_new');
    expect((await f.completion('old-call')).status).toBe(403); expect(f.requests()).toBe(0);
  });

  it('does not deliver further chat output after the prompt permit is replaced', async () => {
    const f=await fixture(); f.hold(); await f.runtime().admit(alice,session(),'msg_test');
    expect((await f.prepare('old-stream')).status).toBe(200);
    const response=await f.completion('old-stream'); const reader=response.body.getReader();
    const first=await reader.read(); expect(new TextDecoder().decode(first.value)).toContain('hello');
    f.calls.set('old-stream','SETTLED');
    await f.runtime().admit(alice,session(),'msg_new'); f.release();
    const later=await reader.read().catch(()=>null); expect(later?.value ? new TextDecoder().decode(later.value) : '').not.toContain('[DONE]');
  });

  it.each(['SETTLED','UNKNOWN'])('terminates a stalled old stream when a different prompt is admitted (%s receipt)', async status => {
    const f=await fixture(); f.hold(); await f.runtime().admit(alice,session(),'msg_test');
    expect((await f.prepare('stalled-call')).status).toBe(200);
    const response=await f.completion('stalled-call'); const reader=response.body.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('hello');
    f.calls.set('stalled-call',status);
    if(status==='SETTLED') {
      await f.runtime().admit(alice,session(),'msg_new'); f.setPrompt('msg_new');
      expect((await f.prepare('next-call')).status).toBe(200);
    } else {
      await expect(f.runtime().admit(alice,session(),'msg_new')).rejects.toMatchObject({code:'platform_reconciliation_required'});
    }
    const ended=await Promise.race([reader.read().then(v=>v.done,()=>true),new Promise(resolve=>setTimeout(()=>resolve(false),1000))]);
    expect(ended).toBe(true); expect(f.requests()).toBe(1);
    const state=JSON.parse(await fs.readFile(path.join(f.dir,'unihub-model','state.json'),'utf8'));
    expect(state.calls['stalled-call'].status).toBe(status);
    f.release();
  });

  it('reconciles an old-format PREPARED call without permit ID after restart without dispatch', async () => {
    const f=await fixture(); await f.runtime().admit(alice,session(),'msg_test'); await f.runtime().close();
    const file=path.join(f.dir,'unihub-model','state.json'); const state=JSON.parse(await fs.readFile(file,'utf8'));
    state.calls.legacy={id:'legacy',sessionID:'ses_one',taskID:state.tasks.ses_one.id,model:'fixture',digest:'',status:'PREPARED',output:false};
    await fs.writeFile(file,JSON.stringify(state)); await f.restart();
    await f.runtime().admit(alice,session(),'msg_test');
    expect((await f.completion('legacy')).status).toBe(403); expect(f.requests()).toBe(0);
    expect(JSON.parse(await fs.readFile(file,'utf8')).calls.legacy.status).toBe('REJECTED');
  });

  it('does not dispatch media if the payer changes while the dispatch journal is being written', async () => {
    const f=await fixture(); await f.runtime().admit(alice,session(),'msg_test');
    const held=pauseJournalWrite('media_race',call=>call?.status==='DISPATCHED'); let sends=0;
    const result=f.runtime().mediaCall({identity:alice,sessionID:'ses_one',callID:'media_race',model:'wan2.6-t2v',operation:'video',inputs:{text:'hello'},dispatch:async()=>{sends++;return {buffer:Buffer.from('ok'),contentType:'audio/mpeg'};}}).then(()=>null,error=>error);
    await held.started; f.select('team-other'); held.release();
    expect(await result).toMatchObject({code:'platform_model_scope_restart_required'}); expect(sends).toBe(0);
    const state=JSON.parse(await fs.readFile(path.join(f.dir,'unihub-model','state.json'),'utf8')); expect(state.calls.media_race.status).toBe('REJECTED');
  });

  it('does not dispatch chat if the payer changes while the dispatch journal is being written', async () => {
    const f=await fixture(); await f.runtime().admit(alice,session(),'msg_test'); expect((await f.prepare('chat_race')).status).toBe(200);
    const held=pauseJournalWrite('chat_race',call=>call?.status==='DISPATCHED'); const result=f.completion('chat_race');
    await held.started; f.select('team-other'); held.release(); expect((await result).status).toBe(403); expect(f.requests()).toBe(0);
    const state=JSON.parse(await fs.readFile(path.join(f.dir,'unihub-model','state.json'),'utf8')); expect(state.calls.chat_race.status).toBe('REJECTED');
  });

  it('does not output an SSE chunk when payer changes during output journaling', async () => {
    const f=await fixture(); f.hold(); await f.runtime().admit(alice,session(),'msg_test'); expect((await f.prepare('stream_race')).status).toBe(200);
    const held=pauseJournalWrite('stream_race',call=>call?.output===true); const response=f.completion('stream_race');
    await held.started; f.select('team-other'); held.release();
    const value=await response.catch(()=>null); const part=value ? await value.body.getReader().read().catch(()=>null) : null; f.release(); expect(part ? new TextDecoder().decode(part.value) : '').not.toContain('hello');
    const state=JSON.parse(await fs.readFile(path.join(f.dir,'unihub-model','state.json'),'utf8')); expect(state.calls.stream_race.status).toBe('UNKNOWN'); expect(f.requests()).toBe(1);
  });
  it('prevents a second authenticated owner from using or reading paid tasks through the shared child token', async () => {
    const f = await fixture(); await f.runtime().admit(alice, session(), 'msg_test');
    const first = f.runtime().status(alice, 'ses_one');
    await expect(f.runtime().admit(other, session('ses_other'), 'msg_test')).rejects.toMatchObject({ code: 'platform_model_scope_restart_required' });
    await expect(f.runtime().admitMediaTask(other, {model: {providerID:'unihub',id:'qwen3-tts-flash'}})).rejects.toMatchObject({ code: 'platform_model_scope_restart_required' });
    const submit = await f.internal('/media/video', { sessionID:'ses_other',callID:'victim_attempt',model:'wan2.6-t2v',prompt:'example',seconds:5,size:'1280*720' });
    const result = await f.internal('/media/video/result', { sessionID:'ses_other',callID:'victim_attempt' });
    expect(submit.status).toBe(403); expect(result.status).toBe(401); expect(f.requests()).toBe(0);
    expect(f.runtime().status(alice, 'ses_one')).toEqual(first);
  });
  it('rejects payer or actor changes, including reuse of existing tasks, until process restart', async () => {
    const f = await fixture(); await f.runtime().admit(alice, session(), 'msg_test');
    const media=await f.runtime().admitMediaTask(alice,{model:{providerID:'unihub',id:'qwen3-tts-flash'}});
    f.select('other-account');
    await expect(f.runtime().admit(alice, session(), 'msg_test')).rejects.toMatchObject({code:'platform_model_scope_restart_required'});
    await expect(f.runtime().admit(alice, session('ses_new'), 'msg_test')).rejects.toMatchObject({code:'platform_model_scope_restart_required'});
    await expect(f.runtime().admitMediaTask(alice,{model:{providerID:'unihub',id:'qwen3-tts-flash'}})).rejects.toMatchObject({code:'platform_model_scope_restart_required'});
    expect((await f.internal('/media/session',{sessionID:media.sessionID})).status).toBe(403);
    f.select('personal'); f.selectActor('bob');
    await expect(f.runtime().admit(alice, session('ses_bob'), 'msg_test')).rejects.toMatchObject({code:'platform_model_scope_restart_required'});
    expect(f.requests()).toBe(0);
  });
  it('rejects the old child token after logout and a fresh login to the same actor and payer', async () => {
    const f=await fixture(); await f.runtime().admit(alice,session(),'msg_test');
    f.expire(); expect((await f.prepare('signed-out')).status).toBe(401);
    f.enable(); f.relogin();
    expect((await f.prepare('new-login')).status).toBe(403);
    await expect(f.runtime().admit(alice,session('ses_new'),'msg_test')).rejects.toMatchObject({code:'platform_model_scope_restart_required'});
    expect(f.requests()).toBe(0);
  });
  it('withholds a completed media response if payer changes while it is in flight', async () => {
    const f=await fixture(); await f.runtime().admit(alice,session(),'msg_test');
    const started=Promise.withResolvers(), release=Promise.withResolvers();
    const pending=f.runtime().mediaCall({identity:alice,sessionID:'ses_one',callID:'media_inflight',model:'wan2.6-t2v',operation:'video',inputs:{text:'private'},dispatch:async()=>{started.resolve();await release.promise;return {buffer:Buffer.from('secret'),contentType:'audio/mpeg'};}});
    await started.promise; f.select('team-other'); release.resolve();
    await expect(pending).rejects.toMatchObject({code:'platform_model_scope_restart_required'});
    const state=JSON.parse(await fs.readFile(path.join(f.dir,'unihub-model','state.json'),'utf8'));
    expect(state.calls.media_inflight.status).toBe('DELIVERED');
  });
  it('locks out all owners if the original payer was switched away and back', async () => {
    const f=await fixture();await f.runtime().admit(alice,session(),'msg_test');
    f.select('team-other');expect((await f.prepare('wrong-payer')).status).toBe(403);
    f.select('personal'); expect((await f.prepare('original-payer')).status).toBe(403);
    expect(f.requests()).toBe(0);
  });
  it('rotates the child token across restart and refuses an old owner after a new owner is admitted', async () => {
    const f=await fixture(); await f.runtime().admit(alice,session(),'msg_test'); const old=f.runtime().createChildEnv();
    await f.restart(); await f.runtime().admit(other,session('ses_other'),'msg_test'); const fresh=f.runtime().createChildEnv();
    expect(fresh.OPENCHAMBER_UNIHUB_PROXY_TOKEN).not.toBe(old.OPENCHAMBER_UNIHUB_PROXY_TOKEN);
    const attempted=await fetch(fresh.OPENCHAMBER_UNIHUB_PROXY_URL+'/media/session',{method:'POST',headers:{authorization:'Bearer '+old.OPENCHAMBER_UNIHUB_PROXY_TOKEN,'content-type':'application/json'},body:'{}'});
    expect(attempted.status).toBe(401);
    expect(() => f.runtime().status(alice,'ses_one')).toThrow(/platform_model_scope_restart_required/);
  });

  it('auto-resolves a single admitted media session when the broker omits sessionID', async () => {
    const f = await fixture(); await f.runtime().admit(alice, session(), 'msg_test');
    await f.runtime().admitMediaTask(alice, { model: { providerID: 'unihub', id: 'qwen3-tts-flash' } });
    const response = await f.internal('/media/session', {});
    expect(response.status).toBe(200); expect(await response.json()).toEqual({sessionID:'ses_one'});
  });

  it('refuses ambiguous or missing media sessions with distinct codes', async () => {
    const f = await fixture(); await f.runtime().admit(alice, session(), 'msg_test');
    f.finished(); const missing = await f.internal('/media/session', {});
    expect(missing.status).toBe(409); expect((await missing.json()).error.code).toBe('platform_media_session_missing');
    await f.runtime().admitMediaTask(alice, { model: { providerID: 'unihub', id: 'qwen3-tts-flash' } });
    await expect(f.runtime().admitMediaTask(other, { model: { providerID: 'unihub', id: 'qwen3-tts-flash' } })).rejects.toMatchObject({code:'platform_model_scope_restart_required'});
  });

  it('uses the unique active agent permit for skill media and refuses expired or ambiguous permits', async () => {
    const f = await fixture(); await f.runtime().admit(alice, session(), 'msg_test');
    expect((await f.internal('/media/session', {})).status).toBe(200);
    await f.runtime().admit(alice, session('ses_two'), 'msg_test');
    const ambiguous = await f.internal('/media/session', {}); expect(ambiguous.status).toBe(409); expect((await ambiguous.json()).error.code).toBe('platform_media_session_ambiguous');
    f.finished(); expect((await f.internal('/media/session', {})).status).toBe(409); expect(f.requests()).toBe(0);
  });

  it('refuses shared child access to dedicated tasks after the agent permit expires', async () => {
    const f=await fixture(); const dedicated=await f.runtime().admitMediaTask(alice,{model:{providerID:'unihub',id:'wan2.6-t2v'}});
    await f.runtime().admit(alice,session(),'msg_test'); f.finished();
    expect((await f.internal('/media/session',{})).status).toBe(409);
    expect((await f.internal('/media/session',{sessionID:dedicated.sessionID})).status).toBe(403);
    const result=await f.runtime().mediaDispatch({identity:alice,sessionID:dedicated.sessionID,callID:'authorized-ui',model:'wan2.6-t2v',operation:'video',inputs:{prompt:'cat',seconds:5,size:'1280*720'}});
    expect(result.taskId).toBe('provider-task'); expect(f.requests()).toBe(1);
  });

  it('refuses configured UI TTS and STT before creating a task', async () => {
    const f=await fixture(); await f.runtime().admit(alice,session(),'msg_test'); f.finished();
    const app=express(); app.use(express.json());
    registerTtsRoutes(app,{resolvePlatformIdentity:async()=>alice,getPlatformModelRuntime:()=>f.runtime(),resolveModelBinding:async purpose=>purpose==='tts' ? {protocol:'managed-media',model:'qwen3-tts-flash',parameters:{voice:'Cherry'}} : purpose==='stt-short' ? {protocol:'managed-media',model:'qwen3-asr-flash',parameters:{}} : null});
    const spoken=await request(app).post('/api/tts/speak').send({text:'你好'}); expect(spoken.status).toBe(503); expect(spoken.body.code).toBe('platform_media_recovery_unavailable');
    const heard=await request(app).post('/api/stt/transcribe').set('content-type','audio/webm').send(Buffer.from('audio')); expect(heard.status).toBe(503); expect(heard.body.code).toBe('platform_media_recovery_unavailable');
    expect(f.requests()).toBe(0);
  });

  it('does not dispatch when a skill permit expires while a model grant is pending', async () => {
    const f=await fixture(); await f.runtime().admit(alice,session(),'msg_test');
    const held=f.pauseGrant(); const pending=f.internal('/media/video',{callID:'video-pending',model:'wan2.6-t2v',prompt:'cat',seconds:5,size:'1280*720'});
    await held.started; f.finished(); held.resume();
    const response=await pending; expect(response.status).toBe(409); expect(f.requests()).toBe(0);
    const state=JSON.parse(await fs.readFile(path.join(f.dir,'unihub-model','state.json'),'utf8'));
    expect(Object.values(state.calls).every(call=>call.status==='REJECTED')).toBe(true);
  });

  it('refuses actual managed image and narration skill processes before provider dispatch', async () => {
    const f = await fixture(); await f.runtime().admit(alice, session(), 'msg_test');
    await fs.writeFile(path.join(f.dir, 'model-configuration.json'), JSON.stringify({version:1,revision:1,connections:[{id:'managed',name:'UniHub',providerId:'unihub',protocol:'managed-media',baseUrl:'https://llmrouter.example.test/platform/v1'}],bindings:[
      {purpose:'image-generation',connectionId:'managed',model:'qwen-image-2.0',parameters:{},verification:{status:'untested'}},
      {purpose:'tts',connectionId:'managed',model:'qwen3-tts-flash',parameters:{voice:'Cherry'},verification:{status:'untested'}},
    ]}));
    const resolver=fileURLToPath(new URL('../model-configuration/resolve-cli.js',import.meta.url));
    const skillDir=fileURLToPath(new URL('../../builtin-skills/skills/ai-image-to-ppt/scripts/',import.meta.url));
    const childEnv={...process.env,...f.runtime().createChildEnv(),OPENCHAMBER_DATA_DIR:f.dir,SUPERWAGIE_MODEL_RESOLVER:resolver,SUPERWAGIE_MODEL_NODE:process.execPath};
    const image = await runProcess('python3',['-c',"import sys; sys.path.insert(0,sys.argv[1]); from provider_credentials import generate_managed_image; generate_managed_image('slide','qwen-image-2.0')",skillDir],{env:childEnv,timeoutMs:30000});
    expect(image.code).not.toBe(0);
    expect(image.stderr).toContain('temporarily unavailable');
    vi.stubEnv('SUPERWAGIE_MODEL_RESOLVER',resolver);
    const voice={model:'qwen3-tts-flash',voice:'Cherry',provider:'managed-media'};
    await expect(requestConfiguredSpeech('你好',voice,{resolveBinding:async()=>({protocol:'managed-media',model:voice.model,parameters:{voice:'Cherry'}}),runResolver:(file,args,options)=>runProcess(file,args,{...options,env:childEnv})})).rejects.toThrow('temporarily unavailable');
    expect(f.requests()).toBe(0);
    const state=JSON.parse(await fs.readFile(path.join(f.dir,'unihub-model','state.json'),'utf8'));
    expect(Object.values(state.calls).filter(call => call.sessionID==='ses_one')).toEqual([]);
  });

  it('journals, dispatches and settles a media call', async () => {
    const f = await fixture(); await f.runtime().admit(alice, session(), 'msg_test');
    const dispatched = [];
    const result = await f.runtime().mediaCall({
      identity: alice, sessionID: 'ses_one', callID: 'media_call_1', model: 'wan2.6-t2v', operation: 'video',
      inputs: { text: '你好', voice: 'Cherry' },
      dispatch: async (ctx) => { dispatched.push(ctx); return { buffer: Buffer.from('mp3'), contentType: 'audio/mpeg' }; },
    });
    expect(result.buffer.toString()).toBe('mp3');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].grant.models).toEqual(['wan2.6-t2v']);
    expect(dispatched[0].idempotencyKey).toBe('media_call_1');
    const state = JSON.parse(await fs.readFile(path.join(f.dir, 'unihub-model', 'state.json'), 'utf8'));
    expect(state.calls.media_call_1.status).toBe('DELIVERED');
    expect(state.calls.media_call_1.operation).toBe('video');
  });

  it('keeps an unresolved media call blocking after transport failure', async () => {
    const f = await fixture(); await f.runtime().admit(alice, session(), 'msg_test');
    await expect(f.runtime().mediaCall({
      identity: alice, sessionID: 'ses_one', callID: 'media_call_2', model: 'wan2.6-t2v', operation: 'video',
      inputs: { text: '你好', voice: 'Cherry' },
      dispatch: async () => { const e = new Error('transport died'); e.code = 'native_media_unresolved'; throw e; },
    })).rejects.toThrow('transport died');
    const state = JSON.parse(await fs.readFile(path.join(f.dir, 'unihub-model', 'state.json'), 'utf8'));
    expect(state.calls.media_call_2.status).toBe('DISPATCHED');
    await expect(f.runtime().mediaCall({
      identity: alice, sessionID: 'ses_one', callID: 'media_call_3', model: 'wan2.6-t2v', operation: 'video',
      inputs: { text: '你好', voice: 'Cherry' }, dispatch: async () => ({}),
    })).rejects.toMatchObject({ code: 'platform_reconciliation_required' });
  });

  it('continues the agent after a confirmed async submission, including after restart, while retaining the original call', async () => {
    const f = await fixture(); await f.runtime().admit(alice, session(), 'msg_test');
    const submitted = await f.internal('/media/video', {sessionID:'ses_one',callID:'video-accepted',model:'wan2.6-t2v',prompt:'cat',seconds:5,size:'1280*720'});
    expect(submitted.status).toBe(200);
    expect(await submitted.json()).toMatchObject({callID:'video-accepted'});
    expect((await f.prepare('after-video')).status).toBe(200);
    const completion = await f.completion('after-video'); expect(completion.status).toBe(200); await completion.text();
    const pending = await f.internal('/media/video/status', {sessionID:'ses_one',callID:'video-accepted'});
    expect(await pending.json()).toMatchObject({status:'QUEUED'});
    await f.restart();
    await expect(f.runtime().admit(alice, session(), 'msg_test')).resolves.toBe(true);
    expect((await f.prepare('after-restart')).status).toBe(200);
    expect(f.runtime().status(alice, 'ses_one').calls).toContainEqual({ callID: 'video-accepted', status: 'DELIVERED' });
  });

  it('keeps a video with unknown submission outcome blocking agent calls after restart', async () => {
    const f = await fixture(); await f.runtime().admit(alice, session(), 'msg_test');
    await expect(f.runtime().mediaCall({ identity: alice, sessionID: 'ses_one', callID: 'video-unknown', model: 'wan2.6-t2v', operation: 'video', inputs: {prompt:'cat'}, dispatch: async () => { throw new Error('connection lost'); } })).rejects.toThrow('connection lost');
    f.calls.set('video-unknown', 'UNKNOWN'); f.callModels.set('video-unknown', 'wan2.6-t2v');
    expect((await f.prepare('blocked-before-restart')).status).toBe(409);
    await f.restart();
    await expect(f.runtime().admit(alice, session(), 'msg_test')).rejects.toMatchObject({code:'platform_reconciliation_required'});
    expect(f.runtime().status(alice, 'ses_one').blocked).toBe(true);
  });

  it('removes a prepared media entry when dispatch refuses locally', async () => {
    const f = await fixture(); await f.runtime().admit(alice, session(), 'msg_test');
    const localError = Object.assign(new Error('bad input'), { local: true });
    await expect(f.runtime().mediaCall({
      identity: alice, sessionID: 'ses_one', callID: 'media_call_4', model: 'wan2.6-t2v', operation: 'video',
      inputs: { text: '你好', voice: 'Cherry' }, dispatch: async () => { throw localError; },
    })).rejects.toThrow('bad input');
    let state = JSON.parse(await fs.readFile(path.join(f.dir, 'unihub-model', 'state.json'), 'utf8'));
    expect(state.calls.media_call_4).toBeUndefined();
    const ok = await f.runtime().mediaCall({
      identity: alice, sessionID: 'ses_one', callID: 'media_call_4', model: 'wan2.6-t2v', operation: 'video',
      inputs: { text: '你好', voice: 'Cherry' }, dispatch: async () => ({ buffer: Buffer.from('ok'), contentType: 'audio/mpeg' }),
    });
    expect(ok.buffer.toString()).toBe('ok');
    state = JSON.parse(await fs.readFile(path.join(f.dir, 'unihub-model', 'state.json'), 'utf8'));
    expect(state.calls.media_call_4.status).toBe('DELIVERED');
  });

  it('reuses one durable media task per owner+model', async () => {
    const f = await fixture();
    const first = await f.runtime().admitMediaTask(alice, { model: { providerID: 'unihub', id: 'qwen3-tts-flash' } });
    const again = await f.runtime().admitMediaTask(alice, { model: { providerID: 'unihub', id: 'qwen3-tts-flash' } });
    expect(again.sessionID).toBe(first.sessionID);
    expect(again.taskID).toBe(first.taskID);
    const otherModel = await f.runtime().admitMediaTask(alice, { model: { providerID: 'unihub', id: 'qwen-image-2.0' } });
    expect(otherModel.sessionID).not.toBe(first.sessionID);
  });

  it('mediaDispatch journeys video through the transport with a task grant', async () => {
    const f = await fixture(); await f.runtime().admit(alice, session(), 'msg_test');
    const result = await f.runtime().mediaDispatch({identity:alice,sessionID:'ses_one',callID:'media_dispatch_1',model:'wan2.6-t2v',operation:'video',inputs:{prompt:'cat',seconds:5,size:'1280*720'}});
    expect(result.taskId).toBe('provider-task');
    const state=JSON.parse(await fs.readFile(path.join(f.dir,'unihub-model','state.json'),'utf8'));
    expect(state.calls.media_dispatch_1.status).toBe('ASYNC_PENDING'); expect(state.calls.media_dispatch_1.model).toBe('wan2.6-t2v');
    expect(f.grants.some((grant)=>grant.body.models?.includes('wan2.6-t2v'))).toBe(true);
  });

  it('admits a media task and journeys video end to end', async () => {
    const f = await fixture();
    const admitted = await f.runtime().admitMediaTask(alice, { model: { providerID: 'unihub', id: 'wan2.6-t2v' } });
    expect(admitted.model).toBe('wan2.6-t2v'); expect(admitted.sessionID).toMatch(/^media_/);
    const result=await f.runtime().mediaDispatch({identity:alice,sessionID:admitted.sessionID,callID:'media_admit_1',model:'wan2.6-t2v',operation:'video',inputs:{prompt:'cat',seconds:5,size:'1280*720'}});
    expect(result.taskId).toBe('provider-task');
    await expect(f.runtime().admitMediaTask(alice,{model:{providerID:'unihub',id:'gpt-4o-mini-tts'}})).rejects.toMatchObject({code:'platform_media_model_not_allowed'});
  });

  it('reconciles a media call using its model grant before the next agent call', async () => {
    const f=await fixture(); await f.runtime().admit(alice,session(),'msg_test');
    await f.runtime().mediaCall({identity:alice,sessionID:'ses_one',callID:'media_cross_model',model:'wan2.6-t2v',operation:'video',inputs:{prompt:'cat'},dispatch:async()=>({})});
    f.calls.set('media_cross_model','SETTLED'); f.callModels.set('media_cross_model','wan2.6-t2v');
    expect((await f.prepare('after-media')).status).toBe(200);
    expect(f.runtime().status(alice,'ses_one').calls).toContainEqual({callID:'media_cross_model',status:'SETTLED'});
  });

  it('restores an admitted media task identity after restart', async () => {
    const f=await fixture(); const admitted=await f.runtime().admitMediaTask(alice,{model:{providerID:'unihub',id:'wan2.6-t2v'}});
    await f.restart(); const again=await f.runtime().admitMediaTask(alice,{model:{providerID:'unihub',id:'wan2.6-t2v'}});
    expect(again.sessionID).toBe(admitted.sessionID);
    const result=await f.runtime().mediaDispatch({identity:alice,sessionID:again.sessionID,callID:'video_after_restart',model:'wan2.6-t2v',operation:'video',inputs:{prompt:'cat',seconds:5,size:'1280*720'}});
    expect(result.taskId).toBe('provider-task');
  });

  it('does not block the task when the media transport rejects input locally', async () => {
    const f=await fixture(); await f.runtime().admit(alice,session(),'msg_test');
    await expect(f.runtime().mediaDispatch({identity:alice,sessionID:'ses_one',callID:'invalid_media',model:'wan2.6-t2v',operation:'video',inputs:{prompt:'',seconds:5,size:'1280*720'}})).rejects.toMatchObject({local:true});
    expect(f.runtime().status(alice,'ses_one').blocked).toBe(false); expect((await f.prepare('after-local-rejection')).status).toBe(200);
  });

  it('serves an active agent session on the private listener', async () => {
    const f=await fixture(); await f.runtime().admit(alice,session(),'msg_test');
    const child=f.runtime().createChildEnv(); expect(child.OPENCHAMBER_UNIHUB_PROXY_URL.startsWith('http://127.0.0.1:')).toBe(true);
    const response=await f.internal('/media/session',{}); expect(response.status).toBe(200); expect(await response.json()).toEqual({sessionID:'ses_one'});
  });

  it('refuses the media broker without the capability token or an admitted session', async () => {
    const f=await fixture(); await f.runtime().admit(alice,session(),'msg_test');
    const child=f.runtime().createChildEnv();
    const denied=await fetch(child.OPENCHAMBER_UNIHUB_PROXY_URL+'/media/session',{method:'POST',headers:{authorization:'Bearer wrong-token','content-type':'application/json'},body:'{}'});
    expect(denied.status).toBe(401);
    const unbound=await f.internal('/media/session',{sessionID:'ses_never_admitted'}); expect(unbound.status).toBe(403);
  });

  it('rejects a duplicate media call id', async () => {
    const f = await fixture(); await f.runtime().admit(alice, session(), 'msg_test');
    const base = { identity: alice, sessionID: 'ses_one', model: 'wan2.6-t2v', operation: 'video', inputs: { text: 'x', voice: 'Cherry' } };
    await f.runtime().mediaCall({ ...base, callID: 'media_call_5', dispatch: async () => ({ buffer: Buffer.from('a'), contentType: 'audio/mpeg' }) });
    f.calls.set('media_call_5', 'SETTLED');
    f.callModels.set('media_call_5', 'wan2.6-t2v');
    await expect(f.runtime().mediaCall({ ...base, callID: 'media_call_5', dispatch: async () => ({ buffer: Buffer.from('b'), contentType: 'audio/mpeg' }) }))
      .rejects.toMatchObject({ code: 'platform_call_already_exists' });
  });

  it('mints and caches per-model media grants under an admitted task', async () => {
    const f = await fixture(); await f.runtime().admit(alice, session(), 'msg_test');
    const state = JSON.parse(await fs.readFile(path.join(f.dir, 'unihub-model', 'state.json'), 'utf8'));
    const task = state.tasks.ses_one;
    const minted = f.grants.length;
    const grant = await f.runtime().mediaCredential(task, alice, 'qwen3-tts-flash');
    expect(grant.models).toEqual(['qwen3-tts-flash']);
    expect(grant.task_id).toBe(task.id);
    expect(f.grants.at(-1).body.models).toEqual(['qwen3-tts-flash']);
    expect(f.grants.length).toBe(minted + 1);
    const again = await f.runtime().mediaCredential(task, alice, 'qwen3-tts-flash');
    expect(again.token).toBe(grant.token);
    expect(f.grants.length).toBe(minted + 1);
    const otherModel = await f.runtime().mediaCredential(task, alice, 'qwen-image-2.0');
    expect(otherModel.models).toEqual(['qwen-image-2.0']);
    expect(f.grants.length).toBe(minted + 2);
    await expect(f.runtime().mediaCredential(task, other, 'qwen3-tts-flash')).rejects.toMatchObject({ code: 'platform_model_scope_restart_required' });
  });

  it('keeps ordinary providers usable while another process owns the platform journal', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'platform-model-busy-'));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const env = { OPENCHAMBER_UNIHUB_GATEWAY_URL: 'http://127.0.0.1:3001/platform/v1',
      OPENCHAMBER_UNIHUB_MODELS: JSON.stringify([{ id: 'fixture', name: 'Fixture', context: 8192, maxOutput: 100 }]) };
    const create = () => createPlatformModelRuntime({ dataDir: dir, instanceDir: path.join(dir, 'run'), env,
      getAccountRuntime: () => { throw new Error('Unavailable journals must not reach account services'); },
      readExecution: async () => null, enterprise: () => false });
    const owner = await create(); cleanups.push(() => owner.close());
    const before = await fs.readFile(path.join(dir, 'unihub-model', 'writer.lock'), 'utf8');
    const blocked = await create(); cleanups.push(() => blocked.close());
    expect(blocked.enabled()).toBe(false);
    expect(blocked.providerConfig()).toEqual({});
    expect(blocked.createChildEnv()).toEqual({});
    expect(blocked.authorizeSession(alice, 'ordinary')).toBe(false);
    expect(await blocked.admit(alice, { id: 'ordinary', model: { providerID: 'byok', id: 'own-model' } }, 'msg_test')).toBe(false);
    await expect(blocked.admit(alice, session(), 'msg_test')).rejects.toMatchObject({ code: 'platform_store_busy', status: 503 });
    await expect(blocked.materializePlugin()).rejects.toMatchObject({ code: 'platform_store_busy', status: 503 });
    await blocked.close();
    expect(await fs.readFile(path.join(dir, 'unihub-model', 'writer.lock'), 'utf8')).toBe(before);
    expect(owner.enabled()).toBe(true);
  });

  it('keeps corrupt journal bytes intact without blocking runtime construction', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'platform-model-corrupt-'));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const folder = path.join(dir, 'unihub-model'); await fs.mkdir(folder);
    const filename = path.join(folder, 'state.json'); await fs.writeFile(filename, '{broken');
    const runtime = await createPlatformModelRuntime({ dataDir: dir, instanceDir: path.join(dir, 'run'), env: {},
      usePublicDefaults: true, getAccountRuntime: () => null, readExecution: async () => null, enterprise: () => false });
    cleanups.push(() => runtime.close());
    expect(runtime.enabled()).toBe(false);
    expect(runtime.providerConfig()).toEqual({});
    expect(() => runtime.status(alice, 'ses_one')).toThrow('platform_store_unavailable');
    expect(await fs.readFile(filename, 'utf8')).toBe('{broken');
  });

  it('uses the published public catalog when the managed desktop has no local override', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'platform-model-defaults-'));
    cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
    const runtime = await createPlatformModelRuntime({
      dataDir: dir,
      instanceDir: path.join(dir, 'run'),
      env: {},
      usePublicDefaults: true,
      getAccountRuntime: () => null,
      readExecution: async () => null,
      isManaged: () => true,
      enterprise: () => false,
    });
    cleanups.push(() => runtime.close());
    await runtime.materializePlugin();
    const child = runtime.createChildEnv();
    expect(child.OPENCHAMBER_UNIHUB_PROXY_URL).toMatch(/^http:[\/]+127\.0\.0\.1:/);
    expect(Object.keys(runtime.providerConfig().unihub.models)).toHaveLength(22);
  });

  it('binds a payer before IO and leaves cash/identity secrets out of durable state', async () => {
    const f = await fixture(); await f.runtime().admit(alice, session(), 'msg_test');
    expect((await f.prepare('logical-1')).status).toBe(200);
    const response = await f.completion('logical-1'); expect(response.status).toBe(200); expect(await response.text()).toContain('[DONE]');
    expect(f.requests()).toBe(1);
    expect(f.grants.every((grant) => grant.target === '/v1/accounts/personal/model-credentials')).toBe(true);
    expect((await f.completion('logical-1')).status).toBe(409);
    expect(f.requests()).toBe(1);
    await expect(f.runtime().admit(other, session(), 'msg_test')).rejects.toMatchObject({ code: 'platform_model_scope_restart_required' });
    const state = await fs.readFile(path.join(f.dir, 'unihub-model', 'state.json'), 'utf8');
    expect(state).not.toMatch(/device-one-private|uh_model_\d+_private|"hi"/);
    expect((await f.prepare('logical-2')).status).toBe(200);
    expect((await f.completion('logical-2')).status).toBe(200);
    expect(f.requests()).toBe(2);
  });
  it('rejects digest changes and blocks new logical IDs after partial output until receipt confirms terminal', async () => {
    const f = await fixture(); await f.runtime().admit(alice, session(), 'msg_test'); f.partial();
    expect((await f.prepare('logical-1')).status).toBe(200);
    const response = await f.completion('logical-1'); await expect(response.text()).rejects.toThrow();
    expect((await f.completion('logical-1', 'ses_one', 'changed')).status).toBe(409);
    expect((await f.prepare('logical-2')).status).toBe(409);
    expect(f.requests()).toBe(1);
    f.calls.set('logical-1', 'SETTLED');
    await f.runtime().reconcile(alice, 'ses_one');
    expect((await f.prepare('logical-2')).status).toBe(200);
    expect(f.requests()).toBe(1);
  });
  it('cannot abandon a prepared call whose dispatch commits during reconciliation', async () => {
    const f = await fixture(); await f.runtime().admit(alice, session(), 'msg_test');
    await f.prepare('racing'); f.hold();
    let reconcile;
    const observed = new Promise((resolve) => {
      const watcher = watch(path.join(f.dir, 'unihub-model'), (_event, filename) => {
        if (!filename?.endsWith('.tmp')) return;
        watcher.close();
        reconcile = f.runtime().reconcile(alice, 'ses_one').catch(() => null);
        resolve();
      });
      cleanups.push(() => watcher.close());
    });
    const responsePromise = f.completion('racing');
    await observed; await reconcile;
    const response = await responsePromise;
    try {
      expect(f.requests()).toBe(1);
      expect(f.runtime().status(alice, 'ses_one').blocked).toBe(true);
      expect((await f.prepare('overlap')).status).toBe(409);
    } finally { f.release(); await response.text(); }
  });
  it('preserves unknown calls across restart and requires the original runtime identity again', async () => {
    const f = await fixture(); await f.runtime().admit(alice, session(), 'msg_test'); f.partial();
    await f.prepare('logical-1'); const response = await f.completion('logical-1'); await expect(response.text()).rejects.toThrow();
    await f.restart();
    expect((await f.prepare('logical-2')).status).toBe(401);
    await expect(f.runtime().admit(other, session(), 'msg_test')).rejects.toMatchObject({ code: 'platform_model_scope_restart_required' });
    await expect(f.runtime().admit(alice, session(), 'msg_test')).rejects.toMatchObject({ code: 'platform_reconciliation_required' });
    f.calls.set('logical-1', 'RELEASED'); await f.runtime().reconcile(alice, 'ses_one');
    await f.runtime().admit(alice, session(), 'msg_test');
    expect((await f.prepare('logical-2')).status).toBe(200);
    expect(f.requests()).toBe(1);
  });
  it('journals an aborted active stream before shutdown releases the writer lock', async () => {
    const f = await fixture(); await f.runtime().admit(alice, session(), 'msg_test');
    await f.prepare('closing'); f.hold();
    const response = await f.completion('closing');
    const body = response.text().catch(() => null);
    await f.restart(); f.release(); await body;
    const state = f.runtime().status(alice, 'ses_one');
    expect(state.blocked).toBe(true);
    expect(state.calls).toEqual([{ callID: 'closing', status: 'UNKNOWN' }]);
    expect(f.requests()).toBe(1);
  });
  it('rejects a delayed public admission after shutdown without overwriting the new writer', async () => {
    const f = await fixture(); const pause = f.pauseGrant();
    const old = f.runtime().admit(alice, session(), 'msg_test');
    const outcome = old.then(() => 'accepted', (error) => error.code);
    await pause.started; await f.restart(); pause.resume();
    expect(await outcome).toBe('platform_runtime_unsupported');
    await f.runtime().admit(alice, session(), 'msg_test');
    const disk = JSON.parse(await fs.readFile(path.join(f.dir, 'unihub-model', 'state.json'), 'utf8'));
    expect(Object.values(disk.tasks).map((task) => task.id)).toEqual([f.runtime().status(alice, 'ses_one').taskID]);
    expect(f.requests()).toBe(0);
  });
  it('refuses an internally injected prompt or a completed run without a new authenticated admission', async () => {
    const f = await fixture(); await f.runtime().admit(alice, session(), 'msg_test'); f.newUnadmittedPrompt();
    expect((await f.prepare('injected')).status).toBe(403);
    const ended = await fixture(); await ended.runtime().admit(alice, session(), 'msg_test'); ended.finished();
    expect((await ended.prepare('after-idle')).status).toBe(403);
    expect(f.requests() + ended.requests()).toBe(0);
  });
  it('rejects unbound, auxiliary, child, expired auth and enterprise requests before model IO', async () => {
    const f = await fixture();
    expect((await f.prepare('unbound')).status).toBe(403);
    await expect(f.runtime().admit(alice, { ...session('child'), parentID: 'parent' }, 'msg_test')).rejects.toMatchObject({ code: 'platform_child_unsupported' });
    await f.runtime().admit(alice, session(), 'msg_test'); f.expire();
    expect((await f.prepare('expired')).status).toBe(401);
    f.enterprise(); await expect(f.runtime().admit(alice, session(), 'msg_test')).rejects.toMatchObject({ code: 'enterprise_mode' });
    expect(f.requests()).toBe(0);
  });
});

it.each([{ OPENCHAMBER_UNIHUB_DISABLED: '1' }, { OPENCHAMBER_UNIHUB_MODE: 'off' }])('disables platform models even with explicit local overrides: %j', async (off) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'platform-off-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const runtime = await createPlatformModelRuntime({ dataDir: dir, instanceDir: path.join(dir, 'run'), env: { ...off, OPENCHAMBER_UNIHUB_GATEWAY_URL: 'https://llmrouter.quukk.com/platform/v1', OPENCHAMBER_UNIHUB_MODELS: JSON.stringify([{ id: 'fixture', name: 'Fixture', context: 8192, maxOutput: 100 }]) }, usePublicDefaults: true, getAccountRuntime: () => null, readExecution: async () => null });
  cleanups.push(() => runtime.close());
  expect(runtime.providerConfig()).toEqual({});
});

it.each(['legacy', 'live'])('starts a disabled runtime without disturbing a %s model journal lock', async (kind) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'platform-lock-degraded-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const folder = path.join(dir, 'unihub-model');
  let owner;
  if (kind === 'live') { owner = await openModelStore(dir); cleanups.push(() => owner.close()); }
  else { await fs.mkdir(folder); await fs.writeFile(path.join(folder, 'writer.lock'), '99999:legacy'); }
  const journal = JSON.stringify({ version: 1, tasks: {}, calls: { call: { id: 'call', sessionID: 'ses_one', taskID: 'task', model: 'fixture', digest: 'd', status: 'UNKNOWN', output: false } } });
  await fs.writeFile(path.join(folder, 'state.json'), journal);
  const original = await fs.readFile(path.join(folder, 'writer.lock'), 'utf8');
  const runtime = await createResilientPlatformModelRuntime({ dataDir: dir, instanceDir: path.join(dir, 'run'), env: { OPENCHAMBER_UNIHUB_GATEWAY_URL: 'http://127.0.0.1:3001/platform/v1', OPENCHAMBER_UNIHUB_MODELS: JSON.stringify([{ id: 'fixture', name: 'Fixture', context: 8192, maxOutput: 100 }]) }, getAccountRuntime: () => null, readExecution: async () => null, isManaged: () => true, enterprise: () => false });
  cleanups.push(() => runtime.close());
  expect(runtime.enabled()).toBe(false);
  expect(runtime.unavailableReason()).toBe('platform_store_busy');
  expect(runtime.createChildEnv()).toEqual({});
  expect(runtime.providerConfig()).toEqual({});
  expect(() => runtime.authorizeSession(alice, 'ses_one')).toThrow('platform_store_busy');
  await expect(runtime.admit(alice, session(), 'msg_test')).rejects.toMatchObject({ code: 'platform_store_busy', status: 503 });
  expect(await fs.readFile(path.join(folder, 'writer.lock'), 'utf8')).toBe(original);
  expect(await fs.readFile(path.join(folder, 'state.json'), 'utf8')).toBe(journal);
  if (owner) expect(owner.read()).toMatchObject({ version: 1 });
});

it('does not mistake a damaged journal for a recoverable lock failure', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'platform-corrupt-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const folder = path.join(dir, 'unihub-model');
  await fs.mkdir(folder); await fs.writeFile(path.join(folder, 'state.json'), '{broken');
  await expect(createResilientPlatformModelRuntime({ dataDir: dir, instanceDir: dir, env: { OPENCHAMBER_UNIHUB_GATEWAY_URL: 'http://127.0.0.1:3001/platform/v1', OPENCHAMBER_UNIHUB_MODELS: JSON.stringify([{ id: 'fixture', name: 'Fixture', context: 8192, maxOutput: 100 }]) }, getAccountRuntime: () => null, readExecution: async () => null })).rejects.toThrow();
  expect(await fs.readFile(path.join(folder, 'state.json'), 'utf8')).toBe('{broken');
});
