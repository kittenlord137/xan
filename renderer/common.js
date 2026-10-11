/*
 * Things every page shares: small helpers, page switching with its transition, the modal and toast,
 * the render progress window (with the live preview), drag and drop.
 */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const api = window.api;
  const Core = window.Core;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const basename = (p) => String(p).split(/[\\/]/).pop();
  const dirname = (p) => String(p).replace(/[\\/][^\\/]*$/, '');
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const ico = (name) => `<svg class="i"><use href="#i-${name}"/></svg>`;
  const reduced = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const UI = { $, api, esc, basename, dirname, clamp, ico, handlers: {}, page: 'editor' };

  // ------------------------------------------------------------------ busy
  // true while a render is running (only one at a time)
  const busyListeners = [];
  let busy = false;
  Object.defineProperty(UI, 'busy', { get: () => busy });
  UI.setBusy = (v) => { busy = !!v; busyListeners.forEach((f) => f(busy)); };
  UI.onBusy = (f) => busyListeners.push(f);

  // ------------------------------------------------------------------ toast
  let toastTimer = 0, toastHide = 0;
  UI.toast = (msg, kind) => {
    const el = $('toast');
    clearTimeout(toastTimer); clearTimeout(toastHide);
    el.textContent = msg;
    el.className = 'toast ' + (kind || '');
    void el.offsetWidth;                       // restart the slide-in
    el.classList.add('show');
    toastTimer = setTimeout(() => {
      el.classList.remove('show');
      toastHide = setTimeout(() => el.classList.add('hidden'), 260);
    }, 5000);
  };

  // ------------------------------------------------------------------ modal
  let modalIsOpen = false, modalHide = 0;
  UI.modalOpen = () => modalIsOpen;
  UI.openModal = (html, opts) => {
    clearTimeout(modalHide);
    const m = $('modal');
    $('modalCard').innerHTML = html;
    $('modalCard').classList.toggle('wide', !!(opts && opts.wide));
    if (!modalIsOpen) {
      m.classList.remove('hidden');
      void m.offsetWidth;
      m.classList.add('show');
    }
    modalIsOpen = true;
  };
  UI.closeModal = () => {
    if (!modalIsOpen) return;
    modalIsOpen = false;
    const m = $('modal');
    m.classList.remove('show');
    modalHide = setTimeout(() => {
      m.classList.add('hidden');
      $('modalCard').innerHTML = '';
    }, reduced() ? 0 : 200);
  };

  UI.askName = (title, initial, okLabel) => new Promise((resolve) => {
    UI.openModal(`<h3>${esc(title)}</h3><input id="smName" class="text-in" maxlength="40" value="${esc(initial)}" spellcheck="false">
      <div class="modal-actions"><button class="secondary" id="smCancel">Cancel</button><button class="primary" id="smOk">${esc(okLabel)}</button></div>`);
    const inp = $('smName');
    inp.focus(); inp.select();
    const done = (v) => { UI.closeModal(); resolve(v); };
    $('smOk').onclick = () => done(inp.value.trim() || null);
    $('smCancel').onclick = () => done(null);
    inp.onkeydown = (e) => { if (e.key === 'Enter') done(inp.value.trim() || null); };
  });
  UI.confirmBox = (title, text, okLabel) => new Promise((resolve) => {
    UI.openModal(`<h3>${esc(title)}</h3><p>${esc(text)}</p>
      <div class="modal-actions"><button class="secondary" id="smCancel">Cancel</button><button class="primary" id="smOk">${esc(okLabel)}</button></div>`);
    const done = (v) => { UI.closeModal(); resolve(v); };
    $('smOk').onclick = () => done(true);
    $('smCancel').onclick = () => done(false);
  });

  // ------------------------------------------------------------------ pages
  const pageEl = (name) => (name === 'editor' ? $('app') : $('page-' + name));
  let pageToken = 0;

  UI.moveNavIndicator = () => {
    const ind = $('navInd'), act = document.querySelector('.nav-item.active');
    if (!ind || !act) return;
    ind.style.transform = `translateY(${act.offsetTop + 9}px)`;
    ind.style.height = Math.max(8, act.offsetHeight - 18) + 'px';
    ind.classList.remove('hidden');
  };

  UI.setPage = (name) => {
    if (UI.page === name || !pageEl(name)) return;
    const from = UI.page;
    UI.page = name;
    const token = ++pageToken;
    for (const b of document.querySelectorAll('.nav-item[data-page]')) b.classList.toggle('active', b.dataset.page === name);
    UI.moveNavIndicator();
    if (UI.handlers[from] && UI.handlers[from].onHide) UI.handlers[from].onHide();
    const swap = () => {
      if (token !== pageToken) return;
      for (const el of document.querySelectorAll('.page')) {
        const on = el === pageEl(name);
        el.classList.remove('page-out', 'page-in');
        el.classList.toggle('hidden', !on);
        if (on && !reduced()) { void el.offsetWidth; el.classList.add('page-in'); }
      }
      window.dispatchEvent(new Event('resize'));
      if (UI.handlers[name] && UI.handlers[name].onShow) UI.handlers[name].onShow();
    };
    const out = pageEl(from);
    if (reduced() || !out || out.classList.contains('hidden')) swap();
    else { out.classList.add('page-out'); setTimeout(swap, 120); }
  };

  // ------------------------------------------------------------------ results
  UI.fmtEta = (s) => {
    s = Math.max(1, Math.round(s));
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  };

  function resultList(results, compare) {
    return `<ul class="results">${results.map((r) => {
      let extra = '';
      if (compare && r.whole && r.srcSize) {
        const pct = Math.round((1 - r.size / r.srcSize) * 100);
        extra = pct > 0 ? ` <b>· ${pct}% smaller than the original</b>` : ' · not smaller than the original, try a lower target';
      }
      return `<li><div class="r-name">${esc(basename(r.output))}</div>
        <div class="r-size">${Core.fmtBytes(r.size)}${extra}</div>
        <button class="secondary" data-show="${esc(r.output)}">Show in folder</button></li>`;
    }).join('')}</ul>`;
  }

  function showResult(res, opts) {
    const o = opts || {};
    const results = res.results || [];
    let html;
    if (res.ok) {
      html = `<h3>${results.length === 1 ? 'Done' : `Done: ${results.length} videos`}</h3>${resultList(results, o.compare)}`;
    } else if (res.cancelled) {
      html = `<h3>${esc(o.noun || 'Export')} cancelled</h3>${results.length ? `<p>These finished before you cancelled:</p>${resultList(results, o.compare)}` : '<p>Nothing was saved.</p>'}`;
    } else {
      html = `<h3>${esc(o.noun || 'Export')} failed</h3><p class="err-text">${esc(res.error || 'Something went wrong.')}</p>${results.length ? `<p>These finished first:</p>${resultList(results, o.compare)}` : ''}`;
    }
    const first = results[0];
    html += `<div class="modal-actions">
      ${first ? `<button class="secondary" id="resOpenFolder" data-folder="${esc(dirname(first.output))}">Open folder</button>` : ''}
      <button class="primary" id="resClose">Close</button></div>`;
    UI.openModal(html);
  }

  // Runs one render with a progress window. The picture in it comes from the engine's preview file.
  UI.runRender = async (payload, opts) => {
    const o = opts || {};
    UI.setBusy(true);
    UI.openModal(`
      <h3>${esc(o.title || 'Exporting…')}</h3>
      <div class="live"><img id="expPrev" alt="" class="hidden"><div class="live-empty" id="expPrevEmpty">${ico('film')}<span>The live preview appears here</span></div></div>
      <div class="exp-name" id="expName">Starting…</div>
      <div class="bar"><div id="expBar"></div></div>
      <div class="exp-row"><span id="expPct">0%</span><span id="expEta"></span></div>
      <p id="expNote" class="hint"></p>
      <div class="modal-actions"><button id="expCancel" class="secondary">Cancel</button></div>`, { wide: true });

    let previewFile = '', poll = 0, loading = false;
    const pull = () => {
      if (!previewFile || loading) return;
      loading = true;
      const img = new Image();
      img.onload = () => {
        loading = false;
        UI.previewsShown = (UI.previewsShown || 0) + 1;
        const el = $('expPrev'); if (!el) return;
        el.src = img.src;
        el.classList.remove('hidden');
        const empty = $('expPrevEmpty'); if (empty) empty.classList.add('hidden');
      };
      img.onerror = () => { loading = false; };        // not written yet, or caught mid-write: try again
      img.src = api.fileUrl(previewFile) + '?t=' + Date.now();
    };

    const off = api.onExportEvent((ev) => {
      if (ev.type === 'item') {
        const n = $('expName'); if (n) n.textContent = `${ev.name}  (${ev.index + 1} of ${ev.total})`;
        const note = $('expNote'); if (note) note.textContent = ev.note || '';
      } else if (ev.type === 'progress') {
        const pct = Math.round(ev.overall * 100);
        const bar = $('expBar'); if (bar) bar.style.width = pct + '%';
        const p = $('expPct'); if (p) p.textContent = pct + '%';
        const e = $('expEta'); if (e) e.textContent = ev.eta != null && ev.overall < 1 ? `about ${UI.fmtEta(ev.eta)} left` : '';
      } else if (ev.type === 'preview') {
        previewFile = ev.file;
        if (!poll) poll = setInterval(pull, 500);
      }
    });

    let res;
    try { res = await api.startExport(payload); }
    catch (e) { res = { ok: false, error: e.message, results: [] }; }
    off();
    clearInterval(poll);
    UI.setBusy(false);
    showResult(res, o);
    return res;
  };

  // ------------------------------------------------------------------ wiring
  function wireModal() {
    $('modal').addEventListener('click', (e) => {
      const t = e.target;
      if (t.id === 'expCancel') { t.disabled = true; t.textContent = 'Cancelling…'; api.cancelExport(); return; }
      if (t.id === 'resClose') { UI.closeModal(); return; }
      if (t.id === 'resUpdates') { UI.closeModal(); api.checkUpdates(); return; }
      if (t.dataset && t.dataset.show) { api.showInFolder(t.dataset.show); return; }
      if (t.dataset && t.dataset.folder) { api.openFolder(t.dataset.folder); return; }
      if (t === $('modal') && !busy) UI.closeModal();
    });
  }

  function wireDrop() {
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
      UI.addPaths(paths);
    });
  }

  // files dropped / opened go to the page you are on (the Smoothie page or the editor)
  UI.addPaths = (paths) => {
    const h = UI.handlers[UI.page] && UI.handlers[UI.page].add ? UI.handlers[UI.page] : UI.handlers.editor;
    if (h) h.add(paths);
  };
  UI.openDialog = () => {
    const h = UI.handlers[UI.page] && UI.handlers[UI.page].open ? UI.handlers[UI.page] : UI.handlers.editor;
    if (h) h.open();
  };

  function wireNav() {
    for (const b of document.querySelectorAll('.nav-item[data-page]')) b.addEventListener('click', () => UI.setPage(b.dataset.page));
    window.addEventListener('resize', () => UI.moveNavIndicator());
    document.addEventListener('keydown', (e) => {
      if (UI.modalOpen() && e.key === 'Escape' && !busy) UI.closeModal();
    });
    // a soft press effect on every button
    document.addEventListener('pointerdown', (e) => {
      const b = e.target.closest && e.target.closest('button');
      if (!b || b.disabled) return;
      b.classList.add('pressed');
      const up = () => { b.classList.remove('pressed'); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointerup', up);
    });
  }

  UI.initCommon = () => { wireModal(); wireDrop(); wireNav(); requestAnimationFrame(() => UI.moveNavIndicator()); };
  window.UI = UI;
})();
