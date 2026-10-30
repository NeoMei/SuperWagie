import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, lstat, realpath, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';

const idPattern = /^edit_[0-9a-f-]{36}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message) => Object.assign(new Error(message), {code});
const maskContract = 'Mask must be a PNG with an alpha channel: transparent areas are edited, opaque areas are preserved; semi-transparent pixels are not supported';
function pngDimensions(bytes) {
  if (bytes.length < 33 || !bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) || bytes.readUInt32BE(8) !== 13 || bytes.subarray(12,16).toString('ascii') !== 'IHDR') return null;
  return {width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20)};
}
// Fast preflight for common non-interlaced 8-bit RGBA/gray-alpha PNGs. Other
// valid PNG encodings are left to the gateway's complete decoder.
function validateMask(bytes, sourceBytes) {
  if (bytes.length > 4 * 1024 * 1024) throw fail('INVALID_MASK', `${maskContract}. Mask exceeds the local 4 MiB limit`);
  const dimensions = pngDimensions(bytes);
  if (!dimensions) throw fail('INVALID_MASK', maskContract);
  const {width,height} = dimensions;
  if (width < 512 || width > 4096 || height < 512 || height > 4096) throw fail('INVALID_MASK', `${maskContract}. Mask dimensions must be 512–4096 pixels per side`);
  const source = pngDimensions(sourceBytes);
  if (source && (source.width !== width || source.height !== height)) throw fail('INVALID_MASK', `${maskContract}. Mask dimensions must match the source image`);
  const bitDepth = bytes[24], type = bytes[25], interlace = bytes[28];
  let hasTransparency = type === 4 || type === 6;
  const compressed = [];
  for (let pos = 8; pos + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(pos), end = pos + 12 + length;
    if (end > bytes.length) throw fail('INVALID_MASK', maskContract);
    const name = bytes.subarray(pos+4,pos+8).toString('ascii');
    if (name === 'tRNS' && [0,2,3].includes(type)) hasTransparency = true;
    if (name === 'IDAT') compressed.push(bytes.subarray(pos+8,pos+8+length));
    if (name === 'IEND') break;
    pos = end;
  }
  if (!hasTransparency) throw fail('INVALID_MASK', maskContract);
  if (bitDepth !== 8 || ![4,6].includes(type) || interlace !== 0) return;
  const channels = type === 6 ? 4 : 2, stride = width * channels, length = (stride + 1) * height;
  let raw;
  try { raw = inflateSync(Buffer.concat(compressed), {maxOutputLength:length}); }
  catch { throw fail('INVALID_MASK', maskContract); }
  if (raw.length !== length) throw fail('INVALID_MASK', maskContract);
  let previous = Buffer.alloc(stride);
  for (let y=0; y<height; y++) {
    const start = y * (stride + 1), filter = raw[start], row = Buffer.from(raw.subarray(start+1,start+1+stride));
    if (filter > 4) throw fail('INVALID_MASK', maskContract);
    for (let x=0; x<stride; x++) {
      const a=x>=channels ? row[x-channels] : 0, b=previous[x], c=x>=channels ? previous[x-channels] : 0;
      let predictor=0;
      if (filter===1) predictor=a;
      else if (filter===2) predictor=b;
      else if (filter===3) predictor=Math.floor((a+b)/2);
      else if (filter===4) { const p=a+b-c, pa=Math.abs(p-a), pb=Math.abs(p-b), pc=Math.abs(p-c); predictor=pa<=pb&&pa<=pc?a:pb<=pc?b:c; }
      row[x]=(row[x]+predictor)&255;
    }
    for (let x=channels-1; x<stride; x+=channels) if (row[x] !== 0 && row[x] !== 255) throw fail('INVALID_MASK', maskContract);
    previous=row;
  }
}
const image = (bytes, maxBytes = 4 * 1024 * 1024) => {
  if (bytes.length < 8 || bytes.length > maxBytes) throw fail('INVALID_IMAGE', 'Image exceeds the supported size');
  let type;
  if (bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))) type = 'png';
  else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) type = 'jpeg';
  else if (bytes.subarray(0,4).toString() === 'RIFF' && bytes.subarray(8,12).toString() === 'WEBP') type = 'webp';
  if (!type) throw fail('INVALID_IMAGE', 'Unsupported image format');
  return {type, uri:`data:image/${type};base64,${bytes.toString('base64')}`};
};
async function resolveCall(action, input, runner) {
  const resolver = process.env.SUPERWAGIE_MODEL_RESOLVER;
  if (!resolver) throw fail('UNAVAILABLE', 'Run from SuperWagie with an admitted managed session');
  const value = await runner(process.env.SUPERWAGIE_MODEL_NODE || process.execPath, [resolver, action], JSON.stringify(input));
  if (value.code !== 0 && value.stderr?.trim() === 'platform_model_scope_restart_required') throw fail('PLATFORM_MODEL_SCOPE_RESTART_REQUIRED', 'Your account or sign-in has changed. Restart SuperWagie to continue. 账户或登录状态已变化，请重启 SuperWagie 后继续。');
  if (value.code !== 0) throw fail('UNRESOLVED', 'Keep the call ID and query its status');
  try { return JSON.parse(value.stdout); } catch { throw fail('UNRESOLVED', 'Keep the call ID and query its status'); }
}
function run(file, args, input) {
  return new Promise((done) => {
    const child = spawn(file, args, {env:{...process.env,ELECTRON_RUN_AS_NODE:'1'},stdio:['pipe','pipe','pipe']}); let stdout = '', stderr = '', size = 0, timedOut = false;
    const timer = setTimeout(() => {timedOut = true; child.kill();}, 140000);
    child.stdout.on('data', part => {size += part.length; if (size > 24*1024*1024) child.kill(); else stdout += part;});
    child.stderr.on('data', part => { if (stderr.length < 1024) stderr += String(part).slice(0, 1024 - stderr.length); }); child.stdin.on('error', () => {}); child.on('error', () => {clearTimeout(timer); done({code:null,stdout:''});});
    child.on('close', code => {clearTimeout(timer); done({code:timedOut ? null : code,stdout,stderr});}); child.stdin.end(input);
  });
}
async function privateDirectory(directory) {
  await mkdir(directory,{recursive:true,mode:0o700}); const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077))) throw fail('INVALID_DIRECTORY','Record directory must be private');
  return realpath(directory);
}
async function atomicRecord(path, record) {
  const temp = `${path}.${randomUUID()}.tmp`; let handle;
  try {handle = await open(temp,'wx',0o600); await handle.writeFile(JSON.stringify(record)); await handle.sync(); await handle.close(); handle = null; await rename(temp,path);}
  finally {await handle?.close(); await rm(temp,{force:true}).catch(()=>{});}
}
export async function submit(directory, request, {runner=run}={}) {
  const dir = await privateDirectory(directory);
  if (typeof request.prompt !== 'string' || !request.prompt.trim() || request.prompt.length > 65536 || typeof request.model !== 'string' || !request.model.trim() || typeof request.imagePath !== 'string' || typeof request.maskPath !== 'string') throw fail('INVALID_REQUEST','Provide imagePath, maskPath, prompt and model');
  const sourceBytes = await readFile(request.imagePath), maskBytes = await readFile(request.maskPath);
  const source = image(sourceBytes); validateMask(maskBytes, sourceBytes); const mask = image(maskBytes);
  const selected = await resolveCall('--media-session', request.sessionID ? {sessionID:request.sessionID} : {}, runner);
  if (typeof selected?.sessionID !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(selected.sessionID) || (request.sessionID && selected.sessionID !== request.sessionID)) throw fail('UNRESOLVED','The admitted session could not be confirmed');
  const sessionID = selected.sessionID;
  const callID = `edit_${randomUUID()}`; const path = join(dir,`${callID}.json`);
  const record = {version:1,callID,state:'DISPATCHED',model:request.model,promptHash:hash(request.prompt),sourceHash:hash(source.uri),maskHash:hash(mask.uri),sessionID};
  const handle = await open(path,'wx',0o600); try {await handle.writeFile(JSON.stringify(record)); await handle.sync();} finally {await handle.close();}
  if (process.platform !== 'win32') {const folder=await open(dir,'r'); try {await folder.sync();} finally {await folder.close();}}
  let value;
  try {value = await resolveCall('--edit-image',{callID,prompt:request.prompt,images:[source.uri],mask:mask.uri,expectedModel:request.model,sessionID},runner);}
  catch (error) { error.callID = callID; error.message += `. ${maskContract}`; throw error; }
  if (value?.callID !== callID || value.status !== 'pending' || value.sessionID !== sessionID) throw Object.assign(fail('UNRESOLVED','Submission response invalid; query the call ID'),{callID});
  record.state='SUBMITTED'; record.sessionID=value.sessionID; await atomicRecord(path,record);
  return {callID,sessionID:value.sessionID,status:'pending'};
}
export async function status(directory, request, {runner=run}={}) {
  const dir = await privateDirectory(directory); if (!idPattern.test(request.callID ?? '')) throw fail('INVALID_CALL','Invalid call ID');
  const path = join(dir,`${request.callID}.json`); const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw fail('INVALID_CALL','Invalid call record');
  const record = JSON.parse(await readFile(path,'utf8'));
  if (record.version !== 1 || record.callID !== request.callID || !['DISPATCHED','SUBMITTED','IMPORTED'].includes(record.state)) throw fail('INVALID_CALL','Invalid call record');
  if (record.sessionID && request.sessionID && record.sessionID !== request.sessionID) throw fail('INVALID_CALL','Session mismatch');
  if (record.state === 'IMPORTED') {if (![`${record.callID}.png`, `${record.callID}.jpg`, `${record.callID}.webp`].includes(record.output)) throw fail('INVALID_CALL','Invalid output path'); const outputStat = await lstat(join(dir,record.output)); if (!outputStat.isFile() || outputStat.isSymbolicLink()) throw fail('INVALID_OUTPUT','Imported image is unsafe'); const bytes = await readFile(join(dir,record.output)); if (hash(bytes) !== record.sha256) throw fail('INVALID_OUTPUT','Imported image changed'); return {callID:record.callID,status:'succeeded',path:join(dir,record.output)};}
  const sessionID = record.sessionID ?? request.sessionID;
  const value = await resolveCall('--image-edit-status',{callID:record.callID,...(sessionID ? {sessionID}:{})},runner);
  if (value?.callID !== record.callID || !['pending','failed','succeeded'].includes(value.status)) throw fail('UNRESOLVED','Status response invalid');
  if (value.status !== 'succeeded') return {callID:record.callID,status:value.status};
  if (value.settlement !== 'SETTLED' || !Array.isArray(value.images) || value.images.length !== 1) throw fail('UNRESOLVED','Image has not settled');
  const data = value.images[0]?.data; if (typeof data !== 'string' || data.length > 24*1024*1024) throw fail('INVALID_OUTPUT','Invalid image bytes');
  const bytes = Buffer.from(data,'base64'); if (bytes.toString('base64') !== data) throw fail('INVALID_OUTPUT','Invalid image encoding');
  const checked = image(bytes, 16 * 1024 * 1024); if (`image/${checked.type}` !== value.images[0].mimeType) throw fail('INVALID_OUTPUT','Image type mismatch');
  const output = `${record.callID}.${checked.type === 'jpeg' ? 'jpg' : checked.type}`; const outputPath = join(dir,output);
  try {const file = await open(outputPath,'wx',0o600); try {await file.writeFile(bytes); await file.sync();} finally {await file.close();}}
  catch (error) {if (error.code !== 'EEXIST') throw error; const existing = await lstat(outputPath); if (!existing.isFile() || existing.isSymbolicLink() || hash(await readFile(outputPath)) !== hash(bytes)) throw error;}
  record.state='IMPORTED'; record.output=output; record.sha256=hash(bytes); await atomicRecord(path,record);
  return {callID:record.callID,status:'succeeded',path:outputPath};
}
async function main() {
  const [action,directory] = process.argv.slice(2); if (!['submit','status'].includes(action) || !directory) throw fail('INVALID_REQUEST','Expected submit|status and record directory');
  let data = ''; for await (const chunk of process.stdin) {data += chunk; if (data.length > 65536) throw fail('INVALID_REQUEST','Input too large');}
  const request = JSON.parse(data); return action === 'submit' ? submit(resolve(directory),request) : status(resolve(directory),request);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().then(value => process.stdout.write(JSON.stringify(value))).catch(error => {process.stderr.write(JSON.stringify({code:error.code ?? 'FAILED',message:error.message,...(error.callID ? {callID:error.callID}:{})})); process.exitCode=1;});
