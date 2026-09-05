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

contextBridge.exposeInMainWorld('superwagie', Object.freeze({
  chooseProject: () => invoke('workspace:choose-project', {}),
  activateProject: (projectId) => invoke('workspace:activate-project', { projectId }),
  query: (request) => invoke('workspace:query', { request }),
  command: (intent) => invoke('workspace:command', { intent }),
  subscribe: async (request, listener) => {
    const result = await invoke('workspace:subscribe', { request });
    const wrapped = (_event, message) => listener(message);
    ipcRenderer.on('workspace:subscription-event', wrapped);
    return Object.freeze({
      initial: result,
      unsubscribe: () => ipcRenderer.removeListener('workspace:subscription-event', wrapped),
    });
  },
  resourceUrl: (handleId, offset, length) => {
    const path = encodeURIComponent(handleId);
    return `superwagie-resource://content/${path}?offset=${offset}&length=${length}`;
  },
}));
