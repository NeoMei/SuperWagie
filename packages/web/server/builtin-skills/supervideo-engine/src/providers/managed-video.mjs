import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFile, readProject } from '../core/store.mjs';
import { importAsset, mediaError, projectMediaPath } from './assets.mjs';
import { runProcess } from './process.mjs';

const validID = value => typeof value === 'string' && /^video_[a-zA-Z0-9-]{1,160}$/.test(value);
const recordPath = (root, callID) => join(root, 'media', 'managed-video', `${callID}.json`);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function runResolver(action, input, runner) {
  const resolver = process.env.SUPERWAGIE_MODEL_RESOLVER;
  if (!resolver) throw mediaError('MODEL_CONFIGURATION_UNAVAILABLE', 'Run this skill from SuperWagie to use the configured video model');
  const result = await runner(process.env.SUPERWAGIE_MODEL_NODE || process.execPath, [resolver, action], {
    timeoutMs: action === '--video-result' ? 130000 : action === '--generate-video' ? 130000 : 20000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, input: JSON.stringify(input),
  });
  if (result.code !== 0 && result.stderr?.trim() === 'platform_model_scope_restart_required') throw mediaError('PLATFORM_MODEL_SCOPE_RESTART_REQUIRED', 'Your account or sign-in has changed. Restart SuperWagie to continue. 账户或登录状态已变化，请重启 SuperWagie 后继续。');
  if (result.code !== 0 || result.timedOut) throw mediaError('MANAGED_VIDEO_UNRESOLVED', 'Video request or read could not be confirmed; retain the call ID and check its status before any new submission');
  try { return JSON.parse(result.stdout); }
  catch { throw mediaError('MANAGED_VIDEO_UNRESOLVED', 'Video helper returned an unreadable response; check the original call ID'); }
}

async function readRecord(root, callID) {
  if (!validID(callID)) throw mediaError('INVALID_VIDEO_CALL', 'Expected a managed video call ID');
  let record;
  try { record = JSON.parse(await readFile(recordPath(root, callID), 'utf8')); }
  catch { throw mediaError('MANAGED_VIDEO_RECORD_MISSING', 'The original video call record is unavailable'); }
  if (record?.version !== 1 || record.callID !== callID || !['DISPATCHED', 'SUBMITTED', 'IMPORTED'].includes(record.state) || typeof record.model !== 'string' || !record.model) throw mediaError('MANAGED_VIDEO_RECORD_INVALID', 'The managed video call record is invalid');
  return record;
}

/** Persist a caller-visible call ID before any payable gateway submission. */
export async function submitManagedVideo(root, request, { runner = runProcess } = {}) {
  await readProject(root);
  if (typeof request?.prompt !== 'string' || !request.prompt.trim() || request.prompt.length > 65536 || !Number.isInteger(request.seconds) || request.seconds < 1 || request.seconds > 10 || !['1280*720', '1920*1080'].includes(request.size) || typeof request.model !== 'string' || !request.model.trim()) throw mediaError('INVALID_VIDEO_REQUEST', 'Provide a model, prompt, duration and supported resolution');
  const callID = request.callID ?? `video_${randomUUID()}`;
  if (!validID(callID)) throw mediaError('INVALID_VIDEO_CALL', 'Expected a managed video call ID');
  const selected = await runResolver('--media-session', request.sessionID ? {sessionID:request.sessionID} : {}, runner);
  if (typeof selected?.sessionID !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(selected.sessionID) || (request.sessionID && selected.sessionID !== request.sessionID)) throw mediaError('MANAGED_VIDEO_UNRESOLVED', 'The admitted session could not be confirmed');
  const sessionID = selected.sessionID;
  const record = { version: 1, callID, state: 'DISPATCHED', model: request.model, promptHash: digest(Buffer.from(request.prompt)), seconds: request.seconds, size: request.size, sessionID };
  await mkdir(join(root, 'media'), { recursive: true });
  const media = await projectMediaPath(root, 'media');
  const directory = join(media, 'managed-video'); await mkdir(directory, { recursive: true });
  await projectMediaPath(root, 'media/managed-video');
  let handle;
  try { handle = await open(recordPath(root, callID), 'wx', 0o600); await handle.writeFile(JSON.stringify(record)); await handle.sync(); }
  catch (error) { if (error.code === 'EEXIST') throw mediaError('MANAGED_VIDEO_CALL_EXISTS', 'This call ID already exists; check its status instead of submitting again'); throw error; }
  finally { await handle?.close(); }
  if (process.platform !== 'win32') { const folder = await open(directory, 'r'); try { await folder.sync(); } finally { await folder.close(); } }
  let value;
  try { value = await runResolver('--generate-video', { callID, sessionID, prompt: request.prompt, seconds: request.seconds, size: request.size, expectedModel: request.model }, runner); }
  catch (error) { if (['MANAGED_VIDEO_UNRESOLVED', 'PLATFORM_MODEL_SCOPE_RESTART_REQUIRED'].includes(error?.code)) error.message += ` (call ID: ${callID})`; throw error; }
  if (value?.callID !== callID || value.sessionID !== sessionID) throw mediaError('MANAGED_VIDEO_UNRESOLVED', 'Video submission response does not match the original call');
  record.state = 'SUBMITTED'; record.sessionID = value.sessionID;
  await atomicWriteFile(recordPath(root, callID), JSON.stringify(record));
  return { callID, sessionID: value.sessionID, status: 'SUBMITTED' };
}

