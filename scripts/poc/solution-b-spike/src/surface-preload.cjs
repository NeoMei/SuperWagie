const { contextBridge, ipcRenderer } = require('electron');

const getArg = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? '';
const identity = getArg('surface-identity');
const nonce = getArg('surface-nonce');
const surfaceType = getArg('surface-type');
const selfTest = getArg('surface-self-test') === 'true';
const requestNonce = () => [...globalThis.crypto.getRandomValues(new Uint8Array(12))]
  .map((value) => value.toString(16).padStart(2, '0')).join('');

const payload = (overrides = {}) => ({
  identity,
  nonce,
  request_nonce: requestNonce(),
  deadline_ms: Date.now() + 2_000,
  ...overrides,
});

const invoke = (channel, overrides) => ipcRenderer.invoke(channel, payload(overrides));
const bridge = { probe: () => invoke('surface:probe') };
if (surfaceType === 'app_ui') bridge.snapshot = () => invoke('surface:snapshot');
if (selfTest) bridge.attack = Object.freeze({
    invoke,
    identity,
    nonce,
    payload,
});
contextBridge.exposeInMainWorld('superwagie', Object.freeze(bridge));
