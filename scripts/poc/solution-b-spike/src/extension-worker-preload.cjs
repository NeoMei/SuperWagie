const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('superwagieExtension', Object.freeze({
  requestCapability: (request) => ipcRenderer.invoke('extension:capability', request),
  completeProbe: (result) => ipcRenderer.invoke('extension:complete-probe', result),
}));
