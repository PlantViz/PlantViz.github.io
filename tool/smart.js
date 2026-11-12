// Specimetrics — smart marker geometry (pure functions, no DOM).
// Works in the browser (window.Smart) and in Node (module.exports) so it can be unit-tested.
//
// Coordinates: spine points, centres and section ends are in FULL-RESOLUTION IMAGE PIXELS.
// The plant mask is sampled in MASK PIXELS: mask = image * (sx, sy), where sx = mask.width / sheet.width.
// A mask pixel (i, j) covers [i, i+1) x [j, j+1); inside(mx, my) looks up floor(mx), floor(my).
// Widths are "apparent widths" from the image (projected outline), not true thickness.
"use strict";
(function (root) {
  const hyp = Math.hypot;
  const dist = (a, b) => hyp(a[0] - b[0], a[1] - b[1]);

  /** cumulative arc length at each vertex */
  function cumlen(pts) { const c = [0]; for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + dist(pts[i - 1], pts[i])); return c; }
  const polyLength = (pts) => { const c = cumlen(pts); return c[c.length - 1]; };

  /** point at arc length s (clamped), with the unit direction of the segment it lies on */
  function pointAt(pts, s, cum = cumlen(pts)) {
    const L = cum[cum.length - 1];
    if (pts.length < 2 || L === 0) return { p: pts[0] ? [pts[0][0], pts[0][1]] : [0, 0], dir: [1, 0], i: 0 };
    s = Math.max(0, Math.min(L, s));
    let i = 1; while (i < cum.length - 1 && cum[i] < s) i++;
    while (i < cum.length - 1 && cum[i] - cum[i - 1] === 0) i++;          // skip zero-length segments
    const a = pts[i - 1], b = pts[i], seg = cum[i] - cum[i - 1] || 1, u = (s - cum[i - 1]) / seg;
    return { p: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u], dir: [(b[0] - a[0]) / seg, (b[1] - a[1]) / seg], i };
  }

  /** unit tangent at s, smoothed over +-win (image px) so corners do not give jumpy normals */
  function tangentAt(pts, s, win = 0, cum = cumlen(pts)) {
    const here = pointAt(pts, s, cum);
    if (win > 0) {
      const p0 = pointAt(pts, s - win, cum).p, p1 = pointAt(pts, s + win, cum).p, L = dist(p0, p1);
      if (L > 1e-9) return [(p1[0] - p0[0]) / L, (p1[1] - p0[1]) / L];
    }
    return here.dir;
  }

  /** position, unit tangent and unit normal at fractional arc length t in [0, 1] */
  function normalAt(pts, t, win = 0, cum = cumlen(pts)) {
    const L = cum[cum.length - 1], s = t * L, tg = tangentAt(pts, s, win, cum);
    return { s, t, p: pointAt(pts, s, cum).p, tangent: tg, normal: [-tg[1], tg[0]] };
  }

  /** n positions at equal arc-length spacing, centred in n equal parts: t = (i + 0.5) / n */
  const sectionTs = (n) => Array.from({ length: n }, (_, i) => (i + 0.5) / n);

  /** resample a polyline into points every `step` (image px) of arc length, both ends included */
  function resample(pts, step) {
    const cum = cumlen(pts), L = cum[cum.length - 1];
    if (!(step > 0) || L === 0) return pts.map((p) => [p[0], p[1]]);
    const k = Math.max(1, Math.round(L / step)), out = [];
    for (let i = 0; i <= k; i++) out.push(pointAt(pts, (i / k) * L, cum).p);
    return out;
  }

  /** inside(mx, my) for an alpha (or RGBA) buffer in mask pixels */
  function maskSampler(data, width, height, { stride = 1, offset = 0, threshold = 128 } = {}) {
    return (mx, my) => {
      const ix = Math.floor(mx), iy = Math.floor(my);
      if (ix < 0 || iy < 0 || ix >= width || iy >= height) return false;
      return data[(iy * width + ix) * stride + offset] >= threshold;
    };
  }

  /**
   * March outward from `center` along +normal and -normal through the mask until leaving the plant.
   * opts: sx, sy (mask px per image px), step (mask px, 0.5), maxHalf (mask px), search (mask px: if the
   * centre is not on the plant, look this far along the normal for the nearest plant pixel).
   * Returns { ok, a, b (image px), width_px (image px), capped, center (possibly shifted) }.
   */
  function marchWidth(inside, center, normal, opts = {}) {
    const sx = opts.sx || 1, sy = opts.sy || sx, step = opts.step || 0.5, maxHalf = opts.maxHalf || 125, search = opts.search ?? 0;
    let nx = normal[0] * sx, ny = normal[1] * sy; const nl = hyp(nx, ny) || 1; nx /= nl; ny /= nl;   // unit normal in mask space
    let cx = center[0] * sx, cy = center[1] * sy;
    if (!inside(cx, cy)) {
      let found = false;
      for (let d = step; d <= search + 1e-9 && !found; d += step)
        for (const sg of [1, -1]) if (inside(cx + sg * d * nx, cy + sg * d * ny)) { cx += sg * d * nx; cy += sg * d * ny; found = true; break; }
      if (!found) return { ok: false, center: [center[0], center[1]] };
    }
    let capped = false;
    const edge = (sg) => {
      let last = 0;
      for (let d = step; ; d += step) {
        if (d > maxHalf + 1e-9) { capped = true; return maxHalf; }
        if (!inside(cx + sg * d * nx, cy + sg * d * ny)) return Math.min(maxHalf, last + step / 2);
        last = d;
      }
    };
    const e1 = edge(1), e2 = edge(-1);
    const toImg = (mx, my) => [mx / sx, my / sy];
    const a = toImg(cx - e2 * nx, cy - e2 * ny), b = toImg(cx + e1 * nx, cy + e1 * ny);
    return { ok: true, a, b, width_px: dist(a, b), capped, center: toImg(cx, cy) };
  }

  const round2 = (v) => Math.round(v * 100) / 100;
  const roundPt = (p) => [round2(p[0]), round2(p[1])];

  /** width options in mask px from mm: { ppm (image px/mm), sx, sy, maskPpm } */
  function mmToMask(mmv, o) { return o.ppm ? mmv * o.ppm * (o.sx || 1) : mmv * (o.maskPpm || 5); }
  function pxToMm(px, o) { return o.ppm ? px / o.ppm : null; }
  /** one millimetre in image px (falls back to the mask grid if the sheet has no scale) */
  function mmToImg(mmv, o) { return o.ppm ? mmv * o.ppm : (mmv * (o.maskPpm || 5)) / (o.sx || 1); }

  // ---------------------------------------------------------------- segments between folds
  // A spine may carry folds = [vertex index, ...]: creases where the organ was folded when pressed. The polyline is split
  // there into segments; each segment has its own tangents (never smoothed across a fold) and its widths are measured
  // perpendicular to that segment only. Without folds there is one segment and everything below behaves as before.

  /** valid fold vertices: interior, integer, unique, sorted */
  function cleanFolds(pts, folds) {
    return [...new Set((folds || []).map((i) => Math.round(i)))].filter((i) => i > 0 && i < (pts || []).length - 1).sort((a, b) => a - b);
  }
  /** [{ k, i0, i1, pts, cum, s0, s1, len, face }] — face alternates 0 / 1 at each fold (the strip shows its other side) */
  function segments(pts, folds) {
    if (!pts || pts.length < 2) return [];
    const cum = cumlen(pts), idx = [0, ...cleanFolds(pts, folds), pts.length - 1], out = [];
    for (let j = 0; j < idx.length - 1; j++) {
      const i0 = idx[j], i1 = idx[j + 1], sub = pts.slice(i0, i1 + 1);
      out.push({ k: j, i0, i1, pts: sub, cum: cumlen(sub), s0: cum[i0], s1: cum[i1], len: cum[i1] - cum[i0], face: j % 2 });
    }
    return out;
  }
  /** index of the segment containing arc length s (a fold point belongs to the segment before it) */
  function segIndexAt(segs, s) { for (let j = 0; j < segs.length; j++) if (s <= segs[j].s1) return j; return segs.length - 1; }
  /** position, tangent and normal at global arc length s, computed inside segment `seg` only */
  function segFrame(seg, s, win) {
    const ls = Math.max(0, Math.min(seg.len, s - seg.s0)), tg = tangentAt(seg.pts, ls, win, seg.cum);
    return { s: seg.s0 + ls, p: pointAt(seg.pts, ls, seg.cum).p, tangent: tg, normal: [-tg[1], tg[0]] };
  }
  const march = (opts, p, normal) => marchWidth(opts.inside, p, normal, { sx: opts.sx, sy: opts.sy, step: 0.5,
    maxHalf: mmToMask(opts.maxHalfMm ?? 25, opts), search: mmToMask(opts.searchMm ?? 1, opts) });
  const median = (v) => { const s = [...v].sort((a, b) => a - b), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };

  /**
   * Fold zones: near a fold the cross-section of one arm runs into the other arm, so widths there are not measured.
   * Radius per fold = max(foldGapMm (1 mm), 0.75 x the wider neighbouring segment's typical width), at most 40 % of
   * the shorter neighbour. Sets seg.rStart / seg.rEnd (image px) and returns the segments.
   */
  function foldZones(segs, opts = {}) {
    const gap = mmToImg(opts.foldGapMm ?? 1, opts), win = mmToImg(opts.winMm ?? 1.5, opts);
    const typical = segs.map((sg) => {
      if (!opts.inside || sg.len === 0) return 0;
      const w = [0.3, 0.4, 0.5, 0.6, 0.7].map((u) => { const g = segFrame(sg, sg.s0 + u * sg.len, win), m = march(opts, g.p, g.normal); return m.ok ? m.width_px : null; }).filter((x) => x != null);
      return median(w) || 0;
    });
    segs.forEach((sg) => { sg.rStart = 0; sg.rEnd = 0; sg.typical_px = typical[sg.k]; });
    for (let j = 1; j < segs.length; j++) {
      const r = Math.min(Math.max(gap, 0.75 * Math.max(typical[j - 1], typical[j])), 0.4 * Math.min(segs[j - 1].len, segs[j].len));
      segs[j - 1].rEnd = r; segs[j].rStart = r;
    }
    return segs;
  }

  /**
   * Cross-sections for a spine: n sections at t = (i + 0.5) / n of the total (unfolded) arc length.
   * opts: inside (mask sampler or null), sx, sy, ppm, maskPpm, maxHalfMm (25), defaultMm (2), winMm (1.5), folds.
   * Each section is measured perpendicular to its own segment; sections inside a fold zone are shifted out of it.
   * Without a mask, sections get the default width and auto: false (the user drags their ends).
   */
  function computeSections(pts, n, opts = {}) {
    const cum = cumlen(pts), L = cum[cum.length - 1], win = mmToImg(opts.winMm ?? 1.5, opts), out = [];
    if (pts.length < 2 || L === 0) return out;
    const segs = foldZones(segments(pts, opts.folds), opts);
    for (const t of opts.ts || sectionTs(n)) {   // opts.ts: positions chosen by hand
      let s = t * L; const j = segIndexAt(segs, s), sg = segs[j], lo = sg.s0 + sg.rStart, hi = sg.s1 - sg.rEnd;
      s = lo > hi ? (sg.s0 + sg.s1) / 2 : Math.max(lo, Math.min(hi, s));
      out.push(sectionOn(sg, s / L, s, opts, win));
    }
    return out;
  }
  /** one section at fractional arc length t (no fold-zone shift: used to re-measure a placeholder) */
  function sectionAt(pts, t, opts = {}, cum = cumlen(pts), win = mmToImg(opts.winMm ?? 1.5, opts)) {
    const L = cum[cum.length - 1], segs = segments(pts, opts.folds), s = t * L;
    return sectionOn(segs[segIndexAt(segs, s)], t, s, opts, win);
  }
  function sectionOn(sg, t, s, opts, win) {
    const g = segFrame(sg, s, win), base = { t: Math.round(t * 1e4) / 1e4, center: roundPt(g.p) };
    if (opts.inside) {
      const m = march(opts, g.p, g.normal);
      if (m.ok) return { ...base, a: roundPt(m.a), b: roundPt(m.b), width_mm: pxToMm(m.width_px, opts) == null ? null : round2(pxToMm(m.width_px, opts)),
        auto: true, seg: sg.k, ...(m.capped ? { capped: true } : {}) };
    }
    const h = mmToImg((opts.defaultMm ?? 2) / 2, opts);
    const a = [g.p[0] - g.normal[0] * h, g.p[1] - g.normal[1] * h], b = [g.p[0] + g.normal[0] * h, g.p[1] + g.normal[1] * h];
    return { ...base, a: roundPt(a), b: roundPt(b), width_mm: opts.ppm ? opts.defaultMm ?? 2 : null, auto: false, default: true, seg: sg.k };
  }

  /** a section whose end was dragged by hand */
  function manualSection(sec, a, b, ppm) {
    const w = dist(a, b), { default: _d, capped: _c, ...rest } = sec;
    return { ...rest, a: roundPt(a), b: roundPt(b), width_mm: ppm ? round2(w / ppm) : null, auto: false };
  }
  const sectionWidthPx = (sec) => dist(sec.a, sec.b);

  /**
   * Dense samples for the strip / ribbon view, every `spacingMm` (1 mm) along each segment (both ends included),
   * measured like sections, perpendicular to the sample's own segment. Samples the mask cannot measure (or all,
   * without a mask) are interpolated from `sections` by t. Samples inside a fold zone get nearFold: true and the
   * width / edge offsets of the nearest sample of the same segment outside the zone.
   */
  function stripSamples(pts, opts = {}, sections = [], segs = null) {
    const cum = cumlen(pts), L = cum[cum.length - 1], out = [];
    if (pts.length < 2 || L === 0) return out;
    segs = segs || foldZones(segments(pts, opts.folds), opts);
    const step = mmToImg(opts.spacingMm ?? 1, opts), win = mmToImg(opts.winMm ?? 1.5, opts);
    for (const sg of segs) {
      if (sg.len === 0) continue;
      const k = Math.max(2, Math.round(sg.len / step)), mine = [];
      for (let i = 0; i <= k; i++) {
        const ls = (i / k) * sg.len, g = segFrame(sg, sg.s0 + ls, win), t = g.s / L;
        let rec = null;
        if (opts.inside) { const m = march(opts, g.p, g.normal); if (m.ok) rec = { a: m.a, b: m.b, width_px: m.width_px, measured: true, capped: m.capped }; }
        if (!rec) {
          const w = interpWidth(sections, t);
          if (w == null) continue;
          rec = { a: [g.p[0] - g.normal[0] * w / 2, g.p[1] - g.normal[1] * w / 2], b: [g.p[0] + g.normal[0] * w / 2, g.p[1] + g.normal[1] * w / 2], width_px: w, measured: false };
        }
        const nearFold = ls < sg.rStart - 1e-9 || sg.len - ls < sg.rEnd - 1e-9;
        mine.push({ t, s: g.s, seg: sg.k, center: g.p, normal: g.normal, tangent: g.tangent, ...rec, ...(nearFold ? { nearFold: true } : {}) });
      }
      const good = mine.filter((x) => !x.nearFold);
      if (good.length) for (const x of mine) {
        if (!x.nearFold) continue;
        let q = good[0]; for (const y of good) if (Math.abs(y.s - x.s) < Math.abs(q.s - x.s)) q = y;
        const oa = dot(sub(q.a, q.center), q.normal), ob = dot(sub(q.b, q.center), q.normal);
        x.a = add(x.center, mul(x.normal, oa)); x.b = add(x.center, mul(x.normal, ob)); x.width_px = q.width_px; x.held = true;
      }
      for (const x of mine) { x.width_mm = pxToMm(x.width_px, opts); out.push(x); }
    }
    return out;
  }
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]], add = (a, b) => [a[0] + b[0], a[1] + b[1]], mul = (a, k) => [a[0] * k, a[1] * k];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1], cross = (a, b) => a[0] * b[1] - a[1] * b[0];
  const unit = (a) => { const l = hyp(a[0], a[1]); return l > 1e-12 ? [a[0] / l, a[1] / l] : null; };
  /** width (image px) at t, linearly interpolated between sections (held constant past the end ones) */
  function interpWidth(sections, t) {
    if (!sections || !sections.length) return null;
    const s = [...sections].sort((x, y) => x.t - y.t);
    if (t <= s[0].t) return sectionWidthPx(s[0]);
    for (let i = 1; i < s.length; i++) if (t <= s[i].t) { const u = (t - s[i - 1].t) / (s[i].t - s[i - 1].t || 1); return sectionWidthPx(s[i - 1]) * (1 - u) + sectionWidthPx(s[i]) * u; }
    return sectionWidthPx(s[s.length - 1]);
  }

  /** how far the spine turns (degrees, 0 = straight on, 180 = straight back) between s - h and s + h:
   *  angle between the local directions (smoothed over h/5) at the two ends of that window */
  function turnAngle(pts, s, h, cum = cumlen(pts)) {
    const L = cum[cum.length - 1], s0 = Math.max(0, s - h), s1 = Math.min(L, s + h);
    if (s1 - s0 < h * 0.5) return 0;
    const d = h / 5, a = tangentAt(pts, s0, d, cum), b = tangentAt(pts, s1, d, cum);
    return (Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1]))) * 180) / Math.PI;
  }

  /**
   * Possible folds: (a) apparent width jumps by more than `ratio` (1.6x) between adjacent samples (and by at least
   * minDiffMm), (b) the spine turns back by more than `bendDeg` (120 deg) within `bendMm` (5 mm).
   * Returns [{ kind: "width_jump" | "sharp_bend", t, s, p, value }], nearby flags of one kind merged.
   */
  function detectFolds(pts, samples, opts = {}) {
    const ratio = opts.ratio ?? 1.6, bendDeg = opts.bendDeg ?? 120, cum = cumlen(pts), L = cum[cum.length - 1], out = [];
    if (pts.length < 2 || L === 0) return out;
    const minDiff = mmToImg(opts.minDiffMm ?? 0.3, opts), merge = mmToImg(opts.mergeMm ?? 3, opts);
    const ok = (samples || []).filter((x) => x.width_px > 0);
    for (let i = 1; i < ok.length; i++) {
      const w0 = ok[i - 1].width_px, w1 = ok[i].width_px, r = Math.max(w0, w1) / Math.min(w0, w1);
      if (r > ratio && Math.abs(w1 - w0) >= minDiff) {
        const s = (ok[i - 1].s + ok[i].s) / 2; out.push({ kind: "width_jump", s, t: s / L, p: pointAt(pts, s, cum).p, value: r });
      }
    }
    const h = mmToImg((opts.bendMm ?? 5) / 2, opts), step = Math.max(h / 5, 1e-6), probes = new Set();
    for (let s = 0; s <= L; s += step) probes.add(s);
    cum.forEach((c) => probes.add(c));
    for (const s of [...probes].sort((x, y) => x - y)) {
      const a = turnAngle(pts, s, h, cum);
      if (a > bendDeg) out.push({ kind: "sharp_bend", s, t: s / L, p: pointAt(pts, s, cum).p, value: a });
    }
    // merge runs of the same kind, keep the strongest
    out.sort((x, y) => x.s - y.s);
    const merged = [];
    for (const f of out) {
      const m = merged.find((g) => g.kind === f.kind && Math.abs(g.s - f.s) <= merge);
      if (!m) merged.push({ ...f }); else if (f.value > m.value) Object.assign(m, f);
    }
    return merged.map((f) => ({ ...f, p: roundPt(f.p), value: round2(f.value) }));
  }

  // ---------------------------------------------------------------- folds: suggestions, creases, ribbons, overlaps
  /**
   * Suggested folds: interior vertices (not already folds) where the spine turns by more than foldDeg (60 deg) within
   * bendMm (5 mm) around the vertex. The strongest of nearby candidates wins (non-maximum suppression over mergeMm,
   * 5 mm); vertices within mergeMm of an existing fold are not suggested. Returns [{ i, s, t, p, angle }] by s.
   * These are only suggestions: the user accepts them.
   */
  function suggestFolds(pts, folds, opts = {}) {
    if (!pts || pts.length < 3) return [];
    const cum = cumlen(pts), L = cum[cum.length - 1]; if (L === 0) return [];
    const f = cleanFolds(pts, folds), h = mmToImg((opts.bendMm ?? 5) / 2, opts), minDeg = opts.foldDeg ?? 60, merge = mmToImg(opts.mergeMm ?? 5, opts);
    const ang = (u, v) => (Math.acos(Math.max(-1, Math.min(1, dot(u, v)))) * 180) / Math.PI, cands = [];
    for (let i = 1; i < pts.length - 1; i++) {
      if (f.includes(i)) continue;
      const s = cum[i], d1 = unit(sub(pts[i], pointAt(pts, s - h, cum).p)), d2 = unit(sub(pointAt(pts, s + h, cum).p, pts[i]));
      if (!d1 || !d2) continue;
      const a = Math.max(ang(d1, d2), turnAngle(pts, s, h, cum));
      if (a > minDeg && !f.some((k) => Math.abs(cum[k] - s) <= merge)) cands.push({ i, s, t: s / L, p: roundPt(pts[i]), angle: round2(a) });
    }
    const keep = [];
    for (const c of cands.sort((x, y) => y.angle - x.angle)) if (!keep.some((k) => Math.abs(k.s - c.s) <= merge)) keep.push(c);
    return keep.sort((x, y) => x.s - y.s);
  }

  /**
   * Crease at the fold between segments j-1 and j. A fold (turn >= 60 deg, the suggestion threshold): a flat-folded strip mirrors its
   * direction across the crease, so the crease runs along the bisector of the two segment directions (d1 + d2);
   * straight back (hairpin) it is perpendicular to the strip. Gentler turns (a bend rather than a flat fold): the mitre
   * line between the two normals.
   * width_px: local width; the crease spans the strip, i.e. width / sin(angle to the strip), at most 1.6 x width.
   * Returns { j, i, p, dir, a, b, turn (deg), len }.
   */
  function crease(segs, j, width_px, opts = {}) {
    const A = segs[j - 1], B = segs[j], win = mmToImg(opts.winMm ?? 1.5, opts);
    const d1 = segFrame(A, A.s1, win).tangent, d2 = segFrame(B, B.s0, win).tangent, p = B.pts[0];
    const turn = (Math.acos(Math.max(-1, Math.min(1, dot(d1, d2)))) * 180) / Math.PI;
    let dir = turn < 60 ? unit(add([-d1[1], d1[0]], [-d2[1], d2[0]])) : unit(add(d1, d2));
    if (!dir) dir = [-d1[1], d1[0]];
    const sn = Math.abs(cross(dir, d1)), w = width_px > 0 ? width_px : 0, len = Math.min(1.6 * w, w / Math.max(sn, 1e-6));
    return { j, i: B.i0, p: [p[0], p[1]], dir, a: add(p, mul(dir, -len / 2)), b: add(p, mul(dir, len / 2)), turn: round2(turn), len };
  }

  /** intersection of segment q0-q1 (or, with ray = true, the ray q0 + u (q1 - q0), u >= 0) with the line p + v dir */
  function hitLine(q0, q1, p, dir, ray) {
    const d = sub(q1, q0), den = cross(d, dir); if (Math.abs(den) < 1e-12) return null;
    const u = cross(sub(p, q0), dir) / den;
    if (u < -1e-9 || (!ray && u > 1 + 1e-9)) return null;
    return { u, q: add(q0, mul(d, u)) };
  }
  /**
   * Clip one edge (list of points from the segment's start to its end) at a crease. atEnd: the crease is at the end.
   * Points on the far side of the crease are dropped and the edge ends exactly on the crease line; an edge that stops
   * short of it is extended along its own direction (at most `maxExt`).
   */
  function clipEdge(edge, cr, ownSide, atEnd, maxExt) {
    if (!cr || edge.length < 2) return edge;
    const e = atEnd ? edge.slice() : edge.slice().reverse(), side = (q) => cross(cr.dir, sub(q, cr.p));
    let n = e.length; while (n > 1 && side(e[n - 1]) * ownSide < 0) n--;
    const kept = e.slice(0, n);
    if (n < e.length) { const h = hitLine(e[n - 1], e[n], cr.p, cr.dir, false); if (h) kept.push(h.q); }
    else if (kept.length >= 2) {
      const q0 = kept[kept.length - 1], dirE = unit(sub(q0, kept[kept.length - 2]));
      if (dirE) { const h = hitLine(q0, add(q0, dirE), cr.p, cr.dir, true); if (h && h.u > 1e-9 && h.u <= maxExt) kept.push(h.q); }
    }
    return atEnd ? kept : kept.reverse();
  }

  /**
   * Ribbon polygons (paper-strip view): one flat band per segment from the edge points of its samples, cut cleanly at
   * the creases. Returns [{ seg, face, poly: [[x, y], ...] (edge a forward, edge b back) }].
   */
  function ribbons(samples, segs, creases) {
    const out = [];
    for (const sg of segs) {
      const mine = samples.filter((x) => x.seg === sg.k); if (mine.length < 2) continue;
      let A = mine.map((x) => x.a), B = mine.map((x) => x.b);
      const mid = mine[Math.floor(mine.length / 2)].center, ext = 2.5 * (median(mine.map((x) => x.width_px)) || 0) + 1;
      const crS = creases.find((c) => c.j === sg.k), crE = creases.find((c) => c.j === sg.k + 1);
      for (const [cr, atEnd] of [[crS, false], [crE, true]]) {
        if (!cr) continue;
        const own = Math.sign(cross(cr.dir, sub(mid, cr.p))) || 1;
        A = clipEdge(A, cr, own, atEnd, ext); B = clipEdge(B, cr, own, atEnd, ext);
      }
      out.push({ seg: sg.k, face: sg.face, poly: [...A, ...B.slice().reverse()] });
    }
    return out;
  }

  /** even-odd point in polygon */
  function pointInPoly(q, poly) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a[1] > q[1]) !== (b[1] > q[1]) && q[0] < ((b[0] - a[0]) * (q[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  }
  /**
   * Overlap (two layers after a fold-back): a sample outside the fold zones whose centre lies inside another segment's
   * ribbon (every flat fold has a small two-layer triangle at the crease; that is not reported). Points within
   * `tol` (0.5 mm) of a fold point are ignored (they sit on the crease itself). Sets sample.overlap / sample.under and
   * returns the overlapping segment pairs [{ segs: [j, k], n, at (mean centre of the overlapping samples) }].
   */
  function markOverlaps(samples, rib, foldPts, opts = {}) {
    const tol = mmToImg(opts.overlapTolMm ?? 0.5, opts), pairs = new Map();
    for (const x of samples) {
      delete x.overlap; delete x.under;
      if (x.held || foldPts.some((p) => dist(p, x.center) < tol)) continue;   // the crease triangle of any flat fold is not reported
      const r = rib.find((rb) => rb.seg !== x.seg && pointInPoly(x.center, rb.poly)); if (!r) continue;
      x.overlap = true; x.under = r.seg;
      const key = [Math.min(x.seg, r.seg), Math.max(x.seg, r.seg)].join(","), g = pairs.get(key) || { segs: key.split(",").map(Number), n: 0, sx: 0, sy: 0 };
      g.n++; g.sx += x.center[0]; g.sy += x.center[1]; pairs.set(key, g);
    }
    return [...pairs.values()].map((g) => ({ segs: g.segs, n: g.n, at: [g.sx / g.n, g.sy / g.n] }));
  }
  /** flag sections whose centre lies inside another segment's ribbon (overlap: true); returns the sections */
  function markSectionOverlaps(sections, rib, foldPts, opts = {}) {
    const tol = mmToImg(opts.overlapTolMm ?? 0.5, opts);
    return (sections || []).map((s) => {
      const { overlap: _o, ...rest } = s, seg = s.seg ?? 0;
      const on = !foldPts.some((p) => dist(p, s.center) < tol) && rib.some((rb) => rb.seg !== seg && pointInPoly(s.center, rb.poly));
      return on ? { ...rest, overlap: true } : rest;
    });
  }

  /**
   * Unfolded (straightened) ribbon: x = arc length, half-height = width there. Returns { total, segs: [{ k, s0, s1, len,
   * face }], folds: [s], profile: [{ s, w, seg, overlap, held }] }. total = sum of the segment lengths.
   */
  function unfolded(samples, segs) {
    const S = segs.map((g) => ({ k: g.k, s0: g.s0, s1: g.s1, len: g.len, face: g.face }));
    return { total: S.reduce((a, g) => a + g.len, 0), segs: S, folds: S.slice(1).map((g) => g.s0),
      profile: samples.map((x) => ({ s: x.s, w: x.width_px, seg: x.seg, overlap: !!x.overlap, held: !!x.held })) };
  }

  /**
   * Everything the ribbon view needs for one spine. opts as for computeSections (with folds); sections: the spine's
   * sections (used for the strip when there is no mask, and flagged for overlap). Returns { segs, samples, creases,
   * ribbons, overlaps, sections (with overlap flags), suggestions, hints (width jumps outside fold zones), unfolded }.
   */
  function analyze(pts, opts = {}, sections = []) {
    const segs = foldZones(segments(pts, opts.folds), opts);
    const samples = stripSamples(pts, opts, sections, segs);
    const creases = segs.slice(1).map((sg) => {
      const w = samples.filter((x) => (x.seg === sg.k - 1 || x.seg === sg.k) && Math.abs(x.s - sg.s0) <= Math.max(sg.rStart, mmToImg(1, opts)) + 1e-6).map((x) => x.width_px);
      return crease(segs, sg.k, median(w) || sg.typical_px || mmToImg(opts.defaultMm ?? 2, opts), opts);
    });
    const rib = ribbons(samples, segs, creases), foldPts = creases.map((c) => c.p);
    const overlaps = segs.length > 1 ? markOverlaps(samples, rib, foldPts, opts) : [];
    const secs = segs.length > 1 ? markSectionOverlaps(sections, rib, foldPts, opts) : (sections || []).map(({ overlap: _o, ...r }) => r);
    const zones = segs.slice(1).map((sg) => [sg.s0 - sg.rStart - mmToImg(1, opts), sg.s0 + sg.rStart + mmToImg(1, opts)]);
    const hints = detectFolds(pts, samples.filter((x) => !x.held && !x.overlap), { ...opts, bendDeg: 999 })
      .filter((h) => h.kind === "width_jump" && !zones.some(([a, b]) => h.s >= a && h.s <= b));
    return { segs, samples, creases, ribbons: rib, overlaps, sections: secs, suggestions: suggestFolds(pts, opts.folds, opts), hints, unfolded: unfolded(samples, segs) };
  }

  /** mean / min / max of section widths (mm, or image px when there is no scale); sections over two layers
   *  (overlap: true) are left out, `excluded` counts them */
  function widthStats(sections, ppm) {
    const excluded = (sections || []).filter((s) => s.overlap).length;
    const v = (sections || []).filter((s) => !s.overlap).map((s) => (ppm ? sectionWidthPx(s) / ppm : sectionWidthPx(s))).filter((x) => isFinite(x));
    if (!v.length) return { n: 0, mean: null, min: null, max: null, excluded };
    return { n: v.length, excluded, mean: v.reduce((a, b) => a + b, 0) / v.length, min: Math.min(...v), max: Math.max(...v) };
  }

  // ---------------------------------------------------------------- magnetic tracing on the plant mask (mask pixels)
  /** Uint8Array (1 = plant) from an RGBA buffer's alpha */
  function gridFromAlpha(data, w, h, threshold = 128) {
    const g = new Uint8Array(w * h);
    for (let i = 0; i < g.length; i++) g[i] = data[i * 4 + 3] >= threshold ? 1 : 0;
    return g;
  }

  /** chamfer distance (mask px) of every plant pixel to the nearest non-plant pixel; 0 off the plant */
  function distanceField(grid, w, h) {
    const d = new Float32Array(w * h), INF = 1e9, A = 1, B = Math.SQRT2;
    for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
      if (!grid[i]) { d[i] = 0; continue; }
      if (x === 0 || y === 0) { d[i] = 1; continue; }
      d[i] = Math.min(INF, d[i - 1] + A, d[i - w] + A, d[i - w - 1] + B, x < w - 1 ? d[i - w + 1] + B : INF);
    }
    for (let y = h - 1, i = w * h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--, i--) {
      if (!grid[i]) continue;
      if (x === w - 1 || y === h - 1) { d[i] = Math.min(d[i], 1); continue; }
      d[i] = Math.min(d[i], d[i + 1] + A, d[i + w] + A, d[i + w + 1] + B, x > 0 ? d[i + w - 1] + B : INF);
    }
    return d;
  }

  /** the best centre-of-plant point within radius r of p; null if no plant is that close */
  function snapToRidge(d, w, h, p, r) {
    const px = Math.round(p[0]), py = Math.round(p[1]); let best = null, bs = -Infinity;
    for (let y = Math.max(0, py - r); y <= Math.min(h - 1, py + r); y++) for (let x = Math.max(0, px - r); x <= Math.min(w - 1, px + r); x++) {
      const v = d[y * w + x], dd = hyp(x - px, y - py); if (!v || dd > r) continue;
      const score = v - dd * 0.5; if (score > bs) { bs = score; best = [x, y]; }
    }
    return best;
  }

  /**
   * Cheapest path from a to b (mask px, integers), preferring the middle of the plant. Off-plant pixels are expensive but
   * allowed, so short gaps (tape, breaks) are bridged. Returns { ok, path: [[x, y], ...], off: fraction of steps off the plant }.
   */
  function trace(d, w, h, a, b, opts = {}) {
    const span = hyp(a[0] - b[0], a[1] - b[1]), margin = Math.round(Math.max(opts.margin ?? 30, span * 0.35));
    const x0 = Math.max(0, Math.min(a[0], b[0]) - margin), y0 = Math.max(0, Math.min(a[1], b[1]) - margin);
    const bw = Math.min(w - 1, Math.max(a[0], b[0]) + margin) - x0 + 1, bh = Math.min(h - 1, Math.max(a[1], b[1]) + margin) - y0 + 1;
    const n = bw * bh, cost = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1);
    const idx = (x, y) => (y - y0) * bw + (x - x0), start = idx(a[0], a[1]), goal = idx(b[0], b[1]);
    const cell = (x, y) => { const v = d[y * w + x]; return v > 0 ? 1 + 8 / (v * v) : (opts.offCost ?? 60); };
    const heapI = [start], heapC = [0]; cost[start] = 0;
    const push = (i, c) => { let k = heapI.length; heapI.push(i); heapC.push(c);
      while (k > 0) { const p = (k - 1) >> 1; if (heapC[p] <= c) break; heapI[k] = heapI[p]; heapC[k] = heapC[p]; k = p; } heapI[k] = i; heapC[k] = c; };
    const pop = () => { const top = heapI[0], lastI = heapI.pop(), lastC = heapC.pop(), m = heapI.length;
      if (m) { let k = 0; for (;;) { let ch = 2 * k + 1; if (ch >= m) break; if (ch + 1 < m && heapC[ch + 1] < heapC[ch]) ch++; if (heapC[ch] >= lastC) break; heapI[k] = heapI[ch]; heapC[k] = heapC[ch]; k = ch; } heapI[k] = lastI; heapC[k] = lastC; }
      return top; };
    const NB = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];
    let reached = start === goal;
    while (heapI.length && !reached) {
      const c0 = heapC[0], i = pop(); if (c0 > cost[i]) continue;
      if (i === goal) { reached = true; break; }
      const x = (i % bw) + x0, y = Math.floor(i / bw) + y0, here = cell(x, y);
      for (const [dx, dy, len] of NB) {
        const nx = x + dx, ny = y + dy; if (nx < x0 || ny < y0 || nx >= x0 + bw || ny >= y0 + bh) continue;
        const j = idx(nx, ny), nc = c0 + len * (here + cell(nx, ny)) / 2;
        if (nc < cost[j]) { cost[j] = nc; prev[j] = i; push(j, nc); }
      }
    }
    if (!reached) return { ok: false, path: [], off: 1 };
    const path = []; let off = 0;
    for (let i = goal; i !== -1; i = prev[i]) { const x = (i % bw) + x0, y = Math.floor(i / bw) + y0; path.push([x, y]); if (!d[y * w + x]) off++; }
    path.reverse();
    const frac = off / path.length;
    return { ok: frac <= (opts.maxOff ?? 0.6), path, off: frac };
  }

  /** moving average of a polyline; the end points stay put */
  function smooth(pts, win = 5) {
    const h2 = Math.floor(win / 2);
    return pts.map((p, i) => { if (i === 0 || i === pts.length - 1) return p; const r = Math.min(h2, i, pts.length - 1 - i); let x = 0, y = 0; for (let k = i - r; k <= i + r; k++) { x += pts[k][0]; y += pts[k][1]; } const m = 2 * r + 1; return [x / m, y / m]; });
  }

  /** Douglas-Peucker */
  function simplify(pts, tol) {
    if (pts.length < 3) return pts.slice();
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [i0, i1] = stack.pop(), a = pts[i0], b = pts[i1], dx = b[0] - a[0], dy = b[1] - a[1], L = hyp(dx, dy); let best = -1, bd = tol;
      for (let i = i0 + 1; i < i1; i++) { const p = pts[i], e = L ? Math.abs(dy * (p[0] - a[0]) - dx * (p[1] - a[1])) / L : dist(p, a); if (e > bd) { bd = e; best = i; } }
      if (best > 0) { keep[best] = 1; stack.push([i0, best], [best, i1]); }
    }
    return pts.filter((_, i) => keep[i]);
  }

  /** narrowest uncapped chord through a point: the organ's width when no line says which way it runs */
  function narrowestChord(inside, center, opts = {}) {
    let best = null;
    for (let k = 0; k < 24; k++) {
      const t = (k * Math.PI) / 24, m = marchWidth(inside, center, [Math.cos(t), Math.sin(t)], opts);
      if (m.ok && !m.capped && (!best || m.width_px < best.width_px)) best = m;
    }
    return best || { ok: false, center };
  }

  // ---------------------------------------------------------------- magic selection (mask pixels)
  /** CIE Lab of an RGBA buffer, packed as bytes: L * 2.55, a + 128, b + 128 */
  function labGrid(rgba, w, h) {
    const lin = new Float32Array(256);
    for (let i = 0; i < 256; i++) { const v = i / 255; lin[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116), out = new Uint8Array(w * h * 3);
    for (let i = 0, n = w * h; i < n; i++) {
      const r = lin[rgba[i * 4]], g = lin[rgba[i * 4 + 1]], b = lin[rgba[i * 4 + 2]];
      const X = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047), Y = f(0.2126 * r + 0.7152 * g + 0.0722 * b), Z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
      out[i * 3] = Math.round((116 * Y - 16) * 2.55); out[i * 3 + 1] = Math.max(0, Math.min(255, Math.round(500 * (X - Y) + 128))); out[i * 3 + 2] = Math.max(0, Math.min(255, Math.round(200 * (Y - Z) + 128)));
    }
    return out;
  }

  /**
   * Photoshop-style magic selection: pixels within `tol` (colour difference, lightness counts 60 %) of the colour at the seed.
   * contiguous: only the connected area. Small holes (up to maxHole px) inside the selection are filled.
   * Returns { region: Uint8Array (1 = selected), count, x0, y0, x1, y1 }, or null when the seed is outside.
   */
  function magicSelect(lab, w, h, seed, tol, opts = {}) {
    const sx = Math.round(seed[0]), sy = Math.round(seed[1]); if (sx < 0 || sy < 0 || sx >= w || sy >= h) return null;
    let L0 = 0, A0 = 0, B0 = 0, m = 0;
    for (let y = Math.max(0, sy - 1); y <= Math.min(h - 1, sy + 1); y++) for (let x = Math.max(0, sx - 1); x <= Math.min(w - 1, sx + 1); x++) { const k = (y * w + x) * 3; L0 += lab[k]; A0 += lab[k + 1]; B0 += lab[k + 2]; m++; }
    L0 /= m; A0 /= m; B0 /= m;
    const lim = tol * tol, n = w * h, region = new Uint8Array(n), LW = 0.6 / 2.55;
    const near = (i) => { const k = i * 3, dl = (lab[k] - L0) * LW, da = lab[k + 1] - A0, db = lab[k + 2] - B0; return dl * dl + da * da + db * db <= lim; };
    let count = 0, x0 = sx, y0 = sy, x1 = sx, y1 = sy;
    const take = (i, x, y) => { region[i] = 1; count++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
    if (opts.contiguous === false) {
      for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) if (near(i)) take(i, x, y);
      if (!region[sy * w + sx]) take(sy * w + sx, sx, sy);
    } else {
      const stack = new Int32Array(n); let sp = 0; const first = sy * w + sx; take(first, sx, sy); stack[sp++] = first;
      while (sp) {
        const i = stack[--sp], x = i % w, y = (i - x) / w;
        if (x > 0 && !region[i - 1] && near(i - 1)) { take(i - 1, x - 1, y); stack[sp++] = i - 1; }
        if (x < w - 1 && !region[i + 1] && near(i + 1)) { take(i + 1, x + 1, y); stack[sp++] = i + 1; }
        if (y > 0 && !region[i - w] && near(i - w)) { take(i - w, x, y - 1); stack[sp++] = i - w; }
        if (y < h - 1 && !region[i + w] && near(i + w)) { take(i + w, x, y + 1); stack[sp++] = i + w; }
      }
    }
    return fillHoles({ region, count, x0, y0, x1, y1 }, w, opts.maxHole ?? 40);
  }

  /** fill background pockets inside a selection that never reach its bounding box edge and are at most maxHole px */
  function fillHoles(sel, w, maxHole) {
    if (!(maxHole > 0)) return sel;
    const { region, x0, y0, x1, y1 } = sel, bw = x1 - x0 + 1, bh = y1 - y0 + 1, seen = new Uint8Array(bw * bh), stack = new Int32Array(bw * bh), at = (x, y) => (y - y0) * bw + (x - x0);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (region[y * w + x] || seen[at(x, y)]) continue;
      let sp = 0, touches = false; const cells = []; seen[at(x, y)] = 1; stack[sp++] = at(x, y);
      while (sp) {
        const c = stack[--sp], cx = (c % bw) + x0, cy = Math.floor(c / bw) + y0;
        if (cells.length <= maxHole) cells.push(cy * w + cx);
        if (cx === x0 || cx === x1 || cy === y0 || cy === y1) touches = true;
        for (const [nx, ny] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]]) {
          if (nx < x0 || nx > x1 || ny < y0 || ny > y1 || region[ny * w + nx] || seen[at(nx, ny)]) continue;
          seen[at(nx, ny)] = 1; stack[sp++] = at(nx, ny);
        }
      }
      if (!touches && cells.length <= maxHole) for (const i of cells) { region[i] = 1; sel.count++; }
    }
    return sel;
  }

  /**
   * Quick selection with a round brush: as the circle (radius r) is dragged along pts, it picks up the pixels inside the circle
   * whose colour is close (within tol) to a colour the cursor's centre passed over. Nothing outside the swept circle is taken,
   * so paper at the brush edge stays out when the centre is on the plant. pts and r in mask px. Same shape as magicSelect.
   */
  function quickSelect(lab, w, h, pts, r, tol, opts = {}) {
    if (!pts.length) return null;
    const R = Math.max(1, r), R2 = R * R;
    const bx0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[0])) - R)), by0 = Math.max(0, Math.floor(Math.min(...pts.map((p) => p[1])) - R));
    const bx1 = Math.min(w - 1, Math.ceil(Math.max(...pts.map((p) => p[0])) + R)), by1 = Math.min(h - 1, Math.ceil(Math.max(...pts.map((p) => p[1])) + R));
    if (bx0 > bx1 || by0 > by1) return null;
    // the swept circle, stamped along the stroke every half radius (or every pixel for a small brush)
    const bw = bx1 - bx0 + 1, sweep = new Uint8Array(bw * (by1 - by0 + 1)), centre = [], seenC = new Set();
    const stamp = (cx, cy) => {
      for (let y = Math.max(by0, Math.ceil(cy - R)); y <= Math.min(by1, Math.floor(cy + R)); y++) for (let x = Math.max(bx0, Math.ceil(cx - R)); x <= Math.min(bx1, Math.floor(cx + R)); x++)
        if ((x - cx) ** 2 + (y - cy) ** 2 <= R2) sweep[(y - by0) * bw + (x - bx0)] = 1;
      const x = Math.round(cx), y = Math.round(cy);
      if (x >= 0 && y >= 0 && x < w && y < h && !seenC.has(y * w + x)) { seenC.add(y * w + x); centre.push(y * w + x); }
    };
    for (let k = 0; k < pts.length; k++) {
      const a = pts[Math.max(0, k - 1)], c = pts[k], n = Math.max(1, Math.ceil(Math.hypot(c[0] - a[0], c[1] - a[1]) / Math.max(0.5, Math.min(1, R / 2))));
      for (let t = k ? 1 : 0; t <= n; t++) stamp(a[0] + ((c[0] - a[0]) * t) / n, a[1] + ((c[1] - a[1]) * t) / n);
    }
    if (!centre.length) return null;
    // reference colours: only where the cursor's centre went (the circle's edge may lie on paper)
    const step = Math.max(1, Math.floor(centre.length / 48)), refs = [];
    for (let k = 0; k < centre.length; k += step) { const j = centre[k] * 3; refs.push(lab[j], lab[j + 1], lab[j + 2]); }
    const lim = tol * tol, LW = 0.6 / 2.55;
    const near = (i) => { const j = i * 3, L = lab[j], A = lab[j + 1], B = lab[j + 2]; for (let k = 0; k < refs.length; k += 3) { const dl = (L - refs[k]) * LW, da = A - refs[k + 1], db = B - refs[k + 2]; if (dl * dl + da * da + db * db <= lim) return true; } return false; };
    const region = new Uint8Array(w * h);
    let count = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
      const i = y * w + x;
      if (!sweep[(y - by0) * bw + (x - bx0)] || !(seenC.has(i) || near(i))) continue;
      region[i] = 1; count++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    if (!count) return null;
    return fillHoles({ region, count, x0, y0, x1, y1 }, w, opts.maxHole ?? 40);
  }

  /** selection as flat runs [y, x, length, ...]: small enough to save with an annotation */
  function regionRuns(sel, w) {
    const out = [];
    for (let y = sel.y0; y <= sel.y1; y++) {
      let x = sel.x0;
      while (x <= sel.x1) {
        if (!sel.region[y * w + x]) { x++; continue; }
        const a = x; while (x <= sel.x1 && sel.region[y * w + x]) x++;
        out.push(y, a, x - a);
      }
    }
    return out;
  }

  /** area enclosed by a polygon */
  function polyArea(p) { let a = 0; for (let i = 0, j = p.length - 1; i < p.length; j = i++) a += p[j][0] * p[i][1] - p[i][0] * p[j][1]; return Math.abs(a) / 2; }

  const Smart = { labGrid, magicSelect, quickSelect, fillHoles, regionRuns, gridFromAlpha, distanceField, snapToRidge, trace, smooth, simplify, narrowestChord, polyArea, dist, cumlen, polyLength, pointAt, tangentAt, normalAt, sectionTs, resample, maskSampler, marchWidth,
    computeSections, sectionAt, manualSection, sectionWidthPx, stripSamples, interpWidth, turnAngle, detectFolds, widthStats, mmToImg,
    cleanFolds, segments, segIndexAt, segFrame, foldZones, suggestFolds, crease, ribbons, pointInPoly, markOverlaps, markSectionOverlaps, unfolded, analyze };
  if (typeof module !== "undefined" && module.exports) module.exports = Smart;
  else root.Smart = Smart;
})(typeof window !== "undefined" ? window : globalThis);
