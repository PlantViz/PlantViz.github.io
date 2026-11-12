// Specimetrics — web tool: 10 example sheets × 3 models, with editing.
// Results are published by the project server, AES-256-GCM encrypted (key = PBKDF2-SHA256 of the passphrase),
// and decrypted here in the browser. Sheet images load from each herbarium's own server.
// Corrections are saved in this browser (localStorage) and can be exported as a JSON file for the project server.
"use strict";

const TYPES = {
  blade:       { geom: "poly", color: "#7ee787", label: "Blade" },
  culm:        { geom: "poly", color: "#ffb547", label: "Culm" },
  blade_width: { geom: "line", color: "#7ee787", label: "Blade width", thin: true },
  culm_width:  { geom: "line", color: "#ffb547", label: "Culm width", thin: true },
  spine:       { geom: "poly", color: "#6cc4ff", label: "Spine" },   // smart marker (spine.js / smart.js)
  contour:     { geom: "poly", color: "#d7b4ff", label: "Contour", closed: true },
};
const FLAGS = {
  blade: [["intact", "Intact", true], ["broken_tip", "Broken"], ["folded", "Folded"], ["rolled", "Rolled"]],
  culm: [["base_present", "Base", true], ["truncated", "Truncated"], ["folded", "Folded"]],
};
const TOOL_KEYS = { v: "select", b: "blade", c: "culm", w: "blade_width", d: "culm_width", t: "spine", l: "contour", a: "brush_add", e: "brush_del", g: "wand_add", x: "wand_del", q: "quick_add" };
const TRACED = { blade: 1, culm: 1, spine: 1 }, BRUSH = { brush_add: 1, brush_del: 1 }, MAGIC = { wand_add: 1, wand_del: 1 }, QUICK = { quick_add: 1, quick_del: 1 }, MASK_TOOL = { ...BRUSH, ...MAGIC, ...QUICK };   // tools that follow the plant mask; mask brushes
const FINE_COL = { fine: "#8b93ff", artefact: "#777" };
const ALL_VIEWS = [["photo", "Photo"], ["plant", "Plant only"], ["mask", "Mask"], ["depth", "Depth"], ["label", "Training label"]];
let VIEWS = ALL_VIEWS.slice(0, 3);
const RUN_LABEL = { seg_r1: "Model 1", seg_r2_depth: "Model 2 · depth", seg_r3: "Model 3" };
const HIT_TOL = 8, MAX_ZOOM = 12, CLICK_TOL = 4;
const TRAITS = [
  { key: "all", label: "All" },
  { key: "blade_length", label: "Blade length", type: "blade", unit: "mm", value: (o) => mm(plen(o.points)), hi: (o) => o.type === "blade" },
  { key: "blade_width", label: "Blade width", type: "blade_width", unit: "mm", dp: 2, value: (o) => mm(dist(...o.points)), hi: (o) => o.type === "blade_width" || o.type === "blade" },
  { key: "wl", label: "W : L", type: "blade", unit: "", dp: 3,
    value: (o) => { const w = widthsOf(o); return w.length ? mm(Math.max(...w.map((x) => dist(...x.points)))) / mm(plen(o.points)) : null; },
    hi: (o) => o.type === "blade" || o.type === "blade_width" },
  { key: "culm_length", label: "Culm length", type: "culm", unit: "mm", value: (o) => mm(plen(o.points)), hi: (o) => o.type === "culm" },
  { key: "culm_diameter", label: "Culm diameter", type: "culm_width", unit: "mm", dp: 2, value: (o) => (2 * mm(dist(...o.points))) / Math.PI,
    hi: (o) => o.type === "culm_width" || o.type === "culm", note: "⌀ = 2w/π from pressed (flattened) width" },
];

