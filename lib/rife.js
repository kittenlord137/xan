'use strict';
// RIFE (AI frame interpolation) through rife-ncnn-vulkan: download just what is needed, and run it.
// No Electron imports, so it can be tested with plain Node.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const remotezip = require('./remotezip');

const RELEASE = '20221029';
const BASE = 'https://github.com/nihui/rife-ncnn-vulkan/releases/download/' + RELEASE;
const PLATFORM = { win32: 'windows', darwin: 'macos', linux: 'ubuntu' }[process.platform] || 'ubuntu';
const EXE = process.platform === 'win32' ? 'rife-ncnn-vulkan.exe' : 'rife-ncnn-vulkan';
const MODELS = ['rife-v4.6', 'rife-v4'];       // the ones that can make any number of in-between frames

let rootDir = path.join(os.tmpdir(), 'xan-rife');
const setRoot = (dir) => { rootDir = dir; };
const getRoot = () => rootDir;

const zipUrl = () => `${BASE}/rife-ncnn-vulkan-${RELEASE}-${PLATFORM}.zip`;
const modelOf = (m) => (MODELS.includes(m) ? m : MODELS[0]);

function status(model) {
  const m = modelOf(model);
  const exe = path.join(rootDir, EXE);
  const hasExe = fs.existsSync(exe);
  const hasModel = fs.existsSync(path.join(rootDir, m, 'flownet.param')) && fs.existsSync(path.join(rootDir, m, 'flownet.bin'));
  return { installed: hasExe && hasModel, hasExe, hasModel, dir: rootDir, exe, model: m };
}

// Download the program (about 3 MB) and one model (about 10 MB) from the project's release page.
async function install(model, { onProgress, signal } = {}) {
  const m = modelOf(model);
  const url = zipUrl();
  const entries = await remotezip.listZip(url, signal);
  const top = (entries.find((e) => e.name.endsWith('/') && e.name.split('/').length === 2) || {}).name || '';
  const want = entries.filter((e) => {
    if (!e.name.startsWith(top) || e.name.endsWith('/')) return false;
    const rel = e.name.slice(top.length);
    if (rel.startsWith(m + '/')) return true;
    return !rel.includes('/') && !/\.md$/i.test(rel);       // the program, its DLLs, the licence
  });
  if (!want.some((e) => e.name.endsWith(EXE)) || !want.some((e) => e.name.endsWith('/flownet.param'))) {
    throw new Error('The RIFE download did not have the expected files.');
  }
  fs.mkdirSync(rootDir, { recursive: true });
  const tmp = rootDir + '.part';
  fs.rmSync(tmp, { recursive: true, force: true });
  await remotezip.extract(url, want, tmp, top, onProgress, signal);
  // move into place (keeps what is already installed, e.g. another model)
  for (const name of fs.readdirSync(tmp)) {
    const to = path.join(rootDir, name);
    fs.rmSync(to, { recursive: true, force: true });
    fs.renameSync(path.join(tmp, name), to);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  if (process.platform !== 'win32') try { fs.chmodSync(path.join(rootDir, EXE), 0o755); } catch (_) { /* best effort */ }
  return status(m);
}

const countFiles = (dir) => { try { return fs.readdirSync(dir).length; } catch (_) { return 0; } };

// inDir: numbered pictures (%08d.jpg). Writes `count` pictures to outDir. job: {cancelled, child}.
function run({ inDir, outDir, model, count, onProgress, job }) {
  return new Promise((resolve, reject) => {
    const st = status(model);
    if (!st.installed) return reject(new Error('RIFE is not downloaded yet. Open Smoothie > Pre-interpolation and press Download.'));
    if (job && job.cancelled) return reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
    const args = ['-i', inDir, '-o', outDir, '-m', path.join(rootDir, st.model), '-n', String(count), '-f', '%08d.jpg'];
    if (process.env.XAN_RIFE_GPU) args.push('-g', process.env.XAN_RIFE_GPU);      // -1 = processor (used by the tests)
    const child = spawn(st.exe, args, { cwd: rootDir, windowsHide: true });
    if (job) job.child = child;
    let err = '';
    child.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-10000); });
    child.stdout.on('data', () => {});
    const timer = setInterval(() => { if (onProgress) { const made = countFiles(outDir); onProgress(Math.min(1, made / count), made); } }, 400);
    child.on('error', (e) => { clearInterval(timer); reject(new Error('Could not start RIFE: ' + e.message)); });
    child.on('close', (code) => {
      clearInterval(timer);
      if (job) job.child = null;
      if (job && job.cancelled) return reject(Object.assign(new Error('Cancelled'), { cancelled: true }));
      const made = countFiles(outDir);
      if (code === 0 && made >= count) return resolve();
      const tail = String(err).trim().split(/\r?\n/).filter((l) => !/vkCreateInstance/.test(l)).slice(-3).join('\n');
      reject(new Error('RIFE could not make the extra frames' + (made ? ` (${made} of ${count} done)` : '') +
        '. It needs a graphics card with Vulkan support and up-to-date drivers.' + (tail ? '\n' + tail : '')));
    });
  });
}

module.exports = { MODELS, setRoot, getRoot, status, install, run, zipUrl };
