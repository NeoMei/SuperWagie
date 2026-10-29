import fs from 'node:fs/promises';
import { watch } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { registerTtsRoutes } from '../tts/routes.js';
import { createPlatformModelRuntime } from './runtime.js';
import { openModelStore } from './store.js';
import { createResilientPlatformModelRuntime } from './degraded.js';
import { readPlatformExecution } from './execution.js';
import { fileURLToPath } from 'node:url';
import { runProcess } from '../../builtin-skills/supervideo-engine/src/providers/process.mjs';
import { requestConfiguredSpeech } from '../../builtin-skills/supervideo-engine/src/providers/model-configuration.mjs';

const cleanups = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const alice = { type: 'client', token: 'device-one-private' };
const other = { type: 'client', token: 'device-two-private' };
const session = (id = 'ses_one') => ({ id, model: { providerID: 'unihub', id: 'fixture' } });
const pauseJournalWrite = (callID, predicate) => {
  const started=Promise.withResolvers(), release=Promise.withResolvers(); let paused=false; const open=fs.open.bind(fs);
  vi.spyOn(fs,'open').mockImplementation(async (...args) => {
    const handle=await open(...args);
    if (String(args[0]).includes('/unihub-model/state.json.') && String(args[0]).endsWith('.tmp')) {
      const write=handle.writeFile.bind(handle);
      handle.writeFile=async(data,...rest)=>{
        if (!paused && typeof data==='string' && predicate(JSON.parse(data).calls[callID])) {paused=true;started.resolve();await release.promise;}
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
  let requests = 0; const grants = []; const calls = new Map(); const grantModels = new Map(); const callModels = new Map(); let release; let waitForGrant;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET') {
      const id = req.url.split('/').pop();
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
    const runtime = await createPlatformModelRuntime({ dataDir: dir, instanceDir: path.join(dir, 'run'), env, getAccountRuntime: () => account, readExecution: options.readExecution ?? (async () => ({ promptID, idle, model: session().model })), isManaged: () => true, enterprise: () => enterprise });
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
    pauseGrant: () => {
      const started = Promise.withResolvers(); const done = Promise.withResolvers();
      waitForGrant = async () => { started.resolve(); await done.promise; };
      return { started: started.promise, resume: () => { waitForGrant = null; done.resolve(); } };
    },
  };
};

describe('UniHub model transport', () => {
  it('authorizes a long active prompt across pages and refuses an unreadable continuation', async () => {
    let broken=false;
    const client={session:{get:async()=>session()},message:{list:async({cursor})=>{
      if (cursor && broken) throw new Error('offline');
      return cursor ? {data:[{type:'user',id:'msg_test'}]} : {data:Array.from({length:100},(_,i)=>({type:'assistant',id:`a${i}`})),cursor:{next:'older'}};
    }}};
    const f=await fixture({readExecution:(id)=>readPlatformExecution(client,id)}); await f.runtime().admit(alice,session(),'msg_test');
    const response=await f.internal('/media/speech',{model:'qwen3-tts-flash',text:'你好',voice:'Cherry'}); expect(response.status).toBe(200); await response.arrayBuffer();
    broken=true; const denied=await f.internal('/media/speech',{model:'qwen3-tts-flash',text:'你好',voice:'Cherry'}); expect(denied.status).toBe(409); expect(f.requests()).toBe(1);
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
    const result=f.runtime().mediaCall({identity:alice,sessionID:'ses_one',callID:'media_race',model:'qwen3-tts-flash',operation:'speech',inputs:{text:'hello'},dispatch:async()=>{sends++;return {buffer:Buffer.from('ok'),contentType:'audio/mpeg'};}}).then(()=>null,error=>error);
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
    expect((await f.internal('/media/speech',{sessionID:media.sessionID,model:'qwen3-tts-flash',text:'你好',voice:'Cherry'})).status).toBe(403);
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
    const pending=f.runtime().mediaCall({identity:alice,sessionID:'ses_one',callID:'media_inflight',model:'qwen3-tts-flash',operation:'speech',inputs:{text:'private'},dispatch:async()=>{started.resolve();await release.promise;return {buffer:Buffer.from('secret'),contentType:'audio/mpeg'};}});
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
    const child = f.runtime().createChildEnv();
    const response = await fetch(child.OPENCHAMBER_UNIHUB_PROXY_URL + '/media/speech', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + child.OPENCHAMBER_UNIHUB_PROXY_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen3-tts-flash', text: '你好', voice: 'Cherry' }),
    });
    if (response.status !== 200) console.log('MEDIA_BROKER_DEBUG:', JSON.stringify(await response.json()));
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).length).toBeGreaterThan(0);
  });

  it('refuses ambiguous or missing media sessions with distinct codes', async () => {
    const f = await fixture(); await f.runtime().admit(alice, session(), 'msg_test');
    const child = f.runtime().createChildEnv();
    const call = (body) => fetch(child.OPENCHAMBER_UNIHUB_PROXY_URL + '/media/speech', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + child.OPENCHAMBER_UNIHUB_PROXY_TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    f.finished();
    const missing = await call({ model: 'qwen3-tts-flash', text: 'x', voice: 'Cherry' });
    expect(missing.status).toBe(409);
    expect((await missing.json()).error.code).toBe('platform_media_session_missing');
    await f.runtime().admitMediaTask(alice, { model: { providerID: 'unihub', id: 'qwen3-tts-flash' } });
    await expect(f.runtime().admitMediaTask(other, { model: { providerID: 'unihub', id: 'qwen3-tts-flash' } })).rejects.toMatchObject({code:'platform_model_scope_restart_required'});
  });

  it('uses the unique active agent permit for skill speech and refuses expired or ambiguous permits', async () => {
    const f = await fixture(); await f.runtime().admit(alice, session(), 'msg_test');
    const speech = () => f.internal('/media/speech', { model:'qwen3-tts-flash', text:'你好', voice:'Cherry' });
    const first = await speech(); expect(first.status).toBe(200); await first.arrayBuffer();
    await f.runtime().admit(alice, session('ses_two'), 'msg_test');
    const ambiguous = await speech(); expect(ambiguous.status).toBe(409); expect((await ambiguous.json()).error.code).toBe('platform_media_session_ambiguous');
    expect(f.requests()).toBe(1);
    f.finished(); const expired = await speech(); expect(expired.status).toBe(409); expect(f.requests()).toBe(1);
  });

  it('refuses shared child access to dedicated tasks after the agent permit expires', async () => {
    const f=await fixture(); const dedicated=await f.runtime().admitMediaTask(alice,{model:{providerID:'unihub',id:'qwen3-tts-flash'}});
    await f.runtime().admit(alice,session(),'msg_test'); f.finished();
    const input={model:'qwen3-tts-flash',text:'你好',voice:'Cherry'};
    expect((await f.internal('/media/speech',input)).status).toBe(409);
    expect((await f.internal('/media/speech',{...input,sessionID:dedicated.sessionID})).status).toBe(403);
    expect(f.requests()).toBe(0);
    const spoken=await f.runtime().mediaDispatch({identity:alice,sessionID:dedicated.sessionID,callID:'authorized-ui',model:input.model,operation:'speech',inputs:{text:input.text,voice:input.voice}});
    expect(spoken.buffer.toString()).toBe('media-mp3-bytes');
  });

  it('keeps authenticated UI TTS and STT working independently of expired agent permits', async () => {
    const f=await fixture(); await f.runtime().admit(alice,session(),'msg_test'); f.finished();
    const app=express(); app.use(express.json());
    registerTtsRoutes(app,{resolvePlatformIdentity:async()=>alice,getPlatformModelRuntime:()=>f.runtime(),resolveModelBinding:async purpose=>purpose==='tts' ? {protocol:'managed-media',model:'qwen3-tts-flash',parameters:{voice:'Cherry'}} : purpose==='stt-short' ? {protocol:'managed-media',model:'qwen3-asr-flash',parameters:{}} : null});
    const spoken=await request(app).post('/api/tts/speak').send({text:'你好'}); expect(spoken.status).toBe(200); expect(spoken.body.toString()).toBe('media-mp3-bytes');
    const heard=await request(app).post('/api/stt/transcribe').set('content-type','audio/webm').send(Buffer.from('audio')); expect(heard.status).toBe(200); expect(heard.body).toEqual({transcript:'heard'});
    expect(f.requests()).toBe(2);
  });

  it('does not dispatch when a skill permit expires while a model grant is pending', async () => {
    const f=await fixture(); await f.runtime().admit(alice,session(),'msg_test');
    const held=f.pauseGrant(); const pending=f.internal('/media/speech',{model:'qwen3-tts-flash',text:'你好',voice:'Cherry'});
    await held.started; f.finished(); held.resume();
    const response=await pending; expect(response.status).toBe(409); expect(f.requests()).toBe(0);
    const state=JSON.parse(await fs.readFile(path.join(f.dir,'unihub-model','state.json'),'utf8'));
    expect(Object.values(state.calls).every(call=>call.status==='REJECTED')).toBe(true);
  });

  it('routes actual image and narration skill processes through a unique agent session', async () => {
    const f = await fixture(); await f.runtime().admit(alice, session(), 'msg_test');
    await fs.writeFile(path.join(f.dir, 'model-configuration.json'), JSON.stringify({version:1,revision:1,connections:[{id:'managed',name:'UniHub',providerId:'unihub',protocol:'managed-media',baseUrl:'https://llmrouter.example.test/platform/v1'}],bindings:[
      {purpose:'image-generation',connectionId:'managed',model:'qwen-image-2.0',parameters:{},verification:{status:'untested'}},
      {purpose:'tts',connectionId:'managed',model:'qwen3-tts-flash',parameters:{voice:'Cherry'},verification:{status:'untested'}},
    ]}));
    const resolver=fileURLToPath(new URL('../model-configuration/resolve-cli.js',import.meta.url));
    const skillDir=fileURLToPath(new URL('../../builtin-skills/skills/ai-image-to-ppt/scripts/',import.meta.url));
    const childEnv={...process.env,...f.runtime().createChildEnv(),OPENCHAMBER_DATA_DIR:f.dir,SUPERWAGIE_MODEL_RESOLVER:resolver,SUPERWAGIE_MODEL_NODE:process.execPath};
    const image = await runProcess('python3',['-c',"import sys; sys.path.insert(0,sys.argv[1]); from provider_credentials import generate_managed_image; print(len(generate_managed_image('slide','qwen-image-2.0'))) ",skillDir],{env:childEnv,timeoutMs:30000});
    expect(image.code, image.stderr).toBe(0); expect(Number(image.stdout.trim())).toBeGreaterThan(0);
    vi.stubEnv('SUPERWAGIE_MODEL_RESOLVER',resolver);
    const voice={model:'qwen3-tts-flash',voice:'Cherry',provider:'managed-media'};
    const speech = await requestConfiguredSpeech('你好',voice,{resolveBinding:async()=>({protocol:'managed-media',model:voice.model,parameters:{voice:'Cherry'}}),runResolver:(file,args,options)=>runProcess(file,args,{...options,env:childEnv})});
    expect(speech.bytes.toString()).toBe('media-mp3-bytes'); expect(f.requests()).toBe(2);
    f.finished();
    const unavailable = await runProcess('python3',['-c',"import sys; sys.path.insert(0,sys.argv[1]); from provider_credentials import generate_managed_image; generate_managed_image('slide','qwen-image-2.0')",skillDir],{env:childEnv,timeoutMs:30000});
    expect(unavailable.code).not.toBe(0); expect(unavailable.stderr).toContain('active agent session');
    await expect(requestConfiguredSpeech('你好',voice,{resolveBinding:async()=>({protocol:'managed-media',model:voice.model,parameters:{voice:'Cherry'}}),runResolver:(file,args,options)=>runProcess(file,args,{...options,env:childEnv})})).rejects.toThrow('active agent session');
    expect(f.requests()).toBe(2);
    const state=JSON.parse(await fs.readFile(path.join(f.dir,'unihub-model','state.json'),'utf8'));
    expect(Object.values(state.calls).filter(call => call.sessionID==='ses_one').map(call=>call.operation)).toEqual(['image_generation','speech']);
  });

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

  it('reconciles a media call using its model grant before the next agent call', async () => {
    const f = await fixture(); await f.runtime().admit(alice, session(), 'msg_test');
    await f.runtime().mediaDispatch({ identity: alice, sessionID: 'ses_one', callID: 'media_cross_model', model: 'qwen3-tts-flash', operation: 'speech', inputs: { text: '你好', voice: 'Cherry' } });
    expect((await f.prepare('after-media')).status).toBe(200);
    expect(f.runtime().status(alice, 'ses_one').calls).toContainEqual({ callID: 'media_cross_model', status: 'SETTLED' });
  });

  it('restores an admitted media task identity after restart', async () => {
    const f = await fixture();
    const admitted = await f.runtime().admitMediaTask(alice, { model: { providerID: 'unihub', id: 'qwen3-tts-flash' } });
    await f.restart();
    const again = await f.runtime().admitMediaTask(alice, { model: { providerID: 'unihub', id: 'qwen3-tts-flash' } });
    expect(again.sessionID).toBe(admitted.sessionID);
    const result = await f.runtime().mediaDispatch({ identity: alice, sessionID: again.sessionID, callID: 'tts_after_restart', model: 'qwen3-tts-flash', operation: 'speech', inputs: { text: '你好', voice: 'Cherry' } });
    expect(result.buffer.toString()).toBe('media-mp3-bytes');
  });

  it('does not block the task when the media transport rejects input locally', async () => {
    const f = await fixture(); await f.runtime().admit(alice, session(), 'msg_test');
    await expect(f.runtime().mediaDispatch({ identity: alice, sessionID: 'ses_one', callID: 'invalid_media', model: 'qwen3-tts-flash', operation: 'speech', inputs: { text: '', voice: 'Cherry' } })).rejects.toMatchObject({ local: true });
    expect(f.runtime().status(alice, 'ses_one').blocked).toBe(false);
    expect((await f.prepare('after-local-rejection')).status).toBe(200);
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
    expect(unbound.status).toBe(403);
  });
  it('rejects a duplicate media call id', async () => {
    const f = await fixture(); await f.runtime().admit(alice, session(), 'msg_test');
    const base = { identity: alice, sessionID: 'ses_one', model: 'qwen3-tts-flash', operation: 'speech', inputs: { text: 'x', voice: 'Cherry' } };
    await f.runtime().mediaCall({ ...base, callID: 'media_call_5', dispatch: async () => ({ buffer: Buffer.from('a'), contentType: 'audio/mpeg' }) });
    f.calls.set('media_call_5', 'SETTLED');
    f.callModels.set('media_call_5', 'qwen3-tts-flash');
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
