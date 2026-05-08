const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  loadState: () => ipcRenderer.invoke('state:load'),
  saveState: (state) => ipcRenderer.send('state:save', state),

  ptySpawn: (tabId, cwd) => ipcRenderer.send('pty:spawn', { tabId, cwd }),
  ptyWrite: (tabId, data) => ipcRenderer.send('pty:write', { tabId, data }),
  ptyResize: (tabId, cols, rows) => ipcRenderer.send('pty:resize', { tabId, cols, rows }),
  ptyKill: (tabId) => ipcRenderer.send('pty:kill', { tabId }),
  ptyCwd: (tabId) => ipcRenderer.invoke('pty:cwd', { tabId }),

  onPtyData: (tabId, cb) => {
    const channel = `pty:data:${tabId}`;
    const listener = (_e, data) => cb(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onPtyExit: (tabId, cb) => {
    const channel = `pty:exit:${tabId}`;
    const listener = () => cb();
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onTabStatus: (cb) => {
    ipcRenderer.on('tab:status', (_e, payload) => cb(payload));
  },

  openMarkdown: () => ipcRenderer.invoke('file:openMarkdown'),
  readMarkdown: (filePath) => ipcRenderer.invoke('file:readMarkdown', filePath)
});
