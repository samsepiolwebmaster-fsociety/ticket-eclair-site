/* Ticket éclair — moteur de scan.
   Détection des bords du ticket, redressement de la perspective, effet scan.
   Aucune dépendance (pas d'OpenCV : ~8 Mo de moins à charger sur le téléphone). */
(function (root) {
  'use strict';

  const DETECT_SIDE = 400;   // la détection travaille sur une image réduite
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  /* ---------- outils image ---------- */
  function grayOf(d, n) {
    const g = new Uint8ClampedArray(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
    return g;
  }

  function boxBlur(src, w, h, r) {
    const tmp = new Float32Array(w * h), out = new Uint8ClampedArray(w * h), k = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      const row = y * w; let acc = 0;
      for (let x = -r; x <= r; x++) acc += src[row + clamp(x, 0, w - 1)];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc / k;
        acc += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[clamp(y, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = acc / k;
        acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
      }
    }
    return out;
  }

  function otsu(g) {
    const hist = new Float64Array(256);
    for (let i = 0; i < g.length; i++) hist[g[i]]++;
    let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t];
    let sumB = 0, wB = 0, best = -1, thr = 127;
    for (let t = 0; t < 256; t++) {
      wB += hist[t]; if (!wB) continue;
      const wF = g.length - wB; if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; thr = t; }
    }
    return thr;
  }

  // érosion / dilatation carrée, séparable
  function morph(m, w, h, r, erode) {
    const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = erode ? 1 : 0;
      for (let k = -r; k <= r; k++) {
        const p = m[y * w + clamp(x + k, 0, w - 1)];
        if (erode ? !p : p) { v = erode ? 0 : 1; break; }
      }
      tmp[y * w + x] = v;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = erode ? 1 : 0;
      for (let k = -r; k <= r; k++) {
        const p = tmp[clamp(y + k, 0, h - 1) * w + x];
        if (erode ? !p : p) { v = erode ? 0 : 1; break; }
      }
      out[y * w + x] = v;
    }
    return out;
  }

  // plus grande composante connexe (4-voisinage)
  function largestComponent(m, w, h) {
    const lab = new Int32Array(w * h), stack = new Int32Array(w * h);
    let best = 0, bestSize = 0, cur = 0;
    for (let i = 0; i < w * h; i++) {
      if (!m[i] || lab[i]) continue;
      cur++; let sp = 0, size = 0; stack[sp++] = i; lab[i] = cur;
      while (sp) {
        const p = stack[--sp]; size++;
        const x = p % w, y = (p - x) / w;
        if (x > 0 && m[p - 1] && !lab[p - 1]) { lab[p - 1] = cur; stack[sp++] = p - 1; }
        if (x < w - 1 && m[p + 1] && !lab[p + 1]) { lab[p + 1] = cur; stack[sp++] = p + 1; }
        if (y > 0 && m[p - w] && !lab[p - w]) { lab[p - w] = cur; stack[sp++] = p - w; }
        if (y < h - 1 && m[p + w] && !lab[p + w]) { lab[p + w] = cur; stack[sp++] = p + w; }
      }
      if (size > bestSize) { bestSize = size; best = cur; }
    }
    const out = new Uint8Array(w * h);
    if (best) for (let i = 0; i < w * h; i++) out[i] = lab[i] === best ? 1 : 0;
    return { mask: out, size: bestSize };
  }

  /* ---------- géométrie ---------- */
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  function polyArea(p) {
    let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a[0] * b[1] - b[0] * a[1]; }
    return s / 2;
  }
  function hull(pts) {
    pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (pts.length < 3) return pts;
    const lo = [], up = [];
    for (const p of pts) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); }
    for (let i = pts.length - 1; i >= 0; i--) { const p = pts[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); }
    up.pop(); lo.pop(); return lo.concat(up);
  }
  // le plus grand quadrilatère inscrit dans l'enveloppe (force brute, n ≤ 48)
  function maxQuad(hp) {
    let pts = hp;
    if (pts.length > 48) { const s = pts.length / 48; pts = Array.from({ length: 48 }, (_, i) => hp[Math.floor(i * s)]); }
    const n = pts.length; if (n < 4) return null;
    let best = -1, q = null;
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++) for (let d = c + 1; d < n; d++) {
      const ar = Math.abs(polyArea([pts[a], pts[b], pts[c], pts[d]]));
      if (ar > best) { best = ar; q = [pts[a], pts[b], pts[c], pts[d]]; }
    }
    return q;
  }
  // ordonne : haut-gauche, haut-droite, bas-droite, bas-gauche
  function orderQuad(q) {
    if (polyArea(q) < 0) q = q.slice().reverse();        // sens horaire à l'écran (y vers le bas)
    let k = 0; for (let i = 1; i < 4; i++) if (q[i][0] + q[i][1] < q[k][0] + q[k][1]) k = i;
    return [0, 1, 2, 3].map(i => q[(k + i) % 4]);
  }
  function fitLine(pts) { // moindres carrés totaux : point + direction
    let mx = 0, my = 0; for (const p of pts) { mx += p[0]; my += p[1]; } mx /= pts.length; my /= pts.length;
    let sxx = 0, sxy = 0, syy = 0; for (const p of pts) { const dx = p[0] - mx, dy = p[1] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    return { p: [mx, my], d: [Math.cos(th), Math.sin(th)] };
  }
  function intersect(l1, l2) {
    const det = l1.d[0] * l2.d[1] - l1.d[1] * l2.d[0];
    if (Math.abs(det) < 1e-6) return null;
    const t = ((l2.p[0] - l1.p[0]) * l2.d[1] - (l2.p[1] - l1.p[1]) * l2.d[0]) / det;
    return [l1.p[0] + t * l1.d[0], l1.p[1] + t * l1.d[1]];
  }
  // affine chaque côté en ajustant une droite sur les points de bord proches
  function refine(quad, boundary, diag) {
    const tol = Math.max(3, diag * 0.015), lines = [];
    for (let i = 0; i < 4; i++) {
      const a = quad[i], b = quad[(i + 1) % 4], L = dist(a, b), ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
      const near = [];
      for (const p of boundary) {
        const t = ((p[0] - a[0]) * ux + (p[1] - a[1]) * uy) / L;
        if (t < 0.12 || t > 0.88) continue;
        if (Math.abs((p[0] - a[0]) * uy - (p[1] - a[1]) * ux) < tol) near.push(p);
      }
      if (near.length < 8) return quad;
      lines.push(fitLine(near));
    }
    const out = [];
    for (let i = 0; i < 4; i++) {
      const c = intersect(lines[(i + 3) % 4], lines[i]);
      if (!c || dist(c, quad[i]) > diag * 0.06) return quad;
      out.push(c);
    }
    return out;
  }

  /* ---------- 1. détection (V1.1) ----------
     Principe : on cherche les 4 droites du bord du papier, pas une « tache claire ».
     - log-luminance : une ombre MULTIPLIE la lumière (papier et table ensemble), donc en log elle
       devient un simple décalage — le contraste papier/table reste le même dans l'ombre ;
     - contours orientés → transformée de Hough (chaque contour ne vote que pour sa propre direction) ;
     - toutes les combinaisons 2 + 2 droites → quadrilatères plausibles (angles, aire, convexité) ;
     - chaque quadrilatère est noté par la part de son périmètre où le dedans est nettement plus
       clair que le dehors, sur une bande de quelques pixels (une ombre floue, une ligne de texte,
       le grain d'une table ne passent pas ce test sur toute une longueur) ;
     - meilleur quadrilatère affiné au sous-pixel ; s'il est mal soutenu → cadre entier (« Tout »),
       jamais un faux cadre. */
  function blurF(a, w, h, r) {
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h), k = 2 * r + 1;
    for (let y = 0; y < h; y++) {
      const row = y * w; let acc = 0;
      for (let x = -r; x <= r; x++) acc += a[row + clamp(x, 0, w - 1)];
      for (let x = 0; x < w; x++) { tmp[row + x] = acc / k; acc += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)]; }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[clamp(y, 0, h - 1) * w + x];
      for (let y = 0; y < h; y++) { out[y * w + x] = acc / k; acc += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x]; }
    }
    return out;
  }
  function sampler(a, w, h) { // lecture bilinéaire, NaN hors image
    return (x, y) => {
      if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return NaN;
      const x0 = Math.min(w - 2, x | 0), y0 = Math.min(h - 2, y | 0), fx = x - x0, fy = y - y0, i = y0 * w + x0;
      return (a[i] * (1 - fx) + a[i + 1] * fx) * (1 - fy) + (a[i + w] * (1 - fx) + a[i + w + 1] * fx) * fy;
    };
  }
  const lineOf = (t, rho) => { const th = t * Math.PI / 180, c = Math.cos(th), s = Math.sin(th); return { t, rho, p: [c * rho, s * rho], d: [-s, c] }; };

  function houghLines(gx, gy, mag, w, h, thr, maxLines) {
    const D = Math.ceil(Math.hypot(w, h)), R = 2 * D + 1, acc = new Float32Array(180 * R);
    const COS = new Float32Array(180), SIN = new Float32Array(180);
    for (let t = 0; t < 180; t++) { COS[t] = Math.cos(t * Math.PI / 180); SIN[t] = Math.sin(t * Math.PI / 180); }
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, m = mag[i]; if (m < thr) continue;
      let t0 = Math.round(Math.atan2(gy[i], gx[i]) * 180 / Math.PI); t0 = ((t0 % 180) + 180) % 180;
      const wt = Math.min(m, 4 * thr);
      for (let dt = -4; dt <= 4; dt++) {
        let t = t0 + dt; if (t < 0) t += 180; else if (t >= 180) t -= 180;
        const rho = Math.round(x * COS[t] + y * SIN[t]) + D; acc[t * R + rho] += wt;
      }
    }
    const cand = [];
    let mx = 0; for (let i = 0; i < acc.length; i++) if (acc[i] > mx) mx = acc[i];
    const lim = mx * 0.08;
    for (let t = 0; t < 180; t++) for (let r = 1; r < R - 1; r++) { const v = acc[t * R + r]; if (v > lim) cand.push([v, t, r - D]); }
    cand.sort((a, b) => b[0] - a[0]);
    const out = [];
    for (const [v, t, rho] of cand) {
      let near = false;
      for (const L of out) {
        let dt = Math.abs(L.t - t), dr = Math.abs(L.rho - rho);
        if (dt > 90) { dt = 180 - dt; dr = Math.abs(L.rho + rho); }   // même droite, notée de l'autre côté
        if (dt <= 5 && dr <= 6) { near = true; break; }
      }
      if (!near) { out.push(lineOf(t, rho)); if (out.length >= maxLines) break; }
    }
    return out;
  }
  function angleOf(q, i) { // angle intérieur au coin i, en degrés
    const a = q[(i + 3) % 4], b = q[i], c = q[(i + 1) % 4];
    const v1 = [a[0] - b[0], a[1] - b[1]], v2 = [c[0] - b[0], c[1] - b[1]];
    return Math.acos(clamp((v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2) || 1), -1, 1)) * 180 / Math.PI;
  }
  // part du périmètre où le dedans est nettement plus clair que le dehors
  function support(q, lg, w, h) {
    const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
    let ok = 0, tot = 0; const sides = [];
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], L = dist(a, b), ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L;
      let nx = uy, ny = -ux;                                        // normale vers l'extérieur
      if (nx * ((a[0] + b[0]) / 2 - cx) + ny * ((a[1] + b[1]) / 2 - cy) < 0) { nx = -nx; ny = -ny; }
      const m = Math.max(12, Math.round(L / 3)); let so = 0;
      for (let k = 0; k < m; k++) {
        const t = 0.04 + 0.92 * (k + 0.5) / m, px = a[0] + (b[0] - a[0]) * t, py = a[1] + (b[1] - a[1]) * t;
        if (px < 1.5 || py < 1.5 || px > w - 2.5 || py > h - 2.5) {   // côté posé sur le bord de la photo
          if (px > -2 && py > -2 && px < w + 1 && py < h + 1) so += 0.4;
          continue;
        }
        let best = -9;
        for (let s = -2; s <= 2; s++) {
          let vin = 0, vout = 0, nin = 0, nout = 0;
          for (let d = 1; d <= 5; d++) {
            const a1 = lg(px + nx * (s - d), py + ny * (s - d)), a2 = lg(px + nx * (s + d), py + ny * (s + d));
            if (a1 === a1) { vin += a1; nin++; } if (a2 === a2) { vout += a2; nout++; }
          }
          if (nin && nout) best = Math.max(best, vin / nin - vout / nout);
        }
        if (best > 0.11) so++;
      }
      sides.push(so / m); ok += so / m * L; tot += L;
    }
    return { cov: ok / tot, sides };
  }
  // affine un côté : sur des normales, position du plus fort saut clair→sombre, puis droite ajustée
  function refineSide(a, b, out, gxy, w, h) {
    const L = dist(a, b), ux = (b[0] - a[0]) / L, uy = (b[1] - a[1]) / L, pts = [];
    const nx = out[0], ny = out[1];
    for (let k = 0; k < 40; k++) {
      const t = 0.1 + 0.8 * (k + 0.5) / 40, px = a[0] + (b[0] - a[0]) * t, py = a[1] + (b[1] - a[1]) * t;
      let best = 0, bs = 0;
      for (let s = -3; s <= 3; s += 0.5) {
        const v = gxy(px + nx * s, py + ny * s, nx, ny);
        if (v > best) { best = v; bs = s; }
      }
      if (best > 0) pts.push([px + nx * bs, py + ny * bs, best]);
    }
    if (pts.length < 10) return null;
    let line = fitLine(pts);
    const res = pts.map(p => Math.abs((p[0] - line.p[0]) * line.d[1] - (p[1] - line.p[1]) * line.d[0]));
    const keep = pts.filter((p, i) => res[i] < 1.2);
    if (keep.length >= 8) line = fitLine(keep);
    return line;
  }

  // src : ImageBitmap / canvas / image ; renvoie {quad:[[x,y]×4] en pixels source, ok, info, score}
  let DBG = null;
  function detect(src, sw, sh) {
    const sc = Math.min(1, DETECT_SIDE / Math.max(sw, sh));
    const w = Math.max(16, Math.round(sw * sc)), h = Math.max(16, Math.round(sh * sc)), n = w * h;
    const cv = makeCanvas(w, h), cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(src, 0, 0, w, h);
    const d = cx.getImageData(0, 0, w, h).data;
    let lg = new Float32Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) lg[i] = Math.log(0.299 * d[j] + 0.587 * d[j + 1] + 0.114 * d[j + 2] + 6);
    lg = blurF(blurF(lg, w, h, 1), w, h, 1);                     // ≈ flou gaussien : efface le grain de la table
    const gx = new Float32Array(n), gy = new Float32Array(n), mag = new Float32Array(n);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = lg[i - w - 1], b = lg[i - w], c = lg[i - w + 1], e = lg[i - 1], f = lg[i + 1], g = lg[i + w - 1], k = lg[i + w], l = lg[i + w + 1];
      gx[i] = (c + 2 * f + l) - (a + 2 * e + g); gy[i] = (g + 2 * k + l) - (a + 2 * b + c);
      mag[i] = Math.hypot(gx[i], gy[i]);
    }
    const smp = []; for (let i = 0; i < n; i += 7) smp.push(mag[i]); smp.sort((p, q) => p - q);
    const thr = Math.max(0.25, smp[Math.floor(smp.length * 0.9)]);
    const full = [[0, 0], [sw, 0], [sw, sh], [0, sh]];

    const lines = houghLines(gx, gy, mag, w, h, thr, 28);
    if (DBG) DBG.lines = lines.map(l => [l.t, l.rho, +(l.rho / sc).toFixed(0)]);
    lines.push(lineOf(0, 0), lineOf(0, w - 1), lineOf(90, 0), lineOf(90, h - 1));   // bords de la photo
    const L = sampler(lg, w, h), minSide = 0.12 * Math.min(w, h);
    const angDiff = (a, b) => { const x = Math.abs(a - b) % 180; return x > 90 ? 180 - x : x; };
    const pairs = [];
    for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
      if (angDiff(lines[i].t, lines[j].t) > 30) continue;
      const li = lines[i], lj = lines[j], mid = [w / 2, h / 2];
      // écart entre les 2 droites, mesuré au centre de la photo (le sens de la normale ne compte pas)
      const foot = [mid[0] - ((mid[0] - lj.p[0]) * lj.d[1] - (mid[1] - lj.p[1]) * lj.d[0]) * lj.d[1], mid[1] + ((mid[0] - lj.p[0]) * lj.d[1] - (mid[1] - lj.p[1]) * lj.d[0]) * lj.d[0]];
      if (Math.abs((foot[0] - li.p[0]) * li.d[1] - (foot[1] - li.p[1]) * li.d[0]) < minSide) continue;
      pairs.push([li, lj]);
    }
    let best = null;
    for (let i = 0; i < pairs.length; i++) for (let j = i + 1; j < pairs.length; j++) {
      const [a1, a2] = pairs[i], [b1, b2] = pairs[j];
      if (angDiff(a1.t, b1.t) < 50 || angDiff(a2.t, b2.t) < 50) continue;
      const c = [intersect(a1, b1), intersect(b1, a2), intersect(a2, b2), intersect(b2, a1)];
      if (c.some(p => !p || p[0] < -0.04 * w || p[1] < -0.04 * h || p[0] > 1.04 * w || p[1] > 1.04 * h)) continue;
      let q = c; const ar = polyArea(q); if (ar < 0) q = q.slice().reverse();
      const frac = Math.abs(ar) / n; if (frac < 0.05 || frac > 1.1) continue;
      let convex = true; for (let k = 0; k < 4; k++) if (cross(q[k], q[(k + 1) % 4], q[(k + 2) % 4]) <= 0) convex = false;
      if (!convex) continue;
      let angOk = true; for (let k = 0; k < 4; k++) { const an = angleOf(q, k); if (an < 45 || an > 135) angOk = false; }
      if (!angOk) continue;
      if ([0, 1, 2, 3].some(k => dist(q[k], q[(k + 1) % 4]) < minSide)) continue;
      const s = support(q, L, w, h), score = s.cov * (0.8 + 0.2 * Math.sqrt(Math.min(1, frac)));
      if (!best || score > best.score) best = { q, score, cov: s.cov, frac, sides: s.sides, onBorder: q.some(p => p[0] < 2 || p[1] < 2 || p[0] > w - 3 || p[1] > h - 3) };
      if (DBG) DBG.push({ q: q.map(p => [p[0] / sc, p[1] / sc]), score, cov: s.cov, sides: s.sides });
    }
    if (!best || best.cov < 0.62 || Math.min(...best.sides) < 0.3)
      return { quad: full, ok: false, info: 'bords non trouvés : cadre entier, ajustez les coins', score: best ? +best.cov.toFixed(2) : 0 };

    // affinage sous-pixel de chaque côté (sauf ceux posés sur le bord de la photo)
    let q = orderQuad(best.q);
    const ccx = q.reduce((s, p) => s + p[0], 0) / 4, ccy = q.reduce((s, p) => s + p[1], 0) / 4;
    const gxy = (x, y, nx, ny) => { const a1 = L(x - nx, y - ny), a2 = L(x + nx, y + ny); return a1 === a1 && a2 === a2 ? a1 - a2 : 0; };
    const sl = [];
    for (let i = 0; i < 4; i++) {
      const a = q[i], b = q[(i + 1) % 4], Ls = dist(a, b);
      let nx = (b[1] - a[1]) / Ls, ny = -(b[0] - a[0]) / Ls;
      if (nx * ((a[0] + b[0]) / 2 - ccx) + ny * ((a[1] + b[1]) / 2 - ccy) < 0) { nx = -nx; ny = -ny; }
      const onBorder = [a, b].every(p => p[0] < 2 || p[1] < 2 || p[0] > w - 3 || p[1] > h - 3);
      sl.push((!onBorder && refineSide(a, b, [nx, ny], gxy, w, h)) || { p: a, d: [(b[0] - a[0]) / Ls, (b[1] - a[1]) / Ls] });
    }
    const rq = [];
    for (let i = 0; i < 4; i++) { const c = intersect(sl[(i + 3) % 4], sl[i]); rq.push(c && dist(c, q[i]) < 0.04 * Math.hypot(w, h) ? c : q[i]); }
    q = rq;
    // resserre d'un cheveu vers le centre : évite le liseré de fond sur les bords
    const scaled = q.map(p => {
      const dx = ccx - p[0], dy = ccy - p[1], Lc = Math.hypot(dx, dy) || 1;
      return [clamp((p[0] + dx / Lc * 0.7) / sc, 0, sw), clamp((p[1] + dy / Lc * 0.7) / sc, 0, sh)];
    });
    if (best.frac > 0.95) return { quad: full, ok: true, info: 'ticket plein cadre', score: +best.cov.toFixed(2) };
    // un côté posé sur le bord de la photo : ticket coupé, ou objet clair qui dépasse → à vérifier
    if (best.onBorder) return { quad: scaled, ok: false, info: 'cadre au bord de la photo : vérifiez les coins', score: +best.cov.toFixed(2) };
    return { quad: scaled, ok: true, info: 'bords détectés', score: +best.cov.toFixed(2) };
  }
  /* ---------- 2. redressement ---------- */
  function solve8(A, B) { // élimination de Gauss
    const n = 8, M = A.map((r, i) => r.concat([B[i]]));
    for (let c = 0; c < n; c++) {
      let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
    }
    return M.map((r, i) => r[n] / r[i]);
  }
  function homography(from, to) { // from[i] -> to[i]
    const A = [], B = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = from[i], [u, v] = to[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); B.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); B.push(v);
    }
    return solve8(A, B);
  }
  function outputSize(q, maxLong) {
    let W = Math.max(dist(q[0], q[1]), dist(q[3], q[2])), H = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
    const s = Math.min(1, maxLong / Math.max(W, H));
    return [Math.max(16, Math.round(W * s)), Math.max(16, Math.round(H * s))];
  }
  // srcData : ImageData de la source ; quad en pixels de cette source
  function warp(srcData, quad, maxLong) {
    const sw = srcData.width, sh = srcData.height, s = srcData.data;
    const [W, H] = outputSize(quad, maxLong || 2400);
    const h = homography([[0, 0], [W, 0], [W, H], [0, H]], quad);
    const out = new ImageData(W, H), o = out.data;
    for (let v = 0; v < H; v++) {
      const vy = v + 0.5;
      for (let u = 0; u < W; u++) {
        const ux = u + 0.5, den = h[6] * ux + h[7] * vy + 1;
        let x = (h[0] * ux + h[1] * vy + h[2]) / den - 0.5, y = (h[3] * ux + h[4] * vy + h[5]) / den - 0.5;
        x = clamp(x, 0, sw - 1.001); y = clamp(y, 0, sh - 1.001);
        const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0;
        const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
        const oi = (v * W + u) * 4;
        for (let c = 0; c < 3; c++) {
          const top = s[i00 + c] + (s[i10 + c] - s[i00 + c]) * fx, bot = s[i01 + c] + (s[i11 + c] - s[i01 + c]) * fx;
          o[oi + c] = top + (bot - top) * fy;
        }
        o[oi + 3] = 255;
      }
    }
    return out;
  }

  /* ---------- 3. effet scan ---------- */
  // fond local du papier (V1.1) : image réduite par MAXIMUM (le texte fin disparaît), puis fermeture
  // (max puis min) qui efface les caractères plus gros SANS déplacer le bord net d'une ombre,
  // puis léger lissage. Plancher à 40 % du papier : une ombre (≈50 %) est effacée, un aplat noir
  // (QR code, logo, ≈10-25 %) n'est pas pris pour du fond.
  function maxMin(a, w, h, r, isMax) {
    const tmp = new Uint8ClampedArray(w * h), out = new Uint8ClampedArray(w * h);
    const pick = isMax ? Math.max : Math.min;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = a[y * w + x]; for (let k = -r; k <= r; k++) v = pick(v, a[y * w + clamp(x + k, 0, w - 1)]); tmp[y * w + x] = v;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = tmp[y * w + x]; for (let k = -r; k <= r; k++) v = pick(v, tmp[clamp(y + k, 0, h - 1) * w + x]); out[y * w + x] = v;
    }
    return out;
  }
  function paperBackground(g, w, h) {
    const B = Math.max(2, Math.round(Math.max(w, h) / 360));   // ~360 px de côté pour le fond
    const gw = Math.ceil(w / B), gh = Math.ceil(h / B);
    let grid = new Uint8ClampedArray(gw * gh);
    for (let by = 0; by < gh; by++) for (let bx = 0; bx < gw; bx++) {
      let m = 0;
      for (let y = by * B; y < Math.min(h, (by + 1) * B); y++) for (let x = bx * B; x < Math.min(w, (bx + 1) * B); x++) if (g[y * w + x] > m) m = g[y * w + x];
      grid[by * gw + bx] = m;
    }
    const r = Math.max(3, Math.round(Math.max(gw, gh) / 60));
    grid = maxMin(maxMin(grid, gw, gh, r, true), gw, gh, r, false);
    grid = boxBlur(grid, gw, gh, 1);
    const sorted = Array.from(g.filter((_, i) => i % 7 === 0)).sort((a, b) => a - b);
    const paper = sorted[Math.floor(sorted.length * 0.9)] || 255, floor = paper * 0.4;
    return { grid, gw, gh, B, floor };
  }
  function bgAt(bg, x, y) {
    const gx = clamp((x + 0.5) / bg.B - 0.5, 0, bg.gw - 1), gy = clamp((y + 0.5) / bg.B - 0.5, 0, bg.gh - 1);
    const x0 = gx | 0, y0 = gy | 0, x1 = Math.min(bg.gw - 1, x0 + 1), y1 = Math.min(bg.gh - 1, y0 + 1), fx = gx - x0, fy = gy - y0, G = bg.grid, W = bg.gw;
    const v = (G[y0 * W + x0] * (1 - fx) + G[y0 * W + x1] * fx) * (1 - fy) + (G[y1 * W + x0] * (1 - fx) + G[y1 * W + x1] * fx) * fy;
    return Math.max(v, bg.floor, 1);
  }
  // mode : 'scan' (gris, fond blanc) · 'nb' (noir et blanc, seuil adaptatif) · 'couleur'
  function enhance(img, mode) {
    const w = img.width, h = img.height, d = img.data, n = w * h;
    const out = new ImageData(w, h), o = out.data;
    if (mode === 'brut') { o.set(d); return out; }
    const g = grayOf(d, n), bg = paperBackground(g, w, h);
    const norm = new Float32Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x; norm[i] = g[i] / bgAt(bg, x, y); }
    // point noir : 1er centile, borné
    const smp = []; for (let i = 0; i < n; i += 11) smp.push(norm[i]); smp.sort((a, b) => a - b);
    const black = Math.min(0.45, smp[Math.floor(smp.length * 0.01)] || 0), white = 0.86;
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      let v;
      if (mode === 'nb') {
        const t = clamp((norm[i] - 0.62) / 0.14, 0, 1); v = 255 * t * t * (3 - 2 * t);
        o[j] = o[j + 1] = o[j + 2] = v;
      } else if (mode === 'couleur') {
        const k = 255 / (bgAt(bg, i % w, (i / w) | 0) * white);
        for (let c = 0; c < 3; c++) o[j + c] = clamp((d[j + c] * k - black * 255) / (1 - black), 0, 255);
      } else {
        const t = clamp((norm[i] - black) / (white - black), 0, 1); v = 255 * Math.pow(t, 1.5);
        o[j] = o[j + 1] = o[j + 2] = v;
      }
      o[j + 3] = 255;
    }
    return out;
  }

  function makeCanvas(w, h) {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
  }

  root.TEScanDbg = { on() { DBG = []; }, get() { return DBG; } };
  root.TEScan = { detect, warp, enhance, outputSize, homography, makeCanvas, orderQuad };
})(typeof self !== 'undefined' ? self : this);
