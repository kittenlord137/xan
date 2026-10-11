'use strict';
// Drives the real app window: loads a video, drags handles, exports, takes screenshots.
//   npx electron test/ui-smoke.js            (add --no-sandbox when running as root, e.g. in a container)
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
// a fresh profile every run, so saved settings from earlier runs cannot leak into the checks
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'xan-ui-profile-')));
const main = require('../main.js');
const engine = require('../lib/ffmpeg');

const OUT = process.env.SHOTS_DIR || path.join(os.tmpdir(), 'clipsqueeze-shots');
fs.mkdirSync(OUT, { recursive: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'clipsqueeze-ui-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, cond, detail) => {
  if (!cond) failures++;
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${name}${!cond && detail !== undefined ? '  -> ' + detail : ''}`);
};

function makeClip(file, { codec = 'libx264', secs = 20, size = '1920x1080', fps = 60, audioTracks = 2 } = {}) {
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${fps}`];
  for (let i = 0; i < audioTracks; i++) args.push('-f', 'lavfi', '-i', `sine=frequency=${440 * (i + 1)}`);
  args.push('-map', '0:v');
  for (let i = 0; i < audioTracks; i++) args.push('-map', `${i + 1}:a`);
  args.push('-t', String(secs), '-c:v', codec, '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac');
  if (codec === 'libx264') args.push('-crf', '16');
  args.push(file);
  const r = spawnSync(engine.FFMPEG, args);
  if (r.status !== 0) throw new Error('clip generation failed: ' + r.stderr);
}

