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
    for (const t of sectionTs(n)) {
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

  const Smart = { dist, cumlen, polyLength, pointAt, tangentAt, normalAt, sectionTs, resample, maskSampler, marchWidth,
    computeSections, sectionAt, manualSection, sectionWidthPx, stripSamples, interpWidth, turnAngle, detectFolds, widthStats, mmToImg,
    cleanFolds, segments, segIndexAt, segFrame, foldZones, suggestFolds, crease, ribbons, pointInPoly, markOverlaps, markSectionOverlaps, unfolded, analyze };
  if (typeof module !== "undefined" && module.exports) module.exports = Smart;
  else root.Smart = Smart;
})(typeof window !== "undefined" ? window : globalThis);
