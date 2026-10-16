(() => {
  'use strict';
  const $ = (q) => document.querySelector(q);
  const $$ = (q) => document.querySelectorAll(q);
  const hasChrome = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;

  /* ---------- storage: small settings in chrome.storage, images as blobs in IndexedDB ---------- */
  const store = {
    get: (k) => hasChrome ? chrome.storage.local.get(k) : Promise.resolve(Object.fromEntries(k.map(x => { try { return [x, JSON.parse(localStorage.getItem(x) || 'null') ?? undefined]; } catch { return [x, undefined]; } }))),
    set: (o) => {
      const clean = Object.fromEntries(Object.entries(o).filter(([_, v]) => v !== undefined));
      return hasChrome ? chrome.storage.local.set(clean) : Promise.resolve(Object.entries(clean).forEach(([k, v]) => localStorage.setItem(k, JSON.stringify(v))));
    },
    remove: (k) => hasChrome ? chrome.storage.local.remove(k) : Promise.resolve([].concat(k).forEach(x => localStorage.removeItem(x))),
    clear: () => hasChrome ? chrome.storage.local.clear() : Promise.resolve(localStorage.clear())
  };
  let dbp;
  const db = () => dbp ||= new Promise((res, rej) => { const r = indexedDB.open('quiettab', 1); r.onupgradeneeded = () => r.result.createObjectStore('blobs'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const idb = (mode, fn) => db().then(d => new Promise((res, rej) => { const t = d.transaction('blobs', mode); const q = fn(t.objectStore('blobs')); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); }));
  const blobs = { get: (k) => idb('readonly', s => s.get(k)), put: (k, v) => idb('readwrite', s => s.put(v, k)), del: (k) => idb('readwrite', s => s.delete(k)), clear: () => idb('readwrite', s => s.clear()) };

  /* ---------- state ---------- */
  const PRESETS = { light: { accent: '#3b5bdb', bg: '#f6f5f2', text: '#1c1c1e' }, dark: { accent: '#8ea2ff', bg: '#121214', text: '#ececee' } };
  const DEFAULT = {
    mode: 'light', colors: { ...PRESETS.light },
    pattern: 'dots', patOp: 50, patSize: 22,
    hasImg: false, overlay: true, dim: 10, blur: 0,
    canvas: true, pan: { x: 0, y: 0 },
    barPos: 'bottom', showClock: true, clockSize: 100,
    secAccent: true,
    h24: true, secs: true, showDate: true,
    board: [],
    links: [{ id: 1, name: 'Google', url: 'https://google.com' }, { id: 2, name: 'GitHub', url: 'https://github.com' }, { id: 3, name: 'YouTube', url: 'https://youtube.com' }, { id: 4, name: 'Gmail', url: 'https://mail.google.com' }]
  };
  let s = structuredClone(DEFAULT);
  const timers = {};
  const save = (keys, delay = 0) => { const k = keys.join(); clearTimeout(timers[k]); timers[k] = setTimeout(() => { delete timers[k]; store.set(Object.fromEntries(keys.map(x => [x, s[x]]))); }, delay); };
  const flushSave = () => {
    for (const [k, t] of Object.entries(timers)) {
      clearTimeout(t);
      delete timers[k];
      const keys = k.split(',');
      store.set(Object.fromEntries(keys.map(x => [x, s[x]])));
    }
  };
  window.addEventListener('pagehide', flushSave);
  window.addEventListener('beforeunload', flushSave);
  const urls = new Map(); // blob key -> object URL (revoked on removal to free memory)
  const urlFor = async (key) => { if (urls.has(key)) return urls.get(key); const b = await blobs.get(key).catch(() => null); if (!b) return null; const u = URL.createObjectURL(b); urls.set(key, u); return u; };
  const dropUrl = (key) => { if (urls.has(key)) { URL.revokeObjectURL(urls.get(key)); urls.delete(key); } };

  const toast = (() => { const el = document.createElement('div'); el.id = 'toast'; document.body.append(el); let t; return (m) => { el.textContent = m; el.classList.add('show'); clearTimeout(t); t = setTimeout(() => el.classList.remove('show'), 1800); }; })();

  /* ---------- clock: ticks only when visible, aligned to the second/minute ---------- */
  let clockT, lastTime = '', lastDay = '', dateStr = '';
  const p2 = (n) => String(n).padStart(2, '0');
  function tick() {
    clearTimeout(clockT);
    document.body.classList.toggle('no-clock', !s.showClock);
    if (!s.showClock) return;
    const d = new Date();
    let h = d.getHours(); if (!s.h24) h = h % 12 || 12;
    const ampm = !s.h24 ? (d.getHours() < 12 ? 'am' : 'pm') : '';
    const tail = s.secs ? `<span class="sec">${p2(d.getSeconds())}${ampm ? ' ' + ampm : ''}</span>` : (ampm ? `<span class="sec">${ampm}</span>` : '');
    const html = `${s.h24 ? p2(h) : h}:${p2(d.getMinutes())}${tail}`;
    if (html !== lastTime) $('#time').innerHTML = lastTime = html;
    const td = d.toDateString();
    if (td !== lastDay) { lastDay = td; dateStr = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }); }
    const ds = s.showDate ? dateStr : '';
    if ($('#date').textContent !== ds) $('#date').textContent = ds;
    if (!document.hidden) {
      const delay = s.secs ? Math.max(20, 1000 - d.getMilliseconds()) : Math.max(20, 60000 - d.getSeconds() * 1000 - d.getMilliseconds());
      clockT = setTimeout(tick, delay);
    }
  }
  async function syncStorage() {
    if (typeof els === 'undefined') return;
    if (document.activeElement && document.activeElement.matches('input, textarea, [contenteditable]')) return;
    try {
      const d = await store.get([...Object.keys(DEFAULT)]);
      let changed = false;
      for (const k in DEFAULT) {
        if (d[k] !== undefined && JSON.stringify(d[k]) !== JSON.stringify(s[k])) {
          s[k] = d[k];
          changed = true;
        }
      }
      if (changed) {
        applyTheme(); applyBar(); applyClockOpts(); renderLinks();
        const currentIds = new Set(s.board.map(i => i.id));
        for (const [id, el] of els) {
          if (!currentIds.has(id)) { el.remove(); els.delete(id); }
        }
        s.board.forEach(it => {
          if (els.has(it.id)) sync(it);
          else renderItem(it);
        });
        applyPan(false);
        updateStats();
      }
    } catch {}
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      clearTimeout(clockT);
    } else {
      tick();
      syncStorage();
    }
  });

  /* ---------- image helpers ---------- */
  async function shrink(file, max, type = 'image/jpeg') {
    const bmp = await createImageBitmap(file);
    if (!bmp.width || !bmp.height) { bmp.close(); throw new Error('Invalid image dimensions'); }
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close();
    const out = await new Promise(r => c.toBlob(r, type, 0.86));
    c.width = c.height = 0; // release canvas memory
    if (!out) throw new Error('Blob encoding failed');
    return out;
  }
  const isPng = (f) => /png|gif|webp|svg/.test(f.type);

  /* ---------- theme & background ---------- */
  function applyTheme() {
    const r = document.documentElement.style;
    r.setProperty('--accent', s.colors.accent); r.setProperty('--bg', s.colors.bg); r.setProperty('--text', s.colors.text);
    r.colorScheme = s.mode;
    [['#cAccent', 'accent'], ['#cBg', 'bg'], ['#cText', 'text']].forEach(([q, k]) => { $(q).value = s.colors[k]; const hx = $(q + 'Hex'); if (document.activeElement !== hx) { hx.value = s.colors[k].slice(1).toUpperCase(); hx.parentElement.classList.remove('bad'); } });
    $$('#presets button').forEach(b => b.classList.toggle('on', b.dataset.c.toLowerCase() === s.colors.accent.toLowerCase()));
    $$('#mode button').forEach(b => b.classList.toggle('on', b.dataset.v === s.mode));
  }
  async function applyBg() {
    const img = $('#bgimg'), pat = $('#pattern');
    const url = s.hasImg ? await urlFor('bg') : null;
    if (s.hasImg && !url) s.hasImg = false;
    img.style.backgroundImage = url ? `url("${url}")` : '';
    img.classList.toggle('on', !!url);
    img.style.setProperty('--dim', s.dim / 100);
    img.style.filter = s.blur ? `blur(${s.blur}px)` : '';
    img.style.inset = s.blur ? `-${s.blur * 2}px` : '0';
    document.body.classList.toggle('on-img', !!url);
    const showPat = s.pattern !== 'plain' && (!url || s.overlay);
    pat.className = showPat ? s.pattern : '';
    pat.style.setProperty('--pat-op', s.patOp / 100);
    pat.style.setProperty('--ps', s.patSize + 'px');
    $$('#pattern-seg button').forEach(b => b.classList.toggle('on', b.dataset.v === s.pattern));
    ['#patOpRow', '#patSizeRow'].forEach(q => $(q).classList.toggle('off', s.pattern === 'plain'));
    $('#patOp').value = s.patOp; $('#patOpV').textContent = s.patOp + '%';
    $('#patSize').value = s.patSize; $('#patSizeV').textContent = s.patSize;
    $('#dim').value = s.dim; $('#dimV').textContent = s.dim + '%';
    $('#blur').value = s.blur; $('#blurV').textContent = s.blur;
    $('#overlay').checked = s.overlay;
    const pv = $('#imgPreview'); pv.classList.toggle('has', !!url); pv.style.backgroundImage = url ? `url("${url}")` : '';
    $('#clearImg').hidden = !url; $('#imgOpts').classList.toggle('show', !!url);
  }
  function applyBar() {
    document.body.classList.remove('bar-top', 'bar-left', 'bar-right');
    if (s.barPos !== 'bottom') document.body.classList.add('bar-' + s.barPos);
    $$('#barPos button').forEach(b => b.classList.toggle('on', b.dataset.v === s.barPos));
  }
  $$('#barPos button').forEach(b => b.onclick = () => { s.barPos = b.dataset.v; applyBar(); save(['barPos']); });
  function applyClockSize() { document.documentElement.style.setProperty('--cs', s.clockSize / 100); $('#clockSize').value = s.clockSize; $('#clockSizeV').textContent = s.clockSize + '%'; }
  function applyClockOpts() { lastTime = ''; applyClockSize(); $('#showClock').checked = s.showClock; $$('.clock-opts,#clockSizeRow').forEach(e => e.classList.toggle('off', !s.showClock)); $('#h24').checked = s.h24; $('#secs').checked = s.secs; $('#showDate').checked = s.showDate; $('#secAccent').checked = s.secAccent; document.body.classList.toggle('sec-plain', !s.secAccent); tick(); }

  /* ---------- links ---------- */
  const normUrl = (u) => {
    u = (u || '').trim();
    if (!u || /^(javascript|data|vbscript):/i.test(u)) return null;
    if (!/^[a-z][\w+.-]*:/i.test(u)) u = 'https://' + u;
    try {
      const p = new URL(u);
      return (p.protocol === 'http:' || p.protocol === 'https:' || p.protocol === 'chrome:' || p.protocol === 'edge:' || p.protocol === 'chrome-extension:') ? p.href : null;
    } catch {
      return null;
    }
  };
  const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
  const icon = (l) => {
    const letter = () => {
      const e = document.createElement('span'); e.className = 'letter';
      const n = host(l?.url || '');
      const ch = (l?.name || n || '?').trim()[0] || '?';
      e.textContent = ch.toUpperCase();
      e.style.setProperty('--h', Math.abs([...n].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)) % 360);
      return e;
    };
    if (!l?.url || !(hasChrome && chrome.runtime?.id)) return letter();
    const img = new Image(); img.alt = ''; img.decoding = 'async';
    img.src = `/_favicon/?pageUrl=${encodeURIComponent(l.url)}&size=32`;
    img.onerror = () => img.replaceWith(letter());
    return img;
  };
  const svgBtn = (label, svg, fn, cls = 'icon-btn') => { const b = document.createElement('button'); b.className = cls; b.type = 'button'; b.setAttribute('aria-label', label); b.title = label; b.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${svg}</svg>`; b.onclick = fn; return b; };
  function renderLinks() {
    const bar = $('#links'); bar.replaceChildren();
    s.links.forEach((l, i) => { const a = document.createElement('a'); a.className = 'tb-link'; a.href = l.url; a.dataset.name = (l.name || host(l.url)) + (i < 9 ? `  ·  ${i + 1}` : ''); a.setAttribute('aria-label', l.name || host(l.url)); a.append(icon(l)); bar.append(a); });
    const list = $('#linkList'); list.replaceChildren();
    $('#linkCount').textContent = s.links.length ? s.links.length + (s.links.length === 1 ? ' link' : ' links') : '';
    if (!s.links.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'No shortcuts yet'; list.append(li); }
    s.links.forEach((l, i) => {
      const li = document.createElement('li'); li.draggable = true;
      const g = document.createElement('span'); g.className = 'grip'; g.textContent = '⋮⋮';
      const ic = document.createElement('span'); ic.className = 'ic'; ic.append(icon(l));
      const nm = document.createElement('span'); nm.className = 'nm'; nm.title = l.url;
      const nb = document.createElement('strong'); nb.textContent = l.name || host(l.url);
      const hs = document.createElement('small'); hs.textContent = host(l.url);
      nm.append(nb, hs);
      const acts = document.createElement('span'); acts.className = 'acts';
      acts.append(
        svgBtn('Move up', '<path d="M12 19V5M5 12l7-7 7 7"/>', () => move(i, i - 1)),
        svgBtn('Move down', '<path d="M12 5v14M5 12l7 7 7-7"/>', () => move(i, i + 1)),
        svgBtn('Edit', '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>', () => startEdit(l)),
        svgBtn('Remove', '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>', () => { s.links = s.links.filter(x => x !== l); if (editing === l.id) resetForm(); commitLinks(); }));
      acts.lastChild.classList.add('danger');
      if (i === 0) acts.children[0].disabled = true;
      if (i === s.links.length - 1) acts.children[1].disabled = true;
      li.append(g, ic, nm, acts);
      li.classList.toggle('editing', editing === l.id);
      li.addEventListener('dragstart', e => { li.classList.add('dragging'); e.dataTransfer.setData('text/x-link', i); });
      li.addEventListener('dragend', () => li.classList.remove('dragging'));
      li.addEventListener('dragover', e => { e.preventDefault(); li.classList.add('over'); });
      li.addEventListener('dragleave', e => { if (!li.contains(e.relatedTarget)) li.classList.remove('over'); });
      li.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); li.classList.remove('over'); const f = e.dataTransfer.getData('text/x-link'); if (f !== '') move(+f, i); });
      list.append(li);
    });
  }
  const commitLinks = () => { renderLinks(); save(['links']); };
  function move(from, to) { if (to < 0 || to >= s.links.length || from === to) return renderLinks(); const [x] = s.links.splice(from, 1); s.links.splice(to, 0, x); commitLinks(); }
  let editing = null;
  function startEdit(l) { editing = l.id; $('#lName').value = l.name; $('#lUrl').value = l.url; $('#saveLink span').textContent = 'Save changes'; renderLinks(); $('#formTitle').textContent = 'Edit shortcut'; $('#cancelEdit').hidden = false; $('#lUrl').focus(); }
  function resetForm() { const was = editing; editing = null; $('#linkForm').reset(); $('#saveLink span').textContent = 'Add shortcut'; $('#formTitle').textContent = 'New shortcut'; $('#cancelEdit').hidden = true; if (was) renderLinks(); }
  $('#cancelEdit').onclick = resetForm;
  $('#linkForm').onsubmit = (e) => {
    e.preventDefault();
    const url = normUrl($('#lUrl').value); if (!url) { $('#lUrl').setCustomValidity('Enter a valid URL'); $('#lUrl').reportValidity(); return; }
    const name = $('#lName').value.trim() || host(url);
    if (editing) Object.assign(s.links.find(l => l.id === editing), { name, url }); else s.links.push({ id: Date.now(), name, url });
    resetForm(); commitLinks();
  };
  $('#lUrl').oninput = (e) => e.target.setCustomValidity('');

  /* ---------- quick-add shortcut dialog ---------- */
  const dlg = $('#linkDlg'), dUrl = $('#dUrl'), dName = $('#dName');
  let prevT;
  const dlgPreview = () => {
    const url = normUrl(dUrl.value || ''), ok = !!url && /\./.test(host(url));
    $('#dlgHost').textContent = ok ? host(url) : 'Add a site to your toolbar';
    $('#dlgPrev').replaceChildren(ok ? icon({ name: dName.value.trim(), url }) : '');
    $('#dlgPrev').classList.toggle('on', ok);
  };
  function openLinkDlg() { $('#dlgForm').reset(); dUrl.setCustomValidity(''); dlgPreview(); dlg.showModal(); dUrl.focus(); }
  dUrl.addEventListener('input', () => { dUrl.setCustomValidity(''); clearTimeout(prevT); prevT = setTimeout(dlgPreview, 250); });
  dName.addEventListener('input', () => { clearTimeout(prevT); prevT = setTimeout(dlgPreview, 250); });
  $('#dlgCancel').onclick = () => dlg.close();
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); }); // click backdrop
  dlg.addEventListener('keydown', (e) => e.stopPropagation());
  $('#dlgForm').addEventListener('submit', (e) => {
    const url = normUrl(dUrl.value);
    if (!url) { e.preventDefault(); dUrl.setCustomValidity('Enter a valid URL'); dUrl.reportValidity(); return; }
    s.links.push({ id: Date.now(), name: dName.value.trim() || host(url), url }); commitLinks();
    toast('Added ' + (dName.value.trim() || host(url)));
  });

  /* ---------- pinboard ---------- */
  const board = $('#board');
  const els = new Map();
  const saveBoard = () => save(['board'], 300);
  const topZ = () => {
    let m = s.board.reduce((m, i) => Math.max(m, i.z || 0), 0);
    if (m > 5000) { [...s.board].sort((a, b) => a.z - b.z).forEach((it, i) => { it.z = i + 1; const el = els.get(it.id); if (el) el.style.zIndex = it.z; }); m = s.board.length; }
    return m + 1;
  };
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const randPos = () => ({ x: 0.15 + Math.random() * 0.6 - (s.canvas ? s.pan.x / innerWidth : 0), y: 0.18 + Math.random() * 0.45 - (s.canvas ? s.pan.y / innerHeight : 0), r: +(Math.random() * 6 - 3).toFixed(1) });

  async function renderItem(it, i = -1) {
    let el = els.get(it.id);
    if (!el) {
      el = document.createElement('div'); el.className = 'item ' + (it.type === 'todo' ? 'note todo' : it.type);
      el.classList.add('item-enter');
      if (typeof i === 'number' && i >= 0) el.style.setProperty('--item-delay', Math.min(0.42, +(0.06 + i * 0.05).toFixed(2)) + 's');
      else el.style.setProperty('--item-delay', '0s');
      el.addEventListener('animationend', () => el.classList.remove('item-enter'), { once: true });
      if (it.type === 'img') { const img = new Image(); img.alt = ''; img.decoding = 'async'; img.draggable = false; img.src = await urlFor(it.id) || ''; el.append(img); }
      else if (it.type === 'todo') buildTodo(el, it);
      else {
        const t = document.createElement('div'); t.contentEditable = 'plaintext-only'; t.spellcheck = false; t.textContent = it.text || '';
        t.addEventListener('input', () => { it.text = t.innerText; saveBoard(); });
        t.addEventListener('pointerdown', e => { if (document.activeElement === t) e.stopPropagation(); });
        t.addEventListener('keydown', e => e.stopPropagation());
        el.append(t);
      }
      const mark = document.createElement('span'); mark.className = 'pinmark';
      const ctl = document.createElement('div'); ctl.className = 'ctl';
      const pin = svgBtn('Pin', '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>', () => { it.pinned = !it.pinned; sync(it); saveBoard(); toast(it.pinned ? 'Pinned' : 'Unpinned'); }, 'pin');
      const del = svgBtn('Remove', '<path d="M6 6l12 12M18 6L6 18"/>', () => removeItem(it), 'del');
      if (it.type !== 'img') {
        const pal = document.createElement('div'); pal.className = 'pal';
        for (const [name, hex] of Object.entries(colorsFor(it))) {
          const b = document.createElement('button'); b.type = 'button'; b.dataset.c = name; b.style.background = hex; b.title = name[0].toUpperCase() + name.slice(1); b.setAttribute('aria-label', b.title + ' color');
          b.onclick = () => { it.color = name; sync(it); saveBoard(); };
          pal.append(b);
        }
        pal.addEventListener('pointerdown', e => e.stopPropagation());
        el.append(pal);
      }
      if (it.type === 'img') {
        const sq = svgBtn('Toggle corners', '', () => { it.square = !it.square; sync(it); saveBoard(); }, 'corner');
        ctl.append(sq);
      }
      ctl.append(pin, del);
      const rs = document.createElement('span'); rs.className = 'rs'; rs.title = it.type === 'todo' ? 'Scale (double-click to reset)' : 'Resize (double-click to reset)'; rs.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>';
      const rot = document.createElement('span'); rot.className = 'rot'; rot.title = 'Rotate (Shift to snap, double-click to reset)';
      rot.innerHTML = '<span class="line"></span><span class="knob"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg></span>';
      el.append(mark, ctl, rs, rot);
      ctl.addEventListener('pointerdown', e => e.stopPropagation());
      dragify(el, it);
      els.set(it.id, el); board.append(el);
    }
    sync(it);
  }
  const PINS = ['#e5484d', '#f76b15', '#ffc53d', '#30a46c', '#12a594', '#0090ff', '#6e56cf', '#d6409f', '#8d8d8d'];
  const pinColor = (id) => { let h = 0; for (const c of String(id || '')) h = (h * 31 + c.charCodeAt(0)) | 0; return PINS[Math.abs(h) % PINS.length]; };
  const NOTES = { yellow: '#fff3a3', pink: '#ffc9d9', green: '#c8f0b8', blue: '#bfe3ff', orange: '#ffd6a5', purple: '#e3d1ff' };
  const TODOS = { slate: '#e2e5ea', sky: '#c8ddf6', mint: '#c5ecd8', sand: '#ebdccb', lavender: '#dfd3f4', blush: '#f3ced7' };
  const colorsFor = (it) => it.type === 'todo' ? TODOS : NOTES;
  const noteColor = (it) => { const pal = colorsFor(it); return pal[it.color] ? it.color : Object.keys(pal)[Math.abs([...String(it.id || '')].reduce((h, c) => (h * 17 + c.charCodeAt(0)) | 0, 7)) % Object.keys(pal).length]; };
  function sync(it) {
    const el = els.get(it.id);
    if (!el) return;
    if (it.type === 'todo') {
      it.scale = +(it.scale || (it.w ? (it.w / 260).toFixed(3) : 1));
      el.style.setProperty('--td-scale', it.scale);
      it.w = Math.round(260 * it.scale);
      el.querySelectorAll('.td-task-text').forEach(t => {
        t.style.height = 'auto';
        if (t.scrollHeight > 0) t.style.height = t.scrollHeight + 'px';
      });
    } else if (it.type === 'note') {
      it.w = Math.max(140, Math.min(1000, it.w || 230));
      it.scale = +(it.w / 230).toFixed(3);
      el.style.setProperty('--note-scale', it.scale);
    } else {
      it.w = Math.max(100, Math.min(1200, it.w || 240));
    }
    if (isNaN(it.x)) it.x = 0.2;
    if (isNaN(it.y)) it.y = 0.2;
    el.style.left = (it.x * 100) + 'vw'; el.style.top = (it.y * 100) + 'vh';
    el.style.width = it.w + 'px';
    el.style.zIndex = it.z || 1;
    el.style.setProperty('--r', (it.r || 0) + 'deg');
    el.style.setProperty('--pin', pinColor(it.id));
    if (it.type !== 'img') { const pal = colorsFor(it); const c = noteColor(it); el.style.setProperty('--note', pal[c]); el.querySelectorAll('.pal button').forEach(b => b.classList.toggle('on', b.dataset.c === c)); }
    el.classList.toggle('pinned', !!it.pinned);
    if (it.type === 'img') {
      el.classList.toggle('square', !!it.square);
      const c = el.querySelector('.corner');
      if (c) {
        c.title = it.square ? 'Make corners rounded' : 'Make corners square'; c.setAttribute('aria-label', c.title);
        c.querySelector('svg').innerHTML = it.square ? '<path d="M6 19v-6a7 7 0 0 1 7-7h6"/>' : '<path d="M6 19V6h13"/>';
      }
    }
    const pinBtn = el.querySelector('.pin');
    if (pinBtn) {
      pinBtn.classList.toggle('on', !!it.pinned);
      pinBtn.title = it.pinned ? 'Unpin' : 'Pin';
    }
  }
  let lastHandleClick = { time: 0, mode: '', id: '' };
  function dragify(el, it) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      it.z = topZ(); el.style.zIndex = it.z;
      el.classList.remove('item-enter');
      if (it.pinned) return saveBoard();
      const mode = e.target.closest('.rs') ? 'resize' : e.target.closest('.rot') ? 'rotate' : 'move';
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY;
      const ox = (isNaN(it.x) ? 0.2 : it.x) * innerWidth, oy = (isNaN(it.y) ? 0.2 : it.y) * innerHeight;
      const ow = el.offsetWidth;
      const oh = it.type === 'note' ? ow : el.offsetHeight;
      const s0 = it.scale || 1;
      const r0 = it.r || 0;
      const box = el.getBoundingClientRect(), cx = box.left + box.width / 2, cy = box.top + box.height / 2;
      const a0 = Math.atan2(sy - cy, sx - cx);
      const k = r0 * Math.PI / 180, cosK = Math.cos(k), sinK = Math.sin(k);
      try { el.setPointerCapture(e.pointerId); } catch {}
      el.classList.add('drag', mode);
      document.body.classList.add('dragging-item', mode);
      let raf = 0, lx = sx, ly = sy, shift = false, moved = false;
      const frame = () => {
        raf = 0;
        const dx = lx - sx, dy = ly - sy;
        if (mode === 'resize') {
          // project pointer delta into the item's own (rotated) axes
          const ux = dx * cosK + dy * sinK, uy = -dx * sinK + dy * cosK;
          const denom = (ow * ow + oh * oh) || 1;
          const dw = ((ux * ow + uy * oh) / denom) * ow;

          if (it.type === 'todo') {
            const ratio = clamp((ow + dw) / ow, 0.3, 4);
            const newScale = clamp(s0 * ratio, 0.5, 3.0);
            it.scale = +newScale.toFixed(3);
            el.style.setProperty('--td-scale', it.scale);
            it.w = Math.round(260 * it.scale);
            el.style.width = it.w + 'px';
            el.querySelectorAll('.td-task-text').forEach(t => {
              t.style.height = 'auto';
              t.style.height = t.scrollHeight + 'px';
            });
          } else if (it.type === 'note') {
            const minW = 140, maxW = Math.min(1000, innerWidth - 20);
            it.w = Math.round(clamp(ow + dw, minW, maxW));
            it.scale = +(it.w / 230).toFixed(3);
            el.style.width = it.w + 'px';
            el.style.setProperty('--note-scale', it.scale);
          } else {
            const minW = 100, maxW = Math.min(1000, innerWidth - 20);
            it.w = Math.round(clamp(ow + dw, minW, maxW));
            el.style.width = it.w + 'px';
          }

          let nh;
          if (it.type === 'note') {
            nh = it.w; // sticky notes are strictly square
          } else if (it.type === 'img') {
            nh = Math.round(it.w * (oh / ow));
          } else {
            nh = el.offsetHeight;
          }

          // keep the top-left corner visually anchored while the center moves
          const dW = it.w - ow, dH = nh - oh;
          const shiftX = (dW / 2) * (1 - cosK) + (dH / 2) * sinK;
          const shiftY = (dH / 2) * (1 - cosK) - (dW / 2) * sinK;
          const nx = (ox - shiftX) / innerWidth;
          const ny = (oy - shiftY) / innerHeight;
          if (!isNaN(nx) && !isNaN(ny)) {
            it.x = nx;
            it.y = ny;
            el.style.left = it.x * 100 + 'vw';
            el.style.top = it.y * 100 + 'vh';
          }
        } else if (mode === 'rotate') {
          let r = r0 + (Math.atan2(ly - cy, lx - cx) - a0) * 180 / Math.PI;
          r = ((r + 540) % 360) - 180;
          if (shift) r = Math.round(r / 15) * 15;
          else if (Math.abs(r) < 2) r = 0; // gentle snap to straight
          it.r = Math.round(r * 10) / 10;
          el.style.setProperty('--r', it.r + 'deg');
        } else {
          it.x = (s.canvas ? ox + dx : clamp(ox + dx, -ow * 0.6, innerWidth - 40)) / innerWidth;
          it.y = (s.canvas ? oy + dy : clamp(oy + dy, -20, innerHeight - 40)) / innerHeight;
          el.style.left = it.x * 100 + 'vw';
          el.style.top = it.y * 100 + 'vh';
        }
      };
      const mv = (ev) => {
        lx = ev.clientX;
        ly = ev.clientY;
        shift = ev.shiftKey;
        if (!moved) {
          const thresh = mode === 'move' ? 4 : 1;
          if (Math.hypot(lx - sx, ly - sy) < thresh) return;
        }
        moved = true;
        raf ||= requestAnimationFrame(frame);
      };
      const up = () => {
        if (raf) {
          cancelAnimationFrame(raf);
          raf = 0;
          frame();
        }
        try { el.releasePointerCapture(e.pointerId); } catch {}
        window.removeEventListener('pointermove', mv);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        el.classList.remove('drag', mode);
        document.body.classList.remove('dragging-item', mode);
        saveBoard();
        if (!moved) {
          if (mode === 'move' && it.type === 'note') {
            editAt(el, sx, sy);
          } else if (mode !== 'move') {
            const now = Date.now();
            if (now - lastHandleClick.time < 450 && lastHandleClick.mode === mode && lastHandleClick.id === it.id) {
              lastHandleClick = { time: 0, mode: '', id: '' };
              if (mode === 'rotate') {
                it.r = 0;
                sync(it);
                saveBoard();
                toast('Reset rotation');
              } else if (mode === 'resize') {
                if (it.type === 'todo') { it.scale = 1; it.w = 260; }
                else if (it.type === 'note') { it.w = 230; it.scale = 1; }
                else if (it.type === 'img') { it.w = 240; }
                sync(it);
                saveBoard();
                toast('Reset size');
              }
            } else {
              lastHandleClick = { time: now, mode, id: it.id };
            }
          }
        }
      };
      window.addEventListener('pointermove', mv);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
    el.addEventListener('dblclick', (e) => {
      if (e.target.closest('.rot')) { it.r = 0; sync(it); saveBoard(); toast('Reset rotation'); }
      else if (e.target.closest('.rs')) {
        if (it.type === 'todo') { it.scale = 1; it.w = 260; }
        else if (it.type === 'note') { it.w = 230; it.scale = 1; }
        else if (it.type === 'img') { it.w = 240; }
        sync(it);
        saveBoard();
        toast('Reset size');
      }
    });
  }
  function editAt(el, x, y) {
    const t = el.querySelector('[contenteditable]'); if (!t) return;
    t.focus();
    const r = document.caretRangeFromPoint?.(x, y);
    const sel = getSelection();
    if (sel) {
      sel.removeAllRanges();
      if (r && t.contains(r.startContainer)) sel.addRange(r);
      else { const e = document.createRange(); e.selectNodeContents(t); e.collapse(false); sel.addRange(e); }
    }
  }
  function removeItem(it) {
    s.board = s.board.filter(x => x !== it);
    const el = els.get(it.id);
    if (el) {
      el.animate([{ opacity: 1, transform: getComputedStyle(el).transform }, { opacity: 0, transform: 'scale(.9)' }], { duration: 180, easing: 'ease-out' }).onfinish = () => el.remove();
      els.delete(it.id);
    }
    if (it.type === 'img') { dropUrl(it.id); blobs.del(it.id).catch(() => {}); }
    saveBoard();
    updateStats();
  }
  async function addImages(files, at) {
    for (const f of files) {
      if (!f.type.startsWith('image/')) continue;
      try {
        const blob = await shrink(f, 1400, isPng(f) ? 'image/webp' : 'image/jpeg');
        const id = 'pin_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        await blobs.put(id, blob);
        const pos = at ? { x: (at.x - (s.canvas ? s.pan.x : 0)) / innerWidth - 0.08, y: (at.y - (s.canvas ? s.pan.y : 0)) / innerHeight - 0.08, r: randPos().r } : randPos();
        const it = { id, type: 'img', ...pos, w: 240, z: topZ(), pinned: false };
        s.board.push(it); await renderItem(it);
      } catch { toast('Could not read that image'); }
    }
    saveBoard();
    updateStats();
  }
  /* ---------- to-do lists ---------- */
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const stop = (e) => e.stopPropagation();
  function buildTodo(el, it) {
    if (!Array.isArray(it.tasks)) it.tasks = [];
    const head = document.createElement('div'); head.className = 'td-head';
    const title = document.createElement('input'); title.className = 'td-title'; title.placeholder = 'To-do'; title.value = it.title || ''; title.spellcheck = false;
    title.addEventListener('input', () => { it.title = title.value; saveBoard(); });
    title.addEventListener('keydown', (e) => {
      stop(e);
      if (e.key === 'Enter' || e.key === 'ArrowDown') {
        e.preventDefault();
        const first = list.firstElementChild?.querySelector('.td-task-text') || add;
        first?.focus();
      }
    });
    const count = document.createElement('span'); count.className = 'td-count';
    head.append(title, count);
    const bar = document.createElement('div'); bar.className = 'td-bar'; const fill = document.createElement('i'); bar.append(fill);
    const list = document.createElement('ul'); list.className = 'td-list';
    const addRow = document.createElement('label'); addRow.className = 'td-add';
    addRow.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
    const add = document.createElement('input'); add.placeholder = 'Add a task'; add.spellcheck = false; addRow.append(add);
    add.addEventListener('keydown', (e) => {
      stop(e);
      if (e.key === 'Enter' && add.value.trim()) {
        it.tasks.push({ id: uid(), text: add.value.trim(), done: false });
        add.value = ''; draw(); saveBoard();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const lastTx = list.lastElementChild?.querySelector('.td-task-text') || title;
        if (lastTx) {
          lastTx.focus();
          lastTx.setSelectionRange?.(lastTx.value.length, lastTx.value.length);
        }
      }
    });
    const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'td-clear'; clear.textContent = 'Clear completed';
    clear.onclick = () => { it.tasks = it.tasks.filter(t => !t.done); draw(); saveBoard(); };
    [title, add, list, clear].forEach(x => x.addEventListener('pointerdown', stop));
    addRow.addEventListener('pointerdown', stop);
    function draw(focusId, atEnd) {
      list.replaceChildren();
      it.tasks.forEach((t, i) => {
        const li = document.createElement('li'); li.classList.toggle('done', t.done);
        const cb = document.createElement('button'); cb.type = 'button'; cb.className = 'td-check'; cb.setAttribute('role', 'checkbox'); cb.setAttribute('aria-checked', String(!!t.done));
        cb.innerHTML = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
        cb.onclick = () => { t.done = !t.done; li.classList.toggle('done', t.done); cb.setAttribute('aria-checked', String(t.done)); meta(); saveBoard(); };
        const tx = document.createElement('textarea'); tx.className = 'td-task-text'; tx.rows = 1; tx.value = t.text; tx.spellcheck = false;
        const autoH = () => { tx.style.height = 'auto'; if (tx.scrollHeight > 0) tx.style.height = tx.scrollHeight + 'px'; };
        tx.addEventListener('input', () => { autoH(); t.text = tx.value; saveBoard(); });
        tx.addEventListener('keydown', (e) => {
          stop(e);
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const n = { id: uid(), text: '', done: false }; it.tasks.splice(i + 1, 0, n); draw(n.id); saveBoard(); }
          else if (e.key === 'Backspace' && !tx.value) { e.preventDefault(); it.tasks.splice(i, 1); const prev = it.tasks[i - 1]; draw(prev?.id, true); if (!prev) add.focus(); saveBoard(); }
          else if (e.key === 'ArrowUp') {
            if (tx.selectionStart === 0 && tx.selectionEnd === 0) {
              e.preventDefault();
              if (it.tasks[i - 1]) {
                const prevTx = list.children[i - 1]?.querySelector('.td-task-text, input');
                if (prevTx) { prevTx.focus(); prevTx.setSelectionRange(prevTx.value.length, prevTx.value.length); }
              } else {
                title.focus();
                title.setSelectionRange?.(title.value.length, title.value.length);
              }
            }
          }
          else if (e.key === 'ArrowDown') {
            if (tx.selectionStart === tx.value.length && tx.selectionEnd === tx.value.length) {
              e.preventDefault();
              const nextTx = list.children[i + 1]?.querySelector('.td-task-text, input') || add;
              if (nextTx) { nextTx.focus(); if (nextTx.setSelectionRange) nextTx.setSelectionRange(0, 0); }
            }
          }
        });
        tx.addEventListener('blur', () => { if (!t.text.trim() && it.tasks.includes(t)) { it.tasks = it.tasks.filter(x => x !== t); draw(); saveBoard(); } });
        const x = document.createElement('button'); x.type = 'button'; x.className = 'td-x'; x.setAttribute('aria-label', 'Delete task');
        x.innerHTML = '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
        x.onclick = () => { it.tasks = it.tasks.filter(y => y !== t); draw(); saveBoard(); };
        li.append(cb, tx, x); list.append(li);
        autoH();
        if (t.id === focusId) requestAnimationFrame(() => { tx.focus(); if (atEnd) tx.setSelectionRange(tx.value.length, tx.value.length); });
      });
      meta();
    }
    function meta() {
      const done = it.tasks.filter(t => t.done).length, n = it.tasks.length;
      count.textContent = n ? `${done}/${n}` : '';
      fill.style.width = n ? (done / n * 100) + '%' : '0';
      bar.hidden = !n; clear.hidden = !done;
      el.classList.toggle('all-done', n > 0 && done === n);
    }
    el.append(head, bar, list, addRow, clear);
    draw();
  }
  function addTodo() {
    const it = { id: 'todo_' + uid(), type: 'todo', color: Object.keys(TODOS)[Math.floor(Math.random() * Object.keys(TODOS).length)], ...randPos(), w: 260, scale: 1, z: topZ(), pinned: false, title: '', tasks: [] };
    s.board.push(it); renderItem(it).then(() => els.get(it.id)?.querySelector('.td-title')?.focus()); saveBoard(); updateStats();
  }
  function addNote() {
    const it = { id: 'note_' + Date.now().toString(36), type: 'note', color: Object.keys(NOTES)[Math.floor(Math.random() * Object.keys(NOTES).length)], ...randPos(), w: 230, z: topZ(), pinned: false, text: '' };
    s.board.push(it); renderItem(it).then(() => els.get(it.id)?.querySelector('[contenteditable]')?.focus()); saveBoard(); updateStats();
  }
  const pickPin = () => $('#pinFile').click();
  $('#pinFile').onchange = (e) => { addImages([...e.target.files]); e.target.value = ''; };
  const menu = $('#addMenu'), addBtn = $('#addBtn');
  if (!/Mac/.test(navigator.userAgent)) $('#addPin kbd').textContent = 'Ctrl V';
  const setMenu = (v) => { menu.classList.toggle('open', v); addBtn.classList.toggle('active', v); addBtn.setAttribute('aria-expanded', v); };
  addBtn.onclick = (e) => { e.stopPropagation(); setMenu(!menu.classList.contains('open')); };
  document.addEventListener('pointerdown', (e) => { if (menu.classList.contains('open') && !e.target.closest('.add-wrap')) setMenu(false); });
  $('#addPin').onclick = () => { setMenu(false); pickPin(); };
  $('#addNote').onclick = () => { setMenu(false); addNote(); };
  $('#addTodo').onclick = () => { setMenu(false); addTodo(); };
  $('#addLink').onclick = () => { setMenu(false); openLinkDlg(); };
  $('#addTodo2').onclick = addTodo;
  $('#addPin2').onclick = pickPin; $('#addNote2').onclick = addNote;
  $('#clearBoard').onclick = () => { if (!s.board.length || !confirm('Remove all pinned images and notes?')) return; [...s.board].forEach(removeItem); updateStats(); };

  // drag & drop and paste
  let dragDepth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  addEventListener('dragenter', e => { if (hasFiles(e)) { dragDepth++; document.body.classList.add('dropping'); } });
  addEventListener('dragleave', e => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dropping'); } });
  addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  addEventListener('drop', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; document.body.classList.remove('dropping'); addImages([...e.dataTransfer.files], { x: e.clientX, y: e.clientY }); });
  addEventListener('paste', e => { if (e.target.closest?.('input,[contenteditable]')) return; const f = [...(e.clipboardData?.files || [])]; if (f.length) { e.preventDefault(); addImages(f); } });

  /* ---------- pannable canvas ---------- */
  const pat = $('#pattern');
  function applyPan(animate) {
    const p = s.canvas ? { x: +s.pan?.x || 0, y: +s.pan?.y || 0 } : { x: 0, y: 0 };
    board.style.transition = pat.style.transition = animate ? 'transform .5s cubic-bezier(.2,.8,.2,1), background-position .5s cubic-bezier(.2,.8,.2,1)' : '';
    board.style.transform = p.x || p.y ? `translate3d(${p.x}px,${p.y}px,0)` : '';
    pat.style.backgroundPosition = `calc(50% + ${p.x}px) calc(50% + ${p.y}px)`;
    document.body.classList.toggle('pannable', s.canvas);
    $('#canvas').checked = !!s.canvas;
  }
  const isEmpty = (t) => t === document.body || t === document.documentElement || t.id === 'bgimg';
  addEventListener('pointerdown', (e) => {
    if (!s.canvas || e.button !== 0 || !isEmpty(e.target)) return;
    const sx = e.clientX - s.pan.x, sy = e.clientY - s.pan.y; let raf = 0, lx = e.clientX, ly = e.clientY;
    document.body.classList.add('panning'); applyPan(false);
    const mv = (ev) => { lx = ev.clientX; ly = ev.clientY; raf ||= requestAnimationFrame(() => { raf = 0; s.pan = { x: Math.round(lx - sx), y: Math.round(ly - sy) }; applyPan(false); }); };
    const up = () => {
      if (raf) { cancelAnimationFrame(raf); raf = 0; s.pan = { x: Math.round(lx - sx), y: Math.round(ly - sy) }; applyPan(false); }
      removeEventListener('pointermove', mv); removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
      document.body.classList.remove('panning'); save(['pan'], 300);
    };
    addEventListener('pointermove', mv); addEventListener('pointerup', up); addEventListener('pointercancel', up);
  });
  addEventListener('dblclick', (e) => { if (s.canvas && isEmpty(e.target) && (s.pan.x || s.pan.y)) { s.pan = { x: 0, y: 0 }; applyPan(true); save(['pan']); } });
  $('#recenter').onclick = () => { s.pan = { x: 0, y: 0 }; applyPan(true); save(['pan']); };
  $('#canvas').onchange = (e) => { s.canvas = e.target.checked; applyPan(true); save(['canvas']); };

  /* ---------- settings controls ---------- */
  $$('#mode button').forEach(b => b.onclick = () => { const prev = s.mode; s.mode = b.dataset.v; const keepAccent = s.colors.accent !== PRESETS[prev].accent; s.colors = { ...PRESETS[s.mode], accent: keepAccent ? s.colors.accent : PRESETS[s.mode].accent }; applyTheme(); save(['mode', 'colors']); });
  [['#cAccent', 'accent'], ['#cBg', 'bg'], ['#cText', 'text']].forEach(([q, k]) => $(q).addEventListener('input', e => { s.colors[k] = e.target.value; applyTheme(); save(['colors'], 200); }));
  const ACCENTS = ['#3b5bdb', '#8ea2ff', '#0090ff', '#12a594', '#30a46c', '#f76b15', '#e5484d', '#d6409f', '#6e56cf'];
  ACCENTS.forEach(c => { const b = document.createElement('button'); b.type = 'button'; b.dataset.c = c; b.style.background = c; b.title = c.toUpperCase(); b.setAttribute('aria-label', 'Accent ' + c); b.onclick = () => { s.colors.accent = c; applyTheme(); save(['colors']); }; $('#presets').append(b); });
  const parseHex = (v) => { v = v.trim().replace(/^#/, ''); if (/^[0-9a-f]{3}$/i.test(v)) v = [...v].map(c => c + c).join(''); return /^[0-9a-f]{6}$/i.test(v) ? '#' + v.toLowerCase() : null; };
  $$('.hex input').forEach(inp => {
    const k = inp.dataset.k;
    inp.addEventListener('input', () => { inp.value = inp.value.replace(/[^0-9a-f#]/gi, ''); const c = parseHex(inp.value); inp.parentElement.classList.toggle('bad', !c && inp.value.length > 0); if (c && inp.value.replace('#', '').length === 6) { s.colors[k] = c; applyTheme(); save(['colors'], 200); } });
    inp.addEventListener('blur', () => { const c = parseHex(inp.value); if (c) { s.colors[k] = c; save(['colors']); } applyTheme(); });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') inp.blur(); });
  });
  $('#resetColors').onclick = () => { s.colors = { ...PRESETS[s.mode] }; applyTheme(); save(['colors']); };
  $$('#pattern-seg button').forEach(b => b.onclick = () => { s.pattern = b.dataset.v; applyBg(); save(['pattern']); });
  [['#patOp', 'patOp'], ['#patSize', 'patSize'], ['#dim', 'dim'], ['#blur', 'blur']].forEach(([q, k]) => $(q).addEventListener('input', e => { s[k] = +e.target.value; applyBg(); save([k], 200); }));
  $('#overlay').onchange = (e) => { s.overlay = e.target.checked; applyBg(); save(['overlay']); };
  [['#secAccent', 'secAccent'], ['#showClock', 'showClock'], ['#h24', 'h24'], ['#secs', 'secs'], ['#showDate', 'showDate']].forEach(([q, k]) => $(q).onchange = (e) => { s[k] = e.target.checked; applyClockOpts(); save([k]); });
  $('#clockSize').addEventListener('input', (e) => { s.clockSize = +e.target.value; applyClockSize(); save(['clockSize'], 200); });
  $('#clockSize').addEventListener('dblclick', () => { s.clockSize = 100; applyClockSize(); save(['clockSize']); });
  $('#bgFile').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try { const blob = await shrink(f, Math.min(2560, Math.max(1280, Math.round((screen.width || 1920) * (window.devicePixelRatio || 1)))), 'image/jpeg'); await blobs.put('bg', blob); dropUrl('bg'); s.hasImg = true; await applyBg(); save(['hasImg']); }
    catch { toast('Could not use that image'); }
  };
  $('#clearImg').onclick = () => { dropUrl('bg'); blobs.del('bg'); s.hasImg = false; applyBg(); save(['hasImg']); };

  // data: export / import / reset
  const toDataURL = (b) => new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
  $('#exportBtn').onclick = async () => {
    const out = { app: 'quiet-tab', v: 2, settings: s, blobs: {} };
    for (const k of ['bg', ...s.board.filter(i => i.type === 'img').map(i => i.id)]) { const b = await blobs.get(k); if (b) out.blobs[k] = await toDataURL(b); }
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(out)], { type: 'application/json' }));
    a.download = `quiet-tab-${new Date().toISOString().slice(0, 10)}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const cancelSaves = () => {
    window.removeEventListener('pagehide', flushSave);
    window.removeEventListener('beforeunload', flushSave);
    for (const k of Object.keys(timers)) { clearTimeout(timers[k]); delete timers[k]; }
  };
  $('#importFile').onchange = async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const data = JSON.parse(await f.text()); if (data.app !== 'quiet-tab' || !data.settings) throw 0;
      cancelSaves();
      await blobs.clear();
      for (const [k, v] of Object.entries(data.blobs || {})) {
        try {
          const res = await fetch(v);
          await blobs.put(k, await res.blob());
        } catch {
          const arr = v.split(','), mime = arr[0].match(/:(.*?);/)?.[1] || 'image/jpeg';
          const bstr = atob(arr[1]);
          const u8 = new Uint8Array(bstr.length);
          for (let i = 0; i < bstr.length; i++) u8[i] = bstr.charCodeAt(i);
          await blobs.put(k, new Blob([u8], { type: mime }));
        }
      }
      await store.clear();
      await store.set({ ...DEFAULT, ...data.settings });
      await store.set({ onboarding: { status: 'done' } }); // restoring a backup isn't a first run
      location.reload();
    } catch { toast('Not a valid Quiet Tab backup'); }
  };
  $('#resetAll').onclick = async () => {
    if (!confirm('Erase all settings, shortcuts, pinned images and notes? This cannot be undone.')) return;
    cancelSaves();
    await store.clear();
    await blobs.clear();
    location.reload();
  };

  /* ---------- panel & keyboard ---------- */
  function updateStats() {
    $('#boardCount').textContent = s.board.length || '';
    $('#clearBoard').disabled = !s.board.length;
  }
  const open = (v) => { if (v) updateStats(); document.body.classList.toggle('open', v); $('#panel').setAttribute('aria-hidden', !v); $('#panel').inert = !v; };
  $('#openSettings').onclick = () => open(true);
  $('#closeSettings').onclick = $('#scrim').onclick = () => open(false);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { setMenu(false); open(false); document.activeElement?.blur(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey || e.target.closest('input,textarea,[contenteditable]')) return;
    if (e.key === ',') { e.preventDefault(); open(!document.body.classList.contains('open')); return; }
    if (document.body.classList.contains('open')) return;
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); addNote(); }
    else if (e.key === 't' || e.key === 'T') { e.preventDefault(); addTodo(); }
    else if (e.key === 's' || e.key === 'S') { e.preventDefault(); openLinkDlg(); }
    else if (/^[1-9]$/.test(e.key) && s.links[e.key - 1]) location.href = s.links[e.key - 1].url;
  });

  /* ---------- boot ---------- */
  /* ---------- onboarding tour: own storage key, so "Reset everything" brings it back ---------- */
  const esc = (t) => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const hueOf = (n) => Math.abs([...n].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)) % 360;
  const nowParts = () => { const d = new Date(); let h = d.getHours(); if (!s.h24) h = h % 12 || 12; return { hm: `${s.h24 ? p2(h) : h}:${p2(d.getMinutes())}`, sec: p2(d.getSeconds()), date: d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) }; };
  const svg = (p, w = 12, sw = 2) => `<svg viewBox="0 0 24 24" width="${w}" height="${w}" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  const CURSOR = '<svg class="mk-cursor" viewBox="0 0 24 24"><path d="M5 3l14 7-6.2 1.8L10 18z" fill="#111" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/></svg>';

  // A miniature, live replica of Quiet Tab that the tour "films" with a virtual camera.
  function buildMini() {
    const t = nowParts();
    const ls = (s.links.length ? s.links : DEFAULT.links).slice(0, 4);
    const tiles = ls.map((l, i) => { const h = host(l.url || ''), ch = (l.name || h || '?').trim()[0] || '?'; return `<span class="mk-tile" style="--h:${hueOf(h)}">${esc(ch.toUpperCase())}<kbd style="--i:${i}">${i + 1}</kbd></span>`; }).join(''); // same letter + hue as the real dock
    const rows = [
      ['Image', '⌘V', 'var(--accent)', '<rect x="3.5" y="4.5" width="17" height="15" rx="3.5"/><circle cx="15.5" cy="9" r="1.4"/><path d="M3.8 16.5l4.4-4.4a1.6 1.6 0 0 1 2.3 0l5.6 5.6"/>'],
      ['Sticky note', 'N', '#d9a400', '<path d="M20.5 14.5V7A2.5 2.5 0 0 0 18 4.5H6A2.5 2.5 0 0 0 3.5 7v11A2.5 2.5 0 0 0 6 20.5h8.5z"/><path d="M14.5 20.5v-4a2 2 0 0 1 2-2h4"/>'],
      ['To-do list', 'T', '#2f9e6b', '<rect x="3.5" y="3.5" width="17" height="17" rx="3.5"/><path d="M7.5 9l1.5 1.5L12 7.5M7.5 15l1.5 1.5L12 13.5"/>'],
      ['Shortcut', 'S', '#d6336c', '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>']
    ].map(([n, k, c, p], i) => `<div class="mk-row" style="--i:${i};--c:${c}"><b>${svg(p, 10)}</b><span>${n}</span><kbd>${k}</kbd></div>`).join('');
    $('#mk').innerHTML = `
      <div class="mk-a mk-clock" style="--d:.35s"><div class="mk-time"><span data-hm>${t.hm}</span>${s.secs ? `<em data-sec>${t.sec}</em>` : ''}</div><div class="mk-date">${esc(t.date)}</div></div>
      <div class="mk-tags">${[s.h24 ? '24-hour' : '12-hour', 'Seconds', 'Date', 'Size'].map((x, i) => `<span style="--i:${i}">${x}</span>`).join('')}</div>
      <div class="mk-a mk-photo-w mk-drop" style="--d:.75s"><div class="mk-photo"><i></i></div></div>
      <div class="mk-a mk-todo-w mk-drop" style="--d:.9s"><div class="mk-todo"><strong>Today</strong><span class="on" style="--w:52px"></span><span style="--w:66px"></span><span style="--w:42px"></span></div></div>
      <div class="mk-a mk-note-w mk-drop" style="--d:1.05s"><div class="mk-note">Call mom<br>at six<i class="mk-h rs"></i><i class="mk-h rot"></i>${CURSOR}</div></div>
      <div class="mk-menu">${rows}</div>
      <div class="mk-a mk-dock" style="--d:.55s">${tiles}<span class="mk-div"></span><span class="mk-btn mk-plus">${svg('<path d="M12 5v14M5 12h14"/>')}</span><span class="mk-btn">${svg('<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>', 12, 1.6)}</span></div>
      ${CURSOR}`;
  }

  // cam: region of the 600x380 mini page to frame, in its own coordinates.
  const TOUR = [
    { key: 'welcome', kicker: 'Welcome', next: 'Begin', cam: [0, 0, 600, 380], title: 'Your new tab, <em>quietly</em> beautiful.', body: 'A calm, personal space every time you open a tab. Take a one-minute tour of what it can do.' },
    { key: 'clock', kicker: 'Clock', cam: [10, 10, 300, 190], title: 'Time, set in <em>type.</em>', body: 'A live clock and date greet you in the corner. Choose 12 or 24-hour, add seconds, resize it, or hide it in Settings.' },
    { key: 'links', kicker: 'Shortcuts', cam: [150, 236, 300, 144], title: 'Favorites, <em>one key</em> away.', body: 'Your shortcuts sit in the dock. Click one, or press <kbd>1</kbd>–<kbd>9</kbd> to jump straight there.' },
    { key: 'create', kicker: 'Create', cam: [185, 196, 250, 178], title: 'Add <em>anything.</em>', body: 'Tap the plus to pin an image, a sticky note, a to-do list or a new shortcut. Or skip the menu with <kbd>N</kbd>, <kbd>T</kbd> and <kbd>S</kbd>.' },
    { key: 'board', kicker: 'Pinboard', cam: [222, 44, 372, 236], title: 'A canvas for your <em>thoughts.</em>', body: 'Drag anything anywhere. Use the handles to resize and rotate, and paste or drop images straight onto the page.' },
    { key: 'theme', kicker: 'Personalize', cam: [0, 0, 600, 380], title: 'Make it <em>yours.</em>', body: 'Pick a look. It applies instantly, and you can fine-tune colors, backgrounds and patterns anytime in Settings.', extra: true },
    { key: 'done', kicker: 'Ready', next: 'Start exploring', cam: [0, 0, 600, 380], title: 'You’re <em>all set.</em>', body: 'Enjoy the quiet. Replay this tour anytime from Settings → Help.' }
  ];
  const tourEl = $('#tour'), mk = $('#mk');
  let tourI = -1, tourPrevFocus = null, tourClock = 0, tourLeaveT = 0;
  TOUR.forEach((st, i) => { const b = document.createElement('button'); b.type = 'button'; b.setAttribute('aria-label', `Step ${i + 1}: ${st.kicker}`); b.onclick = () => showStep(i); $('#tourDots').append(b); });

  function aimCamera() {
    const st = TOUR[tourI]; if (!st) return;
    const screen = $('.tq-screen'), fit = screen.clientWidth / 600;
    const [x, y, w, h] = st.cam, k = Math.min(600 / w, 380 / h);
    // Center the region, but never pan past the page edges.
    const tx = Math.min(0, Math.max(600 - 600 * k, 300 - (x + w / 2) * k));
    const ty = Math.min(0, Math.max(380 - 380 * k, 190 - (y + h / 2) * k));
    mk.style.transform = `scale(${fit}) translate(${tx}px, ${ty}px) scale(${k})`;
  }
  function renderPicker() {
    const ex = $('#tourExtra');
    if (!TOUR[tourI].extra) { ex.innerHTML = ''; return; }
    const accents = [PRESETS[s.mode].accent, '#0090ff', '#12a594', '#30a46c', '#f76b15', '#e5484d', '#d6409f', '#6e56cf'];
    ex.innerHTML = `<div class="tq-modes" role="group" aria-label="Appearance">
        <button type="button" data-v="light" aria-pressed="${s.mode === 'light'}" class="${s.mode === 'light' ? 'on' : ''}">${svg('<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/>', 14)}Light</button>
        <button type="button" data-v="dark" aria-pressed="${s.mode === 'dark'}" class="${s.mode === 'dark' ? 'on' : ''}">${svg('<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>', 14)}Dark</button>
      </div>
      <div class="tq-accents" role="group" aria-label="Accent color">${accents.map(c => `<button type="button" data-c="${c}" style="--c:${c}" aria-label="Accent ${c}" aria-pressed="${c.toLowerCase() === s.colors.accent.toLowerCase()}" class="${c.toLowerCase() === s.colors.accent.toLowerCase() ? 'on' : ''}"></button>`).join('')}</div>`;
    // Reuse the Settings controls so the choice is applied and saved exactly like a manual change.
    $$('#tourExtra .tq-modes button').forEach(b => b.onclick = () => { $(`#mode button[data-v="${b.dataset.v}"]`).click(); renderPicker(); $(`#tourExtra .tq-modes button[data-v="${b.dataset.v}"]`).focus(); });
    $$('#tourExtra .tq-accents button').forEach(b => b.onclick = () => { const c = b.dataset.c; s.colors.accent = c; applyTheme(); save(['colors']); renderPicker(); $(`#tourExtra .tq-accents button[data-c="${c}"]`).focus(); });
  }
  function showStep(i) {
    tourI = Math.max(0, Math.min(i, TOUR.length - 1));
    const st = TOUR[tourI], last = tourI === TOUR.length - 1;
    store.set({ onboarding: { status: 'active', step: tourI } });
    tourEl.dataset.step = st.key;
    $('#tourNum').textContent = p2(tourI + 1);
    $('#tourStep').innerHTML = `${p2(tourI + 1)} <b>/ ${p2(TOUR.length)}</b> &nbsp;·&nbsp; ${st.kicker}`;
    $('#tourTitle').innerHTML = st.title;
    $('#tourBody').innerHTML = st.body;
    renderPicker();
    const txt = $('.tq-text'); txt.classList.remove('swap'); void txt.offsetWidth; txt.classList.add('swap');
    $('#tourBack').disabled = tourI === 0;
    $('#tourNext span').textContent = st.next || 'Next';
    $('#tourSkip').hidden = last;
    $$('#tourDots button').forEach((b, j) => { b.classList.toggle('on', j === tourI); b.classList.toggle('done', j < tourI); b.setAttribute('aria-current', j === tourI ? 'step' : 'false'); });
    aimCamera();
    if (!tourEl.contains(document.activeElement) || document.activeElement.disabled) $('#tourNext').focus({ preventScroll: true });
  }
  const tickMini = () => { const t = nowParts(); $$('#mk [data-hm]').forEach(e => e.textContent = t.hm); $$('#mk [data-sec]').forEach(e => e.textContent = t.sec); };
  function startTour(step = 0) {
    setMenu(false); open(false);
    clearTimeout(tourLeaveT); tourEl.classList.remove('leaving');
    if (tourI < 0) tourPrevFocus = document.activeElement;
    buildMini();
    tourEl.hidden = false;
    // Restart entrance animations when replaying.
    $$('#tour .tq, #tour .tq-veil, #tour .tq-device').forEach(e => { e.style.animation = 'none'; void e.offsetWidth; e.style.animation = ''; });
    clearInterval(tourClock); tourClock = setInterval(tickMini, 1000);
    document.addEventListener('keydown', onTourKey, true);
    addEventListener('resize', aimCamera);
    mk.style.transition = 'none'; showStep(step); void mk.offsetWidth; mk.style.transition = '';
    $('#tourNext').focus({ preventScroll: true });
  }
  function endTour(status) {
    if (tourI < 0) return;
    store.set({ onboarding: { status, step: tourI } });
    tourI = -1; clearInterval(tourClock);
    document.removeEventListener('keydown', onTourKey, true);
    removeEventListener('resize', aimCamera);
    tourEl.classList.add('leaving');
    tourLeaveT = setTimeout(() => { tourEl.hidden = true; tourEl.classList.remove('leaving'); $('#mk').innerHTML = ''; }, 500);
    if (tourPrevFocus?.isConnected && tourPrevFocus !== document.body) tourPrevFocus.focus(); else document.activeElement?.blur();
    if (status === 'skipped') toast('Tutorial skipped. Replay it from Settings → Help');
    else { const tb = $('#toolbar'); tb.classList.remove('tq-ping'); setTimeout(() => { tb.classList.add('tq-ping'); setTimeout(() => tb.classList.remove('tq-ping'), 3000); }, 450); }
  }
  function onTourKey(e) {
    // While the tour is open it owns the keyboard: no app shortcuts fire underneath it.
    e.stopImmediatePropagation();
    if (e.key === 'Escape') { e.preventDefault(); endTour('skipped'); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); $('#tourNext').click(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); if (tourI > 0) showStep(tourI - 1); }
    else if (e.key === 'Tab') {
      const f = [...$$('#tour button:not([disabled]):not([hidden])')].filter(b => b.offsetParent), a = f.indexOf(document.activeElement);
      e.preventDefault(); f[(a + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
    }
  }
  $('#tourNext').onclick = () => tourI === TOUR.length - 1 ? endTour('done') : showStep(tourI + 1);
  $('#tourBack').onclick = () => showStep(tourI - 1);
  $('#tourSkip').onclick = () => endTour('skipped');
  $('#replayTour').onclick = () => { tourPrevFocus = null; startTour(0); };

  async function boot() {
    const d = await store.get([...Object.keys(DEFAULT), 'image', 'onboarding']);
    for (const k in DEFAULT) if (d[k] !== undefined) s[k] = d[k];
    if (!Array.isArray(s.board)) s.board = [];
    if (!Array.isArray(s.links)) s.links = structuredClone(DEFAULT.links);
    if (typeof s.colors !== 'object' || !s.colors) s.colors = { ...PRESETS.light };
    if (typeof s.pan !== 'object' || !s.pan) s.pan = { x: 0, y: 0 };
    if (!['bottom', 'top', 'left', 'right'].includes(s.barPos)) s.barPos = 'bottom';
    if (d.image) { // migrate v1 base64 background into IndexedDB
      try { await blobs.put('bg', await (await fetch(d.image)).blob()); s.hasImg = true; await store.set({ hasImg: true }); } catch {}
      store.remove('image');
    }
    applyTheme(); applyBar(); applyClockOpts(); renderLinks(); await applyBg();
    s.board.forEach(renderItem); applyPan(false);
    // First run (or after a reset): show the tour; resume where the user left off if they closed mid-tour.
    const ob = d.onboarding;
    if (!ob || ob.status === 'active') setTimeout(() => startTour(ob?.step || 0), 350);
  }
  open(false);
  applyTheme(); tick();
  boot();
})();