import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPlatformModelRuntime } from './runtime.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const alice = { type: 'client', token: 'device-one-private' };
const other = { type: 'client', token: 'device-two-private' };
const session = (id = 'ses_one') => ({ id, model: { providerID: 'unihub', id: 'fixture' } });
const fixture = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'platform-model-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  let promptID = 'msg_test'; let idle = null;
  let selected = 'personal'; let enabled = true; let enterprise = false; let mode = 'ok';
  let requests = 0; const grants = []; const calls = new Map(); let release; let waitForGrant;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET') {
      const id = req.url.split('/').pop();
      res.writeHead(calls.has(id) ? 200 : 404, { 'content-type': 'application/json' });
      res.end(JSON.stringify(calls.has(id) ? { call_id: id, status: calls.get(id) } : { error: 'not_found' })); return;
    }
    requests += 1;
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (req.url === '/platform/v1/native/bailian/audio/speech') {
      if (req.headers.authorization !== 'Bearer uh_model_private' || !req.headers['x-unihub-task-id'] || !req.headers['idempotency-key']) {
        res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"unauthorized"}'); return;
      }
      if (body.model !== 'qwen3-tts-flash' || body.input.text !== '你好' || body.input.voice !== 'Cherry') {
        res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"invalid"}'); return;
      }
      res.writeHead(200, { 'content-type': 'audio/mpeg' });
      res.end(Buffer.from('media-mp3-bytes')); return;
    }
    expect(req.headers.authorization).toBe('Bearer uh_model_private');
    expect(req.headers['x-unihub-task-id']).toMatch(/^uh_task_/);
    expect(body.stream).toBe(true);
    expect(body.stream_options.include_usage).toBe(true);
    expect(body.max_tokens).toBe(100);
    const id = req.headers['idempotency-key']; calls.set(id, mode === 'ok' ? 'SETTLED' : 'UNKNOWN');
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
    actor: () => { if (!enabled) throw new Error('expired'); return { actingUserId: 'alice', billingAccountId: selected }; },
    request: async (_identity, target, init) => {
      const body = JSON.parse(init.body); grants.push({ target, body });
      await waitForGrant?.();
      return { id: 'credential', token: 'uh_model_private', actor_id: 'alice', account_id: target.split('/')[3], task_id: body.task_id, origin_product_id: 'superwagie', models: body.models, expires_at: new Date(Date.now() + 600000).toISOString() };
    },
  };
  const create = async () => {
    const runtime = await createPlatformModelRuntime({ dataDir: dir, instanceDir: path.join(dir, 'run'), env, getAccountRuntime: () => account, readExecution: async () => ({ promptID, idle, model: session().model }), isManaged: () => true, enterprise: () => enterprise });
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
  return { runtime: () => runtime, prepare, completion, dir, requests: () => requests, grants, calls,
    select: (value) => { selected = value; }, expire: () => { enabled = false; }, enterprise: () => { enterprise = true; }, partial: () => { mode = 'partial'; }, hold: () => { mode = 'held'; }, release: () => release?.(), newUnadmittedPrompt: () => { promptID = 'msg_unadmitted'; }, finished: () => { idle = Date.now(); },
    restart: async () => { await runtime.close(); runtime = await create(); },
    pauseGrant: () => {
      const started = Promise.withResolvers(); const done = Promise.withResolvers();
      waitForGrant = async () => { started.resolve(); await done.promise; };
      return { started: started.promise, resume: () => { waitForGrant = null; done.resolve(); } };
    },
  };
};

