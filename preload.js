'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

// The sandboxed preload has no url.pathToFileURL, so build the file:// URL by hand.
// Handles spaces and # ? % in names, Windows drive letters and \\server\share paths.
function toFileUrl(p) {
  let s = String(p).replace(/\\/g, '/');
  let host = '';
  if (s.startsWith('//')) {
    const rest = s.slice(2);
    const i = rest.indexOf('/');
    host = i < 0 ? rest : rest.slice(0, i);
    s = i < 0 ? '/' : rest.slice(i);
  } else if (!s.startsWith('/')) {
    s = '/' + s;
  }
  const enc = s
    .split('/')
    .map((seg, i) => (i === 1 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
    .join('/');
  return 'file://' + host + enc;
}

const on = (channel, cb) => {
  const handler = (_e, ...args) => cb(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('api', {
  openFilesDialog: () => ipcRenderer.invoke('dialog:open'),
  chooseFile: (opts) => ipcRenderer.invoke('dialog:file', opts),
  importRecipe: () => ipcRenderer.invoke('recipe:import'),
  exportRecipe: (payload) => ipcRenderer.invoke('recipe:export', payload),
  chooseFolder: () => ipcRenderer.invoke('dialog:folder'),
  binaries: () => ipcRenderer.invoke('app:binaries'),
  launchPaths: () => ipcRenderer.invoke('app:launchPaths'),
  probe: (p) => ipcRenderer.invoke('media:probe', p),
  makeProxy: (p) => ipcRenderer.invoke('media:proxy', p),
  startExport: (payload) => ipcRenderer.invoke('export:start', payload),
  cancelExport: () => ipcRenderer.invoke('export:cancel'),
  showInFolder: (p) => ipcRenderer.invoke('shell:show', p),
  openFolder: (p) => ipcRenderer.invoke('shell:openFolder', p),
  pathForFile: (file) => webUtils.getPathForFile(file),
  fileUrl: toFileUrl,
  appVersion: () => ipcRenderer.invoke('app:version'),
  updateState: () => ipcRenderer.invoke('update:state'),
  checkUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdate: (cb) => on('update', cb),
  onExportEvent: (cb) => on('export:event', cb),
  onOpenPaths: (cb) => on('open-paths', cb),
  onMenu: (cb) => on('menu', cb),
});
