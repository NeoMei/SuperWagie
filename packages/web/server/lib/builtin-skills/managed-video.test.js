import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createProject, readProject } from '../../builtin-skills/supervideo-engine/src/core/store.mjs';
import { importManagedVideo, managedVideoStatus, submitManagedVideo } from '../../builtin-skills/supervideo-engine/src/providers/managed-video.mjs';
import { assertRenderProject } from '../../builtin-skills/supervideo-engine/src/render/schema.mjs';

const cleanups = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it('records a stable video call before submission, checks settlement and imports the verified MP4 once', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'supervideo-managed-test-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  await createProject(root, { mode: 'book', output: { width: 1280, height: 720, fps: 30 } });
  const before = process.env.SUPERWAGIE_MODEL_RESOLVER;
  process.env.SUPERWAGIE_MODEL_RESOLVER = '/fixture/resolver';
  cleanups.push(() => { if (before === undefined) delete process.env.SUPERWAGIE_MODEL_RESOLVER; else process.env.SUPERWAGIE_MODEL_RESOLVER = before; });
  const bytes = Buffer.from('000000186674797069736f6d0000020069736f6d69736f32', 'hex');
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const requests = [];
  const runner = async (_node, [_, action], options) => {
    const input = JSON.parse(options.input); requests.push({ action, input });
    if (action === '--media-session') return { code: 0, stdout: JSON.stringify({ sessionID: 'ses_example' }) };
    if (action === '--generate-video') {
      expect(JSON.parse(await fs.readFile(path.join(root, 'media/managed-video/video_example.json'), 'utf8'))).toMatchObject({ callID: 'video_example', state: 'DISPATCHED' });
      return { code: 0, stdout: JSON.stringify({ callID: input.callID, sessionID: 'ses_example' }) };
    }
    if (action === '--video-status') return { code: 0, stdout: JSON.stringify({ callID: input.callID, status: 'SUCCESS', settlement: 'SETTLED' }) };
    return { code: 0, stdout: JSON.stringify({ video: bytes.toString('base64'), contentType: 'video/mp4', sha256 }) };
  };
  const input = { callID: 'video_example', model: 'wan2.6-t2v', prompt: 'orange cat', seconds: 5, size: '1280*720' };
  expect(await submitManagedVideo(root, input, { runner })).toEqual({ callID: input.callID, sessionID: 'ses_example', status: 'SUBMITTED' });
  await expect(submitManagedVideo(root, input, { runner })).rejects.toMatchObject({ code: 'MANAGED_VIDEO_CALL_EXISTS' });
  expect(await managedVideoStatus(root, input, { runner })).toEqual({ callID: input.callID, status: 'SUCCESS', settlement: 'SETTLED' });
  const asset = await importManagedVideo(root, input, { runner });
  expect(asset).toMatchObject({ mediaType: 'video/mp4', sha256, origin: { kind: 'provider', reference: 'UniHub/video_example', version: 'wan2.6-t2v' } });
  expect(await fs.readFile(path.join(root, asset.path))).toEqual(bytes);
  expect((await readProject(root)).assets).toContainEqual(asset);
  const project = await readProject(root);
  project.scenes = [{ id: 'scene-1', cues: [], visual: { kind: 'video', assetIds: [asset.id], props: {} } }];
  expect(() => assertRenderProject(project)).not.toThrow();
  project.scenes[0].visual.assetIds = [];
  expect(() => assertRenderProject(project)).toThrow(/registered MP4/);
  expect(requests.map(entry => entry.action)).toEqual(['--media-session', '--generate-video', '--media-session', '--video-status', '--video-status', '--video-result']);
});

