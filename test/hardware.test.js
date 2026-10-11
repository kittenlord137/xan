'use strict';
// Graphics card encoding: argument shapes, and the automatic fallback to the processor when the card cannot encode.
// (This machine has no graphics card encoder, so the "card" is faked and is expected to fail.)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let passed = 0, failed = 0;
const check = (name, cond, detail) => {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? '  -> ' + String(detail).slice(0, 300) : ''}`); }
};

(async () => {
  // 1. nothing to find on a machine without a card
  delete process.env.XAN_FORCE_HW;
  let engine = require('../lib/ffmpeg');
  console.log('detection');
  const none = await engine.detectHardware();
  check('no graphics card encoder here: detection says so', none === null, JSON.stringify(none));

  console.log('\nencoder options');
  const nv = { kind: 'nvenc', encoder: 'h264_nvenc' };
  const a = engine.hwVideoArgs(nv, { q: 28 }).join(' ');
  check('NVENC constant quality uses -cq with no bitrate cap', /-c:v h264_nvenc/.test(a) && /-rc vbr -cq 28 -b:v 0/.test(a), a);
  const b = engine.hwVideoArgs(nv, { kbps: 2000 }).join(' ');
  check('NVENC target size uses a bitrate with a ceiling', /-b:v 2000k -maxrate 2300k -bufsize 4000k/.test(b), b);
  const c = engine.hwVideoArgs({ kind: 'amf', encoder: 'hevc_amf' }, { q: 33 }).join(' ');
  check('AMD constant quality uses fixed quantizers', /-c:v hevc_amf/.test(c) && /-rc cqp -qp_i 33 -qp_p 33/.test(c), c);
  const d = engine.hwVideoArgs({ kind: 'qsv', encoder: 'h264_qsv' }, { q: 25 }).join(' ');
  check('Intel constant quality uses -global_quality and nv12', /-global_quality 25/.test(d) && /-pix_fmt nv12/.test(d), d);

  // 2. a faked card that fails: the export must still finish on the processor
  process.env.XAN_FORCE_HW = 'nvenc';
  // a fresh copy of the engine, so the detection cache sees the faked card
  for (const k of Object.keys(require.cache)) if (/lib[\\/]ffmpeg\.js$/.test(k)) delete require.cache[k];
  engine = require('../lib/ffmpeg');
  const Core = require('../shared/core');
  const forced = await engine.detectHardware();
  check('test hook: a pretend NVIDIA card is reported', forced && forced.kind === 'nvenc' && forced.h264 && forced.h265, JSON.stringify(forced));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xan-hw-'));
  const src = path.join(tmp, 'clip.mp4');
  const gen = spawnSync(engine.FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '5', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src]);
  if (gen.status !== 0) throw new Error('could not make a test clip');
  const info = await engine.probe(src);
  const go = async (settings) => {
    const notes = [];
    const res = await engine.exportAll(
      { files: [{ path: src, info, segments: [{ start: 0, end: info.duration }], merge: false }], settings: Object.assign({}, Core.DEFAULT_SETTINGS, { speed: 'veryfast' }, settings), outDir: tmp },
      (e) => { if (e.type === 'item' && e.note) notes.push(e.note); }, new engine.Job());
    return { res, notes };
  };

  console.log('\nfallback to the processor');
  let r = await go({ preset: 'balanced', encoder: 'auto' });
  check('constant quality: card fails, export still succeeds', r.res.ok && fs.existsSync(r.res.results[0].output), r.res.error);
  check('it said it tried the card, then switched', r.notes.some((n) => /NVIDIA graphics card/.test(n)) && r.notes.some((n) => /using the processor/.test(n)), r.notes.join(' | '));
  const oi = await engine.probe(r.res.results[0].output);
  check('and the file is a good video', Math.abs(oi.duration - 5) < 0.3 && oi.vcodec === 'h264', JSON.stringify(oi));

  r = await go({ preset: 'size10', encoder: 'auto', codec: 'h265' });
  check('size target (H.265): card fails, the two-pass export still fits', r.res.ok && r.res.results[0].size <= 10e6, r.res.error || r.res.results[0].size);

  r = await go({ preset: 'balanced', encoder: 'cpu' });
  check('"Processor only" never touches the card', r.res.ok && !r.notes.some((n) => /graphics card/.test(n)), r.notes.join(' | '));

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
