'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const engine = require('./lib/ffmpeg');
const rife = require('./lib/rife');

const VIDEO_EXT = ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'flv', 'wmv', 'ts', 'mts', 'm2ts', 'mpg', 'mpeg', '3gp'];

let win = null;
let activeJob = null;
let binaryStatus = null;

// ---------------------------------------------------------------- updates
// Installed copies check GitHub Releases on start (and every few hours), download a newer
// version in the background and offer "Restart to update". Dev runs never update.
let autoUpdater = null;
let manualCheck = false;
let updateState = { state: 'idle' };

function sendUpdate(payload) {
  if (payload.state === 'downloading' || payload.state === 'ready') updateState = payload;
  if (win && !win.isDestroyed()) win.webContents.send('update', payload);
}

function setupUpdates() {
  if (!app.isPackaged) return;
  try { autoUpdater = require('electron-updater').autoUpdater; } catch (_) { return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;   // also installs it the next time you close the app
  autoUpdater.on('update-available', (i) => sendUpdate({ state: 'downloading', version: i.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) =>
    sendUpdate({ state: 'downloading', version: updateState.version, percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (i) => sendUpdate({ state: 'ready', version: i.version }));
  autoUpdater.on('update-not-available', () => {
    if (manualCheck) sendUpdate({ state: 'none', manual: true });
    manualCheck = false;
  });
  autoUpdater.on('error', () => {
    if (manualCheck) {
      sendUpdate({ state: 'error', manual: true,
        message: 'Could not check for updates. You may be offline, or no update has been published yet.' });
    }
    manualCheck = false;
  });
  setTimeout(() => checkForUpdates(false), 4000);
  setInterval(() => checkForUpdates(false), 6 * 60 * 60 * 1000);
}

function checkForUpdates(manual) {
  if (!autoUpdater) {
    if (manual) sendUpdate({ state: 'error', manual: true, message: 'Updates only work in the installed app, not when run from the source folder.' });
    return;
  }
  if (updateState.state === 'downloading' || updateState.state === 'ready') {
    if (manual) sendUpdate(Object.assign({}, updateState, { manual: true }));
    return;
  }
  manualCheck = !!manual;
  autoUpdater.checkForUpdates().catch(() => { /* reported through the 'error' event */ });
}

function launchPaths(argv) {
  // "Open with xan" / dragging a file onto the exe passes the file as an argument
  return argv
    .slice(app.isPackaged ? 1 : 2)
    .filter((a) => {
      try {
        const ext = path.extname(a).slice(1).toLowerCase();
        return !a.startsWith('--') && VIDEO_EXT.includes(ext) && fs.statSync(a).isFile();
      } catch (_) { return false; }
    });
}

// The whole interface scales with the window: smaller windows shrink it so everything still fits,
// big screens grow it a little. The design is laid out for about 1100 x 700.
let scale = 1;
let scaleTimer = null;
function scaleFor(w, h) {
  const r = Math.min(w / 1100, h / 700);
  const z = r >= 1 ? 1 + Math.min(0.3, (r - 1) * 0.3) : Math.max(0.65, r);
  return Math.round(z * 20) / 20;
}
function applyScale(now) {
  clearTimeout(scaleTimer);
  const run = () => {
    if (!win || win.isDestroyed()) return;
    const [w, h] = win.getContentSize();
    const z = scaleFor(w, h);
    if (z === scale && !now) return;
    scale = z;
    win.webContents.setZoomFactor(z);
    try { win.setTitleBarOverlay({ color: '#08070b', symbolColor: '#cfc8de', height: Math.round(54 * z) }); } catch (_) { /* not supported here */ }
  };
  if (now) run(); else scaleTimer = setTimeout(run, 40);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: '#08070b',
    title: 'xan',
    icon: path.join(__dirname, 'renderer', 'icon.png'),
    // no native title bar or menu: the app draws its own top bar, Windows still supplies the minimise/maximise/close buttons
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#08070b', symbolColor: '#cfc8de', height: 54 },
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => applyScale(true));
  for (const ev of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) win.on(ev, () => applyScale(false));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // a dropped file must never navigate the window away from the app
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('closed', () => { win = null; });
}

// The old menu bar is gone, so its shortcuts are handled here.
function setupShortcuts() {
  Menu.setApplicationMenu(null);
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const mod = input.control || input.meta;
    const k = String(input.key || '').toLowerCase();
    if (mod && !input.shift && !input.alt && k === 'o') { e.preventDefault(); win.webContents.send('menu', 'open'); }
    else if (input.key === 'F1') { e.preventDefault(); win.webContents.send('menu', 'help'); }
    else if (input.key === 'F11') { e.preventDefault(); win.setFullScreen(!win.isFullScreen()); }
    else if (input.key === 'F12' || (mod && input.shift && k === 'i')) { e.preventDefault(); win.webContents.toggleDevTools(); }
  });
}

// ------------------------------------------------------------------ IPC
ipcMain.handle('dialog:file', async (e, opts) => {
  const o = opts || {};
  const r = await dialog.showOpenDialog(win, {
    title: String(o.title || 'Choose a file'),
    properties: ['openFile'],
    filters: Array.isArray(o.filters) ? o.filters : [{ name: 'All files', extensions: ['*'] }],
  });
  return r.canceled ? '' : r.filePaths[0];
});

// Smoothie recipe.ini: read a file the user picks / save one
ipcMain.handle('recipe:import', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Import a Smoothie recipe',
    properties: ['openFile'],
    filters: [{ name: 'Smoothie recipe', extensions: ['ini', 'txt'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const file = r.filePaths[0];
  if (fs.statSync(file).size > 1e6) throw new Error('That file is too big to be a recipe.');
  return { name: path.basename(file, path.extname(file)), text: fs.readFileSync(file, 'utf8') };
});
ipcMain.handle('recipe:export', async (e, payload) => {
  const p = payload || {};
  const r = await dialog.showSaveDialog(win, {
    title: 'Save the recipe',
    defaultPath: String(p.name || 'recipe').replace(/[\\/:*?"<>|]+/g, '_') + '.ini',
    filters: [{ name: 'Smoothie recipe', extensions: ['ini'] }],
  });
  if (r.canceled || !r.filePath) return '';
  fs.writeFileSync(r.filePath, String(p.text || ''), 'utf8');
  return r.filePath;
});

ipcMain.handle('dialog:open', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose video(s)',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Video', extensions: VIDEO_EXT }, { name: 'All files', extensions: ['*'] }],
  });
  return r.canceled ? [] : r.filePaths;
});