it('records the selected session before a lost submit response and uses it for recovery', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'supervideo-recovery-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  await createProject(root, { mode: 'book', output: { width: 1280, height: 720, fps: 30 } });
  const before = process.env.SUPERWAGIE_MODEL_RESOLVER; process.env.SUPERWAGIE_MODEL_RESOLVER = '/fixture/resolver';
  cleanups.push(() => { if (before === undefined) delete process.env.SUPERWAGIE_MODEL_RESOLVER; else process.env.SUPERWAGIE_MODEL_RESOLVER = before; });
  let submissions = 0;
  const runner = async (_node, [_, action], options) => {
    const input = JSON.parse(options.input);
    if (action === '--media-session') return {code:0, stdout:JSON.stringify({sessionID:'ses_original'})};
    if (action === '--generate-video') {
      submissions++;
      expect(input.sessionID).toBe('ses_original');
      expect(JSON.parse(await fs.readFile(path.join(root,'media/managed-video/video_lost.json'),'utf8'))).toMatchObject({sessionID:'ses_original',state:'DISPATCHED'});
      return {code:1, stdout:''};
    }
    expect(action).toBe('--video-status'); expect(input.sessionID).toBe('ses_original');
    return {code:0,stdout:JSON.stringify({callID:input.callID,status:'SUCCESS',settlement:'SETTLED'})};
  };
  const request = {callID:'video_lost',model:'wan2.6-t2v',prompt:'cat',seconds:5,size:'1280*720'};
  await expect(submitManagedVideo(root,request,{runner})).rejects.toMatchObject({code:'MANAGED_VIDEO_UNRESOLVED'});
  expect(await managedVideoStatus(root,{callID:request.callID},{runner})).toMatchObject({status:'SUCCESS',settlement:'SETTLED'});
  await expect(managedVideoStatus(root,{callID:request.callID,sessionID:'ses_attacker'},{runner})).rejects.toMatchObject({code:'INVALID_VIDEO_CALL'});
  expect(submissions).toBe(1);
});

it('reports account change when the media session helper rejects the request', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'supervideo-scope-'));
  cleanups.push(() => fs.rm(root,{recursive:true,force:true}));
  await createProject(root,{mode:'book',output:{width:1280,height:720,fps:30}});
  const before=process.env.SUPERWAGIE_MODEL_RESOLVER;process.env.SUPERWAGIE_MODEL_RESOLVER='/fixture/resolver';
  cleanups.push(()=>{if(before===undefined)delete process.env.SUPERWAGIE_MODEL_RESOLVER;else process.env.SUPERWAGIE_MODEL_RESOLVER=before;});
  await expect(submitManagedVideo(root,{model:'wan2.6-t2v',prompt:'cat',seconds:5,size:'1280*720'}, {runner:async()=>({code:1,stderr:'platform_model_scope_restart_required',stdout:''})})).rejects.toMatchObject({code:'PLATFORM_MODEL_SCOPE_RESTART_REQUIRED',message:expect.stringContaining('Restart SuperWagie')});
});

it('keeps the original call ID visible when a submit ends with a scope refusal', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'supervideo-scope-submit-'));cleanups.push(()=>fs.rm(root,{recursive:true,force:true}));
  await createProject(root,{mode:'book',output:{width:1280,height:720,fps:30}});
  const before=process.env.SUPERWAGIE_MODEL_RESOLVER;process.env.SUPERWAGIE_MODEL_RESOLVER='/fixture/resolver';cleanups.push(()=>{if(before===undefined)delete process.env.SUPERWAGIE_MODEL_RESOLVER;else process.env.SUPERWAGIE_MODEL_RESOLVER=before;});
  const runner=async(_node,[_,action])=>action==='--media-session'?{code:0,stdout:JSON.stringify({sessionID:'ses_1'})}:{code:1,stderr:'platform_model_scope_restart_required',stdout:''};
  await expect(submitManagedVideo(root,{callID:'video_uncertain',model:'wan2.6-t2v',prompt:'cat',seconds:5,size:'1280*720'},{runner})).rejects.toMatchObject({code:'PLATFORM_MODEL_SCOPE_RESTART_REQUIRED',message:expect.stringContaining('video_uncertain')});
  expect(JSON.parse(await fs.readFile(path.join(root,'media/managed-video/video_uncertain.json'),'utf8'))).toMatchObject({state:'DISPATCHED',sessionID:'ses_1'});
});
