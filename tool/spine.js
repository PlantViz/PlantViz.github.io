// Specimetrics — "Spine" smart marker: UI glue (drawing, dragging, panel). Geometry lives in smart.js (window.Smart).
// Uses tool.js globals (S, V, ctx, toScreen, HIT_TOL, ...) at call time; tool.js loads after this file.
// Widths are APPARENT widths of the outline in the photo; thickness cannot be measured from a photo.
//
// Fold-aware ribbon: a spine may carry folds = [vertex index]. Each segment between folds is drawn as a flat paper
// strip (faces alternate cyan / pale at each fold, like a folded ribbon showing its other side), cut at a red crease.
// Where two segments' strips overlap (a fold-back) the overlap is hatched and labelled "2 layers"; sections there are
// dashed and left out of the mean width. Suggested folds (sharp turns) are hollow red rings until the user accepts.
"use strict";
(function (root) {
  const $ = (id) => document.getElementById(id);   // local: this file loads before tool.js
  const TICK = "#9a9a9a", FOLD = "#ff5a5a", HINT = "rgba(255,90,90,.6)";
  const FACE = [{ fill: "rgba(79,195,247,.35)", line: "#4fc3f7" }, { fill: "rgba(200,240,255,.25)", line: "#bfefff" }];
  const OVER = "rgba(4,30,52,.55)";
  const N_MIN = 3, N_MAX = 15, N_DEFAULT = 5;
  const UI = { strip: true, vtx: null };   // vtx: { id, v } = the spine vertex last clicked (for K / Fold)
  const cache = new WeakMap();
  let maskCache = { canvas: null, inside: null };

  /** mask sampler (mask px) from S.mask: white pixels with alpha 255 = plant; alpha < 128 = not plant */
  function inside() {
    if (!S.mask) return null;
    if (maskCache.canvas !== S.mask) {
      let fn = null;
      try { const d = S.mask.getContext("2d").getImageData(0, 0, S.mask.width, S.mask.height); fn = Smart.maskSampler(d.data, d.width, d.height, { stride: 4, offset: 3, threshold: 128 }); } catch {}
      maskCache = { canvas: S.mask, inside: fn };
    }
    return maskCache.inside;
  }
  /** conversion options: full-res image px -> mask px is x * mask.width / sheet.width; folds of spine o */
  function opts(o) {
    const sh = S.sheet, m = S.mask;
    return { inside: inside(), sx: m ? m.width / sh.width : (sh.mask_ppm || 5) / (sh.px_per_mm || 10), sy: m ? m.height / sh.height : undefined,
      ppm: sh.px_per_mm || null, maskPpm: sh.mask_ppm || 5, maxHalfMm: 25, defaultMm: 2, folds: o ? Smart.cleanFolds(o.points, o.folds) : [] };
  }
  const sel = () => { const o = S.objects.find((x) => x.id === S.selected); return o && o.type === "spine" ? o : null; };
  /** the clicked vertex of spine o, if it is an interior vertex (a fold can only sit there) */
  const selVtx = (o) => (o && UI.vtx && UI.vtx.id === o.id && UI.vtx.v > 0 && UI.vtx.v < o.points.length - 1 ? UI.vtx.v : null);

  function init(o) {
    o.n = Math.max(N_MIN, Math.min(N_MAX, o.n || N_DEFAULT)); o.folds = Smart.cleanFolds(o.points, o.folds);
    o.sections = Smart.computeSections(o.points, o.n, opts(o)); return o;
  }
  const recompute = init;
  /** re-measure placeholder (2 mm, no mask yet) sections once the mask is available; hand-set ones are kept */
  function fillDefaults(o) { const op = opts(o); o.sections = o.sections.map((x) => (x.default ? Smart.sectionAt(o.points, x.t, op) : x)); }

  /** ribbon analysis (segments, samples, creases, ribbons, overlaps, suggestions), cached per spine geometry.
   *  Also stores the overlap flag on the spine's sections. */
  function strip(o) {
    const op = opts(o), manual = (o.sections || []).some((s) => !s.auto);
    const sig = JSON.stringify([o.points, op.folds, (o.sections || []).map((s) => [s.t, s.a, s.b]), manual, !!op.inside, op.ppm]);
    const c = cache.get(o); if (c && c.sig === sig) return c;
    const r = Smart.analyze(o.points, manual ? { ...op, inside: null } : op, o.sections || []);
    o.sections = r.sections;
    Object.assign(r, { sig, manual, measured: r.samples.some((s) => s.measured) }); cache.set(o, r); return r;
  }

  // ---------------------------------------------------------------- canvas
  function line(a, b, color, w, alpha = 1, dash = []) { const p = toScreen(a), q = toScreen(b); ctx.globalAlpha = alpha; ctx.setLineDash(dash); ctx.beginPath(); ctx.moveTo(...p); ctx.lineTo(...q); ctx.strokeStyle = color; ctx.lineWidth = w; ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1; }
  function polyPath(poly) { ctx.beginPath(); poly.forEach((q, i) => { const p = toScreen(q); i ? ctx.lineTo(...p) : ctx.moveTo(...p); }); ctx.closePath(); }
  function tag(text, p, color, dx = 8, dy = 4) {
    ctx.font = "500 10px Inter, system-ui, sans-serif"; const tw = ctx.measureText(text).width + 8;
    ctx.fillStyle = "rgba(0,0,0,.75)"; ctx.fillRect(p[0] + dx - 4, p[1] + dy - 11, tw, 14); ctx.fillStyle = color; ctx.fillText(text, p[0] + dx, p[1] + dy);
  }
  const visible = (o) => o.type === "spine" && o.points.length >= 2 && !(root.overlayShows && !root.overlayShows(o));
  /** ribbons (flat paper strip per segment) and hatched two-layer overlaps, under the organ lines */
  function drawUnder() {
    if (!UI.strip || !S.sheet) return;
    for (const o of S.objects) {
      if (!visible(o)) continue;
      const r = strip(o);
      for (const rb of r.ribbons) { polyPath(rb.poly); ctx.fillStyle = FACE[rb.face].fill; ctx.fill(); ctx.strokeStyle = FACE[rb.face].line; ctx.lineWidth = 1; ctx.globalAlpha = 0.9; ctx.stroke(); ctx.globalAlpha = 1; }
      for (const ov of r.overlaps) {
        const A = r.ribbons.find((x) => x.seg === ov.segs[0]), B = r.ribbons.find((x) => x.seg === ov.segs[1]); if (!A || !B) continue;
        ctx.save(); polyPath(A.poly); ctx.clip(); polyPath(B.poly); ctx.fillStyle = OVER; ctx.fill(); ctx.clip();
        const pts = B.poly.map(toScreen), xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
        ctx.strokeStyle = "rgba(191,239,255,.55)"; ctx.lineWidth = 1; ctx.beginPath();
        for (let d = x0 - (y1 - y0); d < x1; d += 6) { ctx.moveTo(d, y1); ctx.lineTo(d + (y1 - y0), y0); }
        ctx.stroke(); ctx.restore();
      }
    }
  }
  function drawOver() {
    if (!S.sheet) return;
    const s0 = sel();
    for (const o of S.objects) {
      if (!visible(o)) continue;
      if (!o.sections) init(o);
      else if (o.sections.some((x) => x.default) && inside()) fillDefaults(o);   // mask arrived after the spine was drawn
      const on = o === s0 || o.id === S.hot, r = strip(o);
      if (r.segs.length > 1) for (const sg of r.segs) {   // spine segments in their face colour (dark / light)
        const sp = sg.pts.map(toScreen); ctx.beginPath(); sp.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
        ctx.strokeStyle = sg.face ? "#bfefff" : "#2b9fd8"; ctx.lineWidth = on ? 3 : 2; ctx.lineJoin = ctx.lineCap = "round"; ctx.stroke();
      }
      o.sections.forEach((s) => {
        const dash = s.overlap ? [4, 3] : [], col = s.auto || s.default ? TICK : "#fff";
        line(s.a, s.b, "rgba(0,0,0,.6)", 3.5); line(s.a, s.b, col, 1.5, 1, dash);
        if (on) for (const e of [s.a, s.b]) { const p = toScreen(e); ctx.fillStyle = s.auto ? "#000" : "#fff"; ctx.beginPath(); ctx.arc(p[0], p[1], 3.5, 0, 7); ctx.fill(); ctx.strokeStyle = TICK; ctx.lineWidth = 1; ctx.stroke(); }
        if (on || V.s > 0.6) {
          const w = S.sheet.px_per_mm ? `${(Smart.sectionWidthPx(s) / S.sheet.px_per_mm).toFixed(2)}` : `${Smart.sectionWidthPx(s).toFixed(0)} px`;
          tag(s.overlap ? `${w} (2 layers)` : w, toScreen(s.b), col, 9, 4);
        }
      });
      for (const cr of r.creases) {   // crease: red line across the ribbon along the bisector of the two segment directions
        line(cr.a, cr.b, "rgba(0,0,0,.7)", 4.5); line(cr.a, cr.b, FOLD, 2.2);
        tag("fold", toScreen(cr.b), FOLD, 6, 4);
      }
      for (const ov of r.overlaps) tag("2 layers", toScreen(ov.at), "#bfefff", -26, 4);
      for (const sg of r.suggestions) {
        const p = toScreen(sg.p); ctx.setLineDash([3, 2]); ctx.strokeStyle = FOLD; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.arc(p[0], p[1], 9, 0, 7); ctx.stroke(); ctx.setLineDash([]);
        tag(`fold? ${sg.angle.toFixed(0)}°`, p, FOLD, 13, 4);
      }
      if (on) for (const h of r.hints) {
        const p = toScreen(h.p); ctx.strokeStyle = HINT; ctx.lineWidth = 1; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.arc(p[0], p[1], 7, 0, 7); ctx.stroke(); ctx.setLineDash([]);
        tag("width jump", p, HINT, 10, 14);
      }
      const v = selVtx(o);
      if (o === s0 && v != null) { const p = toScreen(o.points[v]); ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(p[0], p[1], 7, 0, 7); ctx.stroke(); }
    }
  }

  // ---------------------------------------------------------------- editing
  /** a section end of the selected spine near image point p */
  function hitSection(p) {
    const o = sel(); if (!o || !o.sections) return null;
    let best = null, bd = HIT_TOL / V.s;
    o.sections.forEach((s, k) => { for (const end of ["a", "b"]) { const d = Smart.dist(p, s[end]); if (d < bd) { bd = d; best = { o, k, end }; } } });
    return best;
  }
  function dragSection(h, p) {
    const s = h.o.sections[h.k], a = h.end === "a" ? p : s.a, b = h.end === "b" ? p : s.b;
    h.o.sections[h.k] = Smart.manualSection(s, a, b, S.sheet.px_per_mm);
  }
  function setN(o, n) { n = Math.max(N_MIN, Math.min(N_MAX, n)); if (n === o.n) return; snapshot(); o.n = n; init(o); if (o.source === "model") o.source = "edited"; changed(); }
  /** mark / unmark folds (vertex indices); sections are re-measured per segment */
  function setFolds(o, folds, msg) {
    snapshot(); o.folds = Smart.cleanFolds(o.points, folds); init(o); if (o.source === "model") o.source = "edited";
    changed(); if (msg) toast(msg);
  }
  function toggleFold(o, v) {
    const f = Smart.cleanFolds(o.points, o.folds), had = f.includes(v);
    setFolds(o, had ? f.filter((i) => i !== v) : [...f, v], had ? "Fold removed" : "Fold marked (K to unmark)");
  }
  function acceptSuggestions(o) {
    const sg = strip(o).suggestions; if (!sg.length) return false;
    setFolds(o, [...(o.folds || []), ...sg.map((x) => x.i)], `${sg.length} fold${sg.length > 1 ? "s" : ""} marked`); return true;
  }
  /** tool.js: a spine vertex was pressed (moved = it was dragged). A click on a suggested fold accepts it. */
  function clickVertex(o, v, moved) {
    UI.vtx = { id: o.id, v };
    if (!moved && strip(o).suggestions.some((x) => x.i === v)) { toggleFold(o, v); return; }
    panel(); draw();
  }
  function key(k) {
    const o = sel();
    if (k === "r") { UI.strip = !UI.strip; toast(`Ribbon view ${UI.strip ? "on" : "off"}`); panel(); draw(); return true; }
    if (o && (k === "+" || k === "=")) { setN(o, o.n + 1); return true; }
    if (o && (k === "-" || k === "_")) { setN(o, o.n - 1); return true; }
    if (o && k === "k") {
      const v = selVtx(o);
      if (v != null) toggleFold(o, v);
      else if (!acceptSuggestions(o)) toast("Click an inner spine vertex first, then K");
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- panel
  function renderPanel() {
    const box = $("spineBox"); if (!box) return;
    const o = sel(); if (!o || !S.sheet) { box.hidden = true; box.innerHTML = ""; return; }
    if (!o.sections) init(o);
    else if (o.sections.some((x) => x.default) && inside()) fillDefaults(o);
    const r = strip(o), ppm = S.sheet.px_per_mm, u = ppm ? "mm" : "px", k = ppm || 1, st = Smart.widthStats(o.sections, ppm), f2 = (x) => (x == null ? "—" : x.toFixed(ppm ? 2 : 0));
    const len = (px) => (ppm ? (px / ppm).toFixed(1) : px.toFixed(0)), L = r.unfolded.total, v = selVtx(o), isFold = v != null && (o.folds || []).includes(v);
    const segTxt = r.segs.length > 1 ? `${r.segs.length} segments: ${r.segs.map((g) => len(g.len)).join(" + ")} ${u} · ${r.creases.length} fold${r.creases.length > 1 ? "s" : ""} (${r.creases.map((c) => `${c.turn.toFixed(0)}°`).join(", ")})` : "one segment · no folds marked";
    const sugTxt = r.suggestions.length ? ` · <span style="color:${FOLD}">${r.suggestions.length} suggested</span> (click the red ring or K)` : "";
    const hintTxt = r.hints.length ? ` · width jump at ${r.hints.map((h) => len(h.s)).join(", ")} ${u} (weak hint)` : "";
    const secTxt = o.sections.map((s) => `${f2(Smart.sectionWidthPx(s) / k)}${s.overlap ? " <b>(2 layers)</b>" : ""}`).join(" · ");
    box.hidden = false;
    box.innerHTML = `<div class="k">Spine · apparent width (from the image)</div>
      <div class="big">${ppm ? fmtLen(L / ppm) : L.toFixed(0) + " px"}<span class="sub"> unfolded</span></div>
      <div class="sub">${segTxt}</div>
      <div class="sub">width mean <b>${f2(st.mean)}</b> · min ${f2(st.min)} · max ${f2(st.max)} ${u}${st.excluded ? ` · ${st.excluded} over 2 layers left out` : ""}${o.sections.some((s) => !s.auto && !s.default) ? " · white = set by hand" : ""}${!S.mask ? " · no mask yet: default 2 mm, drag the ends" : o.sections.some((s) => s.default) ? " · not on the plant mask: default 2 mm, drag the ends" : ""}</div>
      <div class="rowx"><span class="k">Sections</span><button class="small" id="spMinus" title="Fewer sections (−)">−</button><span class="sub" style="min-width:18px;text-align:center">${o.n}</span><button class="small" id="spPlus" title="More sections (+)">+</button><span class="grow"></span>
        <button class="small${isFold ? " on" : ""}" id="spFold" ${v == null ? "disabled" : ""} title="${v == null ? "Click an inner spine vertex first" : isFold ? "Unmark the fold at the selected vertex (K)" : "Mark a fold at the selected vertex (K)"}">Fold</button>
        <button class="small${UI.strip ? " on" : ""}" id="spStrip" title="Ribbon view (R)">Ribbon</button></div>
      <canvas id="spChart" width="560" height="150"></canvas>
      <div class="sub">Folds: ${r.creases.length} marked${sugTxt}${r.suggestions.length ? ' <button class="small" id="spAccept" title="Mark all suggested folds">Accept</button>' : ""}${hintTxt}${r.manual ? " · ribbon follows your sections" : r.measured ? "" : " · ribbon interpolated from sections"}</div>
      <div class="sub">Sections: ${secTxt}</div>
      <div class="sub note">Apparent width; thickness cannot be measured from a photo. Each segment between folds is measured perpendicular to itself; where two layers overlap, widths are left out.</div>`;
    $("spMinus").onclick = () => setN(o, o.n - 1); $("spPlus").onclick = () => setN(o, o.n + 1);
    $("spStrip").onclick = () => key("r"); $("spFold").onclick = () => { const w = selVtx(o); if (w != null) toggleFold(o, w); };
    const acc = $("spAccept"); if (acc) acc.onclick = () => acceptSuggestions(o);
    unfoldedChart($("spChart"), o, r, ppm);
  }
  /** the whole spine straightened: x = arc length, half-height = apparent width (exaggerated), faces per segment */
  function unfoldedChart(c, o, r, ppm) {
    const g = c.getContext("2d"), W = c.width, H = c.height, k = ppm || 1, U = r.unfolded, L = U.total || 1, pad = { l: 10, r: 10, t: 26, b: 28 };
    g.clearRect(0, 0, W, H);
    const prof = U.profile, maxW = Math.max(1e-6, ...prof.map((p) => p.w), ...o.sections.map(Smart.sectionWidthPx));
    const X = (s) => pad.l + (s / L) * (W - pad.l - pad.r), y0 = pad.t + (H - pad.t - pad.b) / 2, ky = ((H - pad.t - pad.b) / maxW) * 0.95, Yh = (w) => (w / 2) * ky;
    g.font = "18px Inter, sans-serif"; g.textBaseline = "alphabetic";
    for (const sg of U.segs) {
      const pts = prof.filter((p) => p.seg === sg.k); if (pts.length < 2) continue;
      g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(X(p.s), y0 - Yh(p.w)) : g.moveTo(X(p.s), y0 - Yh(p.w)))); for (let i = pts.length - 1; i >= 0; i--) g.lineTo(X(pts[i].s), y0 + Yh(pts[i].w)); g.closePath();
      g.fillStyle = FACE[sg.face].fill; g.fill(); g.strokeStyle = FACE[sg.face].line; g.lineWidth = 1.5; g.stroke();
      let run = null;   // overlap runs: hatched, dashed outline
      const flush = () => {
        if (!run) return; const x0 = X(run[0]), x1 = Math.max(X(run[1]), x0 + 2), h = Yh(run[2]);
        g.save(); g.beginPath(); g.rect(x0, y0 - h, x1 - x0, 2 * h); g.fillStyle = OVER; g.fill(); g.clip();
        g.strokeStyle = "rgba(191,239,255,.6)"; g.lineWidth = 1; g.beginPath(); for (let d = x0 - 2 * h; d < x1; d += 7) { g.moveTo(d, y0 + h); g.lineTo(d + 2 * h, y0 - h); } g.stroke(); g.restore();
        g.setLineDash([5, 4]); g.strokeStyle = "#bfefff"; g.lineWidth = 1.5; g.strokeRect(x0, y0 - h, x1 - x0, 2 * h); g.setLineDash([]); run = null;
      };
      for (const p of pts) { if (p.overlap) run = run ? [run[0], p.s, Math.max(run[2], p.w)] : [p.s, p.s, p.w]; else flush(); }
      flush();
      const lab = `${(sg.len / k).toFixed(ppm ? 1 : 0)}`, cx = (X(sg.s0) + X(sg.s1)) / 2, tw = g.measureText(lab).width;
      if (X(sg.s1) - X(sg.s0) > tw + 6) { g.fillStyle = FACE[sg.face].line; g.fillText(lab, cx - tw / 2, pad.t - 8); }
    }
    for (const s of o.sections) { const x = X(s.t * L), h = Yh(Smart.sectionWidthPx(s)); g.setLineDash(s.overlap ? [4, 3] : []); g.strokeStyle = s.auto ? "#d0d0d0" : "#fff"; g.lineWidth = 2; g.beginPath(); g.moveTo(x, y0 - h); g.lineTo(x, y0 + h); g.stroke(); g.setLineDash([]); }
    for (const fs of U.folds) { g.strokeStyle = FOLD; g.lineWidth = 3; g.beginPath(); g.moveTo(X(fs), pad.t - 4); g.lineTo(X(fs), H - pad.b + 4); g.stroke(); }
    g.fillStyle = "#8a8a8a"; g.fillText("0", pad.l, H - 6);
    const ex = ky / ((W - pad.l - pad.r) / L), end = `${(L / k).toFixed(ppm ? 1 : 0)} ${ppm ? "mm" : "px"} unfolded · max width ${(maxW / k).toFixed(ppm ? 1 : 0)}${ex > 1.5 ? ` · width ×${ex.toFixed(0)}` : ""}`;
    g.fillText(end, W - pad.r - g.measureText(end).width, H - 6);
  }

  root.Spine = { init, recompute, hitSection, dragSection, key, clickVertex, drawUnder, drawOver, panel: renderPanel, strip, UI, N_MIN, N_MAX };
})(window);
