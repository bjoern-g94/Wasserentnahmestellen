(() => {
  'use strict';

  // ---------- Konstanten ----------
  const TILE = 256;
  const TILE_CACHE = 'wk-tiles-v1';
  const KEY_DATA = 'wk_stellen_v1';
  const KEY_VIEW = 'wk_view_v1';
  const KEY_STAND = 'wk_stammdaten_stand';   // Stand der zuletzt übernommenen stellen.json
  const KEY_DIRTY = 'wk_dirty';              // lokale Änderungen, die noch nicht exportiert wurden
  const KEY_DECL = 'wk_declined_stand';      // Stand, dessen Übernahme abgelehnt wurde
  const MINZ = 12, MAXZ = 19;
  const NEAREST_N = 5;
  const MAX_TILES = 2500;   // Obergrenze für den Offline-Kartendownload
  const ORT = 'Grasberg';   // Ortsbezug für die Online-Adresssuche
  const tileUrl = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;

  const TYPEN = {
    unterflur: { label: 'Unterflurhydrant',   short: 'U', color: '#ef6c00' },
    brunnen:   { label: 'Löschwasserbrunnen', short: 'B', color: '#2e7d32' },
    sonst:     { label: 'Sonstiges',          short: 'S', color: '#616161' }
  };
  // Alte Einträge aus früheren Versionen werden beim Laden umgestellt
  const TYP_ALT = { hydrant: 'unterflur' };
  const ALT_LABEL = { teich: 'Löschteich', zisterne: 'Zisterne', saug: 'Saugstelle' };

  const $ = (s) => document.querySelector(s);
  const mapEl = $('#map'), tilesEl = $('#tiles'), markersEl = $('#markers'), linesEl = $('#lines');

  // ---------- Zustand ----------
  let stellen = loadStellen();
  const hadView = !!loadView();
  let view = loadView() || { lat: 53.225, lng: 8.993, z: 15 }; // wird nach dem Laden der Karte auf das Einsatzgebiet gesetzt
  let mode = 'einsatz';      // 'einsatz' | 'neu'
  let einsatz = null;        // {lat,lng}
  let gps = null;            // {lat,lng}
  let editing = null;        // aktuell bearbeitete Stelle (oder null bei neu)
  let base = 'vec';          // 'vec' = eingebaute Karte, 'osm' = OSM-Kartenbilder
  try { base = localStorage.getItem('wk_base') || 'vec'; } catch (e) { /* ignorieren */ }
  let vec = null;           // eingebaute Kartendaten
  let extra = 0;            // wie oft „Weitere anzeigen“ gedrückt wurde (je 2 Stellen)
  let lastTyp = 'unterflur';
  try { lastTyp = localStorage.getItem('wk_last_typ') || 'unterflur'; } catch (e) { /* ignorieren */ }
  let pendingPos = null;     // Position für neue / bearbeitete Stelle
  let adressen = [];         // Offline-Adressliste (addresses.json)
  let einsatzLabel = null;   // Beschriftung des Einsatzorts (Adresse), sonst null

  // ---------- Speicher ----------
  function loadStellen() {
    try {
      const a = JSON.parse(localStorage.getItem(KEY_DATA) || '[]');
      return Array.isArray(a) ? a.filter(validStelle).map(normStelle) : [];
    } catch (e) { return []; }
  }
  let dirty = false;
  try { dirty = localStorage.getItem(KEY_DIRTY) === '1'; } catch (e) { /* ignorieren */ }
  function saveStellen(fromMaster) {
    try { localStorage.setItem(KEY_DATA, JSON.stringify(stellen)); }
    catch (e) { alert('Speichern auf diesem Gerät ist fehlgeschlagen. Bitte Speicherplatz bzw. Browser-Einstellungen prüfen.'); }
    if (!fromMaster) {
      dirty = true;
      try { localStorage.setItem(KEY_DIRTY, '1'); } catch (e) { /* ignorieren */ }
    }
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
  function normStelle(s) {
    if (!TYPEN[s.typ]) {
      if (ALT_LABEL[s.typ]) s.bem = ALT_LABEL[s.typ] + (s.bem ? ' – ' + s.bem : '');
      s.typ = TYP_ALT[s.typ] || 'sonst';
    }
    delete s.lmin; // Ergiebigkeit wird nicht gespeichert
    return s;
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
    const all = stellen
      .map((s) => ({ s, d: distanceM(einsatz, s), b: bearing(einsatz, s) }))
      .sort((a, b) => a.d - b.d);
    // Grundauswahl: nächster Unterflurhydrant + die zwei nächsten anderen Arten
    const uh = all.find((r) => r.s.typ === 'unterflur');
    const base = (uh ? [uh] : []).concat(all.filter((r) => r.s.typ !== 'unterflur').slice(0, 2));
    base.sort((a, b) => a.d - b.d);
    // Weitere: je Klick die zwei nächsten, unabhängig von der Art
    const more = all.filter((r) => !base.includes(r)).slice(0, extra * 2);
    return base.concat(more);
  }

  // ---------- Kartendarstellung ----------
  // ---------- Eingebaute Karte (Vektordaten) ----------
  const vecEl = $('#vec');
  const vctx = vecEl.getContext('2d');
  function decodeLine(p, extra) {
    const n = p.length / 2, a = new Float64Array(n * 2);
    let la = 0, ln = 0, mnA = 1e9, mnB = 1e9, mxA = -1e9, mxB = -1e9;
    for (let i = 0; i < n; i++) {
      la += p[2 * i]; ln += p[2 * i + 1];
      const A = la / 1e5, B = ln / 1e5;
      a[2 * i] = A; a[2 * i + 1] = B;
      if (A < mnA) mnA = A; if (A > mxA) mxA = A; if (B < mnB) mnB = B; if (B > mxB) mxB = B;
    }
    return Object.assign({ a, bb: [mnA, mnB, mxA, mxB] }, extra);
  }
  function homeView() {
    if (!vec) return;
    const b = vec.bounds;
    setView((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, 15);
  }
  fetch('mapdata.json')
    .then((r) => (r.ok ? r.json() : null))
    .then((j) => {
      if (!j || !j.roads) return;
      vec = {
        bounds: j.bounds,
        roads: j.roads.map((r) => decodeLine(r.p, { k: r.k, n: r.n })),
        ww: j.ww.map((r) => decodeLine(r.p)),
        water: j.water.map((r) => decodeLine(r.p)),
        bld: j.bld.map((r) => decodeLine(r.p))
      };
      if (!hadView) homeView(); else render();
      updateBaseButtons();
    })
    .catch(() => { /* ohne eingebaute Karte: OSM-Kartenbilder */ });

  const ROAD = {
    a: { m: 9, min: 3.2, fill: '#fbd08a', casing: '#c9a063' },
    b: { m: 6, min: 2.6, fill: '#ffffff', casing: '#b8b0a6' },
    c: { m: 3.5, min: 1.6, fill: '#fbfbfb', casing: '#c5beb4' }
  };

  function drawVec(w, h, z, left, top) {
    const dpr = window.devicePixelRatio || 1;
    const cw = Math.round(w * dpr), ch = Math.round(h * dpr);
    if (vecEl.width !== cw || vecEl.height !== ch) { vecEl.width = cw; vecEl.height = ch; }
    const g = vctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#f2efe9';
    g.fillRect(0, 0, w, h);
    const tl = unproject(left - 30, top - 30, z), br = unproject(left + w + 30, top + h + 30, z);
    const vis = (f) => f.bb[2] >= br.lat && f.bb[0] <= tl.lat && f.bb[3] >= tl.lng && f.bb[1] <= br.lng;
    const ppm = (TILE * Math.pow(2, z)) / (40075016 * Math.cos(rad(view.lat)));
    const trace = (f, close) => {
      const a = f.a;
      g.beginPath();
      for (let i = 0; i < a.length; i += 2) {
        const q = project(a[i], a[i + 1], z);
        if (i === 0) g.moveTo(q.x - left, q.y - top); else g.lineTo(q.x - left, q.y - top);
      }
      if (close) g.closePath();
    };
    g.lineJoin = 'round'; g.lineCap = 'round';

    // Wasserflächen und Gräben
    g.fillStyle = '#aad3df';
    vec.water.forEach((f) => { if (vis(f)) { trace(f, true); g.fill(); } });
    g.strokeStyle = '#7fb4d9'; g.lineWidth = Math.max(1.2, 1.5 * ppm);
    vec.ww.forEach((f) => { if (vis(f)) { trace(f, false); g.stroke(); } });

    // Gebäude
    g.fillStyle = '#d9d0c7'; g.strokeStyle = '#b6a99c'; g.lineWidth = 1;
    vec.bld.forEach((f) => { if (vis(f)) { trace(f, true); g.fill(); g.stroke(); } });

    // Wege (Feld- und Fußwege gestrichelt)
    g.setLineDash([4, 3]); g.strokeStyle = '#b07d58'; g.lineWidth = 1.3;
    vec.roads.forEach((f) => { if (f.k === 'd' && vis(f)) { trace(f, false); g.stroke(); } });
    g.setLineDash([]);

    // Straßen: erst Rand, dann Füllung
    ['c', 'b', 'a'].forEach((k) => {
      const st = ROAD[k], wd = Math.max(st.min, st.m * ppm);
      const list = vec.roads.filter((f) => f.k === k && vis(f));
      g.strokeStyle = st.casing; g.lineWidth = wd + 2;
      list.forEach((f) => { trace(f, false); g.stroke(); });
      g.strokeStyle = st.fill; g.lineWidth = wd;
      list.forEach((f) => { trace(f, false); g.stroke(); });
    });

    // Straßennamen entlang der Straße
    if (z >= 15) {
      g.font = `600 ${z >= 17 ? 13 : 12}px system-ui, sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineWidth = 3.5; g.strokeStyle = 'rgba(255,255,255,.9)'; g.fillStyle = '#333';
      const placed = [];
      vec.roads.forEach((f) => {
        if (!f.n || (f.k !== 'a' && f.k !== 'b') || !vis(f)) return;
        const a = f.a;
        let best = null;
        for (let i = 0; i + 3 < a.length; i += 2) {
          const p1 = project(a[i], a[i + 1], z), p2 = project(a[i + 2], a[i + 3], z);
          const x1 = p1.x - left, y1 = p1.y - top, x2 = p2.x - left, y2 = p2.y - top;
          const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
          if (mx < 20 || my < 20 || mx > w - 20 || my > h - 20) continue;
          const L = Math.hypot(x2 - x1, y2 - y1);
          if (!best || L > best.L) best = { L, mx, my, ang: Math.atan2(y2 - y1, x2 - x1) };
        }
        if (!best) return;
        const tw = g.measureText(f.n).width;
        if (best.L < tw + 14) return;
        if (placed.some((q) => q.n === f.n && Math.hypot(q.x - best.mx, q.y - best.my) < 220)) return;
        placed.push({ n: f.n, x: best.mx, y: best.my });
        let ang = best.ang;
        if (ang > Math.PI / 2 || ang < -Math.PI / 2) ang += Math.PI;
        g.save();
        g.translate(best.mx, best.my); g.rotate(ang);
        g.strokeText(f.n, 0, 0); g.fillText(f.n, 0, 0);
        g.restore();
      });
    }

    // Hausnummern bei starker Vergrößerung
    if (z >= 18 && adressen.length) {
      g.font = '600 11px system-ui, sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineWidth = 3; g.strokeStyle = 'rgba(255,255,255,.9)'; g.fillStyle = '#555';
      adressen.forEach((a) => {
        if (a.lat > tl.lat || a.lat < br.lat || a.lng < tl.lng || a.lng > br.lng) return;
        const q = project(a.lat, a.lng, z);
        g.strokeText(a.n, q.x - left, q.y - top); g.fillText(a.n, q.x - left, q.y - top);
      });
    }
  }

  function updateBaseButtons() {
    const v = base === 'vec';
    $('#m-base-vec').classList.toggle('secondary', !v);
    $('#m-base-osm').classList.toggle('secondary', v);
  }
  function setBase(b) {
    base = b;
    try { localStorage.setItem('wk_base', b); } catch (e) { /* ignorieren */ }
    updateBaseButtons();
    render();
  }

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
    const useVec = base === 'vec' && !!vec;
    tilesEl.style.display = useVec ? 'none' : '';
    vecEl.style.display = useVec ? '' : 'none';
    if (useVec) drawVec(w, h, z, left, top);
    const b = vec && vec.bounds;
    $('#outside').style.display = (useVec && b && (view.lat < b[0] - 0.004 || view.lat > b[2] + 0.004 || view.lng < b[1] - 0.006 || view.lng > b[3] + 0.006)) ? 'block' : 'none';

    // Kacheln
    const needed = new Set();
    const x0 = Math.floor(left / TILE), x1 = Math.floor((left + w) / TILE);
    const y0 = Math.floor(top / TILE), y1 = Math.floor((top + h) / TILE);
    for (let y = y0; !useVec && y <= y1; y++) {
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
    const near = mode === 'einsatz' ? nearest() : [];
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
    else if (!einsatz) h.textContent = 'Adresse eingeben oder die Karte antippen, um den Einsatzort zu setzen.';
    else h.textContent = '';
  }

  function updateResult() {
    const box = $('#result');
    box.textContent = '';
    updateHint();
    if (mode === 'einsatz' && qActive()) { renderSuggestions(qText()); return; }

    if (mode === 'neu') {
      const head = document.createElement('div');
      head.className = 'res-head';
      const lbl = document.createElement('span');
      lbl.textContent = stellen.length + ' Entnahmestelle(n) eingetragen – zum Bearbeiten antippen';
      head.appendChild(lbl);
      box.appendChild(head);
      const order = Object.keys(TYPEN);
      const sorted = stellen.slice().sort((a, b) => (order.indexOf(a.typ) - order.indexOf(b.typ)) || (a.name || '').localeCompare(b.name || '', 'de'));
      const ol = document.createElement('ol');
      ol.className = 'list';
      sorted.forEach((s) => {
        const t = TYPEN[s.typ] || TYPEN.sonst;
        const li = document.createElement('li');
        const badge = document.createElement('div');
        badge.className = 'r-rank';
        badge.style.background = t.color; badge.style.color = '#fff';
        badge.textContent = t.short;
        const info = document.createElement('div');
        info.className = 'r-info';
        const b = document.createElement('b');
        b.textContent = s.name || t.label;
        info.appendChild(b);
        if (s.name) { const sm = document.createElement('small'); sm.textContent = t.label; info.appendChild(sm); }
        if (s.bem) { const bm = document.createElement('div'); bm.className = 'r-bem'; bm.textContent = s.bem; info.appendChild(bm); }
        li.append(badge, info);
        li.onclick = () => { setView(s.lat, s.lng, Math.max(view.z, 18)); openStelleDialog(s, null); };
        ol.appendChild(li);
      });
      box.appendChild(ol);
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
    lbl.textContent = 'Nächste Stellen ab ' + (einsatzLabel || 'Einsatzort (Karte)');
    const sub = document.createElement('small');
    sub.style.display = 'block';
    sub.textContent = 'Luftlinie · zum Korrigieren Karte antippen';
    lbl.appendChild(sub);
    const x = document.createElement('button');
    x.textContent = '✕'; x.setAttribute('aria-label', 'Einsatzort löschen');
    x.onclick = () => { einsatz = null; einsatzLabel = null; extra = 0; refresh(); };
    head.append(lbl, x);
    box.appendChild(head);

    const near = nearest();
    if (!near.length) {
      const p = document.createElement('div');
      p.className = 'empty';
      p.textContent = 'Noch keine Entnahmestellen eingetragen. Im Menü (☰) den Pflegemodus starten.';
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
      info.appendChild(b);
      if (r.s.name) {
        const sm = document.createElement('small');
        sm.textContent = t.label;
        info.appendChild(sm);
      }
      if (r.s.bem) {
        const bm = document.createElement('div');
        bm.className = 'r-bem';
        bm.textContent = r.s.bem;
        info.appendChild(bm);
      }
      const dist = document.createElement('div'); dist.className = 'r-dist';
      dist.textContent = fmtDist(r.d);
      const dir = document.createElement('small'); dir.textContent = dirName(r.b);
      dist.appendChild(dir);
      li.append(rank, info, dist);
      li.onclick = () => setView(r.s.lat, r.s.lng, Math.max(view.z, 17));
      ol.appendChild(li);
    });
    box.appendChild(ol);
    if (stellen.length > near.length) {
      const btn = document.createElement('button');
      btn.className = 'online-btn';
      btn.textContent = 'Weitere Wasserentnahmestellen anzeigen';
      btn.onclick = () => {
        extra++;
        fitView([einsatz].concat(nearest().map((r) => r.s)));
        refresh();
      };
      box.appendChild(btn);
    }
  }

  function refresh() {
    updateResult();
    render();
  }

  // ---------- Modus ----------
  function setMode(m) {
    mode = m;
    document.body.classList.toggle('pflege', m === 'neu');
    $('#search').style.display = m === 'einsatz' ? 'flex' : 'none';
    $('#pflege').style.display = m === 'neu' ? 'block' : 'none';
    refresh();
  }
  $('#p-done').onclick = () => setMode('einsatz');
  $('#p-gps').onclick = () => locate((p) => {
    gps = p;
    setView(p.lat, p.lng, Math.max(view.z, 18));
    openStelleDialog(null, p);
  });

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
    if (hit && mode === 'neu') { openStelleDialog(hit, null); return; }

    const ll = pixelToLatLng(px, py);
    if (mode === 'neu') openStelleDialog(null, ll);
    else { einsatz = { lat: ll.lat, lng: ll.lng }; einsatzLabel = null; extra = 0; clearQ(); refresh(); }
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
  const typBtns = $('#f-typ-btns');
  function setTyp(k) {
    fTyp.value = k;
    [...typBtns.children].forEach((b) => b.classList.toggle('on', b.dataset.k === k));
  }
  Object.entries(TYPEN).forEach(([k, t]) => {
    const o = document.createElement('option');
    o.value = k; o.textContent = t.label;
    fTyp.appendChild(o);
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.k = k; b.textContent = t.label;
    b.onclick = () => setTyp(k);
    typBtns.appendChild(b);
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
    setTyp(stelle ? (stelle.typ || 'sonst') : (TYPEN[lastTyp] ? lastTyp : 'unterflur'));
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
    lastTyp = fTyp.value;
    try { localStorage.setItem('wk_last_typ', lastTyp); } catch (e) { /* ignorieren */ }
    const data = {
      name: $('#f-name').value.trim(),
      typ: fTyp.value,
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
  function infoText() {
    let t = `${stellen.length} Entnahmestelle(n) auf diesem Gerät gespeichert.`;
    try {
      const st = localStorage.getItem(KEY_STAND);
      if (st) t += ' Stand der Daten: ' + new Date(st).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' }) + '.';
    } catch (e) { /* ignorieren */ }
    return t;
  }
  $('#btn-menu').onclick = () => {
    $('#m-info').textContent = infoText();
    $('#m-msg').textContent = '';
    $('#m-progress').textContent = '';
    updateBaseButtons();
    dm.showModal();
  };
  $('#m-close').onclick = () => dm.close();
  $('#m-pflege').onclick = () => { dm.close(); setMode('neu'); };
  $('#m-base-vec').onclick = () => setBase('vec');
  $('#m-base-osm').onclick = () => setBase('osm');
  $('#m-home').onclick = () => { homeView(); dm.close(); };

  $('#m-clear').onclick = () => {
    if (!stellen.length) return;
    if (!confirm('ALLE Entnahmestellen auf diesem Gerät löschen? Das kann nicht rückgängig gemacht werden.')) return;
    stellen = [];
    saveStellen();
    $('#m-info').textContent = infoText();
    refresh();
  };

  $('#m-export').onclick = async () => {
    const stand = new Date().toISOString();
    const payload = { app: 'wasserkarte', version: 1, stand, stellen };
    const name = 'stellen.json';
    const markExported = () => {
      try { localStorage.setItem(KEY_STAND, stand); localStorage.removeItem(KEY_DIRTY); } catch (e) { /* ignorieren */ }
      dirty = false;
      $('#m-info').textContent = infoText();
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    try {
      const file = new File([blob], name, { type: 'application/json' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: name });
        markExported();
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
    markExported();
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
        normStelle(s);
        const ex = stellen.find((x) => x.id === s.id);
        if (!ex) { stellen.push(s); added++; }
        else if ((s.ts || 0) > (ex.ts || 0)) { Object.assign(ex, s); updated++; }
      });
      saveStellen();
      refresh();
      $('#m-info').textContent = infoText();
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
    const build = (zmax) => {
      const out = [];
      for (let z = 15; z <= zmax; z++) {
        const n = Math.pow(2, z);
        const a = project(tl.lat, tl.lng, z), b = project(br.lat, br.lng, z);
        const xa = Math.floor(a.x / TILE), xb = Math.floor(b.x / TILE);
        const ya = Math.floor(a.y / TILE), yb = Math.floor(b.y / TILE);
        for (let y = Math.max(0, ya); y <= Math.min(n - 1, yb); y++)
          for (let x = Math.max(0, xa); x <= Math.min(n - 1, xb); x++) out.push([z, x, y]);
      }
      return out;
    };
    let zmax = 18, jobs = build(zmax);
    while (jobs.length > MAX_TILES && zmax > 15) { zmax--; jobs = build(zmax); }
    if (jobs.length > MAX_TILES) {
      alert(`Der Ausschnitt ist zu groß (${jobs.length} Kacheln). Bitte etwas hineinzoomen und erneut versuchen.`);
      return;
    }
    const note = zmax < 18 ? `\n\nDer Ausschnitt ist groß, deshalb wird nur bis Zoomstufe ${zmax} gespeichert (weniger Detail beim Hineinzoomen).` : '';
    if (!confirm(`${jobs.length} Kartenkacheln (ca. ${Math.max(1, Math.round(jobs.length * 0.02))} MB) auf diesem Gerät speichern?${note}`)) return;

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

  // Ausschnitt so wählen, dass Einsatzort und nächste Stellen sichtbar sind
  function fitView(points) {
    const w = mapEl.clientWidth, h = mapEl.clientHeight;
    if (!w || !h || !points.length) return;
    let z = 18, box = null;
    for (; z >= MINZ; z--) {
      const px = points.map((p) => project(p.lat, p.lng, z));
      const xs = px.map((q) => q.x), ys = px.map((q) => q.y);
      box = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
      if (box.x1 - box.x0 <= w - 110 && box.y1 - box.y0 <= h - 130) break;
    }
    z = Math.max(z, MINZ);
    const mid = unproject((box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2, z);
    setView(mid.lat, mid.lng, z);
  }

  // ---------- Adresssuche ----------
  function normText(t) {
    return String(t || '').toLowerCase().replace(/ß/g, 'ss').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/[^a-z0-9]/g, '');
  }
  const normStreet = (t) => normText(t).replace(/strasse$/, 'str');

  fetch('addresses.json')
    .then((r) => (r.ok ? r.json() : []))
    .then((a) => {
      if (!Array.isArray(a)) return;
      adressen = a.filter((x) => x && x.s && isFinite(x.lat) && isFinite(x.lng));
      adressen.forEach((x) => { x._s = normStreet(x.s); x._n = normText(x.n); });
    })
    .catch(() => { /* ohne Adressliste nur Online-Suche / Kartentipp */ });

  // final = true: Nutzer hat „Suchen“ gedrückt (nicht nur getippt)
  function searchLocal(q, final) {
    const m = q.trim().match(/^(.*?)[\s,]*(\d+\s*[a-zA-Z]?)?$/);
    const st = normStreet(m ? m[1] : q);
    const nr = normText(m && m[2] ? m[2] : '');
    if (st.length < 2) return { items: [], approx: false };
    const inStreet = adressen.filter((a) => a._s.includes(st));
    const items = inStreet
      .filter((a) => !nr || a._n.startsWith(nr))
      .sort((a, b) => ((b._n === nr) - (a._n === nr)) || a._s.localeCompare(b._s) || ((parseInt(a.n, 10) || 0) - (parseInt(b.n, 10) || 0)));
    const exact = items.filter((a) => a._n === nr);
    if (!final || !nr || exact.length) return { items: items.slice(0, 8), approx: false, noStreet: !inStreet.length };
    // Hausnummer nicht in den Daten: nächstgelegene Nummern derselben Straße anbieten
    const want = parseInt(nr, 10);
    if (!isFinite(want) || !inStreet.length) return { items: [], approx: false, noStreet: !inStreet.length };
    const near = inStreet
      .map((a) => ({ a, v: parseInt(a.n, 10) }))
      .filter((x) => isFinite(x.v))
      .sort((x, y) => ((x.v % 2 !== want % 2) - (y.v % 2 !== want % 2)) || (Math.abs(x.v - want) - Math.abs(y.v - want)))
      .slice(0, 4)
      .map((x) => x.a);
    return { items: near, approx: true };
  }
  const labelOf = (a) => `${a.s} ${a.n || ''}`.trim();

  function showPicks(items, emptyMsg, extraBtn) {
    const box = $('#result');
    box.textContent = '';
    if (items.length) {
      const ol = document.createElement('ol');
      ol.className = 'list';
      items.forEach((it) => {
        const li = document.createElement('li');
        const info = document.createElement('div');
        info.className = 'r-info';
        const b = document.createElement('b');
        b.textContent = it.label;
        info.appendChild(b);
        if (it.sub) {
          const sm = document.createElement('small');
          sm.textContent = it.sub;
          info.appendChild(sm);
        }
        li.appendChild(info);
        li.onclick = () => pickAddress(it);
        ol.appendChild(li);
      });
      box.appendChild(ol);
    } else if (emptyMsg) {
      const p = document.createElement('div');
      p.className = 'empty';
      p.textContent = emptyMsg;
      box.appendChild(p);
    }
    if (extraBtn) box.appendChild(extraBtn);
  }

  function renderSuggestions(q, final) {
    const res = searchLocal(q, final);
    const items = res.items.map((a) => ({ label: labelOf(a) + (res.approx ? ' (ungefähr)' : ''), sub: ORT, lat: a.lat, lng: a.lng }));
    let btn = null;
    if (navigator.onLine) {
      btn = document.createElement('button');
      btn.className = 'online-btn';
      btn.textContent = 'Online suchen (OpenStreetMap)';
      btn.onclick = () => onlineSearch(q);
    }
    const empty = adressen.length
      ? (res.noStreet ? 'Für diese Straße sind keine Hausnummern gespeichert. Bitte die Karte antippen.' : 'Keine passende Adresse gespeichert.')
      : 'Adressliste ist noch nicht in der App hinterlegt.' + (navigator.onLine ? '' : ' Offline bitte die Karte antippen.');
    showPicks(items, empty, btn);
    if (res.approx) {
      const note = document.createElement('div');
      note.className = 'empty';
      note.textContent = 'Diese Hausnummer ist in den Daten nicht vorhanden. Nächstgelegene Nummern – danach den Einsatzort bei Bedarf per Tipp auf die Karte korrigieren:';
      $('#result').insertBefore(note, $('#result').firstChild);
    }
  }

  async function onlineSearch(q) {
    showPicks([], 'Suche …');
    try {
      const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&countrycodes=de&accept-language=de&q=' + encodeURIComponent(q + ', ' + ORT);
      const res = await fetch(url);
      const j = await res.json();
      const items = (Array.isArray(j) ? j : [])
        .map((r) => ({ label: String(r.display_name || '').split(',').slice(0, 3).join(',').trim(), sub: 'OpenStreetMap', lat: parseFloat(r.lat), lng: parseFloat(r.lon) }))
        .filter((r) => isFinite(r.lat) && isFinite(r.lng));
      showPicks(items, 'Nichts gefunden. Bitte Schreibweise prüfen oder die Karte antippen.');
    } catch (e) {
      showPicks([], 'Online-Suche nicht möglich. Bitte die Karte antippen.');
    }
  }

  // ---------- Straße (Dropdown) + Hausnummer ----------
  const STRASSEN = ['Adolphsdorfer Straße', 'Ottersteiner Straße', 'Tüschendorfer Straße', 'Neu-Bergedorfer Damm', 'Hasenweg'];
  const selStreet = $('#q-street');
  STRASSEN.concat(['__other__']).forEach((n) => {
    const o = document.createElement('option');
    o.value = n;
    o.textContent = n === '__other__' ? 'Andere Straße …' : n;
    selStreet.appendChild(o);
  });
  const isOther = () => selStreet.value === '__other__';
  const streetName = () => (isOther() ? $('#q-other').value.trim() : selStreet.value);
  const qNr = () => $('#q-nr').value.trim();
  const qActive = () => qNr() !== '' || (isOther() && streetName().length >= 2);
  const qText = () => (streetName() + ' ' + qNr()).trim();
  function clearQ() { $('#q-nr').value = ''; $('#q-other').value = ''; }

  // Karte auf die ganze Straße zoomen (damit man z. B. Straßen ohne Hausnummern per Tipp setzen kann)
  function fitStreet(name) {
    if (!vec || !name) return;
    const key = normStreet(name);
    const lats = [], lngs = [];
    vec.roads.forEach((f) => {
      if (f.n && normStreet(f.n) === key) for (let i = 0; i < f.a.length; i += 2) { lats.push(f.a[i]); lngs.push(f.a[i + 1]); }
    });
    if (!lats.length) return;
    fitView([
      { lat: Math.min(...lats), lng: Math.min(...lngs) },
      { lat: Math.max(...lats), lng: Math.max(...lngs) }
    ]);
  }

  function pickAddress(it) {
    einsatz = { lat: it.lat, lng: it.lng };
    einsatzLabel = it.label;
    extra = 0;
    clearQ();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    fitView([einsatz].concat(nearest().map((r) => r.s)));
    refresh();
  }

  function runSearch() {
    const name = streetName();
    if (name.length < 2) return;
    if (!qNr()) {
      fitStreet(name);
      showPicks([], 'Bitte Hausnummer eingeben – oder die Karte antippen, um den Einsatzort zu setzen.');
      return;
    }
    const q = qText();
    const res = searchLocal(q, true);
    const local = res.items;
    if (res.approx) { renderSuggestions(q, true); return; }
    const nr = normText(qNr());
    const exact = nr ? local.filter((a) => a._n === nr) : [];
    const one = exact.length === 1 ? exact[0] : (local.length === 1 ? local[0] : null);
    if (one) pickAddress({ label: labelOf(one), lat: one.lat, lng: one.lng });
    else if (local.length > 1) renderSuggestions(q, true);
    else if (res.noStreet && STRASSEN.includes(name)) {
      fitStreet(name);
      showPicks([], 'Für ' + name + ' liegen keine Hausnummern in den Daten vor. Die Straße ist eingeblendet – bitte den Einsatzort per Tipp auf die Karte setzen.');
    }
    else if (navigator.onLine) onlineSearch(q);
    else renderSuggestions(q, true);
  }
  $('#q-go').onclick = runSearch;
  ['#q-nr', '#q-other'].forEach((id) => {
    const el = $(id);
    el.addEventListener('input', updateResult);
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } });
  });
  selStreet.addEventListener('change', () => {
    $('#q-other').style.display = isOther() ? '' : 'none';
    $('#q-nr').value = '';
    if (isOther()) $('#q-other').focus(); else fitStreet(streetName());
    updateResult();
  });

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

  // ---------- Grundbestand (stellen.json im Repository) ----------
  async function syncStammdaten() {
    try {
      const r = await fetch('stellen.json', { cache: 'no-cache' });
      if (!r.ok) return;
      const j = await r.json();
      const list = Array.isArray(j) ? j : j.stellen;
      const stand = j && j.stand ? String(j.stand) : '';
      if (!Array.isArray(list) || !stand) return;           // leere Vorlage: nichts tun
      const mine = localStorage.getItem(KEY_STAND) || '';
      if (mine && stand <= mine) return;                    // nur neuere Daten übernehmen
      if (dirty && stellen.length) {
        if (localStorage.getItem(KEY_DECL) === stand) return;
        const datum = new Date(stand).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
        if (!confirm(`Neue Entnahmestellen-Daten verfügbar (Stand ${datum}).\n\nÄnderungen, die nur auf diesem Gerät gespeichert sind, gehen dabei verloren. Jetzt übernehmen?`)) {
          localStorage.setItem(KEY_DECL, stand);
          return;
        }
      }
      stellen = list.filter(validStelle).map(normStelle);
      saveStellen(true);
      localStorage.setItem(KEY_STAND, stand);
      localStorage.removeItem(KEY_DIRTY);
      dirty = false;
      refresh();
    } catch (e) { /* offline oder keine Datei: lokale Daten bleiben */ }
  }

  // ---------- Start ----------
  refresh();
  syncStammdaten();
})();
