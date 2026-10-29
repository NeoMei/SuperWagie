import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import sharp from 'sharp';
import { submit, status } from '../../builtin-skills/skills/managed-image-edit/scripts/edit.mjs';
const cleanups = [];
const png = async (width = 512, height = 512, alpha = 0) => sharp({create:{width,height,channels:4,background:{r:255,g:0,b:0,alpha}}}).png().toBuffer();
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); delete process.env.SUPERWAGIE_MODEL_RESOLVER; });
it('persists a stable edit, resumes polling without resubmitting, and imports verified bytes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'managed-edit-')); cleanups.push(()=>fs.rm(root,{recursive:true,force:true}));
  const pixels=Buffer.alloc(512*512*4,255); for (let i=3;i<pixels.length;i+=8) pixels[i]=0;
  const bytes = await sharp(pixels,{raw:{width:512,height:512,channels:4}}).png().toBuffer(); const source = path.join(root,'source.png'); await fs.writeFile(source,bytes);
  process.env.SUPERWAGIE_MODEL_RESOLVER='fixture'; let submits=0; let success=false;
  const runner = async (_exe,args,input) => {const value=JSON.parse(input); if (args[1] === '--media-session') return {code:0,stdout:JSON.stringify({sessionID:'ses_edit'})}; if (args[1] === '--edit-image') {submits++; return {code:0,stdout:JSON.stringify({callID:value.callID,sessionID:'ses_edit',status:'pending'})};} return {code:0,stdout:JSON.stringify(success ? {callID:value.callID,status:'succeeded',settlement:'SETTLED',images:[{data:bytes.toString('base64'),mimeType:'image/png'}]} : {callID:value.callID,status:'pending'})};};
  const saved = await submit(path.join(root,'records'),{imagePath:source,maskPath:source,prompt:'edit',model:'wanx2.1-imageedit'},{runner});
  expect(saved.status).toBe('pending'); expect(await status(path.join(root,'records'),{callID:saved.callID},{runner})).toEqual({callID:saved.callID,status:'pending'});
  success=true; const result = await status(path.join(root,'records'),{callID:saved.callID},{runner}); expect(await fs.readFile(result.path)).toEqual(bytes); expect((await status(path.join(root,'records'),{callID:saved.callID},{runner})).path).toBe(result.path); expect(submits).toBe(1);
});
it('retains a recoverable call ID when submission outcome is unknown', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'managed-edit-')); cleanups.push(()=>fs.rm(root,{recursive:true,force:true})); const source=path.join(root,'source.png'); await fs.writeFile(source,await png()); process.env.SUPERWAGIE_MODEL_RESOLVER='fixture';
  let failure; try {await submit(path.join(root,'records'),{imagePath:source,maskPath:source,prompt:'edit',model:'wanx2.1-imageedit'},{runner:async(_exe,args)=>args[1] === '--media-session' ? ({code:0,stdout:JSON.stringify({sessionID:'ses_edit'})}) : ({code:1,stdout:''})});} catch(error) {failure=error;}
  expect(failure.code).toBe('UNRESOLVED'); expect(failure.callID).toMatch(/^edit_/); const record=JSON.parse(await fs.readFile(path.join(root,'records',`${failure.callID}.json`),'utf8')); expect(record.state).toBe('DISPATCHED');
});

