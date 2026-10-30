import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createWorkflowRunStore } from './store.js';

const dirs = [];
afterEach(async () => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) await fs.rm(dir, {recursive: true, force: true}); });
const run = (state = 'completed') => ({version:1,id:'wf_12345678',parentSessionId:'ses_parent',directory:'/project',name:'test',description:'',phases:[],script:'',state,attempt:1,createdAt:1,currentPhase:null,agents:[],logs:[]});
const setup = async (fsPromises=fs) => {const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'workflow-store-'));dirs.push(dataDir);return {dataDir,store:createWorkflowRunStore({fsPromises,path,dataDir})};};

it('saves concurrently from separate stores without sharing a temporary file', async () => {
  const paths=[];
  const io={...fs,writeFile:async (file,...args)=>{paths.push(file);return fs.writeFile(file,...args);}};
  const {dataDir,store:first}=await setup(io); const second=createWorkflowRunStore({fsPromises:io,path,dataDir});
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  const a=run(); a.description='first'; const b=run(); b.description='second';
  await Promise.all([first.save(a),second.save(b)]);
  expect(paths).toHaveLength(2); expect(new Set(paths).size).toBe(2); expect(warn).not.toHaveBeenCalled();
  expect(['first','second']).toContain(JSON.parse(await fs.readFile(path.join(dataDir,'workflow-runs',`${a.id}.json`),'utf8')).description);
  expect((await fs.readdir(path.join(dataDir,'workflow-runs'))).filter(name=>name.endsWith('.tmp'))).toEqual([]);
});

it('does not recreate a removed run when a stale asynchronous save arrives', async () => {
  const {dataDir,store}=await setup(); const value=run(); await store.save(value);
  const removing=store.remove(value.id); const saving=store.save(value); await Promise.all([removing,saving]);
  expect(await store.get(value.id)).toBeNull();
  const restarted=createWorkflowRunStore({fsPromises:fs,path,dataDir}); expect(await restarted.get(value.id)).toBeNull();
});

it('does not resurrect a run from a second store after deletion', async () => {
  const {dataDir,store:first}=await setup(); const value=run(); await first.save(value);
  const second=createWorkflowRunStore({fsPromises:fs,path,dataDir}); expect(await second.get(value.id)).not.toBeNull();
  await first.remove(value.id); await second.save(value);
  expect(await second.get(value.id)).toBeNull();
  const restarted=createWorkflowRunStore({fsPromises:fs,path,dataDir}); expect(await restarted.get(value.id)).toBeNull();
});

it('restores a run when its file cannot be deleted', async () => {
  let fail = false;
  const io={...fs, rm:async (file, options)=>{if(fail && file.endsWith('.json')) throw Object.assign(new Error('denied'),{code:'EACCES'});return fs.rm(file,options);}};
  const {store}=await setup(io); const value=run(); await store.save(value); fail=true;
  vi.spyOn(console,'warn').mockImplementation(()=>{});
  await expect(store.remove(value.id)).rejects.toMatchObject({code:'EACCES'});
  expect(await store.get(value.id)).toEqual(value); fail=false;
  value.description='retained'; await store.save(value); expect((await store.get(value.id)).description).toBe('retained');
});

it('persists concurrent updates when deletion fails and still rejects the deletion', async () => {
  const entered=Promise.withResolvers(), finish=Promise.withResolvers();
  const io={...fs,rm:async (file,options)=>{if(file.endsWith('.json')){entered.resolve();await finish.promise;throw Object.assign(new Error('denied'),{code:'EACCES'});}return fs.rm(file,options);}};
  const {dataDir,store}=await setup(io), value=run(); await store.save(value);
  vi.spyOn(console,'warn').mockImplementation(()=>{});
  const removal=store.remove(value.id); const result=removal.catch(error=>error); await entered.promise;
  const updated={...value,description:'latest after deletion started'}; const save=store.save(updated);
  finish.resolve(); expect(await result).toMatchObject({code:'EACCES'}); await save; await store.flush();
  expect((await store.get(value.id)).description).toBe(updated.description);
  expect(JSON.parse(await fs.readFile(path.join(dataDir,'workflow-runs',`${value.id}.json`),'utf8')).description).toBe(updated.description);
});

