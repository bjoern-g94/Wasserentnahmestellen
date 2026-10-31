(() => {
  'use strict';

  // ---------- Konstanten ----------
  const TILE = 256;
  const TILE_CACHE = 'wk-tiles-v1';
  const KEY_DATA = 'wk_stellen_v1';
  const KEY_VIEW = 'wk_view_v1';
  const MINZ = 12, MAXZ = 19;
  const NEAREST_N = 5;
  const tileUrl = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;

  const TYPEN = {
    hydrant:  { label: 'Hydrant',                         short: 'H', color: '#ef6c00' },
    teich:    { label: 'Löschteich',                      short: 'T', color: '#1565c0' },
    zisterne: { label: 'Zisterne / Löschwasserbehälter',  short: 'Z', color: '#00838f' },
    brunnen:  { label: 'Löschwasserbrunnen',              short: 'B', color: '#2e7d32' },
    saug:     { label: 'Saugstelle (Gewässer)',           short: 'S', color: '#6a1b9a' },
    sonst:    { label: 'Sonstige',                        short: '?', color: '#616161' }
  };

  const $ = (s) => document.querySelector(s);
  const mapEl = $('#map'), tilesEl = $('#tiles'), markersEl = $('#markers'), linesEl = $('#lines');

  // ---------- Zustand ----------
  let stellen = loadStellen();
  let view = loadView() || { lat: 53.19, lng: 8.99, z: 15 }; // grob Grasberg, wird gemerkt
  let mode = 'einsatz';      // 'einsatz' | 'neu'
  let einsatz = null;        // {lat,lng}
  let gps = null;            // {lat,lng}
  let editing = null;        // aktuell bearbeitete Stelle (oder null bei neu)
  let pendingPos = null;     // Position für neue / bearbeitete Stelle

  // ---------- Speicher ----------
  function loadStellen() {
    try {
      const a = JSON.parse(localStorage.getItem(KEY_DATA) || '[]');
      return Array.isArray(a) ? a.filter(validStelle) : [];
    } catch (e) { return []; }
  }
  function saveStellen() {
    try { localStorage.setItem(KEY_DATA, JSON.stringify(stellen)); }
    catch (e) { alert('Speichern auf diesem Gerät ist fehlgeschlagen. Bitte Speicherplatz bzw. Browser-Einstellungen prüfen.'); }
  }
  function loadView() {
    try {
      const v = JSON.parse(localStorage.getItem(KEY_VIEW) || 'null');
      if (v && isFinite(v.lat) && isFinite(v.lng) && isFinite(v.z)) return v;
    } catch (e) { /* ignorieren */ }
    return null;
  }
  function saveView() {
    try { localStorage.setItem(KEY_VIEW, JSON.stringify(view)); } catch (e) { /* ignorieren */ }
  }
  function validStelle(s) {
    return s && typeof s === 'object' && isFinite(s.lat) && isFinite(s.lng) && typeof s.id === 'string';
  }
  function newId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  // ---------- Geografie ----------
  const rad = (d) => d * Math.PI / 180;
  const deg = (r) => r * 180 / Math.PI;
  const worldSize = (z) => TILE * Math.pow(2, z);

  function project(lat, lng, z) {
    const s = worldSize(z);
    const sin = Math.sin(rad(Math.max(-85, Math.min(85, lat))));
    return {
      x: (lng + 180) / 360 * s,
      y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * s
    };
  }
  function unproject(x, y, z) {
    const s = worldSize(z);
    const n = Math.PI - 2 * Math.PI * y / s;
    return {
      lat: deg(Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))),
      lng: x / s * 360 - 180
    };
  }
  function distanceM(a, b) {
    const R = 6371000;
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function bearing(a, b) {
    const p1 = rad(a.lat), p2 = rad(b.lat), dl = rad(b.lng - a.lng);
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }
  const DIRS = ['N', 'NO', 'O', 'SO', 'S', 'SW', 'W', 'NW'];
  const dirName = (b) => DIRS[Math.round(b / 45) % 8];
  function fmtDist(m) {
    return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(2).replace('.', ',') + ' km';
  }

  // ---------- Nächste Stellen ----------
  function nearest() {
    if (!einsatz) return [];
    return stellen
      .map((s) => ({ s, d: distanceM(einsatz, s), b: bearing(einsatz, s) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, NEAREST_N);
  }

  // ---------- Kartendarstellung ----------
  const tileEls = new Map();
  let rafPending = false;
  function scheduleRender() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; render(); });
  }

  function render() {
    const w = mapEl.clientWidth, h = mapEl.clientHeight;
    if (!w || !h) return;
    const z = view.z;
    const c = project(view.lat, view.lng, z);
    const left = c.x - w / 2, top = c.y - h / 2;
    const n = Math.pow(2, z);

    // Kacheln
    const needed = new Set();
    const x0 = Math.floor(left / TILE), x1 = Math.floor((left + w) / TILE);
    const y0 = Math.floor(top / TILE), y1 = Math.floor((top + h) / TILE);
    for (let y = y0; y <= y1; y++) {
      if (y < 0 || y >= n) continue;
      for (let x = x0; x <= x1; x++) {
        const key = z + '/' + x + '/' + y;
        needed.add(key);
        let img = tileEls.get(key);
        if (!img) {
          img = document.createElement('img');
          img.className = 'tile';
          img.alt = '';
          img.draggable = false;
          img.onerror = () => { img.style.visibility = 'hidden'; };
          img.src = tileUrl(z, ((x % n) + n) % n, y);
          tilesEl.appendChild(img);
          tileEls.set(key, img);
        }
        img.style.transform = `translate(${Math.round(x * TILE - left)}px, ${Math.round(y * TILE - top)}px)`;
      }
    }
    for (const [key, img] of tileEls) {
      if (!needed.has(key)) { img.remove(); tileEls.delete(key); }
    }

    // Marker und Linien
    const near = nearest();
    const rankOf = new Map(near.map((r, i) => [r.s.id, i + 1]));
    markersEl.textContent = '';
    linesEl.textContent = '';
    const toPx = (p) => {
      const q = project(p.lat, p.lng, z);
      return { x: q.x - left, y: q.y - top };
    };
    const inView = (p) => p.x > -40 && p.y > -40 && p.x < w + 40 && p.y < h + 40;

    if (einsatz) {
      const e = toPx(einsatz);
      near.forEach((r) => {
        const p = toPx(r.s);
        const ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        ln.setAttribute('x1', e.x); ln.setAttribute('y1', e.y);
        ln.setAttribute('x2', p.x); ln.setAttribute('y2', p.y);
        ln.setAttribute('stroke', '#d50000'); ln.setAttribute('stroke-width', '2.5');
        ln.setAttribute('stroke-dasharray', '7 6'); ln.setAttribute('opacity', '0.85');
        linesEl.appendChild(ln);
      });
    }
    stellen.forEach((s) => {
      const p = toPx(s);
      if (!inView(p)) return;
      const t = TYPEN[s.typ] || TYPEN.sonst;
      const rank = rankOf.get(s.id);
      const m = document.createElement('div');
      m.className = 'marker' + (rank ? ' near' : '');
      m.style.left = p.x + 'px'; m.style.top = p.y + 'px';
      m.style.background = t.color;
      m.textContent = t.short;
      if (rank) {
        const r = document.createElement('span');
        r.className = 'rank'; r.textContent = rank;
        m.appendChild(r);
      }
      markersEl.appendChild(m);
    });
    if (gps) {
      const p = toPx(gps);
      if (inView(p)) {
        const m = document.createElement('div');
        m.className = 'marker gps';
        m.style.left = p.x + 'px'; m.style.top = p.y + 'px';
        markersEl.appendChild(m);
      }
    }
    if (einsatz) {
      const p = toPx(einsatz);
      const m = document.createElement('div');
      m.className = 'marker einsatz';
      m.style.left = p.x + 'px'; m.style.top = p.y + 'px';
      m.textContent = 'E';
      markersEl.appendChild(m);
    }
  }

  function setView(lat, lng, z) {
    view = { lat, lng, z: Math.max(MINZ, Math.min(MAXZ, z != null ? z : view.z)) };
    saveView();
    scheduleRender();
  }
  function zoomBy(d) {
    const nz = Math.max(MINZ, Math.min(MAXZ, view.z + d));
    if (nz === view.z) return;
    view.z = nz;
    saveView();
    render();
  }

  // ---------- Ergebnisliste ----------
  function updateHint() {
    const h = $('#hint');
    if (mode === 'neu') h.textContent = 'Tippe dorthin, wo die Entnahmestelle liegt. Vorhandene Stellen antippen = bearbeiten.';
    else if (!einsatz) h.textContent = 'Tippe auf die Karte, um den Einsatzort zu setzen.';
    else h.textContent = '';
  }

  function updateResult() {
    const box = $('#result');
    box.textContent = '';
    updateHint();

    if (mode === 'neu') {
      const p = document.createElement('div');
      p.className = 'empty';
      p.textContent = stellen.length
        ? stellen.length + ' Entnahmestelle(n) gespeichert. Karte antippen, um eine weitere einzutragen.'
        : 'Noch keine Entnahmestellen gespeichert. Karte antippen, um die erste einzutragen.';
      box.appendChild(p);
      return;
    }
    if (!einsatz) {
      const p = document.createElement('div');
      p.className = 'empty';
      p.textContent = 'Noch kein Einsatzort gesetzt.';
      box.appendChild(p);
      return;
    }
    const head = document.createElement('div');
    head.className = 'res-head';
    const lbl = document.createElement('span');
    lbl.textContent = `Nächste Entnahmestellen (Luftlinie ab Einsatzort)`;
    const x = document.createElement('button');
    x.textContent = '✕'; x.setAttribute('aria-label', 'Einsatzort löschen');
    x.onclick = () => { einsatz = null; refresh(); };
    head.append(lbl, x);
    box.appendChild(head);

    const near = nearest();
    if (!near.length) {
      const p = document.createElement('div');
      p.className = 'empty';
      p.textContent = 'Noch keine Entnahmestellen eingetragen. Wechsle auf „Stelle eintragen“.';
      box.appendChild(p);
      return;
    }
    const ol = document.createElement('ol');
    ol.className = 'list';
    near.forEach((r, i) => {
      const t = TYPEN[r.s.typ] || TYPEN.sonst;
      const li = document.createElement('li');
      const rank = document.createElement('div'); rank.className = 'r-rank'; rank.textContent = i + 1;
      const info = document.createElement('div'); info.className = 'r-info';
      const b = document.createElement('b'); b.textContent = r.s.name || t.label;
      const sm = document.createElement('small');
      const parts = [t.label];
      if (r.s.lmin) parts.push(r.s.lmin + ' l/min');
      if (r.s.bem) parts.push(r.s.bem);
      sm.textContent = parts.join(' · ');
      info.append(b, sm);
      const dist = document.createElement('div'); dist.className = 'r-dist';
      dist.textContent = fmtDist(r.d);
      const dir = document.createElement('small'); dir.textContent = dirName(r.b);
      dist.appendChild(dir);
      li.append(rank, info, dist);
      li.onclick = () => setView(r.s.lat, r.s.lng, Math.max(view.z, 17));
      ol.appendChild(li);
    });
    box.appendChild(ol);
  }

  function refresh() {
    updateResult();
    render();
  }

  // ---------- Modus ----------
  function setMode(m) {
    mode = m;
    $('#mode-einsatz').classList.toggle('on', m === 'einsatz');
    $('#mode-neu').classList.toggle('on', m === 'neu');
    refresh();
  }
  $('#mode-einsatz').onclick = () => setMode('einsatz');
  $('#mode-neu').onclick = () => setMode('neu');

  // ---------- Karteninteraktion ----------
  const pointers = new Map();
  let drag = null, pinchBase = 0, lastWheel = 0;
  const pdist = () => {
    const a = [...pointers.values()];
    return Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
  };

  mapEl.addEventListener('pointerdown', (e) => {
    try { mapEl.setPointerCapture(e.pointerId); } catch (err) { /* ignorieren */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      drag = { t: Date.now(), moved: false, sx: e.clientX, sy: e.clientY };
    } else {
      if (drag) drag.moved = true;
      if (pointers.size === 2) pinchBase = pdist();
    }
  });

  mapEl.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1 && drag) {
      if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 8) drag.moved = true;
      if (drag.moved) {
        const c = project(view.lat, view.lng, view.z);
        const n = unproject(c.x - dx, c.y - dy, view.z);
        view.lat = Math.max(-84, Math.min(84, n.lat)); view.lng = n.lng;
        scheduleRender();
      }
    } else if (pointers.size === 2 && pinchBase) {
      const d = pdist(), ratio = d / pinchBase;
      if (ratio > 1.6) { zoomBy(1); pinchBase = d; }
      else if (ratio < 0.62) { zoomBy(-1); pinchBase = d; }
    }
  });

  function endPointer(e, cancelled) {
    if (!pointers.has(e.pointerId)) return;
    const wasSingle = pointers.size === 1;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchBase = 0;
    if (wasSingle && drag) {
      const isTap = !cancelled && !drag.moved && Date.now() - drag.t < 700;
      drag = null;
      if (isTap) {
        const r = mapEl.getBoundingClientRect();
        handleTap(e.clientX - r.left, e.clientY - r.top);
      } else {
        saveView();
      }
    }
    if (pointers.size === 0) drag = null;
  }
  mapEl.addEventListener('pointerup', (e) => endPointer(e, false));
  mapEl.addEventListener('pointercancel', (e) => endPointer(e, true));

  mapEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    const now = Date.now();
    if (now - lastWheel < 250) return;
    lastWheel = now;
    zoomBy(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  function pixelToLatLng(px, py) {
    const w = mapEl.clientWidth, h = mapEl.clientHeight;
    const c = project(view.lat, view.lng, view.z);
    return unproject(c.x - w / 2 + px, c.y - h / 2 + py, view.z);
  }

  function handleTap(px, py) {
    // Treffer auf vorhandene Stelle?
    const w = mapEl.clientWidth, h = mapEl.clientHeight;
    const c = project(view.lat, view.lng, view.z);
    let hit = null, best = 28;
    stellen.forEach((s) => {
      const p = project(s.lat, s.lng, view.z);
      const d = Math.hypot(p.x - c.x + w / 2 - px, p.y - c.y + h / 2 - py);
      if (d < best) { best = d; hit = s; }
    });
    if (hit) { openStelleDialog(hit, null); return; }

    const ll = pixelToLatLng(px, py);
    if (mode === 'neu') openStelleDialog(null, ll);
    else { einsatz = { lat: ll.lat, lng: ll.lng }; refresh(); }
  }

  $('#zin').onclick = () => zoomBy(1);
  $('#zout').onclick = () => zoomBy(-1);
  window.addEventListener('resize', scheduleRender);

  // ---------- GPS ----------
  function locate(cb) {
    if (!navigator.geolocation) { alert('Standortbestimmung wird von diesem Gerät/Browser nicht unterstützt.'); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => cb({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      () => alert('Standort konnte nicht bestimmt werden. Bitte Standortfreigabe für diese App erlauben.'),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
    );
  }
  $('#btn-gps').onclick = () => locate((p) => {
    gps = p;
    setView(p.lat, p.lng, Math.max(view.z, 17));
  });

  // ---------- Dialog: Entnahmestelle ----------
  const dlg = $('#dlg-stelle');
  const fTyp = $('#f-typ');
  Object.entries(TYPEN).forEach(([k, t]) => {
    const o = document.createElement('option');
    o.value = k; o.textContent = t.label;
    fTyp.appendChild(o);
  });

  function showCoords() {
    $('#f-coords').textContent = pendingPos
      ? `Position: ${pendingPos.lat.toFixed(6)}, ${pendingPos.lng.toFixed(6)}`
      : '';
  }

  function openStelleDialog(stelle, pos) {
    editing = stelle;
    pendingPos = stelle ? { lat: stelle.lat, lng: stelle.lng } : pos;
    $('#dlg-title').textContent = stelle ? 'Entnahmestelle bearbeiten' : 'Neue Entnahmestelle';
    $('#f-name').value = stelle ? (stelle.name || '') : '';
    fTyp.value = stelle ? (stelle.typ || 'sonst') : 'hydrant';
    $('#f-lmin').value = stelle && stelle.lmin ? stelle.lmin : '';
    $('#f-bem').value = stelle ? (stelle.bem || '') : '';
    $('#f-del').style.display = stelle ? '' : 'none';
    showCoords();
    dlg.showModal();
  }

  $('#f-gps').onclick = () => locate((p) => { pendingPos = p; showCoords(); });
  $('#f-cancel').onclick = () => dlg.close();
  $('#f-del').onclick = () => {
    if (!editing) return;
    if (!confirm('Diese Entnahmestelle wirklich löschen?')) return;
    stellen = stellen.filter((s) => s.id !== editing.id);
    saveStellen();
    dlg.close();
    refresh();
  };
  $('#f-save').onclick = () => {
    if (!pendingPos) return;
    const lm = parseInt($('#f-lmin').value, 10);
    const data = {
      name: $('#f-name').value.trim(),
      typ: fTyp.value,
      lmin: isFinite(lm) && lm > 0 ? lm : null,
      bem: $('#f-bem').value.trim(),
      lat: pendingPos.lat,
      lng: pendingPos.lng,
      ts: Date.now()
    };
    if (editing) {
      Object.assign(editing, data);
    } else {
      stellen.push(Object.assign({ id: newId() }, data));
    }
    saveStellen();
    dlg.close();
    refresh();
  };

  // ---------- Dialog: Daten & Offline ----------
  const dm = $('#dlg-menu');
  $('#btn-menu').onclick = () => {
    $('#m-info').textContent = `${stellen.length} Entnahmestelle(n) auf diesem Gerät gespeichert.`;
    $('#m-msg').textContent = '';
    $('#m-progress').textContent = '';
    dm.showModal();
  };
  $('#m-close').onclick = () => dm.close();

  $('#m-clear').onclick = () => {
    if (!stellen.length) return;
    if (!confirm('ALLE Entnahmestellen auf diesem Gerät löschen? Das kann nicht rückgängig gemacht werden.')) return;
    stellen = [];
    saveStellen();
    $('#m-info').textContent = '0 Entnahmestelle(n) auf diesem Gerät gespeichert.';
    refresh();
  };

  $('#m-export').onclick = async () => {
    const payload = { app: 'wasserkarte', version: 1, exportiert: new Date().toISOString(), stellen };
    const name = 'wasserentnahmestellen-' + new Date().toISOString().slice(0, 10) + '.json';
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    try {
      const file = new File([blob], name, { type: 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: name });
        return;
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  };

  $('#m-import').onclick = () => $('#m-file').click();
  $('#m-file').onchange = async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const list = Array.isArray(data) ? data : data.stellen;
      if (!Array.isArray(list)) throw new Error('Format');
      let added = 0, updated = 0, skipped = 0;
      list.forEach((s) => {
        if (!validStelle(s)) { skipped++; return; }
        const ex = stellen.find((x) => x.id === s.id);
        if (!ex) { stellen.push(s); added++; }
        else if ((s.ts || 0) > (ex.ts || 0)) { Object.assign(ex, s); updated++; }
      });
      saveStellen();
      refresh();
      $('#m-info').textContent = `${stellen.length} Entnahmestelle(n) auf diesem Gerät gespeichert.`;
      $('#m-msg').textContent = `Import: ${added} neu, ${updated} aktualisiert` + (skipped ? `, ${skipped} ungültig übersprungen` : '') + '.';
    } catch (err) {
      $('#m-msg').textContent = 'Die Datei konnte nicht gelesen werden.';
    }
  };

  // ---------- Offline-Karte vorladen ----------
  let prefetching = false;
  $('#m-prefetch').onclick = async () => {
    if (prefetching) return;
    if (!('caches' in window)) { alert('Dieser Browser unterstützt keinen Offline-Speicher.'); return; }
    if (!navigator.onLine) { alert('Dafür wird eine Internetverbindung benötigt.'); return; }
    const w = mapEl.clientWidth, h = mapEl.clientHeight;
    const c = project(view.lat, view.lng, view.z);
    const tl = unproject(c.x - w * 0.75, c.y - h * 0.75, view.z);
    const br = unproject(c.x + w * 0.75, c.y + h * 0.75, view.z);
    const jobs = [];
    for (let z = 15; z <= 18; z++) {
      const n = Math.pow(2, z);
      const a = project(tl.lat, tl.lng, z), b = project(br.lat, br.lng, z);
      const xa = Math.floor(a.x / TILE), xb = Math.floor(b.x / TILE);
      const ya = Math.floor(a.y / TILE), yb = Math.floor(b.y / TILE);
      for (let y = Math.max(0, ya); y <= Math.min(n - 1, yb); y++)
        for (let x = Math.max(0, xa); x <= Math.min(n - 1, xb); x++) jobs.push([z, x, y]);
    }
    if (jobs.length > 900) {
      alert(`Der Ausschnitt ist zu groß (${jobs.length} Kacheln). Bitte weiter hineinzoomen und erneut versuchen.`);
      return;
    }
    if (!confirm(`${jobs.length} Kartenkacheln (ca. ${Math.max(1, Math.round(jobs.length * 0.02))} MB) auf diesem Gerät speichern?`)) return;

    prefetching = true;
    const prog = $('#m-progress');
    const cache = await caches.open(TILE_CACHE);
    let done = 0, failed = 0, idx = 0;
    const worker = async () => {
      while (idx < jobs.length) {
        const [z, x, y] = jobs[idx++];
        const url = tileUrl(z, x, y);
        try {
          if (!(await cache.match(url))) {
            const res = await fetch(url, { mode: 'no-cors' });
            await cache.put(url, res);
            await new Promise((r) => setTimeout(r, 80));
          }
        } catch (e) { failed++; }
        done++;
        prog.textContent = `Lade Karte … ${done} / ${jobs.length}`;
      }
    };
    await Promise.all([worker(), worker()]);
    prefetching = false;
    prog.textContent = failed
      ? `Fertig, aber ${failed} Kachel(n) fehlen. Bitte mit besserer Verbindung wiederholen.`
      : `Fertig: ${jobs.length} Kacheln gespeichert. Die Karte funktioniert für diesen Ausschnitt jetzt offline.`;
  };

  // ---------- Online-Status & Service Worker ----------
  function updateNet() {
    const el = $('#net');
    el.textContent = navigator.onLine ? 'online' : 'offline';
    el.classList.toggle('off', !navigator.onLine);
  }
  window.addEventListener('online', updateNet);
  window.addEventListener('offline', updateNet);
  updateNet();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => { /* ohne SW kein Offline-Betrieb */ });
    });
  }

  // ---------- Start ----------
  refresh();
})();
