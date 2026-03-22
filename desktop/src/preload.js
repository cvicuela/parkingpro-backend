const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getStatus: () => ipcRenderer.invoke('get-status'),
  startServer: () => ipcRenderer.invoke('start-server'),
  stopServer: () => ipcRenderer.invoke('stop-server'),
  restartServer: () => ipcRenderer.invoke('restart-server'),
  openPWA: () => ipcRenderer.invoke('open-pwa'),
  openAdmin: () => ipcRenderer.invoke('open-admin'),
  openBackendFolder: () => ipcRenderer.invoke('open-backend-folder'),
  setPort: (port) => ipcRenderer.invoke('set-port', port),
  onLog: (callback) => {
    ipcRenderer.on('log', (_, msg) => callback(msg));
    return () => ipcRenderer.removeAllListeners('log');
  },
  onStatusChanged: (callback) => {
    ipcRenderer.on('status-changed', (_, data) => callback(data));
    return () => ipcRenderer.removeAllListeners('status-changed');
  },
});
