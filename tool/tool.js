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
};
const FLAGS = {
  blade: [["intact", "Intact", true], ["broken_tip", "Broken"], ["folded", "Folded"], ["rolled", "Rolled"]],
  culm: [["base_present", "Base", true], ["truncated", "Truncated"], ["folded", "Folded"]],
};
const TOOL_KEYS = { v: "select", b: "blade", c: "culm", w: "blade_width", d: "culm_width", t: "spine" };
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

const $ = (id) => document.getElementById(id);
const cv = $("c"), ctx = cv.getContext("2d");
const off = document.createElement("canvas"), octx = off.getContext("2d");
const V = { s: 1, tx: 0, ty: 0, W: 0, H: 0, dpr: 1 };
const S = { key: null, plain: false, meta: null, idx: 0, run: "seg_r3", sheet: null, objects: [], img: null, small: null, mask: null, maskTint: null,
  imgFor: null, extra: {}, trait: "all", view: "photo", tool: "select", selected: null, hot: null, press: null, drawing: null, cursor: null,
  undo: [], dirty: false, rev: 0, overlay: "key", keyK: { ...Represent.K_DEFAULT } };
// Overlay mode: "key" = only representative organs (represent.js) and the width lines of the key set; "all" = every line;
// "off" = none. The selected / hovered object and anything being drawn always show; so do user-drawn spines and the B overlay.
const OVERLAYS = [["key", "Key", "Only a few clearly visible organs and their width lines (O)"], ["all", "All", "Every measurement line (O)"], ["off", "Off", "No measurement lines; pick from the list on the right (O)"]];
try { const m = localStorage.getItem("pv_overlay"); if (OVERLAYS.some(([k]) => k === m)) S.overlay = m; const k = JSON.parse(localStorage.getItem("pv_keyk") || "null"); if (k) S.keyK = { blade: Represent.clampK(k.blade, 3), culm: Represent.clampK(k.culm, 2) }; } catch {}

// ---------------------------------------------------------------- crypto
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64 = (u) => btoa(String.fromCharCode(...new Uint8Array(u)));
async function deriveKey(pass, info) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt: b64(info.salt), iterations: info.iter, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, true, ["decrypt"]);
}
async function unseal(buf) {
  if (S.plain) return buf;  // local preview build only
  const u = new Uint8Array(buf);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: u.slice(0, 12) }, S.key, u.slice(12));
}
const gunzip = (buf) => new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
async function fetchSealed(path) { const r = await fetch(path, { cache: "no-cache" }); if (!r.ok) throw new Error(`${r.status}`); return unseal(await r.arrayBuffer()); }
async function loadJSON(path) { return JSON.parse(new TextDecoder().decode(await gunzip(await fetchSealed(path)))); }
const keyInfo = () => fetch("data/key.json", { cache: "no-cache" }).then((r) => r.json());
async function unlock(pass, remember) {
  const info = await keyInfo();
  S.key = await deriveKey(pass, info);
  try { await unseal(b64(info.check)); } catch { S.key = null; throw new Error("Wrong passphrase"); }
  if (remember) { const raw = await crypto.subtle.exportKey("raw", S.key); try { localStorage.setItem("pv_key", JSON.stringify({ k: toB64(raw), salt: info.salt, exp: Date.now() + 30 * 864e5 })); } catch {} }
}
async function tryRemembered(info) {
  let saved = null; try { saved = JSON.parse(localStorage.getItem("pv_key") || "null"); } catch {}
  if (!saved || saved.exp < Date.now() || info.salt !== saved.salt) return false;
  S.key = await crypto.subtle.importKey("raw", b64(saved.k), { name: "AES-GCM" }, false, ["decrypt"]);
  try { await unseal(b64(info.check)); return true; } catch { S.key = null; return false; }
}
$("lockForm").onsubmit = async (e) => {
  e.preventDefault(); $("unlockBtn").disabled = true; $("lockErr").textContent = "";
  try { await unlock($("pass").value, $("remember").checked); $("pass").value = ""; await start(); }
  catch (err) { $("lockErr").textContent = err.message || "Could not unlock"; }
  $("unlockBtn").disabled = false;
};
// opened from the slides (?from=<slide>): link back to that slide
{ const from = parseInt(new URLSearchParams(location.search).get("from"));
  if (from > 0) { $("toSlides").href = "../slides/#" + from; $("toSlides").textContent = "← Slide " + from; } }
