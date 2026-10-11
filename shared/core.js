/*
 * Shared helpers used by both the UI (renderer) and the encoder (main process):
 * presets, size math, time/size formatting. Plain UMD so it loads with require()
 * in Node and with a <script> tag in the page.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const H265_CRF_OFFSET = 5;   // x265 looks like x264 at a CRF ~5 higher
  const AUDIO_KBPS = 128;
  const SIZE_SAFETY = 0.95;    // aim a little under the target to absorb container overhead
  const MIN_VIDEO_KBPS = 50;

  // mode 'crf' = constant quality, mode 'size' = two-pass encode that fits under a size (decimal MB)
  const PRESETS = [
    { id: 'size10', label: 'Fit under 10 MB', mode: 'size', targetMB: 10 },
    { id: 'size25', label: 'Fit under 25 MB', mode: 'size', targetMB: 25 },
    { id: 'size50', label: 'Fit under 50 MB', mode: 'size', targetMB: 50 },
    { id: 'high', label: 'High quality', mode: 'crf', crf: 23 },
    { id: 'balanced', label: 'Balanced', mode: 'crf', crf: 28 },
    { id: 'small', label: 'Smallest file', mode: 'crf', crf: 32 },
    { id: 'custom', label: 'Custom size…', mode: 'size', targetMB: null },
    // only offered by the Smoothie page (output quality, not a size target)
    { id: 'q-max', label: 'Near lossless', mode: 'crf', crf: 14, hidden: true },
    { id: 'q-high', label: 'Very high', mode: 'crf', crf: 18, hidden: true },
  ];

  const DEFAULT_SETTINGS = {
    preset: 'balanced', customMB: 20, codec: 'h264',
    height: 0, fps: 0, audio: 'all', speed: 'medium',
  };

  function resolve(s) {
    s = Object.assign({}, DEFAULT_SETTINGS, s || {});
    const p = PRESETS.find((x) => x.id === s.preset) || PRESETS.find((x) => x.id === 'balanced');
    const codec = s.codec === 'h265' ? 'h265' : 'h264';
    const out = {
      presetId: p.id,
      mode: p.mode,
      codec,
      height: Number(s.height) || 0,
      fps: Number(s.fps) || 0,
      audio: ['all', 'first', 'none'].includes(s.audio) ? s.audio : 'all',
      speed: ['veryfast', 'medium', 'slow'].includes(s.speed) ? s.speed : 'medium',
    };
    if (p.mode === 'crf') {
      out.baseCrf = p.crf;
      out.crf = p.crf + (codec === 'h265' ? H265_CRF_OFFSET : 0);
    } else {
      out.targetMB = p.targetMB != null ? p.targetMB : Number(s.customMB);
    }
    return out;
  }

  // How many audio tracks end up in the output.
  function audioCount(info, audioMode, merged) {
    if (!info.audioStreams || audioMode === 'none') return 0;
    if (audioMode === 'first' || merged) return 1;   // merging cuts only carries the first track
    return info.audioStreams;
  }

  function outputDims(info, height) {
    let w = info.width, h = info.height;
    if (height && h > height) {
      w = Math.round((w * height) / h / 2) * 2;
      h = height;
    }
    return { w, h };
  }

  function outputFps(info, fps) {
    return fps && info.fps > fps + 1 ? fps : info.fps;
  }

  // Video bitrate (kbps) for a "fit under X MB" encode of `duration` seconds.
  function sizeModeVideoKbps(targetMB, duration, nAudio, srcVideoKbps, scale) {
    const total = ((targetMB * 8000) / duration) * (scale || SIZE_SAFETY);
    let v = total - nAudio * AUDIO_KBPS;
    if (srcVideoKbps) v = Math.min(v, srcVideoKbps * 0.9); // no point exceeding the source
    return v;
  }

  // null when fine, otherwise {level: 'error' | 'warn', text}
  function checkTarget(settings, info, duration, merged) {
    const r = resolve(settings);
    if (r.mode !== 'size') return null;
    if (!(r.targetMB > 0)) return { level: 'error', text: 'Enter a target size in MB.' };
    const n = audioCount(info, r.audio, merged);
    const v = sizeModeVideoKbps(r.targetMB, duration, n, 0);
    if (v < MIN_VIDEO_KBPS) {
      return {
        level: 'error',
        text: `${r.targetMB} MB is too small for ${fmtDur(duration)} of video. Pick a bigger size or trim the clip.`,
      };
    }
    const { w, h } = outputDims(info, r.height);
    const bpp = (v * 1000) / (w * h * outputFps(info, r.fps));
    if (bpp < 0.03) {
      return {
        level: 'warn',
        text: 'Tight fit: expect visible compression. A lower resolution or frame rate will look sharper.',
      };
    }
    return null;
  }

  // Rough output size. `bound` = true means "at most this" (size-target modes).
  function estimateBytes(settings, info, duration, merged) {
    const r = resolve(settings);
    const n = audioCount(info, r.audio, merged);
    const srcKbps = info.videoKbps || info.totalKbps || 0;
    const srcVideoBytes = srcKbps * 125 * duration;
    const audioBytes = n * AUDIO_KBPS * 125 * duration;
    if (r.mode === 'size') {
      const cap = (r.targetMB || 0) * 1e6;
      const srcTotal = srcVideoBytes + audioBytes;
      return { bytes: srcTotal ? Math.min(cap, srcTotal) : cap, bound: true };
    }
    const { w, h } = outputDims(info, r.height);
    const fps = outputFps(info, r.fps);
    // empirical bits-per-pixel for x264 around CRF 23, halving every +6 CRF; x265 ~35% leaner
    const bpp = 0.075 * Math.pow(2, (23 - r.baseCrf) / 6) * (r.codec === 'h265' ? 0.65 : 1);
    let video = (bpp * w * h * fps * duration) / 8;
    if (srcVideoBytes) video = Math.min(video, srcVideoBytes);
    return { bytes: video + audioBytes, bound: false };
  }

  // ---- formatting -------------------------------------------------------
  const pad = (n, l) => String(n).padStart(l || 2, '0');

  function fmtTime(t, withMs) {
    if (!isFinite(t) || t < 0) t = 0;
    const ms = Math.round(t * 1000);
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const r = ms % 1000;
    return `${pad(h)}:${pad(m)}:${pad(s)}` + (withMs === false ? '' : '.' + pad(r, 3));
  }

  function fmtDur(t) {
    if (!isFinite(t) || t < 0) t = 0;
    if (t < 60) return t.toFixed(1) + 's';
    const total = Math.round(t);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }

  // 00.01.15.764 - safe for file names
  function stamp(t) {
    return fmtTime(t).replace(/:/g, '.');
  }

  // Accepts "75.7", "1:15.7", "00:01:15.764" (comma decimals too). NaN when invalid.
  function parseTime(str) {
    str = String(str).trim().replace(',', '.');
    if (!/^\d+(:\d+){0,2}(\.\d+)?$/.test(str)) return NaN;
    return str.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
  }

  function fmtBytes(b) {
    if (!isFinite(b) || b < 0) b = 0;
    if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
    if (b >= 1e6) return (b / 1e6).toFixed(1) + ' MB';
    return Math.max(1, Math.round(b / 1e3)) + ' KB';
  }

  return {
    PRESETS, DEFAULT_SETTINGS, AUDIO_KBPS, SIZE_SAFETY, MIN_VIDEO_KBPS, H265_CRF_OFFSET,
    resolve, audioCount, outputDims, outputFps, sizeModeVideoKbps, checkTarget, estimateBytes,
    fmtTime, fmtDur, stamp, parseTime, fmtBytes,
  };
});
