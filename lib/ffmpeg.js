'use strict';
/*
 * The encoder: finds ffmpeg, probes files, plans output files and runs the encodes.
 * No Electron imports here, so it can be tested with plain Node (npm test).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const Core = require('../shared/core');
const Smoothie = require('../shared/smoothie');
const rife = require('./rife');

// ---------------------------------------------------------------- binaries
function unpacked(p) {
  // inside a packaged app, binaries live next to app.asar, not inside it
  return p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

function findBinary(name) {
  const env = process.env[name === 'ffmpeg' ? 'FFMPEG_PATH' : 'FFPROBE_PATH'];
  if (env) return env;
  try {
    const p = name === 'ffmpeg' ? require('ffmpeg-static') : require('ffprobe-static').path;
    if (p) {
      const real = unpacked(p);
      if (fs.existsSync(real)) return real;
    }
  } catch (_) { /* package not installed: fall back to PATH */ }
  return name;
}

const FFMPEG = findBinary('ffmpeg');
const FFPROBE = findBinary('ffprobe');

function checkBinaries() {
  const run = (bin, args) =>
    spawnSync(bin, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const ff = run(FFMPEG, ['-version']);
  const fp = run(FFPROBE, ['-version']);
  const ok = ff.status === 0 && fp.status === 0;
  let x264 = false, x265 = false;
  if (ok) {
    const enc = run(FFMPEG, ['-hide_banner', '-encoders']).stdout || '';
    x264 = /\blibx264\b/.test(enc);
    x265 = /\blibx265\b/.test(enc);
  }
  return {
    ok, x264, x265,
    version: ok ? ff.stdout.split('\n')[0].trim() : null,
    ffmpegPath: FFMPEG, ffprobePath: FFPROBE,
  };
}

// ------------------------------------------------------------------- probe
function frac(s) {
  if (!s) return 0;
  const [a, b] = String(s).split('/').map(Number);
  return b ? a / b : a || 0;
}

function parseProbe(json, file) {
  const streams = json.streams || [];
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  if (!v) throw new Error('No video stream found in this file.');
  const audio = streams.filter((s) => s.codec_type === 'audio');
  const fmt = json.format || {};
  const duration = parseFloat(fmt.duration) || parseFloat(v.duration) || 0;
  if (!(duration > 0)) throw new Error('Could not read the length of this video.');

  let w = v.width, h = v.height, rot = 0;
  if (v.tags && v.tags.rotate) rot = parseInt(v.tags.rotate, 10) || 0;
  const sd = (v.side_data_list || []).find((x) => x && 'rotation' in x);
  if (sd) rot = Math.round(sd.rotation) || 0;
  if (Math.abs(rot) % 180 === 90) { const t = w; w = h; h = t; }

  const fps = frac(v.avg_frame_rate) || frac(v.r_frame_rate) || 30;
  const size = Number(fmt.size) || fs.statSync(file).size;
  const totalKbps = (size * 8) / 1000 / duration;
  let videoKbps = v.bit_rate ? Number(v.bit_rate) / 1000 : 0;
  if (!videoKbps) videoKbps = Math.max(totalKbps - audio.length * Core.AUDIO_KBPS, totalKbps * 0.5);

  return {
    path: file, name: path.basename(file),
    duration, width: w, height: h, fps,
    vcodec: v.codec_name, pixFmt: v.pix_fmt || '', audioStreams: audio.length,
    size, totalKbps, videoKbps,
  };
}

function probe(file) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], {
      windowsHide: true,
    });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => reject(new Error('Could not run ffprobe: ' + e.message)));
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(lastLines(err) || 'This file could not be read as a video.'));
      try { resolve(parseProbe(JSON.parse(out), file)); } catch (e) { reject(e); }
    });
  });
}

// ------------------------------------------------------------- running ffmpeg
class Cancelled extends Error {}

class Job {
  constructor() { this.cancelled = false; this.child = null; }
  cancel() {
    this.cancelled = true;
    if (this.child) { try { this.child.kill(); } catch (_) { /* already gone */ } }
  }
}

function lastLines(text, n) {
  return String(text || '').trim().split(/\r?\n/).filter(Boolean).slice(-(n || 3)).join('\n');
}