it('keeps a previously queued save when the subsequent deletion fails', async () => {
  const entered=Promise.withResolvers(), finish=Promise.withResolvers(); let hold=false;
  const io={...fs,writeFile:async(file,...args)=>{if(hold){entered.resolve();await finish.promise;}return fs.writeFile(file,...args);},rm:async(file,options)=>{if(file.endsWith('.json'))throw Object.assign(new Error('denied'),{code:'EACCES'});return fs.rm(file,options);}};
  const {dataDir,store}=await setup(io), value=run(); await store.save(value); hold=true;
  vi.spyOn(console,'warn').mockImplementation(()=>{});
  const updated={...value,description:'queued update'}; const saving=store.save(updated); await entered.promise;
  const removal=store.remove(value.id); const result=removal.catch(error=>error); finish.resolve(); await saving;
  expect(await result).toMatchObject({code:'EACCES'});
  expect(JSON.parse(await fs.readFile(path.join(dataDir,'workflow-runs',`${value.id}.json`),'utf8')).description).toBe(updated.description);
});

it('removes the in-memory run after a previously queued save completes', async () => {
  const entered=Promise.withResolvers(), finish=Promise.withResolvers(); let hold=false;
  const io={...fs,writeFile:async(file,...args)=>{if(hold){entered.resolve();await finish.promise;}return fs.writeFile(file,...args);}};
  const {dataDir,store}=await setup(io), value=run(); await store.save(value); hold=true;
  const saving=store.save({...value,description:'queued update'}); await entered.promise;
  const removing=store.remove(value.id); await Promise.resolve(); finish.resolve();
  await saving; expect(await removing).toBe(true); await store.flush();
  expect(await store.get(value.id)).toBeNull();
  await expect(fs.stat(path.join(dataDir,'workflow-runs',`${value.id}.json`))).rejects.toMatchObject({code:'ENOENT'});
});

it('does not resurrect a run saved while successful deletion is in flight', async () => {
  const entered=Promise.withResolvers(), finish=Promise.withResolvers();
  const io={...fs,rm:async (file,options)=>{if(file.endsWith('.json')){entered.resolve();await finish.promise;}return fs.rm(file,options);}};
  const {dataDir,store}=await setup(io), value=run(); await store.save(value);
  const removal=store.remove(value.id); await entered.promise;
  const save=store.save({...value,description:'stale update'}); finish.resolve();
  expect(await removal).toBe(true); await save; await store.flush();
  expect(await store.get(value.id)).toBeNull();
  await expect(fs.stat(path.join(dataDir,'workflow-runs',`${value.id}.json`))).rejects.toMatchObject({code:'ENOENT'});
});

it('rejects a failed save and permits a later save to succeed', async () => {
  let failWrite=false;
  const io={...fs,writeFile:async(file,...args)=>{if(failWrite) throw Object.assign(new Error('disk full'),{code:'ENOSPC'});return fs.writeFile(file,...args);}};
  const {dataDir,store}=await setup(io), value=run(); await store.save(value); vi.spyOn(console,'warn').mockImplementation(()=>{});
  failWrite=true; await expect(store.save({...value,description:'unsaved'})).rejects.toMatchObject({code:'ENOSPC'});
  failWrite=false; await store.save({...value,description:'recovered'});
  expect(JSON.parse(await fs.readFile(path.join(dataDir,'workflow-runs',`${value.id}.json`),'utf8')).description).toBe('recovered');
});