app.whenReady().then(async () => {
  const win = main.getWindow();
  const wc = win.webContents;
  wc.on('console-message', (e) => {
    const level = e.level !== undefined ? e.level : 0;
    if (level >= 2 || /error|uncaught/i.test(String(e.message))) console.log('  [renderer]', e.message);
  });
  if (wc.isLoading()) await new Promise((r) => wc.once('did-finish-load', r));
  win.setContentSize(1180, 720);
  await wait(500);

  const js = (code) => wc.executeJavaScript(code);
  const shot = async (name) => {
    const img = await wc.capturePage();
    fs.writeFileSync(path.join(OUT, name + '.png'), img.toPNG());
  };
  const rect = (sel) => js(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return {x:r.left,y:r.top,w:r.width,h:r.height}; })()`);
  const mouse = (type, x, y) => wc.sendInputEvent({ type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 });
  const key = (k) => js(`document.dispatchEvent(new KeyboardEvent('keydown', {key: ${JSON.stringify(k)}, bubbles: true}))`);
  const st = () => js(`(() => { const s = window.__cs.state, f = s.files[s.cur]; return { t: s.t, hasPreview: s.hasPreview, playing: s.playing, busy: s.busy, files: s.files.length, segs: f ? f.segments.map(x => ({id:x.id, start:+x.start.toFixed(3), end:+x.end.toFixed(3)})) : [], sel: f && f.selectedId, proxy: f && f.proxy }; })()`);
  const setSelect = (id, v) => js(`(() => { const e = document.getElementById(${JSON.stringify(id)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  const waitFor = async (cond, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await js(cond)) return true; await wait(150); } return false; };

  console.log('empty state');
  check('app booted with ffmpeg ok', await js('window.api.binaries().then(b => b.ok)'));
  check('drop zone visible', await js(`!document.getElementById('dropzone').classList.contains('hidden')`));
  check('sidebar hidden', await js(`document.getElementById('sidebar').classList.contains('hidden')`));
  await shot('01-empty');

  const clip = path.join(work, 'Valorant 2026.10.10 - 14.16.09.02.DVR.mp4');
  makeClip(clip);
  console.log('load a video');
  wc.send('open-paths', [clip]);
  check('video loaded', await waitFor(`window.__cs.state.files.length === 1`));
  check('preview playable', await waitFor(`window.__cs.state.hasPreview === true`, 20000));
  await wait(400);
  let s = await st();
  check('one whole-length segment', s.segs.length === 1 && s.segs[0].start === 0 && Math.abs(s.segs[0].end - 20) < 0.3, JSON.stringify(s.segs));
  check('video element has size', (await rect('#video')).h > 200);
  await shot('02-loaded');

  console.log('timeline');
  const tl = await rect('#timeline');
  const trackY = tl.y + 40;
  mouse('mouseDown', tl.x + tl.w * 0.4, trackY); mouse('mouseUp', tl.x + tl.w * 0.4, trackY);
  await wait(300);
  s = await st();
  check('click on timeline seeks to ~40%', Math.abs(s.t - 8) < 0.5, s.t);

  await key('i');                                   // start here (~8 s)
  s = await st();
  check('I sets segment start', Math.abs(s.segs[0].start - s.t) < 0.05 && s.segs[0].start > 7, JSON.stringify(s.segs));

  // drag the end handle (right edge of the segment) to 70%
  const handle = await rect('.seg.selected .h-end');
  mouse('mouseDown', handle.x + 4, handle.y + handle.h / 2);
  mouse('mouseMove', tl.x + tl.w * 0.85, handle.y + handle.h / 2);
  mouse('mouseMove', tl.x + tl.w * 0.7, handle.y + handle.h / 2);
  mouse('mouseUp', tl.x + tl.w * 0.7, handle.y + handle.h / 2);
  await wait(300);
  s = await st();
  check('dragging the end handle works (~14 s)', Math.abs(s.segs[0].end - 14) < 0.5, JSON.stringify(s.segs));

  await key('Home'); await key('+');                // add a second segment at 0
  s = await st();
  check('+ adds a segment', s.segs.length === 2, JSON.stringify(s.segs));
  await key('ArrowRight');                          // 1 s
  await key('s');                                   // split needs playhead inside a segment
  s = await st();
  check('S splits the segment at the playhead', s.segs.length === 3, JSON.stringify(s.segs));
  await key('Delete');
  s = await st();
  check('Delete removes the selected segment', s.segs.length === 2, JSON.stringify(s.segs));
  await key(',');
  await key('.');
  check('frame stepping moves the playhead', Math.abs((await st()).t - 1.0) < 0.1, (await st()).t);
  await shot('03-segments');

  console.log('typed times');
  await js(`(() => { const i = document.querySelector('.seg-row .t-end'); i.value = '0:03.5'; i.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  s = await st();
  check('typing 0:03.5 in an end box applies', s.segs.some((x) => Math.abs(x.end - 3.5) < 0.01), JSON.stringify(s.segs));

  console.log('compression panel');
  await setSelect('preset', 'size10');
  check('est line says up to 10 MB', (await js(`document.getElementById('estLine').textContent`)).includes('10 MB'));
  await setSelect('height', '720');
  await setSelect('cutMode', 'separate');
  const exportBtn = await js(`document.getElementById('exportSummary').textContent`);
  check('summary counts 2 videos', /2 videos/.test(exportBtn), exportBtn);
  await shot('04-compression');

  console.log('export');
  await js(`document.getElementById('btnExport').click()`);
  check('export modal opens', await waitFor(`!document.getElementById('modal').classList.contains('hidden')`, 3000));
  await wait(1200);
  await shot('05-exporting');
  check('export finishes', await waitFor(`!!document.getElementById('resClose') && document.querySelectorAll('.results li').length > 0`, 120000));
  const results = await js(`Array.from(document.querySelectorAll('.r-name, .r-size')).map(e => e.textContent)`);
  console.log('       ' + results.join(' | '));
  check('two result rows', (await js(`document.querySelectorAll('.results li').length`)) === 2);
  const outs = fs.readdirSync(work).filter((f) => f.endsWith('_compressed.mp4'));
  check('two files written next to the source', outs.length === 2, outs.join(','));
  for (const f of outs) check(`${f.slice(-40)} is <= 10 MB`, fs.statSync(path.join(work, f)).size <= 10e6);
  await shot('06-done');
  await js(`document.getElementById('resClose').click()`);

  console.log('cancel');
  await setSelect('preset', 'high');
  await setSelect('speed', 'slow');
  await js(`document.getElementById('btnExport').click()`);
  await wait(900);
  await js(`document.getElementById('expCancel').click()`);
  check('cancel closes with a cancelled message', await waitFor(`document.querySelector('#modalCard h3') && /cancelled/i.test(document.querySelector('#modalCard h3').textContent)`, 15000));
  await js(`document.getElementById('resClose').click()`);

  console.log('updates');
  const btnText = () => js(`(() => { const b = document.getElementById('btnUpdate'); return { hidden: b.classList.contains('hidden'), text: b.textContent, disabled: b.disabled }; })()`);
  check('update button hidden when there is no update', (await btnText()).hidden);
  wc.send('update', { state: 'downloading', version: '9.9.9', percent: 40 });
  await wait(200);
  let ub = await btnText();
  check('downloading shows progress', !ub.hidden && /Downloading update 40%/.test(ub.text) && ub.disabled, JSON.stringify(ub));
  wc.send('update', { state: 'ready', version: '9.9.9' });
  await wait(200);
  ub = await btnText();
  check('ready shows "Restart to update to v9.9.9"', !ub.hidden && /Restart to update to v9\.9\.9/.test(ub.text) && !ub.disabled, JSON.stringify(ub));
  await shot('08-update-ready');
  wc.send('update', { state: 'none', manual: true });
  await wait(200);
  const ver = await js('window.api.appVersion()');   // Electron's own version when launched as "electron test/..."
  check('manual check with no update says up to date', (await js(`document.getElementById('toast').textContent`)).includes(`up to date (v${ver})`), await js(`document.getElementById('toast').textContent`));
  await js(`document.getElementById('btnHelp').click()`);
  await wait(200);
  check('help shows the app version', (await js(`document.getElementById('modalCard').textContent`)).includes(`xan v${ver}`));
  await js(`document.getElementById('resUpdates').click()`);
  await wait(500);
  check('checking from the source folder explains updates need the installed app', /installed app/.test(await js(`document.getElementById('toast').textContent`)), await js(`document.getElementById('toast').textContent`));

  console.log('navigation');
  await js(`document.querySelector('.nav-item[data-page="smoothie"]').click()`);
  check('Smoothie page opens and the editor hides', await js(`!document.getElementById('page-smoothie').classList.contains('hidden') && document.getElementById('app').classList.contains('hidden')`));
  await shot('09-smoothie');
  await key(' ');
  check('editor shortcuts are off on other pages', (await st()).playing === false);

  console.log('smoothie settings');
  check('all eight recipe cards are there', (await js(`document.querySelectorAll('#page-smoothie [data-card]').length`)) === 8);
  check('cards that need extra software start folded', await js(`['flowblur','pre-interp','artifact masking'].every((id) => document.querySelector('[data-card="' + id + '"]').classList.contains('collapsed'))`));
  check('frame blending starts on at 60 fps (the real default recipe)', await js(`(() => { const c = window.__cs.state.sm.configs[0].cfg['frame blending']; return c.enabled === true && c.fps === 60; })()`));
  const setRange = (sec, key, v) => js(`(() => { const e = document.querySelector('input[type=range][data-sec="${sec}"][data-key="${key}"]'); e.value = ${v}; e.dispatchEvent(new Event('input', {bubbles:true})); return e.closest('.opt-col').querySelector('.sl-val').textContent; })()`);
  const setField = (sec, key, v) => js(`(() => { const e = document.querySelector('[data-sec="${sec}"][data-key="${key}"]'); if (e.type === 'checkbox') e.checked = ${JSON.stringify(v)}; else e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  const cfgNow = () => js(`JSON.parse(JSON.stringify(window.__cs.state.sm.configs.find((c) => c.id === window.__cs.state.sm.active).cfg))`);
  check('moving the intensity slider updates the number and the config', (await setRange('frame blending', 'intensity', 1.75)) === '1.75' && (await cfgNow())['frame blending'].intensity === 1.75);
  await setField('frame blending', 'fps', '30');
  check('typing an output fps is saved', (await cfgNow())['frame blending'].fps === 30);
  await setField('frame blending', 'weighting', 'gaussian');
  check('choosing a weighting is saved', (await cfgNow())['frame blending'].weighting === 'gaussian');
  await setField('frame blending', 'enabled', false);
  check('switching a card off dims it', await js(`document.querySelector('[data-card="frame blending"] .sm-body').classList.contains('off')`));
  await setField('frame blending', 'enabled', true);
  check('settings xan cannot use yet are shown disabled', await js(`document.querySelector('[data-sec="interpolation"][data-key="tuning"]').disabled && document.querySelector('[data-sec="flowblur"][data-key="amount"]').disabled`));
  await js(`document.querySelector('[data-card="interpolation"] .panel-head').click()`);
  await shot('10-smoothie-cards');

  console.log('smoothie configs');
  await js(`document.querySelector('[data-act="sm-new"]').click()`);
  await wait(200);
  check('New config asks for a name', await js(`!!document.getElementById('smName')`));
  await js(`(() => { document.getElementById('smName').value = 'Clips 60'; document.getElementById('smOk').click(); })()`);
  await wait(300);
  check('the new config is created and selected, with the same settings', await js(`(() => { const s = window.__cs.state.sm; const c = s.configs.find((x) => x.id === s.active); return s.configs.length === 2 && c.name === 'Clips 60' && c.cfg['frame blending'].intensity === 1.75; })()`));
  await setRange('frame blending', 'intensity', 0.5);
  await js(`(() => { const e = document.getElementById('smSelect'); e.value = window.__cs.state.sm.configs[0].id; e.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  await wait(200);
  check('configs keep their own settings', (await cfgNow())['frame blending'].intensity === 1.75);
  await js(`document.querySelector('[data-act="sm-rename"]').click()`);
  await wait(200);
  await js(`(() => { document.getElementById('smName').value = 'Main'; document.getElementById('smOk').click(); })()`);
  await wait(300);
  check('rename works', await js(`window.__cs.state.sm.configs[0].name === 'Main'`));
  await js(`(() => { const e = document.getElementById('smSelect'); e.value = window.__cs.state.sm.configs[1].id; e.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  await wait(200);
  await js(`document.querySelector('[data-act="sm-delete"]').click()`);
  await wait(200);
  await js(`document.getElementById('smOk').click()`);
  await wait(300);
  check('delete removes it and goes back to the other config', await js(`window.__cs.state.sm.configs.length === 1 && window.__cs.state.sm.active === window.__cs.state.sm.configs[0].id`));
  check('the last config cannot be deleted', await js(`document.querySelector('[data-act="sm-delete"]').disabled`));
  await setField('frame blending', 'fps', '30');
  await setRange('frame blending', 'intensity', 1);
  const ver0 = await js(`window.Smoothie.serializeRecipe(window.__cs.state.sm.configs[0].cfg).includes('[frame blending]')`);
  check('the page can write a recipe.ini', ver0);

  console.log('back in the editor');
  await js(`document.querySelector('.nav-item[data-page="editor"]').click()`);
  check('back to the editor', await js(`document.getElementById('page-smoothie').classList.contains('hidden') && !document.getElementById('app').classList.contains('hidden')`));
  await js(`document.querySelector('#compPanel .panel-head').click()`);
  check('clicking a card header collapses it', await js(`document.getElementById('compPanel').classList.contains('collapsed') && getComputedStyle(document.querySelector('#compPanel .form')).display === 'none'`));
  await js(`document.querySelector('#compPanel .panel-head').click()`);
  check('and expands it again', await js(`!document.getElementById('compPanel').classList.contains('collapsed')`));
  check('sidebar shows the version', (await js(`document.getElementById('navVersion').textContent`)).startsWith('v'));
  check('the Smoothie card is in the editor and starts switched off', await js(`!document.getElementById('smPanel').classList.contains('hidden') && document.querySelector('#smPanel .sm-apply').checked === false`));
  await setSelect('preset', 'high');
  await setSelect('height', '0');
  const est0 = await js(`document.getElementById('estLine').textContent`);
  await js(`(() => { const e = document.querySelector('#smPanel .sm-apply'); e.checked = true; e.dispatchEvent(new Event('change', {bubbles:true})); })()`);
  const est1 = await js(`document.getElementById('estLine').textContent`);
  check('turning Smoothie on changes the size estimate (60 fps source blended to 30 fps)', est0 !== est1, `${est0} | ${est1}`);
  check('the card says what it does', (await js(`document.getElementById('smLine').textContent`)).toLowerCase().includes('blend to 30 fps'));
  await shot('11-editor-smoothie');
  await setSelect('preset', 'size10');
  await setSelect('height', '720');

  console.log('export with Smoothie');
  await js(`document.getElementById('btnExport').click()`);
  check('Smoothie export finishes', await waitFor(`!!document.getElementById('resClose') && document.querySelectorAll('.results li').length > 0`, 180000));
  const smOuts = fs.readdirSync(work).filter((f) => /_compressed( \(\d+\))?\.mp4$/.test(f) && !outs.includes(f));
  check('two more files were written', smOuts.length === 2, smOuts.join(','));
  const pr = spawnSync(engine.FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=avg_frame_rate', '-of', 'csv=p=0', path.join(work, smOuts[0] || 'none')]);
  const [fa, fb] = String(pr.stdout).trim().split('/').map(Number);
  check('and they are 30 fps', Math.abs(fa / fb - 30) < 0.5, String(pr.stdout));
  await js(`document.getElementById('resClose').click()`);
  await js(`(() => { const e = document.querySelector('#smPanel .sm-apply'); e.checked = false; e.dispatchEvent(new Event('change', {bubbles:true})); })()`);

  console.log('second file (HEVC) + file switching');
  const hevc = path.join(work, 'hevc clip.mp4');
  makeClip(hevc, { codec: 'libx265', secs: 6, size: '1280x720', fps: 30, audioTracks: 1 });
  wc.send('open-paths', [hevc]);
  check('second video loaded', await waitFor(`window.__cs.state.files.length === 2`));
  await wait(2500);
  s = await st();
  console.log(`       hevc preview: hasPreview=${s.hasPreview} proxy=${s.proxy ? 'yes' : 'no'}`);
  check('file switcher shown', await js(`!document.getElementById('fileSelect').classList.contains('hidden')`));
  check('export-all checkbox shown', await js(`!document.getElementById('exportAllRow').classList.contains('hidden')`));
  await shot('07-two-files');

  await js(`document.getElementById('btnCloseFile').click()`);
  await wait(300);
  check('closing returns to the first file', (await st()).files === 1);
  await js(`document.getElementById('btnCloseFile').click()`);
  await wait(300);
  check('closing the last file shows the drop zone', await js(`!document.getElementById('dropzone').classList.contains('hidden')`));

  console.log(failures ? `\n${failures} FAILED` : '\nall UI checks passed');
  console.log('screenshots in ' + OUT);
  fs.rmSync(work, { recursive: true, force: true });
  app.exit(failures ? 1 : 0);
}).catch((e) => { console.error(e); app.exit(2); });
