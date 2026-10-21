/* Ticket éclair — l'appli : photo → recadrage + scan → PDF → partage. Tout reste dans le téléphone. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const VERSION = '1.1';
  const WORK_SIDE = 2000;      // chaque photo est ramenée à 2000 px de côté max dès l'import (mémoire de Safari)
  const OUT_SIDE = 2000;       // côté max du ticket redressé
  const PDF_DPI = 200;         // taille de page : le ticket à 200 points par pouce
  const JPEG_Q = 0.72;         // ~150-300 Ko par ticket, texte net (vérifié à l'image)
  const STEP_TIMEOUT = 30000;  // une étape qui dépasse 30 s = échec affiché, jamais d'attente infinie

  const state = { tickets: [], cur: -1, pack: 'each', seq: 0 };
  let work = null;             // { t, canvas, data } : la photo décodée du ticket en cours, gardée en mémoire
  let exportCache = null;      // { key, files } : PDF préparés d'avance (iOS exige un partage immédiat après le toucher)

  /* ---------- utilitaires ---------- */
  const pad = n => String(n).padStart(2, '0');
  const dateStr = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hmStr = d => `${pad(d.getHours())}${pad(d.getMinutes())}`;
  const frame = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
  const withTimeout = (p, ms, msg) => { let tm; return Promise.race([p, new Promise((_, rej) => { tm = setTimeout(() => rej(new Error(msg)), ms); })]).finally(() => clearTimeout(tm)); };
  function slug(s) {
    return String(s || '').replace(/['’]/g, '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  }
  function amountStr(a) {
    const v = parseFloat(String(a || '').replace(/[\s€]/g, '').replace(',', '.'));
    return isFinite(v) && v > 0 ? v.toFixed(2).replace('.', ',') : '';
  }
  function baseName(t) {
    const parts = ['ticket', dateStr(t.time)], s = slug(t.shop), a = amountStr(t.amount);
    if (s) parts.push(s);
    if (a) parts.push(a);
    if (!s && !a) parts.push(hmStr(t.time));
    return parts.join('_');
  }
  function uniqueNames(names) {
    const seen = {};
    return names.map(n => { seen[n] = (seen[n] || 0) + 1; return seen[n] > 1 ? `${n}-${seen[n]}` : n; });
  }
  const kb = n => n > 1048576 ? (n / 1048576).toFixed(1).replace('.', ',') + ' Mo' : Math.max(1, Math.round(n / 1024)) + ' Ko';
  function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  const toBlob = (c, type, q) => new Promise(r => c.toBlob(r, type, q));

  /* ---------- décodage de la photo ---------- */
  function loadImage(blob) {
    return new Promise((res, rej) => {
      const url = URL.createObjectURL(blob), img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); res(img); };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('photo illisible ou format non reconnu')); };
      img.src = url;                       // l'orientation EXIF est appliquée par le navigateur
    });
  }
  // décode une photo et la ramène à WORK_SIDE px max ; renvoie le canvas réduit
  async function decodeSmall(blob) {
    const img = await withTimeout(loadImage(blob), STEP_TIMEOUT, 'la photo met trop de temps à s\'ouvrir');
    const W0 = img.naturalWidth, H0 = img.naturalHeight;
    if (!W0 || !H0) throw new Error('photo vide');
    const s = Math.min(1, WORK_SIDE / Math.max(W0, H0));
    const W = Math.round(W0 * s), H = Math.round(H0 * s), c = canvas(W, H);
    c.getContext('2d', { willReadFrequently: true }).drawImage(img, 0, 0, W, H);
    img.src = '';                          // libère tout de suite la photo pleine taille
    return c;
  }
  async function decodeWork(t) {
    if (work && work.t === t) return work;
    work = null;
    const c = await decodeSmall(t.file);   // t.file est déjà la version réduite (JPEG ≤ 2000 px)
    work = { t, canvas: c, data: c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height) };
    t.w = c.width; t.h = c.height;
    return work;
  }

  /* ---------- traitement d'un ticket ---------- */
  // step(label, fraction) : fait avancer l'indicateur de chargement
  async function renderTicket(t, { redetect = false, step = () => {} } = {}) {
    const w = await decodeWork(t);
    if (redetect || !t.quad) {
      step('Détection des bords…', 0.45); await frame();
      const r = TEScan.detect(w.canvas, t.w, t.h);
      t.quad = r.quad; t.detected = r.ok; t.info = r.info; t.autoQuad = r.quad;
    }
    step('Redressement et effet scan…', 0.7); await frame();
    {
      const warped = TEScan.warp(w.data, t.quad, OUT_SIDE);
      const fx = TEScan.enhance(warped, t.mode);
      let c = canvas(fx.width, fx.height); c.getContext('2d').putImageData(fx, 0, 0);
      if (t.rot) {
        const r = canvas(t.rot % 180 ? c.height : c.width, t.rot % 180 ? c.width : c.height), rx = r.getContext('2d');
        rx.translate(r.width / 2, r.height / 2); rx.rotate(t.rot * Math.PI / 180); rx.drawImage(c, -c.width / 2, -c.height / 2);
        c = r;
      }
      const ob = await withTimeout(toBlob(c, 'image/jpeg', JPEG_Q), STEP_TIMEOUT, 'compression trop longue');
      if (!ob) throw new Error('mémoire insuffisante pour ce ticket');
      t.outBlob = ob;
      t.outW = c.width; t.outH = c.height; t.v = (t.v || 0) + 1;
      if (t.url) URL.revokeObjectURL(t.url);
      t.url = URL.createObjectURL(t.outBlob);
    }
  }
  // changement d'effet / rotation / coins : même indicateur, une seule étape
  async function processTicket(t, opts = {}) {
    LD.show('Traitement…', 0, 0, 0.3); await frame();
    try { await renderTicket(t, opts); LD.hide(); }
    catch (e) { LD.fail('Le traitement a échoué : ' + (e.message || e), null); }
    render(); scheduleExport();
  }

  // une photo → un ticket. Le ticket n'entre dans la session que s'il a réussi.
  async function addBlob(blob, i = 1, n = 1) {
    const step = (label, f) => LD.show(label, i, n, f);
    step('Chargement de la photo…', 0.1); await frame();
    const small = await decodeSmall(blob);
    const file = await withTimeout(toBlob(small, 'image/jpeg', 0.9), STEP_TIMEOUT, 'compression trop longue');
    if (!file) throw new Error('mémoire insuffisante pour cette photo');
    const t = {
      id: ++state.seq, file, mode: 'scan', rot: 0, shop: '', amount: '',
      time: new Date(blob.lastModified && Math.abs(Date.now() - blob.lastModified) < 3e10 ? blob.lastModified : Date.now())
    };
    work = { t, canvas: small, data: small.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, small.width, small.height) };
    t.w = small.width; t.h = small.height;
    await renderTicket(t, { redetect: true, step });
    step('Prêt', 1);
    state.tickets.push(t); state.cur = state.tickets.length - 1;
    render();
    return t;
  }

  // import : une photo après l'autre, jamais deux en même temps ; un échec n'arrête pas les suivantes
  const queue = []; let importing = false, failed = [];
  async function importFiles(files) {
    queue.push(...files);
    if (importing) return;
    importing = true; failed = [];
    let k = 0;
    try {
      while (queue.length) {
        const f = queue.shift(); k++;
        const n = k + queue.length;
        try { await addBlob(f, k, n); }
        catch (e) { failed.push({ f, msg: (e && e.message) || String(e) }); if (work && !state.tickets.includes(work.t)) work = null; }
        await frame();
      }
    } finally { importing = false; }
    if (failed.length) {
      const ok = k - failed.length;
      LD.fail(`${failed.length} photo${failed.length > 1 ? 's' : ''} sur ${k} n'${failed.length > 1 ? 'ont' : 'a'} pas pu être traitée${failed.length > 1 ? 's' : ''} (${failed[0].msg}).` + (ok ? ` ${ok} ticket${ok > 1 ? 's' : ''} prêt${ok > 1 ? 's' : ''}.` : ''), failed.map(x => x.f));
    } else LD.hide();
    render(); scheduleExport();
  }

  /* ---------- indicateur de chargement (toujours visible, toujours une sortie) ---------- */
  const LD = {
    show(label, i, n, f) {
      $('loader').hidden = false; $('loader').classList.remove('err');
      $('ldStep').textContent = label;
      $('ldCount').textContent = n > 1 ? `Photo ${i}/${n}` : (n === 1 ? 'Photo 1/1' : '');
      const tot = n > 0 ? ((i - 1) + f) / n : f;
      $('ldBar').style.width = Math.round(Math.max(0.04, Math.min(1, tot)) * 100) + '%';
      $('ldErr').hidden = true;
    },
    hide() { $('loader').hidden = true; },
    fail(msg, retryFiles) {
      $('loader').hidden = false; $('loader').classList.add('err');
      $('ldStep').textContent = 'Échec'; $('ldCount').textContent = '';
      $('ldMsg').textContent = msg; $('ldErr').hidden = false;
      $('ldRetry').hidden = !(retryFiles && retryFiles.length);
      $('ldRetry').onclick = () => importFiles(retryFiles);
    }
  };
  const current = () => state.tickets[state.cur];

  /* ---------- export PDF ---------- */
  function scrubPdf(ab) {
    // retire la signature de l'outil (« jsPDF x.y.z ») sans décaler les octets
    // (latin1 : un octet = un caractère, donc les positions de la chaîne sont celles des octets)
    const u8 = new Uint8Array(ab); let s = '';
    for (let i = 0; i < u8.length; i += 65536) s += String.fromCharCode.apply(null, u8.subarray(i, i + 65536));
    const re = /\/(Producer|Creator) \(([^)]*)\)/g; let m;
    while ((m = re.exec(s))) {
      const start = m.index + m[0].indexOf('(') + 1;
      for (let i = 0; i < m[2].length; i++) u8[start + i] = 0x20;
    }
    return u8;
  }
  async function pdfOf(list, name) {
    const { jsPDF } = window.jspdf;
    let doc = null;
    for (const t of list) {
      const wmm = t.outW / PDF_DPI * 25.4, hmm = t.outH / PDF_DPI * 25.4, o = wmm > hmm ? 'l' : 'p';
      if (!doc) doc = new jsPDF({ orientation: o, unit: 'mm', format: [wmm, hmm], compress: true });
      else doc.addPage([wmm, hmm], o);
      doc.addImage(new Uint8Array(await t.outBlob.arrayBuffer()), 'JPEG', 0, 0, wmm, hmm, undefined, 'NONE');
    }
    doc.setProperties({ title: name.replace(/\.pdf$/, ''), subject: 'Justificatif', author: '', keywords: '', creator: '' });
    return new File([scrubPdf(doc.output('arraybuffer'))], name, { type: 'application/pdf' });
  }
  function exportKey() { return state.pack + '|' + state.tickets.map(t => t.id + ':' + t.v + ':' + baseName(t)).join(','); }
  async function buildExport() {
    const key = exportKey();
    if (exportCache && exportCache.key === key) return exportCache.files;
    const ready = state.tickets.filter(t => t.outBlob);
    if (!ready.length) return [];
    let files;
    if (state.pack === 'one' && ready.length > 1) {
      const d = ready[0].time;
      files = [await pdfOf(ready, `tickets_${dateStr(d)}_${hmStr(d)}_${ready.length}p.pdf`)];
    } else {
      const names = uniqueNames(ready.map(baseName));
      files = [];
      for (let i = 0; i < ready.length; i++) files.push(await pdfOf([ready[i]], names[i] + '.pdf'));
    }
    exportCache = { key, files };
    return files;
  }
  let exportTimer = 0, warnedKey = '';
  function scheduleExport() {
    clearTimeout(exportTimer);
    if (importing) return;                 // pas de PDF pendant un import : chaque photo d'abord
    exportTimer = setTimeout(() => { if (window.jspdf) buildExport().then(renderExportMsg).catch(() => {}); }, 400);
  }

  async function shareFiles(files, title) {
    if (navigator.canShare && navigator.share && navigator.canShare({ files })) {
      try { await navigator.share({ files, title }); return 'ok'; }
      catch (e) {
        if (e && e.name === 'AbortError') return 'abort';
        if (e && e.name === 'NotAllowedError') return 'again';
        throw e;
      }
    }
    for (const f of files) {                  // repli : téléchargement
      const a = document.createElement('a'); a.href = URL.createObjectURL(f); a.download = f.name;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }
    return 'download';
  }
  const shareMsg = { ok: 'Partagé.', abort: 'Partage annulé.', again: 'PDF prêt : touchez encore « Partager ».', download: 'Téléchargé (partage indisponible sur ce navigateur).' };

  /* ---------- file « à envoyer plus tard » (IndexedDB, dans le téléphone) ---------- */
  const DB = {
    open() {
      if (this.p) return this.p;
      return (this.p = new Promise((res, rej) => {
        const r = indexedDB.open('ticket-eclair', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('later', { keyPath: 'id' });
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      }));
    },
    async tx(mode, fn) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const tx = db.transaction('later', mode), st = tx.objectStore('later'); let out;
        const r = fn(st); if (r) r.onsuccess = () => { out = r.result; };
        tx.oncomplete = () => res(out); tx.onerror = () => rej(tx.error);
      });
    },
    put(o) { return this.tx('readwrite', st => st.put(o)); },
    del(id) { return this.tx('readwrite', st => st.delete(id)); },
    all() { return this.tx('readonly', st => st.getAll()); }
  };
  async function saveLater(files) {
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* facultatif */ }
    for (const f of files) {
      await DB.put({ id: Date.now() + '-' + Math.random().toString(36).slice(2, 7), name: f.name, type: f.type, data: await f.arrayBuffer(), created: Date.now() });
    }
    await renderQueue();
  }
  async function renderQueue() {
    let items = [];
    try { items = (await DB.all()) || []; } catch (e) { $('queue').hidden = true; return; }
    items.sort((a, b) => a.created - b.created);
    $('queue').hidden = !items.length;
    $('queueCount').textContent = items.length ? `${items.length} fichier${items.length > 1 ? 's' : ''}` : '';
    const ul = $('queueList'); ul.textContent = '';
    for (const it of items) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="q-name"></span><span class="q-meta mono dim"></span><button class="ghost sm" data-act="share">Partager</button><button class="link danger" data-act="del" aria-label="Supprimer">✕</button>`;
      li.querySelector('.q-name').textContent = it.name;
      li.querySelector('.q-meta').textContent = kb(it.data.byteLength) + ' · gardé le ' + new Date(it.created).toLocaleDateString('fr-FR');
      li.querySelector('[data-act=share]').onclick = async () => {
        const r = await shareFiles([new File([it.data], it.name, { type: it.type })], it.name);
        if (r === 'ok' && confirm('Envoyé. Le retirer de la liste ?')) { await DB.del(it.id); renderQueue(); }
      };
      li.querySelector('[data-act=del]').onclick = async () => { if (confirm('Supprimer ' + it.name + ' ?')) { await DB.del(it.id); renderQueue(); } };
      ul.appendChild(li);
    }
    if (items.length > 1) {
      const li = document.createElement('li'); li.className = 'q-all';
      const b = document.createElement('button'); b.className = 'ghost'; b.textContent = 'Tout partager';
      b.onclick = () => shareFiles(items.map(it => new File([it.data], it.name, { type: it.type })), 'Tickets');
      li.appendChild(b); ul.appendChild(li);
    }
  }

  /* ---------- affichage ---------- */
  function render() {
    const has = state.tickets.length > 0, t = current();
    $('empty').hidden = has; $('current').hidden = !t; $('tray').hidden = !has; $('export').hidden = !has;
    $('shootTxt').textContent = has ? 'Ticket suivant' : 'Photo du ticket';
    if (t) {
      $('curLabel').textContent = `Ticket ${state.cur + 1} / ${state.tickets.length}`;
      $('curInfo').textContent = t.info ? (t.detected ? '✓ ' : '⚠ ') + t.info : '';
      $('curInfo').classList.toggle('warn', t.detected === false);
      if (t.url && $('curImg').src !== t.url) $('curImg').src = t.url;
      $('modeChips').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.mode === t.mode));
      if (document.activeElement !== $('fShop')) $('fShop').value = t.shop;
      if (document.activeElement !== $('fAmount')) $('fAmount').value = t.amount;
      $('curName').textContent = baseName(t) + '.pdf';
      $('fAmount').classList.toggle('need', !amountStr(t.amount));
    }
    $('trayCount').textContent = has ? `${state.tickets.length} ticket${state.tickets.length > 1 ? 's' : ''}` : '';
    const th = $('thumbs'); th.textContent = '';
    state.tickets.forEach((tk, i) => {
      const b = document.createElement('button'); b.className = 'thumb' + (i === state.cur ? ' on' : '');
      b.setAttribute('aria-label', 'Ticket ' + (i + 1));
      if (tk.url) { const im = document.createElement('img'); im.src = tk.url; im.alt = ''; b.appendChild(im); }
      const n = document.createElement('span'); n.className = 'mono'; n.textContent = i + 1; b.appendChild(n);
      b.onclick = () => { state.cur = i; render(); };
      th.appendChild(b);
    });
    document.querySelectorAll('[data-pack]').forEach(b => b.classList.toggle('on', b.dataset.pack === state.pack));
    $('btnShare').firstChild.textContent = state.pack === 'one' && state.tickets.length > 1 ? 'Partager le PDF unique ' : (state.tickets.length > 1 ? 'Partager les PDF ' : 'Partager le PDF ');
  }
  function renderExportMsg() {
    if (!exportCache || $('exportMsg').classList.contains('warn')) return;   // ne pas effacer l'alerte « montant vide »
    const tot = exportCache.files.reduce((s, f) => s + f.size, 0);
    $('exportMsg').textContent = exportCache.files.length === 1 ? `${exportCache.files[0].name} · ${kb(tot)}` : `${exportCache.files.length} PDF prêts · ${kb(tot)}`;
  }

  /* ---------- éditeur de coins ---------- */
  const ED = { t: null, q: null, scale: 1, ox: 0, oy: 0, drag: -1 };
  async function openEditor() {
    const t = current(); if (!t) return;
    const w = await decodeWork(t);
    ED.t = t; ED.q = t.quad.map(p => p.slice());
    $('editor').hidden = false; document.body.classList.add('noscroll');
    await frame(); layoutEditor(w);
  }
  function layoutEditor(w) {
    const st = $('edStage'), r = st.getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    const s = Math.min(r.width / ED.t.w, r.height / ED.t.h);
    ED.scale = s; ED.ox = (r.width - ED.t.w * s) / 2; ED.oy = (r.height - ED.t.h * s) / 2;
    const c = $('edCanvas'); c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr);
    c.style.width = r.width + 'px'; c.style.height = r.height + 'px';
    const cx = c.getContext('2d'); cx.setTransform(dpr, 0, 0, dpr, 0, 0); cx.clearRect(0, 0, r.width, r.height);
    cx.drawImage(w.canvas, ED.ox, ED.oy, ED.t.w * s, ED.t.h * s);
    $('edSvg').setAttribute('viewBox', `0 0 ${r.width} ${r.height}`);
    drawQuad();
  }
  const toScreen = p => [ED.ox + p[0] * ED.scale, ED.oy + p[1] * ED.scale];
  function drawQuad() {
    const pts = ED.q.map(toScreen);
    $('edSvg').innerHTML = `<polygon points="${pts.map(p => p.join(',')).join(' ')}" class="ed-poly"/>` +
      pts.map((p, i) => `<circle cx="${p[0]}" cy="${p[1]}" r="15" class="ed-h${i === ED.drag ? ' on' : ''}"/>`).join('');
    $('edInfo').textContent = ED.t.detected === false && ED.q === ED.t.autoQuad ? 'détection incertaine' : '';
  }
  function loupe(p) {
    const l = $('edLoupe'), lx = l.getContext('2d'), z = 2.5, src = work && work.canvas;
    if (!src) return;
    l.hidden = false;
    const sz = 120 / z / ED.scale * (1 / 1);
    lx.fillStyle = '#000'; lx.fillRect(0, 0, 120, 120);
    lx.drawImage(src, p[0] - sz / 2, p[1] - sz / 2, sz, sz, 0, 0, 120, 120);
    lx.strokeStyle = '#e8ff2a'; lx.lineWidth = 1; lx.beginPath(); lx.moveTo(60, 48); lx.lineTo(60, 72); lx.moveTo(48, 60); lx.lineTo(72, 60); lx.stroke();
    const sp = toScreen(p), stw = $('edStage').clientWidth;
    l.style.left = (sp[0] < stw / 2 ? stw - 132 : 12) + 'px';
  }
  function edPoint(e) {
    const r = $('edStage').getBoundingClientRect();
    return [(e.clientX - r.left - ED.ox) / ED.scale, (e.clientY - r.top - ED.oy) / ED.scale];
  }
  function bindEditor() {
    const st = $('edStage');
    st.addEventListener('pointerdown', e => {
      const p = edPoint(e); let best = -1, bd = 48 / ED.scale;
      ED.q.forEach((q, i) => { const d = Math.hypot(q[0] - p[0], q[1] - p[1]); if (d < bd) { bd = d; best = i; } });
      if (best < 0) return;
      ED.drag = best; st.setPointerCapture(e.pointerId); e.preventDefault(); drawQuad(); loupe(ED.q[best]);
    });
    st.addEventListener('pointermove', e => {
      if (ED.drag < 0) return;
      const p = edPoint(e);
      ED.q[ED.drag] = [Math.max(0, Math.min(ED.t.w, p[0])), Math.max(0, Math.min(ED.t.h, p[1]))];
      drawQuad(); loupe(ED.q[ED.drag]);
    });
    const end = () => { ED.drag = -1; $('edLoupe').hidden = true; drawQuad(); };
    st.addEventListener('pointerup', end); st.addEventListener('pointercancel', end);
    $('edCancel').onclick = closeEditor;
    $('edAuto').onclick = () => { ED.q = ED.t.autoQuad.map(p => p.slice()); drawQuad(); };
    $('edFull').onclick = () => { ED.q = [[0, 0], [ED.t.w, 0], [ED.t.w, ED.t.h], [0, ED.t.h]]; drawQuad(); };
    $('edOk').onclick = async () => {
      const t = ED.t; t.quad = TEScan.orderQuad(ED.q); t.detected = true; t.info = 'coins ajustés à la main';
      closeEditor(); await processTicket(t);
    };
    window.addEventListener('resize', () => { if (!$('editor').hidden && work) layoutEditor(work); });
  }
  function closeEditor() { $('editor').hidden = true; document.body.classList.remove('noscroll'); }

  /* ---------- branchements ---------- */
  function bind() {
    $('btnShoot').onclick = () => $('inCamera').click();
    $('btnImport').onclick = () => $('inLibrary').click();
    const onFiles = e => {
      let files = [];
      try { files = Array.from(e.target.files || []); } catch (err) { /* liste illisible */ }
      e.target.value = '';                 // on peut re-choisir les mêmes photos ensuite
      if (!files.length) return;
      importFiles(files);
    };
    $('ldClose').onclick = () => LD.hide();
    $('ldAgain').onclick = () => { LD.hide(); $('inLibrary').click(); };
    $('inCamera').onchange = onFiles; $('inLibrary').onchange = onFiles;
    $('modeChips').onclick = e => {
      const b = e.target.closest('button'), t = current(); if (!b || !t || t.mode === b.dataset.mode) return;
      t.mode = b.dataset.mode; processTicket(t);
    };
    $('btnRotate').onclick = () => { const t = current(); if (t) { t.rot = (t.rot + 90) % 360; processTicket(t); } };
    $('btnCorners').onclick = openEditor;
    $('btnDelete').onclick = () => {
      const t = current(); if (!t) return;
      if (t.url) URL.revokeObjectURL(t.url);
      state.tickets.splice(state.cur, 1); if (work && work.t === t) work = null;
      state.cur = Math.min(state.cur, state.tickets.length - 1); render(); scheduleExport();
    };
    const field = (id, key) => $(id).addEventListener('input', e => {
      const t = current(); if (!t) return;
      t[key] = e.target.value; $('curName').textContent = baseName(t) + '.pdf';
      $('fAmount').classList.toggle('need', !amountStr(t.amount));
      $('exportMsg').classList.remove('warn'); scheduleExport();
    });
    field('fShop', 'shop'); field('fAmount', 'amount');
    document.querySelectorAll('[data-pack]').forEach(b => b.onclick = () => { state.pack = b.dataset.pack; render(); scheduleExport(); });
    // montant fortement conseillé : 1er toucher = avertissement, 2e toucher = on part quand même
    const amountWarning = () => {
      const miss = state.tickets.map((t, i) => [t, i]).filter(([t]) => t.outBlob && !amountStr(t.amount));
      if (!miss.length || warnedKey === exportKey()) return false;
      warnedKey = exportKey();
      state.cur = miss[0][1]; render();
      $('exportMsg').textContent = `⚠ Montant vide sur ${miss.length} ticket${miss.length > 1 ? 's' : ''} : tapez-le, il va dans le nom du fichier. Ou touchez encore pour continuer sans.`;
      $('exportMsg').classList.add('warn');
      $('fAmount').scrollIntoView({ block: 'center' });
      return true;
    };
    $('btnShare').onclick = async () => {
      if (amountWarning()) return;
      $('exportMsg').classList.remove('warn');
      const ready = exportCache && exportCache.key === exportKey();
      try {
        const files = ready ? exportCache.files : await buildExport();
        $('exportMsg').textContent = shareMsg[await shareFiles(files, files.length === 1 ? files[0].name : 'Tickets')];
      } catch (e) { $('exportMsg').textContent = 'Échec du partage : ' + e.message; }
    };
    $('btnLater').onclick = async () => {
      if (amountWarning()) return;
      $('exportMsg').classList.remove('warn');
      try {
        const files = await buildExport(); await saveLater(files);
        $('exportMsg').textContent = `${files.length} PDF gardé${files.length > 1 ? 's' : ''} dans le téléphone (liste en bas).`;
      } catch (e) { $('exportMsg').textContent = 'Impossible de garder : ' + e.message; }
    };
    $('btnPhotos').onclick = async () => {
      const ready = state.tickets.filter(t => t.outBlob), names = uniqueNames(ready.map(baseName));
      const imgs = ready.map((t, i) => new File([t.outBlob], names[i] + '.jpg', { type: 'image/jpeg' }));
      try { $('exportMsg').textContent = shareMsg[await shareFiles(imgs, 'Tickets')]; } catch (e) { $('exportMsg').textContent = e.message; }
    };
    bindEditor();
  }

  bind(); render(); renderQueue();
  window.addEventListener('load', () => scheduleExport());
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
  // accès pour les tests automatiques (lecture seule de l'état, mêmes fonctions que les boutons)
  window.TE = { VERSION, state, addBlob, importFiles, buildExport, processTicket, baseName, render, DB, saveLater, renderQueue };
})();