$("lockBtn").onclick =(e) => { e.preventDefault(); try { localStorage.removeItem("pv_key"); } catch {} location.reload(); };

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
  for (const x of S.objects) { if (x.type !== t) continue; for (let i = 1; i < x.points.length; i++) { const d = segDist(m, x.points[i - 1], x.points[i]); if (d < bd) { bd = d; best = x; } } }
  return best;
}
const widthsOf = (o) => S.objects.filter((w) => (w.type === "blade_width" || w.type === "culm_width") && parentOf(w) === o);
const fmtLen = (v) => (v == null ? "—" : v >= 100 ? `${f(v / 10, 1)} cm` : `${f(v, 1)} mm`);
function labelFor(o, pts = o.points) {
  if (pts.length < 2) return "";
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
    k.organSet = new Set(k.organs); k.donor = new Set(k.widthDonors.filter((id) => !k.organSet.has(id)));
    k.show = new Set([...k.organs, ...k.blade_width, ...k.culm_width, ...k.donor]);
    k.byTrait = { blade_length: new Set(k.blade), blade_width: new Set(k.blade_width), wl: new Set(k.wl), culm_length: new Set(k.culm), culm_diameter: new Set(k.culm_width) };
    k.num = new Map(); k.blade.forEach((id, i) => k.num.set(id, i + 1)); k.culm.forEach((id, i) => k.num.set(id, i + 1));
    keyCache = { objs: S.objects, rev: S.rev, sig, val: k };
  }
  return keyCache.val;
}
/** is this object drawn in the current overlay mode? (also used by spine.js and hit-testing) */
function overlayShows(o) {
  if (o.id === S.selected || o.id === S.hot) return true;
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
  status(m === "key" ? "Key: a few clearly visible organs (★ in the list to pin / exclude)" : m === "off" ? "Lines off: pick an organ in the list to see it" : "");
  if (S.sheet) panel(); draw();
}
$("overlay").innerHTML = `<span class="k">Lines</span>` + OVERLAYS.map(([k, l, tip]) => `<button data-o="${k}" title="${tip}">${l}</button>`).join("");
document.querySelectorAll("#overlay button").forEach((b) => { b.onclick = () => setOverlay(b.dataset.o); b.classList.toggle("on", b.dataset.o === S.overlay); });

