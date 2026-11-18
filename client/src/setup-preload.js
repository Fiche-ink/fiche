// Bridge for the install screen (ui/setup.html).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setup', {
  lang: ipcRenderer.sendSync('setup:lang'),
  setLang: l => ipcRenderer.invoke('setup:setLang', l),
  info: () => ipcRenderer.invoke('setup:info'),
  ready: () => ipcRenderer.send('setup:ready'),
  pick: cur => ipcRenderer.invoke('setup:pick', cur),
  install: opts => ipcRenderer.invoke('setup:install', opts),
  onProgress: cb => ipcRenderer.on('setup:progress', (_e, p) => cb(p)),
  open: () => ipcRenderer.invoke('setup:open'),
  close: () => ipcRenderer.invoke('setup:close'),
});
