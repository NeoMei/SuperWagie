import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createPlatformModelRuntime } from './runtime.js';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

for (const operation of ['video', 'image-edit']) it(`recovers ${operation} after a lost response and restart without another submission`, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-recover-'));
  cleanups.push(() => fs.rm(dir, {recursive:true,force:true}));
  const model = operation === 'video' ? 'wan2.6-t2v' : 'wanx2.1-imageedit';
  const callID = operation === 'video' ? 'video_recover' : 'edit_recover';
  let submits = 0, taskID;
  const gateway = http.createServer(async (req, res) => {
    for await (const _ of req) { /* consume request before simulating response loss */ }
    if (req.headers.authorization !== `Bearer grant-${model}` || !req.headers['x-unihub-task-id']) {res.writeHead(403); return res.end();}
    if (req.method === 'POST') {submits++; taskID=req.headers['x-unihub-task-id']; req.socket.destroy(); return;}
    if (taskID !== req.headers['x-unihub-task-id']) {res.writeHead(403); return res.end();}
    res.setHeader('content-type','application/json');
    if (req.url === `/platform/v1/calls/${callID}`) return res.end(JSON.stringify({call_id:callID,status:'UNKNOWN'}));
    if (operation === 'video' && req.url === `/platform/v1/videos/${callID}`) return res.end(JSON.stringify({id:callID,task_id:'provider-task',status:'QUEUED'}));
    if (operation === 'image-edit' && req.url === `/platform/v1/images/edits/${callID}`) {res.writeHead(202); return res.end(JSON.stringify({id:callID,status:'pending'}));}
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => gateway.listen(0,'127.0.0.1',resolve));
  cleanups.push(() => new Promise(resolve => {gateway.closeAllConnections(); gateway.close(resolve);}));
  const env = {OPENCHAMBER_UNIHUB_GATEWAY_URL:`http://127.0.0.1:${gateway.address().port}/platform/v1`,OPENCHAMBER_UNIHUB_MODELS:JSON.stringify([{id:'agent',name:'Agent',context:8192,maxOutput:100}]),OPENCHAMBER_UNIHUB_MEDIA_MODELS:JSON.stringify([model])};
  const identity={type:'client',token:'owner'};
  const account={actor:()=>({actingUserId:'alice',billingAccountId:'personal',authSession:'login-fixture'}),request:async (_identity,target,init)=>{const body=JSON.parse(init.body);return {token:`grant-${body.models[0]}`,actor_id:'alice',account_id:target.split('/')[3],task_id:body.task_id,origin_product_id:'superwagie',models:body.models,expires_at:new Date(Date.now()+600000).toISOString()};}};
  const create = async () => {const runtime=await createPlatformModelRuntime({dataDir:dir,instanceDir:path.join(dir,'run'),env,getAccountRuntime:()=>account,readExecution:async()=>({promptID:'msg_test',idle:null,model:{providerID:'unihub',id:'agent'}}),isManaged:()=>true,enterprise:()=>false});await runtime.materializePlugin();return runtime;};
  let runtime=await create(); cleanups.push(()=>runtime.close());
  const session={id:'ses_original',model:{providerID:'unihub',id:'agent'}};
  await runtime.admit(identity,session,'msg_test');
  const call=(route,body)=>{const child=runtime.createChildEnv();return fetch(child.OPENCHAMBER_UNIHUB_PROXY_URL+route,{method:'POST',headers:{authorization:`Bearer ${child.OPENCHAMBER_UNIHUB_PROXY_TOKEN}`,'content-type':'application/json'},body:JSON.stringify(body)});};
  const selection=await call('/media/session',{}); expect(await selection.json()).toEqual({sessionID:'ses_original'});
  const png=`data:image/png;base64,${Buffer.from('89504e470d0a1a0a','hex').toString('base64')}`;
  const body=operation === 'video' ? {sessionID:'ses_original',callID,model,prompt:'cat',seconds:5,size:'1280*720'} : {sessionID:'ses_original',callID,model,prompt:'edit',images:[png],mask:png};
  expect((await call(`/media/${operation}`,body)).status).not.toBe(200);
  await runtime.close(); runtime=await create();
  await expect(runtime.admit(identity,session,'msg_test')).rejects.toMatchObject({code:'platform_reconciliation_required'});
  const recovered=await call(`/media/${operation}/status`,{sessionID:'ses_original',callID});
  expect(recovered.status).toBe(200);
  expect(await recovered.json()).toMatchObject({callID,status:operation === 'video' ? 'QUEUED' : 'pending'});
  expect((await call(`/media/${operation}/status`,{sessionID:'ses_other',callID})).status).toBe(401);
  expect(submits).toBe(1);
});