// ---------------------------------------------------------------- view & render
function resize() { V.dpr = devicePixelRatio || 1; V.W = innerWidth; V.H = innerHeight; for (const c of [cv, off]) { c.width = Math.round(V.W * V.dpr); c.height = Math.round(V.H * V.dpr); } draw(); }
function fit() { if (!S.sheet) return; const { width: w, height: h } = S.sheet; V.s = Math.min(V.W / w, V.H / h) * 0.92; V.tx = (V.W - w * V.s) / 2; V.ty = (V.H - h * V.s) / 2; draw(); }
function zoomAt(x, y, k) { if (!S.sheet) return; const minS = Math.min(V.W / S.sheet.width, V.H / S.sheet.height) * 0.3, s = Math.max(minS, Math.min(MAX_ZOOM, V.s * k)); V.tx = x - ((x - V.tx) * s) / V.s; V.ty = y - ((y - V.ty) * s) / V.s; V.s = s; draw(); }
function focusOn(pts) {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]), w = Math.max(...xs) - Math.min(...xs) + 300, h = Math.max(...ys) - Math.min(...ys) + 300;
  V.s = Math.min(MAX_ZOOM, Math.min(V.W / w, V.H / h) * 0.6); V.tx = V.W / 2 - ((Math.min(...xs) + Math.max(...xs)) / 2) * V.s; V.ty = V.H / 2 - ((Math.min(...ys) + Math.max(...ys)) / 2) * V.s; draw();
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
  ctx.setTransform(V.dpr, 0, 0, V.dpr, 0, 0); ctx.fillStyle = "#000"; ctx.fillRect(0, 0, V.W, V.H);
  if (!S.sheet) return;
  if (!S.img) { ctx.fillStyle = "#0c0c0c"; ctx.fillRect(...sheetRect()); }
  if (S.view === "plant" && S.mask) {
    octx.setTransform(V.dpr, 0, 0, V.dpr, 0, 0); octx.globalCompositeOperation = "source-over"; octx.clearRect(0, 0, V.W, V.H); drawPhoto(octx);
    octx.globalCompositeOperation = "destination-in"; octx.imageSmoothingEnabled = true; octx.drawImage(S.mask, ...sheetRect()); octx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#101010"; ctx.fillRect(...sheetRect()); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(off, 0, 0); ctx.setTransform(V.dpr, 0, 0, V.dpr, 0, 0);
  } else {
    if (S.view !== "depth") drawPhoto(ctx);
    if (S.view === "depth" && S.extra.depth) { ctx.imageSmoothingEnabled = true; ctx.drawImage(S.extra.depth, ...sheetRect()); }
    if (S.view === "label" && S.extra.label) { ctx.fillStyle = "rgba(0,0,0,.35)"; ctx.fillRect(...sheetRect()); ctx.imageSmoothingEnabled = false; ctx.drawImage(S.extra.label, ...sheetRect()); }
    if (S.view === "mask" && S.maskTint) { ctx.fillStyle = "rgba(0,0,0,.55)"; ctx.fillRect(...sheetRect()); ctx.imageSmoothingEnabled = true; ctx.drawImage(S.maskTint, ...sheetRect()); }
  }
  const t = traitDef();
  if (t.key === "all" && S.overlay === "all") for (const x of S.sheet.fine || []) drawPath(x.points, FINE_COL[x.kind] || "#777", 1, 0.5, [3, 3]);
  Spine.drawUnder();
  const K = S.overlay === "key" ? keys() : null;
  for (const o of S.objects) {
    if (!overlayShows(o)) continue;
    const donor = K && K.donor.has(o.id) && t.key !== "wl" && o.id !== S.selected && o.id !== S.hot, lit = (t.key === "all" || t.hi(o)) && !donor;
    drawObject(o, o.points, { selected: o.id === S.selected, hot: o.id === S.hot, dim: !lit, label: lit && labelWanted(o, t), key: K ? K.num.get(o.id) : null });
  }
  Spine.drawOver(); Ann.drawOverlay();
  if (S.drawing) drawObject(S.drawing, S.cursor ? [...S.drawing.points, S.cursor] : S.drawing.points, { selected: true, live: true, label: true });
  $("zoom").textContent = `${f(V.s * 100, 0)} %`;
}
function labelWanted(o, t) { if (o.id === S.selected || o.id === S.hot) return true; if (S.overlay === "off") return false; if (t.key === "all" && S.overlay === "key") return true; if (t.key === "all") return (o.type === "blade" || o.type === "culm") && mm(plen(o.points)) > 40; return t.type === o.type; }
function drawPath(pts, color, w, alpha = 1, dash = []) {
  const sp = pts.map(toScreen); ctx.globalAlpha = alpha; ctx.lineJoin = ctx.lineCap = "round";
  ctx.beginPath(); sp.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p))); ctx.strokeStyle = color; ctx.lineWidth = w; ctx.setLineDash(dash); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
}
function drawObject(o, pts, { selected = false, hot = false, dim = false, live = false, label = false, key = null } = {}) {
  const T = TYPES[o.type]; if (!T || !pts.length) return;
  const sp = pts.map(toScreen), w = (T.thin ? 1.2 : 2) + (selected || hot ? 1.5 : 0) + (key && !dim ? 1.2 : 0);
  ctx.globalAlpha = dim ? 0.18 : 1; ctx.lineJoin = ctx.lineCap = "round";
  ctx.beginPath(); sp.forEach((p, i) => (i ? ctx.lineTo(...p) : ctx.moveTo(...p)));
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
  ctx.fillStyle = "rgba(0,0,0,.8)"; ctx.fillRect(at[0] + 8, at[1] - 20, tw, 17); ctx.fillStyle = T.color; ctx.fillText(text, at[0] + 13, at[1] - 7);
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
function changed() { S.rev++; Ann.onChange(); S.dirty = true; $("saveBtn").classList.add("dirty"); status("Unsaved corrections"); panel(); draw(); }
function setTool(t) { if (S.drawing && S.drawing.type !== t) S.drawing = null; S.tool = t; document.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === t)); cv.classList.toggle("edit", t === "select"); draw(); }
document.querySelectorAll("[data-tool]").forEach((b) => (b.onclick = () => setTool(b.dataset.tool)));
function addPoint(p) {
  if (!S.drawing) { const flags = {}; (FLAGS[S.tool] || []).forEach(([k, , on]) => (flags[k] = !!on)); S.drawing = { id: uid(), type: S.tool, points: [p], flags, source: "human" }; draw(); return; }
  S.drawing.points.push(p);
  if (TYPES[S.drawing.type].geom === "line") finish(); else draw();
}
function finish() {
  const o = S.drawing; S.drawing = null;
  if (!o || o.points.length < 2) { draw(); return; }
  o.points = o.points.map(([x, y]) => [Math.round(x), Math.round(y)]);
  if (plen(o.points) < 1) { status("Line too short — not added"); draw(); return; }   // e.g. a double-click on one spot
  if (o.type === "spine") Spine.init(o);
  snapshot(); S.objects.push(o); S.selected = o.id; changed();
}
function removeSelected() {
  const o = S.objects.find((x) => x.id === S.selected); if (!o) return;
  snapshot(); const gone = new Set([o.id, ...S.objects.filter((w) => w.parent === o.id).map((w) => w.id)]);
  S.objects = S.objects.filter((x) => !gone.has(x.id)); S.selected = null; changed();
}
function undo() { const u = S.undo.pop(); if (!u) return; S.objects = JSON.parse(u); S.selected = null; changed(); }
// saving, versions per annotator, export: annotators.js
const save = () => Ann.save(), resetEdits = () => Ann.reset(), exportEdits = () => Ann.exportAll();
$("saveBtn").onclick = save; $("resetBtn").onclick = resetEdits; $("dlBtn").onclick = exportEdits;

