import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createPlatformModelRuntime } from './runtime.js';

const cleanups = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
it('binds a single asynchronous edit to its task, settles before returning image bytes, and never resubmits', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-edit-broker-')); cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  const png = Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'); const image = `data:image/png;base64,${png}`;
  let state = 'pending', count = 0; const observed = [];
  const gateway = http.createServer(async (req, res) => {
    const chunks = []; for await (const part of req) chunks.push(part);
    observed.push({url: req.url, method: req.method, task: req.headers['x-unihub-task-id'], key: req.headers['idempotency-key'], body: Buffer.concat(chunks).toString()});
    if (req.headers.authorization !== 'Bearer grant-wanx2.1-imageedit') { res.writeHead(403); return res.end(); }
    res.setHeader('content-type', 'application/json');
    if (req.method === 'POST') { count++; res.writeHead(202); return res.end(JSON.stringify({id: 'edit_test', status: 'pending'})); }
    if (req.url === '/platform/v1/calls/edit_test') return res.end(JSON.stringify({call_id: 'edit_test', status: state === 'success' ? 'SETTLED' : 'UNKNOWN'}));
    if (req.url === '/platform/v1/images/edits/edit_test') { if (state === 'pending') {res.writeHead(202); return res.end(JSON.stringify({id: 'edit_test', status: 'pending'}));} return res.end(JSON.stringify({data: [{b64_json: png}]})); }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve)); cleanups.push(() => new Promise(resolve => { gateway.closeAllConnections(); gateway.close(resolve); }));
  const env = { OPENCHAMBER_UNIHUB_GATEWAY_URL: `http://127.0.0.1:${gateway.address().port}/platform/v1`, OPENCHAMBER_UNIHUB_MODELS: JSON.stringify([{id:'agent',name:'Agent',context:8192,maxOutput:100}]), OPENCHAMBER_UNIHUB_MEDIA_MODELS: JSON.stringify(['wanx2.1-imageedit']) };
  const identity = {type:'client',token:'edit-owner'}; const account = {actor: () => ({actingUserId:'alice',billingAccountId:'personal',authSession:'login-fixture'}), request: async (_identity, target, init) => {const body = JSON.parse(init.body); return {token:`grant-${body.models[0]}`,actor_id:'alice',account_id:target.split('/')[3],task_id:body.task_id,origin_product_id:'superwagie',models:body.models,expires_at:new Date(Date.now()+600000).toISOString()};}};
  const create = async () => { const value = await createPlatformModelRuntime({dataDir:dir,instanceDir:path.join(dir,'run'),env,getAccountRuntime:()=>account,readExecution:async()=>({promptID:'msg_test',idle:null,model:{providerID:'unihub',id:'agent'}}),isManaged:()=>true,enterprise:()=>false}); await value.materializePlugin(); return value; };
  let runtime = await create(); cleanups.push(()=>runtime.close()); await runtime.admit(identity,{id:'ses_edit',model:{providerID:'unihub',id:'agent'}},'msg_test');
  const call = (url, body) => { const child = runtime.createChildEnv(); return fetch(child.OPENCHAMBER_UNIHUB_PROXY_URL + url,{method:'POST',headers:{authorization:`Bearer ${child.OPENCHAMBER_UNIHUB_PROXY_TOKEN}`,'content-type':'application/json'},body:JSON.stringify(body)}); };
  const input = {sessionID:'ses_edit',callID:'edit_test',model:'wanx2.1-imageedit',prompt:'replace',images:[image],mask:image};
  const submitted = await call('/media/image-edit',input); expect(await submitted.json()).toEqual({callID:'edit_test',sessionID:'ses_edit',status:'pending'});
  expect((await call('/media/image-edit',input)).status).toBe(409); expect(count).toBe(1);
  const pending = await call('/media/image-edit/status',{sessionID:'ses_edit',callID:'edit_test'}); expect(await pending.json()).toEqual({callID:'edit_test',status:'pending'});
  expect((await call('/media/image-edit/status',{sessionID:'ses_other',callID:'edit_test'})).status).toBe(401);
  state='output-not-settled'; const withheld = await call('/media/image-edit/status',{sessionID:'ses_edit',callID:'edit_test'});
  expect(withheld.status).toBe(409); expect(await withheld.json()).toMatchObject({error:{code:'platform_image_edit_settlement_pending'}});
  await runtime.close(); runtime = await create();
  await expect(runtime.admit(identity,{id:'ses_edit',model:{providerID:'unihub',id:'agent'}},'msg_test')).resolves.toBe(true);
  state='success'; const complete = await call('/media/image-edit/status',{sessionID:'ses_edit',callID:'edit_test'}); expect(await complete.json()).toEqual({callID:'edit_test',status:'succeeded',settlement:'SETTLED',images:[{data:png,mimeType:'image/png'}]});
  expect(observed[0].body).toContain('filename="mask.png"'); expect(observed[0].body).not.toContain('name="size"'); expect(observed[0].key).toBe('edit_test'); expect(observed.every(row => row.task === observed[0].task)).toBe(true);
});