it('persists the selected session before a lost edit response and uses it for recovery', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'managed-edit-recovery-')); cleanups.push(()=>fs.rm(root,{recursive:true,force:true}));
  const source=path.join(root,'source.png'); await fs.writeFile(source,await png()); process.env.SUPERWAGIE_MODEL_RESOLVER='fixture';
  let submissions=0, callID;
  const runner=async (_exe,args,input) => {
    const value=JSON.parse(input);
    if (args[1] === '--media-session') return {code:0,stdout:JSON.stringify({sessionID:'ses_original'})};
    if (args[1] === '--edit-image') {submissions++;callID=value.callID;expect(value.sessionID).toBe('ses_original');const record=JSON.parse(await fs.readFile(path.join(root,'records',`${callID}.json`),'utf8'));expect(record).toMatchObject({state:'DISPATCHED',sessionID:'ses_original'});return {code:1,stdout:''};}
    expect(args[1]).toBe('--image-edit-status'); expect(value.sessionID).toBe('ses_original');
    return {code:0,stdout:JSON.stringify({callID:value.callID,status:'pending'})};
  };
  await expect(submit(path.join(root,'records'),{imagePath:source,maskPath:source,prompt:'edit',model:'wanx2.1-imageedit'},{runner})).rejects.toMatchObject({code:'UNRESOLVED'});
  expect(await status(path.join(root,'records'),{callID},{runner})).toEqual({callID,status:'pending'});
  await expect(status(path.join(root,'records'),{callID,sessionID:'ses_attacker'},{runner})).rejects.toMatchObject({code:'INVALID_CALL'});
  expect(submissions).toBe(1);
});

it('rejects invalid masks and mismatched PNG dimensions before session admission', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'managed-edit-mask-')); cleanups.push(()=>fs.rm(root,{recursive:true,force:true}));
  const source=path.join(root,'source.png'), mask=path.join(root,'mask.png'); await fs.writeFile(source,await png());
  process.env.SUPERWAGIE_MODEL_RESOLVER='fixture'; let calls=0;
  const runner=async()=>{calls++;return {code:1,stdout:''}};
  const request={imagePath:source,maskPath:mask,prompt:'edit',model:'wanx2.1-imageedit'};
  await fs.writeFile(mask,await sharp({create:{width:512,height:512,channels:3,background:'white'}}).jpeg().toBuffer());
  await expect(submit(path.join(root,'records'),request,{runner})).rejects.toMatchObject({code:'INVALID_MASK',message:expect.stringMatching(/PNG.*transparent.*opaque.*semi-transparent/i)});
  const cli=spawnSync(process.execPath,[fileURLToPath(new URL('../../builtin-skills/skills/managed-image-edit/scripts/edit.mjs',import.meta.url)),'submit',path.join(root,'cli-records')],{input:JSON.stringify(request),encoding:'utf8'});
  expect(cli.status).toBe(1); expect(JSON.parse(cli.stderr)).toMatchObject({code:'INVALID_MASK',message:expect.stringMatching(/PNG.*transparent.*opaque.*semi-transparent/i)});
  await fs.writeFile(mask,await png(512,513));
  await expect(submit(path.join(root,'records'),request,{runner})).rejects.toMatchObject({code:'INVALID_MASK',message:expect.stringMatching(/dimensions/i)});
  await fs.writeFile(mask,await png(512,512,0.5));
  await expect(submit(path.join(root,'records'),request,{runner})).rejects.toMatchObject({code:'INVALID_MASK',message:expect.stringMatching(/semi-transparent/i)});
  expect(calls).toBe(0);
});

it('surfaces the restart action from the managed session resolver without exposing stderr', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'managed-edit-scope-'));cleanups.push(()=>fs.rm(root,{recursive:true,force:true}));
  const source=path.join(root,'source.png'), mask=path.join(root,'mask.png'); await fs.writeFile(source,await png(512,512,1));
  await fs.writeFile(mask,await png(512,512,0));
  process.env.SUPERWAGIE_MODEL_RESOLVER='/fixture/resolver';
  await expect(submit(path.join(root,'records'),{imagePath:source,maskPath:mask,prompt:'edit',model:'wanx2.1-imageedit'},{runner:async()=>({code:1,stdout:'',stderr:'platform_model_scope_restart_required'})})).rejects.toMatchObject({code:'PLATFORM_MODEL_SCOPE_RESTART_REQUIRED',message:expect.stringContaining('Restart SuperWagie')});
});
