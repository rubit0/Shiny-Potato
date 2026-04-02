const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getPlatform: () => ipcRenderer.invoke('app:get-platform'),
  selectFolder: () => ipcRenderer.invoke('dialog:select-folder'),
  selectFiles: () => ipcRenderer.invoke('dialog:select-files'),
  selectOutputFolder: () => ipcRenderer.invoke('dialog:select-output-folder'),
  scanLegacyVideos: (rootPath) => ipcRenderer.invoke('scan:legacy-videos', rootPath),
  scanLegacyVideosFiles: (filePaths) =>
    ipcRenderer.invoke('scan:legacy-videos-files', filePaths),
  convertLegacyFiles: (payload) => ipcRenderer.invoke('convert:legacy-files', payload),
  abortConversion: () => ipcRenderer.invoke('convert:abort'),
  openPath: (dirPath) => ipcRenderer.invoke('shell:open-path', dirPath),
  onConvertProgress: (callback) => {
    const channel = 'convert:progress';
    const listener = (_event, data) => {
      callback(data);
    };
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
  onScanProgress: (callback) => {
    const channel = 'scan:progress';
    const listener = (_event, data) => {
      callback(data);
    };
    ipcRenderer.on(channel, listener);
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },
});
