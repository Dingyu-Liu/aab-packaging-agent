const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('partnerDesktop', {
  updates: {
    status: () => ipcRenderer.invoke('partner:update:status'),
    configure: input => ipcRenderer.invoke('partner:update:configure', input),
    check: () => ipcRenderer.invoke('partner:update:check'),
    download: () => ipcRenderer.invoke('partner:update:download'),
    install: () => ipcRenderer.invoke('partner:update:install'),
    onOpen: callback => { const listener = () => callback(); ipcRenderer.on('partner:update:open', listener); return () => ipcRenderer.removeListener('partner:update:open', listener); },
    subscribe: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('partner:update:state', listener); return () => ipcRenderer.removeListener('partner:update:state', listener); },
  },
});
