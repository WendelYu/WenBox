const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wenboxDesktop', {
    writeText: (text) => ipcRenderer.invoke('wenbox:copy-text', String(text))
});