ipcMain.handle('dialog:folder', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose where exported videos go',
    properties: ['openDirectory', 'createDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('app:binaries', () => {
  if (!binaryStatus) binaryStatus = engine.checkBinaries();
  return binaryStatus;
});

ipcMain.handle('app:launchPaths', () => launchPaths(process.argv));

ipcMain.handle('media:probe', async (_e, p) => {
  try { return { ok: true, info: await engine.probe(p) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('media:proxy', async (_e, p) => {
  try { return { ok: true, path: await engine.makeProxy(p) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// RIFE (pre-interpolation) is downloaded on demand into the app's data folder
let rifeAbort = null;
ipcMain.handle('rife:status', (_e, model) => {
  rife.setRoot(path.join(app.getPath('userData'), 'rife'));
  return rife.status(model);
});
ipcMain.handle('rife:install', async (e, model) => {
  if (rifeAbort) return { ok: false, error: 'A download is already running.' };
  rife.setRoot(path.join(app.getPath('userData'), 'rife'));
  rifeAbort = new AbortController();
  const sender = e.sender;
  try {
    const st = await rife.install(model, {
      signal: rifeAbort.signal,
      onProgress: (frac) => { if (!sender.isDestroyed()) sender.send('rife:progress', frac); },
    });
    return { ok: true, status: st };
  } catch (err) {
    return { ok: false, error: rifeAbort && rifeAbort.signal.aborted ? 'Cancelled' : 'Could not download RIFE: ' + err.message };
  } finally {
    rifeAbort = null;
  }
});
ipcMain.handle('rife:cancel', () => { if (rifeAbort) rifeAbort.abort(); return true; });

ipcMain.handle('export:start', async (e, payload) => {
  if (activeJob) return { ok: false, error: 'An export is already running.', results: [] };
  activeJob = new engine.Job();
  const sender = e.sender;
  rife.setRoot(path.join(app.getPath('userData'), 'rife'));
  payload = Object.assign({}, payload, { previewFile: path.join(os.tmpdir(), `xan-preview-${process.pid}.jpg`) });
  try {
    return await engine.exportAll(payload, (ev) => {
      if (!sender.isDestroyed()) sender.send('export:event', ev);
    }, activeJob);
  } catch (err) {
    return { ok: false, error: err.message, results: [] };
  } finally {
    activeJob = null;
    try { fs.rmSync(payload.previewFile, { force: true }); } catch (_) { /* best effort */ }
  }
});

ipcMain.handle('export:cancel', () => {
  if (activeJob) activeJob.cancel();
  return true;
});

ipcMain.handle('app:version', () => app.getVersion());
ipcMain.handle('update:state', () => updateState);
ipcMain.handle('update:check', () => { checkForUpdates(true); return true; });
ipcMain.handle('update:install', () => {
  if (autoUpdater && updateState.state === 'ready') autoUpdater.quitAndInstall(true, true);
  return true;
});

ipcMain.handle('shell:show', (_e, p) => { shell.showItemInFolder(p); return true; });
ipcMain.handle('shell:openFolder', (_e, p) => shell.openPath(p));

// -------------------------------------------------------------- lifecycle
app.setAppUserModelId('com.clipsqueeze.app');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const paths = launchPaths(argv);
    if (paths.length) win.webContents.send('open-paths', paths);
  });

  app.whenReady().then(() => {
    createWindow();
    setupShortcuts();
    setupUpdates();
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    if (activeJob) activeJob.cancel();
    engine.cleanupProxies();
  });
}

module.exports = { getWindow: () => win, scaleFor };
