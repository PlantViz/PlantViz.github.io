// Specimetrics — "key" (representative) organs: a few clearly visible blades and culms per sheet, so the
// overlay and the summary can show a handful of trustworthy measurements instead of every line.
// Pure geometry, no DOM: browser window.Represent, Node module.exports (tests/represent.test.js).
//
// Score per organ (blade / culm) = length (mm)
//   × clear      (1 − fraction of its length lying within nearMm of another organ)
//   × crossings  1 / (1 + 0.6 · d), d = other organs touching its interior (ends excluded: tufts share a base)
//                per 50 mm of its length
//   × flags      broken / not intact / folded / rolled / truncated / no base / uncertain
//   × width      0.75 when it has no usable width line (one crossing > 1 other organ, a blade width > 15 % of
//                its length, or > 3x the sheet's median width is not usable)
//   × model      class fragment / artefact / fine → 0.2; confidence c → 0.3 + 0.7 c
//   × shape      tortuosity (path / chord) above 1.3; hairpin turns (> 100° within ~6 mm: the trace jumped);
//                kinks (> 60° over ~18 mm) 1 / (1 + 0.25 n); straight segments > 15 mm (a bridged gap) × (1 − 0.5 f);
//   × rim        × (1 − 0.7 f), f = fraction of points within 4 % of the image border (ruler / colour chart / edge);
//                dead straight axis-aligned lines (ruler / tape / paper edge) × 0.4, along the image border × 0.3;
//                neither donates a width line
//   × source     human 1.5, edited 1.3 (a corrected organ is preferred)
// Then greedy by score, skipping organs whose midpoint is within spreadMm of one already picked (same type).
// Explicit pins override: key === true always picked (first), key === false never.
// Width lines: those on key organs; if fewer than K, filled from the best-scoring organs that have one.
"use strict";
(function (root) {
  const ORGANS = ["blade", "culm"], WIDTH_OF = { blade: "blade_width", culm: "culm_width" };
  const K_MIN = 1, K_MAX = 8, K_DEFAULT = { blade: 3, culm: 2 };
  const clampK = (k, d) => Math.max(K_MIN, Math.min(K_MAX, Math.round(Number.isFinite(+k) ? +k : d)));

  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const plen = (p) => { let L = 0; for (let i = 1; i < p.length; i++) L += dist(p[i - 1], p[i]); return L; };
  function segDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  }
  /** point at arc-length fraction u (0..1) of a polyline */
  function at(p, u) {
    const goal = plen(p) * u; let acc = 0;
    for (let i = 1; i < p.length; i++) { const L = dist(p[i - 1], p[i]); if (acc + L >= goal && L > 0) { const s = (goal - acc) / L; return [p[i - 1][0] + (p[i][0] - p[i - 1][0]) * s, p[i - 1][1] + (p[i][1] - p[i - 1][1]) * s]; } acc += L; }
    return p[p.length - 1];
  }
  /** samples every `step` px along a polyline: [{p, u}] (u = arc-length fraction) */
  function samples(p, step) {
    const L = plen(p), n = Math.max(2, Math.ceil(L / step) + 1), out = [];
    let i = 1, acc = 0;
    for (let k = 0; k < n; k++) {
      const goal = (L * k) / (n - 1);
      while (i < p.length - 1 && acc + dist(p[i - 1], p[i]) < goal) { acc += dist(p[i - 1], p[i]); i++; }
      const S = dist(p[i - 1], p[i]), s = S ? Math.min(1, (goal - acc) / S) : 0;
      out.push({ p: [p[i - 1][0] + (p[i][0] - p[i - 1][0]) * s, p[i - 1][1] + (p[i][1] - p[i - 1][1]) * s], u: L ? goal / L : 0 });
    }
    return out;
  }

  /** uniform grid of segments (bbox prefilter): cell -> [{id, a, b}] */
  function segmentGrid(organs, cell, pad) {
    const g = new Map();
    for (const o of organs) for (let i = 1; i < o.points.length; i++) {
      const a = o.points[i - 1], b = o.points[i];
      const x0 = Math.floor((Math.min(a[0], b[0]) - pad) / cell), x1 = Math.floor((Math.max(a[0], b[0]) + pad) / cell);
      const y0 = Math.floor((Math.min(a[1], b[1]) - pad) / cell), y1 = Math.floor((Math.max(a[1], b[1]) + pad) / cell);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const k = x + "," + y; let c = g.get(k); if (!c) g.set(k, (c = [])); c.push({ id: o.id, a, b }); }
    }
    return g;
  }

  const valid = (o) => o && Array.isArray(o.points) && o.points.length >= 2;
  /** parent organ of a width line: its `parent` if present, else the organ (matching type) whose polyline is nearest the line's midpoint */
  function defaultParentOf(objects) {
    const byId = new Map(objects.map((o) => [o.id, o]));
    return (w) => {
      if (w.parent && byId.has(w.parent)) return byId.get(w.parent);
      const t = w.type === "blade_width" ? "blade" : "culm", m = [(w.points[0][0] + w.points[1][0]) / 2, (w.points[0][1] + w.points[1][1]) / 2];
      let best = null, bd = Infinity;
      for (const x of objects) { if (x.type !== t || !valid(x)) continue; for (let i = 1; i < x.points.length; i++) { const d = segDist(m, x.points[i - 1], x.points[i]); if (d < bd) { bd = d; best = x; } } }
      return best;
    };
  }

  const FLAG_W = { broken_tip: 0.5, folded: 0.7, rolled: 0.85, truncated: 0.6, uncertain: 0.5, unsure: 0.5, damaged: 0.5, overlapping: 0.7 };
  function flagWeight(o) {
    const f = o.flags || {}; let w = 1;
    for (const [k, x] of Object.entries(FLAG_W)) if (f[k]) w *= x;
    if (o.type === "blade" && f.intact === false) w *= 0.5;
    if (o.type === "culm" && f.base_present === false) w *= 0.7;
    return w;
  }
  function modelWeight(o) {
    let w = 1; const cls = String(o.class || o.kind || o.label || "").toLowerCase();
    if (/fragment|artefact|artifact|fine|noise/.test(cls)) w *= 0.2;
    const c = Number(o.confidence ?? o.conf ?? o.score);
    if (Number.isFinite(c) && c >= 0 && c <= 1) w *= 0.3 + 0.7 * c;
    return w;
  }
  function tortuosity(o) {
    if (Number.isFinite(+o.tortuosity) && +o.tortuosity >= 1) return +o.tortuosity;
    const ch = dist(o.points[0], o.points[o.points.length - 1]);
    return ch > 0 ? plen(o.points) / ch : Infinity;
  }
  const shapeWeight = (t) => (t <= 1.3 ? 1 : Math.max(0.15, 1 - (t - 1.3) * 1.2));
  /** hairpin turns (> 100° over ~6 mm or ~18 mm): a trace that jumped onto a neighbouring organ, not a real leaf */
  function hairpins(o, ppm, deg = 100, windows = [2, 6]) {
    const q = samples(o.points, 3 * ppm).map((s) => s.p), lim = Math.cos((deg * Math.PI) / 180);
    let most = 0;
    for (const w of windows) {   // directions over w samples (3 mm each) before / after each sample
      let n = 0, inTurn = false;
      for (let i = w; i + w < q.length; i++) {
        const a = [q[i][0] - q[i - w][0], q[i][1] - q[i - w][1]], b = [q[i + w][0] - q[i][0], q[i + w][1] - q[i][1]];
        const sharp = (a[0] * b[0] + a[1] * b[1]) / (Math.hypot(...a) * Math.hypot(...b) || 1) < lim;
        if (sharp && !inTurn) n++; inTurn = sharp;
      }
      most = Math.max(most, n);
    }
    return most;
  }
  /** fraction of the length in single straight segments over 15 mm: the tracer bridged a gap it could not see */
  function bridged(o, ppm) {
    let long = 0; for (let i = 1; i < o.points.length; i++) { const d = dist(o.points[i - 1], o.points[i]); if (d > 15 * ppm) long += d; }
    return long / Math.max(1e-9, plen(o.points));
  }
  /** fraction of the points within 4 % of the image border (ruler, colour chart, paper edge live there) */
  function atRim(o, W, H) {
    if (!(W > 0 && H > 0)) return 0;
    const mx = 0.04 * W, my = 0.04 * H;
    return o.points.filter((p) => p[0] < mx || p[0] > W - mx || p[1] < my || p[1] > H - my).length / o.points.length;
  }
  /** dead straight (path / chord < 1.01) and axis-aligned (< 2°) over 20 mm: a ruler, tape or paper edge rather
   *  than a plant organ (a traced organ always wiggles a little). 2 = also hugging the image border (within 5 %;
   *  needs opts.width / height), 1 = elsewhere, 0 = not ruled. */
  function ruled(o, ppm, tort, W, H) {
    if (tort >= 1.01 || plen(o.points) < 20 * ppm) return 0;
    const a = o.points[0], b = o.points[o.points.length - 1], ang = Math.abs(Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI) % 90;
    if (!(ang < 2 || ang > 88)) return 0;
    if (!(W > 0 && H > 0)) return 1;
    const mx = 0.05 * W, my = 0.05 * H;
    return o.points.every((p) => p[0] < mx || p[0] > W - mx) || o.points.every((p) => p[1] < my || p[1] > H - my) ? 2 : 1;
  }
  const sourceWeight = (o) => (o.source === "human" ? 1.5 : o.source === "edited" ? 1.3 : 1);

  /**
   * Score every blade / culm. opts: ppm (px per mm; null -> 10), nearMm (1), parentOf(width) -> organ, width / height (image px).
   * Returns [{o, id, type, mm, score, clear, crossers, tort, hasWidth, mid}], best first.
   */
  function rank(objects, opts = {}) {
    objects = (objects || []).filter(valid);
    const ppm = opts.ppm > 0 ? opts.ppm : 10, near = (opts.nearMm ?? 1) * ppm;
    const organs = objects.filter((o) => ORGANS.includes(o.type));
    if (!organs.length) return [];
    const parentOf = opts.parentOf || defaultParentOf(objects);
    const cell = Math.max(near * 4, 5 * ppm), grid = segmentGrid(organs, cell, near);
    /** ids of organs (other than `skip`) passing within `near` of the polyline, sampled for u in (lo, hi) */
    function touching(points, skip, lo, hi, onSample) {
      const ids = new Set();
      for (const { p, u } of samples(points, Math.max(1, near))) {
        const c = grid.get(Math.floor(p[0] / cell) + "," + Math.floor(p[1] / cell)); let hitAny = false;
        if (c) for (const s of c) {
          if (s.id === skip) continue;
          if (Math.min(s.a[0], s.b[0]) - near > p[0] || Math.max(s.a[0], s.b[0]) + near < p[0] || Math.min(s.a[1], s.b[1]) - near > p[1] || Math.max(s.a[1], s.b[1]) + near < p[1]) continue;
          if (segDist(p, s.a, s.b) <= near) { hitAny = true; if (u > lo && u < hi) ids.add(s.id); }
        }
        if (onSample) onSample(hitAny);
      }
      return ids;
    }
    // width lines: one that crosses other organs is probably measuring across a bundle, not one organ
    // also implausible: a blade width over 15 % of the blade's length (grass blades are long and narrow), or a
    // width more than 3x the sheet's median width of that type (the model measured across a bundle or a fold)
    const widthsBy = new Map(), wlines = objects.filter((w) => w.type === "blade_width" || w.type === "culm_width");
    const med = (a) => { const s = [...a].sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
    const medW = {}; for (const t of ["blade_width", "culm_width"]) medW[t] = med(wlines.filter((w) => w.type === t).map((w) => dist(w.points[0], w.points[1])));
    for (const w of wlines) {
      const p = parentOf(w); if (!p) continue;
      const cross = touching(w.points, p.id, 0.1, 0.9); cross.delete(p.id);
      const len = dist(w.points[0], w.points[1]), wl = len / Math.max(1e-9, plen(p.points)), rel = medW[w.type] ? len / medW[w.type] : 1;
      const plausible = !(p.type === "blade" && wl > 0.15) && rel <= 3;
      const q = (1 / (1 + cross.size)) * (p.type === "blade" && wl > 0.1 ? 0.6 : 1) * (plausible ? 1 : 0.3);
      if (!widthsBy.has(p.id)) widthsBy.set(p.id, []);
      widthsBy.get(p.id).push({ id: w.id, crossers: cross.size, ok: cross.size <= 1 && plausible, q });
    }
    const out = [];
    for (const o of organs) {
      const L = plen(o.points); let covered = 0, n = 0;
      const crossers = touching(o.points, o.id, 0.08, 0.92, (hit) => { n++; if (hit) covered++; });
      const widths = widthsBy.get(o.id) || [], usable = widths.filter((w) => w.ok);
      const clear = 1 - covered / Math.max(1, n), tort = tortuosity(o), hasWidth = usable.length > 0, pins = hairpins(o, ppm), kinks = Math.max(0, hairpins(o, ppm, 60, [6]) - pins), gap = bridged(o, ppm), edge = ruled(o, ppm, tort, opts.width, opts.height), rim = atRim(o, opts.width, opts.height);
      // crossings per 50 mm: long organs naturally cross more, but each crossing is a chance the trace jumped
      const density = crossers.size / Math.max(1, L / ppm / 50);
      const score = (L / ppm) * clear * (1 / (1 + 0.6 * density)) * flagWeight(o) * (hasWidth ? 1 : 0.75)
        * modelWeight(o) * shapeWeight(tort) * sourceWeight(o) * (1 / (1 + 0.7 * pins)) * (1 / (1 + 0.25 * kinks)) * (1 - 0.5 * gap) * (edge === 2 ? 0.3 : edge === 1 ? 0.4 : 1) * (1 - 0.7 * rim);
      const widthScore = hasWidth && !edge ? score * Math.max(...usable.map((w) => w.q)) : 0;
      out.push({ o, id: o.id, type: o.type, mm: L / ppm, score, widthScore, clear, crossers: crossers.size, tort, hairpins: pins, kinks, bridged: gap, hasWidth, widths, mid: at(o.points, 0.5) });
    }
    return out.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  }

  function ks(opts) { const k = opts.k || {}; return { blade: clampK(k.blade, K_DEFAULT.blade), culm: clampK(k.culm, K_DEFAULT.culm) }; }
  /** greedy choice with pins and spread; `cand` ranked best first */
  function choose(cand, K, spread) {
    const chosen = [];
    for (const r of cand) if (r.o.key === true) chosen.push(r);   // pins first, even beyond K
    for (const r of cand) {
      if (chosen.length >= K) break;
      if (r.o.key === true || r.o.key === false) continue;
      if (chosen.some((c) => dist(c.mid, r.mid) < spread)) continue;
      chosen.push(r);
    }
    return chosen;
  }

  /**
   * Key organ ids: pins first, then the K best per type (blades then culms).
   * opts: ppm, k: {blade, culm} (1..8; default 3 / 2), nearMm (1), spreadMm (15), parentOf.
   */
  function pick(objects, opts = {}) { return pickAll(objects, opts).organs; }

  /**
   * Key sets for every measurement: {organs, blade, culm, blade_width, culm_width, wl, widthDonors, ranked}.
   * blade_width / culm_width: width-line ids — those on key organs, topped up to K from the best organs that have one.
   * wl: blade ids with a key width (W:L needs both). widthDonors: organs used only for their width line.
   */
  function pickAll(objects, opts = {}) {
    const empty = { organs: [], blade: [], culm: [], blade_width: [], culm_width: [], wl: [], widthDonors: [], ranked: [] };
    objects = (objects || []).filter(valid); if (!objects.length) return empty;
    const ppm = opts.ppm > 0 ? opts.ppm : 10, spread = (opts.spreadMm ?? 15) * ppm, K = ks(opts);
    const parentOf = opts.parentOf || defaultParentOf(objects);
    const ranked = rank(objects, { ...opts, parentOf });
    const res = { ...empty, ranked };
    for (const t of ORGANS) {
      const cand = ranked.filter((r) => r.type === t), chosen = choose(cand, K[t], spread);
      res[t] = chosen.map((r) => r.id);
      // widths: clear width lines on key organs first (all widths of a pinned organ), then the organs with the
      // best clear width lines (not excluded), spread out, until there are K
      const usable = (r) => r.widths.filter((w) => w.ok || r.o.key === true);
      const wsrc = chosen.filter((r) => usable(r).length);
      for (const r of [...cand].sort((x, y) => y.widthScore - x.widthScore)) {
        if (wsrc.length >= K[t]) break;
        if (r.o.key === false || !(r.widthScore > 0) || wsrc.includes(r)) continue;
        if (wsrc.some((c) => dist(c.mid, r.mid) < spread)) continue;
        wsrc.push(r); res.widthDonors.push(r.id);
      }
      res[WIDTH_OF[t]] = wsrc.flatMap((r) => usable(r).map((w) => w.id));
      if (t === "blade") res.wl = wsrc.map((r) => r.id);
    }
    res.organs = [...res.blade, ...res.culm];
    return res;
  }

  /** mean, sample sd (null for n < 2), n */
  function stats(v) {
    const a = (v || []).filter((x) => x != null && isFinite(x)), n = a.length;
    if (!n) return { mean: null, sd: null, n: 0 };
    const mean = a.reduce((s, x) => s + x, 0) / n;
    return { mean, sd: n > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : null, n };
  }

  const api = { pick, pickAll, rank, stats, clampK, K_MIN, K_MAX, K_DEFAULT };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Represent = api;
})(typeof window !== "undefined" ? window : globalThis);
