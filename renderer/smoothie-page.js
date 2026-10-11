/*
 * The Smoothie page: its own clips, preview and Render button, plus the recipe settings.
 * It never touches the compression editor; a Smoothie render just makes <name>_smoothie.mp4.
 */
(() => {
  'use strict';
  const { $, api, esc, basename, dirname, ico, toast, openModal, closeModal, askName, confirmBox } = window.UI;
  const UI = window.UI;
  const Core = window.Core;
  const Smoothie = window.Smoothie;

  const KEY = 'xan.smoothie';
  const state = {
    active: '',
    configs: [],
    out: { dir: '', quality: 'q-high', codec: 'h264', audio: 'all' },
    clips: [],      // {path, name, info, proxy, proxyFailed}
    cur: -1,
  };
  const closed = new Set();       // cards the user folded away
  let initDone = false;
  let rife = { status: null, busy: false, frac: 0, error: '' };

  const curCfg = () => state.configs.find((c) => c.id === state.active) || state.configs[0];
  const clip = () => state.clips[state.cur] || null;
  const newId = () => 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);

  // ------------------------------------------------------------ saving
  function load() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) { /* first run */ }
    const configs = s && Array.isArray(s.configs)
      ? s.configs.filter((c) => c && c.id).map((c) => ({ id: String(c.id), name: String(c.name || 'Config').slice(0, 40), cfg: Smoothie.normalize(c.cfg) }))
      : [];
    if (!configs.length) configs.push({ id: 'default', name: 'Default', cfg: Smoothie.defaults() });
    state.configs = configs;
    state.active = s && configs.some((c) => c.id === s.active) ? s.active : configs[0].id;
    if (s && s.out) {
      if (typeof s.out.dir === 'string') state.out.dir = s.out.dir;
      if (['q-max', 'q-high', 'high', 'balanced'].includes(s.out.quality)) state.out.quality = s.out.quality;
      if (['h264', 'h265'].includes(s.out.codec)) state.out.codec = s.out.codec;
      if (['all', 'first', 'none'].includes(s.out.audio)) state.out.audio = s.out.audio;
    }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify({ active: state.active, configs: state.configs, out: state.out })); } catch (_) { /* storage unavailable */ }
  }
  function uniqueName(name, exceptId) {
    const taken = new Set(state.configs.filter((c) => c.id !== exceptId).map((c) => c.name.toLowerCase()));
    let n = name || 'Config', i = 2;
    while (taken.has(n.toLowerCase())) n = `${name} ${i++}`;
    return n;
  }

  // ------------------------------------------------------------ clips + player
  const DIRECT_CODECS = ['h264', 'vp8', 'vp9', 'av1'];
  const needsProxy = (info) => {
    const pix = info.pixFmt || '';
    return !DIRECT_CODECS.includes(info.vcodec) || (pix !== '' && !/^yuvj?420p$/.test(pix));
  };
  const NO_PREVIEW = 'No preview is available for this video.\nYou can still render it.';

  function playerMsg(text) {
    const el = $('smPlayerMsg');
    el.textContent = text || '';
    el.classList.toggle('hidden', !text);
  }

  function loadVideo(c) {
    const v = $('smVideo');
    playerMsg('');
    $('smProxyBadge').classList.toggle('hidden', !c.proxy);
    if (!c.proxy && !c.proxyFailed && needsProxy(c.info)) { buildProxy(c); return; }
    if (c.proxyFailed && needsProxy(c.info)) { playerMsg(NO_PREVIEW); return; }
    v.src = api.fileUrl(c.proxy || c.path);
    v.load();
  }
  async function buildProxy(c) {
    const v = $('smVideo');
    v.removeAttribute('src'); v.load();
    playerMsg('Preparing a preview of this video…\nThe render always uses the original.');
    if (!c.proxyPromise) c.proxyPromise = api.makeProxy(c.path);
    const res = await c.proxyPromise;
    c.proxyPromise = null;
    if (res.ok) c.proxy = res.path; else c.proxyFailed = true;
    if (clip() === c) loadVideo(c);
  }

  async function addPaths(paths) {
    if (!paths || !paths.length) return;
    if (UI.busy) { toast('Wait for the render to finish first.', 'warn'); return; }
    let first = -1;
    const failed = [];
    for (const p of paths) {
      const at = state.clips.findIndex((c) => c.path === p);
      if (at >= 0) { if (first < 0) first = at; continue; }
      const res = await api.probe(p);
      if (!res.ok) { failed.push(`${basename(p)}: ${res.error}`); continue; }
      state.clips.push({ path: p, name: res.info.name, info: res.info, proxy: null, proxyFailed: false });
      if (first < 0) first = state.clips.length - 1;
    }
    if (failed.length) toast(failed[0] + (failed.length > 1 ? `  (+${failed.length - 1} more)` : ''), 'error');
    if (first >= 0) select(first);
  }
  async function openDialog() {
    if (UI.busy) return;
    addPaths(await api.openFilesDialog());
  }

  function select(i) {
    state.cur = i;
    const c = clip();
    if (c) loadVideo(c);
    renderClips();
    renderOut();
    renderSummary();
  }

  function removeClip(i) {
    if (UI.busy) return;
    const was = state.cur;
    state.clips.splice(i, 1);
    if (!state.clips.length) {
      state.cur = -1;
      const v = $('smVideo'); v.removeAttribute('src'); v.load();
      renderClips(); renderOut(); renderSummary();
      return;
    }
    select(Math.max(0, Math.min(was > i ? was - 1 : was, state.clips.length - 1)));
  }

  function renderClips() {
    const has = state.clips.length > 0;
    $('smDrop').classList.toggle('hidden', has);
    $('smPlayer').classList.toggle('hidden', !has);
    $('smClips').classList.toggle('hidden', !has);
    $('smFileCount').textContent = has ? `${state.clips.length} clip${state.clips.length === 1 ? '' : 's'}` : '';
    $('smClipList').innerHTML = state.clips.map((c, i) => {
      const f = c.info;
      return `<div class="clip-row${i === state.cur ? ' selected' : ''}" data-i="${i}">
        <div class="clip-main"><b title="${esc(c.path)}">${esc(c.name)}</b>
        <span>${f.width}×${f.height} · ${Math.round(f.fps * 100) / 100} fps · ${Core.fmtDur(f.duration)} · ${Core.fmtBytes(f.size)}</span></div>
        <button class="seg-x" data-rm="${i}" title="Remove this clip">${ico('x')}</button></div>`;
    }).join('');
  }

  // ------------------------------------------------------------ output panel
  function renderOut() {
    const o = state.out;
    $('smQuality').value = o.quality;
    $('smCodec').value = o.codec;
    const c = clip();
    const n = c ? c.info.audioStreams : 0;
    const audio = $('smAudio');
    if (c && n === 0) { audio.innerHTML = '<option value="none">No audio in this video</option>'; audio.disabled = true; }
    else {
      audio.disabled = false;
      audio.innerHTML = n > 1
        ? `<option value="all">Keep all ${n} tracks</option><option value="first">First track only</option><option value="none">Remove</option>`
        : '<option value="all">Keep</option><option value="none">Remove</option>';
      audio.value = n === 1 && o.audio === 'first' ? 'all' : o.audio;
    }
    const x265 = !window.__binaries || window.__binaries.x265 !== false;
    const h265 = $('smCodec').querySelector('option[value="h265"]');
    h265.disabled = !x265;
    if (!x265 && o.codec === 'h265') { o.codec = 'h264'; $('smCodec').value = 'h264'; }
    $('smOutDirText').textContent = o.dir ? `Save to: ${basename(o.dir) || o.dir}` : 'Save next to the original';
    $('smOutDir').title = o.dir || 'Rendered videos are saved next to the original. Click to choose a folder.';
    $('smOutReset').classList.toggle('hidden', !o.dir);
    $('smRender').disabled = !state.clips.length || UI.busy;
    $('smRenderText').textContent = state.clips.length > 1 ? `Render ${state.clips.length} clips` : 'Render';
  }

  function renderSummary() {
    const c = curCfg();
    const f = clip();
    const el = $('smSum');
    if (el) el.textContent = `Does: ${Smoothie.summary(c.cfg, f ? f.info : null)}`;
    const note = $('smNote');
    let text = '';
    if (f) {
      try {
        const plan = Smoothie.build(c.cfg, f.info);
        if (plan.notes.length) text = plan.notes[0];
        else if (!plan.touched) text = 'Nothing to do yet. Switch an effect on in the settings.';
      } catch (_) { /* ignore */ }
    }
    note.textContent = text;
    note.classList.toggle('hidden', !text);
  }

  // ------------------------------------------------------------ settings cards
  const fmt = (k, v) => (k.step >= 1 ? String(Math.round(v)) : String(+Number(v).toFixed(2)));
  const pct = (k, v) => Math.max(0, Math.min(100, ((v - k.min) / (k.max - k.min)) * 100));

  function row(sec, k, v, cfg) {
    if (k.hidden) return '';
    const dead = !sec.live || k.live === false;
    const at = `data-sec="${esc(sec.id)}" data-key="${esc(k.key)}"${dead ? ' disabled' : ''}`;
    const hint = k.hint ? `<div class="opt-hint">${esc(k.hint)}</div>` : '';
    const tag = k.live === false && sec.live ? '<em class="tag">Not used</em>' : '';
    const cls = dead ? ' dead' : '';
    switch (k.type) {
      case 'bool':
        return `<label class="opt${k.key === 'enabled' ? ' master' : ''}${cls}"><input type="checkbox" ${at}${v ? ' checked' : ''}><span>${esc(k.label)}</span>${tag}</label>`;
      case 'slider':
        return `<div class="opt-col${cls}"><div class="opt-top"><span>${esc(k.label)}</span><b class="sl-val">${fmt(k, v)}</b></div>
          <input type="range" class="range" ${at} min="${k.min}" max="${k.max}" step="${k.step}" value="${v}" style="--p:${pct(k, v)}%">${hint}</div>`;
      case 'select':
        return `<div class="opt-col${cls}"><div class="opt-top"><span>${esc(k.label)}</span>${tag}</div>
          <select ${at}>${k.options.map((o) => `<option value="${esc(o)}"${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>${hint}</div>`;
      case 'number':
        return `<div class="opt-col${cls}"><div class="opt-top"><span>${esc(k.label)}</span></div>
          <input type="number" ${at} min="${k.min}" max="${k.max}" step="${k.step}" value="${v}">${hint}</div>`;
      case 'path':
        return `<div class="opt-col${cls}"><div class="opt-top"><span>${esc(k.label)}</span></div>
          <div class="path-row"><div class="path-name${v ? ' set' : ''}" title="${esc(v)}">${v ? esc(basename(v)) : 'No file chosen'}</div>
          <button class="secondary" data-act="lut-pick"${dead ? ' disabled' : ''}>Choose…</button>
          ${v ? '<button class="tiny" data-act="lut-clear" title="Remove"><svg class="i"><use href="#i-x"/></svg></button>' : ''}</div>${hint}</div>`;
      case 'maskfile': {
        const full = Smoothie.maskPathOf(cfg);
        return `<div class="opt-col${cls}"><div class="opt-top"><span>${esc(k.label)}</span></div>
          <div class="path-row"><div class="path-name${v ? ' set' : ''}" title="${esc(full)}">${v ? esc(v) : 'No file chosen'}</div>
          <button class="secondary" data-act="mask-pick"${dead ? ' disabled' : ''}>Choose…</button>
          ${v ? '<button class="tiny" data-act="mask-clear" title="Remove"><svg class="i"><use href="#i-x"/></svg></button>' : ''}</div>${hint}</div>`;
      }
      case 'rife':
        return '<div class="opt-col rife-row" id="rifeRow"></div>';
      default:
        return `<div class="opt-col${cls}"><div class="opt-top"><span>${esc(k.label)}</span>${tag}</div>
          <input type="text" ${at} value="${esc(v)}" spellcheck="false">${hint}</div>`;
    }
  }

  function card(sec, cfg) {
    const master = sec.keys.find((k) => k.key === 'enabled');
    const off = master && !cfg[sec.id].enabled;
    const shut = closed.has(sec.id);
    const badge = sec.badge ? `<em class="tag">${esc(sec.badge)}</em>` : '';
    return `<div class="panel${shut ? ' collapsed' : ''}" data-card="${esc(sec.id)}">
      <div class="panel-head"><svg class="i ph-ico"><use href="#i-${sec.icon}"/></svg><h2>${esc(sec.title)}</h2>${badge}<svg class="i chev"><use href="#i-chev-d"/></svg></div>
      <div class="pb"><div class="pb-inner"><div class="sm-body${off ? ' off' : ''}"><p class="sm-about">${esc(sec.about)}</p>${sec.keys.map((k) => row(sec, k, cfg[sec.id][k.key], cfg)).join('')}</div></div></div>
    </div>`;
  }

  const options = () => state.configs.map((c) => `<option value="${esc(c.id)}"${c.id === state.active ? ' selected' : ''}>${esc(c.name)}</option>`).join('');

  function renderSettings() {
    const c = curCfg();
    if (!initDone) {
      // effects that are off start folded away, except the three everyone uses
      for (const s of Smoothie.SCHEMA) {
        const m = s.keys.find((k) => k.key === 'enabled');
        if (m && !c.cfg[s.id].enabled && !['frame blending', 'interpolation', 'timescale'].includes(s.id)) closed.add(s.id);
      }
      initDone = true;
    }
    $('smTop').innerHTML = `
      <div class="panel-head" style="cursor:default"><svg class="i ph-ico"><use href="#i-sparkle"/></svg><h2>Recipe</h2></div>
      <div class="opt-col"><div class="opt-top"><span>Config</span></div><select id="smSelect">${options()}</select></div>
      <div class="btn-line">
        <button class="secondary" data-act="sm-new">New</button>
        <button class="secondary" data-act="sm-rename">Rename</button>
        <button class="secondary" data-act="sm-delete"${state.configs.length < 2 ? ' disabled' : ''}>Delete</button>
        <button class="secondary" data-act="sm-reset">Reset</button>
        <button class="secondary" data-act="sm-import">${ico('open')}Import</button>
        <button class="secondary" data-act="sm-export">${ico('export')}Export</button>
      </div>
      <div class="sm-line" id="smSum"></div>
      <div class="sm-line warn hidden" id="smNote"></div>`;
    const by = (id) => Smoothie.SCHEMA.find((s) => s.id === id);
    $('smCards').innerHTML = ['frame blending', 'interpolation', 'timescale', 'color grading', 'lut', 'flowblur', 'pre-interp', 'artifact masking']
      .map((id) => card(by(id), c.cfg)).join('');
    renderSummary();
    renderRife();
  }

  // ------------------------------------------------------------ RIFE download row
  async function refreshRife() {
    try { rife.status = await api.rifeStatus(curCfg().cfg['pre-interp'].model); } catch (_) { rife.status = null; }
    renderRife();
  }
  function renderRife() {
    const el = $('rifeRow');
    if (!el) return;
    const model = curCfg().cfg['pre-interp'].model;
    const st = rife.status;
    let html;
    if (rife.busy) {
      html = `<div class="opt-top"><span>Downloading ${esc(model)}…</span><b class="sl-val">${Math.round(rife.frac * 100)}%</b></div>
        <div class="bar thin"><div style="width:${Math.round(rife.frac * 100)}%"></div></div>
        <div class="btn-line"><button class="secondary" data-act="rife-cancel">Cancel</button></div>`;
    } else if (st && st.installed) {
      html = `<div class="opt-top"><span>RIFE (${esc(st.model)})</span><em class="tag ok">Ready</em></div>
        <div class="opt-hint">Downloaded. It runs on your graphics card (Vulkan).</div>`;
    } else {
      html = `<div class="opt-top"><span>RIFE (${esc(model)})</span><em class="tag warn">Not downloaded</em></div>
        <div class="btn-line"><button class="secondary" data-act="rife-install">${ico('export')}Download (about 13 MB)</button></div>
        <div class="opt-hint">One time only. It comes from the RIFE project's release page on GitHub.</div>${rife.error ? `<div class="opt-hint err">${esc(rife.error)}</div>` : ''}`;
    }
    el.innerHTML = html;
  }
  async function installRife() {
    if (rife.busy) return;
    rife = { status: rife.status, busy: true, frac: 0, error: '' };
    renderRife();
    const off = api.onRifeProgress((f) => { rife.frac = f; renderRife(); });
    let res;
    try { res = await api.rifeInstall(curCfg().cfg['pre-interp'].model); } catch (e) { res = { ok: false, error: e.message }; }
    off();
    rife.busy = false;
    if (res.ok) { rife.status = res.status; rife.error = ''; toast('RIFE is ready.', 'ok'); }
    else rife.error = res.error === 'Cancelled' ? '' : res.error;
    renderRife();
  }

  // ------------------------------------------------------------ config actions
  function changed() {
    save();
    renderSummary();
  }
  function addConfig(name, cfg) {
    const c = { id: newId(), name: uniqueName(name), cfg: Smoothie.normalize(cfg) };
    state.configs.push(c);
    state.active = c.id;
    return c;
  }

  async function action(act) {
    const c = curCfg();
    if (act === 'sm-new') {
      const name = await askName('New config', uniqueName(c.name + ' copy'), 'Create');
      if (!name) return;
      addConfig(name, JSON.parse(JSON.stringify(c.cfg)));
      save(); renderSettings(); refreshRife(); toast(`Created "${curCfg().name}" from the current settings.`, 'ok');
    } else if (act === 'sm-rename') {
      const name = await askName('Rename config', c.name, 'Rename');
      if (!name) return;
      c.name = uniqueName(name, c.id);
      save(); renderSettings(); refreshRife();
    } else if (act === 'sm-delete') {
      if (state.configs.length < 2) return;
      if (!(await confirmBox('Delete this config?', `"${c.name}" will be removed. This can't be undone.`, 'Delete'))) return;
      state.configs = state.configs.filter((x) => x.id !== c.id);
      state.active = state.configs[0].id;
      save(); renderSettings(); refreshRife();
    } else if (act === 'sm-reset') {
      if (!(await confirmBox('Reset to defaults?', `All settings in "${c.name}" go back to Smoothie's defaults.`, 'Reset'))) return;
      c.cfg = Smoothie.defaults();
      save(); renderSettings(); refreshRife();
    } else if (act === 'sm-import') {
      let r;
      try { r = await api.importRecipe(); } catch (e) { toast(e.message, 'error'); return; }
      if (!r) return;
      const parsed = Smoothie.parseRecipe(r.text);
      if (!parsed.sections) { toast("That file doesn't look like a Smoothie recipe.", 'warn'); return; }
      const nice = /^recipe$/i.test(r.name) ? 'Imported recipe' : r.name;
      addConfig(nice, parsed.config);
      save(); renderSettings(); refreshRife();
      toast(`Imported "${curCfg().name}". Settings xan can't use were kept and will export back unchanged.`, 'ok');
    } else if (act === 'sm-export') {
      let p;
      try { p = await api.exportRecipe({ name: c.name, text: Smoothie.serializeRecipe(c.cfg) }); } catch (e) { toast(e.message, 'error'); return; }
      if (p) toast(`Saved ${basename(p)}`, 'ok');
    }
  }

  // ------------------------------------------------------------ rendering
  async function render() {
    if (UI.busy || !state.clips.length) return;
    const c = curCfg();
    const cfg = JSON.parse(JSON.stringify(c.cfg));
    let any = false;
    for (const f of state.clips) {
      let plan;
      try { plan = Smoothie.build(cfg, f.info); } catch (e) { toast(`${f.name}: ${e.message}`, 'error'); return; }
      if (plan.touched) any = true;
    }
    if (!any) { toast('Nothing to render yet: switch an effect on in the settings first.', 'warn'); return; }
    if (cfg['pre-interp'].enabled) {
      const st = await api.rifeStatus(cfg['pre-interp'].model);
      rife.status = st;
      if (!st.installed) {
        closed.delete('pre-interp');
        renderSettings();
        const el = document.querySelector('[data-card="pre-interp"]');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        toast('Pre-interpolation needs RIFE. Press Download in its card first.', 'warn');
        return;
      }
    }
    const v = $('smVideo'); if (!v.paused) v.pause();
    const payload = {
      files: state.clips.map((f) => ({
        path: f.path, info: f.info, suffix: 'smoothie', merge: false,
        segments: [{ start: 0, end: f.info.duration }],
      })),
      settings: { preset: state.out.quality, codec: state.out.codec, height: 0, fps: 0, audio: state.out.audio, speed: 'medium', customMB: 20 },
      outDir: state.out.dir || null,
      smoothie: cfg,
    };
    const res = await UI.runRender(payload, { title: 'Rendering with Smoothie…', noun: 'Render', compare: false });
    renderOut();
    return res;
  }

  // ------------------------------------------------------------ wiring
  function wire() {
    const page = $('page-smoothie');

    page.addEventListener('input', (e) => {
      const el = e.target;
      if (!(el.matches && el.matches('input[type=range][data-sec]'))) return;
      const k = Smoothie.SCHEMA.find((s) => s.id === el.dataset.sec).keys.find((x) => x.key === el.dataset.key);
      const v = Number(el.value);
      curCfg().cfg[el.dataset.sec][el.dataset.key] = v;
      el.style.setProperty('--p', pct(k, v) + '%');
      const out = el.closest('.opt-col').querySelector('.sl-val'); if (out) out.textContent = fmt(k, v);
      changed();
    });

    page.addEventListener('change', (e) => {
      const el = e.target;
      if (el.id === 'smSelect') { state.active = el.value; save(); renderSettings(); refreshRife(); return; }
      if (el.id === 'smQuality') { state.out.quality = el.value; save(); return; }
      if (el.id === 'smCodec') { state.out.codec = el.value; save(); return; }
      if (el.id === 'smAudio') { state.out.audio = el.value; save(); return; }
      if (!el.dataset || !el.dataset.sec || el.type === 'range') return;
      const sec = Smoothie.SCHEMA.find((s) => s.id === el.dataset.sec);
      const k = sec.keys.find((x) => x.key === el.dataset.key);
      const cfg = curCfg().cfg;
      if (k.type === 'bool') {
        cfg[sec.id][k.key] = el.checked;
        if (k.key === 'enabled') el.closest('.sm-body').classList.toggle('off', !el.checked);
      } else if (k.type === 'number') {
        const v = Math.min(k.max, Math.max(k.min, Number(el.value) || k.def));
        cfg[sec.id][k.key] = v; el.value = v;
      } else cfg[sec.id][k.key] = el.value;
      changed();
      if (sec.id === 'pre-interp' && k.key === 'model') refreshRife();
    });

    page.addEventListener('click', async (e) => {
      const rm = e.target.closest('[data-rm]');
      if (rm) { removeClip(Number(rm.dataset.rm)); return; }
      const clipRow = e.target.closest('.clip-row');
      if (clipRow) { if (!UI.busy) select(Number(clipRow.dataset.i)); return; }
      const head = e.target.closest('.panel-head');
      if (head && head.parentElement.id !== 'smTop') {
        const panel = head.parentElement;
        panel.classList.toggle('collapsed');
        const id = panel.dataset.card;
        if (id) { if (panel.classList.contains('collapsed')) closed.add(id); else closed.delete(id); }
        return;
      }
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'lut-pick') {
        const p = await api.chooseFile({ title: 'Choose a LUT', filters: [{ name: 'LUT', extensions: ['cube', '3dl', 'dat', 'm3d', 'csp'] }, { name: 'All files', extensions: ['*'] }] });
        if (!p) return;
        curCfg().cfg.lut.path = p; curCfg().cfg.lut.enabled = true; changed(); renderSettings();
      } else if (act === 'lut-clear') {
        curCfg().cfg.lut.path = ''; changed(); renderSettings();
      } else if (act === 'mask-pick') {
        const p = await api.chooseFile({ title: 'Choose a mask picture', filters: [{ name: 'Picture', extensions: ['png', 'jpg', 'jpeg', 'bmp'] }, { name: 'All files', extensions: ['*'] }] });
        if (!p) return;
        const m = curCfg().cfg['artifact masking'];
        m['folder path'] = dirname(p); m['file name'] = basename(p); m.enabled = true;
        changed(); renderSettings();
      } else if (act === 'mask-clear') {
        const m = curCfg().cfg['artifact masking'];
        m['folder path'] = ''; m['file name'] = '';
        changed(); renderSettings();
      } else if (act === 'rife-install') installRife();
      else if (act === 'rife-cancel') api.rifeCancel();
      else action(act);
    });

    $('smBtnOpen').addEventListener('click', openDialog);
    $('smDropOpen').addEventListener('click', openDialog);
    $('smOutDir').addEventListener('click', async () => {
      const dir = await api.chooseFolder();
      if (dir) { state.out.dir = dir; save(); renderOut(); }
    });
    $('smOutReset').addEventListener('click', () => { state.out.dir = ''; save(); renderOut(); });
    $('smRender').addEventListener('click', render);

    const v = $('smVideo');
    v.addEventListener('error', () => {
      const c = clip();
      if (!c || !v.getAttribute('src')) return;
      if (c.proxy || c.proxyFailed) { playerMsg(NO_PREVIEW); return; }
      buildProxy(c);
    });
    UI.onBusy(() => renderOut());
  }

  function init() {
    load();
    wire();
    renderClips();
    renderOut();
    renderSettings();
    refreshRife();
    UI.handlers.smoothie = {
      add: (paths) => addPaths(paths),
      open: openDialog,
      onHide: () => { const v = $('smVideo'); if (v && !v.paused) v.pause(); },
      onShow: () => { renderOut(); refreshRife(); },
    };
    window.__sm = { state, render, addPaths, curCfg };    // handy for debugging and the tests
  }

  UI.initSmoothie = init;
  UI.smoothieBinaries = (b) => { window.__binaries = b; if (initDone) renderOut(); };
})();