function runFfmpeg(args, { cwd, job, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    if (job && job.cancelled) return reject(new Cancelled('Cancelled'));
    if (process.env.CLIPSQUEEZE_DEBUG) console.error('[ffmpeg]', args.map((a) => (/[\s\[\]']/.test(a) ? JSON.stringify(a) : a)).join(' '));
    const child = spawn(FFMPEG, args, { cwd, windowsHide: true });
    if (job) job.child = child;
    let errText = '', buf = '';
    child.stderr.on('data', (d) => {
      errText += d;
      if (errText.length > 20000) errText = errText.slice(-10000);
    });
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const m = /^out_time_(?:us|ms)=(-?\d+)/.exec(line); // both are microseconds
        if (m && onProgress) onProgress(Math.max(0, Number(m[1]) / 1e6));
      }
    });
    child.on('error', (e) => reject(new Error('Could not start ffmpeg: ' + e.message)));
    child.on('close', (code) => {
      if (job) job.child = null;
      if (job && job.cancelled) return reject(new Cancelled('Cancelled'));
      if (code === 0) resolve();
      else reject(new Error(lastLines(errText) || `ffmpeg stopped with code ${code}`));
    });
  });
}

// --------------------------------------------------------------- planning
function uniquePath(dir, name, ext, used) {
  let p = path.join(dir, name + ext);
  let n = 1;
  while (fs.existsSync(p) || used.has(p.toLowerCase())) p = path.join(dir, `${name} (${n++})${ext}`);
  used.add(p.toLowerCase());
  return p;
}

// file: {path, info, segments:[{start,end}], merge}
function planOutputs(file, outDir, used) {
  const dir = outDir || path.dirname(file.path);
  const base = path.basename(file.path, path.extname(file.path));
  const dur = file.info.duration;
  const segs = (file.segments || [])
    .map((s) => ({ start: Math.max(0, Number(s.start)), end: Math.min(dur, Number(s.end)) }))
    .filter((s) => s.end - s.start > 0.01)
    .sort((a, b) => a.start - b.start);
  if (!segs.length) throw new Error(`${path.basename(file.path)}: no segments to export.`);
  const isWhole = (g) => g.start <= 0.001 && g.end >= dur - 0.05;
  const suffix = file.suffix || 'compressed';
  const mk = (name, list) => ({
    input: file.path,
    info: file.info,
    output: uniquePath(dir, name, '.mp4', used),
    segs: list,
    duration: list.reduce((a, g) => a + (g.end - g.start), 0),
    whole: list.length === 1 && isWhole(list[0]),
  });
  if (file.merge && segs.length > 1) return [mk(`${base}_merged_${suffix}`, segs)];
  if (segs.length === 1 && isWhole(segs[0])) return [mk(`${base}_${suffix}`, segs)];
  return segs.map((g) => mk(`${base}-${Core.stamp(g.start)}-${Core.stamp(g.end)}_${suffix}`, [g]));
}

// --------------------------------------------------------------- encoding
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sec = (t) => t.toFixed(3);

