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
  const mk = (name, list) => ({
    input: file.path,
    info: file.info,
    output: uniquePath(dir, name, '.mp4', used),
    segs: list,
    duration: list.reduce((a, g) => a + (g.end - g.start), 0),
    whole: list.length === 1 && isWhole(list[0]),
  });
  if (file.merge && segs.length > 1) return [mk(`${base}_merged_compressed`, segs)];
  if (segs.length === 1 && isWhole(segs[0])) return [mk(`${base}_compressed`, segs)];
  return segs.map((g) => mk(`${base}-${Core.stamp(g.start)}-${Core.stamp(g.end)}_compressed`, [g]));
}

// --------------------------------------------------------------- encoding
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sec = (t) => t.toFixed(3);

// What Smoothie does to this video (null when it is off or has nothing to do).
function smoothiePlan(smoothie, info) {
  if (!smoothie) return null;
  const cfg = Smoothie.normalize(smoothie);
  if (cfg.lut.enabled && cfg.lut.path) {
    if (/'/.test(cfg.lut.path)) throw new Error('The LUT file name contains an apostrophe (\'). Rename the file and choose it again.');
    if (!fs.existsSync(cfg.lut.path)) throw new Error(`The LUT file was not found: ${cfg.lut.path}`);
  }
  const plan = Smoothie.build(cfg, info);
  return plan.touched ? plan : null;
}

async function encodeOutput(item, settings, job, onFrac, onNote, smoothie) {
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

  const vf = [];
  if (r.height) vf.push(`scale=-2:'min(ih,${r.height})'`);
  if (r.fps && effFps > r.fps + 1) vf.push(`fps=${r.fps}`);
  const chain = [sm && sm.body, vf.join(',')].filter(Boolean).join(',');
  const atempo = Smoothie.atempoChain(speed);

  let inputArgs, filterArgs, mapArgs;
  if (merged) {
    // several cuts joined into one file: trim + concat in one filter graph
    const hasA = nAudio > 0;
    const parts = [];
    item.segs.forEach((g, i) => {
      parts.push(`[0:v:0]trim=start=${sec(g.start)}:end=${sec(g.end)},setpts=PTS-STARTPTS[v${i}]`);
      if (hasA) parts.push(`[0:a:0]atrim=start=${sec(g.start)}:end=${sec(g.end)},asetpts=PTS-STARTPTS[a${i}]`);
    });
    const ins = item.segs.map((_, i) => `[v${i}]` + (hasA ? `[a${i}]` : '')).join('');
    parts.push(`${ins}concat=n=${item.segs.length}:v=1:a=${hasA ? 1 : 0}[vc]` + (hasA ? '[ac]' : ''));
    let vlabel = '[vc]', alabel = '[ac]';
    if (chain) { parts.push(`[vc]${chain}[vout]`); vlabel = '[vout]'; }
    if (hasA && atempo) { parts.push(`[ac]${atempo}[aout]`); alabel = '[aout]'; }
    inputArgs = ['-i', item.input];
    filterArgs = ['-filter_complex', parts.join(';')];
    mapArgs = ['-map', vlabel].concat(hasA ? ['-map', alabel] : []);
  } else {
    const g = item.segs[0];
    // -ss before -i seeks fast; because we re-encode, the cut is still frame accurate
    inputArgs = item.whole ? ['-i', item.input] : ['-ss', sec(g.start), '-i', item.input, '-t', sec(g.end - g.start)];
    mapArgs = ['-map', '0:v:0'];
    if (sm) {
      // Smoothie filters can contain a split/blend graph, so the whole thing is one filter graph
      const parts = [`[0:v:0]${chain}[vout]`];
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

  const head = ['-hide_banner', '-y', '-nostdin', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1'];
  const vArgs = ['-c:v', lib, '-preset', r.speed, '-pix_fmt', 'yuv420p'];
  const aArgs = nAudio > 0 ? ['-c:a', 'aac', '-b:a', `${Core.AUDIO_KBPS}k`] : ['-an'];
  const tail = ['-movflags', '+faststart'].concat(r.codec === 'h265' ? ['-tag:v', 'hvc1'] : []);
  const common = [...inputArgs, ...filterArgs, ...mapArgs, ...vArgs];
  const frac = (t) => clamp01(t / outDuration);

  if (r.mode === 'crf') {
    await runFfmpeg([...head, ...common, '-crf', String(r.crf), ...aArgs, ...tail, item.output], {
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
      await runFfmpeg([...head, ...common, ...rate, ...pass1, ...aArgs, '-f', 'null', os.devnull], {
        cwd: tmp, job, onProgress: (t) => onFrac(0.5 * frac(t)),
      });
      await runFfmpeg([...head, ...common, ...rate, ...pass2, ...aArgs, ...tail, item.output], {
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
    try {
      await encodeOutput(
        item, payload.settings, job,
        (f) => {
          const overall = clamp01((done + clamp01(f) * item.duration) / total);
          const elapsed = (Date.now() - t0) / 1000;
          emit({ type: 'progress', overall, item: clamp01(f), eta: overall > 0.02 ? (elapsed * (1 - overall)) / overall : null });
        },
        (note) => emit(Object.assign({}, itemInfo, { note })),
        payload.smoothie
      );
    } catch (e) {
      try { fs.rmSync(item.output, { force: true }); } catch (_) { /* partial file */ }
      if (e instanceof Cancelled) return { ok: false, cancelled: true, results };
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
