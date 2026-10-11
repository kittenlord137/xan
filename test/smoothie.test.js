'use strict';
// Smoothie: settings, recipe.ini, filter chain, and real exports through ffmpeg. Run with: npm test
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const engine = require('../lib/ffmpeg');
const Core = require('../shared/core');
const Smoothie = require('../shared/smoothie');
const rife = require('../lib/rife');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xan-smoothie-test-'));
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail !== undefined ? '  -> ' + detail : ''}`); }
}
const ff = (args) => spawnSync(engine.FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { maxBuffer: 1 << 28 });
const probeStream = (f, entries) => {
  const r = spawnSync(engine.FFPROBE, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', `stream=${entries}`, '-of', 'json', f]);
  return JSON.parse(r.stdout).streams[0];
};
const fpsOf = (s) => { const [a, b] = s.avg_frame_rate.split('/').map(Number); return a / b; };
const gray = (f) => ff(['-i', f, '-vf', 'scale=64:36,format=gray', '-f', 'rawvideo', '-frames:v', '1', '-']).stdout;
const diffFrom = (f, ref) => { const a = gray(f), b = ref; let t = 0; for (let i = 0; i < a.length; i++) t += Math.abs(a[i] - b[i]); return t / a.length; };
const avgLuma = (f) => {
  const r = ff(['-i', f, '-vf', 'scale=32:32,format=gray', '-f', 'rawvideo', '-frames:v', '1', '-']);
  return r.stdout.reduce((a, b) => a + b, 0) / r.stdout.length;
};
const settings = (o) => Object.assign({}, Core.DEFAULT_SETTINGS, { speed: 'veryfast' }, o);
async function exportWith(src, smoothie, extra) {
  const info = engine.probe(src);
  const events = [];
  const res = await engine.exportAll({
    files: [Object.assign({ path: src, info: await info, segments: [{ start: 0, end: (await info).duration }], merge: false }, (extra && extra.file) || {})],
    settings: settings((extra && extra.settings) || {}), outDir: path.join(tmp, 'out'), smoothie, previewFile: (extra && extra.preview) || undefined, suffix: undefined,
  }, (e) => events.push(e), new engine.Job());
  return { res, events };
}

const pv = path.join(tmp, 'live preview.jpg');
const pvOk = () => fs.existsSync(pv) && fs.statSync(pv).size > 2000 && ff(['-i', pv, '-f', 'null', '-']).status === 0;

async function main() {
  console.log('settings and recipe.ini');
  const d = Smoothie.defaults();
  check('defaults match the real recipe: blending on at 60 fps, interpolation off', d['frame blending'].enabled === true && d['frame blending'].fps === 60 && d.interpolation.enabled === false && d.interpolation.fps === '1920');
  const real = `[interpolation]
enabled: no
masking: no
fps: 1920
speed: medium
tuning: weak
algorithm: 23
use gpu: no

[frame blending]
enabled: yes
fps: 60
intensity: 1.0
weighting: equal
bright blend: no

[flowblur]
enabled: no
masking: no
amount: 125
do blending: after

[output]
process: ffmpeg
enc args: H264 CPU
file format: %FILENAME% ~ %FRUIT%
container: .MP4

[timescale]
in: 1.0
out: 1.0

[color grading]
enabled: no
brightness: 1.0
saturation: 1.0
contrast: 1.0

[lut]
enabled: no
path:
opacity: 0.2

