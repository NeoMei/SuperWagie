const { contextBridge, ipcRenderer } = require('electron');

function argument(name) {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix));
  if (!value) throw new Error(`BRIDGE_ARGUMENT_MISSING:${name}`);
  return value.slice(prefix.length);
}

const surfaceIdentity = argument('surface-identity');
const surfaceNonce = argument('surface-nonce');
let sequence = 0;

function invoke(channel, body) {
  sequence += 1;
  return ipcRenderer.invoke(channel, { surfaceIdentity, surfaceNonce, sequence, body });
}

function toHex(bytes) {
  let output = '';
  for (const byte of bytes) output += byte.toString(16).padStart(2, '0');
  return output;
}

async function stageDraft({ documentId, baseRevision, content, changeGeneration }) {
  const bytes = new TextEncoder().encode(content);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const expectedRevision = `sha256:${toHex(digest)}`;
  const started = await invoke('workspace:draft', {
    operation: 'begin', documentId, baseRevision, expectedSize: bytes.length,
    expectedRevision, changeGeneration,
  });
  const chunkSize = 192 * 1024;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.slice(offset, Math.min(offset + chunkSize, bytes.length));
    await invoke('workspace:draft', {
      operation: 'append', uploadId: started.upload_id, offset, contentHex: toHex(chunk),
    });
  }
  return invoke('workspace:draft', { operation: 'finish', uploadId: started.upload_id });
}

async function readResource(handle) {
  if (!handle || typeof handle.handle_id !== 'string'
    || !Number.isSafeInteger(handle.size_limit_bytes) || handle.size_limit_bytes < 0
    || !Number.isSafeInteger(handle.range_limit_bytes) || handle.range_limit_bytes < 1) {
    throw new Error('RESOURCE_HANDLE_INVALID');
  }
  const chunks = [];
  for (let offset = 0; offset < handle.size_limit_bytes; offset += handle.range_limit_bytes) {
    const length = Math.min(handle.range_limit_bytes, handle.size_limit_bytes - offset);
    const url = `superwagie-resource://content/${encodeURIComponent(handle.handle_id)}?offset=${offset}&length=${length}`;
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`RESOURCE_READ_FAILED:${response.status}`);
    chunks.push(new Uint8Array(await response.arrayBuffer()));
  }
  const bytes = new Uint8Array(handle.size_limit_bytes);
  let cursor = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, cursor);
    cursor += chunk.length;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

contextBridge.exposeInMainWorld('superwagie', Object.freeze({
  chooseProject: () => invoke('workspace:choose-project', {}),
  activateProject: (projectId) => invoke('workspace:activate-project', { projectId }),
  query: (request) => invoke('workspace:query', { request }),
  command: (intent) => invoke('workspace:command', { intent }),
  stageDraft,
  readResource,
  subscribe: async (request, listener) => {
    const result = await invoke('workspace:subscribe', { request });
    const wrapped = (_event, message) => listener(message);
    ipcRenderer.on('workspace:subscription-event', wrapped);
    return Object.freeze({
      initial: result,
      unsubscribe: () => ipcRenderer.removeListener('workspace:subscription-event', wrapped),
    });
  },
  onCheckpointRequested: (listener) => {
    const wrapped = () => listener();
    ipcRenderer.on('workspace:checkpoint-request', wrapped);
    return () => ipcRenderer.removeListener('workspace:checkpoint-request', wrapped);
  },
  checkpointReady: (result) => invoke('workspace:checkpoint-ready', { result }),
}));