// What Smoothie does to this video (null when it is off or has nothing to do). Throws if something it needs is missing.
function smoothiePlan(smoothie, info) {
  if (!smoothie) return null;
  const cfg = Smoothie.normalize(smoothie);
  if (cfg.lut.enabled && cfg.lut.path) {
    if (/'/.test(cfg.lut.path)) throw new Error('The LUT file name contains an apostrophe (\'). Rename the file and choose it again.');
    if (!fs.existsSync(cfg.lut.path)) throw new Error(`The LUT file was not found: ${cfg.lut.path}`);
  }
  const plan = Smoothie.build(cfg, info);
  if (!plan.touched) return null;
  if (plan.maskPath && (plan.maskCount || (plan.pre && plan.pre.masked)) && !fs.existsSync(plan.maskPath)) {
    throw new Error(`The mask file was not found: ${plan.maskPath}`);
  }
  if (plan.pre && !rife.status(plan.pre.model).installed) {
    throw new Error('Pre-interpolation needs RIFE, which is not downloaded yet. Open Smoothie > Pre-interpolation and press Download.');
  }
  return plan;
}

const ffmpegHead = ['-hide_banner', '-y', '-nostdin', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1'];

// How to read just the wanted part of the source: input options for one cut, or a trim+concat graph for joined cuts.
function cutVideo(item, fps) {
  const g = item.segs[0];
  if (item.segs.length > 1) {
    const parts = item.segs.map((s, i) => `[0:v:0]trim=start=${sec(s.start)}:end=${sec(s.end)},setpts=PTS-STARTPTS[v${i}]`);
    parts.push(`${item.segs.map((_, i) => `[v${i}]`).join('')}concat=n=${item.segs.length}:v=1:a=0,fps=${fps}[vf]`);
    return ['-i', item.input, '-filter_complex', parts.join(';'), '-map', '[vf]'];
  }
  const inp = item.whole ? ['-i', item.input] : ['-ss', sec(g.start), '-t', sec(g.end - g.start), '-i', item.input];
  return [...inp, '-map', '0:v:0', '-vf', `fps=${fps}`];
}

// show a picture in the live preview (written to a side file first so the page never reads half a picture)
function copyPreview(from, to) {
  try { fs.copyFileSync(from, to + '.tmp'); fs.renameSync(to + '.tmp', to); } catch (_) { /* preview is optional */ }
}

// RIFE first: cut the video into pictures, let RIFE make the extra ones, and join them into a temporary video.
async function prepareInterpolated(item, plan, job, onFrac, onNote, previewFile) {
  const info = item.info;
  const fps = info.fps;
  const factor = plan.pre.factor;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xan-rife-'));
  const inDir = path.join(tmp, 'in'), outDir = path.join(tmp, 'out');
  fs.mkdirSync(inDir); fs.mkdirSync(outDir);
  const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* best effort */ } };
  try {
    if (onNote) onNote('Step 1 of 3: cutting the video into pictures…');
    await runFfmpeg([...ffmpegHead, ...cutVideo(item, fps), '-q:v', '2', '-start_number', '1', path.join(inDir, '%08d.jpg')], {
      job, onProgress: (t) => onFrac(0.15 * clamp01(t / item.duration)),
    });
    const frames = fs.readdirSync(inDir).length;
    if (frames < 2) throw new Error('There are not enough frames in this part of the video to interpolate.');
    const target = Math.round(frames * factor);
    if (onNote) onNote(`Step 2 of 3: RIFE is making ${target - frames} extra frames…`);
    await rife.run({
      inDir, outDir, model: plan.pre.model, count: target, job,
      onProgress: (f, made) => {
        onFrac(0.15 + 0.6 * f);
        if (previewFile && made > 1) copyPreview(path.join(outDir, String(made - 1).padStart(8, '0') + '.jpg'), previewFile);
      },
    });
    if (onNote) onNote('Step 3 of 3: joining the frames…');
    const out = path.join(tmp, 'interpolated.mkv');
    const newFps = fps * factor;
    const x = ['-framerate', String(newFps), '-start_number', '1', '-i', path.join(outDir, '%08d.jpg')];
    let filter = [];
    if (plan.pre.masked) {
      const cfgMask = plan.maskPath;
      const feather = plan.feather ? `,gblur=sigma=${Math.max(2, info.height / 90).toFixed(2)}` : '';
      x.push('-framerate', String(fps), '-start_number', '1', '-i', path.join(inDir, '%08d.jpg'),
        '-loop', '1', '-t', String(Math.ceil(target / newFps) + 2), '-i', cfgMask);
      filter = ['-filter_complex',
        `[2:v:0]format=gray,scale=${info.width}:${info.height}${feather}[mk];[1:v:0]format=yuv420p,fps=${newFps}[o];[0:v:0]format=yuv420p[p];[p][mk]alphamerge[a];[o][a]overlay=format=auto:shortest=1[v]`,
        '-map', '[v]'];
    }
    await runFfmpeg([...ffmpegHead, ...x, ...filter, '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-pix_fmt', 'yuv420p', '-an', out], {
      job, onProgress: (t) => onFrac(0.75 + 0.25 * clamp01(t / (target / newFps))),
    });
    return { file: out, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

async function encodeOutput(item, settings, job, onFrac0, onNote, smoothie, previewFile) {
  const r = Core.resolve(settings);
  const info = item.info;
  const merged = item.segs.length > 1;
  const nAudio = Core.audioCount(info, r.audio, merged);
  const lib = r.codec === 'h265' ? 'libx265' : 'libx264';
  const sm = smoothiePlan(smoothie, info);
  const speed = sm ? sm.speed : 1;
  const effFps = sm ? sm.outFps : info.fps;
  const outDuration = item.duration / speed;            // length of the finished video
  if (sm && sm.notes.length && onNote) onNote(sm.notes[0]);

  // RIFE takes the first half of the progress bar
  let pre = null;
  let onFrac = onFrac0;
  if (sm && sm.pre) {
    pre = await prepareInterpolated(item, sm, job, (f) => onFrac0(0.5 * clamp01(f)), onNote, previewFile);
    onFrac = (f) => onFrac0(0.5 + 0.5 * clamp01(f));
    if (onNote) onNote('');
  }
  try {
    await encodeMain();
  } finally {
    if (pre) pre.cleanup();
  }

  async function encodeMain() {
  const vf = [];
  if (r.height) vf.push(`scale=-2:'min(ih,${r.height})'`);
  if (r.fps && effFps > r.fps + 1) vf.push(`fps=${r.fps}`);
  const post = vf.join(',');
  const atempo = Smoothie.atempoChain(speed);

  // inputs: 0 = the original, 1 = the RIFE video (if any), then the mask picture (if any)
  const inputs = [];
  const g0 = item.segs[0];
  if (merged || item.whole) inputs.push('-i', item.input);
  else inputs.push('-ss', sec(g0.start), '-t', sec(g0.end - g0.start), '-i', item.input);
  let next = 1;
  if (pre) { inputs.push('-i', pre.file); next++; }
  const maskIdx = next;
  const needMask = sm && sm.maskCount > 0;
  if (needMask) inputs.push('-loop', '1', '-t', String(Math.ceil(outDuration) + 2), '-i', sm.maskPath);
  const smGraph = (vin) => sm.compose(vin, '[vout]', post, `[${maskIdx}:v:0]`);

  let filterArgs, mapArgs;
  if (merged) {
    // several cuts joined into one file: trim + concat in one filter graph
    const hasA = nAudio > 0;
    const parts = [];
    item.segs.forEach((g, i) => {
      if (!pre) parts.push(`[0:v:0]trim=start=${sec(g.start)}:end=${sec(g.end)},setpts=PTS-STARTPTS[v${i}]`);
      if (hasA) parts.push(`[0:a:0]atrim=start=${sec(g.start)}:end=${sec(g.end)},asetpts=PTS-STARTPTS[a${i}]`);
    });
    if (!pre) {
      const ins = item.segs.map((_, i) => `[v${i}]` + (hasA ? `[a${i}]` : '')).join('');
      parts.push(`${ins}concat=n=${item.segs.length}:v=1:a=${hasA ? 1 : 0}[vc]` + (hasA ? '[ac]' : ''));
    } else if (hasA) {
      parts.push(`${item.segs.map((_, i) => `[a${i}]`).join('')}concat=n=${item.segs.length}:v=0:a=1[ac]`);
    }
    let vlabel = '', alabel = '[ac]';
    const vin = pre ? '[1:v:0]' : '[vc]';
    if (sm) { parts.push(smGraph(vin)); vlabel = '[vout]'; }
    else if (post) { parts.push(`${vin}${post}[vout]`); vlabel = '[vout]'; }
    else vlabel = vin;
    if (hasA && atempo) { parts.push(`[ac]${atempo}[aout]`); alabel = '[aout]'; }
    filterArgs = ['-filter_complex', parts.join(';')];
    mapArgs = ['-map', vlabel].concat(hasA ? ['-map', alabel] : []);
  } else {
    mapArgs = ['-map', pre ? '1:v:0' : '0:v:0'];
    if (sm) {
      // Smoothie filters can contain split/merge graphs, so the whole thing is one filter graph
      const parts = [smGraph(pre ? '[1:v:0]' : '[0:v:0]')];
      mapArgs = ['-map', '[vout]'];
      if (nAudio > 0) {
        const tracks = r.audio === 'first' ? 1 : nAudio;
        for (let i = 0; i < tracks; i++) {
          if (atempo) { parts.push(`[0:a:${i}]${atempo}[a${i}]`); mapArgs.push('-map', `[a${i}]`); }
          else mapArgs.push('-map', `0:a:${i}`);
        }
      }
      filterArgs = ['-filter_complex', parts.join(';')];
    } else {
      filterArgs = vf.length ? ['-vf', vf.join(',')] : [];
      if (nAudio > 0) mapArgs.push(...(r.audio === 'first' ? ['-map', '0:a:0'] : ['-map', '0:a?']));
    }
  }
  const inputArgs = inputs;

  // live preview: a second output that saves a small picture of what is being rendered, a few times a second
  let previewOut = [];
  if (previewFile) {
    let graph = '';
    let vsel = mapArgs[1];
    if (filterArgs[0] === '-filter_complex') graph = filterArgs[1];
    else if (filterArgs[0] === '-vf') { graph = `[${vsel}]${filterArgs[1]}[vout]`; vsel = '[vout]'; }
    const src = vsel.startsWith('[') ? vsel : `[${vsel}]`;
    graph += (graph ? ';' : '') + `${src}split=2[pm][pp];[pp]fps=4,scale=480:-2[pv]`;
    filterArgs = ['-filter_complex', graph];
    mapArgs[1] = '[pm]';
    previewOut = ['-map', '[pv]', '-c:v', 'mjpeg', '-q:v', '6', '-update', '1', '-f', 'image2', previewFile];
  }

  const head = ffmpegHead;
  const vArgs = ['-c:v', lib, '-preset', r.speed, '-pix_fmt', 'yuv420p'];
  const aArgs = nAudio > 0 ? ['-c:a', 'aac', '-b:a', `${Core.AUDIO_KBPS}k`] : ['-an'];
  const tail = ['-movflags', '+faststart'].concat(r.codec === 'h265' ? ['-tag:v', 'hvc1'] : []);
  const common = [...inputArgs, ...filterArgs, ...mapArgs, ...vArgs];
  const frac = (t) => clamp01(t / outDuration);

  if (r.mode === 'crf') {
    await runFfmpeg([...head, ...common, '-crf', String(r.crf), ...aArgs, ...tail, item.output, ...previewOut], {
      job, onProgress: (t) => onFrac(frac(t)),
    });
    return;
  }

  // ---- fit under a size: two-pass at a computed bitrate, then verify and retry if needed
  const targetBytes = r.targetMB * 1e6;
  let kbps = Core.sizeModeVideoKbps(r.targetMB, outDuration, nAudio, info.videoKbps);
  if (kbps < Core.MIN_VIDEO_KBPS) {
    throw new Error(`${r.targetMB} MB is too small for ${Core.fmtDur(outDuration)} of video. Pick a bigger size or trim the clip.`);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipsqueeze-'));
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const pass1 = r.codec === 'h265' ? ['-x265-params', 'pass=1:stats=ffpass'] : ['-pass', '1', '-passlogfile', 'ffpass'];
      const pass2 = r.codec === 'h265' ? ['-x265-params', 'pass=2:stats=ffpass'] : ['-pass', '2', '-passlogfile', 'ffpass'];
      // both passes must hand the encoder identical frames; the null muxer and mp4 muxer
      // otherwise pick different frame-timing modes, which breaks pass 2 after joined cuts
      const rate = ['-b:v', `${Math.floor(kbps)}k`, '-fps_mode', 'vfr'];
      // relative log names + cwd=tmp keeps Windows drive-letter colons out of x265-params
      await runFfmpeg([...head, ...common, ...rate, ...pass1, ...aArgs, '-f', 'null', os.devnull, ...previewOut], {
        cwd: tmp, job, onProgress: (t) => onFrac(0.5 * frac(t)),
      });
      await runFfmpeg([...head, ...common, ...rate, ...pass2, ...aArgs, ...tail, item.output, ...previewOut], {
        cwd: tmp, job, onProgress: (t) => onFrac(0.5 + 0.5 * frac(t)),
      });
      const size = fs.statSync(item.output).size;
      if (size <= targetBytes || attempt === 2) break;
      kbps = Math.floor(kbps * (targetBytes / size) * 0.97);
      if (kbps < Core.MIN_VIDEO_KBPS) break;
      if (onNote) onNote('Still a bit over the limit, adjusting and encoding again…');
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
  }   // encodeMain
}

// payload: {files:[{path, info, segments, merge}], settings, outDir}
// emit(event) receives: plan, item, progress. Resolves {ok, results, error?, cancelled?}.
async function exportAll(payload, emit, job) {
  const used = new Set();
  const plan = [];
  try {
    for (const f of payload.files) {
      fs.mkdirSync(payload.outDir || path.dirname(f.path), { recursive: true });
      plan.push(...planOutputs(f, payload.outDir, used));
    }
    for (const item of plan) {
      const smp = smoothiePlan(payload.smoothie, item.info);
      const effInfo = smp ? Object.assign({}, item.info, { fps: smp.outFps }) : item.info;
      const chk = Core.checkTarget(payload.settings, effInfo, item.duration / (smp ? smp.speed : 1), item.segs.length > 1);
      if (chk && chk.level === 'error') throw new Error(`${path.basename(item.input)}: ${chk.text}`);
    }
  } catch (e) {
    return { ok: false, error: e.message, results: [] };
  }

  const total = plan.reduce((a, i) => a + i.duration, 0);
  const t0 = Date.now();
  const results = [];
  let done = 0;
  emit({ type: 'plan', count: plan.length });

  for (let i = 0; i < plan.length; i++) {
    const item = plan[i];
    const itemInfo = { type: 'item', index: i, total: plan.length, name: path.basename(item.output), note: '' };
    emit(itemInfo);
    if (payload.previewFile) emit({ type: 'preview', file: payload.previewFile });
    try {
      await encodeOutput(
        item, payload.settings, job,
        (f) => {
          const overall = clamp01((done + clamp01(f) * item.duration) / total);
          const elapsed = (Date.now() - t0) / 1000;
          emit({ type: 'progress', overall, item: clamp01(f), eta: overall > 0.02 ? (elapsed * (1 - overall)) / overall : null });
        },
        (note) => emit(Object.assign({}, itemInfo, { note })),
        payload.smoothie,
        payload.previewFile || null
      );
    } catch (e) {
      try { fs.rmSync(item.output, { force: true }); } catch (_) { /* partial file */ }
      if (e instanceof Cancelled || e.cancelled) return { ok: false, cancelled: true, results };
      return { ok: false, error: e.message, results };
    }
    done += item.duration;
    results.push({
      output: item.output,
      size: fs.statSync(item.output).size,
      input: item.input,
      whole: item.whole,
      srcSize: item.info.size,
    });
  }
  emit({ type: 'progress', overall: 1, item: 1, eta: 0 });
  return { ok: true, results };
}

// ---------------------------------------------------- preview proxy (for odd codecs)
const proxyDir = path.join(os.tmpdir(), 'clipsqueeze-preview');

const proxyJobs = new Map();   // out path -> promise, so the same video is never converted twice at once

function makeProxy(file) {
  fs.mkdirSync(proxyDir, { recursive: true });
  const st = fs.statSync(file);
  const key = crypto.createHash('sha1').update(`${file}|${st.mtimeMs}|${st.size}`).digest('hex').slice(0, 16);
  const out = path.join(proxyDir, key + '.mp4');
  if (fs.existsSync(out) && fs.statSync(out).size > 0) return Promise.resolve(out);
  if (proxyJobs.has(out)) return proxyJobs.get(out);
  const part = out + '.part.mp4';
  const job = runFfmpeg([
    '-hide_banner', '-y', '-nostdin', '-loglevel', 'error', '-i', file,
    '-map', '0:v:0', '-map', '0:a:0?', '-vf', "scale=-2:'min(ih,540)'",
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', part,
  ]).then(() => { fs.renameSync(part, out); return out; })
    .finally(() => proxyJobs.delete(out));
  proxyJobs.set(out, job);
  return job;
}

function cleanupProxies() {
  try { fs.rmSync(proxyDir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}

module.exports = {
  FFMPEG, FFPROBE, checkBinaries, probe, parseProbe, planOutputs, encodeOutput, exportAll,
  makeProxy, cleanupProxies, Job, Cancelled,
};