describe('UniHub model transport', () => {
  it('journals, dispatches and settles a media call', async () => {
    const f = await fixture(); await f.runtime().admit(alice, session(), 'msg_test');
    const dispatched = [];
    const result = await f.runtime().mediaCall({
      identity: alice, sessionID: 'ses_one', callID: 'media_call_1', model: 'qwen3-tts-flash', operation: 'speech',
      inputs: { text: '你好', voice: 'Cherry' },
      dispatch: async (ctx) => { dispatched.push(ctx); return { buffer: Buffer.from('mp3'), contentType: 'audio/mpeg' }; },
    });
    expect(result.buffer.toString()).toBe('mp3');
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].grant.models).toEqual(['qwen3-tts-flash']);
    expect(dispatched[0].idempotencyKey).toBe('media_call_1');
    const state = JSON.parse(await fs.readFile(path.join(f.dir, 'unihub-model', 'state.json'), 'utf8'));
    expect(state.calls.media_call_1.status).toBe('DELIVERED');
    expect(state.calls.media_call_1.operation).toBe('speech');
  });

  it('keeps an unresolved media call blocking after transport failure', async () => {
    const f = await fixture(); await f.runtime().admit(alice, session(), 'msg_test');
    await expect(f.runtime().mediaCall({
      identity: alice, sessionID: 'ses_one', callID: 'media_call_2', model: 'qwen3-tts-flash', operation: 'speech',
      inputs: { text: '你好', voice: 'Cherry' },
      dispatch: async () => { const e = new Error('transport died'); e.code = 'native_media_unresolved'; throw e; },
    })).rejects.toThrow('transport died');
    const state = JSON.parse(await fs.readFile(path.join(f.dir, 'unihub-model', 'state.json'), 'utf8'));
    expect(state.calls.media_call_2.status).toBe('DISPATCHED');
    await expect(f.runtime().mediaCall({
      identity: alice, sessionID: 'ses_one', callID: 'media_call_3', model: 'qwen3-tts-flash', operation: 'speech',
      inputs: { text: '你好', voice: 'Cherry' }, dispatch: async () => ({}),
    })).rejects.toMatchObject({ code: 'platform_reconciliation_required' });
  });

  it('removes a prepared media entry when dispatch refuses locally', async () => {
    const f = await fixture(); await f.runtime().admit(alice, session(), 'msg_test');
    const localError = Object.assign(new Error('bad input'), { local: true });
    await expect(f.runtime().mediaCall({
      identity: alice, sessionID: 'ses_one', callID: 'media_call_4', model: 'qwen3-tts-flash', operation: 'speech',
      inputs: { text: '你好', voice: 'Cherry' }, dispatch: async () => { throw localError; },
    })).rejects.toThrow('bad input');
    let state = JSON.parse(await fs.readFile(path.join(f.dir, 'unihub-model', 'state.json'), 'utf8'));
    expect(state.calls.media_call_4).toBeUndefined();
    const ok = await f.runtime().mediaCall({
      identity: alice, sessionID: 'ses_one', callID: 'media_call_4', model: 'qwen3-tts-flash', operation: 'speech',
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

  it('mediaDispatch journeys speech through the transport with a task grant', async () => {
    const f = await fixture(); await f.runtime().admit(alice, session(), 'msg_test');
    const result = await f.runtime().mediaDispatch({
      identity: alice, sessionID: 'ses_one', callID: 'media_dispatch_1', model: 'qwen3-tts-flash', operation: 'speech',
      inputs: { text: '你好', voice: 'Cherry' },
    });
    expect(result.buffer.toString()).toBe('media-mp3-bytes');
    expect(result.contentType).toBe('audio/mpeg');
    const state = JSON.parse(await fs.readFile(path.join(f.dir, 'unihub-model', 'state.json'), 'utf8'));
    expect(state.calls.media_dispatch_1.status).toBe('DELIVERED');
    expect(state.calls.media_dispatch_1.model).toBe('qwen3-tts-flash');
    expect(f.grants.some((grant) => grant.body.models?.includes('qwen3-tts-flash'))).toBe(true);
  });

  it('admits a media task and journeys speech end to end', async () => {
    const f = await fixture();
    const admitted = await f.runtime().admitMediaTask(alice, { model: { providerID: 'unihub', id: 'qwen3-tts-flash' } });
    expect(admitted.model).toBe('qwen3-tts-flash');
    expect(admitted.sessionID).toMatch(/^media_/);
    const result = await f.runtime().mediaDispatch({
      identity: alice, sessionID: admitted.sessionID, callID: 'media_admit_1', model: 'qwen3-tts-flash', operation: 'speech',
      inputs: { text: '你好', voice: 'Cherry' },
    });
    expect(result.buffer.toString()).toBe('media-mp3-bytes');
    await expect(f.runtime().admitMediaTask(alice, { model: { providerID: 'unihub', id: 'gpt-4o-mini-tts' } }))
      .rejects.toMatchObject({ code: 'platform_media_model_not_allowed' });
  });

  it('serves managed speech on the private listener for admitted sessions', async () => {
    const f = await fixture(); await f.runtime().admit(alice, session(), 'msg_test');
    await f.runtime().admitMediaTask(alice, { model: { providerID: 'unihub', id: 'qwen3-tts-flash' } });
    const child = f.runtime().createChildEnv();
    expect(child.OPENCHAMBER_UNIHUB_PROXY_URL.startsWith('http://127.0.0.1:')).toBe(true);
    const response = await fetch(child.OPENCHAMBER_UNIHUB_PROXY_URL + '/media/speech', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + child.OPENCHAMBER_UNIHUB_PROXY_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionID: 'ses_one', model: 'qwen3-tts-flash', text: '你好', voice: 'Cherry' }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    const audio = Buffer.from(await response.arrayBuffer());
    expect(audio.length).toBeGreaterThan(0);
  });

  it('refuses the media broker without the capability token or an admitted session', async () => {
    const f = await fixture(); await f.runtime().admit(alice, session(), 'msg_test');
    await f.runtime().admitMediaTask(alice, { model: { providerID: 'unihub', id: 'qwen3-tts-flash' } });
    const child = f.runtime().createChildEnv();
    const denied = await fetch(child.OPENCHAMBER_UNIHUB_PROXY_URL + '/media/speech', {
      method: 'POST', headers: { authorization: 'Bearer wrong-token', 'content-type': 'application/json' },
      body: JSON.stringify({ sessionID: 'ses_one', model: 'qwen3-tts-flash', text: '你好', voice: 'Cherry' }),
    });
    expect(denied.status).toBe(401);
    const unbound = await fetch(child.OPENCHAMBER_UNIHUB_PROXY_URL + '/media/speech', {
      method: 'POST', headers: { authorization: 'Bearer ' + child.OPENCHAMBER_UNIHUB_PROXY_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ sessionID: 'ses_never_admitted', model: 'qwen3-tts-flash', text: '你好', voice: 'Cherry' }),
    });
    expect(unbound.status).toBe(401);
  });
  it('rejects a duplicate media call id', async () => {
    const f = await fixture(); await f.runtime().admit(alice, session(), 'msg_test');
    const base = { identity: alice, sessionID: 'ses_one', model: 'qwen3-tts-flash', operation: 'speech', inputs: { text: 'x', voice: 'Cherry' } };
    await f.runtime().mediaCall({ ...base, callID: 'media_call_5', dispatch: async () => ({ buffer: Buffer.from('a'), contentType: 'audio/mpeg' }) });
    f.calls.set('media_call_5', 'SETTLED');
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
    await expect(f.runtime().mediaCredential(task, other, 'qwen3-tts-flash')).rejects.toMatchObject({ code: 'platform_task_owner_mismatch' });
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
    f.select('team-other');
    expect((await f.prepare('logical-1')).status).toBe(200);
    const response = await f.completion('logical-1'); expect(response.status).toBe(200); expect(await response.text()).toContain('[DONE]');
    expect(f.requests()).toBe(1);
    expect(f.grants.every((grant) => grant.target === '/v1/accounts/personal/model-credentials')).toBe(true);
    expect((await f.completion('logical-1')).status).toBe(409);
    expect(f.requests()).toBe(1);
    await expect(f.runtime().admit(other, session(), 'msg_test')).rejects.toMatchObject({ code: 'platform_task_owner_mismatch' });
    const state = await fs.readFile(path.join(f.dir, 'unihub-model', 'state.json'), 'utf8');
    expect(state).not.toMatch(/device-one-private|uh_model_private|"hi"/);
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
    await expect(f.runtime().admit(other, session(), 'msg_test')).rejects.toMatchObject({ code: 'platform_task_owner_mismatch' });
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