// Predicted organ lines and widths are switched off for now: sheets start empty and only lines people draw exist.
// Set to true to bring them back (Yours / Key / All / Off, the "Model (original)" version, numbers from predictions).
const SHOW_PREDICTED = false;
const PV_esc = (t) => String(t ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const $ = (id) => document.getElementById(id);
const cv = $("c"), ctx = cv.getContext("2d");
const off = document.createElement("canvas"), octx = off.getContext("2d");
const V = { s: 1, tx: 0, ty: 0, W: 0, H: 0, dpr: 1 };
const S = { key: null, plain: false, meta: null, idx: 0, run: "seg_r3", sheet: null, objects: [], img: null, small: null, mask: null, maskTint: null,
  imgFor: null, extra: {}, trait: "all", view: "photo", tool: "select", selected: null, hot: null, press: null, drawing: null, cursor: null,
  undo: [], dirty: false, rev: 0, snap: true, manual: false, space: false, preview: null, field: null, maskBase: null, maskSig: "", stroke: null, brushPx: 14, alt: false, insertMode: false, selVtx: null, extending: null, savedSig: null, maskModel: null, tol: 18, connected: true, lastMagic: null, photo: null, overlay: SHOW_PREDICTED && new URLSearchParams(location.search).has("from") ? "key" : "mine", keyK: { ...Represent.K_DEFAULT } };
// Overlay mode: "mine" = only lines people drew or edited (no predicted lines); "key" = those plus representative organs (represent.js) and the width lines of the key set; "all" = every line;
// "off" = none. The selected / hovered object and anything being drawn always show; so do user-drawn spines and the B overlay.
const OVERLAYS = !SHOW_PREDICTED ? [["mine", "On", "Show the lines people drew or edited (O)"], ["off", "Off", "Hide the lines; pick from the list on the right (O)"]] : [["mine", "Yours", "Only lines people drew or edited; predicted lines hidden (O)"], ["key", "Key", "Your lines plus a few clearly visible predicted organs and their width lines (O)"], ["all", "All", "Every measurement line (O)"], ["off", "Off", "No measurement lines; pick from the list on the right (O)"]];
try { const m = localStorage.getItem("pv_overlay"); if (OVERLAYS.some(([k]) => k === m)) S.overlay = m; const k = JSON.parse(localStorage.getItem("pv_keyk") || "null"); if (k) S.keyK = { blade: Represent.clampK(k.blade, 3), culm: Represent.clampK(k.culm, 2) }; } catch {}

/** does this object take part at all in the current Lines mode? ("Yours" leaves predicted lines out of the view, lists and traits) */
try { S.snap = localStorage.getItem("pv_snap") !== "0"; const b = +localStorage.getItem("pv_brush"); if (b >= 3 && b <= 150) S.brushPx = b; const t = +localStorage.getItem("pv_tol"); if (t >= 1 && t <= 100) S.tol = t; S.connected = localStorage.getItem("pv_connected") !== "0"; } catch {}
const inScope = (o) => o.source !== "model" || (SHOW_PREDICTED && S.overlay !== "mine");

// ---------------------------------------------------------------- data access
// Published site: after Google sign-in (assets/auth.js) the tool data is read from private storage with a
// 1-hour signed link. Local preview build (publish.ps1 -Preview): plain files next to the page (data/key.json says plain).
const gunzip = (buf) => new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
async function fetchSealed(path) {
  let url = path;
  if (!S.plain) { S.content = await PV.content(); url = S.content.url("tool/" + path); }
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.arrayBuffer();
}
async function loadJSON(path) { return JSON.parse(new TextDecoder().decode(await gunzip(await fetchSealed(path)))); }
// opened from the slides (?from=<slide>): link back to that slide
{ const from = parseInt(new URLSearchParams(location.search).get("from"));
  if (from > 0) { $("toSlides").href = "../slides/#" + from; $("toSlides").textContent = "← Slide " + from; } }
$("lockBtn").onclick = (e) => { e.preventDefault(); if (S.plain) return toast("Local preview — no sign-in"); PV.signOut(); };

// ---------------------------------------------------------------- geometry
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const plen = (p) => { let L = 0; for (let i = 1; i < p.length; i++) L += dist(p[i - 1], p[i]); return L; };
function segDist(p, a, b) { const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy; const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0; return dist(p, [a[0] + t * dx, a[1] + t * dy]); }
const toScreen = (p) => [p[0] * V.s + V.tx, p[1] * V.s + V.ty];
const toImage = (x, y) => [(x - V.tx) / V.s, (y - V.ty) / V.s];
const mm = (px) => (S.sheet?.px_per_mm ? px / S.sheet.px_per_mm : null);
const f = (v, d = 1) => (v == null || !isFinite(v) ? "—" : v.toFixed(d));
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");
const traitDef = () => TRAITS.find((t) => t.key === S.trait);
const uid = () => "h" + Math.random().toString(36).slice(2, 9);
function parentOf(o) {
  if (o.parent) { const p = S.objects.find((x) => x.id === o.parent); if (p) return p; }
  const t = o.type === "blade_width" ? "blade" : "culm", m = [(o.points[0][0] + o.points[1][0]) / 2, (o.points[0][1] + o.points[1][1]) / 2];
  let best = null, bd = Infinity;
  for (const x of S.objects) { if (x.type !== t || !inScope(x)) continue; for (let i = 1; i < x.points.length; i++) { const d = segDist(m, x.points[i - 1], x.points[i]); if (d < bd) { bd = d; best = x; } } }
  return best;
}
const widthsOf = (o) => S.objects.filter((w) => (w.type === "blade_width" || w.type === "culm_width") && inScope(w) && parentOf(w) === o);
const fmtLen = (v) => (v == null ? "—" : v >= 100 ? `${f(v / 10, 1)} cm` : `${f(v, 1)} mm`);
function labelFor(o, pts = o.points) {
  if (pts.length < 2) return "";
  if (TYPES[o.type].closed) { if (pts.length < 3) return ""; const a = Smart.polyArea(pts), p = S.sheet?.px_per_mm; return p ? `${f(a / (p * p), 1)} mm²` : `${f(a, 0)} px²`; }
  const px = TYPES[o.type].geom === "line" ? dist(pts[0], pts[1]) : plen(pts), v = mm(px), t = traitDef();
  if (v == null) return `${f(px, 0)} px`;
  if (t.key === "wl" && o.type === "blade" && pts === o.points) { const r = t.value(o); return r ? `W:L ${f(r, 3)}` : fmtLen(v); }
  if (o.type === "culm_width") return t.key === "culm_diameter" ? `⌀ ${f((2 * v) / Math.PI, 2)} mm` : `${f(v, 2)} mm`;
  if (o.type === "blade_width") return `${f(v, 2)} mm`;
  return fmtLen(v);
}

// ---------------------------------------------------------------- key organs (represent.js) & overlay visibility
let keyCache = { objs: null, rev: -1, sig: "", val: null };
/** key sets for the current objects, cached until the objects change: Represent.pickAll + lookups */
function keys() {
  const sig = `${S.keyK.blade},${S.keyK.culm},${S.sheet?.px_per_mm}`;
  if (keyCache.objs !== S.objects || keyCache.rev !== S.rev || keyCache.sig !== sig) {
    const k = Represent.pickAll(S.objects, { ppm: S.sheet?.px_per_mm, width: S.sheet?.width, height: S.sheet?.height, k: S.keyK, parentOf });
    // lines people drew or edited are always key: the automatic pick only chooses among predicted ones
    for (const o of S.objects) {
      if (o.source === "model" || o.type === "spine" || !k[o.type] || k[o.type].includes(o.id) || organOf(o)?.key === false) continue;
      k[o.type].push(o.id);
      if (o.type === "blade" && widthsOf(o).length && !k.wl.includes(o.id)) k.wl.push(o.id);
    }
    k.organs = [...k.blade, ...k.culm];
    k.organSet = new Set(k.organs); k.donor = new Set(k.widthDonors.filter((id) => !k.organSet.has(id)));
    k.show = new Set([...k.organs, ...k.blade_width, ...k.culm_width, ...k.donor]);
    k.byTrait = { blade_length: new Set(k.blade), blade_width: new Set(k.blade_width), wl: new Set(k.wl), culm_length: new Set(k.culm), culm_diameter: new Set(k.culm_width) };
    k.num = new Map(); k.blade.forEach((id, i) => k.num.set(id, i + 1)); k.culm.forEach((id, i) => k.num.set(id, i + 1));
    keyCache = { objs: S.objects, rev: S.rev, sig, val: k };
  }
  return keyCache.val;
}
/** is this object drawn in the current overlay mode? (also used by spine.js and hit-testing) */
const isMaskObj = (o) => o.type === "stroke" || o.type === "maskmeta";
function overlayShows(o) {
  if (isMaskObj(o) || !inScope(o)) return false;
  if (o.id === S.selected || o.id === S.hot || S.overlay === "mine") return true;
  if (S.overlay === "off") return false;
  if (o.type === "spine") return S.overlay === "all" || o.source !== "model";   // spines a person drew are user content
  if (S.overlay === "all") return true;
  if (o.type.endsWith("_width") && S.selected) { const p = parentOf(o); if (p && p.id === S.selected) return true; }   // widths of the selected organ
  return S.overlay === "key" && keys().show.has(o.id);
}
/** organ a list row / star refers to: the organ itself, or a width line's parent */
const organOf = (o) => (o.type.endsWith("_width") ? parentOf(o) : o);
function toggleKey(o) {
  const t = organOf(o); if (!t) return;
  const on = keys().organSet.has(t.id) || (o !== t && keys().show.has(o.id));
  snapshot(); t.key = !on; changed();
  toast(t.key ? `${TYPES[t.type].label} pinned as key` : `${TYPES[t.type].label} excluded from key`);
}
function resetKeys() { if (!S.objects.some((o) => "key" in o)) return; snapshot(); for (const o of S.objects) delete o.key; changed(); toast("Key picks back to automatic"); }
function setKeyK(type, d) {
  const n = Represent.clampK(S.keyK[type] + d, S.keyK[type]); if (n === S.keyK[type]) return;
  S.keyK = { ...S.keyK, [type]: n }; try { localStorage.setItem("pv_keyk", JSON.stringify(S.keyK)); } catch {}
  panel(); draw();
}
function setOverlay(m) {
  S.overlay = m; try { localStorage.setItem("pv_overlay", m); } catch {}
  document.querySelectorAll("#overlay button").forEach((b) => b.classList.toggle("on", b.dataset.o === m));
  status(m === "mine" ? "Showing only lines people drew or edited" : m === "key" ? "Key: your lines plus a few clearly visible predicted organs (★ in the list to pin / exclude)" : m === "off" ? "Lines off: pick an organ in the list to see it" : "");
  if (S.sheet) panel(); draw();
}
$("overlay").innerHTML = `<span class="k">Lines</span>` + OVERLAYS.map(([k, l, tip]) => `<button data-o="${k}" title="${tip}">${l}</button>`).join("");
document.querySelectorAll("#overlay button").forEach((b) => { b.onclick = () => setOverlay(b.dataset.o); b.classList.toggle("on", b.dataset.o === S.overlay); });

// ---------------------------------------------------------------- view & render
// ---- theme (the page sets data-theme before it paints)
const light = () => document.documentElement.dataset.theme === "light";
const THEME_ICON = { sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6L7 7M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>', moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>' };
function showTheme() { const b = $("themeBtn"), l = light(); b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${l ? THEME_ICON.moon : THEME_ICON.sun}</svg>`; b.title = l ? "Switch to the dark theme" : "Switch to the white theme"; b.setAttribute("aria-label", b.title); }
$("themeBtn").onclick = () => { const t = light() ? "dark" : "light"; document.documentElement.dataset.theme = t; try { localStorage.setItem("pv_theme", t); } catch {} showTheme(); draw(); };
showTheme();
function resize() { V.dpr = devicePixelRatio || 1; V.W = innerWidth; V.H = innerHeight; for (const c of [cv, off]) { c.width = Math.round(V.W * V.dpr); c.height = Math.round(V.H * V.dpr); } draw(); }
/** the part of the window not covered by the bars and panels */
function area() {
  const box = (id) => { const e = $(id); return e.classList.contains("hidden") ? null : e.getBoundingClientRect(); };
  const x = box("tools")?.right ?? 0, y = box("top")?.bottom ?? 0, r = box("panel")?.left ?? V.W, b = box("bottom")?.top ?? V.H;
  return { x, y, w: r - x, h: b - y };
}
function fit() { if (!S.sheet) return; const { width: w, height: h } = S.sheet, a = area(); V.s = Math.min(a.w / w, a.h / h) * 0.96; V.tx = a.x + (a.w - w * V.s) / 2; V.ty = a.y + (a.h - h * V.s) / 2; draw(); }
function zoomAt(x, y, k) { if (!S.sheet) return; const minS = Math.min(V.W / S.sheet.width, V.H / S.sheet.height) * 0.3, s = Math.max(minS, Math.min(MAX_ZOOM, V.s * k)); V.tx = x - ((x - V.tx) * s) / V.s; V.ty = y - ((y - V.ty) * s) / V.s; V.s = s; draw(); }
function focusOn(pts) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]), w = Math.max(...xs) - Math.min(...xs) + 300, h = Math.max(...ys) - Math.min(...ys) + 300, a = area();
  V.s = Math.min(MAX_ZOOM, Math.min(a.w / w, a.h / h) * 0.6); V.tx = a.x + a.w / 2 - ((Math.min(...xs) + Math.max(...xs)) / 2) * V.s; V.ty = a.y + a.h / 2 - ((Math.min(...ys) + Math.max(...ys)) / 2) * V.s; draw();
}
const sheetRect = () => { const a = toScreen([0, 0]), b = toScreen([S.sheet.width, S.sheet.height]); return [a[0], a[1], b[0] - a[0], b[1] - a[1]]; };
function drawPhoto(g) {
  if (!S.img) return;
  const useSmall = S.small && V.s * V.dpr * S.sheet.width <= S.small.width * 1.15;
  g.imageSmoothingEnabled = V.s < 2; g.imageSmoothingQuality = "high"; g.drawImage(useSmall ? S.small : S.img, ...sheetRect());
}
let raf = 0;
function draw() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); }
function render() {
  ctx.setTransform(V.dpr, 0, 0, V.dpr, 0, 0); ctx.fillStyle = light() ? "#e8e7e3" : "#000"; ctx.fillRect(0, 0, V.W, V.H);
  if (!S.sheet) return;
  if (!S.img) { ctx.fillStyle = light() ? "#f5f4f0" : "#0c0c0c"; ctx.fillRect(...sheetRect()); }
  if (S.view === "plant" && S.mask) {
    octx.setTransform(V.dpr, 0, 0, V.dpr, 0, 0); octx.globalCompositeOperation = "source-over"; octx.clearRect(0, 0, V.W, V.H); drawPhoto(octx);
    octx.globalCompositeOperation = "destination-in"; octx.imageSmoothingEnabled = true; octx.drawImage(S.mask, ...sheetRect()); octx.globalCompositeOperation = "source-over";
    ctx.fillStyle = light() ? "#fff" : "#101010"; ctx.fillRect(...sheetRect()); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(off, 0, 0); ctx.setTransform(V.dpr, 0, 0, V.dpr, 0, 0);
  } else {
    if (S.view !== "depth") drawPhoto(ctx);
    if (S.view === "depth" && S.extra.depth) { ctx.imageSmoothingEnabled = true; ctx.drawImage(S.extra.depth, ...sheetRect()); }
    if (S.view === "label" && S.extra.label) { ctx.fillStyle = "rgba(0,0,0,.35)"; ctx.fillRect(...sheetRect()); ctx.imageSmoothingEnabled = false; ctx.drawImage(S.extra.label, ...sheetRect()); }
    if (S.view === "photo" && MASK_TOOL[S.tool] && S.maskTint) { ctx.globalAlpha = 0.45; ctx.imageSmoothingEnabled = true; ctx.drawImage(S.maskTint, ...sheetRect()); ctx.globalAlpha = 1; }
    if (S.view === "mask" && S.maskTint) { ctx.fillStyle = "rgba(0,0,0,.55)"; ctx.fillRect(...sheetRect()); ctx.imageSmoothingEnabled = true; ctx.drawImage(S.maskTint, ...sheetRect()); }
  }
  const t = traitDef();
  if (t.key === "all" && S.overlay === "all") for (const x of S.sheet.fine || []) drawPath(x.points, FINE_COL[x.kind] || "#777", 1, 0.5, [3, 3]);
  Mask.drawSelection(ctx);
  if (S.quick?.canvas) { ctx.imageSmoothingEnabled = false; ctx.drawImage(S.quick.canvas, ...sheetRect()); ctx.imageSmoothingEnabled = true; }
  Spine.drawUnder();
  const K = S.overlay === "key" ? keys() : null;
  placedLabels.length = 0;
  for (const o of S.objects) {
    if (!overlayShows(o)) continue;
    const donor = K && K.donor.has(o.id) && t.key !== "wl" && o.id !== S.selected && o.id !== S.hot, lit = (t.key === "all" || t.hi(o)) && !donor;
    drawObject(o, o.points, { selected: o.id === S.selected, hot: o.id === S.hot, dim: !lit, label: lit && labelWanted(o, t), key: K ? K.num.get(o.id) : null });
  }
  Spine.drawOver(); Ann.drawOverlay();
  const sv = S.selVtx && S.objects.find((o) => o.id === S.selVtx.id && o.id === S.selected);
  if (sv && sv.points[S.selVtx.v]) { const q = toScreen(sv.points[S.selVtx.v]); ctx.lineWidth = 2; ctx.strokeStyle = "#fff"; ctx.beginPath(); ctx.arc(q[0], q[1], 8, 0, 7); ctx.stroke(); }
  if (S.drawing) drawObject(S.drawing, livePts(), { selected: true, live: true, label: true });
  ctxBar();
  if (MASK_TOOL[S.tool] && S.cursor) {   // the cursor says what a click will do: + adds to the mask, − removes
    const q = toScreen(S.cursor), brush = BRUSH[S.tool] || QUICK[S.tool], del = S.tool.endsWith("_del") !== S.alt;
    if (brush) { ctx.lineWidth = 1; for (const [col, r] of [["#000", S.brushPx + 1], ["#fff", S.brushPx]]) { ctx.strokeStyle = col; ctx.beginPath(); ctx.arc(q[0], q[1], r, 0, 7); ctx.stroke(); } }
    const inside = brush && S.brushPx >= 9, cx = inside ? q[0] : q[0] + 15, cy = inside ? q[1] : q[1] - 15, a = 5; ctx.lineCap = "round";
    for (const [col, w] of [["#000", 4.5], ["#fff", 2]]) { ctx.strokeStyle = col; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(cx - a, cy); ctx.lineTo(cx + a, cy); if (!del) { ctx.moveTo(cx, cy - a); ctx.lineTo(cx, cy + a); } ctx.stroke(); }
  }
  $("zoom").textContent = `${f(V.s * 100, 0)} %`;
}
// ---- context bar: small icon buttons next to what is selected (a line, or a region of the mask)
const CTX_ICON = {
  addpt: '<path d="M4 18L12 8l8 10"/><circle cx="12" cy="8" r="2.5"/><path d="M18 3v4M16 5h4"/>',
  delpt: '<path d="M4 18L12 8l8 10"/><circle cx="12" cy="8" r="2.5"/><path d="M16 5h4"/>',
  extend: '<path d="M3 17l7-7"/><circle cx="10" cy="10" r="2"/><path d="M12 8l6-6" stroke-dasharray="2 2.5"/><path d="M15 2h4v4"/>',
  extstart: '<path d="M21 7l-7 7"/><circle cx="14" cy="14" r="2"/><path d="M12 16l-6 6" stroke-dasharray="2 2.5"/><path d="M9 22H5v-4"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
  split: '<rect x="3" y="3" width="18" height="18" rx="2" stroke-dasharray="3 2"/><path d="M12 8v8M8 12h8"/>',
  move: '<path d="M5 12h12"/><path d="M13 7l5 5-5 5"/>',
  whole: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 12l3 3 5-6"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  addw: '<path d="M3 16c5-6 13-6 18 0"/><path d="M12 7v9"/><path d="M9.5 7h5M9.5 16h5"/><path d="M19 3v4M17 5h4"/>',
  delw: '<path d="M3 16c5-6 13-6 18 0"/><path d="M12 7v9"/><path d="M9.5 7h5M9.5 16h5"/><path d="M17 5h4"/>',
};
// what a line can be switched to without redrawing it (same geometry)
const SWAP = { blade: ["blade", "culm"], culm: ["blade", "culm"], blade_width: ["blade_width", "culm_width"], culm_width: ["blade_width", "culm_width"] };
const ctxBtn = (act, icon, title, extra = "") => `<button type="button" data-act="${act}" title="${title}" aria-label="${title}"${extra}><svg viewBox="0 0 24 24" aria-hidden="true">${CTX_ICON[icon]}</svg></button>`;
let ctxSig = "";
function ctxBar() {
  const bar = $("ctx"); let box = null, sig = "", html = "";
  if (!S.drawing && !S.press?.moved && S.sheet && S.tool === "select") {
    if (Mask.sel) {
      box = Mask.selScreenBox(); const act = Mask.active(), sp = Mask.sel.part;
      sig = `r${sp}-${act}-${Mask.parts().length}`;
      html = `<select id="ctxCls" title="Class for a new part">${Mask.CLASSES.map((c) => `<option value="${c.id}"${c.id === "leaf" ? " selected" : ""}>${c.name}</option>`).join("")}</select>`
        + ctxBtn("split", "split", "Make this area a new part of the chosen class")
        + (act !== sp ? ctxBtn("move", "move", `Move this area into the active part (${Mask.label(Mask.part(act) || { cls: "other", n: 1 })})`) : "")
        + ctxBtn("whole", "whole", "Select the whole part, not just this area") + ctxBtn("delregion", "trash", "Remove this area from the mask (Delete)") + ctxBtn("deselect", "close", "Deselect (Esc)");
    } else {
      const o = S.objects.find((x) => x.id === S.selected && overlayShows(x));
      if (o) {
        const T = TYPES[o.type], poly = T.geom === "poly", open = poly && !T.closed, v = S.selVtx?.id === o.id ? S.selVtx.v : null, min = T.closed ? 3 : 2;
        const sp = o.type === "spine", sec = sp && Spine.UI.sec?.id === o.id ? Spine.UI.sec.k : null;
        sig = `l${o.id}-${o.type}-${v}-${S.insertMode}-${S.widthMode}-${sec}-${o.points.length}-${(o.sections || []).length}`;
        const xs = o.points.map((p) => toScreen(p)[0]), ys = o.points.map((p) => toScreen(p)[1]);
        box = { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
        html = (SWAP[o.type] ? `<select id="ctxType" title="What this line measures">${SWAP[o.type].map((t) => `<option value="${t}"${t === o.type ? " selected" : ""}>${TYPES[t].label}</option>`).join("")}</select>` : "")
          + (poly ? ctxBtn("addpt", "addpt", "Add a point: click on the line where it should go (or double-click the line)", S.insertMode ? ' class="on"' : "") : "")
          + (poly ? ctxBtn("delpt", "delpt", v == null ? "Delete a point: click a point first" : "Delete the selected point (Delete)", v == null || o.points.length <= min ? " disabled" : "") : "")
          + (open ? ctxBtn("extend", "extend", "Extend from the end: keep drawing from its last point") + ctxBtn("extstart", "extstart", "Extend from the start: keep drawing from its first point") : "")
          + (sp ? ctxBtn("addw", "addw", "Add a width marker: click on the spine where it should go", S.widthMode ? ' class="on"' : "")
            + ctxBtn("delw", "delw", sec == null ? "Delete a width marker: click one of its ends first" : "Delete the selected width marker", sec == null || (o.sections || []).length <= 1 ? " disabled" : "") : "")
          + ctxBtn("delline", "trash", v == null ? "Delete this line (Delete)" : "Delete this line") + ctxBtn("deselect", "close", "Deselect (Esc)");
      }
    }
  }
  if (!box) { if (!bar.hidden) { bar.hidden = true; ctxSig = ""; } return; }
  if (sig !== ctxSig) { bar.innerHTML = html; ctxSig = sig; bar.hidden = false; bindCtx(); }
  const a = area(), w = bar.offsetWidth, h = bar.offsetHeight;
  let x = Math.max(a.x + 6, Math.min(a.x + a.w - w - 6, box.right + 10)), y = box.top - h - 10;
  if (y < a.y + 6) y = Math.min(a.y + a.h - h - 6, box.bottom + 10);
  bar.style.left = `${x}px`; bar.style.top = `${Math.max(a.y + 6, y)}px`;
}
function bindCtx() {
  $("ctx").querySelectorAll("[data-act]").forEach((b) => (b.onclick = () => ctxAction(b.dataset.act)));
  const sel = $("ctxCls"); if (sel) sel.onchange = (e) => e.target.blur();
  const ty = $("ctxType"); if (ty) ty.onchange = (e) => { e.target.blur(); setType(e.target.value); };
}
function ctxAction(act) {
  const o = S.objects.find((x) => x.id === S.selected);
  if (act === "split") Mask.splitSel($("ctxCls").value);
  else if (act === "move") Mask.relabelSel(Mask.active());
  else if (act === "whole") { Mask.selectPart(Mask.sel.part); draw(); }
  else if (act === "delregion") Mask.relabelSel(0);
  else if (act === "deselect") { Mask.clearSel(); S.selected = null; S.selVtx = null; S.insertMode = S.widthMode = false; panel(); draw(); }
  else if (act === "addpt") { S.insertMode = !S.insertMode; S.widthMode = false; status(S.insertMode ? "Click on the line where the new point goes" : ""); draw(); }
  else if (act === "addw") { S.widthMode = !S.widthMode; S.insertMode = false; status(S.widthMode ? "Click on the spine where the width marker goes" : ""); draw(); }
  else if (act === "delw" && o && Spine.UI.sec?.id === o.id) Spine.removeSection(o, Spine.UI.sec.k);
  else if (act === "delpt" && o && S.selVtx?.id === o.id) removeVertex(o, S.selVtx.v);
  else if (act === "extend" && o) extendLine(o, false);
  else if (act === "extstart" && o) extendLine(o, true);
  else if (act === "delline") removeSelected();
}
/** switch the selected line between blade and culm (or blade width and culm width); widths follow their organ */
function setType(t) {
  const o = S.objects.find((x) => x.id === S.selected); if (!o || !SWAP[o.type]?.includes(t) || o.type === t) return;
  snapshot(); o.type = t; if (o.source === "model") o.source = "edited";
  changed(); toast(`Now a ${TYPES[t].label.toLowerCase()}`);
}
// ---- editing lines: insert and delete points, extend from either end
function nearestSegment(o, p) {
  let best = null, bd = Infinity;
  for (let i = 1; i < o.points.length; i++) { const d = segDist(p, o.points[i - 1], o.points[i]); if (d < bd) { bd = d; best = i; } }
  if (TYPES[o.type].closed && o.points.length > 2) { const d = segDist(p, o.points.at(-1), o.points[0]); if (d < bd) { bd = d; best = o.points.length; } }
  return { i: best, d: bd };
}
function insertVertex(o, p) {
  const { i, d } = nearestSegment(o, p); if (i == null || d > HIT_TOL * 2 / V.s) return false;
  const a = o.points[i - 1], b = o.points[i % o.points.length], dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy, t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
  snapshot(); o.points.splice(i, 0, [Math.round(a[0] + t * dx), Math.round(a[1] + t * dy)]);
  if (o.folds) o.folds = o.folds.map((f) => (f >= i ? f + 1 : f));
  if (o.type === "spine") Spine.recompute(o); if (o.source === "model") o.source = "edited";
  S.selVtx = { id: o.id, v: i }; S.insertMode = false; changed(); status("Point added: drag it into place"); return true;
}
function removeVertex(o, v) {
  const min = TYPES[o.type].closed ? 3 : 2; if (o.points.length <= min) return toast("A line needs at least " + min + " points");
  snapshot(); o.points.splice(v, 1);
  if (o.folds) o.folds = o.folds.filter((f) => f !== v).map((f) => (f > v ? f - 1 : f));
  if (o.type === "spine") Spine.recompute(o); if (o.source === "model") o.source = "edited";
  S.selVtx = null; changed();
}
function extendLine(o, fromStart) {
  const index = S.objects.indexOf(o); if (index < 0) return;
  snapshot(); S.objects.splice(index, 1);
  const d = JSON.parse(JSON.stringify(o)); if (fromStart) d.points.reverse();
  S.extending = { orig: o, index, fromStart, len: o.points.length };
  setTool(o.type); S.drawing = d; if (TRACED[o.type] && snapping()) d.marks = [d.points.length];
  S.selVtx = null; S.insertMode = false;
  status(`Extending the ${TYPES[o.type].label.toLowerCase()} from its ${fromStart ? "start" : "end"}: click to add, Enter to finish, Esc to cancel`); draw();
}
function cancelExtend() {
  const X = S.extending; if (!X) return; S.extending = null; S.drawing = null; S.preview = null;
  S.objects.splice(X.index, 0, X.orig); S.undo.pop(); S.selected = X.orig.id; setTool("select"); panel(); draw();
}
function labelWanted(o, t) { if (o.id === S.selected || o.id === S.hot) return true; if (S.overlay === "off") return false; if (S.overlay === "mine") return true; if (t.key === "all" && S.overlay === "key") return true; if (t.key === "all") return (o.type === "blade" || o.type === "culm") && mm(plen(o.points)) > 40; return t.type === o.type; }
const placedLabels = [];
function drawPath(pts, color, w, alpha = 1, dash = []) {
  const sp = pts.map(toScreen); ctx.globalAlpha = alpha; ctx.lineJoin = ctx.lineCap = "round";
  ctx.beginPath(); sp.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p))); ctx.strokeStyle = color; ctx.lineWidth = w; ctx.setLineDash(dash); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
}
function drawObject(o, pts, { selected = false, hot = false, dim = false, live = false, label = false, key = null } = {}) {
  const T = TYPES[o.type]; if (!T || !pts.length) return;
  const sp = pts.map(toScreen), w = (T.thin ? 1.2 : 2) + (selected || hot ? 1.5 : 0) + (key && !dim ? 1.2 : 0);
  ctx.globalAlpha = dim ? 0.18 : 1; ctx.lineJoin = ctx.lineCap = "round";
  ctx.beginPath(); sp.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p))); if (T.closed && !live) ctx.closePath();
  ctx.strokeStyle = "rgba(0,0,0,.6)"; ctx.lineWidth = w + 2.5; ctx.stroke();
  ctx.strokeStyle = T.color; ctx.lineWidth = w; ctx.setLineDash(live || o.source === "human" ? [6, 4] : []); ctx.stroke(); ctx.setLineDash([]);
  if (T.geom === "line" && sp.length === 2) { const [a, b] = sp, L = dist(a, b) || 1, nx = (-(b[1] - a[1]) / L) * 5, ny = ((b[0] - a[0]) / L) * 5; ctx.beginPath(); for (const p of [a, b]) { ctx.moveTo(p[0] - nx, p[1] - ny); ctx.lineTo(p[0] + nx, p[1] + ny); } ctx.stroke(); }
  if (selected || live) for (const p of sp) { ctx.fillStyle = "#000"; ctx.fillRect(p[0] - 3.5, p[1] - 3.5, 7, 7); ctx.strokeStyle = T.color; ctx.lineWidth = 1; ctx.strokeRect(p[0] - 3.5, p[1] - 3.5, 7, 7); }
  ctx.globalAlpha = 1;
  if (key && !dim) {   // numbered badge at the tip (bases converge in tufts)
    const e = sp[sp.length - 1]; ctx.beginPath(); ctx.arc(e[0], e[1], 8, 0, 7); ctx.fillStyle = T.color; ctx.fill(); ctx.strokeStyle = "#000"; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = "#000"; ctx.font = "600 10px Inter, system-ui, sans-serif"; ctx.textAlign = "center"; ctx.fillText(String(key), e[0], e[1] + 3.5); ctx.textAlign = "start";
  }
  if (!label) return;
  const text = labelFor(o, pts); if (!text) return;
  const at = T.geom === "line" ? sp[sp.length - 1] : sp[Math.floor(sp.length / 2)];
  ctx.font = "500 11px Inter, system-ui, sans-serif"; const tw = ctx.measureText(text).width + 10;
  const x = at[0] + 8; let y = at[1] - 20;   // move down until it clears the labels already drawn
  while (placedLabels.some((r) => x < r.x + r.w && r.x < x + tw && y < r.y + 18 && r.y < y + 18)) y += 19;
  placedLabels.push({ x, y, w: tw });
  ctx.fillStyle = "rgba(0,0,0,.8)"; ctx.fillRect(x, y, tw, 17); ctx.fillStyle = T.color; ctx.fillText(text, x + 5, y + 13);
}

// ---------------------------------------------------------------- editing
function hit(p) {
  const tol = HIT_TOL / V.s, t = traitDef(), pool = S.objects.filter((o) => (t.key === "all" || t.hi(o)) && overlayShows(o));
  let best = null, bd = tol;
  for (const o of pool) o.points.forEach((q, i) => { const d = dist(p, q); if (d < bd) { bd = d; best = { o, v: i }; } });
  if (best) return best;
  for (const o of pool) for (let i = 1; i < o.points.length; i++) { const d = segDist(p, o.points[i - 1], o.points[i]); if (d < bd) { bd = d; best = { o }; } }
  return best;
}
const snapshot = () => { S.undo.push(JSON.stringify(S.objects)); if (S.undo.length > 200) S.undo.shift(); };
// ---- drafts: unsaved work is copied to this browser every few seconds and offered back if the page closed before Save
const draftKey = () => (S.sheet ? `pv_draft:${S.sheet.id}:${PV.user()?.id ?? "local"}` : null);
let draftTimer = 0;
function scheduleDraft() { clearTimeout(draftTimer); draftTimer = setTimeout(saveDraft, 2000); }
function saveDraft() {
  clearTimeout(draftTimer); draftTimer = 0; const k = draftKey(); if (!k || !S.dirty) return;
  const rec = JSON.stringify({ at: Date.now(), run: S.run, ver: S.ver, objects: S.objects, notes: S.notes });
  try { localStorage.setItem(k, rec); } catch {
    try {   // storage full: drop the oldest drafts and try once more
      const old = Object.keys(localStorage).filter((x) => x.startsWith("pv_draft:") && x !== k).map((x) => [x, (JSON.parse(localStorage.getItem(x) || "{}").at || 0)]).sort((a, b) => a[1] - b[1]);
      for (const [x] of old.slice(0, Math.max(1, old.length - 2))) localStorage.removeItem(x);
      localStorage.setItem(k, rec);
    } catch {}
  }
}
function clearDraft() { clearTimeout(draftTimer); draftTimer = 0; const k = draftKey(); try { if (k) localStorage.removeItem(k); } catch {} $("draftBar").hidden = true; }
/** after a sheet opens: unsaved work left from last time? */
function offerDraft() {
  const k = draftKey(); let d = null; try { d = JSON.parse(localStorage.getItem(k) || "null"); } catch {}
  const bar = $("draftBar"); if (!d || !Array.isArray(d.objects) || d.run !== S.run) { bar.hidden = true; return; }
  $("draftWhen").textContent = new Date(d.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  bar.hidden = false;
  $("draftRestore").onclick = () => {
    bar.hidden = true; snapshot(); S.objects = d.objects; if (d.ver) S.ver = d.ver; if (d.notes) S.notes = d.notes; S.forceMaskSave = true; S.selected = null;
    changed(); toast("Unsaved work restored: press Save to keep it");
  };
  $("draftDiscard").onclick = () => { if (confirm("Discard the unsaved work from " + $("draftWhen").textContent + "? This can't be undone.")) clearDraft(); };
}
addEventListener("pagehide", saveDraft);
function changed() { scheduleDraft(); S.rev++; Ann.onChange(); if (MASK_TOOL[S.tool]) toolOptions(); S.dirty = true; $("saveBtn").classList.add("dirty"); status("Unsaved corrections"); panel(); draw(); }
function setTool(t) { if (S.drawing && S.drawing.type !== t) { if (S.extending) cancelExtend(); S.drawing = null; } if (t !== "select") { Mask.clearSel(); S.insertMode = false; } if (MASK_TOOL[t]) showTab("mask"); S.tool = t; document.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === t)); cv.classList.toggle("edit", t === "select"); cv.classList.toggle("brushing", !!(BRUSH[t] || QUICK[t])); toolOptions(); if (S.sheet) status(document.querySelector(`[data-tool="${t}"]`).dataset.tip.split("|")[2]); draw(); }
document.querySelectorAll("[data-tool]").forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
// ---- snap: lines follow the plant mask (Shift = this click by hand)
const snapping = () => S.snap && !S.manual && !!S.mask;
function setSnap(v) { S.snap = v; try { localStorage.setItem("pv_snap", v ? "1" : "0"); } catch {} $("snapBtn").classList.toggle("on", v); S.preview = null; toast(v ? "Snap on: lines follow the plant" : "Snap off: lines go exactly where you click"); draw(); }
$("snapBtn").onclick = () => setSnap(!S.snap); $("snapBtn").classList.toggle("on", S.snap);
function field() {
  if (!S.mask) return null;
  if (!S.field) { const w = S.mask.width, h = S.mask.height, g = Smart.gridFromAlpha(S.mask.getContext("2d").getImageData(0, 0, w, h).data, w, h); S.field = { d: Smart.distanceField(g, w, h), w, h, sx: w / S.sheet.width, sy: h / S.sheet.height }; }
  return S.field;
}
function snapPoint(p) {
  const F = field(); if (!F) return p;
  const q = Smart.snapToRidge(F.d, F.w, F.h, [p[0] * F.sx, p[1] * F.sy], Math.max(3, Math.round((12 / V.s) * F.sx)));
  return q ? [q[0] / F.sx, q[1] / F.sy] : p;
}
/** image-pixel points after a, following the plant to b; null when there is no plant to follow */
function traced(a, b) {
  const F = field(); if (!F) return null;
  const clampX = (x) => Math.max(0, Math.min(F.w - 1, Math.round(x * F.sx))), clampY = (y) => Math.max(0, Math.min(F.h - 1, Math.round(y * F.sy)));
  const r = Smart.trace(F.d, F.w, F.h, [clampX(a[0]), clampY(a[1])], [clampX(b[0]), clampY(b[1])]); if (!r.ok || r.path.length < 2) return null;
  return Smart.simplify(Smart.smooth(r.path, 5), 1.2).slice(1).map((q) => [q[0] / F.sx, q[1] / F.sy]);
}
function livePts() { const d = S.drawing; return S.preview ? [...d.points, ...S.preview] : S.cursor ? [...d.points, S.cursor] : d.points; }
let previewTimer = 0;
function schedulePreview() {
  if (previewTimer) return;
  previewTimer = setTimeout(() => {
    previewTimer = 0; const d = S.drawing;
    if (!d || !TRACED[d.type] || !snapping() || !S.cursor) { S.preview = null; return; }
    const q = snapPoint(S.cursor); S.preview = traced(d.points.at(-1), q) || [q]; draw();
  }, 60);
}
/** one click on a blade or culm: the width across the plant there. False when the mask gives no clear answer. */
function oneClickWidth(p) {
  const op = Spine.opts(); if (!op.inside) return false;
  const organ = S.tool === "blade_width" ? "blade" : "culm"; let par = null, bd = Math.max(12 / V.s, (S.sheet.px_per_mm || 10) * 4), nrm = null;
  for (const o of S.objects) { if (o.type !== organ || !inScope(o)) continue; for (let i = 1; i < o.points.length; i++) { const a = o.points[i - 1], b = o.points[i], e = segDist(p, a, b); if (e < bd) { bd = e; par = o; const L = dist(a, b) || 1; nrm = [-(b[1] - a[1]) / L, (b[0] - a[0]) / L]; } } }
  const mo = { sx: op.sx, sy: op.sy, search: 8 }, m = nrm ? Smart.marchWidth(op.inside, p, nrm, mo) : Smart.narrowestChord(op.inside, p, mo);
  if (!m.ok || m.capped) return false;
  const o = { id: uid(), type: S.tool, points: [m.a, m.b].map(([x, y]) => [Math.round(x), Math.round(y)]), flags: {}, source: "human", assisted: true };
  if (par) o.parent = par.id;
  snapshot(); S.objects.push(o); S.selected = o.id; showTab("work"); changed(); return true;
}
function addPoint(p) {
  const trace = TRACED[S.tool] && snapping();
  if (!S.drawing) {
    if (snapping() && TYPES[S.tool].geom === "line") { if (oneClickWidth(p)) return; status("No clear plant under that click: place both edges by hand"); }
    const flags = {}; (FLAGS[S.tool] || []).forEach(([k, , on]) => (flags[k] = !!on));
    S.drawing = { id: uid(), type: S.tool, points: [trace ? snapPoint(p) : p], flags, source: "human" }; if (trace) S.drawing.marks = [1]; draw(); return;
  }
  if (trace && S.drawing.marks) {
    const d = S.drawing, last = d.points.at(-1); if (dist(last, p) * V.s < 3) { draw(); return; }
    const q = snapPoint(p); d.points.push(...(traced(last, q) || [q])); d.marks.push(d.points.length); S.preview = null; draw(); return;
  }
  S.drawing.points.push(p);
  if (TYPES[S.drawing.type].geom === "line") finish(); else draw();
}
function finish() {
  const o = S.drawing, X = S.extending;
  if (X && (!o || o.points.length <= X.len)) return cancelExtend();
  S.drawing = null; S.preview = null;
  if (!o || o.points.length < (TYPES[o.type]?.closed ? 3 : 2)) { draw(); return; }
  delete o.marks; if (TYPES[o.type].closed) o.points = Smart.simplify(o.points, 1 / V.s);
  o.points = o.points.map(([x, y]) => [Math.round(x), Math.round(y)]);
  if (plen(o.points) < 1) { status("Line too short — not added"); draw(); return; }   // e.g. a double-click on one spot
  if (X) {
    S.extending = null; const added = o.points.length - X.len;
    if (X.fromStart) { o.points.reverse(); if (o.folds) o.folds = o.folds.map((f) => f + added); }
    if (o.type === "spine") Spine.recompute(o); if (o.source === "model") o.source = "edited";
    S.objects.splice(X.index, 0, o); S.selected = o.id; setTool("select"); changed(); status(`Extended by ${added} point${added === 1 ? "" : "s"}`); return;
  }
  if (o.type === "spine") Spine.init(o);
  snapshot(); S.objects.push(o); S.selected = o.id; showTab("work"); changed();
}
function removeSelected() {
  if (Mask.sel) return Mask.relabelSel(0);
  const o = S.objects.find((x) => x.id === S.selected); if (!o) return;
  if (S.selVtx?.id === o.id) return removeVertex(o, S.selVtx.v);
  snapshot(); const gone = new Set([o.id, ...S.objects.filter((w) => w.parent === o.id).map((w) => w.id)]);
  S.objects = S.objects.filter((x) => !gone.has(x.id)); S.selected = null; S.selVtx = null; changed();
}
// ---- mask: parts in a label map (mask.js); edits are ops in S.objects so save, versions and undo carry them
const maskSig = () => S.objects.filter((o) => o.type === "stroke").map((o) => o.id).join() + "|" + JSON.stringify(Mask.ready ? Mask.parts().map((p) => [p.id, p.cls, p.n, p.color || "", p.name || ""]) : []);
function paintSeg(canvas, color, st, i) {
  const g = canvas.getContext("2d"), a = st.points[Math.max(0, i - 1)], b = st.points[i];
  g.setTransform(canvas.width / S.sheet.width, 0, 0, canvas.height / S.sheet.height, 0, 0);
  g.globalCompositeOperation = st.mode === "del" ? "destination-out" : "source-over"; g.strokeStyle = color; g.lineWidth = 2 * st.r; g.lineCap = "round";
  g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0] + (i ? 0 : 0.01), b[1]); g.stroke();
  g.setTransform(1, 0, 0, 1, 0, 0); g.globalCompositeOperation = "source-over";
}
/** while the brush moves: paint straight onto the canvases; the label map is updated when the stroke ends */
function paintLive(st, i) { paintSeg(S.mask, "#fff", st, i); paintSeg(S.maskTint, Mask.color(st.to), st, i); }
function rebuildMask() {
  if (!Mask.ready) return;
  Mask.rebuild(); S.maskSig = maskSig(); S.field = null; Spine.maskChanged(S.objects.some((o) => o.type === "stroke")); draw();
}
/** the mask a sheet starts from: a saved version's, else the model's (or an empty one for uploads) */
async function applyBase(v) {
  const id = S.sheet?.id; Mask.reset();
  try {
    if (v?.mask) { await Mask.fromSaved(v.mask); if (S.sheet?.id !== id) return; Mask.adoptParts(v.mask); }
    else if (S.maskModel) Mask.fromAlpha(S.maskModel); else return;
  } catch (e) { status(e.message); if (!S.maskModel) return; Mask.fromAlpha(S.maskModel); }
  rebuildMask(); Ann.markClean("mask"); panel();
}
/** a finished mask edit: update the label map directly, without replaying everything */
function maskEdited(op) { S.objects.push(op); Mask.apply(op); S.maskSig = maskSig(); S.field = null; Spine.maskChanged(true); changed(); }
function endStroke() {
  const st = S.stroke; S.stroke = null; if (!st) return;
  st.points = st.points.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]);
  maskEdited(st);
}
// ---- magic selection: click a colour, the connected area joins or leaves the mask (Photoshop's Magic Wand)
function photoLab() {
  const w = S.mask.width, h = S.mask.height;
  if (S.photo && S.photo.img === S.img && S.photo.w === w) return S.photo;
  const e = document.createElement("canvas"); e.width = w; e.height = h; const g = e.getContext("2d", { willReadFrequently: true }); g.imageSmoothingQuality = "high"; g.drawImage(S.img, 0, 0, w, h);
  return (S.photo = { img: S.img, w, h, lab: Smart.labGrid(g.getImageData(0, 0, w, h).data, w, h) });
}
function magicRegion(p) {
  const P = photoLab(), sel = Smart.magicSelect(P.lab, P.w, P.h, [(p[0] * P.w) / S.sheet.width, (p[1] * P.h) / S.sheet.height], S.tol, { contiguous: S.connected });
  return sel ? { sel, runs: Smart.regionRuns(sel, P.w), w: P.w, h: P.h } : null;
}
const magicStatus = (n, w, mode) => {
  const p = S.sheet.px_per_mm, a = n * (S.sheet.width / w) ** 2, h = S.mask.height, most = n > 0.5 * w * h;
  status(most ? "That selected most of the sheet (probably the paper). Undo with Ctrl Z, or lower Tolerance." : `${mode === "del" ? "Removed" : "Added"} ${p ? `${f(a / (p * p), 1)} mm²` : `${n.toLocaleString()} px`}. Too much or too little? Move Tolerance.`);
};
function applyMagic(p, flip) {
  if (!S.mask) return status("The mask is still loading");
  if (!S.img) return status("The photo is still loading");
  let r; try { r = magicRegion(p); } catch { return status("Magic select can't read this photo (demo sheets load from herbarium servers). Use the brush here."); }
  if (!r) return status("Click on the sheet");
  const mode = S.tool.endsWith("_del") !== flip ? "del" : "add";
  snapshot(); const o = { id: uid(), type: "stroke", kind: "region", mode, to: mode === "add" ? Mask.active() : 0, w: r.w, h: r.h, runs: r.runs, points: [[Math.round(p[0]), Math.round(p[1])]], r: 0, source: "human" };
  S.lastMagic = { id: o.id, p }; maskEdited(o); magicStatus(r.sel.count, r.w, mode);
}
// ---- quick selection: paint over part of the plant; the selection grows into similar colour around the stroke
function quickRegion(Q) {
  const P = photoLab(), k = P.w / S.sheet.width;
  const sel = Smart.quickSelect(P.lab, P.w, P.h, Q.points.map((p) => [p[0] * k, p[1] * k]), Q.r * k, S.tol);
  return sel ? { sel, w: P.w, h: P.h } : null;
}
function quickPreview() {
  const Q = S.quick; if (!Q) return;
  let r; try { r = quickRegion(Q); } catch { S.quick = null; return status("Quick selection can't read this photo (demo sheets load from herbarium servers). Use the brush here."); }
  if (!r) return;
  const c = Q.canvas && Q.canvas.width === r.w ? Q.canvas : Object.assign(document.createElement("canvas"), { width: r.w, height: r.h }), g = c.getContext("2d"), im = g.createImageData(r.w, r.h);
  const [R, G, B] = Q.mode === "del" ? [255, 90, 90] : Mask.rgb(Mask.part(Q.to) || { cls: "plant", n: 1 });
  const { region, x0, y0, x1, y1 } = r.sel;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = y * r.w + x; if (region[i]) im.data.set([R, G, B, 150], i * 4); }
  g.putImageData(im, 0, 0); Q.canvas = c; Q.last = r; draw();
}
let quickTimer = 0;
function quickUpdate(now) { if (now) { clearTimeout(quickTimer); quickTimer = 0; quickPreview(); return; } if (!quickTimer) quickTimer = setTimeout(() => { quickTimer = 0; quickPreview(); }, 50); }
function quickEnd() {
  const Q = S.quick; S.quick = null; clearTimeout(quickTimer); quickTimer = 0; if (!Q) return;
  let r; try { r = quickRegion(Q); } catch { draw(); return; } if (!r) { draw(); return; }
  snapshot(); const o = { id: uid(), type: "stroke", kind: "region", mode: Q.mode, to: Q.mode === "add" ? Q.to : 0, w: r.w, h: r.h, runs: Smart.regionRuns(r.sel, r.w), points: [Q.points[0].map(Math.round)], r: 0, source: "human" };
  S.lastMagic = null; maskEdited(o); magicStatus(r.sel.count, r.w, Q.mode);
}
/** tolerance moved: the last magic click follows it, so one click can be tuned */
function retuneMagic() {
  const L = S.lastMagic, o = S.objects.at(-1); if (!L || !o || o.id !== L.id || !S.img || !S.mask) return;
  let r; try { r = magicRegion(L.p); } catch { return; } if (!r) return;
  o.runs = r.runs; o.id = L.id = uid(); S.rev++; panel(); draw(); magicStatus(r.sel.count, r.w, o.mode);
}
function setTolerance(v) {
  S.tol = Math.max(1, Math.min(100, Math.round(v))); try { localStorage.setItem("pv_tol", S.tol); } catch {}
  const r = $("optTol"), o = $("optTolV"); if (r) r.value = S.tol; if (o) o.textContent = S.tol; retuneMagic();
}
/** the settings of the active mask tool, in the bottom bar */
const activeChip = () => { if (!Mask.ready) return ""; const id = Mask.active(), p = Mask.part(id); return p ? `<button type="button" class="chip" id="optPart" title="The part Magic and Brush paint into: click to change it in the Mask tab"><span class="dot" style="background:${Mask.css(p)}"></span>${Mask.label(p)}</button>` : ""; };
function toolOptions() {
  const box = $("toolOpts");
  if (BRUSH[S.tool]) {
    box.hidden = false; box.innerHTML = activeChip() + `<label title="Brush size: [ smaller, ] larger">Size <kbd>[</kbd><input type="range" id="optSize" min="3" max="150" value="${S.brushPx}"><kbd>]</kbd></label>`;
    $("optSize").oninput = (e) => setBrush(+e.target.value); $("optSize").onchange = (e) => e.target.blur();
  } else if (QUICK[S.tool]) {
    box.hidden = false; box.innerHTML = activeChip() + `<label title="Brush size: [ smaller, ] larger">Size <kbd>[</kbd><input type="range" id="optSize" min="3" max="150" value="${S.brushPx}"><kbd>]</kbd></label><label title="How different a colour may be and still be picked up">Tolerance <input type="range" id="optTol" min="1" max="60" value="${S.tol}"><b id="optTolV">${S.tol}</b></label>`;
    $("optSize").oninput = (e) => setBrush(+e.target.value); $("optSize").onchange = (e) => e.target.blur();
    $("optTol").oninput = (e) => setTolerance(+e.target.value); $("optTol").onchange = (e) => e.target.blur();
  } else if (MAGIC[S.tool]) {
    box.hidden = false; box.innerHTML = activeChip() + `<label title="How different a colour may be and still be selected: [ fewer colours, ] more. Your last click updates.">Tolerance <kbd>[</kbd><input type="range" id="optTol" min="1" max="60" value="${S.tol}"><kbd>]</kbd><b id="optTolV">${S.tol}</b></label><label title="On: only the connected area. Off: this colour everywhere on the sheet."><input type="checkbox" id="optConn"${S.connected ? " checked" : ""}> Connected</label>`;
    $("optTol").oninput = (e) => setTolerance(+e.target.value); $("optTol").onchange = (e) => e.target.blur();
    $("optConn").onchange = (e) => { S.connected = e.target.checked; try { localStorage.setItem("pv_connected", S.connected ? "1" : "0"); } catch {} e.target.blur(); retuneMagic(); };
  } else { box.hidden = true; box.innerHTML = ""; }
  const chip = $("optPart"); if (chip) chip.onclick = () => showTab("mask");
}
function setBrush(px) { S.brushPx = Math.max(3, Math.min(150, Math.round(px))); try { localStorage.setItem("pv_brush", S.brushPx); } catch {} const r = $("optSize"); if (r) r.value = S.brushPx; status(`Brush size ${S.brushPx * 2} px on screen`); draw(); }
function undo() { const u = S.undo.pop(); if (!u) return; S.objects = JSON.parse(u); S.selected = null; changed(); }
// saving, versions per annotator, export: annotators.js
const save = () => { if (S.drawing) finish(); Ann.save(); }, resetEdits = () => Ann.reset(), exportEdits = () => Ann.exportAll();
$("saveBtn").onclick = save; $("resetBtn").onclick = resetEdits; $("dlBtn").onclick = exportEdits;
$("undoBtn").onclick = undo; $("fitBtn").onclick = fit;
// tool rail tooltips: name, shortcut, how to use it
document.querySelectorAll("#tools [data-tip]").forEach((b) => {
  b.onmouseenter = () => {
    const tip = $("tip"), [name, key, how] = b.dataset.tip.split("|"), r = b.getBoundingClientRect();
    tip.children[0].textContent = name; tip.children[1].textContent = key; tip.children[1].hidden = !key; tip.children[2].textContent = how;
    tip.hidden = false; tip.style.left = `${r.right + 10}px`; tip.style.top = `${Math.max(56, Math.min(innerHeight - tip.offsetHeight - 48, r.top))}px`;
  };
  b.onmouseleave = () => { $("tip").hidden = true; };
});

// ---------------------------------------------------------------- input
cv.addEventListener("pointerdown", (e) => {
  if (!S.sheet || (e.button !== 0 && e.button !== 1)) return; cv.setPointerCapture(e.pointerId);
  if (S.space || e.button === 1) { S.press = { x: e.offsetX, y: e.offsetY, tx: V.tx, ty: V.ty, moved: false, mode: "maybe", panOnly: true }; return; }
  if (QUICK[S.tool]) {
    if (!S.mask) return status("The mask is still loading");
    if (!S.img) return status("The photo is still loading");
    const p0 = toImage(e.offsetX, e.offsetY);
    S.quick = { points: [p0], r: S.brushPx / V.s, mode: (S.tool === "quick_del") !== e.altKey ? "del" : "add", to: Mask.active() };
    S.press = { x: e.offsetX, y: e.offsetY, moved: false, mode: "quick" }; quickUpdate(true); return;
  }
  if (BRUSH[S.tool]) {
    if (!S.mask) { status("The mask is still loading"); return; }
    snapshot(); const p0 = toImage(e.offsetX, e.offsetY);
    S.stroke = { id: uid(), type: "stroke", mode: (S.tool === "brush_del") !== e.altKey ? "del" : "add", to: Mask.active(), r: Math.round((S.brushPx / V.s) * 10) / 10, points: [p0], source: "human" };
    paintLive(S.stroke, 0); S.press = { x: e.offsetX, y: e.offsetY, moved: false, mode: "brush" }; draw(); return;
  }
  const p = toImage(e.offsetX, e.offsetY), sec = !S.drawing && S.tool === "select" ? Spine.hitSection(p) : null;
  if (sec) { snapshot(); S.press = { x: e.offsetX, y: e.offsetY, tx: V.tx, ty: V.ty, moved: false, sec, mode: "section" }; return; }
  const h = !S.drawing && S.tool === "select" ? hit(p) : null, vtx = h && h.v != null;
  if (vtx) { snapshot(); S.selected = h.o.id; S.selVtx = { id: h.o.id, v: h.v }; Mask.clearSel(); panel(); }
  S.press = { x: e.offsetX, y: e.offsetY, tx: V.tx, ty: V.ty, moved: false, o: vtx ? h.o : null, v: vtx ? h.v : null, mode: vtx ? "vertex" : S.tool === "contour" ? "free" : "maybe" };
});
cv.addEventListener("pointermove", (e) => {
  if (!S.sheet) return; S.cursor = toImage(e.offsetX, e.offsetY); const P = S.press; S.manual = e.shiftKey; S.alt = e.altKey; if (MASK_TOOL[S.tool]) draw();
  if (P && P.mode === "quick" && S.quick) {
    if (dist(S.quick.points.at(-1), S.cursor) * V.s >= 4) { S.quick.points.push(S.cursor); quickUpdate(); }
    draw(); return;
  }
  if (P && P.mode === "brush") {
    const st = S.stroke, last = st.points.at(-1);
    if (dist(last, S.cursor) * V.s >= 2) { st.points.push(S.cursor); paintLive(st, st.points.length - 1); }
    draw(); return;
  }
  if (P && P.mode === "free") {
    if (!P.moved && Math.hypot(e.offsetX - P.x, e.offsetY - P.y) > CLICK_TOL) { P.moved = true; if (!S.drawing) { S.drawing = { id: uid(), type: "contour", points: [toImage(P.x, P.y)], flags: {}, source: "human" }; P.started = true; } }
    if (P.moved && dist(S.drawing.points.at(-1), S.cursor) * V.s >= 4) S.drawing.points.push(S.cursor);
    draw(); return;
  }
  if (!P && S.drawing && TRACED[S.drawing.type] && snapping()) schedulePreview(); else if (!S.drawing || !snapping()) S.preview = null;
  if (P) {
    const dx = e.offsetX - P.x, dy = e.offsetY - P.y;
    if (!P.moved && Math.hypot(dx, dy) > CLICK_TOL) { P.moved = true; if (P.mode === "maybe") P.mode = "pan"; cv.classList.add("grabbing"); }
    if (P.moved && P.mode === "pan") { V.tx = P.tx + dx; V.ty = P.ty + dy; }
    if (P.moved && P.mode === "vertex") { P.o.points[P.v] = [Math.round(S.cursor[0]), Math.round(S.cursor[1])]; if (P.o.type === "spine") Spine.recompute(P.o); }
    if (P.moved && P.mode === "section") Spine.dragSection(P.sec, S.cursor);
  }
  if (S.drawing) status(`${TYPES[S.drawing.type].label}  ${labelFor(S.drawing, livePts())}`);
  draw();
});
cv.addEventListener("pointerup", (e) => {
  const P = S.press; S.press = null; cv.classList.remove("grabbing"); if (!P || !S.sheet) return; S.manual = e.shiftKey;
  if (P.mode === "brush") { endStroke(); return; }
  if (P.mode === "quick") { quickEnd(); return; }
  if (P.panOnly && !P.moved) return;
  if (P.mode === "free" && P.moved) { if (P.started) finish(); return; }
  if (P.mode === "section") { Spine.UI.sec = { id: P.sec.o.id, k: P.sec.k }; if (P.moved) { if (P.sec.o.source === "model") P.sec.o.source = "edited"; changed(); } else { S.undo.pop(); draw(); } return; }
  if (P.mode === "vertex") { if (P.moved) { if (P.o.source === "model") P.o.source = "edited"; changed(); } else S.undo.pop(); if (P.o.type === "spine") Spine.clickVertex(P.o, P.v, P.moved); return; }
  if (P.moved) return;
  const p = toImage(e.offsetX, e.offsetY);
  if (S.tool === "select") {
    const cur = S.objects.find((x) => x.id === S.selected);
    if (S.insertMode && cur && insertVertex(cur, p)) return;
    if (S.widthMode && cur?.type === "spine" && Spine.addSection(cur, p)) return;
    S.insertMode = S.widthMode = false;
    const h = hit(p);
    if (h) { if (h.o.id !== S.selected || h.v == null) S.selVtx = null; S.selected = h.o.id; Mask.clearSel(); showTab("work"); }
    else { S.selected = null; S.selVtx = null; if (Mask.selectAt(p, e.shiftKey)) { showTab("mask"); status("Area selected: use the bar beside it, or Shift+click to add more areas"); } else Mask.clearSel(); }
    panel(); draw();
  } else if (MAGIC[S.tool]) applyMagic(p, e.altKey); else addPoint(p);
});
cv.addEventListener("dblclick", (e) => {
  e.preventDefault(); const d = S.drawing;
  if (!d && S.tool === "select") { const o = S.objects.find((x) => x.id === S.selected); if (o && TYPES[o.type]?.geom === "poly") insertVertex(o, toImage(e.offsetX, e.offsetY)); return; }
  if (!d || TYPES[d.type].geom !== "poly") return; while (!d.marks && d.points.length > 2 && dist(d.points.at(-1), d.points.at(-2)) * V.s < 6) d.points.pop(); finish();
});
cv.addEventListener("wheel", (e) => { e.preventDefault(); const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY; zoomAt(e.offsetX, e.offsetY, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0018))); }, { passive: false });
addEventListener("resize", resize);
addEventListener("keyup", (e) => { if (e.key === " ") { S.space = false; cv.classList.remove("grab"); } if (e.key === "Alt") { e.preventDefault(); S.alt = false; draw(); } });
addEventListener("keydown", (e) => { if (e.key === "Alt" && MASK_TOOL[S.tool]) { e.preventDefault(); S.alt = true; draw(); } });   // Alt swaps + and −; the browser menu must not take it
addEventListener("blur", () => { S.alt = false; });
cv.addEventListener("pointerleave", () => { if (MASK_TOOL[S.tool]) { S.cursor = null; draw(); } });
// right panel tabs; working on the image brings the Measure tab back
function showTab(p) {
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("on", b.dataset.p === p));
  document.querySelectorAll("#panel .pane").forEach((e) => (e.hidden = e.id !== "p-" + p));
}
document.querySelectorAll("#tabs button").forEach((b) => (b.onclick = () => showTab(b.dataset.p)));
addEventListener("keydown", (e) => {
  const fa = document.activeElement, field = (el) => !!el && (["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName) || el.isContentEditable);
  if (field(e.target) || (field(fa) && !["checkbox", "range", "color"].includes(fa.type)) || !S.meta || !$("annModal").hidden || !$("upModal").hidden) return;
  const k = (e.key || "").toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === "s") { e.preventDefault(); save(); return; }
  if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); undo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (k === "enter") { if (S.drawing) finish(); }
  else if (k === "escape") { if (S.extending) cancelExtend(); else if (S.drawing) S.drawing = null; else if (S.insertMode || S.widthMode) S.insertMode = S.widthMode = false; else if (Mask.sel) Mask.clearSel(); else { S.selected = null; S.selVtx = null; } status(S.dirty ? "Unsaved corrections" : ""); panel(); draw(); }
  else if (k === "backspace") { e.preventDefault(); if (S.drawing) { const d = S.drawing; S.preview = null; if (S.extending && (d.marks ? d.marks.length <= 1 : d.points.length <= S.extending.len)) { cancelExtend(); return; } if (d.marks) { d.marks.pop(); if (d.marks.length) d.points.length = d.marks.at(-1); else S.drawing = null; } else { d.points.pop(); if (!d.points.length) S.drawing = null; } draw(); } else removeSelected(); }
  else if (k === "delete") removeSelected();
  else if (Spine.key(k)) {}
  else if (k === "s") setSnap(!S.snap);
  else if (k === "[") { if (MAGIC[S.tool]) setTolerance(S.tol - 3); else setBrush(S.brushPx * 0.8); }
  else if (k === "]") { if (MAGIC[S.tool]) setTolerance(S.tol + 3); else setBrush(S.brushPx * 1.25); }
  else if (k === "q" && S.tool === "quick_add") setTool("quick_del");
  else if (k === " ") { e.preventDefault(); if (!S.space) { S.space = true; cv.classList.add("grab"); } }
  else if (k === "f") fit();
  else if (k === "0") { const a = area(); zoomAt(a.x + a.w / 2, a.y + a.h / 2, 1 / V.s); }
  else if (k >= "1" && k <= "6") setTrait(TRAITS[+k - 1].key);
  else if (k === "o") setOverlay(OVERLAYS[(OVERLAYS.findIndex(([m]) => m === S.overlay) + 1) % OVERLAYS.length][0]);
  else if (k === "p") { const i = VIEWS.findIndex(([v]) => v === S.view); setView(VIEWS[(i + 1) % VIEWS.length][0]); }
  else if (k === "m") { const runs = Object.keys(S.meta.models); loadRun(runs[(runs.indexOf(S.run) + 1) % runs.length]); }
  else if (k === "arrowright") go(1);
  else if (k === "arrowleft") go(-1);
  else if (k === "h") $("help").hidden = !$("help").hidden;
  else if (k === "tab") { e.preventDefault(); document.querySelectorAll(".hud").forEach((h) => h.classList.toggle("hidden")); }
  else if (TOOL_KEYS[k]) setTool(TOOL_KEYS[k]);
});
function setTrait(k) { S.trait = k; document.querySelectorAll("#traits button").forEach((b) => b.classList.toggle("on", b.dataset.k === k)); panel(); draw(); }
$("traits").innerHTML = TRAITS.map((t, i) => `<button data-k="${t.key}">${t.label}<i>${i + 1}</i></button>`).join("");
document.querySelectorAll("#traits button").forEach((b) => (b.onclick = () => setTrait(b.dataset.k)));
function setView(v) {
  if (!VIEWS.some(([k]) => k === v)) v = "photo";
  S.view = v; document.querySelectorAll("#views button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
  const ex = S.meta?.examples[S.idx];
  if (v === "label" && ex?.label_source) status(`${ex.label_source} — red plant, teal unsure (ignored in training)`);
  else if (v === "depth") status("Relative depth (Depth Anything V2): brighter = nearer");
  draw();
}
function buildViews(ex) {
  VIEWS = ALL_VIEWS.filter(([k]) => k === "photo" || k === "plant" || k === "mask" || !!ex.files[k]);
  $("views").innerHTML = VIEWS.map(([k, l]) => `<button data-v="${k}">${l}</button>`).join("");
  document.querySelectorAll("#views button").forEach((b) => (b.onclick = () => setView(b.dataset.v)));
}

// ---------------------------------------------------------------- panels
const median = (a) => { const s = [...a].sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
function traitValues(t) { const out = []; for (const o of S.objects) { if (o.type !== t.type || !inScope(o)) continue; if (t.key === "blade_length" && o.flags && o.flags.intact === false) continue; const v = t.value(o); if (v != null && isFinite(v)) out.push({ o, v }); } return out; }
function panel() {
  if (!S.sheet) return;
  $("undoBtn").disabled = !S.undo.length;
  if (Mask.ready && !S.stroke && maskSig() !== S.maskSig) rebuildMask();   // undo, versions: the mask follows the ops
  for (const part of [Mask.panel, Ann.panel, Spine.panel, keyPanel]) { try { part(); } catch (e) { console.error(e); } }   // one side panel failing must not leave the trait list stale
  const t = traitDef(), list = $("list"), keyMode = S.overlay === "key", K = keyMode ? keys() : null; list.innerHTML = "";
  const pm = (s, dp) => (s.n ? `${f(s.mean, dp)}${s.sd != null ? ` ± ${f(s.sd, dp)}` : ""}` : "—");
  if (t.key === "all") {
    const n = S.objects.filter((o) => (o.type === "blade" || o.type === "culm") && inScope(o)).length, mine = S.overlay === "mine";
    $("traitTitle").textContent = "All traits · this sheet"; $("traitBig").textContent = n ? `${n} organ${n === 1 ? "" : "s"}` : mine ? "Nothing drawn yet" : "No organs";
    $("traitSub").textContent = mine ? (n ? "your lines on this sheet; choose a trait to highlight it" : (SHOW_PREDICTED ? "pick a tool on the left and draw on the image; Key or All (bottom bar) show the predicted lines" : "pick a tool on the left and draw on the image")) : keyMode ? `key organs: mean ± sd (n) of a few clearly visible ones; all: median of every line` : "choose a trait to highlight it; edit lines with the tools on the left"; drawChart([]);
    for (const tr of TRAITS.slice(1)) {
      const all = traitValues(tr), v = all.map((x) => x.v), el = document.createElement("div"), dp = tr.dp ?? 1; el.className = "item";
      if (keyMode) {
        const s = Represent.stats(all.filter((x) => K.byTrait[tr.key].has(x.o.id)).map((x) => x.v));
        el.innerHTML = `<span></span><span class="t">${tr.label}<span class="tag">key</span></span><span class="v">${pm(s, dp)}<span class="sub"> ${tr.unit} (${s.n})</span></span><span class="x">all: median ${v.length ? f(median(v), dp) : "—"} ${tr.unit} (${v.length})</span>`;
      } else el.innerHTML = `<span></span><span class="t">${tr.label}</span><span class="v">${v.length ? f(median(v), dp) : "—"}<span class="sub"> ${tr.unit}</span></span><span class="x">${v.length ? `n ${v.length} · range ${f(Math.min(...v), dp)}–${f(Math.max(...v), dp)}` : "no values"}</span>`;
      el.onclick = () => setTrait(tr.key); list.appendChild(el);
    }
    if (mine) {
      const seen = {}, rows = S.objects.filter((o) => !isMaskObj(o) && inScope(o));   // spines and contours too: every row can be edited or deleted
      if (rows.length) { const h = document.createElement("div"); h.className = "k gap"; h.textContent = Ann.viewingOther() ? `${Ann.viewingOther()}'s lines` : "Your lines"; list.appendChild(h); }
      for (const o of rows) { seen[o.type] = (seen[o.type] || 0) + 1; list.appendChild(organRow(o, `${TYPES[o.type].label} ${seen[o.type]}`, labelFor(o), "", null)); }
    }
    if (keyMode && K.organs.length) {
      const h = document.createElement("div"); h.className = "k gap"; h.textContent = "Key organs"; list.appendChild(h);
      for (const id of K.organs) { const o = S.objects.find((x) => x.id === id); if (o) list.appendChild(organRow(o, `${TYPES[o.type].label} ${K.num.get(id)}`, fmtLen(mm(plen(o.points))), "", null)); }
    }
    return;
  }
  const vals = traitValues(t), v = vals.map((x) => x.v), dp = t.dp ?? 1, kset = keyMode ? K.byTrait[t.key] : null;
  $("traitTitle").textContent = t.label;
  if (keyMode) {
    const s = Represent.stats(vals.filter((x) => kset.has(x.o.id)).map((x) => x.v));
    $("traitBig").textContent = s.n ? `${pm(s, dp)} ${t.unit}` : "—";
    $("traitSub").textContent = `key: mean ± sd of ${s.n} · all: median ${v.length ? f(median(v), dp) : "—"} ${t.unit} (${v.length})${v.length ? ` · range ${f(Math.min(...v), dp)}–${f(Math.max(...v), dp)}` : ""}${t.note ? " · " + t.note : ""}`;
  } else {
    $("traitBig").textContent = v.length ? `${f(median(v), dp)} ${t.unit}` : "—";
    $("traitSub").textContent = v.length ? `median of ${v.length} · range ${f(Math.min(...v), dp)}–${f(Math.max(...v), dp)} ${t.unit}${t.note ? " · " + t.note : ""}` : "none on this sheet";
  }
  drawChart(vals);
  vals.sort((a, b) => (kset ? kset.has(b.o.id) - kset.has(a.o.id) : 0) || b.v - a.v).forEach(({ o, v: val }, i) => {
    const par = o.type.endsWith("width") ? parentOf(o) : o, target = par || o;
    const x = par && par !== o ? `on ${TYPES[par.type].label.toLowerCase()} ${fmtLen(mm(plen(par.points)))}` : "";
    list.appendChild(organRow(o, `${TYPES[target.type].label} ${i + 1}`, f(val, dp), x, vals, kset));
  });
}
const ICON_EDIT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>', ICON_DEL = `<svg viewBox="0 0 24 24" aria-hidden="true">${CTX_ICON.trash}</svg>`;
/** one list row: star (Key mode), label, value; hover highlights, click selects + focuses; flags when selected; edit / delete */
function organRow(o, label, value, x, vals, kset) {
  const par = o.type.endsWith("width") ? parentOf(o) : o, target = par || o, el = document.createElement("div");
  el.className = "item" + (o.id === S.selected ? " sel" : "");
  let star = "";
  if (S.overlay === "key") {
    const on = kset ? kset.has(o.id) : keys().organSet.has(o.id), cls = target.key === true ? "pin" : target.key === false ? "ex" : on ? "auto" : "";
    star = `<button class="star ${cls}" title="${on ? "Key (click to exclude)" : "Not key (click to pin)"}${target.key != null ? " · set by hand" : ""}">${on ? "★" : "☆"}</button>`;
  }
  el.innerHTML = `<span class="sw" style="background:${TYPES[o.type].color}"></span><span class="t">${star}${label}<span class="tag">${o.source || "model"}</span></span><span class="v">${value}</span><span class="x">${x}</span>`
    + `<span class="rowAct"><button type="button" class="ic" data-ra="edit" title="Edit: select it and show it on the image">${ICON_EDIT}</button><button type="button" class="ic" data-ra="del" title="Delete this ${TYPES[o.type].label.toLowerCase()}">${ICON_DEL}</button></span>`;
  el.querySelector('[data-ra="edit"]').onclick = (ev) => { ev.stopPropagation(); if (S.tool !== "select") setTool("select"); S.selected = o.id; S.selVtx = null; Mask.clearSel(); focusOn(par ? par.points.concat(o.points) : o.points); panel(); draw(); status("Selected: drag its points, or use the bar beside it"); };
  el.querySelector('[data-ra="del"]').onclick = (ev) => { ev.stopPropagation(); S.selected = o.id; S.selVtx = null; removeSelected(); };
  const redraw = () => { draw(); if (vals) drawChart(vals); };
  el.onmouseenter = () => { S.hot = o.id; redraw(); }; el.onmouseleave = () => { S.hot = null; redraw(); };
  const sb = el.querySelector(".star"); if (sb) sb.onclick = (ev) => { ev.stopPropagation(); toggleKey(o); };
  el.onclick = () => { S.selected = o.id; focusOn(par ? par.points.concat(o.points) : o.points); panel(); };
  if (o.id === S.selected && FLAGS[target.type]) {
    const fl = document.createElement("div"); fl.className = "flags";
    for (const [k, name] of FLAGS[target.type]) {
      const b = document.createElement("button"); b.textContent = name; b.className = target.flags?.[k] ? "on" : "";
      b.onclick = (ev) => { ev.stopPropagation(); snapshot(); target.flags = { ...(target.flags || {}), [k]: !target.flags?.[k] }; if (target.source === "model") target.source = "edited"; changed(); };
      fl.appendChild(b);
    }
    el.appendChild(fl);
  }
  return el;
}
/** Key mode: how many key organs per type, and a reset for hand-set pins / exclusions */
function keyPanel() {
  const box = $("keyBox"); if (!box) return;
  if (S.overlay !== "key" || !S.sheet) { box.hidden = true; box.innerHTML = ""; return; }
  const K = keys(), hand = S.objects.filter((o) => "key" in o).length;
  box.hidden = false;
  box.innerHTML = `<div class="rowx"><span class="k">Key organs</span><span class="grow"></span><span class="sub">${K.blade.length} blades · ${K.culm.length} culms</span></div>`
    + ["blade", "culm"].map((tp) => `<div class="rowx"><span class="sub kk">${TYPES[tp].label}s</span><button class="small" data-kt="${tp}" data-d="-1" title="Fewer key ${tp}s">−</button><span class="sub kn">${S.keyK[tp]}</span><button class="small" data-kt="${tp}" data-d="1" title="More key ${tp}s">+</button></div>`).join("")
    + `<div class="rowx"><span class="sub">★ in the lists pins / excludes${hand ? ` · ${hand} set by hand` : ""}</span><span class="grow"></span>${hand ? '<button class="small" id="keyReset" title="Back to the automatic pick">Auto</button>' : ""}</div>`;
  box.querySelectorAll("[data-kt]").forEach((b) => (b.onclick = () => setKeyK(b.dataset.kt, +b.dataset.d)));
  const r = $("keyReset"); if (r) r.onclick = resetKeys;
}
function drawChart(vals) {
  const c = $("chart"), g = c.getContext("2d"), W = c.width, H = c.height; g.clearRect(0, 0, W, H);
  if (!vals.length) { c.style.display = "none"; return; } c.style.display = "block";
  const v = vals.map((x) => x.v), lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1, X = (x) => 16 + ((x - lo) / span) * (W - 32), t = traitDef();
  g.strokeStyle = "#333"; g.lineWidth = 2; g.beginPath(); g.moveTo(16, H - 22); g.lineTo(W - 16, H - 22); g.stroke();
  const ks = S.overlay === "key" ? keys().byTrait[t.key] : null;
  vals.forEach(({ o, v: x }, k) => { const hp = o.id === S.hot || o.id === S.selected; g.fillStyle = hp ? "#fff" : TYPES[o.type].color; g.globalAlpha = hp ? 1 : ks && !ks.has(o.id) ? 0.25 : 0.8; g.beginPath(); g.arc(X(x), H - 40 + (hp ? 0 : ((k % 5) - 2) * 3), hp ? 7 : 5, 0, Math.PI * 2); g.fill(); });
  g.globalAlpha = 1; const md = median(v); g.strokeStyle = "#fff"; g.beginPath(); g.moveTo(X(md), 8); g.lineTo(X(md), H - 22); g.stroke();
  g.fillStyle = "#8a8a8a"; g.font = "20px Inter, sans-serif"; g.fillText(f(lo, t.dp ?? 1), 16, H - 2); const hs = f(hi, t.dp ?? 1); g.fillText(hs, W - 16 - g.measureText(hs).width, H - 2);
}
function modelButtons() {
  $("models").innerHTML = Object.keys(S.meta.models).map((r) => `<button data-r="${r}" title="${S.meta.models[r].title}">${RUN_LABEL[r] || r}</button>`).join("");
  document.querySelectorAll("#models button").forEach((b) => (b.onclick = () => loadRun(b.dataset.r)));
}
function runCard() {
  const m = S.meta.models[S.run], ex = S.meta.examples[S.idx], r = ex.runs[S.run] || { segmentation_s: null, organs_s: null, blades: 0, culms: 0, ran_at: "" };
  document.querySelectorAll("#models button").forEach((b) => b.classList.toggle("on", b.dataset.r === S.run));
  $("card").innerHTML = `<div class="t">${m.title}</div>
    <b>${m.train_sheets.toLocaleString()}</b> training sheets · ${m.val_sheets} held out<br>
    ${m.labels}<br>
    ${m.architecture} · input ${m.inputs}<br>
    Training: <b>${m.train_min} min</b> (${m.iterations.toLocaleString()} iterations, batch ${m.batch}, ${m.gpu})${m.extra ? `<br>${m.extra}` : ""}<br>
    Validation IoU <b>${f(m.val_iou, 3)}</b>${m.val_iou_independent ? ` (${f(m.val_iou_independent, 3)} vs independent labels)` : ""} — ${m.val_note}`;
  $("runInfo").innerHTML = `<span class="badge">Already run</span>segmentation <b>${f(r.segmentation_s, 2)} s</b> · organs <b>${f(r.organs_s, 2)} s</b>${r.depth_s ? ` · depth <b>${f(r.depth_s, 2)} s</b>` : ""}<br>
    ${r.blades} blades · ${r.culms} culms · run ${r.ran_at}<br>${Ann.runInfo()}`;
  if (ex.pending) $("runInfo").innerHTML = `The models haven't run on this specimen yet.<br>${Ann.runInfo()}`;
  const sc = S.sheet;
  $("scaleInfo").textContent = sc.px_per_mm ? `Scale ${f(sc.px_per_mm, 2)} px/mm · ${sc.scale_source === "ruler" ? "from the sheet's ruler" : "estimated from sheet size"}` : "No scale: lengths shown in pixels";
}

