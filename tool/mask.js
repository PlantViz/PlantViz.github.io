// Specimetrics — mask parts. The mask is a label map at mask resolution: 0 = not plant, n = part n.
// Each part has a class (leaf, stem, ...) and its own colour. Edits are ops in S.objects (type "stroke"), replayed on a base
// label map (the model's mask, or a saved version's), so undo and versions keep working. The part table lives in S.objects
// as one { type: "maskmeta" } object for the same reason.
// Uses tool.js globals (S, $, toast, status, panel, draw, ...) at call time; tool.js loads after this file.
"use strict";
(function (root) {
  const byId = (id) => document.getElementById(id);
  const CLASSES = [
    { id: "plant", name: "Plant", hue: 188 },
    { id: "leaf", name: "Leaf", hue: 112 },
    { id: "stem", name: "Stem / culm", hue: 36 },
    { id: "flower", name: "Flower / inflorescence", hue: 318 },
    { id: "fruit", name: "Fruit / seed", hue: 268 },
    { id: "root", name: "Root", hue: 20 },
    { id: "other", name: "Other", hue: 0, gray: true },
  ];
  const cls = (id) => CLASSES.find((c) => c.id === id) || CLASSES[CLASSES.length - 1];
  const typing = (box) => { const a = document.activeElement; return !!a && box.contains(a) && (a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && a.type !== "color" && a.type !== "range" && a.type !== "checkbox")); };
  const M = { w: 0, h: 0, base: null, labels: null, counts: [], sel: null, ready: false, lut: null };

  // ---------------------------------------------------------------- part table
  function meta() {
    let m = S.objects.find((o) => o.type === "maskmeta");
    if (!m) { m = { id: "maskmeta", type: "maskmeta", points: [], parts: [{ id: 1, cls: "plant", n: 1 }], active: 1 }; S.objects.push(m); }
    return m;
  }
  const parts = () => meta().parts;
  const part = (id) => parts().find((p) => p.id === id);
  const active = () => { const m = meta(); return part(m.active) ? m.active : (parts()[0]?.id ?? 0); };
  const label = (p) => (p.name ? p.name : `${cls(p.cls).name.split(" /")[0]} ${p.n}`);
  const cleanPartName = (t) => String(t || "").replace(/\s+/g, " ").trim().slice(0, 40);
  const HEX = /^#[0-9a-f]{6}$/i;
  function rgb(p) {   // a colour the user picked, else one from the class (parts of one class get nearby but distinct colours)
    if (p.color && HEX.test(p.color)) return [1, 3, 5].map((i) => parseInt(p.color.slice(i, i + 2), 16));
    const c = cls(p.cls), k = p.n - 1, h = (c.hue + ((k * 47) % 120) - (k ? 60 : 0) + 360) % 360, s = c.gray ? 0 : 0.75, l = 0.58 + (k % 3) * 0.08;
    const f = (n) => { const a = s * Math.min(l, 1 - l), q = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(q - 3, 9 - q, 1)))); };
    return [f(0), f(8), f(4)];
  }
  const css = (p) => `rgb(${rgb(p).join(",")})`;
  const color = (id) => { const p = part(id); return p ? css(p) : "#5fe1ff"; };
  const hex = (p) => "#" + rgb(p).map((v) => v.toString(16).padStart(2, "0")).join("");

  // ---------------------------------------------------------------- base label map
  function setBase(labels, w, h) { M.base = labels; M.w = w; M.h = h; M.ready = true; M.sel = null; }
  /** the model's mask (white = plant) as part 1 */
  function fromAlpha(canvas) {
    const w = canvas.width, h = canvas.height, d = canvas.getContext("2d").getImageData(0, 0, w, h).data, l = new Uint8Array(w * h);
    for (let i = 0; i < l.length; i++) l[i] = d[i * 4 + 3] > 127 ? 1 : 0;
    setBase(l, w, h);
  }
  function blank(w, h) { setBase(new Uint8Array(w * h), w, h); }
  /** a saved version's mask: PNG whose red channel is the part number */
  function fromSaved(rec) {
    return new Promise((ok, fail) => {
      const im = new Image();
      im.onload = () => {
        const c = document.createElement("canvas"); c.width = rec.w; c.height = rec.h; const g = c.getContext("2d", { willReadFrequently: true });
        g.drawImage(im, 0, 0); const d = g.getImageData(0, 0, rec.w, rec.h).data, l = new Uint8Array(rec.w * rec.h);
        for (let i = 0; i < l.length; i++) l[i] = d[i * 4];
        setBase(l, rec.w, rec.h); ok();
      };
      im.onerror = () => fail(new Error("Could not read the saved mask"));
      im.src = "data:image/png;base64," + rec.png;
    });
  }
  /** the current mask for saving: { w, h, png (base64), parts } */
  function encode() {
    if (!M.ready) return null;
    const c = document.createElement("canvas"); c.width = M.w; c.height = M.h; const g = c.getContext("2d"), im = g.createImageData(M.w, M.h);
    for (let i = 0; i < M.labels.length; i++) { const v = M.labels[i]; im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = v; im.data[i * 4 + 3] = 255; }
    g.putImageData(im, 0, 0);
    const counts = new Map(); for (const v of M.labels) if (v) counts.set(v, (counts.get(v) || 0) + 1);
    return { w: M.w, h: M.h, png: c.toDataURL("image/png").split(",")[1], parts: parts().map((p) => ({ id: p.id, cls: p.cls, n: p.n, ...(p.color ? { color: p.color } : {}), ...(p.name ? { name: p.name } : {}), pixels: counts.get(p.id) || 0 })) };
  }
  /** the part table that goes with a saved mask */
  function adoptParts(rec) {
    const m = meta(); m.parts = (rec.parts || []).map((p) => ({ id: p.id, cls: p.cls, n: p.n, ...(p.color && HEX.test(p.color) ? { color: p.color } : {}), ...(cleanPartName(p.name) ? { name: cleanPartName(p.name) } : {}) }));
    if (!m.parts.length) m.parts = [{ id: 1, cls: "plant", n: 1 }];
    m.active = m.parts[0].id;
  }

  // ---------------------------------------------------------------- ops
  const to = (op) => (op.mode === "del" ? 0 : op.to ?? 1);
  function applyRuns(op) {
    const r = op.runs, sx = M.w / op.w, sy = M.h / op.h, v = to(op);
    if (sx === 1 && sy === 1) { for (let i = 0; i < r.length; i += 3) M.labels.fill(v, r[i] * M.w + r[i + 1], r[i] * M.w + r[i + 1] + r[i + 2]); return; }
    for (let i = 0; i < r.length; i += 3) { const y = Math.round(r[i] * sy), x0 = Math.round(r[i + 1] * sx), x1 = Math.round((r[i + 1] + r[i + 2]) * sx); if (y < M.h) M.labels.fill(v, y * M.w + x0, y * M.w + Math.min(M.w, x1)); }
  }
  function applyBrush(op) {   // rasterise the stroke in its own bounding box
    const k = M.w / S.sheet.width, xs = op.points.map((p) => p[0] * k), ys = op.points.map((p) => p[1] * k), rr = op.r * k + 2;
    const x0 = Math.max(0, Math.floor(Math.min(...xs) - rr)), y0 = Math.max(0, Math.floor(Math.min(...ys) - rr));
    const x1 = Math.min(M.w, Math.ceil(Math.max(...xs) + rr)), y1 = Math.min(M.h, Math.ceil(Math.max(...ys) + rr)), bw = x1 - x0, bh = y1 - y0;
    if (bw <= 0 || bh <= 0) return;
    const c = document.createElement("canvas"); c.width = bw; c.height = bh; const g = c.getContext("2d", { willReadFrequently: true });
    g.lineCap = g.lineJoin = "round"; g.lineWidth = 2 * op.r * k; g.strokeStyle = "#fff"; g.beginPath();
    op.points.forEach((p, i) => (i ? g.lineTo(p[0] * k - x0, p[1] * k - y0) : g.moveTo(p[0] * k - x0, p[1] * k - y0)));
    if (op.points.length === 1) g.lineTo(op.points[0][0] * k - x0 + 0.01, op.points[0][1] * k - y0);
    g.stroke();
    const d = g.getImageData(0, 0, bw, bh).data, v = to(op);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (d[(y * bw + x) * 4 + 3] > 127) M.labels[(y + y0) * M.w + x + x0] = v;
  }
  const applyOp = (op) => (op.runs ? applyRuns(op) : applyBrush(op));
  const ops = () => S.objects.filter((o) => o.type === "stroke");
  /** labels = base + every op, then the canvases the rest of the tool uses */
  function rebuild() {
    if (!M.ready) return;
    M.labels = M.base.slice(); for (const op of ops()) applyOp(op);
    meta(); render();
  }
  /** one new op on top of the current labels */
  function apply(op) { applyOp(op); render(); }

  // ---------------------------------------------------------------- canvases: S.mask (white = any plant), S.maskTint (colour per part)
  function render() {
    const w = M.w, h = M.h, n = w * h;
    const mk = (c) => { if (c && c.width === w && c.height === h) return c; const e = document.createElement("canvas"); e.width = w; e.height = h; return e; };
    S.mask = mk(S.mask); S.maskTint = mk(S.maskTint);
    const lut = new Uint8Array(256 * 4), counts = new Array(256).fill(0);
    for (let v = 1; v < 256; v++) lut.set([95, 225, 255, 255], v * 4);   // pixels of a part no longer in the table
    for (const p of parts()) { const [r, g, b] = rgb(p); lut.set([r, g, b, p.hidden ? 0 : 255], p.id * 4); }
    const gm = S.mask.getContext("2d"), gt = S.maskTint.getContext("2d"), im = gm.createImageData(w, h), it = gt.createImageData(w, h), L = M.labels;
    for (let i = 0; i < n; i++) {
      const v = L[i]; if (!v) continue; counts[v]++;
      const j = i * 4; im.data[j] = im.data[j + 1] = im.data[j + 2] = 255; im.data[j + 3] = 255;
      it.data[j] = lut[v * 4]; it.data[j + 1] = lut[v * 4 + 1]; it.data[j + 2] = lut[v * 4 + 2]; it.data[j + 3] = lut[v * 4 + 3];
    }
    gm.putImageData(im, 0, 0); gt.putImageData(it, 0, 0); M.counts = counts;
    if (M.sel) selCanvas();
  }

  // ---------------------------------------------------------------- selecting a region of the mask
  /** the connected area of one part under image point p (Shift adds to the selection) */
  function selectAt(p, add) {
    if (!M.ready) return false;
    const x = Math.floor((p[0] * M.w) / S.sheet.width), y = Math.floor((p[1] * M.h) / S.sheet.height);
    if (x < 0 || y < 0 || x >= M.w || y >= M.h) return false;
    const v = M.labels[y * M.w + x]; if (!v) { if (!add) clearSel(); return false; }
    const keep = add && M.sel ? M.sel.bits : new Uint8Array(M.w * M.h), stack = [y * M.w + x];
    if (keep[y * M.w + x]) return true;
    keep[y * M.w + x] = 1;
    while (stack.length) {
      const i = stack.pop(), cx = i % M.w;
      for (const j of [cx > 0 ? i - 1 : -1, cx < M.w - 1 ? i + 1 : -1, i - M.w, i + M.w]) if (j >= 0 && j < M.labels.length && !keep[j] && M.labels[j] === v) { keep[j] = 1; stack.push(j); }
    }
    M.sel = { bits: keep, at: p, part: v }; selCanvas(); return true;
  }
  function selectPart(id) {
    const bits = new Uint8Array(M.w * M.h); let any = false;
    for (let i = 0; i < bits.length; i++) if (M.labels[i] === id) { bits[i] = 1; any = true; }
    if (!any) return false;
    M.sel = { bits, at: M.sel?.at, part: id }; selCanvas(); return true;
  }
  function selCanvas() {
    const c = document.createElement("canvas"); c.width = M.w; c.height = M.h; const g = c.getContext("2d"), im = g.createImageData(M.w, M.h), b = M.sel.bits;
    let n = 0, x0 = M.w, y0 = M.h, x1 = 0, y1 = 0;
    for (let y = 0; y < M.h; y++) for (let x = 0; x < M.w; x++) {
      const i = y * M.w + x; if (!b[i]) continue; n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      const edge = !b[i - 1] || !b[i + 1] || !b[i - M.w] || !b[i + M.w], j = i * 4, stripe = (x + y) % 8 < 4;
      im.data.set(edge ? [255, 255, 255, 255] : stripe ? [255, 255, 255, 90] : [0, 0, 0, 40], j);
    }
    g.putImageData(im, 0, 0); M.sel.canvas = c; M.sel.count = n; M.sel.box = [x0, y0, x1, y1];
  }
  function clearSel() { M.sel = null; }
  function selRuns() {
    const b = M.sel.bits, out = [];
    for (let y = M.sel.box[1]; y <= M.sel.box[3]; y++) { let x = M.sel.box[0]; while (x <= M.sel.box[2]) { if (!b[y * M.w + x]) { x++; continue; } const a = x; while (x <= M.sel.box[2] && b[y * M.w + x]) x++; out.push(y, a, x - a); } }
    return out;
  }
  /** move the selection into part `id` (0 removes it from the mask) */
  function relabelSel(id) {
    if (!M.sel) return;
    snapshot(); S.objects.push({ id: uid(), type: "stroke", kind: "region", mode: id ? "add" : "del", to: id, w: M.w, h: M.h, runs: selRuns(), points: [M.sel.at || [0, 0]], r: 0, source: "human" });
    const n = M.sel.count; clearSel(); changed();
    toast(id ? `Moved to ${label(part(id))}` : `Removed ${n.toLocaleString()} px from the mask`);
  }
  /** a new part of class c made from the selection (one undo step) */
  function splitSel(c) {
    if (!M.sel) return null; const m = meta(); if (m.parts.length >= 250) { toast("Too many parts on one sheet"); return null; }
    snapshot(); const id = Math.max(0, ...m.parts.map((p) => p.id)) + 1, n = Math.max(0, ...m.parts.filter((p) => p.cls === c).map((p) => p.n)) + 1;
    m.parts.push({ id, cls: c, n }); m.active = id;
    S.objects.push({ id: uid(), type: "stroke", kind: "region", mode: "add", to: id, w: M.w, h: M.h, runs: selRuns(), points: [M.sel.at || [0, 0]], r: 0, source: "human" });
    clearSel(); changed(); if (c === "other") askName(id); else toast(`New part: ${label(part(id))}`); return id;
  }
  /** screen box of the selection (for the context bar) */
  function selScreenBox() {
    if (!M.sel) return null; const k = S.sheet.width / M.w, [x0, y0, x1, y1] = M.sel.box, a = toScreen([x0 * k, y0 * k]), b = toScreen([(x1 + 1) * k, (y1 + 1) * k]);
    return { left: a[0], top: a[1], right: b[0], bottom: b[1] };
  }
  function drawSelection(ctx) {
    if (!M.sel?.canvas) return; ctx.imageSmoothingEnabled = false; ctx.drawImage(M.sel.canvas, ...sheetRect()); ctx.imageSmoothingEnabled = true;
  }

  // ---------------------------------------------------------------- part table edits (undoable: the table is an object)
  function newPart(c) {
    const m = meta(); if (m.parts.length >= 250) { toast("Too many parts on one sheet"); return null; }
    snapshot(); const id = Math.max(0, ...m.parts.map((p) => p.id)) + 1, n = Math.max(0, ...m.parts.filter((p) => p.cls === c).map((p) => p.n)) + 1;
    m.parts.push({ id, cls: c, n }); m.active = id; changed(); return id;
  }
  function setActive(id) { meta().active = id; panelRender(); toolOptions(); draw(); }
  function setClass(id, c) {
    const m = meta(), p = part(id); if (!p || p.cls === c) return;
    snapshot(); p.cls = c; p.n = Math.max(0, ...m.parts.filter((q) => q.cls === c && q !== p).map((q) => q.n)) + 1;
    if (c !== "other") delete p.name;
    changed(); if (c === "other") askName(id);
  }
  function rename(id, t) {
    const p = part(id), n = cleanPartName(t); if (!p || (p.name || "") === n) return;
    snapshot(); if (n) p.name = n; else delete p.name; changed();
  }
  /** a part of class Other gets a name: focus its name box in the Mask tab */
  function askName(id) { showTab("mask"); setTimeout(() => { const e = byId("maskBox").querySelector(`[data-name="${id}"]`); if (e) { e.focus(); e.select(); } }, 0); toast("Name this part"); }
  function removePart(id) {
    const m = meta(), p = part(id); if (!p) return;
    if (m.parts.length === 1) { toast("Keep at least one part; erase its area instead"); return; }
    if (M.counts[id] && !confirm(`Remove ${label(p)} and its ${M.counts[id].toLocaleString()} px from the mask?`)) return;
    if (M.counts[id]) selectPart(id);
    snapshot();
    if (M.sel) S.objects.push({ id: uid(), type: "stroke", kind: "region", mode: "del", to: 0, w: M.w, h: M.h, runs: selRuns(), points: [[0, 0]], r: 0, source: "human" });
    clearSel(); m.parts = m.parts.filter((q) => q.id !== id); if (m.active === id) m.active = m.parts[0].id; changed();
  }
  /** colour picker: live while dragging, one undo step when chosen */
  function previewColor(id, c) { const p = part(id); if (!p || !HEX.test(c)) return; p.color = c; render(); toolOptions(); draw(); }
  function commitColor(id, before, c) {
    const p = part(id); if (!p || !HEX.test(c)) return;
    p.color = before || undefined; if (!before) delete p.color;
    if ((before || "") === c) { render(); return; }
    snapshot(); p.color = c; changed();
  }
  function resetColor(id) { const p = part(id); if (!p || !p.color) return; snapshot(); delete p.color; changed(); }
  function toggleHidden(id) { const p = part(id); if (!p) return; p.hidden = !p.hidden; render(); panelRender(); draw(); }

  // ---------------------------------------------------------------- Mask tab
  function area(px) { const p = S.sheet?.px_per_mm, a = px * (S.sheet.width / M.w) ** 2; return p ? `${f(a / (p * p), a / (p * p) >= 100 ? 0 : 1)} mm²` : `${px.toLocaleString()} px`; }
  const classOptions = (sel) => CLASSES.map((c) => `<option value="${c.id}"${c.id === sel ? " selected" : ""}>${c.name}</option>`).join("");
  function panelRender() {
    const box = byId("maskBox"); if (!box) return;
    if (typing(box)) { box.dataset.stale = "1"; return; }   // redraw after the field loses focus
    if (!M.ready) { box.innerHTML = `<div class="sub">The mask is loading…</div>`; return; }
    const act = active();
    box.innerHTML = `<div class="rowx"><span class="k">Mask parts</span><span class="grow"></span><span class="sub">${parts().length}</span></div>
      <div class="sub note">Magic and Brush paint into the <b>active</b> part (dot). Click a row to make it active.</div>`
      + parts().map((p) => `<div class="mpart${p.id === act ? " sel" : ""}" data-id="${p.id}"><input type="color" class="swatch" data-col="${p.id}" data-before="${p.color || ""}" value="${hex(p)}" title="Pick a colour for ${label(p)}${p.color ? " (double-click to go back to the class colour)" : ""}">
        <span class="mn">${label(p)}</span><span class="sub">${area(M.counts[p.id] || 0)}</span>
        <button class="mini" data-eye="${p.id}" title="${p.hidden ? "Show" : "Hide"} this part">${p.hidden ? "Show" : "Hide"}</button>
        <select data-cls="${p.id}" title="Class of this part">${classOptions(p.cls)}</select>
        ${p.cls === "other" ? `<input class="pname" data-name="${p.id}" value="${PV.esc(p.name || "")}" maxlength="40" placeholder="Name this part (e.g. galls, label)" autocomplete="off">` : ""}
        <button class="mini" data-del="${p.id}" title="Remove this part">Remove</button></div>`).join("")
      + `<div class="rowx gap"><select id="newCls">${classOptions("leaf")}</select><button class="small" id="newPart">+ New part</button></div>
      <div class="sub note">To split a part, choose Edit and click its area on the image, then use the bar that appears. Shift+click adds more areas.</div>`;
    box.querySelectorAll(".mpart").forEach((r) => (r.onclick = (e) => { if (!e.target.closest("button,select,input")) setActive(+r.dataset.id); }));
    box.querySelectorAll("[data-eye]").forEach((b) => (b.onclick = () => toggleHidden(+b.dataset.eye)));
    box.querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => removePart(+b.dataset.del)));
    box.querySelectorAll("[data-cls]").forEach((s) => (s.onchange = (e) => { setClass(+s.dataset.cls, e.target.value); e.target.blur(); }));
    box.onfocusout = () => setTimeout(() => { if (box.dataset.stale && !typing(box)) { delete box.dataset.stale; panelRender(); } }, 0);
    box.querySelectorAll("[data-name]").forEach((n) => {
      n.onchange = () => rename(+n.dataset.name, n.value);
      n.onkeydown = (e) => { if (e.key === "Enter") n.blur(); if (e.key === "Escape") { n.value = part(+n.dataset.name)?.name || ""; n.blur(); } };
    });
    box.querySelectorAll("[data-col]").forEach((c) => {
      const id = +c.dataset.col;
      c.oninput = (e) => previewColor(id, e.target.value);
      c.onchange = (e) => commitColor(id, c.dataset.before, e.target.value);
      c.ondblclick = (e) => { e.preventDefault(); resetColor(id); };
    });
    byId("newPart").onclick = () => { const c = byId("newCls").value, id = newPart(c); if (!id) return; if (c === "other") askName(id); else toast(`${label(part(id))} is active: paint it with Magic or Brush`); };
  }

  root.Mask = { CLASSES, meta, parts, part, active, label, color, css, rgb, fromAlpha, fromSaved, blank, encode, adoptParts, rebuild, apply, render,
    selectAt, selectPart, clearSel, relabelSel, splitSel, selScreenBox, drawSelection, newPart, setActive, setClass, removePart, panel: panelRender,
    get ready() { return M.ready; }, get sel() { return M.sel; }, get size() { return [M.w, M.h]; }, labelAt: (x, y) => M.labels?.[y * M.w + x] ?? 0, reset() { M.ready = false; M.sel = null; M.base = M.labels = null; } };
})(window);