it('does not expose a newly proposed run when its first save fails', async () => {
  let fail=true;
  const io={...fs,writeFile:async(file,...args)=>{if(fail)throw Object.assign(new Error('disk full'),{code:'ENOSPC'});return fs.writeFile(file,...args);}};
  const {store}=await setup(io), value=run('awaiting-approval'); vi.spyOn(console,'warn').mockImplementation(()=>{});
  await expect(store.save(value)).rejects.toMatchObject({code:'ENOSPC'});
  expect(await store.get(value.id)).toBeNull(); expect(await store.list()).toEqual([]);
  fail=false; await store.save(value); expect(await store.get(value.id)).toEqual(value);
});

it('preserves a readable run when a temporary read failure occurs and retries loading', async () => {
  const {dataDir,store}=await setup(); const value=run(); await store.save(value);
  // A separate directory-backed store has not loaded this run yet.
  const otherDir=await fs.mkdtemp(path.join(os.tmpdir(),'workflow-read-error-')); dirs.push(otherDir);
  const folder=path.join(otherDir,'workflow-runs'); await fs.mkdir(folder);
  const original=path.join(dataDir,'workflow-runs',`${value.id}.json`), target=path.join(folder,`${value.id}.json`);
  await fs.copyFile(original,target); let fail=true;
  const io={...fs,readFile:async(file,...args)=>{if(fail && file===target)throw Object.assign(new Error('read unavailable'),{code:'EIO'});return fs.readFile(file,...args);}};
  const loaded=createWorkflowRunStore({fsPromises:io,path,dataDir:otherDir});
  await expect(loaded.load()).rejects.toMatchObject({code:'EIO'});
  expect(await fs.readdir(folder)).toEqual([`${value.id}.json`]);
  fail=false; expect(await loaded.get(value.id)).toMatchObject({id:value.id});
});

it('isolates a file only after reading invalid JSON', async () => {
  const {dataDir,store}=await setup(); const folder=path.join(dataDir,'workflow-runs'); await fs.mkdir(folder); const file=path.join(folder,'wf_12345678.json');
  await fs.writeFile(file,'not-json'); vi.spyOn(console,'warn').mockImplementation(()=>{});
  await store.load(); expect(await store.list()).toEqual([]);
  const files=await fs.readdir(folder); expect(files).toHaveLength(1); expect(files[0]).toMatch(/^wf_12345678\.json\.corrupt-/);
});

it('keeps an old run visible when pruning its file fails', async () => {
  const io={...fs,rm:async(file,options)=>{if(file.endsWith('wf_00000000.json')) throw Object.assign(new Error('denied'),{code:'EACCES'});return fs.rm(file,options);}};
  const {store}=await setup(io);
  for(let n=0;n<=100;n++) {const value=run();value.id=`wf_${String(n).padStart(8,'0')}`;value.createdAt=n;await store.save(value);}
  expect(await store.get('wf_00000000')).not.toBeNull();
});

it('surfaces both removal and concurrent recovery write failures', async () => {
  const entered=Promise.withResolvers(), release=Promise.withResolvers(); let failWrite=false;
  const io={...fs,rm:async(file,opts)=>{if(file.endsWith('.json')){entered.resolve();await release.promise;throw Object.assign(new Error('delete failed'),{code:'EACCES'});}return fs.rm(file,opts);},writeFile:async(file,...args)=>{if(failWrite)throw Object.assign(new Error('disk full'),{code:'ENOSPC'});return fs.writeFile(file,...args);}};
  const {store}=await setup(io), value=run(); await store.save(value); vi.spyOn(console,'warn').mockImplementation(()=>{});
  const removal=store.remove(value.id); const result=removal.catch(error=>error); await entered.promise;
  const saving=store.save({...value,description:'latest'}); const saved=saving.catch(error=>error); failWrite=true; await Promise.resolve(); release.resolve();
  const [removeError,saveError]=await Promise.all([result,saved]);
  expect(saveError).toMatchObject({code:'ENOSPC'});
  expect(removeError).toBeInstanceOf(AggregateError); expect(removeError.errors.map(error=>error.code)).toEqual(['EACCES','ENOSPC']);
});