// ---------------------------------------------------------------- loading
function toast(t) { const e = $("toast"); e.textContent = t; e.classList.add("show"); clearTimeout(toast.t); toast.t = setTimeout(() => e.classList.remove("show"), 1800); }
function status(t) { $("status").textContent = t; }
const loadImage = (url) => new Promise((res, rej) => { const im = new Image(); im.decoding = "async"; im.onload = () => res(im); im.onerror = () => rej(new Error("image")); im.src = url; });
async function go(d) { const i = (S.idx + d + S.meta.examples.length) % S.meta.examples.length; await openExample(i); }
$("prev").onclick = () => go(-1); $("next").onclick = () => go(1);
$("example").onchange = (e) => openExample(+e.target.value);
function confirmLeave() {
  if (!S.dirty && !Meta.dirty()) return true;
  if (!confirm("You have unsaved changes. Leave without saving?")) return false;
  if (S.dirty) clearDraft();   // they chose to throw the work away
  return true;
}
async function openExample(i) {
  if (!confirmLeave()) { $("example").value = S.idx; return; }
  S.idx = i; const ex = S.meta.examples[i]; Meta.show(ex);
  $("example").value = i; $("count").textContent = `${i + 1} / ${S.meta.examples.length}`; pickLabel();
  $("why").innerHTML = `${ex.out_of_domain ? '<span class="badge">Not a grass</span>' : ""}${ex.group ? "" : `<b>${ex.challenge}.</b> `}${ex.why}${ex.out_of_domain && SHOW_PREDICTED ? " Organ lines (blade / culm) assume grass anatomy and are not meaningful here." : ""}`;
  S.extra = {}; buildViews(ex);
  for (const view of ["depth", "label"]) if (ex.files[view])
    fetchSealed(`data/s/${ex.files[view]}.m`).then((buf) => loadImage(URL.createObjectURL(new Blob([buf], { type: "image/png" }))))
      .then((im) => { if (S.idx === i) { S.extra[view] = im; draw(); } }).catch(() => {});
  history.replaceState(null, "", `#${i + 1}`);
  S.img = S.small = null; S.imgFor = null;
  await loadRun(S.run, true);
  setView(S.view);
}
function sheetInfo(sheet) {
  $("species").textContent = cap(sheet.species) || "Unknown";
  $("meta").textContent = [sheet.institution?.toUpperCase(), sheet.catalog, cap(sheet.state), (sheet.date || "").slice(0, 4)].filter(Boolean).join(" · ");
  $("links").innerHTML = [`${sheet.width.toLocaleString()} × ${sheet.height.toLocaleString()} px`, sheet.rights ? `licence ${sheet.rights}` : "",
    sheet.record_uuid ? `<a href="https://portal.idigbio.org/portal/records/${sheet.record_uuid}" target="_blank" rel="noopener">iDigBio record</a>` : "",
    /^https?:\/\//.test(sheet.record_url || "") ? `<a href="${PV_esc(sheet.record_url)}" target="_blank" rel="noopener">Record</a>` : ""].filter(Boolean).join(" · ");
}
/** an uploaded specimen the models haven't processed: its photo, no predictions, and an empty mask to paint on */
async function loadPending(ex, i) {
  const sheet = { id: ex.id, species: ex.species, institution: ex.institution, catalog: ex.catalog, state: "", date: "", rights: "", width: ex.width || 1, height: ex.height || 1,
    px_per_mm: null, scale_source: "none", mask_ppm: 5, objects: [], fine: [], run: S.run };
  const firstOpen = !S.sheet || S.sheet.id !== sheet.id; S.sheet = sheet;
  await Ann.prepare(ex); if (S.idx !== i) return;
  const saved = Ann.initial();
  S.objects = JSON.parse(JSON.stringify(saved ? saved.objects || [] : [])).filter(inScope); Ann.markClean("lines"); offerDraft();
  sheetInfo(sheet); runCard(); if (firstOpen) fit();
  const k = Math.min(1, 2400 / Math.max(sheet.width, sheet.height)), blank = document.createElement("canvas");
  blank.width = Math.max(1, Math.round(sheet.width * k)); blank.height = Math.max(1, Math.round(sheet.height * k));
  S.maskModel = blank; applyBase(saved); panel(); draw();
  status(saved ? `Showing your saved version (${Ann.active().name})` : "Loading image…");
  S.imgFor = sheet.id;
  try {
    const { url } = await PV.api(`/specimens/${ex.specId}/image?size=original`);
    const blob = await fetch(url).then((r) => { if (!r.ok) throw new Error(r.status); return r.blob(); });   // read as data so magic select can use the pixels
    const img = await loadImage(URL.createObjectURL(blob)); if (S.idx !== i || S.sheet?.id !== sheet.id) return;
    S.img = img; try { S.small = await createImageBitmap(img, { resizeWidth: Math.min(3000, img.naturalWidth), resizeQuality: "high" }); } catch {}
    if (!saved) status("No model results yet: draw by hand or paint the mask"); draw();
  } catch { if (S.sheet?.id === sheet.id) status("Could not load this image"); }
}
async function loadRun(run, force = false) {
  if (!force && !confirmLeave()) return;
  S.run = run; S.dirty = false; $("saveBtn").classList.remove("dirty"); S.undo = []; S.selected = null; S.hot = null; S.drawing = null; S.mask = S.maskTint = S.maskModel = S.field = S.preview = S.stroke = null; S.maskSig = ""; S.lastMagic = null; S.forceMaskSave = false; $("draftBar").hidden = true; S.selVtx = null; S.insertMode = S.widthMode = false; S.extending = null; Mask.reset();
  const ex = S.meta.examples[S.idx], i = S.idx, name = ex.files[run];
  if (ex.pending) return loadPending(ex, i);
  status("Decrypting results…");
  let sheet; try { sheet = await loadJSON(`data/s/${name}.j`); } catch (err) { status(`Could not load results (${err.message})`); return; }
  if (S.idx !== i || S.run !== run) return;
  const firstOpen = !S.sheet || S.sheet.id !== sheet.id;
  S.sheet = sheet;
  status("Loading saved versions…"); await Ann.prepare(ex); if (S.idx !== i || S.run !== run) return;
  const saved = Ann.initial();   // the active annotator's own saved version, else the model's
  S.objects = JSON.parse(JSON.stringify(saved ? saved.objects || [] : sheet.objects)).filter(inScope); Ann.markClean("lines"); offerDraft();   // predicted lines never enter the working set while they are off
  sheetInfo(sheet);
  runCard(); if (firstOpen) fit(); panel(); draw();
  status(saved ? `Showing your saved version (${Ann.active().name})` : "");
  fetchSealed(`data/s/${name}.m`).then((buf) => loadImage(URL.createObjectURL(new Blob([buf], { type: "image/png" })))).then((m) => {
    if (S.idx !== i || S.run !== run) return;
    const a = document.createElement("canvas"); a.width = m.width; a.height = m.height; const g = a.getContext("2d"); g.drawImage(m, 0, 0);
    const d = g.getImageData(0, 0, a.width, a.height), px = d.data;
    for (let k = 0; k < px.length; k += 4) { const on = px[k] > 127; px[k] = px[k + 1] = px[k + 2] = 255; px[k + 3] = on ? 255 : 0; }
    g.putImageData(d, 0, 0); S.maskModel = a; applyBase(saved);   // spine panel: placeholder widths are measured now
  }).catch(() => {});
  if (S.imgFor !== sheet.id) {
    S.imgFor = sheet.id; let url = (sheet.accessuri || "").replace(/^http:\/\//, "https://");
    if (!saved) status(ex.files.photo ? "Loading image…" : `Loading image from ${sheet.institution?.toUpperCase() || "herbarium"}…`);
    try {
      if (ex.files.photo) url = URL.createObjectURL(new Blob([await fetchSealed(`data/s/${ex.files.photo}.p`)], { type: "image/jpeg" }));
      const img = await loadImage(url); if (S.sheet?.id !== sheet.id) return;
      S.img = img; try { S.small = await createImageBitmap(img, { resizeWidth: Math.min(3000, img.naturalWidth), resizeQuality: "high" }); } catch {}
      if (!saved) status(""); draw();
    } catch { if (S.sheet?.id === sheet.id) status("Image unavailable from the herbarium server. Results still shown."); }
  }
}
addEventListener("beforeunload", (e) => { if (S.dirty) saveDraft(); if (S.dirty || Meta.dirty()) e.preventDefault(); });
function buildMenu() {
  const opt = (x, i) => `<option value="${i}">${x.group ? PV_esc(cap(x.species)) + (x.low_res ? " · low res" : "") : `${i + 1}. ${x.challenge} — ${cap(x.species)}`}</option>`;
  const groups = [...new Set(S.meta.examples.map((x) => x.group).filter(Boolean))];
  $("example").innerHTML = groups.map((g) => `<optgroup label="${PV_esc(g)}">${S.meta.examples.map((x, i) => x.group === g ? opt(x, i) : "").join("")}</optgroup>`).join("")
    + `<optgroup label="Demo · grass challenges">${S.meta.examples.map((x, i) => !x.group && !x.out_of_domain ? opt(x, i) : "").join("")}</optgroup>`
    + `<optgroup label="Demo · not grasses">${S.meta.examples.map((x, i) => !x.group && x.out_of_domain ? opt(x, i) : "").join("")}</optgroup>`;
  $("example").value = S.idx; if (S.meta.examples.length) $("count").textContent = `${S.idx + 1} / ${S.meta.examples.length}`;
  pickLabel(); if (!$("pickPanel").hidden) pickRender();
}
// ---- specimen picker: groups fold open and closed (remembered), search across everything
const PICK_KEY = "pv_groups_closed";
let pickClosed = new Set(), pickHi = -1;
try { pickClosed = new Set(JSON.parse(localStorage.getItem(PICK_KEY) || "[]")); } catch {}
const pickGroups = () => {
  const ex = S.meta.examples, groups = [...new Set(ex.map((x) => x.group).filter(Boolean))].map((g) => [g, ex.map((x, i) => [x, i]).filter(([x]) => x.group === g)]);
  return groups.concat([["Demo · grass challenges", ex.map((x, i) => [x, i]).filter(([x]) => !x.group && !x.out_of_domain)], ["Demo · not grasses", ex.map((x, i) => [x, i]).filter(([x]) => !x.group && x.out_of_domain)]]).filter(([, l]) => l.length);
};
const pickText = (x, i) => (x.group ? cap(x.species) : `${i + 1}. ${x.challenge} — ${cap(x.species)}`);
const pickDot = (x) => { const s = Ann.stageOf(x); return s ? `<i class="dot" data-s="${s}" title="${Ann.stageName(s)}"></i>` : `<i class="dot none"></i>`; };
function pickRefresh() { if (!$("pickPanel").hidden) pickRender(); }
$("pickStage").innerHTML = `<option value="">All stages</option>` + Ann.STAGES.map(([k, l]) => `<option value="${k}">${l}</option>`).join("");
$("pickStage").onchange = () => pickRender();
function pickLabel() { const x = S.meta?.examples[S.idx]; if (!x) return; $("pickName").textContent = pickText(x, S.idx); $("pickBtn").title = `${pickText(x, S.idx)} · choose a specimen`; }
function pickSave() { try { localStorage.setItem(PICK_KEY, JSON.stringify([...pickClosed])); } catch {} }
function pickRender() {
  const q = $("pickFind").value.trim().toLowerCase(), cur = S.meta.examples[S.idx], want = $("pickStage").value;
  let h = "", any = false;
  for (const [g, list] of pickGroups()) {
    const items = list.filter(([x, i]) => (!q || `${pickText(x, i)} ${x.institution || ""} ${x.catalog || ""} ${g}`.toLowerCase().includes(q)) && (!want || Ann.stageOf(x) === want));
    if (!items.length) continue; any = true;
    const open = q || want || !pickClosed.has(g);
    h += `<div class="pg${open ? " open" : ""}" data-g="${PV_esc(g)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg><span>${PV_esc(g)}</span><em>${q || want ? `${items.length} of ${list.length}` : list.length}</em></div>`;
    if (open) h += items.map(([x, i]) => `<div class="pi${i === S.idx ? " cur" : ""}" role="option" data-i="${i}" aria-selected="${i === S.idx}"><span>${pickDot(x)}${PV_esc(pickText(x, i))}</span><em>${PV_esc([x.institution, x.catalog].filter(Boolean).join(" · "))}${x.low_res ? ' <b>low res</b>' : ""}${x.pending ? ' <b>no model yet</b>' : ""}</em></div>`).join("");
  }
  $("pickList").innerHTML = any ? h : `<div class="sub pempty">${q ? `No specimen matches “${PV_esc(q)}”` : "No specimen"}${want ? ` at the stage “${Ann.stageName(want)}”` : ""}.</div>`;
  $("pickList").querySelectorAll(".pg").forEach((e) => (e.onclick = () => { const g = e.dataset.g; if (pickClosed.has(g)) pickClosed.delete(g); else pickClosed.add(g); pickSave(); pickRender(); }));
  $("pickList").querySelectorAll(".pi").forEach((e) => (e.onclick = () => pickChoose(+e.dataset.i)));
  pickHi = -1;
}
$("stageChip").onclick = () => showTab("status");
function pickOpen() {
  const p = $("pickPanel"), b = $("pickBtn").getBoundingClientRect();
  const cur = S.meta.examples[S.idx], g = cur.group || (cur.out_of_domain ? "Demo · not grasses" : "Demo · grass challenges");
  if (pickClosed.delete(g)) pickSave();   // the open specimen's set is always open
  p.hidden = false; $("pickBtn").setAttribute("aria-expanded", "true"); p.style.left = `${Math.max(8, b.left)}px`; p.style.top = `${b.bottom + 4}px`;
  $("pickFind").value = ""; pickRender(); $("pickFind").focus(); Ann.loadProgress();
  const c = $("pickList").querySelector(".pi.cur"); if (c) c.scrollIntoView({ block: "center" });
}
function pickClose() { $("pickPanel").hidden = true; $("pickBtn").setAttribute("aria-expanded", "false"); }
function pickChoose(i) { pickClose(); if (i !== S.idx) openExample(i); }
$("pickBtn").onclick = () => ($("pickPanel").hidden ? pickOpen() : pickClose());
$("pickFind").oninput = pickRender;
$("pickOpenAll").onclick = () => { pickClosed.clear(); pickSave(); pickRender(); };
$("pickCloseAll").onclick = () => { pickGroups().forEach(([g]) => pickClosed.add(g)); pickSave(); pickRender(); };
$("pickFind").onkeydown = (e) => {
  const items = [...$("pickList").querySelectorAll(".pi")];
  if (e.key === "Escape") { e.stopPropagation(); pickClose(); $("pickBtn").focus(); }
  else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault(); if (!items.length) return;
    pickHi = Math.max(0, Math.min(items.length - 1, pickHi + (e.key === "ArrowDown" ? 1 : -1)));
    items.forEach((x, k) => x.classList.toggle("hi", k === pickHi)); items[pickHi].scrollIntoView({ block: "nearest" });
  } else if (e.key === "Enter") { e.preventDefault(); const t = items[pickHi] || items[0]; if (t) pickChoose(+t.dataset.i); }
};
addEventListener("pointerdown", (e) => { if (!$("pickPanel").hidden && !e.target.closest("#pickPanel, #pickBtn")) pickClose(); }, true);
async function start() {
  status("Loading examples…");
  S.meta = await loadJSON("data/index.bin");
  $("lock").hidden = true;
  try { await Meta.addUploaded(); } catch {}   // the examples still work if the list can't be read
  Meta.showUploadButton(); buildMenu(); Ann.loadProgress();
  modelButtons(); setTrait("all"); setTool("select");
  // opened plainly: the first contributed specimen; from the slides or with #n: that demo number
  const first = new URLSearchParams(location.search).has("from") ? 0 : Math.max(0, S.meta.examples.findIndex((x) => x.group));
  const j = Math.max(0, Math.min(S.meta.examples.length - 1, (parseInt(location.hash.slice(1)) || first + 1) - 1));
  await openExample(j); setView(S.view);
}
(async function init() {
  resize();
  if (!window.DecompressionStream) { $("lockErr").textContent = "This browser is too old for the viewer. Please use a current Chrome, Edge, Firefox or Safari."; return; }
  let info = null;
  try { const r = await fetch("data/key.json", { cache: "no-cache" }); if (r.ok) info = await r.json(); } catch {}
  if (info?.plain) { S.plain = true; Ann.setAccount(null); await start(); Tour.maybeOpen(); toast("Local preview — not encrypted"); return; }
  const a = await PV.signIn($("gate"), { title: "Specimetrics", what: "the tool (example specimens with three models)" });
  Ann.setAccount(a.user);
  if (a.user?.role === "admin") $("adminLink").hidden = false;
  try { await start(); Tour.maybeOpen(); } catch (e) { $("lock").hidden = false; $("lockErr").textContent = `Could not load examples (${e.message}).`; }
})();
