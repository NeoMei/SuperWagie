import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPlatformModelRuntime } from './runtime.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const identity = { type: 'client', token: 'video-owner' };
const model = 'wan2.6-t2v';
const mp4 = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');

const fixture = async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-video-broker-'));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  let taskStatus = 'QUEUED'; let chargeStatus = 'UNKNOWN'; let submits = 0; let badHash = false; let payload = mp4; let declaredSize;
  const calls = new Map();
  const gateway = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer grant-${model}` || !req.headers['x-unihub-task-id']) { res.writeHead(403); res.end(); return; }
    if (req.method === 'POST' && req.url === '/platform/v1/videos') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); const callID = req.headers['idempotency-key'];
      if (body.model !== model || !callID) { res.writeHead(400); res.end(); return; }
      submits += 1; calls.set(callID, req.headers['x-unihub-task-id']);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ task_id: 'internal-task-id' })); return;
    }
    const match = /^\/platform\/v1\/(videos|calls)\/([^/]+)(\/result)?$/.exec(req.url);
    if (!match || !calls.has(match[2]) || calls.get(match[2]) !== req.headers['x-unihub-task-id']) { res.writeHead(404); res.end(); return; }
    if (match[1] === 'calls') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ call_id: match[2], status: chargeStatus })); return; }
    if (match[3]) {
      if (taskStatus !== 'SUCCESS') { res.writeHead(409); res.end(); return; }
      res.writeHead(200, { 'content-type': 'video/mp4', 'x-content-sha256': badHash ? '0'.repeat(64) : crypto.createHash('sha256').update(payload).digest('hex'), ...(declaredSize ? {'content-length': declaredSize} : {}) }); res.end(payload); return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: match[2], task_id: 'internal-task-id', status: taskStatus, progress: '50%', result_url: `/platform/v1/videos/${match[2]}/result` }));
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise(resolve => { gateway.closeAllConnections(); gateway.close(resolve); }));
  const env = { OPENCHAMBER_UNIHUB_GATEWAY_URL: `http://127.0.0.1:${gateway.address().port}/platform/v1`, OPENCHAMBER_UNIHUB_MODELS: JSON.stringify([{id: 'agent', name: 'Agent', context: 8192, maxOutput: 100}]), OPENCHAMBER_UNIHUB_MEDIA_MODELS: JSON.stringify([model]) };
  let actorState = { actingUserId: 'alice', billingAccountId: 'personal', authSession: 'login-fixture' };
  let readBarrier = null;
  const account = { actor: () => { if (!actorState) throw new Error('logged out'); return actorState; }, request: async (_who, target, init) => { const body = JSON.parse(init.body); return { token: `grant-${body.models[0]}`, actor_id: 'alice', account_id: target.split('/')[3], task_id: body.task_id, origin_product_id: 'superwagie', models: body.models, expires_at: new Date(Date.now() + 600000).toISOString() }; } };
  let promptID = 'msg_test';
  const runtime = await createPlatformModelRuntime({ dataDir: dir, instanceDir: path.join(dir, 'run'), env, getAccountRuntime: () => account, readExecution: async () => { if (readBarrier) { readBarrier.entered.resolve(); await readBarrier.release.promise; } return {promptID, idle: null, model: {providerID: 'unihub', id: 'agent'}}; }, isManaged: () => true, enterprise: () => false });
  cleanups.push(() => runtime.close()); await runtime.materializePlugin();
  await runtime.admit(identity, {id: 'ses_video', model: {providerID: 'unihub', id: 'agent'}}, 'msg_test');
  const child = runtime.createChildEnv();
  const call = (route, body) => fetch(child.OPENCHAMBER_UNIHUB_PROXY_URL + route, {method: 'POST', headers: {authorization: `Bearer ${child.OPENCHAMBER_UNIHUB_PROXY_TOKEN}`, 'content-type': 'application/json'}, body: JSON.stringify(body)});
  return {runtime, call, setStatus: (value, settlement) => {taskStatus = value; chargeStatus = settlement;}, setPrompt: value => {promptID = value;}, setActor: value => {actorState = value;}, holdRead: () => {readBarrier = {entered:Promise.withResolvers(),release:Promise.withResolvers()}; return readBarrier;}, badHash: () => {badHash = true;}, setPayload: (bytes, declared) => {payload = bytes; declaredSize = declared;}, submits: () => submits};
};

