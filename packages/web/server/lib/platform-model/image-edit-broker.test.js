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
  await runtime.close(); runtime = await create();
  await expect(runtime.admit(identity,{id:'ses_edit',model:{providerID:'unihub',id:'agent'}},'msg_test')).resolves.toBe(true);
  state='success'; const complete = await call('/media/image-edit/status',{sessionID:'ses_edit',callID:'edit_test'}); expect(await complete.json()).toEqual({callID:'edit_test',status:'succeeded',settlement:'SETTLED',images:[{data:png,mimeType:'image/png'}]});
  expect(observed[0].body).toContain('filename="mask.png"'); expect(observed[0].body).not.toContain('name="size"'); expect(observed[0].key).toBe('edit_test'); expect(observed.every(row => row.task === observed[0].task)).toBe(true);
});