// ---------------------------------------------------------------- input
cv.addEventListener("pointerdown", (e) => {
  if (!S.sheet || (e.button !== 0 && e.button !== 1)) return; cv.setPointerCapture(e.pointerId);
  const p = toImage(e.offsetX, e.offsetY), sec = !S.drawing && S.tool === "select" ? Spine.hitSection(p) : null;
  if (sec) { snapshot(); S.press = { x: e.offsetX, y: e.offsetY, tx: V.tx, ty: V.ty, moved: false, sec, mode: "section" }; return; }
  const h = !S.drawing && S.tool === "select" ? hit(p) : null, vtx = h && h.v != null;
  if (vtx) { snapshot(); S.selected = h.o.id; panel(); }
  S.press = { x: e.offsetX, y: e.offsetY, tx: V.tx, ty: V.ty, moved: false, o: vtx ? h.o : null, v: vtx ? h.v : null, mode: vtx ? "vertex" : "maybe" };
});
cv.addEventListener("pointermove", (e) => {
  if (!S.sheet) return; S.cursor = toImage(e.offsetX, e.offsetY); const P = S.press;
  if (P) {
    const dx = e.offsetX - P.x, dy = e.offsetY - P.y;
    if (!P.moved && Math.hypot(dx, dy) > CLICK_TOL) { P.moved = true; if (P.mode === "maybe") P.mode = "pan"; cv.classList.add("grabbing"); }
    if (P.moved && P.mode === "pan") { V.tx = P.tx + dx; V.ty = P.ty + dy; }
    if (P.moved && P.mode === "vertex") { P.o.points[P.v] = [Math.round(S.cursor[0]), Math.round(S.cursor[1])]; if (P.o.type === "spine") Spine.recompute(P.o); }
    if (P.moved && P.mode === "section") Spine.dragSection(P.sec, S.cursor);
  }
  if (S.drawing) status(`${TYPES[S.drawing.type].label}  ${labelFor(S.drawing, [...S.drawing.points, S.cursor])}`);
  draw();
});
cv.addEventListener("pointerup", (e) => {
  const P = S.press; S.press = null; cv.classList.remove("grabbing"); if (!P || !S.sheet) return;
  if (P.mode === "section") { if (P.moved) { if (P.sec.o.source === "model") P.sec.o.source = "edited"; changed(); } else S.undo.pop(); return; }
  if (P.mode === "vertex") { if (P.moved) { if (P.o.source === "model") P.o.source = "edited"; changed(); } else S.undo.pop(); if (P.o.type === "spine") Spine.clickVertex(P.o, P.v, P.moved); return; }
  if (P.moved) return;
  const p = toImage(e.offsetX, e.offsetY);
  if (S.tool === "select") { const h = hit(p); S.selected = h ? h.o.id : null; panel(); draw(); } else addPoint(p);
});
cv.addEventListener("dblclick", (e) => { e.preventDefault(); const d = S.drawing; if (!d || TYPES[d.type].geom !== "poly") return; while (d.points.length > 2 && dist(d.points.at(-1), d.points.at(-2)) * V.s < 6) d.points.pop(); finish(); });
cv.addEventListener("wheel", (e) => { e.preventDefault(); const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY; zoomAt(e.offsetX, e.offsetY, Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0018))); }, { passive: false });
addEventListener("resize", resize);
// HUD layout: the right panel starts below the model card (whose height varies); the trait bar
// moves up when it would cover the views bar.
function layoutHud() {
  const tr = document.querySelector(".tr").getBoundingClientRect(), pn = $("panel");
  const top = Math.round(tr.bottom + 10);
  pn.style.top = top + "px"; pn.style.maxHeight = Math.max(120, innerHeight - top - 80) + "px";
  const tb = $("traits"), bl = document.querySelector(".bl").getBoundingClientRect();
  tb.style.bottom = "";
  const t = tb.getBoundingClientRect();
  if (t.left < bl.right + 8 && t.right > bl.left) tb.style.bottom = Math.round(innerHeight - bl.top + 8) + "px";
}
new ResizeObserver(layoutHud).observe(document.querySelector(".tr"));
new ResizeObserver(layoutHud).observe($("traits"));
addEventListener("resize", layoutHud);
addEventListener("keydown", (e) => {
  if (["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName) || !S.meta || !$("annModal").hidden) return;
  const k = (e.key || "").toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === "s") { e.preventDefault(); save(); return; }
  if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); undo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (k === "enter") { if (S.drawing) finish(); }
  else if (k === "escape") { if (S.drawing) S.drawing = null; else S.selected = null; status(S.dirty ? "Unsaved corrections" : ""); panel(); draw(); }
  else if (k === "backspace") { e.preventDefault(); if (S.drawing) { S.drawing.points.pop(); if (!S.drawing.points.length) S.drawing = null; draw(); } else removeSelected(); }
  else if (k === "delete") removeSelected();
  else if (Spine.key(k)) {}
  else if (k === "f") fit();
  else if (k === "0") zoomAt(V.W / 2, V.H / 2, 1 / V.s);
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
function traitValues(t) { const out = []; for (const o of S.objects) { if (o.type !== t.type) continue; if (t.key === "blade_length" && o.flags && o.flags.intact === false) continue; const v = t.value(o); if (v != null && isFinite(v)) out.push({ o, v }); } return out; }
function panel() {
  if (!S.sheet) return;
  Ann.panel(); Spine.panel(); keyPanel();
  const t = traitDef(), list = $("list"), keyMode = S.overlay === "key", K = keyMode ? keys() : null; list.innerHTML = "";
  const pm = (s, dp) => (s.n ? `${f(s.mean, dp)}${s.sd != null ? ` ± ${f(s.sd, dp)}` : ""}` : "—");
  if (t.key === "all") {
    const n = S.objects.filter((o) => o.type === "blade" || o.type === "culm").length;
    $("traitTitle").textContent = "All traits · this sheet"; $("traitBig").textContent = n ? `${n} organs` : "No organs";
    $("traitSub").textContent = keyMode ? `key organs: mean ± sd (n) of a few clearly visible ones; all: median of every line` : "choose a trait to highlight it; edit lines with the tools on the left"; drawChart([]);
    for (const tr of TRAITS.slice(1)) {
      const all = traitValues(tr), v = all.map((x) => x.v), el = document.createElement("div"), dp = tr.dp ?? 1; el.className = "item";
      if (keyMode) {
        const s = Represent.stats(all.filter((x) => K.byTrait[tr.key].has(x.o.id)).map((x) => x.v));
        el.innerHTML = `<span></span><span class="t">${tr.label}<span class="tag">key</span></span><span class="v">${pm(s, dp)}<span class="sub"> ${tr.unit} (${s.n})</span></span><span class="x">all: median ${v.length ? f(median(v), dp) : "—"} ${tr.unit} (${v.length})</span>`;
      } else el.innerHTML = `<span></span><span class="t">${tr.label}</span><span class="v">${v.length ? f(median(v), dp) : "—"}<span class="sub"> ${tr.unit}</span></span><span class="x">${v.length ? `n ${v.length} · range ${f(Math.min(...v), dp)}–${f(Math.max(...v), dp)}` : "no values"}</span>`;
      el.onclick = () => setTrait(tr.key); list.appendChild(el);
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
/** one list row: star (Key mode), label, value; hover highlights, click selects + focuses; flags when selected */
function organRow(o, label, value, x, vals, kset) {
  const par = o.type.endsWith("width") ? parentOf(o) : o, target = par || o, el = document.createElement("div");
  el.className = "item" + (o.id === S.selected ? " sel" : "");
  let star = "";
  if (S.overlay === "key") {
    const on = kset ? kset.has(o.id) : keys().organSet.has(o.id), cls = target.key === true ? "pin" : target.key === false ? "ex" : on ? "auto" : "";
    star = `<button class="star ${cls}" title="${on ? "Key (click to exclude)" : "Not key (click to pin)"}${target.key != null ? " · set by hand" : ""}">${on ? "★" : "☆"}</button>`;
  }
  el.innerHTML = `<span class="sw" style="background:${TYPES[o.type].color}"></span><span class="t">${star}${label}<span class="tag">${o.source || "model"}</span></span><span class="v">${value}</span><span class="x">${x}</span>`;
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
  const m = S.meta.models[S.run], ex = S.meta.examples[S.idx], r = ex.runs[S.run];
  document.querySelectorAll("#models button").forEach((b) => b.classList.toggle("on", b.dataset.r === S.run));
  $("card").innerHTML = `<div class="t">${m.title}</div>
    <b>${m.train_sheets.toLocaleString()}</b> training sheets · ${m.val_sheets} held out<br>
    ${m.labels}<br>
    ${m.architecture} · input ${m.inputs}<br>
    Training: <b>${m.train_min} min</b> (${m.iterations.toLocaleString()} iterations, batch ${m.batch}, ${m.gpu})${m.extra ? `<br>${m.extra}` : ""}<br>
    Validation IoU <b>${f(m.val_iou, 3)}</b>${m.val_iou_independent ? ` (${f(m.val_iou_independent, 3)} vs independent labels)` : ""} — ${m.val_note}`;
  $("runInfo").innerHTML = `<span class="badge">Already run</span>segmentation <b>${f(r.segmentation_s, 2)} s</b> · organs <b>${f(r.organs_s, 2)} s</b>${r.depth_s ? ` · depth <b>${f(r.depth_s, 2)} s</b>` : ""}<br>
    ${r.blades} blades · ${r.culms} culms · run ${r.ran_at}<br>${Ann.runInfo()}`;
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
function confirmLeave() { return !S.dirty || confirm("You have unsaved corrections. Leave without saving?"); }
async function openExample(i) {
  if (!confirmLeave()) { $("example").value = S.idx; return; }
  S.idx = i; const ex = S.meta.examples[i];
  $("example").value = i; $("count").textContent = `${i + 1} / ${S.meta.examples.length}`;
  $("why").innerHTML = `${ex.out_of_domain ? '<span class="badge">Not a grass</span>' : ""}<b>${ex.challenge}.</b> ${ex.why}${ex.out_of_domain ? " Organ lines (blade / culm) assume grass anatomy and are not meaningful here." : ""}`;
  S.extra = {}; buildViews(ex);
  for (const view of ["depth", "label"]) if (ex.files[view])
    fetchSealed(`data/s/${ex.files[view]}.m`).then((buf) => loadImage(URL.createObjectURL(new Blob([buf], { type: "image/png" }))))
      .then((im) => { if (S.idx === i) { S.extra[view] = im; draw(); } }).catch(() => {});
  history.replaceState(null, "", `#${i + 1}`);
  S.img = S.small = null; S.imgFor = null;
  await loadRun(S.run, true);
  setView(S.view);
}
async function loadRun(run, force = false) {
  if (!force && !confirmLeave()) return;
  S.run = run; S.dirty = false; $("saveBtn").classList.remove("dirty"); S.undo = []; S.selected = null; S.hot = null; S.drawing = null; S.mask = S.maskTint = null;
  const ex = S.meta.examples[S.idx], i = S.idx, name = ex.files[run];
  status("Decrypting results…");
  let sheet; try { sheet = await loadJSON(`data/s/${name}.j`); } catch (err) { status(`Could not load results (${err.message})`); return; }
  if (S.idx !== i || S.run !== run) return;
  const firstOpen = !S.sheet || S.sheet.id !== sheet.id;
  S.sheet = sheet;
  const saved = Ann.initial();   // the active annotator's own saved version (legacy pv_edit = "default"), else the model's
  S.objects = JSON.parse(JSON.stringify(saved ? saved.objects : sheet.objects));
  $("species").textContent = cap(sheet.species) || "Unknown";
  $("meta").textContent = [sheet.institution?.toUpperCase(), sheet.catalog, cap(sheet.state), (sheet.date || "").slice(0, 4)].filter(Boolean).join(" · ");
  $("links").innerHTML = [`${sheet.width.toLocaleString()} × ${sheet.height.toLocaleString()} px`, sheet.rights ? `licence ${sheet.rights}` : "",
    sheet.record_uuid ? `<a href="https://portal.idigbio.org/portal/records/${sheet.record_uuid}" target="_blank" rel="noopener">iDigBio record</a>` : ""].filter(Boolean).join(" · ");
  runCard(); if (firstOpen) fit(); panel(); draw();
  status(saved ? `Showing your saved version (${Ann.active().name})` : "");
  fetchSealed(`data/s/${name}.m`).then((buf) => loadImage(URL.createObjectURL(new Blob([buf], { type: "image/png" })))).then((m) => {
    if (S.idx !== i || S.run !== run) return;
    const a = document.createElement("canvas"); a.width = m.width; a.height = m.height; const g = a.getContext("2d"); g.drawImage(m, 0, 0);
    const d = g.getImageData(0, 0, a.width, a.height), px = d.data;
    for (let k = 0; k < px.length; k += 4) { const on = px[k] > 127; px[k] = px[k + 1] = px[k + 2] = 255; px[k + 3] = on ? 255 : 0; }
    g.putImageData(d, 0, 0); S.mask = a; panel();   // spine panel: placeholder widths are measured now
    const t = document.createElement("canvas"); t.width = a.width; t.height = a.height; const tg = t.getContext("2d");
    tg.fillStyle = "#5fe1ff"; tg.fillRect(0, 0, t.width, t.height); tg.globalCompositeOperation = "destination-in"; tg.drawImage(a, 0, 0); S.maskTint = t; draw();
  }).catch(() => {});
  if (S.imgFor !== sheet.id) {
    S.imgFor = sheet.id; const url = (sheet.accessuri || "").replace(/^http:\/\//, "https://");
    if (!saved) status(`Loading image from ${sheet.institution?.toUpperCase() || "herbarium"}…`);
    try {
      const img = await loadImage(url); if (S.sheet?.id !== sheet.id) return;
      S.img = img; try { S.small = await createImageBitmap(img, { resizeWidth: Math.min(3000, img.naturalWidth), resizeQuality: "high" }); } catch {}
      if (!saved) status(""); draw();
    } catch { if (S.sheet?.id === sheet.id) status("Image unavailable from the herbarium server. Results still shown."); }
  }
}
addEventListener("beforeunload", (e) => { if (S.dirty) e.preventDefault(); });
async function start() {
  status("Loading examples…");
  S.meta = await loadJSON("data/index.bin");
  $("lock").hidden = true;
  const opt = (x, i) => `<option value="${i}">${i + 1}. ${x.challenge} — ${cap(x.species)}</option>`;
  $("example").innerHTML = `<optgroup label="Grass challenges">${S.meta.examples.map((x, i) => x.out_of_domain ? "" : opt(x, i)).join("")}</optgroup>`
    + `<optgroup label="Not grasses (never seen in training)">${S.meta.examples.map((x, i) => x.out_of_domain ? opt(x, i) : "").join("")}</optgroup>`;
  modelButtons(); setTrait("all"); setTool("select");
  const j = Math.max(0, Math.min(S.meta.examples.length - 1, (parseInt(location.hash.slice(1)) || 1) - 1));
  await openExample(j); setView(S.view);
}
(async function init() {
  resize();
  if (!(window.crypto && crypto.subtle && window.DecompressionStream)) { $("lockErr").textContent = "This browser is too old for the encrypted viewer."; return; }
  try {
    const info = await keyInfo();
    if (info.plain) { S.plain = true; await start(); toast("Local preview — not encrypted"); return; }
    if (await tryRemembered(info)) await start();
  } catch {}
})();
