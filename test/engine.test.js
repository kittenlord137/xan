'use strict';
// End-to-end test of the encoder against a real ffmpeg. Run with: npm test
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const engine = require('../lib/ffmpeg');
const Core = require('../shared/core');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipsqueeze-test-'));
let passed = 0, failed = 0;

function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? '  -> ' + detail : ''}`); }
}

async function run(payload) {
  const events = [];
  const res = await engine.exportAll(payload, (e) => events.push(e), new engine.Job());
  return { res, events };
}

const settings = (o) => Object.assign({}, Core.DEFAULT_SETTINGS, { speed: 'veryfast' }, o);

async function main() {
  const bins = engine.checkBinaries();
  console.log(`ffmpeg: ${bins.version}\n  x264=${bins.x264} x265=${bins.x265}  (${bins.ffmpegPath})`);
  if (!bins.ok) throw new Error('ffmpeg/ffprobe not runnable');

  // source clip: 1080p30, 12 s, two audio tracks, deliberately heavy
  const src = path.join(tmp, 'source clip (test).mp4');
  const gen = spawnSync(engine.FFMPEG, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440', '-f', 'lavfi', '-i', 'sine=frequency=880',
    '-map', '0:v', '-map', '1:a', '-map', '2:a', '-t', '12',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src,
  ]);
  if (gen.status !== 0) throw new Error('could not make test clip: ' + gen.stderr);

  const info = await engine.probe(src);
  console.log('\nprobe');
  check('duration ~12s', Math.abs(info.duration - 12) < 0.3, info.duration);
  check('1920x1080 @30', info.width === 1920 && info.height === 1080 && Math.round(info.fps) === 30);
  check('2 audio tracks', info.audioStreams === 2);
  const srcSize = fs.statSync(src).size;
  console.log(`  source: ${Core.fmtBytes(srcSize)}`);

  const outInfo = async (p) => engine.probe(p);
  const base = (segments, o) => Object.assign({ files: [{ path: src, info, segments, merge: false }], settings: settings({}), outDir: tmp }, o);
  const whole = [{ start: 0, end: info.duration }];

  console.log('\nconstant quality, whole file');
  {
    const { res, events } = await run(base(whole, { settings: settings({ preset: 'balanced' }) }));
    check('export ok', res.ok, res.error);
    const o = res.results[0];
    check('named *_compressed.mp4 next to outDir', path.basename(o.output) === 'source clip (test)_compressed.mp4', o.output);
    const oi = await outInfo(o.output);
    check('smaller than source', o.size < srcSize, `${o.size} vs ${srcSize}`);
    check('duration kept', Math.abs(oi.duration - info.duration) < 0.4, oi.duration);
    check('both audio tracks kept', oi.audioStreams === 2, oi.audioStreams);
    check('h264 + yuv420p', oi.vcodec === 'h264');
    check('progress reached 100%', events.some((e) => e.type === 'progress' && e.overall === 1));
    check('"whole" flag set', o.whole === true);
  }

  console.log('\nsecond run does not overwrite');
  {
    const { res } = await run(base(whole));
    check('export ok', res.ok, res.error);
    check('named "(1)"', /_compressed \(1\)\.mp4$/.test(res.results[0].output), res.results[0].output);
  }

  console.log('\nH.265 + 720p + first audio track only');
  {
    const { res } = await run(base(whole, { settings: settings({ codec: 'h265', height: 720, audio: 'first', preset: 'small' }) }));
    check('export ok', res.ok, res.error);
    if (res.ok) {
      const oi = await outInfo(res.results[0].output);
      check('hevc', oi.vcodec === 'hevc', oi.vcodec);
      check('720 high', oi.height === 720 && oi.width === 1280, `${oi.width}x${oi.height}`);
      check('1 audio track', oi.audioStreams === 1, oi.audioStreams);
    }
  }

  console.log('\nno audio, 15 fps');
  {
    const { res } = await run(base(whole, { settings: settings({ audio: 'none', fps: 15, height: 480 }) }));
    check('export ok', res.ok, res.error);
    if (res.ok) {
      const oi = await outInfo(res.results[0].output);
      check('no audio', oi.audioStreams === 0, oi.audioStreams);
      check('~15 fps', Math.abs(oi.fps - 15) < 0.6, oi.fps);
      check('480 high', oi.height === 480, oi.height);
    }
  }

  for (const codec of ['h264', 'h265']) {
    console.log(`\nfit under 3 MB (${codec}, two-pass)`);
    const { res, events } = await run(base(whole, { settings: settings({ preset: 'custom', customMB: 3, codec }) }));
    check('export ok', res.ok, res.error);
    if (res.ok) {
      const sz = res.results[0].size;
      check(`size <= 3,000,000 bytes`, sz <= 3e6, `${sz}`);
      check('not wastefully small (> 1.5 MB)', sz > 1.5e6, `${sz}`);
      console.log(`       result: ${Core.fmtBytes(sz)}`);
      const prog = events.filter((e) => e.type === 'progress').map((e) => e.overall);
      check('progress reported', prog.length > 2);
    }
  }

  console.log('\nsegments');
  {
    const segs = [{ start: 1, end: 3.5 }, { start: 6, end: 10 }];
    const sep = await run(base(segs, { settings: settings({ preset: 'high' }) }));
    check('separate: ok', sep.res.ok, sep.res.error);
    check('separate: 2 files', sep.res.ok && sep.res.results.length === 2);
    if (sep.res.ok) {
      const d1 = (await outInfo(sep.res.results[0].output)).duration;
      const d2 = (await outInfo(sep.res.results[1].output)).duration;
      check('separate: durations 2.5s and 4s', Math.abs(d1 - 2.5) < 0.25 && Math.abs(d2 - 4) < 0.25, `${d1}, ${d2}`);
      check('separate: timestamp names', /-00\.00\.01\.000-00\.00\.03\.500_compressed\.mp4$/.test(sep.res.results[0].output), sep.res.results[0].output);
      check('separate: not flagged whole', sep.res.results[0].whole === false);
    }
    const payload = base(segs, { settings: settings({ preset: 'high' }) });
    payload.files[0].merge = true;
    const mer = await run(payload);
    check('merge: ok', mer.res.ok, mer.res.error);
    if (mer.res.ok) {
      check('merge: 1 file', mer.res.results.length === 1);
      const oi = await outInfo(mer.res.results[0].output);
      check('merge: duration ~6.5s', Math.abs(oi.duration - 6.5) < 0.35, oi.duration);
      check('merge: first audio track kept', oi.audioStreams === 1, oi.audioStreams);
    }
    // merge + target size + scaling
    const p2 = base(segs, { settings: settings({ preset: 'custom', customMB: 1.5, height: 480 }) });
    p2.files[0].merge = true;
    const m2 = await run(p2);
    check('merge + size target: ok', m2.res.ok, m2.res.error);
    if (m2.res.ok) check('merge + size target: <= 1.5 MB', m2.res.results[0].size <= 1.5e6, `${m2.res.results[0].size}`);
  }

  console.log('\nerrors and cancel');
  {
    const { res } = await run(base(whole, { settings: settings({ preset: 'custom', customMB: 0.02 }) }));
    check('absurdly small target is refused', !res.ok && /too small/.test(res.error || ''), res.error);
    check('nothing written for refused export', !fs.readdirSync(tmp).some((f) => f.includes('0.02')));

    const bad = await run(base([], {}));
    check('no segments is refused', !bad.res.ok, bad.res.error);

    const job = new engine.Job();
    const before = new Set(fs.readdirSync(tmp));
    const p = engine.exportAll(base(whole, { settings: settings({ preset: 'high', speed: 'slow' }) }), () => {}, job);
    setTimeout(() => job.cancel(), 700);
    const r = await p;
    check('cancel reported', r.cancelled === true, JSON.stringify(r));
    const leftovers = fs.readdirSync(tmp).filter((f) => !before.has(f));
    check('partial file removed', leftovers.length === 0, leftovers.join(','));
  }

  console.log('\nbroken file');
  {
    const junk = path.join(tmp, 'not-a-video.mp4');
    fs.writeFileSync(junk, 'hello');
    let msg = null;
    try { await engine.probe(junk); } catch (e) { msg = e.message; }
    check('probe rejects non-video', !!msg, msg);
  }

  console.log('\nshared helpers');
  check('parseTime 1:15.5', Core.parseTime('1:15.5') === 75.5);
  check('parseTime 00:01:15,764', Math.abs(Core.parseTime('00:01:15,764') - 75.764) < 1e-9);
  check('parseTime rejects junk', isNaN(Core.parseTime('abc')) && isNaN(Core.parseTime('1:2:3:4')));
  check('fmtTime', Core.fmtTime(75.764) === '00:01:15.764');
  check('stamp', Core.stamp(75.764) === '00.01.15.764');

  console.log(`\n${passed} passed, ${failed} failed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