it.each(['image-edit', 'video'])('does not send %s after its prompt ends while authority is issuing a grant', async (operation) => {
  const model = operation === 'video' ? 'wan2.6-t2v' : 'wanx2.1-imageedit';
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-edit-permit-')); cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  let gatewayRequests = 0;
  const gateway = http.createServer((_req, res) => { gatewayRequests++; res.writeHead(500); res.end(); });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve)); cleanups.push(() => new Promise(resolve => { gateway.closeAllConnections(); gateway.close(resolve); }));
  const env = { OPENCHAMBER_UNIHUB_GATEWAY_URL: `http://127.0.0.1:${gateway.address().port}/platform/v1`, OPENCHAMBER_UNIHUB_MODELS: JSON.stringify([{id:'agent',name:'Agent',context:8192,maxOutput:100}]), OPENCHAMBER_UNIHUB_MEDIA_MODELS: JSON.stringify([model]) };
  let idle = null, started, release;
  const grantStarted = new Promise(resolve => { started = resolve; });
  const continueGrant = new Promise(resolve => { release = resolve; });
  const identity = {type:'client',token:'edit-owner'};
  const account = {actor: () => ({actingUserId:'alice',billingAccountId:'personal',authSession:'login-fixture'}), request: async (_identity, target, init) => { const body = JSON.parse(init.body); if (body.models[0] === model) { started(); await continueGrant; } return {token:'fixture-grant',actor_id:'alice',account_id:'personal',task_id:body.task_id,origin_product_id:'superwagie',models:body.models,expires_at:new Date(Date.now()+600000).toISOString()}; }};
  const runtime = await createPlatformModelRuntime({dataDir:dir,instanceDir:path.join(dir,'run'),env,getAccountRuntime:()=>account,readExecution:async()=>({promptID:'msg_test',idle,model:{providerID:'unihub',id:'agent'}}),isManaged:()=>true,enterprise:()=>false});
  cleanups.push(()=>runtime.close()); await runtime.materializePlugin(); await runtime.admit(identity,{id:'ses_edit',model:{providerID:'unihub',id:'agent'}},'msg_test');
  const child = runtime.createChildEnv(); const png = 'data:image/png;base64,iVBORw0KGgo=';
  const input = operation === 'video' ? {sessionID:'ses_edit',callID:'video_expired',model,prompt:'replace',seconds:5,size:'1280*720'} : {sessionID:'ses_edit',callID:'edit_expired',model,prompt:'replace',images:[png],mask:png};
  const pending = fetch(child.OPENCHAMBER_UNIHUB_PROXY_URL + '/media/' + operation,{method:'POST',headers:{authorization:`Bearer ${child.OPENCHAMBER_UNIHUB_PROXY_TOKEN}`,'content-type':'application/json'},body:JSON.stringify(input)});
  await grantStarted; idle = Date.now(); release();
  const response = await pending;
  expect(response.status).toBe(403);
  expect(gatewayRequests).toBe(0);
});

