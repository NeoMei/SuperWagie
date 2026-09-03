const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('superwagieWorkspace', Object.freeze({
  boot: () => ipcRenderer.invoke('sw:boot'),
  readText: (relativePath) => ipcRenderer.invoke('sw:read-text', relativePath),
  writeText: (payload) => ipcRenderer.invoke('sw:write-text', payload),
  onFileChanged: (listener) => {
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on('sw:file-changed', wrapped);
    return () => ipcRenderer.removeListener('sw:file-changed', wrapped);
  },
}));
