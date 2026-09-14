'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    patch: (partial) => ipcRenderer.invoke('settings:patch', partial),
  },

  appInfo: () => ipcRenderer.invoke('app:info'),

  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
  },

  dialog: {
    pickFiles: () => ipcRenderer.invoke('dialog:pickFiles'),
    pickFolder: (title) => ipcRenderer.invoke('dialog:pickFolder', { title }),
  },

  checkDir: (dir) => ipcRenderer.invoke('fs:checkDir', dir),

  files: {
    add: (paths) => ipcRenderer.invoke('files:add', paths),
    remove: (ids) => ipcRenderer.invoke('files:remove', ids),
    clear: () => ipcRenderer.invoke('files:clear'),
  },

  queue: {
    existing: (ids) => ipcRenderer.invoke('queue:existing', { ids }),
    start: (ids, overwrite) => ipcRenderer.invoke('queue:start', { ids, overwrite }),
    cancel: () => ipcRenderer.send('queue:cancel'),
    cancelJob: (id) => ipcRenderer.send('queue:cancelJob', id),
  },

  shell: {
    revealFile: (filePath) => ipcRenderer.invoke('shell:revealFile', filePath),
    openPath: (target) => ipcRenderer.invoke('shell:openPath', target),
    openFolderOf: (filePath) => ipcRenderer.invoke('shell:openFolderOf', filePath),
  },

  // File.path is gone in recent Electron; the path needs an explicit call.
  pathForFile: (file) => webUtils.getPathForFile(file),

  on: (channel, handler) => {
    const allowed = ['queue:job', 'queue:started', 'queue:finished', 'files:scanning', 'window:state'];
    if (!allowed.includes(channel)) return () => {};
    const listener = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
