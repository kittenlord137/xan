'use strict';
// Smoothie settings ("recipe"): the schema, defaults, recipe.ini reading/writing, and the ffmpeg filter chain.
// Shared by the main process (require) and the page (global `Smoothie`). No Node-only APIs in here.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Smoothie = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  const WEIGHTINGS = ['equal', 'ascending', 'descending', 'gaussian', 'gaussian_sym', 'pyramid', 'pyramid_sym'];

  // Section and key names are exactly the ones in Smoothie's recipe.ini, so a recipe can be imported and exported.
  //   type: bool | number | slider | text | select | path
  //   live: false = kept in the recipe but not used by xan (needs software xan does not include)
  const SCHEMA = [
    {
      id: 'frame blending', title: 'Frame blending', icon: 'blur', live: true,
      about: 'Blends many frames into one to make motion blur. Footage recorded at a high frame rate (say 240) blends down to a smooth lower rate (say 60).',
      keys: [
        { key: 'enabled', label: 'Frame blending', type: 'bool', def: true },
        { key: 'fps', label: 'Output FPS', type: 'number', def: 60, min: 1, max: 1000, step: 1, hint: 'The frame rate after blending. 60 is the usual choice.' },
        { key: 'intensity', label: 'Intensity', type: 'slider', def: 1.0, min: 0, max: 5, step: 0.05, hint: '1 = every frame is blended in. Above 1 adds more blur and ghosting. Suggested maximum: 1 at 30 fps, 1.75 at 60 fps, 3 at 120 fps.' },
        { key: 'weighting', label: 'Weighting', type: 'select', def: 'equal', options: WEIGHTINGS, hint: 'How strongly each frame counts. equal: all the same. ascending: newest strongest. descending: oldest strongest. gaussian / pyramid: peak at the newest frame. _sym: peak in the middle.' },
        { key: 'bright blend', label: 'Bright blend', type: 'bool', def: false, live: false },
      ],
    },
    {
      id: 'interpolation', title: 'Interpolation', icon: 'sparkle', live: true,
      about: 'Makes new in-between frames so footage gets smoother (for example 60 fps to 240 fps). Uses ffmpeg\'s built-in motion interpolation, which is slow. Combine it with frame blending for blur.',
      keys: [
        { key: 'enabled', label: 'Interpolation', type: 'bool', def: false },
        { key: 'fps', label: 'Target FPS', type: 'text', def: '1920', hint: 'A frame rate (240) or a multiple of the source rate (2x, 4x). Very high targets take a very long time.' },
        { key: 'speed', label: 'Speed', type: 'select', def: 'medium', options: ['medium', 'fast', 'faster', 'fastest'], hint: 'medium: best quality, slowest. fastest: just blends neighbouring frames.' },
        { key: 'tuning', label: 'Tuning', type: 'select', def: 'weak', options: ['film', 'animation', 'weak', 'smooth'], live: false },
        { key: 'algorithm', label: 'Algorithm', type: 'select', def: '23', options: ['2', '13', '23'], live: false },
        { key: 'masking', label: 'Masking', type: 'bool', def: false, live: false },
        { key: 'use gpu', label: 'Use GPU', type: 'bool', def: false, live: false },
      ],
    },
    {
      id: 'timescale', title: 'Timescale', icon: 'clock', live: true,
      about: 'Speeds footage up or slows it down. If the clip was recorded slowed down, put its speed in Input and it is brought back to normal.',
      keys: [
        { key: 'in', label: 'Input speed', type: 'slider', def: 1.0, min: 0.05, max: 4, step: 0.05, hint: 'The speed the input file is playing at. 0.1 means the footage was slowed to 10%.' },
        { key: 'out', label: 'Output speed', type: 'slider', def: 1.0, min: 0.05, max: 4, step: 0.05, hint: 'The speed you want. 1.03 speeds the footage up slightly, 0.5 is slow motion.' },
      ],
    },
    {
      id: 'color grading', title: 'Color grading', icon: 'sliders', live: true,
      about: 'Basic color adjustments. 1.0 means unchanged.',
      keys: [
        { key: 'enabled', label: 'Color grading', type: 'bool', def: false },
        { key: 'brightness', label: 'Brightness', type: 'slider', def: 1.0, min: 0.2, max: 2, step: 0.05 },
        { key: 'saturation', label: 'Saturation', type: 'slider', def: 1.0, min: 0, max: 3, step: 0.05 },
        { key: 'contrast', label: 'Contrast', type: 'slider', def: 1.0, min: 0.2, max: 3, step: 0.05 },
      ],
    },
    {
      id: 'lut', title: 'LUT', icon: 'film', live: true,
      about: 'Applies a color lookup table (.cube or .3dl file).',
      keys: [
        { key: 'enabled', label: 'LUT', type: 'bool', def: false },
        { key: 'path', label: 'File', type: 'path', def: '' },
        { key: 'opacity', label: 'Opacity', type: 'slider', def: 0.2, min: 0, max: 1, step: 0.05 },
      ],
    },
    {
      id: 'flowblur', title: 'Flowblur', icon: 'blur', live: false,
      about: 'Blur that follows motion (RSMB). Needs extra software that xan does not include yet.',
      keys: [
        { key: 'enabled', label: 'Flowblur', type: 'bool', def: false },
        { key: 'masking', label: 'Masking', type: 'bool', def: false },
        { key: 'amount', label: 'Amount', type: 'slider', def: 125, min: 0, max: 200, step: 1 },
        { key: 'do blending', label: 'Blend', type: 'select', def: 'after', options: ['after', 'before'] },
      ],
    },
    {
      id: 'pre-interp', title: 'Pre-interpolation', icon: 'sparkle', live: false,
      about: 'AI frame interpolation (RIFE) before everything else. Needs extra software that xan does not include yet.',
      keys: [
        { key: 'enabled', label: 'Pre-interpolation', type: 'bool', def: false },
        { key: 'masking', label: 'Masking', type: 'bool', def: false },
        { key: 'factor', label: 'Factor', type: 'text', def: '3x' },
        { key: 'model', label: 'Model', type: 'text', def: 'rife-v4.4' },
      ],
    },
    {
      id: 'artifact masking', title: 'Artifact masking', icon: 'film', live: false,
      about: 'Hides interpolation artifacts using a mask. Needs extra software that xan does not include yet.',
      keys: [
        { key: 'enabled', label: 'Artifact masking', type: 'bool', def: false },
        { key: 'feathering', label: 'Feathering', type: 'bool', def: true },
        { key: 'folder path', label: 'Folder', type: 'text', def: '' },
        { key: 'file name', label: 'File name', type: 'text', def: '' },
      ],
    },
  ];

  // Parts of a recipe xan does not show: kept as they are so an imported recipe exports back unchanged.
  const HIDDEN = {
    output: { process: 'ffmpeg', 'enc args': 'H264 CPU', 'file format': '%FILENAME% ~ %FRUIT%', container: '.MP4' },
    'preview window': { enabled: 'no', process: 'ffplay', 'output args': '-f yuv4mpegpipe -' },
    miscellaneous: {
      'source plugin': 'bestsource', 'play ding': 'no', 'always verbose': 'no', 'dedup threshold': '0.0',
      'global output folder': '', 'source indexing': 'no',
      'ffmpeg options': '-loglevel error -i - -hide_banner -stats -stats_period 0.15',
      'ffplay options': '-loglevel quiet -i - -autoexit -window_title smoothie.preview',
    },
    console: { 'stay on top': 'no', borderless: 'no', position: 'top left', width: '900', height: '350' },
  };
  // order of sections in a written recipe
  const RECIPE_ORDER = ['interpolation', 'frame blending', 'flowblur', 'output', 'preview window', 'artifact masking',
    'miscellaneous', 'console', 'timescale', 'color grading', 'lut', 'pre-interp'];

  const clone = (o) => JSON.parse(JSON.stringify(o));
  const num = (v, d) => { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : d; };
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const truthy = (v) => (typeof v === 'boolean' ? v : /^(y|yes|true|1|on)$/i.test(String(v).trim()));

  function defaults() {
    const cfg = {};
    for (const sec of SCHEMA) {
      cfg[sec.id] = {};
      for (const k of sec.keys) cfg[sec.id][k.key] = k.def;
    }
    cfg.hidden = clone(HIDDEN);
    return cfg;
  }

  // Fill in anything missing and force every value into its allowed range, so the rest of the code can trust it.
  function normalize(input) {
    const out = defaults();
    const src = input && typeof input === 'object' ? input : {};
    for (const sec of SCHEMA) {
      const s = src[sec.id] && typeof src[sec.id] === 'object' ? src[sec.id] : {};
      for (const k of sec.keys) {
        if (!(k.key in s)) continue;
        const v = s[k.key];
        if (k.type === 'bool') out[sec.id][k.key] = truthy(v);
        else if (k.type === 'number' || k.type === 'slider') out[sec.id][k.key] = clamp(num(v, k.def), k.min, k.max);
        else if (k.type === 'select') out[sec.id][k.key] = k.options.includes(String(v)) ? String(v) : k.def;
        else out[sec.id][k.key] = String(v == null ? '' : v);
      }
    }
    const h = src.hidden && typeof src.hidden === 'object' ? src.hidden : {};
    for (const name of Object.keys(HIDDEN)) {
      const hs = h[name] && typeof h[name] === 'object' ? h[name] : {};
      for (const key of Object.keys(HIDDEN[name])) if (key in hs) out.hidden[name][key] = String(hs[key]);
    }
    return out;
  }

  // ---------------------------------------------------------------- recipe.ini
  function parseRecipe(text) {
    const raw = {};
    let section = null;
    for (const line0 of String(text || '').replace(/^﻿/, '').split(/\r?\n/)) {
      const line = line0.trim();
      if (!line || line[0] === '#' || line[0] === ';') continue;
      const m = line.match(/^\[(.+)\]$/);
      if (m) { section = m[1].trim().toLowerCase(); raw[section] = raw[section] || {}; continue; }
      if (!section) continue;
      const i = line.search(/[:=]/);
      if (i < 0) continue;
      raw[section][line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
    const cfg = {};
    for (const sec of SCHEMA) {
      if (!raw[sec.id]) continue;
      cfg[sec.id] = {};
      for (const k of sec.keys) if (k.key in raw[sec.id]) cfg[sec.id][k.key] = raw[sec.id][k.key];
    }
    cfg.hidden = {};
    for (const name of Object.keys(HIDDEN)) if (raw[name]) cfg.hidden[name] = raw[name];
    return { config: normalize(cfg), sections: Object.keys(raw).length };
  }

  function serializeRecipe(input) {
    const cfg = normalize(input);
    const fmt = (v) => (typeof v === 'boolean' ? (v ? 'yes' : 'no') : typeof v === 'number' ? String(Number.isInteger(v) ? v : +v.toFixed(4)) : String(v));
    const blocks = [];
    for (const id of RECIPE_ORDER) {
      const sec = SCHEMA.find((s) => s.id === id);
      const lines = [`[${id}]`];
      if (sec) for (const k of sec.keys) lines.push(`${k.key}: ${fmt(cfg[id][k.key])}`.replace(/: $/, ':'));
      else for (const [key, v] of Object.entries(cfg.hidden[id])) lines.push(`${key}: ${v}`.replace(/: $/, ':'));
      blocks.push(lines.join('\n'));
    }
    return blocks.join('\n\n') + '\n';
  }

  // ---------------------------------------------------------------- filter chain
  function speedOf(cfg) {
    const t = normalize(cfg).timescale;
    return t.out / t.in;
  }

  // "2x" / "240" -> frames per second (given the rate it starts from)
  function parseTargetFps(text, baseFps) {
    const s = String(text).trim().toLowerCase();
    const m = s.match(/^(\d+(?:\.\d+)?)\s*x$/);
    if (m) return parseFloat(m[1]) * baseFps;
    const n = parseFloat(s);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  // weights for n blended frames, oldest first
  function weights(kind, n) {
    if (n < 2) return [1];
    const w = [];
    for (let i = 0; i < n; i++) {
      const x = i / (n - 1);                       // 0 = oldest, 1 = newest
      let v;
      switch (kind) {
        case 'ascending': v = 0.15 + x; break;
        case 'descending': v = 0.15 + (1 - x); break;
        case 'gaussian': v = Math.exp(-Math.pow((x - 1) / 0.38, 2) / 2); break;
        case 'gaussian_sym': v = Math.exp(-Math.pow((x - 0.5) / 0.22, 2) / 2); break;
        case 'pyramid': v = 0.1 + x; break;
        case 'pyramid_sym': v = 0.1 + (1 - Math.abs(2 * x - 1)); break;
        default: v = 1;
      }
      w.push(Math.max(v, 0.001));
    }
    return w;
  }

  const num4 = (x) => String(+x.toFixed(4));
  // a filter-argument string for a file path, escaped for ffmpeg's two levels of parsing
  function lutArg(p) { return `'${String(p).replace(/\\/g, '/').replace(/:/g, '\\:')}'`; }

  const MINTERP = {
    medium: 'mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1',
    fast: 'mi_mode=mci:mc_mode=obmc:me_mode=bidir',
    faster: 'mi_mode=mci:mc_mode=obmc:me_mode=bidir:me=ds',
    fastest: 'mi_mode=blend',
  };

  // Returns {body, speed, outFps, notes[]}. `body` is a filter graph fragment (no input/output labels) or ''.
  function build(input, info) {
    const cfg = normalize(input);
    const notes = [];
    const stages = [];                      // strings, or {lut: ...}
    const speed = cfg.timescale.out / cfg.timescale.in;
    let fps = (info && info.fps) || 0;
    const baseFps = fps;
    let touched = false;

    if (Math.abs(speed - 1) > 1e-6) {
      stages.push(`setpts=PTS*${num4(cfg.timescale.in / cfg.timescale.out)}`);
      fps = fps * speed;
      touched = true;
    }

    const it = cfg.interpolation;
    if (it.enabled) {
      const target = parseTargetFps(it.fps, fps);
      if (target > fps * 1.01) {
        stages.push(`minterpolate=fps=${num4(target)}:${MINTERP[it.speed]}`);
        fps = target;
        touched = true;
        if (target > 480) notes.push('A very high interpolation rate takes a very long time.');
      } else if (target > 0) notes.push(`Interpolation skipped: the target (${num4(target)} fps) is not above the video's ${num4(fps)} fps.`);
    }

    const fb = cfg['frame blending'];
    if (fb.enabled) {
      const out = fb.fps;
      if (fps > out * 1.01) {
        const ratio = fps / out;
        let frames = Math.round(ratio * fb.intensity);
        frames = clamp(frames, 1, 1000);
        if (frames >= 2) {
          const w = weights(fb.weighting, frames).map(num4).join(' ');
          stages.push(`tmix=frames=${frames}:weights='${w}'`);
        }
        stages.push(Math.abs(ratio - Math.round(ratio)) < 0.01 ? `framestep=${Math.round(ratio)}` : `fps=${num4(out)}`);
        fps = out;
        touched = true;
      } else {
        notes.push(`Frame blending skipped: the video (${num4(fps)} fps) is not above ${num4(out)} fps, so there is nothing to blend.`);
      }
    }

    // Pin the frame rate. After joined cuts ffmpeg no longer knows the rate and would guess 25 fps, dropping frames.
    if (touched && fps > 0) stages.push(`fps=${num4(fps)}`);
    const pinned = touched;

    const cg = cfg['color grading'];
    if (cg.enabled) {
      if (cg.contrast !== 1 || cg.saturation !== 1) { stages.push(`eq=contrast=${num4(cg.contrast)}:saturation=${num4(cg.saturation)}`); touched = true; }
      if (cg.brightness !== 1) { stages.push(`lutyuv=y='clip(val*${num4(cg.brightness)},minval,maxval)'`); touched = true; }
    }

    const lut = cfg.lut;
    if (lut.enabled) {
      if (!lut.path) notes.push('LUT is on but no file is chosen, so it was skipped.');
      else { stages.push({ lut: lut.path, opacity: lut.opacity }); touched = true; }
    }

    let body = '';
    if (touched) {
      if (!pinned && fps > 0) stages.splice(0, 0, `fps=${num4(fps)}`);
      const parts = ['format=yuv420p'].concat(stages);
      // plain filters are chained with commas; a LUT with opacity needs a small split/blend graph
      let chain = [];
      const segments = [];
      let n = 0;
      for (const st of parts) {
        if (typeof st === 'string') { chain.push(st); continue; }
        if (st.opacity >= 0.999) { chain.push(`lut3d=file=${lutArg(st.lut)}`); continue; }
        const a = `s${n}a`, b = `s${n}b`, c = `s${n}c`;
        n++;
        chain.push(`split[${a}][${b}]`);
        segments.push(chain.join(','));
        segments.push(`[${b}]lut3d=file=${lutArg(st.lut)}[${c}]`);
        chain = [`[${a}][${c}]blend=all_mode=normal:all_opacity=${num4(st.opacity)}`];
      }
      segments.push(chain.join(','));
      body = segments.join(';');
    }
    return { body, speed, outFps: fps || baseFps, notes, touched };
  }

  // a speed change as an audio filter chain (atempo only accepts 0.5 to 100 per step)
  function atempoChain(speed) {
    if (Math.abs(speed - 1) < 1e-6) return '';
    const f = [];
    let s = speed;
    while (s < 0.5) { f.push('atempo=0.5'); s /= 0.5; }
    while (s > 100) { f.push('atempo=100'); s /= 100; }
    f.push(`atempo=${num4(s)}`);
    return f.join(',');
  }

  // one-line description for the editor card
  function summary(input, info) {
    const cfg = normalize(input);
    const bits = [];
    const fb = cfg['frame blending'], it = cfg.interpolation;
    if (it.enabled) bits.push(`interpolate to ${it.fps}`);
    if (fb.enabled) bits.push(`blend to ${fb.fps} fps (x${fb.intensity})`);
    if (Math.abs(cfg.timescale.out / cfg.timescale.in - 1) > 1e-6) bits.push(`speed x${num4(cfg.timescale.out / cfg.timescale.in)}`);
    if (cfg['color grading'].enabled) bits.push('color');
    if (cfg.lut.enabled && cfg.lut.path) bits.push('LUT');
    return bits.length ? bits.join(' · ') : 'nothing switched on yet';
  }

  return { SCHEMA, WEIGHTINGS, defaults, normalize, parseRecipe, serializeRecipe, build, speedOf, atempoChain, weights, summary, parseTargetFps, lutArg };
});
