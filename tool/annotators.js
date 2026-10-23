// Specimetrics — annotator profiles, saved versions per annotator, evaluator comparison and scores.
// Pure helpers (cleanName, organValues, compare) also load in Node (module.exports) for tests.
// Browser part uses tool.js globals (S, $, toast, status, panel, draw, ...) at call time; tool.js loads after this file.
//
// localStorage keys (all access wrapped in try/catch):
//   pv_profiles                         {name: {name, role, expertise, created_at}}
//   pv_profile_active                   name of the active profile
//   pv_ver:<sheetId>:<run>:<annotator>  {sheet_id, species, run, annotator, role, expertise, saved_at, px_per_mm, objects, copied_from?}
//   pv_score:<sheetId>:<run>:<version>  {score 1-5, comment, evaluator, at}   (<version> = annotator name, or "model")
//   pv_edit:<sheetId>:<run>             legacy single corrected version -> shown as annotator "default"
"use strict";
(function (root) {
  const ROLES = ["Annotator", "Evaluator"], EXPERTISE = ["Novice", "Intermediate", "Expert"];
  const DEFAULT = { name: "default", role: "Annotator", expertise: "Unspecified" };
  const MODEL = "model", B_COLOR = "#ff4fd8";

  // ------------------------------------------------------------ pure helpers
  /** profile names: letters, digits, space . _ - ; max 40; "model" is reserved for the original */
  function cleanName(s) {
    const n = String(s || "").replace(/[^\p{L}\p{N} ._-]/gu, "").replace(/\s+/g, " ").trim().slice(0, 40);
    return n.toLowerCase() === MODEL || n === "__new" ? "" : n;   // "__new" is the profile menu's "+ New profile" entry
  }
  const d2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const plen = (p) => { let L = 0; for (let i = 1; i < p.length; i++) L += d2(p[i - 1], p[i]); return L; };
  /** point halfway along a polyline */
  function midpoint(p) {
    const half = plen(p) / 2; let acc = 0;
    for (let i = 1; i < p.length; i++) { const L = d2(p[i - 1], p[i]); if (acc + L >= half && L > 0) { const u = (half - acc) / L; return [p[i - 1][0] + (p[i][0] - p[i - 1][0]) * u, p[i - 1][1] + (p[i][1] - p[i - 1][1]) * u]; } acc += L; }
    return p[0];
  }
  const median = (a) => { const s = [...a].sort((x, y) => x - y), n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
  const TRAITS = [
    { key: "blade_length", label: "Blade length", type: "blade", v: (o, k) => plen(o.points) / k, skip: (o) => o.flags && o.flags.intact === false },
    { key: "blade_width", label: "Blade width", type: "blade_width", v: (o, k) => d2(o.points[0], o.points[1]) / k },
    { key: "culm_length", label: "Culm length", type: "culm", v: (o, k) => plen(o.points) / k },
    { key: "culm_diameter", label: "Culm diam.", type: "culm_width", v: (o, k) => (2 * d2(o.points[0], o.points[1])) / k / Math.PI },
  ];
  /** trait values for a list of objects; k = px per mm (or 1 for pixels) */
  function organValues(objs, k) {
    const out = {};
    for (const t of TRAITS) out[t.key] = objs.filter((o) => o.type === t.type && o.points && o.points.length >= 2 && !(t.skip && t.skip(o))).map((o) => t.v(o, k)).filter((x) => isFinite(x));
    return out;
  }
  /**
   * Agreement between versions A and B (object lists). ppm = px per mm (null -> pixels; tolMm then means px).
   * Organs = blades + culms; matched greedily by nearest midpoint (same type) within tolMm.
   */
  function compare(A, B, ppm, tolMm = 10) {
    const k = ppm || 1, va = organValues(A, k), vb = organValues(B, k);
    const traits = TRAITS.map((t) => { const a = median(va[t.key]), b = median(vb[t.key]); return { key: t.key, label: t.label, a, b, nA: va[t.key].length, nB: vb[t.key].length, rel: a != null && b != null && a !== 0 ? (b - a) / a : null }; });
    const organs = (L) => L.filter((o) => (o.type === "blade" || o.type === "culm") && o.points && o.points.length >= 2).map((o) => ({ o, m: midpoint(o.points), len: plen(o.points) / k }));
    const oa = organs(A), ob = organs(B), pairs = [];
    oa.forEach((x, i) => ob.forEach((y, j) => { if (x.o.type !== y.o.type) return; const d = d2(x.m, y.m) / k; if (d <= tolMm) pairs.push([d, i, j]); }));
    pairs.sort((p, q) => p[0] - q[0]);
    const ua = new Set(), ub = new Set(), matches = [];
    for (const [d, i, j] of pairs) if (!ua.has(i) && !ub.has(j)) { ua.add(i); ub.add(j); matches.push({ a: oa[i].o, b: ob[j].o, d, diff: Math.abs(oa[i].len - ob[j].len) }); }
    const n = matches.length;
    return { traits, nA: oa.length, nB: ob.length, matched: n, pctA: oa.length ? (100 * n) / oa.length : null, pctB: ob.length ? (100 * n) / ob.length : null,
      meanAbsDiffMm: n ? matches.reduce((s, m) => s + m.diff, 0) / n : null, matches, unit: ppm ? "mm" : "px" };
  }
  const Pure = { cleanName, midpoint, median, organValues, compare, ROLES, EXPERTISE };
  if (typeof module !== "undefined" && module.exports) { module.exports = Pure; return; }

  const $ = (id) => document.getElementById(id);   // local: this file loads before tool.js
  // ------------------------------------------------------------ storage
  const ls = {
    get(k) { try { const v = localStorage.getItem(k); return v == null ? null : JSON.parse(v); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
    del(k) { try { localStorage.removeItem(k); } catch {} },
    keys(prefix) { const out = []; try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(prefix)) out.push(k); } } catch {} return out; },
  };
  const profiles = () => { const p = ls.get("pv_profiles"); return p && typeof p === "object" ? p : {}; };
  function active() { const n = ls.get("pv_profile_active"), p = profiles(); return (n && p[n]) || (n === DEFAULT.name ? { ...DEFAULT, ...(p[n] || {}) } : DEFAULT); }
  const chosen = () => ls.get("pv_profile_active") != null;
  const me = () => active().name;
  const isEval = () => active().role === "Evaluator";
  const verKey = (name) => `pv_ver:${S.sheet.id}:${S.run}:${name}`;
  const legacyKey = () => `pv_edit:${S.sheet.id}:${S.run}`;
  const scoreKey = (name) => `pv_score:${S.sheet.id}:${S.run}:${name}`;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const when = (iso) => { try { return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };
  const vname = (n) => (n === MODEL ? "Model (original)" : n);

  /** saved versions for the current sheet + run, newest first; legacy pv_edit appears as "default" */
  function versions() {
    if (!S.sheet) return [];
    const out = [], seen = new Set(), pre = `pv_ver:${S.sheet.id}:${S.run}:`;
    for (const k of ls.keys(pre)) { const r = ls.get(k); if (r && Array.isArray(r.objects)) { const name = r.annotator || k.slice(pre.length); seen.add(name); out.push({ ...r, annotator: name }); } }
    if (!seen.has(DEFAULT.name)) { const r = ls.get(legacyKey()); if (r && Array.isArray(r.objects)) out.push({ ...r, annotator: DEFAULT.name, role: DEFAULT.role, expertise: DEFAULT.expertise, legacy: true }); }
    return out.sort((a, b) => String(b.saved_at).localeCompare(String(a.saved_at)));
  }
  const versionOf = (name) => versions().find((v) => v.annotator === name) || null;
  const objectsOf = (name) => (name === MODEL ? S.sheet.objects : (versionOf(name) || {}).objects) || [];

  // ------------------------------------------------------------ hooks called from tool.js
  /** which objects to show when a sheet/run opens: the active annotator's own version, else the model's */
  function initial() {
    S.cmpB = null;
    const own = versionOf(me());
    S.ver = { base: own ? me() : MODEL, copy: false };
    return own;
  }
  function onChange() {
    const v = S.ver || (S.ver = { base: MODEL });
    if (v.base !== me() && v.base !== MODEL && !v.copy) { v.copy = true; toast(`Editing your own copy — ${v.base}'s version stays unchanged`); }
  }
  function save(force) {
    if (!S.sheet) return;
    if (!chosen() && !force) { openModal({ firstSave: true, then: () => save(true) }); return; }
    const p = active(), base = S.ver?.base || MODEL;
    if (base !== p.name && versionOf(p.name) && !versionOf(p.name).legacy && !confirm(`Replace your saved version (${p.name}) for this sheet and model with the one on screen?`)) return;
    const rec = { sheet_id: S.sheet.id, species: S.sheet.species, run: S.run, annotator: p.name, role: p.role, expertise: p.expertise,
      saved_at: new Date().toISOString(), px_per_mm: S.sheet.px_per_mm, objects: S.objects };
    if (base !== p.name) rec.copied_from = base;
    if (!ls.set(verKey(p.name), rec)) { toast("Could not save (browser storage blocked)"); return; }
    S.ver = { base: p.name, copy: false }; S.dirty = false; $("saveBtn").classList.remove("dirty");
    status(`Saved as ${p.name} · ${new Date().toLocaleTimeString()}`); toast(`Saved in this browser as ${p.name}`); runCard(); panel();
  }
  function reset() {
    const n = me();
    if (!confirm(`Discard ${n === DEFAULT.name ? "your" : n + "'s"} saved corrections for this example and model, and go back to the model's result?`)) return;
    ls.del(verKey(n)); if (n === DEFAULT.name) ls.del(legacyKey());
    loadRun(S.run, true);
  }
  function exportAll() {
    const read = (prefix) => ls.keys(prefix).map((k) => ls.get(k)).filter(Boolean);
    const legacy = read("pv_edit:"), vers = read("pv_ver:");
    const scores = ls.keys("pv_score:").map((k) => { const [, sheet_id, run, ...rest] = k.split(":"); return { sheet_id, run, version: rest.join(":"), ...(ls.get(k) || {}) }; });
    if (!legacy.length && !vers.length && !scores.length) { toast("No saved corrections yet"); return; }
    const out = {
      exported_at: new Date().toISOString(), tool: "plantviz.github.io/tool", schema: "specimetrics-annotations/2",
      schema_note: "versions: one record per (sheet_id, run, annotator) with role, expertise, saved_at, px_per_mm and objects " +
        "(points in full-resolution image px; types blade, culm, blade_width, culm_width, spine). Spine objects carry n and " +
        "folds [vertex index, ...] (creases the annotator marked; segments between folds are measured separately) and " +
        "sections [{t, center, a, b, width_mm, auto, seg, overlap}] — seg = segment index (0 = before the first fold), overlap = " +
        "the section lies where two folded layers overlap (excluded from the mean width); apparent widths from the image, not thickness. scores: evaluator scores " +
        "1-5 per (sheet_id, run, version), version = annotator name or 'model' (the original model result). corrections: legacy " +
        "single-version records (pv_edit), equivalent to annotator 'default'.",
      profiles: Object.values(profiles()), active_profile: me(), versions: vers, scores, corrections: legacy,
    };
    const blob = new Blob([JSON.stringify(out, null, 1)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `plantviz-corrections-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    toast(`Exported ${vers.length + legacy.length} version${vers.length + legacy.length === 1 ? "" : "s"} · ${scores.length} score${scores.length === 1 ? "" : "s"}`);
  }
  function runInfo() {
    const v = versions(), own = v.find((x) => x.annotator === me());
    if (!v.length) return "No corrections saved yet";
    return `<span class="badge">Corrected</span>${v.length} saved version${v.length > 1 ? "s" : ""}${own ? ` · yours ${when(own.saved_at)}` : ""}`;
  }
  function loadVersion(name) {
    if (!S.sheet || !confirmLeave()) return;
    S.objects = JSON.parse(JSON.stringify(objectsOf(name)));
    S.ver = { base: name, copy: false }; S.undo = []; S.dirty = false; S.selected = S.hot = null; S.drawing = null; $("saveBtn").classList.remove("dirty");
    if (S.cmpB === name) S.cmpB = null;
    status(name === MODEL ? "Showing the model's original result" : name === me() ? "Showing your saved version" : `Viewing ${name}'s version — edits make your own copy`);
    runCard(); panel(); draw();
  }

  // ------------------------------------------------------------ panel: versions + evaluator
  function scoreBadge(name) { const s = ls.get(scoreKey(name)); return s && s.score ? `<span class="tag" title="${esc(`${s.evaluator || ""}${s.comment ? ": " + s.comment : ""}`)}">${s.score}/5</span>` : ""; }
  function renderPanel() {
    const box = $("verBox"); if (!box || !S.sheet) return;
    const v = versions(), ev = isEval(), cur = S.ver?.base || MODEL, mine = me();
    const rows = [{ annotator: MODEL }, ...v];
    const working = S.dirty || S.ver?.copy;
    let h = `<div class="rowx"><span class="k">Versions${ev ? " · evaluator" : ""}</span><span class="grow"></span><span class="sub">${rows.length}</span></div>`;
    for (const r of rows) {
      const n = r.annotator, on = n === cur, isB = S.cmpB === n;
      h += `<div class="ver${on ? " sel" : ""}" data-n="${esc(n)}"><span class="t">${esc(vname(n))}${n === mine ? ' <span class="tag">you</span>' : ""}${scoreBadge(n)}</span>`
        + `<span class="x">${n === MODEL ? "model result" : `${r.expertise ? `<span class="tag">${esc(r.expertise)}</span>` : ""} ${esc(r.role || "")} · ${when(r.saved_at)}${r.copied_from ? ` · from ${esc(vname(r.copied_from))}` : ""}${r.legacy ? " · legacy" : ""}`}</span>`
        + (ev ? `<span class="ab"><button class="small${on ? " on" : ""}" data-a="${esc(n)}" title="Show as A (editable)">A</button><button class="small b${isB ? " on" : ""}" data-b="${esc(n)}" title="Overlay as B (dashed magenta)">B</button></span>` : "")
        + `</div>`;
    }
    if (cur !== mine && cur !== MODEL) h += `<div class="sub note">${working ? `Editing your copy of ${esc(cur)}'s version — saving stores it as <b>${esc(mine)}</b>; theirs stays unchanged.` : `Viewing ${esc(cur)}'s version.`}${working ? "" : ' <button class="small" id="copyBtn">Edit as copy</button>'}</div>`;
    else if (working && cur === MODEL && versionOf(mine)) h += `<div class="sub note">Editing from the model's result — saving replaces your saved version.</div>`;
    if (ev) h += evalBlock(cur);
    box.innerHTML = h;
    box.querySelectorAll(".ver").forEach((el) => (el.onclick = () => { if (el.dataset.n !== cur) loadVersion(el.dataset.n); }));
    box.querySelectorAll("[data-a]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); if (b.dataset.a !== cur) loadVersion(b.dataset.a); }));
    box.querySelectorAll("[data-b]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); S.cmpB = S.cmpB === b.dataset.b ? null : b.dataset.b; renderPanel(); draw(); }));
    const cb = $("copyBtn"); if (cb) cb.onclick = () => { S.ver.copy = true; toast(`Editing your own copy of ${cur}'s version`); renderPanel(); };
    box.querySelectorAll(".score").forEach((sc) => {
      const name = sc.dataset.n, inp = sc.querySelector("input");
      sc.querySelectorAll("button[data-s]").forEach((b) => (b.onclick = () => setScore(name, +b.dataset.s, inp.value)));
      inp.onchange = () => { const s = ls.get(scoreKey(name)); if (s && s.score) setScore(name, s.score, inp.value); };
      inp.onkeydown = (e) => { if (e.key === "Enter") inp.blur(); };
    });
  }
  function setScore(name, score, comment) {
    const rec = { score, comment: String(comment || "").slice(0, 500), evaluator: me(), at: new Date().toISOString() };
    if (!ls.set(scoreKey(name), rec)) { toast("Could not save score"); return; }
    toast(`Scored ${vname(name)} ${score}/5`); renderPanel();
  }
  function scoreRow(label, name) {
    const s = ls.get(scoreKey(name)) || {};
    return `<div class="score" data-n="${esc(name)}"><div class="rowx"><span class="k">${label}</span><span class="sub">${esc(vname(name))}</span><span class="grow"></span>`
      + [1, 2, 3, 4, 5].map((i) => `<button class="small${s.score === i ? " on" : ""}" data-s="${i}">${i}</button>`).join("")
      + `</div><input placeholder="Comment (optional)" maxlength="500" value="${esc(s.comment || "")}">${s.evaluator ? `<div class="sub">scored by ${esc(s.evaluator)} · ${when(s.at)}</div>` : ""}</div>`;
  }
  function evalBlock(cur) {
    let h = `<div class="k gap">Compare</div>`;
    const aName = S.dirty || S.ver?.copy ? "working copy (unsaved)" : vname(cur);
    if (!S.cmpB) h += `<div class="sub">Show one version as A (normal colours) and overlay another as B (dashed magenta) to see agreement.</div>`;
    else {
      const r = compare(S.objects, objectsOf(S.cmpB), S.sheet.px_per_mm, 10), u = r.unit, f1 = (x, d = 1) => (x == null || !isFinite(x) ? "—" : x.toFixed(d));
      h += `<div class="sub">A: <b>${esc(aName)}</b> · B: <b style="color:${B_COLOR}">${esc(vname(S.cmpB))}</b></div><div class="cmp"><span></span><span>A</span><span>B</span><span>Δ</span>`;
      for (const t of r.traits) h += `<span>${t.label}</span><span>${f1(t.a, t.key.includes("width") || t.key.includes("diam") ? 2 : 1)}</span><span>${f1(t.b, t.key.includes("width") || t.key.includes("diam") ? 2 : 1)}</span><span>${t.rel == null ? "—" : (t.rel >= 0 ? "+" : "") + f1(100 * t.rel, 0) + "%"}</span>`;
      h += `<span>Organs</span><span>${r.nA}</span><span>${r.nB}</span><span></span></div>`;
      h += `<div class="sub">medians in ${u}. Matched ${r.matched} organs by nearest midpoint (≤ 10 ${u}): ${f1(r.pctA, 0)}% of A, ${f1(r.pctB, 0)}% of B · mean |Δ length| <b>${f1(r.meanAbsDiffMm)} ${u}</b></div>`;
    }
    if (!(S.dirty || S.ver?.copy)) h += scoreRow("Score A", cur);
    if (S.cmpB) h += scoreRow("Score B", S.cmpB);
    return h;
  }
  function drawOverlay() {
    if (!S.cmpB || !S.sheet) return;
    for (const o of objectsOf(S.cmpB)) if (o.points && o.points.length >= 2) drawPath(o.points, B_COLOR, o.type.endsWith("width") ? 1.2 : 1.8, 0.95, [5, 4]);
  }

  // ------------------------------------------------------------ profile control + modal
  function showWho() {
    const p = active(), w = $("who");
    if (w) w.textContent = `${p.name} · ${p.role}${p.expertise && p.expertise !== "Unspecified" ? " · " + p.expertise : ""}`;
    const sel = $("annSel"); if (!sel) return;
    const all = { [DEFAULT.name]: DEFAULT, ...profiles() };
    sel.innerHTML = Object.values(all).map((x) => `<option value="${esc(x.name)}"${x.name === p.name ? " selected" : ""}>${esc(x.name)} · ${esc(x.role)}</option>`).join("") + `<option value="__new">+ New profile…</option>`;
  }
  function setActive(name) {
    ls.set("pv_profile_active", name); showWho();
    if (!S.sheet) return;
    if (S.dirty) { if (!isEval()) S.cmpB = null; toast(`Now ${name} — unsaved edits will be saved under this name`); S.ver = { ...(S.ver || { base: MODEL }), copy: (S.ver?.base || MODEL) !== name && (S.ver?.base || MODEL) !== MODEL }; runCard(); panel(); }
    else loadRun(S.run, true);
  }
  let modalThen = null;
  function openModal({ firstSave = false, then = null, edit = false } = {}) {
    modalThen = then;
    const p = edit ? active() : { name: "", role: "Annotator", expertise: "Intermediate" };
    $("annName").value = edit ? p.name : ""; $("annName").disabled = edit && p.name === DEFAULT.name;
    const pick = (id, v) => $(id).querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
    pick("annRole", p.role); pick("annExp", p.expertise);
    $("annNote").textContent = firstSave ? "Who is saving? Versions are kept per annotator; nobody's version is overwritten by someone else." : "";
    $("annCancel").textContent = firstSave ? "Save as default" : "Cancel";
    $("annCancel").dataset.first = firstSave ? "1" : "";
    $("annModal").hidden = false; setTimeout(() => $("annName").focus(), 0);
  }
  function closeModal() { $("annModal").hidden = true; const sel = $("annSel"); if (sel) showWho(); }
  function bind() {
    if (!$("annModal")) return;
    for (const id of ["annRole", "annExp"]) $(id).querySelectorAll("button").forEach((b) => (b.onclick = () => $(id).querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b))));
    $("annForm").onsubmit = (e) => {
      e.preventDefault();
      const name = $("annName").disabled ? DEFAULT.name : cleanName($("annName").value);
      if (!name) { $("annNote").textContent = "Enter a name (letters, digits, space . _ -; “model” is reserved)."; return; }
      const role = $("annRole").querySelector(".on")?.dataset.v || "Annotator", expertise = $("annExp").querySelector(".on")?.dataset.v || "Intermediate";
      const all = profiles(); all[name] = { name, role, expertise, created_at: all[name]?.created_at || new Date().toISOString() };
      if (!ls.set("pv_profiles", all)) { $("annNote").textContent = "Browser storage is blocked; profiles cannot be kept."; return; }
      const then = modalThen; closeModal();
      if (then) { ls.set("pv_profile_active", name); showWho(); S.ver && (S.ver.copy = S.ver.base !== name && S.ver.base !== MODEL); then(); }
      else setActive(name);
    };
    $("annCancel").onclick = () => { const first = $("annCancel").dataset.first, then = modalThen; closeModal(); if (first && then) { ls.set("pv_profile_active", DEFAULT.name); showWho(); then(); } };
    $("annModal").onkeydown = (e) => { if (e.key === "Escape") { e.stopPropagation(); closeModal(); } };
    $("annSel").onchange = (e) => { const v = e.target.value; if (v === "__new") { openModal(); showWho(); } else setActive(v); };
    $("annEdit").onclick = () => openModal({ edit: true });
    showWho();
  }
  bind();

  root.Ann = { ...Pure, active, versions, initial, onChange, save, reset, exportAll, runInfo, loadVersion, panel: renderPanel, drawOverlay, openModal, showWho };
})(typeof window !== "undefined" ? window : globalThis);