describe('managed video broker', () => {
  it.each([
    ['payer switch', {actingUserId:'alice',billingAccountId:'team',authSession:'login-fixture'}],
    ['actor switch', {actingUserId:'bob',billingAccountId:'personal',authSession:'login-fixture'}],
    ['new login', {actingUserId:'alice',billingAccountId:'personal',authSession:'new-login'}],
    ['logout', null],
  ])('rejects session selection after %s', async (_label, state) => {
    const f=await fixture(); f.setActor(state);
    const response=await f.call('/media/session',{sessionID:'ses_video'});
    expect([401,403]).toContain(response.status);
    expect(f.submits()).toBe(0);
  });
  it('rechecks payer after readExecution returns before exposing the session', async () => {
    const f=await fixture(), barrier=f.holdRead();
    const response=f.call('/media/session',{}); await barrier.entered.promise;
    f.setActor({actingUserId:'alice',billingAccountId:'team',authSession:'login-fixture'}); barrier.release.resolve();
    expect((await response).status).toBe(403);
    expect(f.submits()).toBe(0);
  });
  it('selects only the current admitted prompt session and rejects a different or expired session before submission', async () => {
    const f = await fixture();
    const selected = await f.call('/media/session', {});
    expect(selected.status).toBe(200);
    expect(await selected.json()).toEqual({sessionID:'ses_video'});
    expect((await f.call('/media/session', {sessionID:'ses_other'})).status).toBe(403);
    f.setPrompt('later_prompt');
    expect((await f.call('/media/session', {sessionID:'ses_video'})).status).toBe(403);
    expect(f.submits()).toBe(0);
  });
  it('rejects a new paid submission after the admitted prompt ends, even with an explicit session', async () => {
    const f = await fixture();
    f.setPrompt('later_prompt');
    const response = await f.call('/media/video', {sessionID: 'ses_video', callID: 'video_late', model, prompt: 'cat', seconds: 5, size: '1280*720'});
    expect(response.status).toBe(403);
    expect(f.submits()).toBe(0);
  });
  it('submits once with a stable call ID, polls the call ID and returns only settled owned MP4 bytes', async () => {
    const f = await fixture(); const input = {sessionID: 'ses_video', callID: 'video_call_1', model, prompt: 'orange cat', seconds: 5, size: '1280*720'};
    const submitted = await f.call('/media/video', input); expect(submitted.status).toBe(200); expect(await submitted.json()).toEqual({callID: 'video_call_1', sessionID: 'ses_video'});
    const duplicate = await f.call('/media/video', input); expect(duplicate.status).toBe(409); expect(f.submits()).toBe(1);
    const pending = await f.call('/media/video/status', {sessionID: 'ses_video', callID: 'video_call_1'}); expect(await pending.json()).toMatchObject({callID: 'video_call_1', status: 'QUEUED'});
    const denied = await f.call('/media/video/result', {sessionID: 'ses_video', callID: 'video_call_1'}); expect(denied.status).toBe(409);
    f.setStatus('SUCCESS', 'SETTLED'); const result = await f.call('/media/video/result', {sessionID: 'ses_video', callID: 'video_call_1'});
    expect(result.status).toBe(200); expect(result.headers.get('content-type')).toBe('video/mp4'); expect(Buffer.from(await result.arrayBuffer())).toEqual(mp4);
    expect(f.runtime.status(identity, 'ses_video').calls).toContainEqual({callID: 'video_call_1', status: 'SETTLED'});
  });
  it('rejects wrong session, unadmitted model and a mismatched result digest', async () => {
    const f = await fixture();
    const invalid = await f.call('/media/video', {sessionID: 'ses_video', callID: 'video_bad', model: 'other-model', prompt: 'cat', seconds: 5, size: '1280*720'}); expect(invalid.status).toBe(403);
    const missing = await f.call('/media/video/status', {sessionID: 'ses_other', callID: 'video_bad'}); expect(missing.status).toBe(401);
    expect((await f.call('/media/video', {sessionID: 'ses_video', callID: 'video_call_2', model, prompt: 'cat', seconds: 5, size: '1280*720'})).status).toBe(200);
    f.setStatus('SUCCESS', 'SETTLED'); f.badHash(); const result = await f.call('/media/video/result', {sessionID: 'ses_video', callID: 'video_call_2'}); expect(result.status).toBe(502);
  });
  it('accepts exactly 64 MiB and rejects an oversized declared result', async () => {
    const f = await fixture();
    expect((await f.call('/media/video', {sessionID: 'ses_video', callID: 'video_boundary', model, prompt: 'cat', seconds: 5, size: '1280*720'})).status).toBe(200);
    f.setStatus('SUCCESS', 'SETTLED');
    const bytes = Buffer.alloc(64 * 1024 * 1024); mp4.copy(bytes);
    f.setPayload(bytes); const accepted = await f.call('/media/video/result', {sessionID: 'ses_video', callID: 'video_boundary'});
    expect(accepted.status).toBe(200); expect((await accepted.arrayBuffer()).byteLength).toBe(bytes.length);
    f.setPayload(mp4, bytes.length + 1); const oversized = await f.call('/media/video/result', {sessionID: 'ses_video', callID: 'video_boundary'});
    expect(oversized.status).toBe(502);
  }, 30000);

});