it('reconciles a cancelled client request by its original call ID without redispatch', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'image-edit-cancel-')); cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  let received, reply, submits = 0, state = 'reserved';
  const submitted = new Promise(resolve => { received = resolve; });
  const allowResponse = new Promise(resolve => { reply = resolve; });
  const png = Buffer.from('89504e470d0a1a0a','hex').toString('base64');
  const gateway = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain before recording dispatch */ }
    if (req.method === 'POST') { submits++; received(); await allowResponse; res.writeHead(202, {'content-type':'application/json'}); return res.end(JSON.stringify({id:'edit_cancel',status:'pending'})); }
    res.setHeader('content-type','application/json');
    if (req.url === '/platform/v1/calls/edit_cancel') return res.end(JSON.stringify({call_id:'edit_cancel',status:state === 'settled' ? 'SETTLED' : 'UNKNOWN'}));
    if (req.url === '/platform/v1/images/edits/edit_cancel') { if (state === 'settled') return res.end(JSON.stringify({data:[{b64_json:png}]})); res.writeHead(202); return res.end(JSON.stringify({id:'edit_cancel',status:'pending'})); }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => gateway.listen(0, '127.0.0.1', resolve)); cleanups.push(() => new Promise(resolve => { gateway.closeAllConnections(); gateway.close(resolve); }));
  const env = {OPENCHAMBER_UNIHUB_GATEWAY_URL:`http://127.0.0.1:${gateway.address().port}/platform/v1`,OPENCHAMBER_UNIHUB_MODELS:JSON.stringify([{id:'agent',name:'Agent',context:8192,maxOutput:100}]),OPENCHAMBER_UNIHUB_MEDIA_MODELS:JSON.stringify(['wanx2.1-imageedit'])};
  const identity = {type:'client',token:'edit-owner'};
  const account = {actor:()=>({actingUserId:'alice',billingAccountId:'personal',authSession:'login-fixture'}),request:async (_identity,_target,init)=>{const body=JSON.parse(init.body);return {token:'fixture-grant',actor_id:'alice',account_id:'personal',task_id:body.task_id,origin_product_id:'superwagie',models:body.models,expires_at:new Date(Date.now()+600000).toISOString()};}};
  const runtime = await createPlatformModelRuntime({dataDir:dir,instanceDir:path.join(dir,'run'),env,getAccountRuntime:()=>account,readExecution:async()=>({promptID:'msg_test',idle:null,model:{providerID:'unihub',id:'agent'}}),isManaged:()=>true,enterprise:()=>false}); cleanups.push(()=>runtime.close());
  await runtime.materializePlugin(); await runtime.admit(identity,{id:'ses_edit',model:{providerID:'unihub',id:'agent'}},'msg_test');
  const child=runtime.createChildEnv(), headers={authorization:`Bearer ${child.OPENCHAMBER_UNIHUB_PROXY_TOKEN}`,'content-type':'application/json'}, image=`data:image/png;base64,${png}`, abort=new AbortController();
  const pending=fetch(child.OPENCHAMBER_UNIHUB_PROXY_URL+'/media/image-edit',{method:'POST',headers,signal:abort.signal,body:JSON.stringify({sessionID:'ses_edit',callID:'edit_cancel',model:'wanx2.1-imageedit',prompt:'replace',images:[image],mask:image})});
  await submitted; abort.abort(); await expect(pending).rejects.toMatchObject({name:'AbortError'}); reply();
  const read = () => fetch(child.OPENCHAMBER_UNIHUB_PROXY_URL+'/media/image-edit/status',{method:'POST',headers,body:JSON.stringify({sessionID:'ses_edit',callID:'edit_cancel'})});
  const waiting = await read(); expect(await waiting.json()).toMatchObject({callID:'edit_cancel',status:'pending'});
  state = 'settled'; const complete = await read(); expect(await complete.json()).toMatchObject({callID:'edit_cancel',status:'succeeded',settlement:'SETTLED'});
  expect(submits).toBe(1);
});
