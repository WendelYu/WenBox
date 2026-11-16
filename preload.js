const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wenboxDesktop', {
    apiRequest: (request) => ipcRenderer.invoke('wenbox:api-request', request),
    writeText: (text) => ipcRenderer.invoke('wenbox:copy-text', String(text))
});
