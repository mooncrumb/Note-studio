/* Note Studio: publish simulator + library + image editor. Everything is stored in the browser IndexedDB. */
(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  /* ================= common ================= */
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const chars = (s) => Array.from(s || '').length;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const fmtTime = (t) => { const d = new Date(t); return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const fmtSize = (b) => !b ? '' : b < 1024 * 1024 ? Math.max(1, Math.round(b / 1024)) + ' KB' : (b / 1024 / 1024).toFixed(1) + ' MB';
  let toastT = 0;
  function toast(t) { const el = $('toast'); el.textContent = t; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { el.hidden = true; }, 2600); }
  function setStatus(t, cls) { const el = $('saveStatus'); el.textContent = t; el.className = 'status' + (cls ? ' ' + cls : ''); }
  /* dangerous actions that need two clicks */
  const armed = new WeakMap();
  function twice(btn, msg, fn) {
    if (armed.get(btn)) { clearTimeout(armed.get(btn)); armed.delete(btn); btn.classList.remove('armed'); fn(); return; }
    btn.classList.add('armed'); toast(msg);
    armed.set(btn, setTimeout(() => { armed.delete(btn); btn.classList.remove('armed'); }, 3000));
  }
  function blobToDataURL(blob) { return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); }); }
  async function dataURLToBlob(d) { const r = await fetch(d); return r.blob(); }
  function loadImage(src) { return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; }); }
  /* shrink an image to a dataURL (used in notes) */
  async function shrink(src, maxW, maxH, q) {
    const isBlob = src instanceof Blob;
    const url = isBlob ? URL.createObjectURL(src) : src;
    try {
      const im = await loadImage(url);
      const r = Math.min(1, maxW / im.naturalWidth, maxH / im.naturalHeight);
      const c = document.createElement('canvas');
      c.width = Math.round(im.naturalWidth * r); c.height = Math.round(im.naturalHeight * r);
      c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', q || 0.85);
    } finally { if (isBlob) URL.revokeObjectURL(url); }
  }
  function download(blobOrUrl, name) {
    const a = document.createElement('a');
    const url = blobOrUrl instanceof Blob ? URL.createObjectURL(blobOrUrl) : blobOrUrl;
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    if (blobOrUrl instanceof Blob) setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
  function openModal(id) { $(id).hidden = false; }
  function closeModal(id) { $(id).hidden = true; }

  /* ================= storage (IndexedDB) ================= */
  const mem = { notes: new Map(), assets: new Map(), kv: new Map() };
  const DB = {
    db: null, ok: false,
    open() {
      return new Promise((res) => {
        let r;
        try { r = indexedDB.open('note-studio', 1); } catch (e) { res(false); return; }
        r.onupgradeneeded = () => { const d = r.result; ['notes', 'assets', 'kv'].forEach((s) => { if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' }); }); };
        r.onsuccess = () => { DB.db = r.result; DB.ok = true; res(true); };
        r.onerror = () => res(false);
        r.onblocked = () => res(false);
      });
    },
    run(store, mode, fn) {
      if (!DB.ok) {
        const m = mem[store];
        return Promise.resolve(fn({ get: (id) => ({ result: m.get(id) }), getAll: () => ({ result: Array.from(m.values()) }), put: (o) => { m.set(o.id, o); }, delete: (id) => { m.delete(id); }, clear: () => m.clear() }, true));
      }
      return new Promise((res, rej) => {
        const t = DB.db.transaction(store, mode); const s = t.objectStore(store); let out;
        const r = fn(s);
        if (r && 'onsuccess' in r) r.onsuccess = () => { out = r.result; };
        t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error);
      });
    },
    get(s, id) { return DB.run(s, 'readonly', (st, m) => m ? st.get(id).result : st.get(id)); },
    all(s) { return DB.run(s, 'readonly', (st, m) => m ? st.getAll().result : st.getAll()); },
    put(s, o) { return DB.run(s, 'readwrite', (st) => { st.put(o); }); },
    del(s, id) { return DB.run(s, 'readwrite', (st) => { st.delete(id); }); }
  };
  function saveFailed(e) { console.error(e); setStatus('Save failed: the browser storage may be full', 'warn'); }

  /* ================= router ================= */
  const PAGES = ['sim', 'lib', 'edit'];
  function route() {
    let p = (location.hash || '#sim').slice(1);
    if (PAGES.indexOf(p) < 0) p = 'sim';
    PAGES.forEach((k) => { $('pg-' + k).hidden = k !== p; });
    $$('.appnav a').forEach((a) => { if (a.dataset.page === p) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    $('sideOpen').hidden = !(p === 'sim' && document.body.classList.contains('side-off'));
    if (p === 'lib') renderLib();
    if (p === 'edit') requestAnimationFrame(edRender);
    window.scrollTo(0, 0);
  }
  const go = (p) => { if (location.hash === '#' + p) route(); else location.hash = p; };

  /* ================= publish simulator ================= */
  let N = null;            // current note
  let A = { id: 'account', name: '', avatar: '', bio: '', fans: '0', likes: '0' };
  let view = 'detail', slide = 0;
  const MAX_IMG = 18;
  const TABS = {
    video: { drop: 'Drag a video here or click to upload', btn: 'Upload video', specs: [['Video size', 'Up to 4 hours,<br>max 20GB per video'], ['Video format', 'Common video formats,<br>mp4 and mov recommended'], ['Video resolution', 'Videos over 1080P look sharper uploaded from the web']] },
    image: { drop: 'Drag photos here or click to upload', btn: 'Upload photos', specs: [] },
    article: { drop: 'The simulator does not support long articles yet', btn: 'Switch to image notes', specs: [] },
    podcast: { drop: 'The simulator does not support podcasts yet', btn: 'Switch to image notes', specs: [] }
  };
  const SUGG = ['Pilates', 'MarkhamPilates', 'Rehab', 'TorontoLife', 'Markham', 'PilatesForBeginners', 'PostureCorrection', 'ReformerPilates', 'TorontoPilates', 'MovementRehab', 'Anniversary', 'FitnessCheckIn'];
  const EMO = ['😊', '😂', '🥰', '😍', '🤩', '😎', '🥳', '😭', '👍', '👏', '🙌', '💪', '🙏', '✨', '🔥', '🎉', '🎁', '❤️', '💛', '💙', '🌟', '📍', '📅', '✅', '👉', '💬', '🏃‍♀️', '🧘‍♀️', '🍰', '🌿', '☀️', '🍂'];
  const COMPS = [
    ['Pick a group chat', 'down', '<path d="M3 4h10v6.5H8l-3 2.5v-2.5H3z"/>'],
    ['Quote a note', 'right', '<path d="M4 3h8v10H4zM6.5 6h3M6.5 9h3"/>'],
    ['Add a poll', 'right', '<path d="M3.5 13V8M8 13V3.5M12.5 13V6"/>'],
    ['Add a widget', 'down', '<path d="M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z"/>'],
    ['Link a live preview', 'right', '<rect x="2.5" y="4" width="11" height="8" rx="2"/><path d="M7 6.5v3l2.5-1.5z"/>'],
    ['Tag location or friends', 'right', '<circle cx="8" cy="6" r="2.5"/><path d="M3.5 13.5c.8-2.4 2.5-3.5 4.5-3.5s3.7 1.1 4.5 3.5"/>'],
    ['Add a route', 'right', '<path d="M4 13a1.5 1.5 0 1 0 0-.1M12 4.5a1.5 1.5 0 1 0 0-.1M4 11.5V9c0-1.5 1-2.5 2.5-2.5h3C11 6.5 12 5.5 12 4"/>'],
    ['Choose a file', 'right', '<path d="M4 2.5h5l3 3v8H4zM9 2.5v3h3"/>']
  ];
  const EVENTS = [
    { id: 'red11', name: 'RED11 Featured Creator Call', date: '11-04 to 11-25', bg: 'linear-gradient(135deg,#5B6B8C,#2F3B55)' },
    { id: 'malu', name: 'Street Life Festival', date: '10-23 to 11-30', bg: 'linear-gradient(135deg,#6E9A7A,#3D6250)' }
  ];
  const TAG_RE = /#([^\s#@，。！？、,.!?;；:：（）()【】]+)/g;
  function topicsOf(s) { const out = []; let m; TAG_RE.lastIndex = 0; while ((m = TAG_RE.exec(s || ''))) { if (out.indexOf(m[1]) < 0) out.push(m[1]); } return out; }
  const ico = {
    left: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2L4 7l5 5"/></svg>',
    right: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 2l5 5-5 5"/></svg>',
    x: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 2l8 8M10 2l-8 8"/></svg>',
    pen: '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2.5l2 2L5 11H3V9z"/></svg>',
    heart: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 13.5S2 10 2 6a3 3 0 0 1 6-1 3 3 0 0 1 6 1c0 4-6 7.5-6 7.5z"/></svg>',
    star: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z"/></svg>',
    chat: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M2.5 3h11v8h-6l-3 2.5V11h-2z"/></svg>',
    info: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="6" cy="6" r="5"/><path d="M6 5.3V9M6 3.2v.1" stroke-linecap="round"/></svg>',
    pin: '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M6 11s3.5-3.4 3.5-6A3.5 3.5 0 0 0 2.5 5c0 2.6 3.5 6 3.5 6z"/><circle cx="6" cy="5" r="1.2"/></svg>',
    lock: '<svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="2.5" y="5.5" width="7" height="5" rx="1"/><path d="M4 5.5V4a2 2 0 0 1 4 0v1.5"/></svg>',
    back: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M11 3.5L5.5 9l5.5 5.5"/></svg>',
    share: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.5l5 4.5-5 4.5V10c-4 0-6 1.5-7.5 4.5C3 10 5 7 10 6.5z"/></svg>',
    down: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4.5l3 3 3-3"/></svg>',
    chev: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 3l3 3-3 3"/></svg>',
    flag: '<svg width="22" height="22" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 18V4h10l-2 3.5L14 11H4"/></svg>',
    menu: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3 5h14M3 10h14M3 15h14"/></svg>',
    search: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="9" cy="9" r="5.5"/><path d="M13 13l4 4"/></svg>'
  };

  function blankNote() {
    const t = Date.now();
    return { id: uid(), tab: 'image', title: '', body: '', images: [], location: '', original: false, statement: '', visibility: 'public', schedOn: false, schedAt: '', allowCopy: true, events: {}, published: false, createdAt: t, updatedAt: t };
  }
  function normalizeNote(n) {
    const b = blankNote();
    Object.keys(b).forEach((k) => { if (n[k] == null) n[k] = b[k]; });
    if (n.topics && n.topics.length) {
      const miss = n.topics.filter((t) => n.body.indexOf('#' + t) < 0);
      if (miss.length) n.body = n.body.replace(/\s+$/, '') + '\n\n' + miss.map((t) => '#' + t).join(' ');
    }
    delete n.topics; delete n.allowCollab; delete n.account;
    return n;
  }

  let saveT = 0;
  function scheduleSave() {
    setStatus('Saving...');
    clearTimeout(saveT);
    saveT = setTimeout(saveNow, 500);
  }
  async function saveNow() {
    clearTimeout(saveT);
    try {
      N.updatedAt = Date.now();
      await DB.put('notes', N);
      await DB.put('kv', A);
      await DB.put('kv', { id: 'current', noteId: N.id });
      setStatus(DB.ok ? 'Auto-saved ' + pad(new Date().getHours()) + ':' + pad(new Date().getMinutes()) : 'This browser can’t store long-term. Export a backup before closing the page', DB.ok ? 'ok' : 'warn');
      updateDraftCount();
    } catch (e) { saveFailed(e); }
  }
  async function updateDraftCount() {
    const all = await DB.all('notes');
    $('draftsBtn').lastChild.textContent = 'Drafts (' + all.length + ')';
  }

  function renderScreen() {
    $$('.tab').forEach((t) => t.setAttribute('aria-selected', t.dataset.tab === N.tab));
    const showEdit = N.tab === 'image';
    document.body.classList.toggle('editing', showEdit);
    $('editView').hidden = !showEdit; $('uploadView').hidden = showEdit;
    if (!showEdit) {
      const t = TABS[N.tab];
      $('dropText').textContent = t.drop; $('upBtn').textContent = t.btn;
      $('specs').innerHTML = t.specs.map((s) => '<div class="spec"><b>' + s[0] + '</b><span>' + s[1] + '</span></div>').join('');
      $('specs').hidden = !t.specs.length;
    }
  }
  function fillForm() {
    $('title').value = N.title; $('body').value = N.body; $('location').value = N.location;
    $('original').checked = !!N.original; $('statement').value = N.statement;
    $('visibility').value = N.visibility; $('schedOn').checked = !!N.schedOn; $('schedAt').value = N.schedAt;
    $('schedAt').hidden = !N.schedOn; $('allowCopy').checked = !!N.allowCopy;
    delete $('body').dataset.touched;
  }
  function fillAccount() { $('accName').value = A.name; $('accBio').value = A.bio; $('accFans').value = A.fans; $('accLikes').value = A.likes; }
  function renderAccount() {
    const bg = A.avatar ? 'url(' + A.avatar + ')' : '';
    $('topAv').style.backgroundImage = bg; $('accAv').style.backgroundImage = bg;
    $('topName').textContent = A.name || 'Account name';
  }
  function renderSide() {
    $('origTxt').textContent = N.original ? 'Marked original' : 'Claim original';
    $('locBox').classList.toggle('has', !!N.location.trim());
  }
  function counts() {
    const t = chars(N.title), b = chars(N.body), n = topicsOf(N.body).length;
    $('titleCount').textContent = t + '/20'; $('titleCount').className = 'cnt' + (t > 20 ? ' over' : '');
    $('bodyCount').textContent = b + '/1000'; $('bodyCount').className = 'cnt' + (b > 1000 ? ' over' : '');
    $('topicCount').textContent = n ? n + '/10 Topic' : ''; $('topicCount').className = 'cnt' + (n > 10 ? ' over' : '');
  }
  function renderSugg() {
    const used = topicsOf(N.body), box = $('sugg'); box.innerHTML = '';
    SUGG.slice(0, 8).forEach((t) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'tchip' + (used.indexOf(t) >= 0 ? ' used' : '');
      b.textContent = '#' + t; b.onclick = () => addTag(t); box.appendChild(b);
    });
    const m = document.createElement('button'); m.type = 'button'; m.className = 'fold'; m.innerHTML = 'More ' + ico.down;
    m.onclick = (e) => { e.stopPropagation(); openTagPop(); }; box.appendChild(m);
  }
  function renderImgs() {
    const box = $('imgs'); box.innerHTML = '';
    if (N.images.length < MAX_IMG) {
      const a = document.createElement('button'); a.type = 'button'; a.className = 'add'; a.setAttribute('aria-label', 'Add photo');
      a.innerHTML = '<svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M14 6v16M6 14h16"/></svg>' + (N.images.length ? '' : '<span style="font-size:12px">Add photo</span>');
      a.onclick = (e) => { e.stopPropagation(); openAddMenu(a); };
      box.appendChild(a);
    }
    N.images.forEach((src, i) => {
      const t = document.createElement('div'); t.className = 'tile';
      t.innerHTML = '<img alt="Photo ' + (i + 1) + '  photo" src="' + src + '">' + (i === 0 ? '<span class="cov">Cover</span>' : '') +
        '<div class="ctl"><button type="button" aria-label="Move left" title="Move left">' + ico.left + '</button><button type="button" aria-label="Edit image" title="Edit image">' + ico.pen + '</button><button type="button" aria-label="Delete" title="Delete">' + ico.x + '</button><button type="button" aria-label="Move right" title="Move right">' + ico.right + '</button></div>';
      const b = t.querySelectorAll('button');
      b[0].onclick = () => move(i, -1);
      b[1].onclick = () => edOpen({ src, name: 'Note photo ' + (i + 1), origin: { type: 'note', noteId: N.id, index: i } });
      b[2].onclick = () => { N.images.splice(i, 1); slide = Math.min(slide, Math.max(0, N.images.length - 1)); changed(true); };
      b[3].onclick = () => move(i, 1);
      box.appendChild(t);
    });
    $('imgCount').textContent = N.images.length + '/' + MAX_IMG;
  }
  function move(i, d) { const j = i + d; if (j < 0 || j >= N.images.length) return; const t = N.images[i]; N.images[i] = N.images[j]; N.images[j] = t; changed(true); }
  function renderComps() {
    const box = $('comps'); $$('[data-comp]', box).forEach((n) => n.remove());
    COMPS.forEach((c) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'box comp'; b.dataset.comp = '1';
      b.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' + c[2] + '</svg><span class="grow">' + c[0] + '</span>' + (c[1] === 'down' ? ico.down : ico.chev);
      b.onclick = () => toast('The simulator does not support 「' + c[0] + '」，, it only shows the slot');
      box.appendChild(b);
    });
  }
  function renderEvents() {
    const box = $('evs'); box.innerHTML = '';
    EVENTS.forEach((ev) => {
      const on = !!N.events[ev.id], d = document.createElement('div'); d.className = 'ev';
      d.innerHTML = '<span class="th" style="background:' + ev.bg + '">' + ico.flag + '</span><span class="grow"><b>' + esc(ev.name) + '</b><small>' + esc(ev.date) + '</small></span>' +
        '<button type="button" class="evbtn" aria-pressed="' + on + '">' + (on ? 'Linked' : 'Link') + '</button>';
      d.querySelector('button').onclick = () => { N.events[ev.id] = !N.events[ev.id]; renderEvents(); changed(); };
      box.appendChild(d);
    });
  }
  function changed(full) { if (full) { renderImgs(); renderScreen(); } counts(); renderSugg(); renderAccount(); renderSide(); renderPreview(); scheduleSave(); }
  function loadNoteIntoUI() { slide = 0; view = 'detail'; fillForm(); renderImgs(); renderEvents(); counts(); renderSugg(); renderSide(); renderScreen(); renderPreview(); }

  function insertText(str) {
    const ta = $('body');
    let p = ta.selectionStart == null ? ta.value.length : ta.selectionStart, q = ta.selectionEnd == null ? p : ta.selectionEnd;
    if (document.activeElement !== ta && !ta.dataset.touched) { p = q = ta.value.length; }
    ta.value = ta.value.slice(0, p) + str + ta.value.slice(q); N.body = ta.value;
    ta.focus(); ta.setSelectionRange(p + str.length, p + str.length); ta.dataset.touched = '1'; changed();
  }
  function addTag(t) {
    if (topicsOf(N.body).indexOf(t) >= 0) { toast('Your text already has #' + t); return; }
    if (topicsOf(N.body).length >= 10) { toast('Up to 10 topics'); return; }
    const ta = $('body'), p = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
    const before = ta.dataset.touched ? ta.value.slice(0, p) : ta.value;
    insertText((before && !/\s$/.test(before) ? ' ' : '') + '#' + t + ' ');
  }
  function closePops() { $('emoPop').hidden = true; $('tagPop').hidden = true; }
  function openTagPop() {
    const pop = $('tagPop'), used = topicsOf(N.body);
    pop.innerHTML = '<input class="inp" id="tagNew" type="text" placeholder="Type a topic and press Enter" style="margin-bottom:6px">' +
      SUGG.filter((t) => used.indexOf(t) < 0).map((t) => '<button type="button" data-t="' + esc(t) + '">#' + esc(t) + '</button>').join('');
    $$('[data-t]', pop).forEach((b) => { b.onclick = () => { addTag(b.dataset.t); closePops(); }; });
    const inp = pop.querySelector('#tagNew');
    inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); const v = inp.value.replace(/^#+/, '').trim(); if (v) { addTag(v); closePops(); } } if (e.key === 'Escape') closePops(); };
    $('emoPop').hidden = true; pop.hidden = false; inp.focus();
  }
  async function addImageFiles(list) {
    const files = Array.from(list || []).filter((f) => /^image\//.test(f.type)).slice(0, MAX_IMG - N.images.length);
    if (!files.length) { toast('Please choose image files'); return; }
    setStatus('Processing photos...');
    for (const f of files) { try { N.images.push(await shrink(f, 1080, 1440)); } catch (e) { toast('One photo could not be read and was skipped'); } }
    N.tab = 'image'; changed(true);
  }
  function openAddMenu(anchor) {
    const m = $('addMenu'), r = anchor.getBoundingClientRect();
    m.style.left = Math.min(r.left, innerWidth - 180) + 'px'; m.style.top = (r.bottom + 6) + 'px';
    m.hidden = false;
  }

  /* Drafts */
  async function openDrafts() {
    const all = (await DB.all('notes')).sort((a, b) => b.updatedAt - a.updatedAt);
    const box = $('draftList'); box.innerHTML = '';
    if (!all.length) box.innerHTML = '<p class="hint">No notes yet.</p>';
    all.forEach((n) => {
      const d = document.createElement('div'); d.className = 'drow' + (n.id === N.id ? ' cur' : '');
      d.innerHTML = '<span class="th"' + (n.images[0] ? ' style="background-image:url(' + n.images[0] + ')"' : '') + '></span>' +
        '<span class="grow"><b>' + esc(n.title || 'Untitled note') + (n.published ? '<span class="stag">Simulated publish</span>' : '') + (n.id === N.id ? '<span class="stag">editing</span>' : '') + '</b>' +
        '<small>' + n.images.length + '  photos · edited ' + fmtTime(n.updatedAt) + '</small></span>' +
        '<button type="button" class="btn sm">Open</button><button type="button" class="pill danger">Delete</button>';
      const [openB, delB] = d.querySelectorAll('button');
      openB.onclick = async () => { await saveNow(); N = normalizeNote(n); await DB.put('kv', { id: 'current', noteId: N.id }); loadNoteIntoUI(); closeModal('draftModal'); toast('Opened'); };
      delB.onclick = () => twice(delB, 'Tap again to delete this note', async () => {
        await DB.del('notes', n.id);
        if (n.id === N.id) {
          const rest = (await DB.all('notes')).sort((a, b) => b.updatedAt - a.updatedAt);
          N = rest[0] ? normalizeNote(rest[0]) : blankNote();
          loadNoteIntoUI(); await saveNow();
        }
        updateDraftCount(); openDrafts();
      });
      box.appendChild(d);
    });
    openModal('draftModal');
  }

  /* phone preview */
  const avStyle = () => A.avatar ? ' style="background-image:url(' + A.avatar + ')"' : '';
  const richText = (s) => esc(s).replace(/(^|[^\w&])([#@][^\s#@，。！？、,.!?;；:：（）()【】<]+)/g, (m, a, b) => a + '<span class="lk">' + b + '</span>');
  function whenText() {
    if (N.schedOn && N.schedAt) { const d = new Date(N.schedAt); if (!isNaN(d)) return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
    return 'just now';
  }
  function metaLine() {
    const bits = ['<span>Edited ' + whenText() + '</span>'];
    if (N.location.trim()) bits.push('<span>' + ico.pin + esc(N.location.trim()) + '</span>');
    if (N.visibility === 'private') bits.push('<span>' + ico.lock + 'Private</span>');
    return bits.join('');
  }
  const bottomNav = (cur) => '<div class="hbot"><span class="' + (cur === 'home' ? 'on' : '') + '">Home</span><span>Shop</span><span class="plus">+</span><span>Inbox</span><span class="' + (cur === 'me' ? 'on' : '') + '">Me</span></div>';
  function noteCard(withLock) {
    const cover = N.images[0] ? '<img alt="Cover" src="' + N.images[0] + '">' : 'Cover appears after you add photos';
    const lock = withLock && N.visibility === 'private' ? '<span class="lockb">' + ico.lock + 'Private</span>' : '';
    return '<div class="fcard"><div class="fimg">' + cover + lock + '</div><div class="ft">' + esc(N.title || 'Title') + '</div>' +
      '<div class="fu"><span class="av"' + avStyle() + '></span><span class="nm">' + esc(A.name || 'Account name') + '</span>' + ico.heart + '<span>Like</span></div></div>';
  }
  function renderPreview() {
    $$('.seg [data-view]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.view === view));
    const sc = $('screen'), name = esc(A.name || 'Account name');
    if (view === 'home') {
      const first = N.visibility === 'private'
        ? '<div class="privnote">This note is private and won’t show in anyone else’s feed</div>'
        : '<div class="fcol">' + noteCard(false) + '<div class="skel b"></div></div><div class="fcol"><div class="skel a"></div><div class="skel b"></div></div>';
      sc.innerHTML = '<div class="hwrap"><div class="htop">' + ico.menu + '<div class="htabs"><span>Follow</span><span class="on">Discover</span><span>Local</span></div>' + ico.search + '</div>' +
        '<div class="hchan"><span class="on">For You</span><span>Fitness</span><span>Food</span><span>Fashion</span><span>Travel</span><span>Health</span></div>' +
        '<div class="feed">' + first + '</div>' + bottomNav('home') + '</div>';
      const fc = sc.querySelector('.fcard'); if (fc) fc.onclick = () => { view = 'detail'; renderPreview(); };
      return;
    }
    if (view === 'profile') {
      sc.innerHTML = '<div class="pwrap"><div class="dscroll"><div class="phead"><div class="who"><span class="av"' + avStyle() + '></span><b>' + name + '</b></div>' +
        (A.bio ? '<div class="pbio">' + esc(A.bio) + '</div>' : '') +
        '<div class="pstats"><span><b>' + esc(A.fans || '0') + '</b>Followers</span><span><b>' + esc(A.likes || '0') + '</b>Likes & saves</span><span class="pedit">Edit profile</span></div></div>' +
        '<div class="ptabs"><span class="on">Notes</span><span>Save</span><span>Liked</span></div>' +
        '<div class="feed"><div class="fcol">' + noteCard(true) + '<div class="skel b"></div></div><div class="fcol"><div class="skel a"></div></div></div></div>' +
        bottomNav('me') + '</div>';
      sc.querySelector('.fcard').onclick = () => { view = 'detail'; renderPreview(); };
      return;
    }
    const n = N.images.length; slide = Math.min(slide, Math.max(0, n - 1));
    const media = n ? '<img alt="Photo ' + (slide + 1) + ' " src="' + N.images[slide] + '">' +
      (n > 1 ? '<button type="button" class="mnav prev" aria-label="Previous">' + ico.left + '</button><button type="button" class="mnav next" aria-label="Next">' + ico.right + '</button><span class="num">' + (slide + 1) + '/' + n + '</span>' : '')
      : 'Appears after you add photos';
    let dots = ''; for (let i = 0; i < n && n > 1; i++) dots += '<i class="' + (i === slide ? 'on' : '') + '"></i>';
    sc.innerHTML = '<div class="det"><div class="dhead">' + ico.back + '<span class="av big"' + avStyle() + '></span><span class="nm">' + name + '</span><span class="follow">Follow</span>' + ico.share + '</div>' +
      '<div class="dscroll"><div class="media">' + media + '</div>' + (dots ? '<div class="dots">' + dots + '</div>' : '') +
      '<div class="dbody">' + (N.title ? '<h3>' + esc(N.title) + '</h3>' : '') + '<div class="dtext">' + richText(N.body) + '</div>' +
      '<div class="dmeta">' + metaLine() + '</div>' +
      (N.statement ? '<div class="dai">' + ico.info + esc(N.statement) + '</div>' : '') +
      '</div><div class="dcm"><span class="c">0 comments</span><div class="me"><span class="av big"' + avStyle() + '></span><span>Say something nice to the author</span></div><div class="empty">Nothing here yet. Tap to comment</div></div></div>' +
      '<div class="dbar"><span class="say">Say something...</span><span>' + ico.heart + 'Like</span><span>' + ico.star + 'Save</span><span>' + ico.chat + 'Comment</span></div></div>';
    const p = sc.querySelector('.prev'), q = sc.querySelector('.next');
    if (p) p.onclick = () => { slide = (slide - 1 + n) % n; renderPreview(); };
    if (q) q.onclick = () => { slide = (slide + 1) % n; renderPreview(); };
  }

  function bindSim() {
    $$('.tab').forEach((t) => { t.onclick = () => { N.tab = t.dataset.tab; renderScreen(); scheduleSave(); }; });
    $$('[data-off]').forEach((b) => { b.onclick = () => toast('The simulator only opens the publish-note screen'); });
    $$('[data-toast]').forEach((b) => { b.onclick = () => toast(b.dataset.toast); });
    $$('[data-fold]').forEach((b) => {
      b.onclick = () => { const c = $(b.dataset.fold), closed = c.classList.toggle('closed'); b.setAttribute('aria-expanded', !closed); b.querySelector('span').textContent = closed ? 'Expand' : 'Collapse'; };
    });
    $('draftsBtn').onclick = openDrafts;
    $('newNoteBtn').onclick = async () => { await saveNow(); N = blankNote(); loadNoteIntoUI(); await saveNow(); closeModal('draftModal'); toast('Created a new note'); };
    $('sideClose').onclick = () => { document.body.classList.add('side-off'); $('sideOpen').hidden = false; };
    $('sideOpen').onclick = () => { document.body.classList.remove('side-off'); $('sideOpen').hidden = true; };
    $('upBtn').onclick = () => {
      if (N.tab === 'image') $('imgInput').click();
      else if (N.tab === 'video') toast('The simulator only supports image notes. Videos can’t be uploaded');
      else { N.tab = 'image'; renderScreen(); scheduleSave(); }
    };
    const sec = $('imgSec');
    sec.ondragover = (e) => { e.preventDefault(); sec.classList.add('over'); };
    sec.ondragleave = () => sec.classList.remove('over');
    sec.ondrop = (e) => { e.preventDefault(); sec.classList.remove('over'); addImageFiles(e.dataTransfer.files); };
    const drop = $('drop');
    drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); if (N.tab !== 'image') { toast('Switch to image notes, then drag photos in'); return; } addImageFiles(e.dataTransfer.files); };
    $('imgInput').onchange = function () { const f = this.files; addImageFiles(f).then(() => { this.value = ''; }); };
    $('addFromPc').onclick = () => { $('addMenu').hidden = true; $('imgInput').click(); };
    $('addFromLib').onclick = () => { $('addMenu').hidden = true; openPicker(true, async (ids) => {
      for (const id of ids.slice(0, MAX_IMG - N.images.length)) { const a = await DB.get('assets', id); if (a && a.blob) N.images.push(await shrink(a.blob, 1080, 1440)); }
      changed(true); toast('Added to the note');
    }); };
    $('clearImgs').onclick = function () { if (!N.images.length) return; twice(this, 'Tap again to clear all photos', () => { N.images = []; slide = 0; changed(true); }); };
    $('coverTip').onclick = () => toast('The first photo is the cover. Drag to reorder.');
    $('smartTitle').onclick = () => toast('The simulator has no smart-title feature');
    $('title').oninput = function () { N.title = this.value; changed(); };
    const ta = $('body');
    ta.oninput = function () { N.body = this.value; changed(); };
    ta.onfocus = () => { ta.dataset.touched = '1'; };
    $('tagBtn').onclick = (e) => { e.stopPropagation(); if ($('tagPop').hidden) openTagPop(); else closePops(); };
    $('atBtn').onclick = () => insertText('@');
    $('emoBtn').onclick = (e) => {
      e.stopPropagation(); const pop = $('emoPop');
      if (!pop.innerHTML) { pop.innerHTML = EMO.map((x) => '<button type="button" aria-label="' + x + '">' + x + '</button>').join(''); $$('button', pop).forEach((b) => { b.onclick = () => insertText(b.textContent); }); }
      $('tagPop').hidden = true; pop.hidden = !pop.hidden;
    };
    $('location').oninput = function () { N.location = this.value; changed(); };
    $('original').onchange = function () { N.original = this.checked; changed(); };
    $('statement').onchange = function () { N.statement = this.value; changed(); };
    $('visibility').onchange = function () { N.visibility = this.value; changed(); };
    $('schedOn').onchange = function () { N.schedOn = this.checked; $('schedAt').hidden = !this.checked; changed(); };
    $('schedAt').onchange = function () { N.schedAt = this.value; changed(); };
    $('allowCopy').onchange = function () { N.allowCopy = this.checked; changed(); };
    $$('[data-view]').forEach((b) => { b.onclick = () => { view = b.dataset.view; renderPreview(); }; });
    $('pubBtn').onclick = async () => {
      const w = [];
      if (chars(N.title) > 20) w.push('Title over 20 characters');
      if (chars(N.body) > 1000) w.push('Body over 1000 characters');
      if (!N.images.length) w.push('No photos uploaded yet');
      if (topicsOf(N.body).length > 10) w.push('More than 10 topics');
      $('mWarn').textContent = w.length ? 'Note: ' + w.join('，') + '。' : '';
      N.published = true; N.publishedAt = Date.now(); await saveNow();
      view = 'detail'; slide = 0; renderPreview();
      openModal('pubModal'); $('mClose').focus();
    };
    $('mClose').onclick = () => closeModal('pubModal');
    $('saveBtn').onclick = async () => { await saveNow(); toast('Saved to drafts'); };
  }

  /* account + backup popover */
  function bindTop() {
    const pops = [['acctBtn', 'acctPop'], ['backupBtn', 'backupPop']];
    pops.forEach(([b, p]) => {
      $(b).onclick = (e) => {
        e.stopPropagation();
        pops.forEach(([b2, p2]) => { if (p2 !== p) { $(p2).hidden = true; $(b2).setAttribute('aria-expanded', 'false'); } });
        $(p).hidden = !$(p).hidden; $(b).setAttribute('aria-expanded', !$(p).hidden);
        if (p === 'backupPop' && !$(p).hidden) showStorage();
      };
      $(p).onclick = (e) => e.stopPropagation();
    });
    document.addEventListener('click', (e) => {
      pops.forEach(([b, p]) => { $(p).hidden = true; $(b).setAttribute('aria-expanded', 'false'); });
      $('addMenu').hidden = true;
      if (!e.target.closest || !e.target.closest('.tools')) closePops();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      closePops(); $('addMenu').hidden = true;
      pops.forEach(([, p]) => { $(p).hidden = true; });
      ['draftModal', 'pickModal', 'itemModal', 'pubModal'].forEach((m) => { if (!$(m).hidden) closeModal(m); });
    });
    $$('[data-close]').forEach((b) => { b.onclick = () => { b.closest('.modal').hidden = true; }; });
    $$('.modal').forEach((m) => { m.addEventListener('click', (e) => { if (e.target === m) m.hidden = true; }); });
    const acc = (k) => function () { A[k] = this.value; renderAccount(); renderPreview(); scheduleSave(); };
    $('accName').oninput = acc('name'); $('accBio').oninput = acc('bio'); $('accFans').oninput = acc('fans'); $('accLikes').oninput = acc('likes');
    $('avatarBtn').onclick = () => $('avatarInput').click();
    $('avatarInput').onchange = async function () {
      const f = this.files && this.files[0]; this.value = ''; if (!f) return;
      A.avatar = await shrink(f, 200, 200); renderAccount(); renderPreview(); scheduleSave();
    };
    $('exportBtn').onclick = exportAll;
    $('importBtn').onclick = () => $('importInput').click();
    $('importInput').onchange = function () { const f = this.files && this.files[0]; this.value = ''; if (f) importAll(f); };
  }
  async function showStorage() {
    const el = $('storageInfo');
    if (!DB.ok) { el.textContent = 'This browser (possibly private mode) can’t store long-term. Export before closing the page.'; return; }
    try {
      const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
      el.textContent = est ? 'Used ' + fmtSize(est.usage) + '，, about ' + fmtSize(est.quota) : '';
    } catch (e) { el.textContent = ''; }
  }
  async function exportAll() {
    setStatus('Exporting...');
    const notes = await DB.all('notes'), kv = await DB.all('kv'), assets = await DB.all('assets');
    const out = [];
    for (const a of assets) { const c = Object.assign({}, a); if (a.blob) { c.blob = undefined; c.dataUrl = await blobToDataURL(a.blob); } out.push(c); }
    const data = { app: 'note-studio', version: 1, exportedAt: Date.now(), notes, kv, assets: out };
    const d = new Date();
    download(new Blob([JSON.stringify(data)], { type: 'application/json' }), 'note-studio-backup-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.json');
    setStatus('Backup exported', 'ok');
  }
  async function importAll(file) {
    try {
      const data = JSON.parse(await file.text());
      if (data.app !== 'note-studio') throw new Error('not a backup');
      for (const n of data.notes || []) await DB.put('notes', normalizeNote(n));
      for (const a of data.assets || []) { if (a.dataUrl) { a.blob = await dataURLToBlob(a.dataUrl); delete a.dataUrl; } await DB.put('assets', a); }
      for (const k of data.kv || []) await DB.put('kv', k);
      await boot(true);
      toast('Import complete');
    } catch (e) { console.error(e); toast('This file is not a Note Studio backup'); }
  }

  /* ================= library ================= */
  let libFilter = 'all', libQuery = '', libURLs = [], curItem = null;
  const extOf = (name) => { const m = /\.([a-z0-9]{1,5})$/i.exec(name || ''); return m ? m[1].toUpperCase() : 'FILE'; };
  const KIND = { image: 'Images', file: 'Files', text: 'Text', link: 'Links' };
  async function renderLib() {
    libURLs.forEach((u) => URL.revokeObjectURL(u)); libURLs = [];
    let all = (await DB.all('assets')).sort((a, b) => b.updatedAt - a.updatedAt);
    const total = all.length;
    if (libFilter !== 'all') all = all.filter((a) => a.kind === libFilter);
    if (libQuery) { const q = libQuery.toLowerCase(); all = all.filter((a) => [a.name, a.note, a.text, a.url].join(' ').toLowerCase().indexOf(q) >= 0); }
    const g = $('libGrid'); g.innerHTML = '';
    $('libEmpty').hidden = total > 0;
    if (total && !all.length) g.innerHTML = '<p class="hint">No matching assets.</p>';
    all.forEach((a) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'lcard';
      let th;
      if (a.kind === 'image' && a.blob) { const u = URL.createObjectURL(a.blob); libURLs.push(u); th = '<img alt="" loading="lazy" src="' + u + '">'; }
      else if (a.kind === 'text') th = '<span class="snip">' + esc((a.text || '').slice(0, 220) || '（empty)') + '</span>';
      else if (a.kind === 'link') th = '<span class="ext">LINK</span>';
      else th = '<span class="ext">' + esc(extOf(a.name)) + '</span>';
      const sub = a.kind === 'link' ? (a.url || 'No link yet') : a.note || (fmtTime(a.updatedAt) + (a.size ? ' · ' + fmtSize(a.size) : ''));
      b.innerHTML = '<span class="lthumb">' + th + '<span class="kind">' + KIND[a.kind] + '</span></span><span class="lmeta"><b>' + esc(a.name || 'Untitled') + '</b><small>' + esc(sub) + '</small></span>';
      b.onclick = () => openItem(a.id);
      g.appendChild(b);
    });
  }
  async function addLibFiles(list) {
    const files = Array.from(list || []);
    const vids = files.filter((f) => /^video\//.test(f.type));
    const ok = files.filter((f) => !/^video\//.test(f.type));
    if (vids.length) toast('Videos not supported, skipped ' + vids.length + ' ');
    if (!ok.length) return [];
    setStatus('Uploading...');
    const ids = [];
    for (const f of ok) {
      const t = Date.now();
      const a = { id: uid(), kind: /^image\//.test(f.type) ? 'image' : 'file', name: f.name, mime: f.type || 'application/octet-stream', size: f.size, blob: f.slice(0, f.size, f.type), note: '', createdAt: t, updatedAt: t };
      try { await DB.put('assets', a); ids.push(a.id); } catch (e) { saveFailed(e); return ids; }
    }
    setStatus('Uploaded ' + ids.length + ' ', 'ok');
    renderLib();
    return ids;
  }
  async function openItem(id) {
    const a = await DB.get('assets', id); if (!a) return;
    curItem = a;
    $('iT').textContent = KIND[a.kind];
    $('iMeta').textContent = 'edited ' + fmtTime(a.updatedAt) + (a.size ? ' · ' + fmtSize(a.size) : '');
    $('iName').value = a.name || ''; $('iNote').value = a.note || '';
    $('iUrlF').hidden = a.kind !== 'link'; $('iUrl').value = a.url || ''; $('iOpen').href = a.url || '#';
    $('iTextF').hidden = a.kind !== 'text'; $('iText').value = a.text || '';
    $('iEdit').hidden = a.kind !== 'image'; $('iToNote').hidden = a.kind !== 'image';
    $('iCopy').hidden = a.kind !== 'text'; $('iDown').hidden = !a.blob;
    const pv = $('iPreview'); pv.innerHTML = ''; pv.hidden = a.kind === 'text' || a.kind === 'link';
    if (a.blob) {
      const u = URL.createObjectURL(a.blob); libURLs.push(u);
      if (a.kind === 'image') pv.innerHTML = '<img alt="" src="' + u + '">';
      else if (/pdf/.test(a.mime)) pv.innerHTML = '<iframe title="PDF Preview" src="' + u + '"></iframe>';
      else pv.innerHTML = '<span class="ext">' + esc(extOf(a.name)) + '</span>';
    }
    openModal('itemModal');
    if (a.kind === 'text') $('iText').focus();
  }
  function bindLib() {
    $('libUpload').onclick = () => $('libInput').click();
    $('libInput').onchange = function () { const f = this.files; addLibFiles(f).then(() => { this.value = ''; }); };
    $('libText').onclick = async () => { const t = Date.now(); const a = { id: uid(), kind: 'text', name: 'New text ' + fmtTime(t), text: '', note: '', createdAt: t, updatedAt: t }; await DB.put('assets', a); renderLib(); openItem(a.id); };
    $('libLink').onclick = async () => { const t = Date.now(); const a = { id: uid(), kind: 'link', name: 'New link', url: '', note: '', createdAt: t, updatedAt: t }; await DB.put('assets', a); renderLib(); openItem(a.id); setTimeout(() => $('iUrl').focus(), 50); };
    $$('#libFilter button').forEach((b) => { b.onclick = () => { libFilter = b.dataset.f; $$('#libFilter button').forEach((x) => x.setAttribute('aria-pressed', x === b)); renderLib(); }; });
    $('libSearch').oninput = function () { libQuery = this.value.trim(); renderLib(); };
    const w = $('libDrop');
    w.ondragover = (e) => { e.preventDefault(); w.classList.add('over'); };
    w.ondragleave = (e) => { if (!w.contains(e.relatedTarget)) w.classList.remove('over'); };
    w.ondrop = (e) => { e.preventDefault(); w.classList.remove('over'); addLibFiles(e.dataTransfer.files); };
    $('iUrl').oninput = function () { $('iOpen').href = this.value || '#'; };
    $('iSave').onclick = async () => {
      const a = curItem; if (!a) return;
      a.name = $('iName').value.trim(); a.note = $('iNote').value;
      if (a.kind === 'text') a.text = $('iText').value;
      if (a.kind === 'link') { let u = $('iUrl').value.trim(); if (u && !/^[a-z]+:/i.test(u)) u = 'https://' + u; a.url = u; if (!a.name || a.name === 'New link') { try { a.name = new URL(u).hostname; } catch (e) { } } }
      a.updatedAt = Date.now();
      try { await DB.put('assets', a); closeModal('itemModal'); renderLib(); toast('Saved'); } catch (e) { saveFailed(e); }
    };
    $('iDel').onclick = function () { twice(this, 'Tap again to delete', async () => { await DB.del('assets', curItem.id); closeModal('itemModal'); renderLib(); toast('Deleted'); }); };
    $('iDown').onclick = () => { if (curItem && curItem.blob) download(curItem.blob, curItem.name || ('asset.' + (curItem.mime.split('/')[1] || 'bin'))); };
    $('iCopy').onclick = async () => { try { await navigator.clipboard.writeText($('iText').value); toast('Copied'); } catch (e) { $('iText').select(); toast('Press Ctrl+C  or ⌘C copy'); } };
    $('iEdit').onclick = () => { const a = curItem; closeModal('itemModal'); edOpen({ blob: a.blob, name: a.name, origin: { type: 'asset', id: a.id } }); };
    $('iToNote').onclick = async () => {
      if (N.images.length >= MAX_IMG) { toast('A note can have at most 18 photos'); return; }
      N.images.push(await shrink(curItem.blob, 1080, 1440)); changed(true); closeModal('itemModal'); toast('Added to the current note');
    };
  }
  /* image picker */
  let pickCb = null, pickSel = [], pickMulti = true;
  async function openPicker(multi, cb) {
    pickCb = cb; pickSel = []; pickMulti = multi;
    const imgs = (await DB.all('assets')).filter((a) => a.kind === 'image' && a.blob).sort((a, b) => b.updatedAt - a.updatedAt);
    const g = $('pickGrid'); g.innerHTML = '';
    if (!imgs.length) g.innerHTML = '<p class="hint">No images in the library yet. Upload some in the Library first.</p>';
    imgs.forEach((a) => {
      const u = URL.createObjectURL(a.blob); libURLs.push(u);
      const b = document.createElement('button'); b.type = 'button'; b.className = 'pitem'; b.setAttribute('aria-pressed', 'false'); b.title = a.name || '';
      b.innerHTML = '<img alt="" src="' + u + '"><span class="ck"></span>';
      b.onclick = () => {
        const i = pickSel.indexOf(a.id);
        if (!pickMulti) { pickSel = [a.id]; } else if (i >= 0) pickSel.splice(i, 1); else pickSel.push(a.id);
        $$('.pitem', g).forEach((x) => { const k = pickSel.indexOf(x.dataset.id); x.setAttribute('aria-pressed', k >= 0); x.querySelector('.ck').textContent = k >= 0 && pickMulti ? k + 1 : ''; });
        $('pickOk').disabled = !pickSel.length; $('pickInfo').textContent = pickSel.length ? 'Selected ' + pickSel.length + ' ' : '';
      };
      b.dataset.id = a.id; g.appendChild(b);
    });
    $('pickOk').disabled = true; $('pickInfo').textContent = '';
    $('pT').textContent = multi ? 'Choose images from library (multi-select)' : 'Choose one image from library';
    openModal('pickModal');
  }

  /* ================= Image editor ================= */
  const E = { img: null, url: '', name: '', origin: null, rot: 0, flip: false, crop: null, ratio: 0, adj: { b: 0, c: 0, s: 0, t: 0 }, texts: [], sel: -1, mode: 'view', rc: null, k: 1, boxes: [], drag: null };
  const cv = () => $('edCanvas');
  async function edOpen(o) {
    try {
      if (E.url) URL.revokeObjectURL(E.url);
      E.url = o.blob ? URL.createObjectURL(o.blob) : '';
      E.img = await loadImage(E.url || o.src);
    } catch (e) { toast('This image can’t be opened'); return; }
    E.name = o.name || 'Images'; E.origin = o.origin || null;
    E.rot = 0; E.flip = false; E.ratio = 0; E.adj = { b: 0, c: 0, s: 0, t: 0 }; E.texts = []; E.sel = -1; E.mode = 'view';
    buildRot(); E.crop = { x: 0, y: 0, w: E.rc.width, h: E.rc.height };
    syncEdPanel();
    go('edit');
    requestAnimationFrame(edRender);
  }
  function buildRot() {
    const im = E.img, w = im.naturalWidth, h = im.naturalHeight, side = E.rot % 180 !== 0;
    const c = document.createElement('canvas'); c.width = side ? h : w; c.height = side ? w : h;
    const x = c.getContext('2d');
    x.translate(c.width / 2, c.height / 2); x.rotate(E.rot * Math.PI / 180); if (E.flip) x.scale(-1, 1);
    x.drawImage(im, -w / 2, -h / 2);
    E.rc = c;
  }
  function fitRatioCrop() {
    const W = E.rc.width, H = E.rc.height;
    if (!E.ratio) return;
    const c = E.crop || { x: 0, y: 0, w: W, h: H };
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
    let w = W, h = w / E.ratio; if (h > H) { h = H; w = h * E.ratio; }
    let x = Math.min(Math.max(cx - w / 2, 0), W - w), y = Math.min(Math.max(cy - h / 2, 0), H - h);
    E.crop = { x, y, w, h };
  }
  function syncEdPanel() {
    const has = !!E.img;
    $('edPanel').classList.toggle('off', !has);
    $('edEmpty').hidden = has; cv().hidden = !has;
    $('edResetAll').hidden = !has;
    $('edName').textContent = has ? E.name : 'image editor';
    $('edSize').textContent = has && E.crop ? Math.round(E.crop.w) + '×' + Math.round(E.crop.h) : '';
    const o = E.origin;
    $('edOrigin').textContent = !has ? '' : o && o.type === 'note' ? 'From a note. Click 「Save」 to replace this photo in the note.' : o && o.type === 'asset' ? 'From the library. Click 「Save」 to overwrite this image in the library.' : 'Opened from your computer. Click 「Save」 to save it to the library.';
    $('edSave').textContent = o && o.type === 'note' ? 'Save to note' : o && o.type === 'asset' ? 'Save (overwrite library original)' : 'Save to library';
    $('edCropBtn').setAttribute('aria-pressed', E.mode === 'crop'); $('edCropBtn').textContent = E.mode === 'crop' ? 'Finish crop' : 'Start crop';
    $$('#edRatios button').forEach((b) => b.setAttribute('aria-pressed', Number(b.dataset.r) === E.ratio));
    $$('[data-adj]').forEach((r) => { r.value = E.adj[r.dataset.adj]; r.nextElementSibling.value = E.adj[r.dataset.adj]; });
    $('edHint').textContent = E.mode === 'crop' ? 'Drag the corners to resize, drag inside to move. When done, click 「Finish crop」。' : 'Click text on the image to select it, hold and drag to move it.';
    syncTextForm();
  }
  function syncTextForm() {
    const t = E.texts[E.sel];
    $('edTextForm').hidden = !t; $('edTextHint').hidden = !!t;
    if (!t) return;
    if (document.activeElement !== $('tfText')) $('tfText').value = t.text;
    $('tfFont').value = t.font; $('tfWeight').value = String(t.weight);
    $('tfSize').value = t.size; $('tfSizeO').value = t.size;
    $('tfColor').value = t.color; $('tfStroke').value = t.stroke;
    $('tfStrokeW').value = t.strokeW; $('tfStrokeWO').value = t.strokeW;
    $('tfBg').value = t.bg; $('tfBgOn').checked = !!t.bgOn;
  }
  /* adjust: work on pixels directly */
  function applyAdj(ctx, w, h) {
    const { b, c, s, t } = E.adj; if (!b && !c && !s && !t) return;
    const d = ctx.getImageData(0, 0, w, h), p = d.data;
    const bb = b * 1.28, cc = c * 1.28, cf = (259 * (cc + 255)) / (255 * (259 - cc)), sf = 1 + s / 100, tt = t * 0.3;
    for (let i = 0; i < p.length; i += 4) {
      let r = p[i] + bb + tt, g = p[i + 1] + bb, bl = p[i + 2] + bb - tt;
      r = cf * (r - 128) + 128; g = cf * (g - 128) + 128; bl = cf * (bl - 128) + 128;
      const l = 0.299 * r + 0.587 * g + 0.114 * bl;
      r = l + (r - l) * sf; g = l + (g - l) * sf; bl = l + (bl - l) * sf;
      p[i] = r < 0 ? 0 : r > 255 ? 255 : r; p[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g; p[i + 2] = bl < 0 ? 0 : bl > 255 ? 255 : bl;
    }
    ctx.putImageData(d, 0, 0);
  }
  const fontsReady = new Set();
  function ensureFont(t) {
    const key = t.weight + ' ' + t.font;
    if (fontsReady.has(key) || !document.fonts || !document.fonts.load) return;
    fontsReady.add(key);
    document.fonts.load(t.weight + ' 40px "' + t.font + '"', t.text || 'char').then(() => requestAnimationFrame(edRender)).catch(() => { });
  }
  /* draw a text block, return its box on the canvas */
  function drawText(ctx, t, W, H, s) {
    ensureFont(t);
    const fs = t.size / 100 * W * s, lines = (t.text || ' ').split('\n'), lh = fs * 1.22;
    ctx.save();
    ctx.font = t.weight + ' ' + fs + 'px "' + t.font + '", "Noto Sans SC", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const cx = t.x * W * s, cy = t.y * H * s;
    const bw = Math.max.apply(null, lines.map((l) => ctx.measureText(l).width)), bh = lines.length * lh;
    const padX = fs * 0.35, padY = fs * 0.18;
    if (t.bgOn) {
      ctx.fillStyle = t.bg; const x = cx - bw / 2 - padX, y = cy - bh / 2 - padY, w = bw + padX * 2, h = bh + padY * 2, r = Math.min(fs * 0.35, h / 2);
      ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); ctx.fill();
    }
    lines.forEach((l, i) => {
      const y = cy - bh / 2 + lh * (i + 0.5);
      if (t.strokeW > 0) { ctx.lineJoin = 'round'; ctx.miterLimit = 2; ctx.lineWidth = fs * t.strokeW / 100 * 2; ctx.strokeStyle = t.stroke; ctx.strokeText(l, cx, y); }
      ctx.fillStyle = t.color; ctx.fillText(l, cx, y);
    });
    ctx.restore();
    const ex = t.bgOn ? padX : fs * t.strokeW / 100, ey = t.bgOn ? padY : fs * t.strokeW / 100;
    return { x: cx - bw / 2 - ex, y: cy - bh / 2 - ey, w: bw + ex * 2, h: bh + ey * 2 };
  }
  function edRender() {
    const c = cv(); if (!E.img || $('pg-edit').hidden) { syncEdPanel(); return; }
    const wrap = $('edCanvasWrap'), maxW = wrap.clientWidth - 24, maxH = wrap.clientHeight - 24, dpr = window.devicePixelRatio || 1;
    const ctx = c.getContext('2d');
    if (E.mode === 'crop') {
      const W = E.rc.width, H = E.rc.height, k = Math.min(maxW / W, maxH / H);
      E.k = k;
      c.style.width = W * k + 'px'; c.style.height = H * k + 'px'; c.width = Math.round(W * k * dpr); c.height = Math.round(H * k * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.drawImage(E.rc, 0, 0, W * k, H * k);
      const r = { x: E.crop.x * k, y: E.crop.y * k, w: E.crop.w * k, h: E.crop.h * k };
      ctx.fillStyle = 'rgba(0,0,0,.5)';
      ctx.fillRect(0, 0, W * k, r.y); ctx.fillRect(0, r.y + r.h, W * k, H * k - r.y - r.h); ctx.fillRect(0, r.y, r.x, r.h); ctx.fillRect(r.x + r.w, r.y, W * k - r.x - r.w, r.h);
      ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 1;
      for (let i = 1; i < 3; i++) { ctx.beginPath(); ctx.moveTo(r.x + r.w * i / 3, r.y); ctx.lineTo(r.x + r.w * i / 3, r.y + r.h); ctx.moveTo(r.x, r.y + r.h * i / 3); ctx.lineTo(r.x + r.w, r.y + r.h * i / 3); ctx.stroke(); }
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = '#fff';
      [[r.x, r.y], [r.x + r.w, r.y], [r.x, r.y + r.h], [r.x + r.w, r.y + r.h]].forEach(([x, y]) => ctx.fillRect(x - 6, y - 6, 12, 12));
    } else {
      const W = E.crop.w, H = E.crop.h, k = Math.min(maxW / W, maxH / H);
      E.k = k;
      c.style.width = W * k + 'px'; c.style.height = H * k + 'px'; c.width = Math.round(W * k * dpr); c.height = Math.round(H * k * dpr);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(E.rc, E.crop.x, E.crop.y, E.crop.w, E.crop.h, 0, 0, c.width, c.height);
      applyAdj(ctx, c.width, c.height);
      const s = k * dpr;
      E.boxes = E.texts.map((t) => drawText(ctx, t, W, H, s));
      if (E.sel >= 0 && E.boxes[E.sel]) {
        const b = E.boxes[E.sel];
        ctx.save(); ctx.setLineDash([6 * dpr, 4 * dpr]); ctx.lineWidth = 1.5 * dpr; ctx.strokeStyle = '#2C52D2'; ctx.strokeRect(b.x - 4 * dpr, b.y - 4 * dpr, b.w + 8 * dpr, b.h + 8 * dpr); ctx.restore();
      }
    }
    syncEdPanel();
  }
  let rafPending = false;
  const edRenderSoon = () => { if (rafPending) return; rafPending = true; requestAnimationFrame(() => { rafPending = false; edRender(); }); };
  function canvasPoint(e) { const r = cv().getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  function bindCanvas() {
    const c = cv();
    c.addEventListener('pointerdown', (e) => {
      if (!E.img) return;
      const p = canvasPoint(e), dpr = window.devicePixelRatio || 1;
      if (E.mode === 'crop') {
        const k = E.k, r = { x: E.crop.x * k, y: E.crop.y * k, w: E.crop.w * k, h: E.crop.h * k };
        const corners = [[r.x, r.y, 'tl'], [r.x + r.w, r.y, 'tr'], [r.x, r.y + r.h, 'bl'], [r.x + r.w, r.y + r.h, 'br']];
        const hit = corners.find(([x, y]) => Math.abs(p.x - x) < 18 && Math.abs(p.y - y) < 18);
        if (hit) {
          const ax = hit[2][1] === 'l' ? E.crop.x + E.crop.w : E.crop.x, ay = hit[2][0] === 't' ? E.crop.y + E.crop.h : E.crop.y;
          E.drag = { type: 'resize', ax, ay };
        } else if (p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h) {
          E.drag = { type: 'move', ox: p.x / k - E.crop.x, oy: p.y / k - E.crop.y };
        } else return;
      } else {
        let hit = -1;
        for (let i = E.boxes.length - 1; i >= 0; i--) { const b = E.boxes[i], x = p.x * dpr, y = p.y * dpr; if (x >= b.x - 6 && x <= b.x + b.w + 6 && y >= b.y - 6 && y <= b.y + b.h + 6) { hit = i; break; } }
        E.sel = hit;
        if (hit >= 0) { const t = E.texts[hit], W = E.crop.w * E.k, H = E.crop.h * E.k; E.drag = { type: 'text', ox: p.x / W - t.x, oy: p.y / H - t.y }; }
        edRender();
        if (hit < 0) return;
      }
      c.setPointerCapture(e.pointerId); c.classList.add('grab'); e.preventDefault();
    });
    c.addEventListener('pointermove', (e) => {
      if (!E.drag) return;
      const p = canvasPoint(e), k = E.k, RW = E.rc.width, RH = E.rc.height;
      if (E.drag.type === 'move') {
        E.crop.x = Math.min(Math.max(p.x / k - E.drag.ox, 0), RW - E.crop.w);
        E.crop.y = Math.min(Math.max(p.y / k - E.drag.oy, 0), RH - E.crop.h);
      } else if (E.drag.type === 'resize') {
        const px = Math.min(Math.max(p.x / k, 0), RW), py = Math.min(Math.max(p.y / k, 0), RH), { ax, ay } = E.drag;
        const sx = px < ax ? -1 : 1, sy = py < ay ? -1 : 1;
        let w = Math.abs(px - ax), h = Math.abs(py - ay);
        if (E.ratio) { if (w / Math.max(h, 1) > E.ratio) h = w / E.ratio; else w = h * E.ratio; }
        const mw = sx > 0 ? RW - ax : ax, mh = sy > 0 ? RH - ay : ay;
        if (w > mw) { const f = mw / w; w *= f; h *= E.ratio ? f : 1; }
        if (h > mh) { const f = mh / h; h *= f; w *= E.ratio ? f : 1; }
        w = Math.max(w, 24); h = Math.max(h, 24);
        E.crop = { x: sx > 0 ? ax : ax - w, y: sy > 0 ? ay : ay - h, w, h };
      } else if (E.drag.type === 'text') {
        const t = E.texts[E.sel], W = E.crop.w * k, H = E.crop.h * k;
        t.x = Math.min(Math.max(p.x / W - E.drag.ox, 0), 1); t.y = Math.min(Math.max(p.y / H - E.drag.oy, 0), 1);
      }
      edRenderSoon();
    });
    const end = () => { E.drag = null; c.classList.remove('grab'); };
    c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
    window.addEventListener('resize', () => { if (!$('pg-edit').hidden) edRenderSoon(); });
  }
  function exportCanvas(maxSide) {
    const W = E.crop.w, H = E.crop.h, s = Math.min(1, maxSide / Math.max(W, H));
    const c = document.createElement('canvas'); c.width = Math.round(W * s); c.height = Math.round(H * s);
    const ctx = c.getContext('2d');
    ctx.drawImage(E.rc, E.crop.x, E.crop.y, E.crop.w, E.crop.h, 0, 0, c.width, c.height);
    applyAdj(ctx, c.width, c.height);
    E.texts.forEach((t) => drawText(ctx, t, W, H, s));
    return c;
  }
  const canvasBlob = (c, type, q) => new Promise((res) => c.toBlob(res, type, q));
  async function edSaveToLib(asNew) {
    const blob = await canvasBlob(exportCanvas(2400), 'image/jpeg', 0.92), t = Date.now();
    const base = (E.name || 'Images').replace(/\.[a-z0-9]+$/i, '');
    if (!asNew && E.origin && E.origin.type === 'asset') {
      const a = await DB.get('assets', E.origin.id);
      if (a) { a.blob = blob; a.mime = 'image/jpeg'; a.size = blob.size; a.updatedAt = t; await DB.put('assets', a); return a.id; }
    }
    const a = { id: uid(), kind: 'image', name: base + (asNew && E.origin ? '（ (edited)' : '') + '.jpg', mime: 'image/jpeg', size: blob.size, blob, note: '', createdAt: t, updatedAt: t };
    await DB.put('assets', a);
    if (!E.origin) { E.origin = { type: 'asset', id: a.id }; E.name = a.name; }
    return a.id;
  }
  async function edSaveToNote(append) {
    const d = exportCanvas(1440).toDataURL('image/jpeg', 0.88);
    const o = E.origin;
    if (!append && o && o.type === 'note') {
      if (o.noteId === N.id) { if (N.images[o.index] != null) N.images[o.index] = d; else N.images.push(d); changed(true); }
      else { const n = await DB.get('notes', o.noteId); if (n) { n.images[o.index] = d; n.updatedAt = Date.now(); await DB.put('notes', n); } }
      return;
    }
    if (N.images.length >= MAX_IMG) { toast('A note can have at most 18 photos'); return false; }
    N.images.push(d); changed(true);
  }
  function newText() {
    return { text: 'Double-click to edit', x: 0.5, y: 0.2, size: 9, font: 'Smiley Sans Oblique', weight: 400, color: '#1F4A3A', stroke: '#FFFFFF', strokeW: 10, bg: '#F6C445', bgOn: false };
  }
  function bindEditor() {
    bindCanvas();
    $$('[data-ed-open]').forEach((b) => {
      b.onclick = () => {
        if (b.dataset.edOpen === 'file') $('edInput').click();
        else openPicker(false, async (ids) => { const a = await DB.get('assets', ids[0]); if (a) edOpen({ blob: a.blob, name: a.name, origin: { type: 'asset', id: a.id } }); });
      };
    });
    $('edInput').onchange = function () { const f = this.files && this.files[0]; this.value = ''; if (f) edOpen({ blob: f, name: f.name, origin: null }); };
    $('edCropBtn').onclick = () => {
      E.mode = E.mode === 'crop' ? 'view' : 'crop'; E.sel = -1;
      if (E.mode === 'crop' && E.ratio) fitRatioCrop();
      edRender();
    };
    $$('#edRatios button').forEach((b) => {
      b.onclick = () => { E.ratio = Number(b.dataset.r); if (E.ratio) fitRatioCrop(); E.mode = 'crop'; edRender(); };
    });
    const rot = (d) => { E.rot = (E.rot + d + 360) % 360; buildRot(); E.crop = { x: 0, y: 0, w: E.rc.width, h: E.rc.height }; if (E.ratio) fitRatioCrop(); edRender(); };
    $('edRotL').onclick = () => rot(-90); $('edRotR').onclick = () => rot(90);
    $('edFlip').onclick = () => { E.flip = !E.flip; buildRot(); const W = E.rc.width; E.crop.x = W - E.crop.x - E.crop.w; edRender(); };
    $$('[data-adj]').forEach((r) => { r.oninput = () => { E.adj[r.dataset.adj] = Number(r.value); r.nextElementSibling.value = r.value; edRenderSoon(); }; });
    $('edAdjReset').onclick = () => { E.adj = { b: 0, c: 0, s: 0, t: 0 }; edRender(); };
    $('edResetAll').onclick = function () { twice(this, 'Tap again to reset to the original', () => { E.rot = 0; E.flip = false; E.ratio = 0; E.adj = { b: 0, c: 0, s: 0, t: 0 }; E.texts = []; E.sel = -1; E.mode = 'view'; buildRot(); E.crop = { x: 0, y: 0, w: E.rc.width, h: E.rc.height }; edRender(); }); };
    $('edAddText').onclick = () => {
      if (E.mode === 'crop') E.mode = 'view';
      const t = newText(); t.y = Math.min(0.85, 0.2 + E.texts.length * 0.12); E.texts.push(t); E.sel = E.texts.length - 1; edRender();
      $('tfText').focus(); $('tfText').select();
    };
    const T = () => E.texts[E.sel];
    $('tfText').oninput = function () { if (T()) { T().text = this.value; edRenderSoon(); } };
    $('tfFont').onchange = function () { if (T()) { T().font = this.value; edRender(); } };
    $('tfWeight').onchange = function () { if (T()) { T().weight = Number(this.value); edRender(); } };
    $('tfSize').oninput = function () { if (T()) { T().size = Number(this.value); $('tfSizeO').value = this.value; edRenderSoon(); } };
    $('tfColor').oninput = function () { if (T()) { T().color = this.value; edRenderSoon(); } };
    $('tfStroke').oninput = function () { if (T()) { T().stroke = this.value; edRenderSoon(); } };
    $('tfStrokeW').oninput = function () { if (T()) { T().strokeW = Number(this.value); $('tfStrokeWO').value = this.value; edRenderSoon(); } };
    $('tfBg').oninput = function () { if (T()) { T().bg = this.value; T().bgOn = true; edRenderSoon(); } };
    $('tfBgOn').onchange = function () { if (T()) { T().bgOn = this.checked; edRender(); } };
    $('tfCenter').onclick = () => { if (T()) { T().x = 0.5; edRender(); } };
    $('tfDup').onclick = () => { if (T()) { const c = Object.assign({}, T()); c.y = Math.min(0.95, c.y + 0.08); E.texts.push(c); E.sel = E.texts.length - 1; edRender(); } };
    $('tfDel').onclick = () => { if (T()) { E.texts.splice(E.sel, 1); E.sel = -1; edRender(); } };
    cv().addEventListener('dblclick', () => { if (T()) { $('tfText').focus(); $('tfText').select(); } });
    document.addEventListener('keydown', (e) => {
      if ($('pg-edit').hidden || E.sel < 0) return;
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (/INPUT|TEXTAREA|SELECT/.test(tag)) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { E.texts.splice(E.sel, 1); E.sel = -1; edRender(); e.preventDefault(); }
    });
    $('edSave').onclick = async () => {
      if (!E.img) return;
      E.mode = 'view'; E.sel = -1; edRender();
      try {
        if (E.origin && E.origin.type === 'note') { await edSaveToNote(false); toast('Saved to the note'); }
        else { await edSaveToLib(false); toast('Saved to the library'); }
        $('edSaveHint').textContent = 'Last saved: ' + fmtTime(Date.now());
        syncEdPanel();
      } catch (e) { saveFailed(e); }
    };
    $('edSaveLib').onclick = async () => { if (!E.img) return; try { await edSaveToLib(true); toast('Saved as a new asset in the library'); } catch (e) { saveFailed(e); } };
    $('edToNote').onclick = async () => { if (!E.img) return; if ((await edSaveToNote(true)) !== false) toast('Added as the last photo of the current note'); };
    $('edDownload').onclick = async () => { if (!E.img) return; const b = await canvasBlob(exportCanvas(2400), 'image/jpeg', 0.92); download(b, (E.name || 'Images').replace(/\.[a-z0-9]+$/i, '') + '--edited.jpg'); };
    $('pickOk').onclick = () => { closeModal('pickModal'); if (pickCb) pickCb(pickSel.slice()); };
  }

  /* ================= boot ================= */
  async function boot(reload) {
    if (!reload) {
      await DB.open();
      if (DB.ok && navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => { });
    }
    const acc = await DB.get('kv', 'account');
    let notes = await DB.all('notes');
    if (!notes.length && !reload) {
      const seed = window.SEED || {};
      const n = normalizeNote(Object.assign(blankNote(), seed.note || {}));
      await DB.put('notes', n); notes = [n];
      if (!acc && seed.account) await DB.put('kv', Object.assign({ id: 'account' }, seed.account));
    }
    A = Object.assign({ id: 'account', name: '', avatar: '', bio: '', fans: '0', likes: '0' }, (await DB.get('kv', 'account')) || {});
    const cur = await DB.get('kv', 'current');
    N = normalizeNote((cur && notes.find((n) => n.id === cur.noteId)) || notes.sort((a, b) => b.updatedAt - a.updatedAt)[0]);
    fillAccount(); renderAccount(); loadNoteIntoUI(); updateDraftCount();
    setStatus(DB.ok ? 'Content is saved automatically' : 'This browser can’t store long-term. Export a backup before closing the page', DB.ok ? '' : 'warn');
    if (reload) renderLib();
  }
  window.addEventListener('hashchange', route);
  document.addEventListener('DOMContentLoaded', async () => {
    bindTop(); bindSim(); renderComps(); bindLib(); bindEditor();
    await boot(false);
    route();
  });
})();
