import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createPlatformModelRuntime } from '../platform-model/runtime.js';
import { readConfiguredVideoFromDisk } from './resolve-cli.js';
import { managedVideoStatus } from '../../builtin-skills/supervideo-engine/src/providers/managed-video.mjs';
import { createProject } from '../../builtin-skills/supervideo-engine/src/core/store.mjs';
import { fileURLToPath } from 'node:url';

const cleanups=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse()) await cleanup();});
it('preserves a real managed broker refusal without disclosing its credentials', async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'model-scope-'));cleanups.push(()=>fs.rm(dir,{recursive:true,force:true}));
  let payer='personal';const identity={type:'client',token:'fixture-owner'};
  const account={actor:()=>({actingUserId:'alice',billingAccountId:payer,authSession:'login-fixture'}),request:async(_identity,target,init)=>{const body=JSON.parse(init.body);return {token:'private-grant',actor_id:'alice',account_id:target.split('/')[3],task_id:body.task_id,origin_product_id:'superwagie',models:body.models,expires_at:new Date(Date.now()+600000).toISOString()};}};
  const env={OPENCHAMBER_UNIHUB_GATEWAY_URL:'http://127.0.0.1:1/platform/v1',OPENCHAMBER_UNIHUB_MODELS:JSON.stringify([{id:'agent',name:'Agent',context:8192,maxOutput:100}]),OPENCHAMBER_UNIHUB_MEDIA_MODELS:JSON.stringify(['wan2.6-t2v'])};
  const runtime=await createPlatformModelRuntime({dataDir:dir,instanceDir:path.join(dir,'run'),env,getAccountRuntime:()=>account,readExecution:async()=>({promptID:'msg_test',idle:null,model:{providerID:'unihub',id:'agent'}}),isManaged:()=>true,enterprise:()=>false});cleanups.push(()=>runtime.close());
  await runtime.materializePlugin();await runtime.admit(identity,{id:'ses_1',model:{providerID:'unihub',id:'agent'}},'msg_test');payer='other';
  const environment=runtime.createChildEnv();
  await expect(readConfiguredVideoFromDisk({sessionID:'ses_1',callID:'video_1'},{environment})).rejects.toMatchObject({code:'platform_model_scope_restart_required'});
  const project=path.join(dir,'project'); await createProject(project,{mode:'book',output:{width:1280,height:720,fps:30}});
  await fs.mkdir(path.join(project,'media','managed-video'),{recursive:true});
  await fs.writeFile(path.join(project,'media','managed-video','video_1.json'),JSON.stringify({version:1,callID:'video_1',state:'DISPATCHED',model:'wan2.6-t2v',sessionID:'ses_1'}));
  const keys=['SUPERWAGIE_MODEL_RESOLVER','SUPERWAGIE_MODEL_NODE','OPENCHAMBER_UNIHUB_PROXY_URL','OPENCHAMBER_UNIHUB_PROXY_TOKEN'];
  const old=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  Object.assign(process.env,environment,{SUPERWAGIE_MODEL_NODE:process.execPath,SUPERWAGIE_MODEL_RESOLVER:fileURLToPath(new URL('./resolve-cli.js',import.meta.url))});
  try {await expect(managedVideoStatus(project,{callID:'video_1'})).rejects.toMatchObject({code:'PLATFORM_MODEL_SCOPE_RESTART_REQUIRED',message:expect.stringContaining('Restart SuperWagie')});}
  finally {for(const key of keys){if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key];}}

});