export async function managedVideoStatus(root, request, { runner = runProcess } = {}) {
  const record = await readRecord(root, request?.callID);
  const sessionID = request.sessionID ?? record.sessionID;
  if (request.sessionID && record.sessionID && request.sessionID !== record.sessionID) throw mediaError('INVALID_VIDEO_CALL', 'The video call belongs to another session');
  const value = await runResolver('--video-status', { callID: record.callID, ...(sessionID ? { sessionID } : {}) }, runner);
  if (value?.callID !== record.callID || !['NOT_START', 'SUBMITTED', 'QUEUED', 'IN_PROGRESS', 'SUCCESS', 'FAILURE', 'UNKNOWN'].includes(value.status)) throw mediaError('MANAGED_VIDEO_UNRESOLVED', 'Video status does not match the original call');
  return { callID: record.callID, status: value.status, ...(value.progress ? { progress: value.progress } : {}), ...(value.settlement ? { settlement: value.settlement } : {}) };
}

export async function importManagedVideo(root, request, { runner = runProcess } = {}) {
  const record = await readRecord(root, request?.callID);
  const status = await managedVideoStatus(root, request, { runner });
  if (status.status !== 'SUCCESS' || status.settlement !== 'SETTLED') throw mediaError('MANAGED_VIDEO_PENDING', 'The video or its settlement is not complete');
  const sessionID = request.sessionID ?? record.sessionID;
  const value = await runResolver('--video-result', { callID: record.callID, ...(sessionID ? { sessionID } : {}) }, runner);
  if (value?.contentType !== 'video/mp4' || typeof value.video !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256 ?? '')) throw mediaError('OUTPUT_INVALID', 'Managed video response is invalid');
  const bytes = Buffer.from(value.video, 'base64');
  if (bytes.length < 12 || bytes.length > 64 * 1024 * 1024 || bytes.toString('base64') !== value.video || bytes.subarray(4, 8).toString('ascii') !== 'ftyp' || digest(bytes) !== value.sha256) throw mediaError('OUTPUT_INVALID', 'Managed video bytes do not match the broker receipt');
  const temporary = await mkdtemp(join(tmpdir(), 'supervideo-managed-'));
  try {
    const path = join(temporary, 'video.mp4'); await writeFile(path, bytes, { mode: 0o600 });
    const asset = await importAsset(root, { path, origin: { kind: 'provider', reference: `UniHub/${record.callID}`, version: record.model } });
    record.state = 'IMPORTED'; record.assetId = asset.id; record.sha256 = asset.sha256;
    await atomicWriteFile(recordPath(root, record.callID), JSON.stringify(record));
    return asset;
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
