(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const Core = window.Core;
  const api = window.api;

  const SEG_HUES = [268, 312, 232, 340, 196, 288, 250, 326];

  const state = {
    files: [],            // {path, name, info, segments:[{id,start,end}], selectedId, proxy, proxyFailed}
    cur: -1,
    settings: Object.assign({}, Core.DEFAULT_SETTINGS),
    outDir: '',
    cutMode: 'separate',
    exportAll: false,
    binaries: null,
    t: 0,                 // playhead, seconds
    playing: false,
    hasPreview: false,
    busy: false,          // an export is running
    nextId: 1,
    page: 'editor',
    sm: { apply: false, active: '', configs: [] },
  };

  const cur = () => state.files[state.cur] || null;
  const dur = () => (cur() ? cur().info.duration : 0);
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const basename = (p) => String(p).split(/[\\/]/).pop();
  const dirname = (p) => String(p).replace(/[\\/][^\\/]*$/, '');
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sortedSegs = (f) => f.segments.slice().sort((a, b) => a.start - b.start || a.id - b.id);
  const selSeg = () => { const f = cur(); return f ? f.segments.find((s) => s.id === f.selectedId) || null : null; };
  const minGap = () => 1 / ((cur() && cur().info.fps) || 30);
  const ico = (name) => `<svg class="i"><use href="#i-${name}"/></svg>`;

  // ------------------------------------------------------------ preferences
  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem('clipsqueeze.prefs') || '{}');
      if (p.settings) Object.assign(state.settings, p.settings);
      if (typeof p.outDir === 'string') state.outDir = p.outDir;
      if (p.cutMode === 'merge' || p.cutMode === 'separate') state.cutMode = p.cutMode;
    } catch (_) { /* first run */ }
    // normalise anything odd that was stored
    const r = Core.resolve(state.settings);
    state.settings.preset = r.presetId; state.settings.codec = r.codec;
    state.settings.height = r.height; state.settings.fps = r.fps;
    state.settings.audio = r.audio; state.settings.speed = r.speed;
    if (!(Number(state.settings.customMB) > 0)) state.settings.customMB = Core.DEFAULT_SETTINGS.customMB;
  }
  function savePrefs() {
    try {
      localStorage.setItem('clipsqueeze.prefs', JSON.stringify({ settings: state.settings, outDir: state.outDir, cutMode: state.cutMode }));
    } catch (_) { /* storage unavailable */ }
  }

  // ------------------------------------------------------------------ toast
  let toastTimer = 0;
  function toast(msg, kind) {
    const el = $('toast');
    el.textContent = msg;
    el.className = 'toast ' + (kind || '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 5000);
  }

  // ------------------------------------------------------------------ modal
  const modalOpen = () => !$('modal').classList.contains('hidden');
  function openModal(html) { $('modalCard').innerHTML = html; $('modal').classList.remove('hidden'); }
  function closeModal() { $('modal').classList.add('hidden'); $('modalCard').innerHTML = ''; }

  // ------------------------------------------------------------ loading files
  function setPage(name) {
    if (state.page === name) return;
    state.page = name;
    if (name !== 'editor') { const v = $('video'); if (v && !v.paused) v.pause(); }
    $('app').classList.toggle('hidden', name !== 'editor');
    for (const el of document.querySelectorAll('.page')) el.classList.toggle('hidden', el.id !== 'page-' + name);
    for (const b of document.querySelectorAll('.nav-item[data-page]')) b.classList.toggle('active', b.dataset.page === name);
    if (name === 'editor') window.dispatchEvent(new Event('resize'));
  }

  async function addPaths(paths) {
    setPage('editor');
    if (!paths || !paths.length) return;
    if (state.busy) { toast('Wait for the export to finish first.', 'warn'); return; }
    let firstIdx = -1;
    const failed = [];
    for (const p of paths) {
      const existing = state.files.findIndex((f) => f.path === p);
      if (existing >= 0) { if (firstIdx < 0) firstIdx = existing; continue; }
      const res = await api.probe(p);
      if (!res.ok) { failed.push(`${basename(p)}: ${res.error}`); continue; }
      const info = res.info;
      const seg = { id: state.nextId++, start: 0, end: info.duration };
      state.files.push({ path: p, name: info.name, info, segments: [seg], selectedId: seg.id, proxy: null, proxyFailed: false });
      if (firstIdx < 0) firstIdx = state.files.length - 1;
    }
    if (failed.length) toast(failed[0] + (failed.length > 1 ? `  (+${failed.length - 1} more)` : ''), 'error');
    if (firstIdx >= 0) openFile(firstIdx);
  }

  async function openDialog() {
    setPage('editor');
    if (state.busy) return;
    const paths = await api.openFilesDialog();
    addPaths(paths);
  }

  function showUI(hasFile) {
    $('app').classList.toggle('has-file', hasFile);
    for (const id of ['player', 'sidebar', 'timelineWrap', 'controls', 'btnCloseFile']) $(id).classList.toggle('hidden', !hasFile);
    $('dropzone').classList.toggle('hidden', hasFile);
  }

  function openFile(i) {
    pause();
    state.cur = i;
    const f = cur();
    state.t = 0;
    state.hasPreview = false;
    showUI(true);
    loadVideo(f);
    document.title = `${f.name} – xan`;
    renderAll();
  }

  function closeCurrentFile() {
    if (state.busy || !cur()) return;
    pause();
    state.files.splice(state.cur, 1);
    if (state.files.length) { openFile(Math.min(state.cur, state.files.length - 1)); return; }
    state.cur = -1;
    const v = $('video');
    v.removeAttribute('src');
    v.load();
    showUI(false);
    document.title = 'xan';
    renderAll();
  }

  // ----------------------------------------------------------------- video
  function showPlayerMsg(text) {
    const el = $('playerMsg');
    el.textContent = text || '';
    el.classList.toggle('hidden', !text);
  }

  // Codecs the built-in player decodes reliably. Anything else (HEVC from many GPU recorders,
  // 10-bit, ProRes...) gets a small H.264 preview copy; the export always uses the original.
  const DIRECT_CODECS = ['h264', 'vp8', 'vp9', 'av1'];
  function needsProxy(info) {
    const pix = info.pixFmt || '';
    return !DIRECT_CODECS.includes(info.vcodec) || (pix !== '' && !/^yuvj?420p$/.test(pix));
  }

  const NO_PREVIEW = 'No preview is available for this video.\nYou can still type start and end times and export it.';

  function loadVideo(f) {
    const v = $('video');
    showPlayerMsg('');
    state.hasPreview = false;
    updatePlayButton();
    $('proxyBadge').classList.toggle('hidden', !f.proxy);
    if (!f.proxy && !f.proxyFailed && needsProxy(f.info)) { buildProxy(f); return; }
    if (f.proxyFailed && needsProxy(f.info)) { showPlayerMsg(NO_PREVIEW); return; }
    v.src = api.fileUrl(f.proxy || f.path);
    v.load();
  }

  async function buildProxy(f) {
    const v = $('video');
    v.removeAttribute('src');
    v.load();
    showPlayerMsg('Preparing a preview of this video…\nThe export always uses the original.');
    if (!f.proxyPromise) f.proxyPromise = api.makeProxy(f.path);
    const res = await f.proxyPromise;
    f.proxyPromise = null;
    if (res.ok) f.proxy = res.path; else f.proxyFailed = true;
    if (cur() === f) loadVideo(f);
  }

  function onVideoError() {
    const f = cur();
    if (!f || !$('video').getAttribute('src')) return;
    state.hasPreview = false;
    updatePlayButton();
    if (f.proxy || f.proxyFailed) { showPlayerMsg(NO_PREVIEW); return; }
    buildProxy(f);   // the player choked on it: fall back to a preview copy
  }

  function setTime(t) {
    t = clamp(t, 0, dur());
    state.t = t;
    if (state.hasPreview) $('video').currentTime = t;
    renderTime();
  }

  function play() {
    if (!state.hasPreview) return;
    const v = $('video');
    if (v.ended || state.t >= dur() - 0.03) { v.currentTime = 0; state.t = 0; }
    const p = v.play();
    if (p && p.catch) p.catch(() => {});
  }
  function pause() { const v = $('video'); if (!v.paused) v.pause(); }
  function togglePlay() { if (state.playing) pause(); else play(); }

  function tick() {
    if (!state.playing) return;
    state.t = $('video').currentTime;
    renderTime();
    requestAnimationFrame(tick);
  }

  function updatePlayButton() {
    $('btnPlay').innerHTML = ico(state.playing ? 'pause' : 'play');
    $('btnPlay').disabled = !state.hasPreview;
    $('btnPlay').title = state.hasPreview ? 'Play / pause (Space)' : 'No preview for this video';
  }

  function stepFrames(n) {
    const f = cur(); if (!f) return;
    pause();
    const fps = f.info.fps || 30;
    const idx = Math.floor(state.t * fps + 1e-3) + n;
    setTime(Math.max(0, idx) / fps + 0.001);
  }

  // -------------------------------------------------------------- segments
  function selectSeg(id, { seek } = {}) {
    const f = cur(); if (!f) return;
    f.selectedId = id;
    refreshSelection();
    if (seek) { const s = selSeg(); if (s) setTime(s.start); }
  }

  function refreshSelection() {
    const f = cur(); if (!f) return;
    document.querySelectorAll('.seg-row, .seg').forEach((el) => {
      el.classList.toggle('selected', Number(el.dataset.id) === f.selectedId);
    });
  }

  function afterSegChange() {
    renderSegments(); renderTimeline(); renderEstimates(); renderExportBar();
  }

  function addSegmentAt(t) {
    const f = cur(); if (!f) return;
    const d = f.info.duration;
    const len = Math.min(5, d / 4);
    const start = clamp(t, 0, d - len);
    const seg = { id: state.nextId++, start, end: start + len };
    f.segments.push(seg);
    f.selectedId = seg.id;
    afterSegChange();
  }

  function splitAtPlayhead() {
    const f = cur(); if (!f) return;
    const t = state.t, gap = minGap();
    const target = selSeg() && selSeg().start < t && t < selSeg().end ? selSeg()
      : f.segments.find((s) => s.start < t && t < s.end);
    if (!target || t - target.start < gap || target.end - t < gap) {
      toast('Move the playhead inside a segment to split it.', 'warn'); return;
    }
    const right = { id: state.nextId++, start: t, end: target.end };
    target.end = t;
    f.segments.push(right);
    f.selectedId = right.id;
    afterSegChange();
  }

  function removeSegment(id) {
    const f = cur(); if (!f) return;
    const order = sortedSegs(f);
    const i = order.findIndex((s) => s.id === id);
    if (i < 0) return;
    f.segments = f.segments.filter((s) => s.id !== id);
    const rest = sortedSegs(f);
    if (f.selectedId === id) f.selectedId = rest.length ? rest[Math.min(i, rest.length - 1)].id : null;
    afterSegChange();
  }

  function resetSegments() {
    const f = cur(); if (!f) return;
    const seg = { id: state.nextId++, start: 0, end: f.info.duration };
    f.segments = [seg];
    f.selectedId = seg.id;
    afterSegChange();
  }

  function setStartHere() {
    const f = cur(); if (!f) return;
    const s = selSeg(), t = state.t, gap = minGap();
    if (!s) { addSegmentAt(t); return; }
    if (t >= f.info.duration - gap) { toast('That is the very end of the video.', 'warn'); return; }
    s.start = t;
    if (s.end <= t + gap) s.end = f.info.duration;
    afterSegChange();
  }

  function setEndHere() {
    const f = cur(); if (!f) return;
    const s = selSeg(), t = state.t, gap = minGap();
    if (!s) { addSegmentAt(Math.max(0, t - 5)); return; }
    if (t <= gap) { toast('That is the very start of the video.', 'warn'); return; }
    s.end = t;
    if (s.start >= t - gap) s.start = 0;
    afterSegChange();
  }

  function stepSelection(dir) {
    const f = cur(); if (!f) return;
    const order = sortedSegs(f);
    if (!order.length) return;
    const i = order.findIndex((s) => s.id === f.selectedId);
    const next = order[clamp((i < 0 ? 0 : i) + dir, 0, order.length - 1)];
    selectSeg(next.id, { seek: true });
  }

  // ----------------------------------------------------------- estimates
  function unitsFor(f) {
    const segs = sortedSegs(f).filter((s) => s.end - s.start > 0.01);
    if (state.cutMode === 'merge' && segs.length > 1) {
      return [{ dur: segs.reduce((a, s) => a + (s.end - s.start), 0), merged: true }];
    }
    return segs.map((s) => ({ dur: s.end - s.start, merged: false }));
  }

  // ------------------------------------------------------------- rendering
  function renderAll() {
    renderTitle(); renderOutDir(); renderFileSelect();
    renderSegments(); renderTimeline(); renderCompression(); renderTime(); renderSmoothieCard();
    renderEstimates(); renderExportBar(); updatePlayButton();
    $('cutMode').value = state.cutMode;
  }

  function renderTitle() {
    const f = cur();
    const el = $('fileMeta');
    if (!f) { el.innerHTML = ''; return; }
    const i = f.info;
    el.innerHTML = `<b>${esc(f.name)}</b> &nbsp;${i.width}×${i.height} · ${Math.round(i.fps * 100) / 100} fps · ${Core.fmtDur(i.duration)} · ${Core.fmtBytes(i.size)} · ${esc(i.vcodec)}`;
    el.title = f.path;
  }

  function renderOutDir() {
    $('outDirText').textContent = state.outDir ? `Output: ${basename(state.outDir) || state.outDir}` : 'Output: same folder as video';
    $('btnOutDir').title = state.outDir ? state.outDir : 'Exported videos are saved next to the original. Click to choose a folder.';
    $('btnOutReset').classList.toggle('hidden', !state.outDir);
  }

  function renderFileSelect() {
    const sel = $('fileSelect');
    sel.classList.toggle('hidden', state.files.length < 2);
    sel.innerHTML = state.files.map((f, i) => `<option value="${i}">${esc(f.name)}</option>`).join('');
    sel.value = String(state.cur);
  }

  function renderSegments() {
    const f = cur();
    const list = $('segList');
    if (!f) { list.innerHTML = ''; $('segTotal').innerHTML = ''; return; }
    const order = sortedSegs(f);
    const merged = state.cutMode === 'merge' && order.length > 1;
    if (!order.length) {
      list.innerHTML = '<div class="seg-empty">No segments. Press <kbd>+</kbd> to add one.</div>';
    } else {
      list.innerHTML = order.map((s, i) => {
        const len = s.end - s.start;
        let meta = Core.fmtDur(len);
        if (!merged) {
          const e = estimate(f, len, false);
          meta += ` · ${e.bound ? 'up to ' : '~'}${Core.fmtBytes(e.bytes)}`;
        } else meta += ' · part of the merged video';
        return `<div class="seg-row${s.id === f.selectedId ? ' selected' : ''}" data-id="${s.id}" style="--h:${SEG_HUES[(s.id - 1) % SEG_HUES.length]}">
          <span class="seg-idx">${i + 1}</span>
          <div class="seg-times">
            <input class="t-start" value="${Core.fmtTime(s.start)}" spellcheck="false" aria-label="Segment start">
            <span class="arrow">→</span>
            <input class="t-end" value="${Core.fmtTime(s.end)}" spellcheck="false" aria-label="Segment end">
          </div>
          <button class="seg-x" title="Remove segment">${ico('x')}</button>
          <div class="seg-meta">${meta}</div>
        </div>`;
      }).join('');
    }
    const total = order.reduce((a, s) => a + (s.end - s.start), 0);
    $('segTotal').innerHTML = `<span>${order.length} segment${order.length === 1 ? '' : 's'}</span><span>total <b>${Core.fmtDur(total)}</b></span>`;
  }

  function renderTimeline() {
    const f = cur();
    const layer = $('segLayer');
    layer.innerHTML = '';
    if (!f) { $('ticks').innerHTML = ''; return; }
    const d = f.info.duration;
    const order = sortedSegs(f);
    for (const s of f.segments) {
      const el = document.createElement('div');
      el.className = 'seg' + (s.id === f.selectedId ? ' selected' : '');
      el.dataset.id = s.id;
      el.style.setProperty('--h', SEG_HUES[(s.id - 1) % SEG_HUES.length]);
      el.style.left = (s.start / d) * 100 + '%';
      el.style.width = ((s.end - s.start) / d) * 100 + '%';
      el.innerHTML = `<span class="label">${order.indexOf(s) + 1}</span><div class="handle h-start"></div><div class="handle h-end"></div>`;
      layer.appendChild(el);
    }
    renderTicks();
  }

  function renderTicks() {
    const el = $('ticks');
    el.innerHTML = '';
    const f = cur(); if (!f) return;
    const d = f.info.duration;
    const w = $('timeline').clientWidth || 800;
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];
    const step = steps.find((s) => (s / d) * w >= 84) || steps[steps.length - 1];
    const label = (t) => {
      const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
      const ss = step < 1 ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0');
      return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
    };
    for (let t = 0; t <= d + 1e-6; t += step) {
      const div = document.createElement('div');
      div.className = 'tick';
      div.style.left = (t / d) * 100 + '%';
      div.textContent = label(t);
      el.appendChild(div);
    }
  }

  function renderTime() {
    const f = cur();
    const d = dur();
    $('timeReadout').textContent = Core.fmtTime(state.t);
    $('frameReadout').textContent = Math.floor(state.t * ((f && f.info.fps) || 30) + 1e-3) + 'f';
    $('playhead').style.left = d ? (state.t / d) * 100 + '%' : '0';
  }

  function renderCompression() {
    const s = state.settings, f = cur();
    $('preset').value = s.preset;
    $('codec').value = s.codec;
    $('height').value = String(s.height);
    $('fps').value = String(s.fps);
    $('speed').value = s.speed;
    const custom = s.preset === 'custom';
    $('customLabel').classList.toggle('hidden', !custom);
    $('customWrap').classList.toggle('hidden', !custom);
    $('customMB').value = s.customMB;

    const x265 = !state.binaries || state.binaries.x265 !== false;
    const h265 = $('codec').querySelector('option[value="h265"]');
    h265.disabled = !x265;
    h265.textContent = x265 ? 'H.265 (about 35% smaller)' : 'H.265 (not in this ffmpeg)';
    if (!x265 && s.codec === 'h265') { s.codec = 'h264'; $('codec').value = 'h264'; }

    const n = f ? f.info.audioStreams : 0;
    const audio = $('audio');
    if (n === 0) {
      audio.innerHTML = '<option value="none">No audio in this video</option>';
      audio.disabled = true;
      audio.value = 'none';
    } else {
      audio.disabled = false;
      audio.innerHTML = n === 1
        ? '<option value="all">Keep</option><option value="none">Remove</option>'
        : `<option value="all">Keep all ${n} tracks</option><option value="first">First track only</option><option value="none">Remove</option>`;
      audio.value = n === 1 && s.audio === 'first' ? 'all' : s.audio;
    }
  }

  function renderEstimates() {
    const f = cur();
    const note = $('compNote'), est = $('estLine');
    if (!f) { note.classList.add('hidden'); est.innerHTML = ''; return; }
    const r = Core.resolve(state.settings);
    const files = state.exportAll ? state.files : [f];
    let total = 0, worst = null;
    for (const file of files) {
      for (const u of unitsFor(file)) {
        total += estimate(file, u.dur, u.merged).bytes;
        const chk = targetCheck(file, u.dur, u.merged);
        if (chk && (!worst || (chk.level === 'error' && worst.level !== 'error'))) worst = chk;
      }
    }
    if (worst) { note.textContent = worst.text; note.className = 'note ' + (worst.level === 'error' ? 'error' : ''); }
    else note.className = 'note hidden';
    if (r.mode === 'size') est.innerHTML = `Each video: <b>up to ${r.targetMB > 0 ? r.targetMB : '?'} MB</b> <span title="1 MB = 1,000,000 bytes">(1 MB = 1,000,000 bytes)</span>`;
    else est.innerHTML = total > 0 ? `Estimated output: <b>~${Core.fmtBytes(total)}</b> <span>(rough guess; depends on the footage)</span>` : '';
  }

  function renderExportBar() {
    const f = cur();
    const multi = state.files.length > 1;
    $('exportAllRow').classList.toggle('hidden', !multi);
    $('exportAllCount').textContent = state.files.length;
    $('exportAll').checked = state.exportAll && multi;
    if (!f) { $('exportSummary').textContent = ''; $('btnExport').disabled = true; return; }
    const files = state.exportAll && multi ? state.files : [f];
    const n = files.reduce((a, file) => a + unitsFor(file).length, 0);
    $('exportSummary').textContent = n ? `${n} video${n === 1 ? '' : 's'} will be created` : 'Nothing to export';
    $('btnExport').disabled = !n || state.busy;
  }

  // --------------------------------------------------------------- export
  function fmtEta(s) {
    s = Math.max(1, Math.round(s));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  }

  async function doExport() {
    if (state.busy || !cur()) return;
    const multi = state.files.length > 1 && state.exportAll;
    const files = multi ? state.files : [cur()];
    for (const f of files) {
      if (!unitsFor(f).length) { toast(`${f.name}: add a segment first.`, 'warn'); return; }
      for (const u of unitsFor(f)) {
        const chk = targetCheck(f, u.dur, u.merged);
        if (chk && chk.level === 'error') { toast(`${f.name}: ${chk.text}`, 'error'); return; }
      }
    }
    pause();
    state.busy = true;
    renderExportBar();
    openModal(`
      <h3>Exporting…</h3>
      <div class="exp-name" id="expName">Starting…</div>
      <div class="bar"><div id="expBar"></div></div>
      <div class="exp-row"><span id="expPct">0%</span><span id="expEta"></span></div>
      <p id="expNote" class="hint"></p>
      <div class="modal-actions"><button id="expCancel" class="secondary">Cancel</button></div>`);

    const off = api.onExportEvent((ev) => {
      if (ev.type === 'item') {
        const n = $('expName'); if (n) n.textContent = `${ev.name}  (${ev.index + 1} of ${ev.total})`;
        const note = $('expNote'); if (note) note.textContent = ev.note || '';
      } else if (ev.type === 'progress') {
        const pct = Math.round(ev.overall * 100);
        const bar = $('expBar'); if (bar) bar.style.width = pct + '%';
        const p = $('expPct'); if (p) p.textContent = pct + '%';
        const e = $('expEta'); if (e) e.textContent = ev.eta != null && ev.overall < 1 ? `about ${fmtEta(ev.eta)} left` : '';
      }
    });

    const payload = {
      files: files.map((f) => ({
        path: f.path,
        info: f.info,
        segments: sortedSegs(f).map((s) => ({ start: s.start, end: s.end })),
        merge: state.cutMode === 'merge',
      })),
      settings: Object.assign({}, state.settings),
      outDir: state.outDir || null,
      smoothie: state.sm.apply ? JSON.parse(JSON.stringify(smCur().cfg)) : null,
    };
    let res;
    try { res = await api.startExport(payload); }
    catch (e) { res = { ok: false, error: e.message, results: [] }; }
    off();
    state.busy = false;
    renderExportBar();
    showExportResult(res);
  }

  function resultList(results) {
    return `<ul class="results">${results.map((r) => {
      let extra = '';
      if (r.whole && r.srcSize) {
        const pct = Math.round((1 - r.size / r.srcSize) * 100);
        extra = pct > 0 ? ` <b>· ${pct}% smaller than the original</b>` : ' · not smaller than the original, try a lower target';
      }
      return `<li><div class="r-name">${esc(basename(r.output))}</div>
        <div class="r-size">${Core.fmtBytes(r.size)}${extra}</div>
        <button class="secondary" data-show="${esc(r.output)}">Show in folder</button></li>`;
    }).join('')}</ul>`;
  }

  function showExportResult(res) {
    const results = res.results || [];
    let html;
    if (res.ok) {
      html = `<h3>${results.length === 1 ? 'Done' : `Done: ${results.length} videos`}</h3>${resultList(results)}`;
    } else if (res.cancelled) {
      html = `<h3>Export cancelled</h3>${results.length ? `<p>These finished before you cancelled:</p>${resultList(results)}` : '<p>Nothing was saved.</p>'}`;
    } else {
      html = `<h3>Export failed</h3><p class="err-text">${esc(res.error || 'Something went wrong.')}</p>${results.length ? `<p>These finished first:</p>${resultList(results)}` : ''}`;
    }
    const first = results[0];
    html += `<div class="modal-actions">
      ${first ? `<button class="secondary" id="resOpenFolder" data-folder="${esc(dirname(first.output))}">Open folder</button>` : ''}
      <button class="primary" id="resClose">Close</button></div>`;
    openModal(html);
  }

  // --------------------------------------------------------------- updates
  function onUpdate(u) {
    const b = $('btnUpdate');
    if (!u) return;
    if (u.state === 'downloading') {
      b.className = 'pill update';
      b.disabled = true;
      b.textContent = `Downloading update${u.percent ? ' ' + u.percent + '%' : '…'}`;
      b.title = u.version ? `Version ${u.version} is downloading in the background` : '';
    } else if (u.state === 'ready') {
      b.className = 'pill update ready';
      b.disabled = false;
      b.textContent = `Restart to update${u.version ? ' to v' + u.version : ''}`;
      b.title = 'Closes xan, installs the update and opens it again';
      if (u.manual) toast(`Version ${u.version} is ready. Click "Restart to update" in the top bar.`, 'ok');
    } else if (u.manual && u.state === 'none') {
      toast(`You're up to date (v${state.version || '?'}).`, 'ok');
    } else if (u.manual && u.state === 'error') {
      toast(u.message || 'Could not check for updates.', 'warn');
    }
  }

  function showHelp() {
    openModal(`
      <h3>Keyboard shortcuts</h3>
      <div class="keys">
        <div><kbd>Space</kbd></div><div>Play / pause</div>
        <div><kbd>I</kbd> &nbsp; <kbd>O</kbd></div><div>Set the selected segment's start / end at the playhead</div>
        <div><kbd>+</kbd></div><div>Add a segment at the playhead</div>
        <div><kbd>S</kbd></div><div>Split the segment at the playhead</div>
        <div><kbd>Delete</kbd></div><div>Remove the selected segment</div>
        <div><kbd>←</kbd> <kbd>→</kbd></div><div>Back / forward 1 second (hold <kbd>Shift</kbd> for 5 seconds)</div>
        <div><kbd>,</kbd> <kbd>.</kbd></div><div>Back / forward one frame</div>
        <div><kbd>↑</kbd> <kbd>↓</kbd></div><div>Previous / next segment</div>
        <div><kbd>Home</kbd> <kbd>End</kbd></div><div>Start / end of the video</div>
        <div><kbd>M</kbd></div><div>Mute the preview (export is not affected)</div>
        <div><kbd>Ctrl</kbd>+<kbd>O</kbd></div><div>Open video(s)</div>
        <div><kbd>Ctrl</kbd>+<kbd>E</kbd></div><div>Export</div>
      </div>
      <p class="hint" style="margin-top:14px">Drag the edges of a segment on the timeline, or type exact times in the list. Several segments become separate videos, or one video if you pick <b>Merge cuts</b>.</p>
      <p class="hint">xan v${esc(state.version || '?')}</p>
      <div class="modal-actions"><button class="secondary" id="resUpdates">Check for updates</button><button class="primary" id="resClose">Close</button></div>`);
  }

  // ---------------------------------------------------------- Smoothie
  const SM_KEY = 'xan.smoothie';
  const smClosed = new Set();          // card ids the user folded away (cards that need extra software start folded)
  let smInit = false;
  const smCur = () => state.sm.configs.find((c) => c.id === state.sm.active) || state.sm.configs[0];

  function smLoad() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(SM_KEY) || 'null'); } catch (_) { /* first run */ }
    const configs = s && Array.isArray(s.configs)
      ? s.configs.filter((c) => c && c.id).map((c) => ({ id: String(c.id), name: String(c.name || 'Config').slice(0, 40), cfg: Smoothie.normalize(c.cfg) }))
      : [];
    if (!configs.length) configs.push({ id: 'default', name: 'Default', cfg: Smoothie.defaults() });
    state.sm = { apply: !!(s && s.apply), active: s && configs.some((c) => c.id === s.active) ? s.active : configs[0].id, configs };
  }
  function smSave() {
    try { localStorage.setItem(SM_KEY, JSON.stringify(state.sm)); } catch (_) { /* storage unavailable */ }
  }
  function smUniqueName(name, exceptId) {
    const taken = new Set(state.sm.configs.filter((c) => c.id !== exceptId).map((c) => c.name.toLowerCase()));
    let n = name || 'Config', i = 2;
    while (taken.has(n.toLowerCase())) n = `${name} ${i++}`;
    return n;
  }
  const smNewId = () => 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);

  // What an export really looks like with Smoothie on: a different frame rate and length.
  function effective(file, dur) {
    if (!state.sm.apply) return { info: file.info, dur };
    let plan;
    try { plan = Smoothie.build(smCur().cfg, file.info); } catch (_) { return { info: file.info, dur }; }
    if (!plan.touched) return { info: file.info, dur };
    return { info: Object.assign({}, file.info, { fps: plan.outFps }), dur: dur / plan.speed };
  }
  const estimate = (file, dur, merged) => { const e = effective(file, dur); return Core.estimateBytes(state.settings, e.info, e.dur, merged); };
  const targetCheck = (file, dur, merged) => { const e = effective(file, dur); return Core.checkTarget(state.settings, e.info, e.dur, merged); };

  const smFmt = (k, v) => (k.step >= 1 ? String(Math.round(v)) : String(+Number(v).toFixed(2)));
  const smPct = (k, v) => Math.max(0, Math.min(100, ((v - k.min) / (k.max - k.min)) * 100));

  function smRow(sec, k, v) {
    const dead = !sec.live || k.live === false;
    const at = `data-sec="${esc(sec.id)}" data-key="${esc(k.key)}"${dead ? ' disabled' : ''}`;
    const hint = k.hint ? `<div class="opt-hint">${esc(k.hint)}</div>` : '';
    const tag = k.live === false && sec.live ? '<em class="tag">Not used</em>' : '';
    const cls = dead ? ' dead' : '';
    switch (k.type) {
      case 'bool':
        return `<label class="opt${k.key === 'enabled' ? ' master' : ''}${cls}"><input type="checkbox" ${at}${v ? ' checked' : ''}><span>${esc(k.label)}</span>${tag}</label>`;
      case 'slider':
        return `<div class="opt-col${cls}"><div class="opt-top"><span>${esc(k.label)}</span><b class="sl-val">${smFmt(k, v)}</b></div>
          <input type="range" class="range" ${at} min="${k.min}" max="${k.max}" step="${k.step}" value="${v}" style="--p:${smPct(k, v)}%">${hint}</div>`;
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
          ${v ? '<button class="tiny" data-act="lut-clear" title="Remove"><svg class="i"><use href="#i-x"/></svg></button>' : ''}</div></div>`;
      default:
        return `<div class="opt-col${cls}"><div class="opt-top"><span>${esc(k.label)}</span>${tag}</div>
          <input type="text" ${at} value="${esc(v)}" spellcheck="false">${hint}</div>`;
    }
  }

  function smCard(sec, cfg) {
    const master = sec.keys.find((k) => k.key === 'enabled');
    const off = master && !cfg[sec.id].enabled;
    const closed = smClosed.has(sec.id);
    const tag = sec.live ? '' : '<em class="tag">Not available yet</em>';
    return `<div class="panel${closed ? ' collapsed' : ''}" data-card="${esc(sec.id)}">
      <div class="panel-head"><svg class="i ph-ico"><use href="#i-${sec.icon}"/></svg><h2>${esc(sec.title)}</h2>${tag}<svg class="i chev"><use href="#i-chev-d"/></svg></div>
      <div class="sm-body${off ? ' off' : ''}"><p class="sm-about">${esc(sec.about)}</p>${sec.keys.map((k) => smRow(sec, k, cfg[sec.id][k.key])).join('')}</div>
    </div>`;
  }

  function smOptions() {
    return state.sm.configs.map((c) => `<option value="${esc(c.id)}"${c.id === state.sm.active ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
  }

  function renderSmoothiePage() {
    const c = smCur();
    if (!smInit) { for (const s of Smoothie.SCHEMA) if (!s.live) smClosed.add(s.id); smInit = true; }
    $('smTop').innerHTML = `
      <div class="panel-head" style="cursor:default"><svg class="i ph-ico"><use href="#i-sparkle"/></svg><h2>Recipe</h2></div>
      <label class="opt master"><input type="checkbox" class="sm-apply"${state.sm.apply ? ' checked' : ''}><span>Apply Smoothie when exporting</span></label>
      <div class="opt-col"><div class="opt-top"><span>Config</span></div><select id="smSelect">${smOptions()}</select></div>
      <div class="btn-line">
        <button class="secondary" data-act="sm-new">New</button>
        <button class="secondary" data-act="sm-rename">Rename</button>
        <button class="secondary" data-act="sm-delete"${state.sm.configs.length < 2 ? ' disabled' : ''}>Delete</button>
        <button class="secondary" data-act="sm-reset">Reset to defaults</button>
        <button class="secondary" data-act="sm-import"><svg class="i"><use href="#i-open"/></svg>Import recipe.ini</button>
        <button class="secondary" data-act="sm-export"><svg class="i"><use href="#i-export"/></svg>Export recipe.ini</button>
      </div>
      <div class="sm-line" id="smSum"></div>`;
    const left = ['frame blending', 'interpolation', 'timescale'];
    const right = ['color grading', 'lut', 'flowblur', 'pre-interp', 'artifact masking'];
    const by = (id) => Smoothie.SCHEMA.find((s) => s.id === id);
    $('smColL').innerHTML = left.map((id) => smCard(by(id), c.cfg)).join('');
    $('smColR').innerHTML = right.map((id) => smCard(by(id), c.cfg)).join('');
    renderSmoothieSummary();
  }

  function renderSmoothieSummary() {
    const c = smCur();
    const f = cur();
    const sum = Smoothie.summary(c.cfg, f ? f.info : null);
    const el = $('smSum'); if (el) el.textContent = `Does: ${sum}`;
    renderSmoothieCard();
  }

  // the small card in the editor's right column
  function renderSmoothieCard() {
    const c = smCur();
    for (const box of document.querySelectorAll('.sm-apply')) box.checked = state.sm.apply;
    const q = $('smQuick'); q.innerHTML = smOptions();
    $('smLine').textContent = Smoothie.summary(c.cfg, null).replace(/^./, (m) => m.toUpperCase());
    const note = $('smNote');
    let text = '';
    const f = cur();
    if (f && state.sm.apply) {
      try {
        const plan = Smoothie.build(c.cfg, f.info);
        if (plan.notes.length) text = plan.notes[0];
        else if (!plan.touched) text = 'Nothing to do for this video with these settings.';
      } catch (_) { /* ignore */ }
    }
    note.textContent = text;
    note.classList.toggle('hidden', !text);
  }

  function smChanged() {
    smSave();
    renderSmoothieSummary();
    renderSegments(); renderEstimates(); renderExportBar();
  }

  function askName(title, initial, okLabel) {
    return new Promise((resolve) => {
      openModal(`<h3>${esc(title)}</h3><input id="smName" class="text-in" maxlength="40" value="${esc(initial)}" spellcheck="false">
        <div class="modal-actions"><button class="secondary" id="smCancel">Cancel</button><button class="primary" id="smOk">${esc(okLabel)}</button></div>`);
      const inp = $('smName');
      inp.focus(); inp.select();
      const done = (v) => { closeModal(); resolve(v); };
      $('smOk').onclick = () => done(inp.value.trim() || null);
      $('smCancel').onclick = () => done(null);
      inp.onkeydown = (e) => { if (e.key === 'Enter') done(inp.value.trim() || null); };
    });
  }
  function confirmBox(title, text, okLabel) {
    return new Promise((resolve) => {
      openModal(`<h3>${esc(title)}</h3><p>${esc(text)}</p>
        <div class="modal-actions"><button class="secondary" id="smCancel">Cancel</button><button class="primary" id="smOk">${esc(okLabel)}</button></div>`);
      const done = (v) => { closeModal(); resolve(v); };
      $('smOk').onclick = () => done(true);
      $('smCancel').onclick = () => done(false);
    });
  }

  function addConfig(name, cfg) {
    const c = { id: smNewId(), name: smUniqueName(name), cfg: Smoothie.normalize(cfg) };
    state.sm.configs.push(c);
    state.sm.active = c.id;
    return c;
  }

  async function smAction(act) {
    const c = smCur();
    if (act === 'sm-new') {
      const name = await askName('New config', smUniqueName(c.name + ' copy'), 'Create');
      if (!name) return;
      addConfig(name, JSON.parse(JSON.stringify(c.cfg)));
      smSave(); renderSmoothiePage(); toast(`Created "${smCur().name}" from the current settings.`, 'ok');
    } else if (act === 'sm-rename') {
      const name = await askName('Rename config', c.name, 'Rename');
      if (!name) return;
      c.name = smUniqueName(name, c.id);
      smSave(); renderSmoothiePage();
    } else if (act === 'sm-delete') {
      if (state.sm.configs.length < 2) return;
      if (!(await confirmBox('Delete this config?', `"${c.name}" will be removed. This can't be undone.`, 'Delete'))) return;
      state.sm.configs = state.sm.configs.filter((x) => x.id !== c.id);
      state.sm.active = state.sm.configs[0].id;
      smSave(); renderSmoothiePage(); renderEstimates(); renderSegments(); renderExportBar();
    } else if (act === 'sm-reset') {
      if (!(await confirmBox('Reset to defaults?', `All settings in "${c.name}" go back to Smoothie's defaults.`, 'Reset'))) return;
      c.cfg = Smoothie.defaults();
      smChanged(); renderSmoothiePage();
    } else if (act === 'sm-import') {
      let r;
      try { r = await api.importRecipe(); } catch (e) { toast(e.message, 'error'); return; }
      if (!r) return;
      const parsed = Smoothie.parseRecipe(r.text);
      if (!parsed.sections) { toast("That file doesn't look like a Smoothie recipe.", 'warn'); return; }
      const nice = /^recipe$/i.test(r.name) ? 'Imported recipe' : r.name;
      addConfig(nice, parsed.config);
      smChanged(); renderSmoothiePage();
      toast(`Imported "${smCur().name}". Settings xan can't use yet were kept and will export back unchanged.`, 'ok');
    } else if (act === 'sm-export') {
      let p;
      try { p = await api.exportRecipe({ name: c.name, text: Smoothie.serializeRecipe(c.cfg) }); } catch (e) { toast(e.message, 'error'); return; }
      if (p) toast(`Saved ${basename(p)}`, 'ok');
    }
  }

  function wireSmoothie() {
    const page = $('page-smoothie');
    // sliders move smoothly and save as they go; everything else saves on change
    page.addEventListener('input', (e) => {
      const el = e.target;
      if (!(el.matches && el.matches('input[type=range][data-sec]'))) return;
      const k = Smoothie.SCHEMA.find((s) => s.id === el.dataset.sec).keys.find((x) => x.key === el.dataset.key);
      const v = Number(el.value);
      smCur().cfg[el.dataset.sec][el.dataset.key] = v;
      el.style.setProperty('--p', smPct(k, v) + '%');
      const out = el.closest('.opt-col').querySelector('.sl-val'); if (out) out.textContent = smFmt(k, v);
      smChanged();
    });
    page.addEventListener('change', (e) => {
      const el = e.target;
      if (el.id === 'smSelect') { state.sm.active = el.value; smSave(); renderSmoothiePage(); renderSegments(); renderEstimates(); renderExportBar(); return; }
      if (el.classList && el.classList.contains('sm-apply')) { state.sm.apply = el.checked; smChanged(); return; }
      if (!el.dataset || !el.dataset.sec || el.type === 'range') return;
      const sec = Smoothie.SCHEMA.find((s) => s.id === el.dataset.sec);
      const k = sec.keys.find((x) => x.key === el.dataset.key);
      const cfg = smCur().cfg;
      if (k.type === 'bool') {
        cfg[sec.id][k.key] = el.checked;
        if (k.key === 'enabled') el.closest('.sm-body').classList.toggle('off', !el.checked);
      } else if (k.type === 'number') {
        const v = Math.min(k.max, Math.max(k.min, Number(el.value) || k.def));
        cfg[sec.id][k.key] = v; el.value = v;
      } else cfg[sec.id][k.key] = el.value;
      smChanged();
    });
    page.addEventListener('click', async (e) => {
      const head = e.target.closest('.panel-head');
      if (head && head.parentElement.dataset.card) {
        const id = head.parentElement.dataset.card;
        head.parentElement.classList.toggle('collapsed');
        if (head.parentElement.classList.contains('collapsed')) smClosed.add(id); else smClosed.delete(id);
        return;
      }
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.dataset.act;
      if (act === 'lut-pick') {
        const p = await api.chooseFile({ title: 'Choose a LUT', filters: [{ name: 'LUT', extensions: ['cube', '3dl', 'dat', 'm3d', 'csp'] }, { name: 'All files', extensions: ['*'] }] });
        if (!p) return;
        smCur().cfg.lut.path = p; smCur().cfg.lut.enabled = true; smChanged(); renderSmoothiePage();
      } else if (act === 'lut-clear') {
        smCur().cfg.lut.path = ''; smChanged(); renderSmoothiePage();
      } else smAction(act);
    });
    // the little card in the editor
    $('smPanel').addEventListener('change', (e) => {
      if (e.target.classList.contains('sm-apply')) { state.sm.apply = e.target.checked; smChanged(); renderSmoothiePage(); }
      else if (e.target.id === 'smQuick') { state.sm.active = e.target.value; smSave(); renderSmoothiePage(); renderSegments(); renderEstimates(); renderExportBar(); }
    });
    $('smEdit').addEventListener('click', () => setPage('smoothie'));
  }

  // ---------------------------------------------------------- timeline drag
  const timeline = $('timeline');
  let drag = null;
  const xToTime = (x) => {
    const r = timeline.getBoundingClientRect();
    return clamp((x - r.left) / r.width, 0, 1) * dur();
  };

  function onDrag(e) {
    const t = xToTime(e.clientX);
    if (drag.mode === 'scrub') { setTime(t); return; }
    const f = cur(); if (!f) return;
    const s = f.segments.find((x) => x.id === drag.id);
    if (!s) return;
    const gap = minGap();
    if (drag.mode === 'start') s.start = clamp(t, 0, s.end - gap);
    else s.end = clamp(t, s.start + gap, f.info.duration);
    setTime(drag.mode === 'start' ? s.start : s.end);
    afterSegChange();
  }

  timeline.addEventListener('pointerdown', (e) => {
    if (!cur() || e.button !== 0) return;
    const handle = e.target.closest('.handle');
    const segEl = e.target.closest('.seg');
    if (handle && segEl) {
      drag = { mode: handle.classList.contains('h-start') ? 'start' : 'end', id: Number(segEl.dataset.id) };
      cur().selectedId = drag.id;
    } else {
      drag = { mode: 'scrub' };
      if (segEl) { cur().selectedId = Number(segEl.dataset.id); refreshSelection(); }
    }
    timeline.setPointerCapture(e.pointerId);
    onDrag(e);
    e.preventDefault();
  });
  timeline.addEventListener('pointermove', (e) => { if (drag) onDrag(e); });
  const endDrag = (e) => {
    if (!drag) return;
    drag = null;
    try { timeline.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
  };
  timeline.addEventListener('pointerup', endDrag);
  timeline.addEventListener('pointercancel', endDrag);
  new ResizeObserver(() => renderTicks()).observe(timeline);

  // ------------------------------------------------------ segment list events
  const segList = $('segList');
  segList.addEventListener('click', (e) => {
    const row = e.target.closest('.seg-row');
    if (!row) return;
    const id = Number(row.dataset.id);
    if (e.target.closest('.seg-x')) { removeSegment(id); return; }
    selectSeg(id, { seek: !e.target.closest('input') });
  });
  segList.addEventListener('focusin', (e) => {
    const row = e.target.closest('.seg-row');
    if (row && e.target.tagName === 'INPUT') { selectSeg(Number(row.dataset.id)); e.target.select(); }
  });
  segList.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' && e.key === 'Enter') e.target.blur();
    if (e.target.tagName === 'INPUT' && e.key === 'Escape') { renderSegments(); }
  });
  segList.addEventListener('change', (e) => {
    const input = e.target;
    if (input.tagName !== 'INPUT') return;
    const row = input.closest('.seg-row');
    const f = cur();
    const s = f && row && f.segments.find((x) => x.id === Number(row.dataset.id));
    if (!s) return;
    const v = Core.parseTime(input.value);
    const gap = minGap();
    const isStart = input.classList.contains('t-start');
    let ok = !isNaN(v);
    if (ok && isStart) ok = v >= 0 && v <= s.end - gap;
    if (ok && !isStart) ok = v <= f.info.duration + 0.0005 && v >= s.start + gap;
    if (!ok) { toast('Use a time like 1:23.5, with the start before the end and inside the video.', 'warn'); renderSegments(); return; }
    if (isStart) s.start = v; else s.end = Math.min(v, f.info.duration);
    setTime(isStart ? s.start : s.end);
    afterSegChange();
  });

  // ------------------------------------------------------------ wiring
  function buildSelects() {
    const preset = $('preset');
    const g1 = document.createElement('optgroup'); g1.label = 'Fit under a size';
    const g2 = document.createElement('optgroup'); g2.label = 'Constant quality';
    for (const p of Core.PRESETS) (p.mode === 'size' ? g1 : g2).appendChild(new Option(p.label, p.id));
    preset.append(g1, g2);
  }

  function bindSetting(id, key, parse) {
    $(id).addEventListener('change', () => {
      state.settings[key] = parse ? parse($(id).value) : $(id).value;
      savePrefs();
      renderCompression(); renderSegments(); renderEstimates();
    });
  }

  function wire() {
    bindSetting('preset', 'preset');
    bindSetting('codec', 'codec');
    bindSetting('height', 'height', Number);
    bindSetting('fps', 'fps', Number);
    bindSetting('audio', 'audio');
    bindSetting('speed', 'speed');
    $('customMB').addEventListener('input', () => {
      const v = Number($('customMB').value);
      state.settings.customMB = v > 0 ? v : 0;
      savePrefs(); renderSegments(); renderEstimates();
    });
    $('cutMode').addEventListener('change', () => {
      state.cutMode = $('cutMode').value;
      savePrefs(); renderSegments(); renderEstimates(); renderExportBar();
    });
    $('exportAll').addEventListener('change', () => { state.exportAll = $('exportAll').checked; renderEstimates(); renderExportBar(); });
    $('fileSelect').addEventListener('change', () => { if (!state.busy) openFile(Number($('fileSelect').value)); });
    $('btnCloseFile').addEventListener('click', closeCurrentFile);
    $('btnOpen').addEventListener('click', openDialog);
    $('dzOpen').addEventListener('click', openDialog);
    $('btnHelp').addEventListener('click', showHelp);
    $('navHelp').addEventListener('click', showHelp);
    wireSmoothie();
    $('navUpdates').addEventListener('click', () => api.checkUpdates());
    for (const b of document.querySelectorAll('.nav-item[data-page]')) b.addEventListener('click', () => setPage(b.dataset.page));
    for (const head of document.querySelectorAll('#sidebar .panel-head')) {
      head.addEventListener('click', (e) => { if (!e.target.closest('.btn-row')) head.parentElement.classList.toggle('collapsed'); });
    }
    $('btnUpdate').addEventListener('click', () => {
      if (state.busy) { toast('Finish the export first, then restart to update.', 'warn'); return; }
      api.installUpdate();
    });
    api.onUpdate(onUpdate);
    $('btnOutDir').addEventListener('click', async () => {
      const dir = await api.chooseFolder();
      if (dir) { state.outDir = dir; savePrefs(); renderOutDir(); }
    });
    $('btnOutReset').addEventListener('click', () => { state.outDir = ''; savePrefs(); renderOutDir(); });

    $('btnAddSeg').addEventListener('click', () => addSegmentAt(state.t));
    $('btnSplit').addEventListener('click', splitAtPlayhead);
    $('btnDelSeg').addEventListener('click', () => { const s = selSeg(); if (s) removeSegment(s.id); });
    $('btnResetSegs').addEventListener('click', resetSegments);

    $('btnPlay').addEventListener('click', togglePlay);
    $('btnFrameBack').addEventListener('click', () => stepFrames(-1));
    $('btnFrameFwd').addEventListener('click', () => stepFrames(1));
    $('btnSetStart').addEventListener('click', setStartHere);
    $('btnSetEnd').addEventListener('click', setEndHere);
    $('btnToStart').addEventListener('click', () => { const s = selSeg(); if (s) setTime(s.start); });
    $('btnToEnd').addEventListener('click', () => { const s = selSeg(); if (s) setTime(s.end); });
    $('btnMute').addEventListener('click', toggleMute);
    $('btnExport').addEventListener('click', doExport);

    const v = $('video');
    v.addEventListener('click', togglePlay);
    v.addEventListener('loadedmetadata', () => {
      state.hasPreview = true;
      showPlayerMsg('');
      if (state.t > 0) v.currentTime = state.t;
      updatePlayButton();
    });
    v.addEventListener('error', onVideoError);
    v.addEventListener('play', () => { state.playing = true; updatePlayButton(); requestAnimationFrame(tick); });
    v.addEventListener('pause', () => { state.playing = false; updatePlayButton(); });
    v.addEventListener('ended', () => { state.playing = false; state.t = Math.min(dur(), v.currentTime); renderTime(); updatePlayButton(); });

    // modal buttons (delegated)
    $('modal').addEventListener('click', (e) => {
      const t = e.target;
      if (t.id === 'expCancel') { t.disabled = true; t.textContent = 'Cancelling…'; api.cancelExport(); return; }
      if (t.id === 'resClose') { closeModal(); return; }
      if (t.id === 'resUpdates') { closeModal(); api.checkUpdates(); return; }
      if (t.dataset && t.dataset.show) { api.showInFolder(t.dataset.show); return; }
      if (t.dataset && t.dataset.folder) { api.openFolder(t.dataset.folder); return; }
      if (t === $('modal') && !state.busy) closeModal();
    });

    // drag and drop
    let depth = 0;
    const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
    window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; $('dropOverlay').classList.remove('hidden'); });
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) $('dropOverlay').classList.add('hidden'); });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      depth = 0;
      $('dropOverlay').classList.add('hidden');
      const paths = Array.from(e.dataTransfer.files || []).map((f) => api.pathForFile(f)).filter(Boolean);
      addPaths(paths);
    });

    document.addEventListener('keydown', onKey);
    api.onOpenPaths(addPaths);
    api.onMenu((name) => { if (name === 'open') openDialog(); else if (name === 'help') showHelp(); });
  }

  function toggleMute() {
    const v = $('video');
    v.muted = !v.muted;
    $('btnMute').innerHTML = ico(v.muted ? 'mute' : 'vol');
  }

  function onKey(e) {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
    if (modalOpen()) { if (e.key === 'Escape' && !state.busy) closeModal(); return; }
    if (state.page !== 'editor') return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); doExport(); return; }
    if (typing || mod || e.altKey || !cur()) return;
    const key = e.key;
    const handled = () => e.preventDefault();
    switch (key) {
      case ' ': handled(); togglePlay(); break;
      case 'ArrowLeft': handled(); pause(); setTime(state.t - (e.shiftKey ? 5 : 1)); break;
      case 'ArrowRight': handled(); pause(); setTime(state.t + (e.shiftKey ? 5 : 1)); break;
      case 'ArrowUp': handled(); stepSelection(-1); break;
      case 'ArrowDown': handled(); stepSelection(1); break;
      case ',': case '<': handled(); stepFrames(-1); break;
      case '.': case '>': handled(); stepFrames(1); break;
      case 'Home': handled(); setTime(0); break;
      case 'End': handled(); setTime(dur()); break;
      case 'i': case 'I': handled(); setStartHere(); break;
      case 'o': case 'O': handled(); setEndHere(); break;
      case '+': case '=': handled(); addSegmentAt(state.t); break;
      case 's': case 'S': handled(); splitAtPlayhead(); break;
      case 'm': case 'M': handled(); toggleMute(); break;
      case 'Delete': case 'Backspace': { handled(); const s = selSeg(); if (s) removeSegment(s.id); break; }
      default: break;
    }
  }

  async function init() {
    loadPrefs();
    smLoad();
    buildSelects();
    wire();
    showUI(false);
    renderSmoothiePage();
    renderAll();
    state.version = await api.appVersion();
    $('navVersion').textContent = 'v' + state.version;
    api.updateState().then(onUpdate);   // an update may already be downloaded if the page reloaded
    state.binaries = await api.binaries();
    renderCompression();
    if (!state.binaries.ok) {
      openModal(`<h3>ffmpeg could not be started</h3>
        <p>xan needs ffmpeg to work, and it could not be run.</p>
        <p class="hint">Looked for: ${esc(state.binaries.ffmpegPath)}<br>and: ${esc(state.binaries.ffprobePath)}</p>
        <p>Run <b>npm install</b> in the app folder again (it downloads ffmpeg), or install ffmpeg and make sure it is on your PATH.</p>
        <div class="modal-actions"><button class="primary" id="resClose">Close</button></div>`);
    }
    const launch = await api.launchPaths();
    if (launch && launch.length) addPaths(launch);
  }

  window.__cs = { state };   // handy for debugging in DevTools
  init();
})();
