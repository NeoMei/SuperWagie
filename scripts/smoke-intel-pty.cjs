const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
assert.equal(process.arch,'x64');assert.equal(process.versions.electron,'43.8.4');assert.equal(process.versions.modules,'148');
delete process.env.ELECTRON_RUN_AS_NODE;
// Read the physical ASAR bytes before extracting this isolated test module.
process.noAsar=true;
const app=process.argv[2];
assert(app, 'Usage: Electron scripts/smoke-intel-pty.cjs /path/犇马.app');
const archive=path.join(app,'Contents/Resources/app.asar');
const bytes=fs.readFileSync(archive);
const start=8+bytes.readUInt32LE(4);
const header=JSON.parse(bytes.subarray(16,16+bytes.readUInt32LE(12)));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'superwagie-intel-pty-proof-'));
const prefix='node_modules/node-pty';
const rows=[];
function walk(node,relative=''){
 for(const [name,entry] of Object.entries(node.files)){
  assert(name!=='.'&&name!=='..'&&!name.includes('/')&&!name.includes('\\'));
  const file=relative?relative+'/'+name:name;
  if(entry.files)walk(entry,file);else if(file.startsWith(prefix+'/'))rows.push({file,entry});
 }
}
walk(header);
let terminal;
let exited=false;
let timer;
let exitPromise;
async function main(){
 try{
  assert(rows.length>0,'Packaged node-pty JS absent');
  for(const {file,entry} of rows){
   assert(!entry.link,'Unexpected node-pty archive link');
   const target=path.join(root,file.slice(prefix.length+1));
   fs.mkdirSync(path.dirname(target),{recursive:true});
   if(entry.unpacked)fs.copyFileSync(path.join(archive+'.unpacked',file),target);
   else {const offset=Number(entry.offset);assert(Number.isSafeInteger(offset)&&offset>=0&&start+offset+entry.size<=bytes.length);fs.writeFileSync(target,bytes.subarray(start+offset,start+offset+entry.size));}
  }
  const helper=path.join(root,'build/Release/spawn-helper');if(fs.existsSync(helper))fs.chmodSync(helper,0o755);
  for(const dir of ['prebuilds/darwin-x64','bin']){const file=path.join(root,dir,'spawn-helper');if(fs.existsSync(file))fs.chmodSync(file,0o755);}
  const pty=require(path.join(root,'lib/index.js'));
  terminal=pty.spawn('/bin/sh',['-c','printf NATIVE_INTEL_PTY_OK'],{name:'xterm-256color',cols:80,rows:24,cwd:root,env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'}});
  exitPromise=new Promise(resolve=>terminal.onExit(event=>{exited=true;resolve(event);}));
  let output='';terminal.onData(data=>{output+=data;});
  const exit=await Promise.race([exitPromise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('PTY did not exit')),10000);})]);
  assert.equal(exit.exitCode,0);assert(output.includes('NATIVE_INTEL_PTY_OK'));
  console.log(JSON.stringify({passed:true,architecture:process.arch,electron:process.versions.electron,node:process.versions.node,abi:process.versions.modules,packageFiles:rows.length,shellExecuted:true}));
 }finally{
  clearTimeout(timer);
  if(terminal&&!exited){
   for(const signal of ['SIGTERM','SIGKILL']){
    if(exited)break;
    try{terminal.kill(signal);}catch(error){if(error.code!=='ESRCH')throw error;}
    let deadline;await Promise.race([exitPromise,new Promise(resolve=>{deadline=setTimeout(resolve,2000);})]);clearTimeout(deadline);
   }
   assert(exited,'The owned PTY child did not exit after cleanup');
  }
  fs.rmSync(root,{recursive:true,force:true});
 }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