[pre-interp]
enabled: no
masking: no
factor: 3x
model: rife-v4.4
`;
  const parsed = Smoothie.parseRecipe(real);
  check('the real default recipe reads back as the defaults', JSON.stringify(parsed.config) === JSON.stringify(d));
  const custom = Smoothie.parseRecipe(real.replace('fps: 60', 'fps: 120').replace('intensity: 1.0', 'intensity: 1.75').replace('weighting: equal', 'weighting: gaussian').replace('[lut]\nenabled: no\npath:', '[lut]\nenabled: yes\npath: C:\\luts\\a b.cube').replace('masking: no\nfps: 1920', 'masking: no\nfps: 4x')).config;
  check('values are read (fps, intensity, weighting, lut path, 4x)', custom['frame blending'].fps === 120 && custom['frame blending'].intensity === 1.75 && custom['frame blending'].weighting === 'gaussian' && custom.lut.enabled && custom.lut.path === 'C:\\luts\\a b.cube' && custom.interpolation.fps === '4x', JSON.stringify(custom['frame blending']));
  const again = Smoothie.parseRecipe(Smoothie.serializeRecipe(custom)).config;
  check('writing then reading a recipe changes nothing', JSON.stringify(again) === JSON.stringify(custom));
  check('a written recipe has the real section names', ['[interpolation]', '[frame blending]', '[flowblur]', '[timescale]', '[color grading]', '[lut]', '[pre-interp]'].every((h) => Smoothie.serializeRecipe(d).includes(h)));
  const odd = Smoothie.normalize({ 'frame blending': { fps: 99999, intensity: -4, weighting: 'bogus', enabled: 'yes' }, timescale: { in: 0, out: 'x' } });
  check('out-of-range and nonsense values are corrected', odd['frame blending'].fps === 1000 && odd['frame blending'].intensity === 0 && odd['frame blending'].weighting === 'equal' && odd['frame blending'].enabled === true && odd.timescale.in === 0.05 && odd.timescale.out === 1);
  check('a recipe with nothing recognisable is reported', Smoothie.parseRecipe('hello world').sections === 0);

  console.log('filter chain');
  const b240 = Smoothie.build(d, { fps: 240 });
  check('240 fps to 60 blends 4 frames then keeps every 4th', /tmix=frames=4:weights='1 1 1 1'/.test(b240.body) && /framestep=4/.test(b240.body) && b240.outFps === 60, b240.body);
  const hi = Smoothie.normalize({ 'frame blending': { intensity: 1.75 } });
  check('intensity 1.75 blends 7 frames', /tmix=frames=7/.test(Smoothie.build(hi, { fps: 240 }).body));
  const low = Smoothie.normalize({ 'frame blending': { intensity: 0.5 } });
  check('intensity 0.5 blends 2 frames', /tmix=frames=2/.test(Smoothie.build(low, { fps: 240 }).body));
  const same = Smoothie.build(d, { fps: 60 });
  check('nothing to blend at 60 fps: skipped with a reason', !same.touched && same.notes.length === 1, JSON.stringify(same));
  check('speed: input 0.5 output 1 doubles the speed', Math.abs(Smoothie.speedOf({ timescale: { in: 0.5, out: 1 } }) - 2) < 1e-9);
  check('audio speed chain is split into steps of at least 0.5', Smoothie.atempoChain(0.25) === 'atempo=0.5,atempo=0.5' && Smoothie.atempoChain(1) === '' && Smoothie.atempoChain(1.5) === 'atempo=1.5');
  check('weights are normalised in shape: ascending rises, descending falls', (() => { const a = Smoothie.weights('ascending', 5), z = Smoothie.weights('descending', 5); return a[4] > a[0] && z[0] > z[4]; })());

  console.log('real exports');
  const hfr = path.join(tmp, 'hfr 240.mp4');
  let g = ff(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=240', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '3', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', hfr]);
  check('made a 240 fps test clip', g.status === 0, String(g.stderr));
  let r = await exportWith(hfr, d);
  let out = r.res.ok && r.res.results[0].output;
  check('240 fps blends down to a 60 fps video', r.res.ok && Math.abs(fpsOf(probeStream(out, 'avg_frame_rate')) - 60) < 0.5, JSON.stringify(r.res.error));
  check('and it is still 3 seconds long', Math.abs(Number(probeStream(out, 'nb_read_frames').nb_read_frames) - 180) <= 2, JSON.stringify(probeStream(out, 'nb_read_frames')));

  // which end of the blend is "newest"? frame N has brightness N*8, so a heavier newest frame gives a brighter result
  const ramp = path.join(tmp, 'ramp.mp4');
  g = ff(['-f', 'lavfi', '-i', 'color=c=black:size=64x64:rate=120,geq=lum=mod(N\\,32)*8:cb=128:cr=128', '-t', '1', '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv420p', ramp]);
  const lumaOf = (cfg) => {
    const body = Smoothie.build(Smoothie.normalize(cfg), { fps: 120 }).body;
    const x = ff(['-i', ramp, '-vf', body.replace('format=yuv420p', 'format=yuv420p') + ',format=gray', '-f', 'rawvideo', '-frames:v', '2', '-']);
    return x.stdout[64 * 64];   // second frame: the first one is only filled with what came before the clip
  };
  const eq = lumaOf({ 'frame blending': { fps: 30, weighting: 'equal' } });
  const asc = lumaOf({ 'frame blending': { fps: 30, weighting: 'ascending' } });
  const desc = lumaOf({ 'frame blending': { fps: 30, weighting: 'descending' } });
  check('ascending gives the newest frame the most weight, descending the oldest', asc > eq && eq > desc, `asc ${asc} equal ${eq} desc ${desc}`);

  // timescale
  const base = path.join(tmp, 'base.mp4');
  g = ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '4', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', base]);
  const durOf = (f, sel) => Number(spawnSync(engine.FFPROBE, ['-v', 'error', '-select_streams', sel, '-show_entries', 'stream=duration', '-of', 'csv=p=0', f]).stdout.toString().trim());
  r = await exportWith(base, Smoothie.normalize({ 'frame blending': { enabled: false }, timescale: { in: 1, out: 0.5 } }));
  out = r.res.ok && r.res.results[0].output;
  check('output speed 0.5 makes slow motion: twice as long, video and audio', r.res.ok && Math.abs(durOf(out, 'v:0') - 8) < 0.3 && Math.abs(durOf(out, 'a:0') - 8) < 0.4, `${r.res.error} v=${r.res.ok && durOf(out, 'v:0')} a=${r.res.ok && durOf(out, 'a:0')}`);
  r = await exportWith(base, Smoothie.normalize({ 'frame blending': { enabled: false }, timescale: { in: 0.5, out: 1 } }));
  out = r.res.ok && r.res.results[0].output;
  check('input speed 0.5 speeds it back up: half as long', r.res.ok && Math.abs(durOf(out, 'v:0') - 2) < 0.2 && Math.abs(durOf(out, 'a:0') - 2) < 0.3, `${r.res.error}`);
  r = await exportWith(base, Smoothie.normalize({ 'frame blending': { enabled: false }, timescale: { in: 1, out: 0.5 } }), { settings: { audio: 'none' } });
  check('slow motion without audio', r.res.ok);

  // size target and slow motion: the bitrate is worked out from the new length
  r = await exportWith(base, Smoothie.normalize({ 'frame blending': { enabled: false }, timescale: { in: 1, out: 0.5 } }), { settings: { preset: 'size10' } });
  check('"fit under 10 MB" counts the stretched length and stays under', r.res.ok && fs.statSync(r.res.results[0].output).size <= 10e6, r.res.error);

  // merged cuts + blending
  r = await exportWith(hfr, d, { file: { segments: [{ start: 0, end: 1 }, { start: 1.5, end: 2.5 }], merge: true } });
  out = r.res.ok && r.res.results[0].output;
  check('merged cuts with frame blending: 60 fps, about 2 s', r.res.ok && Math.abs(fpsOf(probeStream(out, 'avg_frame_rate')) - 60) < 0.5 && Math.abs(durOf(out, 'v:0') - 2) < 0.2, r.res.error);
  r = await exportWith(hfr, d, { file: { segments: [{ start: 0.5, end: 1.5 }], merge: false } });
  check('a single cut with frame blending', r.res.ok && Math.abs(durOf(r.res.results[0].output, 'v:0') - 1) < 0.15, r.res.error);

  // two audio tracks stay in the right number
  const two = path.join(tmp, 'two audio.mp4');
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=120', '-f', 'lavfi', '-i', 'sine=frequency=440', '-f', 'lavfi', '-i', 'sine=frequency=880', '-map', '0:v', '-map', '1:a', '-map', '2:a', '-t', '2', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', two]);
  r = await exportWith(two, d);
  const nA = r.res.ok && spawnSync(engine.FFPROBE, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', r.res.results[0].output]).stdout.toString().trim().split(/\s+/).length;
  check('both audio tracks are kept through Smoothie', r.res.ok && nA === 2, r.res.error);

  // colour
  const baseLuma = avgLuma(base);
  r = await exportWith(base, Smoothie.normalize({ 'frame blending': { enabled: false }, 'color grading': { enabled: true, brightness: 1.4, contrast: 1, saturation: 1 } }));
  check('brightness 1.4 makes the picture brighter', r.res.ok && avgLuma(r.res.results[0].output) > baseLuma + 8, `${baseLuma} -> ${r.res.ok && avgLuma(r.res.results[0].output)} ${r.res.error}`);
  r = await exportWith(base, Smoothie.normalize({ 'frame blending': { enabled: false }, 'color grading': { enabled: true, brightness: 1, contrast: 1, saturation: 0 } }));
  check('saturation 0 works (no colour)', r.res.ok, r.res.error);

  // LUT: a cube that inverts every colour, kept in a folder with a colon and a space in its name
  const lutDir = path.join(tmp, 'my:luts folder'); fs.mkdirSync(lutDir);
  const cube = path.join(lutDir, 'invert.cube');
  const lines = ['LUT_3D_SIZE 2'];
  for (let b = 0; b < 2; b++) for (let gg = 0; gg < 2; gg++) for (let rr = 0; rr < 2; rr++) lines.push(`${1 - rr} ${1 - gg} ${1 - b}`);
  fs.writeFileSync(cube, lines.join('\n') + '\n');
  const baseGray = gray(base);
  r = await exportWith(base, Smoothie.normalize({ 'frame blending': { enabled: false }, lut: { enabled: true, path: cube, opacity: 1 } }));
  const full = r.res.ok && diffFrom(r.res.results[0].output, baseGray);
  check('a LUT at full opacity is applied (path with a colon and a space)', r.res.ok && full > 40, `${full} ${r.res.error}`);
  r = await exportWith(base, Smoothie.normalize({ 'frame blending': { enabled: false }, lut: { enabled: true, path: cube, opacity: 0.5 } }));
  const half = r.res.ok && diffFrom(r.res.results[0].output, baseGray);
  check('half opacity lands between the original and the full effect', r.res.ok && half > full * 0.3 && half < full * 0.7, `${half} vs ${full} ${r.res.error}`);
  r = await exportWith(hfr, Smoothie.normalize({ lut: { enabled: true, path: cube, opacity: 0.3 } }), { file: { segments: [{ start: 0, end: 1 }, { start: 1.5, end: 2 }], merge: true } });
  check('LUT with opacity also works inside merged cuts', r.res.ok, r.res.error);
  r = await exportWith(base, Smoothie.normalize({ lut: { enabled: true, path: path.join(tmp, 'nope.cube') } }));
  check('a missing LUT file is reported', !r.res.ok && /LUT file was not found/.test(r.res.error), r.res.error);
  const odd2 = path.join(lutDir, "it's.cube"); fs.copyFileSync(cube, odd2);
  r = await exportWith(base, Smoothie.normalize({ lut: { enabled: true, path: odd2 } }));
  check('a LUT name with an apostrophe is explained', !r.res.ok && /apostrophe/.test(r.res.error), r.res.error);

  // interpolation (small clips: this is slow)
  const lo = path.join(tmp, 'lo.mp4');
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=10', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', lo]);
  for (const speed of ['medium', 'fast', 'faster', 'fastest']) {
    r = await exportWith(lo, Smoothie.normalize({ interpolation: { enabled: true, fps: '2x', speed }, 'frame blending': { enabled: false } }));
    check(`interpolation (${speed}) turns 10 fps into 20 fps`, r.res.ok && Math.abs(fpsOf(probeStream(r.res.results[0].output, 'avg_frame_rate')) - 20) < 0.5, r.res.error);
  }
  r = await exportWith(lo, Smoothie.normalize({ interpolation: { enabled: true, fps: '60', speed: 'fastest' }, 'frame blending': { enabled: true, fps: 30, intensity: 1 } }));
  check('interpolate to 60 fps, then blend to 30 fps', r.res.ok && Math.abs(fpsOf(probeStream(r.res.results[0].output, 'avg_frame_rate')) - 30) < 0.5, r.res.error);

  // ---- artifact masking: left half black = original frames show through, right half = interpolated
  const mask = path.join(tmp, 'mask.png');
  ff(['-f', 'lavfi', '-i', 'color=c=white:s=320x180', '-vf', 'drawbox=x=0:y=0:w=160:h=180:color=black:t=fill', '-frames:v', '1', mask]);
  const frameGray = (f, n) => ff(['-i', f, '-vf', `select=eq(n\\,${n}),scale=320:180,format=gray`, '-frames:v', '1', '-f', 'rawvideo', '-']).stdout;
  const halfDiff = (a, b, left) => { let t = 0, c = 0; for (let y = 0; y < 180; y++) for (let x = left ? 8 : 168; x < (left ? 152 : 312); x++) { t += Math.abs(a[y * 320 + x] - b[y * 320 + x]); c++; } return t / c; };
  const mcfg = (extra) => Smoothie.normalize(Object.assign({ interpolation: { enabled: true, fps: '2x', speed: 'fastest', masking: true }, 'frame blending': { enabled: false }, 'artifact masking': { enabled: true, feathering: false, 'folder path': tmp, 'file name': 'mask.png' } }, extra || {}));
  r = await exportWith(lo, mcfg(), { settings: { preset: 'high' } });
  if (r.res.ok) {
    const src0 = frameGray(lo, 0), out1 = frameGray(r.res.results[0].output, 1);
    const L = halfDiff(src0, out1, true), R = halfDiff(src0, out1, false);
    check('masking: the black half keeps the original frame, the white half gets the new frame', L < 4 && R > L + 3, `left ${L.toFixed(1)} right ${R.toFixed(1)}`);
  } else check('masking: export works', false, r.res.error);
  r = await exportWith(lo, mcfg({ 'artifact masking': { enabled: true, feathering: true, 'folder path': tmp, 'file name': 'mask.png' } }));
  check('masking with feathering works', r.res.ok, r.res.error);
  r = await exportWith(lo, mcfg({ 'artifact masking': { enabled: true, 'folder path': tmp, 'file name': 'missing.png' } }));
  check('a missing mask file is reported', !r.res.ok && /mask file was not found/.test(r.res.error), r.res.error);
  const noSwitch = Smoothie.build(Smoothie.normalize({ interpolation: { enabled: true, fps: '2x', masking: true } }), { fps: 10, width: 320, height: 180 });
  check('"use the mask" without Artifact masking on is explained and skipped', noSwitch.maskCount === 0 && noSwitch.notes.some((n) => /Artifact masking is switched off/.test(n)), JSON.stringify(noSwitch.notes));
  r = await exportWith(lo, mcfg(), { file: { segments: [{ start: 0, end: 0.8 }, { start: 1, end: 1.8 }], merge: true } });
  check('masking also works with joined cuts', r.res.ok, r.res.error);

  // ---- flowblur (xan's own): same frame rate out, picture blurred along motion
  const mot = path.join(tmp, 'motion.mp4');
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-t', '2', '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p', mot]);
  const sharp = (buf) => { let t = 0; for (let y = 0; y < 180; y++) for (let x = 0; x < 319; x++) t += Math.abs(buf[y * 320 + x] - buf[y * 320 + x + 1]); return t; };
  r = await exportWith(mot, Smoothie.normalize({ 'frame blending': { enabled: false }, flowblur: { enabled: true, amount: 150 } }), { settings: { preset: 'high' } });
  if (r.res.ok) {
    const o = r.res.results[0].output;
    check('flowblur keeps the frame rate (30 fps) and length', Math.abs(fpsOf(probeStream(o, 'avg_frame_rate')) - 30) < 0.5 && Math.abs(durOf(o, 'v:0') - 2) < 0.2);
    check('flowblur makes the picture softer', sharp(frameGray(o, 30)) < sharp(frameGray(mot, 30)) * 0.97, `${sharp(frameGray(o, 30))} vs ${sharp(frameGray(mot, 30))}`);
  } else check('flowblur export works', false, r.res.error);
  r = await exportWith(mot, Smoothie.normalize({ 'frame blending': { enabled: true, fps: 15 }, flowblur: { enabled: true, amount: 100, 'do blending': 'before' } }));
  check('flowblur together with frame blending (before)', r.res.ok && Math.abs(fpsOf(probeStream(r.res.results[0].output, 'avg_frame_rate')) - 15) < 0.5, r.res.error);
  r = await exportWith(mot, Smoothie.normalize({ 'frame blending': { enabled: false }, flowblur: { enabled: true, amount: 100, masking: true }, 'artifact masking': { enabled: true, 'folder path': tmp, 'file name': 'mask.png' } }));
  check('flowblur with a mask', r.res.ok, r.res.error);
  check('flowblur amount 0 does nothing', Smoothie.build(Smoothie.normalize({ 'frame blending': { enabled: false }, flowblur: { enabled: true, amount: 0 } }), { fps: 30 }).touched === false);

  // ---- RIFE pre-interpolation (downloads the real program, about 13 MB, and runs it on the processor)
  console.log('RIFE');
  rife.setRoot(path.join(tmp, 'rife-empty'));
  r = await exportWith(lo, Smoothie.normalize({ 'frame blending': { enabled: false }, 'pre-interp': { enabled: true, factor: '3x' } }));
  check('before the download, the export explains that RIFE is missing', !r.res.ok && /not downloaded/.test(r.res.error), r.res.error);
  rife.setRoot(path.join(tmp, 'rife'));
  check('status says not installed', rife.status('rife-v4.6').installed === false);
  let installed = false, prog = 0;
  try {
    await rife.install('rife-v4.6', { onProgress: (d, t) => { prog = d / t; } });
    installed = rife.status('rife-v4.6').installed;
    check('RIFE downloads and installs (only the program and one model)', installed && prog === 1 && fs.statSync(path.join(rife.getRoot(), 'rife-v4.6', 'flownet.bin')).size > 5e6 && !fs.existsSync(path.join(rife.getRoot(), 'rife-anime')));
  } catch (e) {
    console.log(`  skip RIFE tests: could not download (${e.message})`);
  }
  if (installed) {
    process.env.XAN_RIFE_GPU = '-1';
    const tiny = path.join(tmp, 'tiny.mp4');
    ff(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=8', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-c:v', 'libx264', '-crf', '14', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', tiny]);
    const pre3 = Smoothie.normalize({ 'frame blending': { enabled: false }, 'pre-interp': { enabled: true, factor: '3x' } });
    r = await exportWith(tiny, pre3);
    if (r.res.ok) {
      const o = r.res.results[0].output;
      const nf = Number(probeStream(o, 'nb_read_frames').nb_read_frames);
      check('RIFE 3x: 8 fps becomes 24 fps, same length', Math.abs(fpsOf(probeStream(o, 'avg_frame_rate')) - 24) < 0.6 && nf >= 46 && nf <= 50 && Math.abs(durOf(o, 'v:0') - 2) < 0.15, `fps ${fpsOf(probeStream(o, 'avg_frame_rate'))} frames ${nf}`);
      check('and the audio is kept and in sync', Math.abs(durOf(o, 'a:0') - 2) < 0.2);
    } else check('RIFE 3x export works', false, r.res.error);
    check('temporary picture files are cleaned up', fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('xan-rife-') && fs.existsSync(path.join(os.tmpdir(), f, 'in'))).length === 0);
    fs.rmSync(pv, { force: true });
    r = await exportWith(tiny, pre3, { preview: pv });
    check('live preview works with RIFE too', r.res.ok && pvOk(), r.res.error);
    r = await exportWith(tiny, pre3, { file: { segments: [{ start: 0, end: 0.75 }, { start: 1, end: 1.75 }], merge: true } });
    check('RIFE with joined cuts: 24 fps, 1.5 s, audio', r.res.ok && Math.abs(fpsOf(probeStream(r.res.results[0].output, 'avg_frame_rate')) - 24) < 0.6 && Math.abs(durOf(r.res.results[0].output, 'v:0') - 1.5) < 0.2 && durOf(r.res.results[0].output, 'a:0') > 1.2, r.res.error);
    r = await exportWith(tiny, pre3, { file: { segments: [{ start: 0.5, end: 1.5 }], merge: false } });
    check('RIFE on one cut out of the middle', r.res.ok && Math.abs(durOf(r.res.results[0].output, 'v:0') - 1) < 0.15, r.res.error);
    const mk2 = path.join(tmp, 'mask-tiny.png');
    ff(['-f', 'lavfi', '-i', 'color=c=white:s=160x90', '-vf', 'drawbox=x=0:y=0:w=80:h=90:color=black:t=fill', '-frames:v', '1', mk2]);
    r = await exportWith(tiny, Smoothie.normalize({ 'frame blending': { enabled: false }, 'pre-interp': { enabled: true, factor: '2x', masking: true }, 'artifact masking': { enabled: true, 'folder path': tmp, 'file name': 'mask-tiny.png' } }));
    check('RIFE with a mask', r.res.ok && Math.abs(fpsOf(probeStream(r.res.results[0].output, 'avg_frame_rate')) - 16) < 0.5, r.res.error);
    r = await exportWith(tiny, Smoothie.normalize({ 'frame blending': { enabled: true, fps: 12, intensity: 1 }, 'pre-interp': { enabled: true, factor: '3x' } }), { settings: { preset: 'size10' } });
    check('RIFE then frame blending (24 fps blended to 12) under a size limit', r.res.ok && Math.abs(fpsOf(probeStream(r.res.results[0].output, 'avg_frame_rate')) - 12) < 0.5 && fs.statSync(r.res.results[0].output).size <= 10e6, r.res.error);
    // cancel half way through
    const job = new engine.Job();
    const pi = await engine.probe(tiny);
    const pr = engine.exportAll({ files: [{ path: tiny, info: pi, segments: [{ start: 0, end: pi.duration }], merge: false }], settings: settings({}), outDir: path.join(tmp, 'out'), smoothie: pre3 }, () => {}, job);
    setTimeout(() => job.cancel(), 400);
    const cr = await pr;
    check('cancelling during RIFE stops cleanly and removes temporary files', cr.cancelled === true && fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('xan-rife-')).length === 0, JSON.stringify(cr));
    delete process.env.XAN_RIFE_GPU;
  }

  // ---- live preview picture
  for (const [name, sm, ex] of [
    ['a plain compression (constant quality)', null, { settings: { preset: 'balanced' } }],
    ['a plain compression with "fit under 10 MB" (two passes)', null, { settings: { preset: 'size10', height: 360 } }],
    ['joined cuts', null, { file: { segments: [{ start: 0, end: 1 }, { start: 2, end: 3 }], merge: true } }],
    ['Smoothie frame blending', d, {}],
    ['Smoothie with a LUT and a mask', Smoothie.normalize({ 'frame blending': { enabled: false }, lut: { enabled: true, path: cube, opacity: 0.4 }, interpolation: { enabled: true, fps: '2x', speed: 'fastest', masking: true }, 'artifact masking': { enabled: true, 'folder path': tmp, 'file name': 'mask.png' } }), {}],
  ]) {
    fs.rmSync(pv, { force: true });
    const src = sm === d ? hfr : base;
    r = await exportWith(src, sm, Object.assign({ preview: pv }, ex));
    check(`live preview is written while rendering: ${name}`, r.res.ok && pvOk(), r.res.error);
    check('  and the export itself is still correct', r.res.ok && fs.statSync(r.res.results[0].output).size > 1000);
  }
  r = await exportWith(base, null, { preview: pv, settings: { audio: 'none' } });
  check('live preview with no audio', r.res.ok && pvOk(), r.res.error);

  // Smoothie off or with nothing to do leaves the normal path untouched
  r = await exportWith(base, null);
  check('no Smoothie: exports normally', r.res.ok);
  r = await exportWith(base, Smoothie.normalize({}));
  check('Smoothie on but nothing to blend (30 fps source): exports normally', r.res.ok);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
