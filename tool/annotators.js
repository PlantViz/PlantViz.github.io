// Specimetrics — annotator profiles, saved versions per annotator, evaluator comparison and scores.
// Pure helpers (cleanName, organValues, compare) also load in Node (module.exports) for tests.
// Browser part uses tool.js globals (S, $, toast, status, panel, draw, ...) at call time; tool.js loads after this file.
//
// localStorage keys (all access wrapped in try/catch):
//   pv_ver:<sheetId>:<run>:<annotator>  {sheet_id, species, run, annotator, role, expertise, saved_at, px_per_mm, objects, copied_from?}
//   pv_score:<sheetId>:<run>:<version>  {score 1-5, comment, evaluator, at}   (<version> = annotator name, or "model")
"use strict";
(function (root) {
  const ROLES = ["Annotator", "Evaluator"], EXPERTISE = ["Novice", "Intermediate", "Expert", "Unspecified"];
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
  // the annotator is the signed-in account (local preview builds have no sign-in: one profile kept in this browser)
  const PREVIEW = "pv_preview_profile";
  let account = null;
  function previewAccount() { return { name: "Local preview", role: "Annotator", expertise: "Unspecified", email: "not signed in", picture: null, canEvaluate: true, local: true, ...(ls.get(PREVIEW) || {}) }; }
  function setAccount(u) {
    if (!u) { account = previewAccount(); showWho(); return; }
    account = { name: cleanName(u.display_name || u.name) || cleanName(String(u.email).split("@")[0]) || "User", role: u.work_role === "Evaluator" ? "Evaluator" : "Annotator",
      expertise: EXPERTISE.includes(u.expertise) ? u.expertise : "Unspecified", email: u.email, picture: u.picture || null, canEvaluate: !!u.can_evaluate };
    showWho();
  }
  const active = () => account || previewAccount();
  const me = () => active().name;
  const isEval = () => active().role === "Evaluator";
  const verKey = (name) => `pv_ver:${S.sheet.id}:${S.run}:${name}`;
  const scoreKey = (name) => `pv_score:${S.sheet.id}:${S.run}:${name}`;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const when = (iso) => { try { return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };

  // ------------------------------------------------------------ versions: database (specimens) or this browser (demo sheets)
  // Database: each person has two chains per specimen, kind "organs" (lines) and kind "mask" (mask parts), saved separately
  // so a line edit doesn't resend the mask. Browser: one record per sheet, run and annotator (pv_ver:...).
  const C = { key: null, db: false, specId: null, rows: [], error: null };
  const myId = () => PV.user()?.id;
  const meKey = () => (C.db ? "u" + myId() : me());
  // ------------------------------------------------------------ work status: where a specimen is in annotation and evaluation
  const WORK_KINDS = ["organs", "mask", "notes"];
  const STAGES = [["not_started", "Not started"], ["annotating", "Annotating"], ["annotated", "Annotated"], ["evaluating", "In evaluation"], ["evaluated", "Evaluated"]];
  const STAGE_TIP = { not_started: "Nobody has saved work on it yet", annotating: "Someone has saved work and is still at it", annotated: "An annotator marked their work complete",
    evaluating: "An evaluator has started scoring or commenting", evaluated: "An evaluator accepted it or asked for changes" };
  const DIFFICULTY = [["easy", "Easy"], ["moderate", "Moderate"], ["difficult", "Difficult"], ["not_possible", "Not possible"]];
  const stageName = (s) => (STAGES.find(([k]) => k === s) || STAGES[0])[1];
  const diffName = (d) => (DIFFICULTY.find(([k]) => k === d) || [null, ""])[1];
  const rank = (s) => STAGES.findIndex(([k]) => k === s);
  const mainAid = (v) => v.aid.organs ?? v.aid.mask ?? v.aid.notes;
  const blankNotes = () => ({ difficulty: null, text: "" });
  /** one person's stage: any unsaved-for-review (draft) part means they're still annotating */
  function stageOfVersion(v) {
    if (!C.db) return v.done ? "annotated" : "annotating";
    const st = Object.values(v.status || {});
    if (!st.length) return "not_started";
    if (st.includes("draft")) return "annotating";
    if (st.some((x) => x === "verified" || x === "rejected")) return "evaluated";
    return (v.reviews || []).length ? "evaluating" : "annotated";
  }
  const decisionOf = (v) => (v?.status ? Object.values(v.status).find((x) => x === "verified" || x === "rejected") : null) || null;
  /** the open specimen's stage: the furthest anyone got */
  function sheetStage() { let s = "not_started"; for (const v of versions()) if (rank(v.stage || stageOfVersion(v)) > rank(s)) s = v.stage || stageOfVersion(v); return s; }
  // all specimens' stages for the picker (by file name), from GET /annotations/progress; the open one is updated after each save
  const P = { byFile: new Map(), loaded: false };
  async function loadProgress() {
    if (S.plain) return;
    try { const r = await PV.api("/annotations/progress"); P.byFile = new Map(r.items.map((x) => [x.file_name, x])); P.loaded = true; if (typeof pickRefresh === "function") pickRefresh(); } catch {}
  }
  function noteProgress() {
    const ex = S.meta?.examples[S.idx]; if (!ex?.file_name || !C.db) return;
    P.byFile.set(ex.file_name, { file_name: ex.file_name, stage: sheetStage(), people: C.rows.map((v) => ({ author_id: v.authorId, name: v.annotator, stage: v.stage, difficulty: v.notes?.difficulty || null })) });
    if (typeof pickRefresh === "function") pickRefresh();
  }
  /** stage of a picker entry: database specimens from the progress list, demo sheets from this browser */
  function stageOf(ex) {
    if (ex.group) return P.loaded || P.byFile.has(ex.file_name) ? P.byFile.get(ex.file_name)?.stage || "not_started" : null;
    return null;
  }
  function notesChanged() { return JSON.stringify(S.notes || blankNotes()) !== S.savedSig?.notes; }
  /** typing notes or picking a difficulty: unsaved like any other change (Save keeps it, the draft keeps a copy) */
  function touchNotes() {
    S.dirty = true; $("saveBtn").classList.add("dirty"); if (typeof scheduleDraft === "function") scheduleDraft(); status("Unsaved changes"); stageChip();
  }
  function stageChip() {
    const c = $("stageChip"); if (!c || !S.sheet) return;
    const s = sheetStage(), own = versionOf(meKey()), d = decisionOf(versions().find((v) => decisionOf(v)));
    c.dataset.s = s; c.dataset.d = s === "evaluated" ? d || "verified" : ""; c.querySelector("span").textContent = s === "evaluated" ? (d === "rejected" ? "Needs changes" : "Accepted") : stageName(s);
    c.title = `${stageName(s)}: ${STAGE_TIP[s]}${own ? ` · you: ${stageName(own.stage || stageOfVersion(own))}` : ""} — open the Status tab`;
  }
  function localRows() {
    if (!S.sheet) return [];
    const out = [], pre = `pv_ver:${S.sheet.id}:${S.run}:`;
    for (const k of ls.keys(pre)) { const r = ls.get(k); if (r && Array.isArray(r.objects)) { const name = r.annotator || k.slice(pre.length); out.push({ ...r, annotator: name, key: name, stage: r.done ? "annotated" : "annotating" }); } }
    return out;
  }
  async function fetchRows() {
    const rows = await PV.api(`/specimens/${C.specId}/annotations`), by = new Map();
    for (const a of rows) {
      if (!WORK_KINDS.includes(a.kind)) continue;
      const k = "u" + a.author_id, v = by.get(k) || { key: k, authorId: a.author_id, annotator: a.author?.name || "Someone", role: a.author?.work_role || "", expertise: a.author?.expertise || "", saved_at: "", objects: null, mask: null, notes: null, aid: {}, status: {}, reviews: [] };
      v.aid[a.kind] = a.id; v.status[a.kind] = a.status; if (a.created_at > v.saved_at) v.saved_at = a.created_at;
      if (a.kind === "organs") { v.objects = a.data?.objects || []; v.copied_from = a.data?.copied_from || v.copied_from; }
      else if (a.kind === "mask") v.mask = a.data?.mask || null;
      else v.notes = { difficulty: a.data?.difficulty || null, text: a.data?.text || "" };
      by.set(k, v);
    }
    C.rows = [...by.values()];
    await Promise.all(C.rows.map(async (v) => { try { v.reviews = await PV.api(`/annotations/${mainAid(v)}/reviews`); } catch { v.reviews = []; } }));
    for (const v of C.rows) v.stage = stageOfVersion(v);
    noteProgress();
  }
  /** before a sheet opens: which store, and its versions */
  async function prepare(ex) {
    Object.assign(C, { key: ex.id, db: false, specId: null, rows: [], error: null });
    if (S.plain || !ex.group) return;
    try { const id = await Meta.specimenId(ex); if (!id) return; C.specId = id; C.db = true; await fetchRows(); }
    catch (e) { C.error = e.message || "Could not read the saved versions"; }
  }
  /** saved versions for the open sheet, newest first: the database's for specimens, this browser's for demo sheets */
  function versions() {
    return (C.db ? C.rows : localRows()).slice().sort((a, b) => String(b.saved_at).localeCompare(String(a.saved_at)));
  }
  const versionOf = (key) => versions().find((v) => v.key === key) || null;
  const objectsOf = (key) => ((key === MODEL ? S.sheet.objects : (versionOf(key) || {}).objects) || []).filter(inScope);
  const vname = (key) => (key === MODEL ? "Model (original)" : versionOf(key)?.annotator || String(key).replace(/^local:/, ""));
  const lineObjects = () => S.objects.filter((o) => o.type !== "stroke" && o.type !== "maskmeta");

  // ------------------------------------------------------------ hooks called from tool.js
  /** which version to show when a sheet opens: the signed-in person's own, else the model's */
  function initial() {
    S.cmpB = null;
    const own = versionOf(meKey());
    S.ver = { base: own ? own.key : MODEL, copy: false };
    S.notes = JSON.parse(JSON.stringify(own?.notes || blankNotes())); S.savedSig = { ...(S.savedSig || {}), notes: JSON.stringify(S.notes) };
    return own;
  }
  /** what was last loaded or saved, so Save only sends what changed */
  function markClean(part) { S.savedSig = { ...(S.savedSig || {}), ...(part !== "mask" ? { lines: JSON.stringify(lineObjects()) } : {}), ...(part !== "lines" ? { mask: maskSig() } : {}), ...(!part ? { notes: JSON.stringify(S.notes || blankNotes()) } : {}) }; }
  function onChange() {
    const v = S.ver || (S.ver = { base: MODEL });
    if (v.base !== meKey() && v.base !== MODEL && !v.copy) { v.copy = true; toast(`Editing your own copy — ${vname(v.base)}'s version stays unchanged`); }
  }
  let saving = false;
  /** Save (one button). submit: also mark the work complete, so evaluators can review it; saving changes later reopens it */
  async function save({ submit = false } = {}) {
    if (!S.sheet || saving) return false;
    const p = active(), base = S.ver?.base || MODEL, key = meKey(), other = base !== key && base !== MODEL ? versionOf(base) : null;
    const lines = lineObjects(), lineChanged = JSON.stringify(lines) !== S.savedSig?.lines || !!other, maskChanged = Mask.ready && (maskSig() !== S.savedSig?.mask || !!other || !!S.forceMaskSave);
    const notes = S.notes || blankNotes(), noteChanged = notesChanged(), own = versionOf(key);
    if (!lineChanged && !maskChanged && !noteChanged && !submit) { S.dirty = false; $("saveBtn").classList.remove("dirty"); toast("Nothing new to save"); return true; }
    if (submit && !lineChanged && !maskChanged && !noteChanged && !own) { toast("Nothing to mark complete yet: draw, paint the mask or write a note first"); return false; }
    const what = [lineChanged && "lines", maskChanged && "mask", noteChanged && "notes"].filter(Boolean).join(", ").replace(/, ([^,]*)$/, " and $1") || "status";
    if (C.db) {
      saving = true; $("saveBtn").disabled = true; status(submit ? "Marking complete…" : "Saving…");
      try {
        const src = other, common = { run: S.run, px_per_mm: S.sheet.px_per_mm, copied_from: src ? src.annotator : undefined }, sent = new Set();
        const post = async (kind, parent, data) => { await PV.api(`/specimens/${C.specId}/annotations`, { method: "POST", json: { kind, source: "human", parent_id: parent, submit, data } }); sent.add(kind); };
        if (lineChanged) await post("organs", src?.aid.organs, { ...common, objects: lines });
        if (maskChanged) await post("mask", src?.aid.mask, { ...common, mask: Mask.encode() });
        if (noteChanged) await post("notes", undefined, { run: S.run, difficulty: notes.difficulty || null, text: String(notes.text || "").slice(0, 10000) });
        if (submit && own) for (const k of WORK_KINDS) if (!sent.has(k) && own.aid[k] && own.status[k] === "draft") await PV.api(`/annotations/${own.aid[k]}`, { method: "PATCH", json: { status: "submitted" } });
        await fetchRows();
      } catch (e) {
        saving = false; $("saveBtn").disabled = false;
        const msg = e.status === 401 ? "Not saved: you're signed out. Your work is still on screen and kept as a draft; press Save again to sign in" : e.status === 403 ? "Your account can't save annotations yet: ask an admin for annotator access" : `Could not save (${e.message})`;
        status(msg); toast(msg); try { await fetchRows(); } catch {} return false;
      }
      saving = false; $("saveBtn").disabled = false;
    } else {
      if (base !== key && versionOf(key) && !confirm(`Replace your saved version (${p.name}) for this sheet and model with the one on screen?`)) return;
      const prev = versionOf(key), rec = { sheet_id: S.sheet.id, species: S.sheet.species, run: S.run, annotator: p.name, account: p.email, role: p.role, expertise: p.expertise,
        saved_at: new Date().toISOString(), px_per_mm: S.sheet.px_per_mm, objects: lines, mask: maskChanged ? Mask.encode() : prev?.mask || null, notes, done: submit };
      if (base !== key) rec.copied_from = vname(base);
      if (!ls.set(`pv_ver:${S.sheet.id}:${S.run}:${p.name}`, rec)) { toast("Could not save: this browser's storage is full or blocked"); return false; }
    }
    S.ver = { base: key, copy: false }; S.dirty = false; S.forceMaskSave = false; $("saveBtn").classList.remove("dirty"); markClean(); clearDraft();
    const where = C.db ? "the database" : "this browser";
    if (submit) { status(`Marked complete as ${p.name} · ${new Date().toLocaleTimeString()}`); toast(C.db ? "Marked complete: evaluators can review it now" : "Marked complete"); }
    else { status(`Saved ${what} to ${where} as ${p.name} · ${new Date().toLocaleTimeString()}`); toast(`Saved ${what} to ${where}${own && own.stage !== "annotating" && C.db ? " · reopened: mark it complete again when you're done" : ""}`); }
    runCard(); panel(); return true;
  }
  function reset() {
    if (C.db) {
      if (!confirm("Start this sheet again from the model? Your saved versions stay in the database history.")) return;
      clearDraft(); S.objects = []; S.ver = { base: MODEL, copy: false }; S.undo = []; S.selected = null; applyBase(null); S.dirty = true; $("saveBtn").classList.add("dirty");
      status("Started again from the model. Save to keep this as your latest version."); panel(); draw(); return;
    }
    const n = me();
    if (!confirm(`Discard ${n}'s saved corrections for this example and model${SHOW_PREDICTED ? ", and go back to the model's result" : ""}?`)) return;
    ls.del(`pv_ver:${S.sheet.id}:${S.run}:${n}`); clearDraft();
    loadRun(S.run, true);
  }
  function exportAll() {
    const read = (prefix) => ls.keys(prefix).map((k) => ls.get(k)).filter(Boolean);
    const vers = read("pv_ver:");
    const scores = ls.keys("pv_score:").map((k) => { const [, sheet_id, run, ...rest] = k.split(":"); return { sheet_id, run, version: rest.join(":"), ...(ls.get(k) || {}) }; });
    const dbRows = C.db ? C.rows.map((v) => ({ specimen_id: C.specId, sheet_id: S.sheet.id, annotator: v.annotator, role: v.role, expertise: v.expertise, saved_at: v.saved_at, objects: v.objects, mask: v.mask, reviews: v.reviews })) : [];
    if (!vers.length && !scores.length && !dbRows.length) { toast("No saved corrections yet"); return; }
    const out = {
      exported_at: new Date().toISOString(), tool: "plantviz.github.io/tool", schema: "specimetrics-annotations/3",
      schema_note: "versions: browser saves, one record per (sheet_id, run, annotator); database_versions: this specimen's latest version per person. " +
        "objects: points in full-resolution image px; types blade, culm, blade_width, culm_width, spine, contour. Spine objects carry n, folds [vertex index] " +
        "and sections [{t, center, a, b, width_mm, auto, seg, overlap}]. mask: {w, h, png (base64; red channel = part number, 0 = not plant), " +
        "parts [{id, cls, n, pixels}]} at mask resolution (scale by the sheet size). scores / reviews: evaluator scores 1-5.",
      profiles: [{ name: me(), role: active().role, expertise: active().expertise }], active_profile: me(), versions: vers, scores, database_versions: dbRows,
    };
    const blob = new Blob([JSON.stringify(out, null, 1)], { type: "application/json" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `plantviz-corrections-${new Date().toISOString().slice(0, 10)}.json`; a.click();
    toast(`Exported ${vers.length + dbRows.length} version${vers.length + dbRows.length === 1 ? "" : "s"}`);
  }
  function runInfo() {
    const v = versions(), own = versionOf(meKey());
    if (!v.length) return C.db ? "No versions saved yet" : "No corrections saved in this browser yet";
    return `<span class="badge">Corrected</span>${v.length} saved version${v.length > 1 ? "s" : ""}${own ? ` · yours ${when(own.saved_at)}` : ""}`;
  }
  function loadVersion(key) {
    if (!S.sheet || !confirmLeave()) return;
    if (SHOW_PREDICTED && key === MODEL && S.overlay === "mine") setOverlay("key");
    const v = key === MODEL ? null : versionOf(key);
    S.objects = JSON.parse(JSON.stringify(objectsOf(key)));
    S.ver = { base: key, copy: false }; S.undo = []; S.dirty = false; S.selected = S.hot = null; S.drawing = null; $("saveBtn").classList.remove("dirty");
    if (S.cmpB === key) S.cmpB = null;
    markClean("lines"); applyBase(v);
    status(key === MODEL ? "Showing the model's original result" : key === meKey() ? "Showing your saved version" : `Viewing ${vname(key)}'s version — edits make your own copy`);
    runCard(); panel(); draw();
  }

  // ------------------------------------------------------------ panel: versions + evaluator
  const myReview = (v) => (v?.reviews || []).filter((r) => r.evaluator_id === myId()).at(-1);
  function scoreBadge(key) {
    const v = versionOf(key);
    if (C.db && v) { const r = (v.reviews || []).filter((x) => x.score); if (!r.length) return ""; const avg = r.reduce((a, x) => a + x.score, 0) / r.length; return `<span class="tag" title="${r.length} score${r.length > 1 ? "s" : ""}">${avg.toFixed(r.length > 1 ? 1 : 0)}/5</span>`; }
    const s = ls.get(scoreKey(key)); return s && s.score ? `<span class="tag" title="${esc(`${s.evaluator || ""}${s.comment ? ": " + s.comment : ""}`)}">${s.score}/5</span>` : "";
  }
  function renderPanel() {
    renderStatus(); stageChip();
    const box = $("verBox"); if (!box || !S.sheet) return;
    const a = document.activeElement; if (a && box.contains(a) && a.tagName === "INPUT") return;   // someone is typing a comment
    const v = versions(), ev = isEval(), cur = S.ver?.base || MODEL, mine = meKey();
    const rows = [...(SHOW_PREDICTED ? [{ key: MODEL, annotator: MODEL }] : []), ...v];
    const working = S.dirty || S.ver?.copy;
    let h = `<div class="rowx"><span class="k">Versions${ev ? " · evaluator" : ""}</span><span class="grow"></span><span class="sub">${rows.length}</span></div>`
      + `<div class="sub note">${C.db ? "Saved in the database: everyone on the project sees them." : S.plain ? "Local preview: saved in this browser." : "Demo sheet: saved in this browser only."}${C.error ? ` <b>${esc(C.error)}</b>` : ""}</div>`;
    for (const r of rows) {
      const n = r.key, on = n === cur, isB = S.cmpB === n;
      h += `<div class="ver${on ? " sel" : ""}" data-n="${esc(n)}"><span class="t">${esc(vname(n))}${n === mine ? ' <span class="tag">you</span>' : ""}${scoreBadge(n)}</span>`
        + `<span class="x">${n === MODEL ? "model result" : `${r.expertise ? `<span class="tag">${esc(r.expertise)}</span>` : ""} ${esc(r.role || "")} · ${when(r.saved_at)}${r.copied_from ? ` · from ${esc(r.copied_from)}` : ""}`}</span>`
        + (ev ? `<span class="ab"><button class="small${on ? " on" : ""}" data-a="${esc(n)}" title="Show as A (editable)">A</button><button class="small b${isB ? " on" : ""}" data-b="${esc(n)}" title="Overlay as B (dashed magenta)">B</button></span>` : "")
        + `</div>`;
    }
    if (cur !== mine && cur !== MODEL) h += `<div class="sub note">${working ? `Editing your copy of ${esc(vname(cur))}'s version — saving stores it under <b>${esc(me())}</b>; theirs stays unchanged.` : `Viewing ${esc(vname(cur))}'s version.`}${working ? "" : ' <button class="small" id="copyBtn">Edit as copy</button>'}</div>`;
    if (ev) h += evalBlock(cur);
    box.innerHTML = h;
    box.querySelectorAll(".ver").forEach((el) => (el.onclick = () => { if (el.dataset.n !== cur) loadVersion(el.dataset.n); }));
    box.querySelectorAll("[data-a]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); if (b.dataset.a !== cur) loadVersion(b.dataset.a); }));
    box.querySelectorAll("[data-b]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); S.cmpB = S.cmpB === b.dataset.b ? null : b.dataset.b; renderPanel(); draw(); }));
    const cb = $("copyBtn"); if (cb) cb.onclick = () => { S.ver.copy = true; toast(`Editing your own copy of ${vname(cur)}'s version`); renderPanel(); };
    const ts = $("toStatus"); if (ts) ts.onclick = () => showTab("status");
    box.querySelectorAll(".score").forEach((sc) => {
      const key = sc.dataset.n, inp = sc.querySelector("input");
      sc.querySelectorAll("button[data-s]").forEach((b) => (b.onclick = () => setScore(key, +b.dataset.s, inp.value)));
      inp.onchange = () => { const s = C.db ? myReview(versionOf(key)) : ls.get(scoreKey(key)); if (s && s.score) setScore(key, s.score, inp.value); };
      inp.onkeydown = (e) => { if (e.key === "Enter") inp.blur(); };
    });
  }
  async function setScore(key, score, comment) {
    const v = versionOf(key), text = String(comment || "").slice(0, 500);
    if (C.db && v) {
      try { await PV.api(`/annotations/${mainAid(v)}/reviews`, { method: "POST", json: { score, comment: text || undefined, decision: "comment" } }); v.reviews = await PV.api(`/annotations/${mainAid(v)}/reviews`); v.stage = stageOfVersion(v); noteProgress(); }
      catch (e) { toast(e.status === 403 ? (v.authorId === myId() ? "You can't score your own version" : "Scoring needs evaluator access") : `Could not save the score (${e.message})`); return; }
    } else if (!ls.set(scoreKey(key), { score, comment: text, evaluator: me(), account: active().email, at: new Date().toISOString() })) { toast("Could not save score"); return; }
    toast(`Scored ${vname(key)} ${score}/5`); renderPanel();
  }
  function scoreRow(label, key) {
    const v = versionOf(key), s = (C.db && v ? myReview(v) : ls.get(scoreKey(key))) || {};
    return `<div class="score" data-n="${esc(key)}"><div class="rowx"><span class="k">${label}</span><span class="sub">${esc(vname(key))}</span><span class="grow"></span>`
      + [1, 2, 3, 4, 5].map((i) => `<button class="small${s.score === i ? " on" : ""}" data-s="${i}">${i}</button>`).join("")
      + `</div><input placeholder="Comment (optional)" maxlength="500" value="${esc(s.comment || "")}">${s.score ? `<div class="sub">your score · ${when(s.created_at || s.at)}</div>` : ""}</div>`;
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
    if (!(S.dirty || S.ver?.copy) && cur !== MODEL) h += `<div class="sub gap">Score and notes for A: <button class="small" id="toStatus">Status tab</button></div>`;
    if (S.cmpB) h += scoreRow("Score B", S.cmpB);
    return h;
  }
  function drawOverlay() {
    if (!S.cmpB || !S.sheet) return;
    for (const o of objectsOf(S.cmpB)) if (o.type !== "stroke" && o.type !== "maskmeta" && o.points && o.points.length >= 2) drawPath(o.points, B_COLOR, o.type.endsWith("width") ? 1.2 : 1.8, 0.95, [5, 4]);
  }

  // ------------------------------------------------------------ Status tab: stage, your difficulty + notes, mark complete; evaluators: notes, score, decision
  let evalDraft = { key: null, text: "" };   // an evaluator's note being written survives re-renders
  function renderStatus() {
    const box = $("statusBox"); if (!box || !S.sheet) return;
    const a = document.activeElement; if (a && box.contains(a) && a.tagName === "TEXTAREA") return;   // someone is typing
    const s = sheetStage(), v = versions(), key = meKey(), own = versionOf(key), myStage = own ? own.stage || stageOfVersion(own) : "not_started";
    const cur = S.ver?.base || MODEL, target = cur !== key && cur !== MODEL ? versionOf(cur) : null, n = S.notes || blankNotes();
    let h = `<div class="stages" role="list">${STAGES.map(([k, l], i) => `<div class="stg${k === s ? " on" : ""}${i < rank(s) ? " past" : ""}" data-s="${k}" role="listitem" title="${STAGE_TIP[k]}"><i></i><span>${l}</span></div>`).join("")}</div>`;
    h += `<div class="sub note">${C.db ? "This specimen, across everyone working on it." : "Demo sheet: status is kept in this browser only."}</div>`;
    // your work
    const dec = decisionOf(own), last = own && (own.reviews || []).filter((r) => r.comment).at(-1);
    h += `<div class="k gap">Your work <span class="tag st" data-s="${myStage}" data-d="${dec || ""}">${dec ? (dec === "rejected" ? "Needs changes" : "Accepted") : stageName(myStage)}</span></div>`;
    if (dec === "rejected" || (last && myStage !== "annotating")) h += `<div class="sub note">${dec === "rejected" ? "<b>An evaluator asked for changes.</b> " : ""}${last ? `“${esc(last.comment)}” — ${esc(last.evaluator_name || "evaluator")}` : ""}</div>`;
    h += `<div class="k sm">How hard is this specimen to annotate?</div><div class="seg diff" id="diffSeg">${DIFFICULTY.map(([k, l]) => `<button type="button" data-d="${k}" class="${n.difficulty === k ? "on" : ""}">${l}</button>`).join("")}</div>`;
    h += `<div class="k sm">Notes · think aloud</div><textarea id="noteText" rows="5" maxlength="10000" placeholder="What you see, what's hard, what you decided and why. Saved with Save (Ctrl S).">${esc(n.text || "")}</textarea>`;
    if (myStage === "annotating" || myStage === "not_started" || S.dirty) h += `<div class="rowx"><span class="sub">${S.dirty ? "Unsaved changes" : own ? `Saved ${when(own.saved_at)}` : "Nothing saved yet"}</span><span class="grow"></span><button class="on" id="doneBtn" title="Save and tell evaluators your work on this specimen is finished">Mark complete</button></div>`;
    else h += `<div class="sub">You marked this complete${own ? ` · ${when(own.saved_at)}` : ""}. Saving changes reopens it.</div>`;
    // evaluator: the version on screen
    if (isEval() && C.db) {
      h += `<div class="k gap">Evaluate</div>`;
      if (!target) {
        const others = v.filter((x) => x.key !== key);
        h += others.length ? `<div class="sub">Open someone's version to evaluate it:</div>` + others.map((x) => `<div class="rowx who"><span>${esc(x.annotator)}</span><span class="tag st" data-s="${x.stage}">${stageName(x.stage)}</span><span class="grow"></span><button class="small" data-open="${esc(x.key)}">Open</button></div>`).join("")
          : `<div class="sub">No one else has saved work on this specimen yet.</div>`;
      } else {
        const mine = (target.reviews || []).filter((r) => r.evaluator_id === myId() && r.score).at(-1) || {}, tStage = target.stage || stageOfVersion(target), canDecide = tStage !== "annotating";
        h += `<div class="sub">${esc(target.annotator)}'s version · <span class="tag st" data-s="${tStage}">${stageName(tStage)}</span>${target.notes?.difficulty ? ` · rated <b>${diffName(target.notes.difficulty)}</b>` : ""}</div>`;
        if (target.notes?.text) h += `<div class="quote">${esc(target.notes.text)}</div>`;
        h += `<div class="rowx"><span class="k sm">Score</span><span class="grow"></span>${[1, 2, 3, 4, 5].map((i) => `<button class="small${mine.score === i ? " on" : ""}" data-sc="${i}">${i}</button>`).join("")}</div>`;
        h += `<div class="k sm">Evaluator notes · think aloud</div><textarea id="evalText" rows="4" maxlength="5000" placeholder="What's right, what's missing, what should change."></textarea>`;
        h += `<div class="rowx"><button class="small" id="evNote">Save note</button><span class="grow"></span><button class="small" id="evReject"${canDecide ? "" : " disabled"} title="Send it back to the annotator">Needs changes</button><button class="small on" id="evAccept"${canDecide ? "" : " disabled"} title="Accept this version">Accept</button></div>`;
        if (!canDecide) h += `<div class="sub">Accept and Needs changes open once ${esc(target.annotator)} marks the work complete. Notes and scores can be given any time.</div>`;
      }
    }
    // everything said about this specimen
    const said = [];
    for (const x of v) {
      if (x.notes?.difficulty || x.notes?.text) said.push({ at: x.saved_at, who: x.annotator, what: "annotator", diff: x.notes.difficulty, text: x.notes.text });
      for (const r of x.reviews || []) if (r.comment || r.score || r.decision !== "comment") said.push({ at: r.created_at, who: r.evaluator_name || "Evaluator", what: `on ${x.annotator}'s version`, text: r.comment, decision: r.decision, score: r.score });
    }
    if (said.length) {
      said.sort((p, q) => String(q.at).localeCompare(String(p.at)));
      h += `<div class="k gap">Notes on this specimen</div>` + said.map((x) => `<div class="said"><div class="sub"><b>${esc(x.who)}</b> ${esc(x.what)} · ${when(x.at)}${x.diff ? ` · <span class="tag">${diffName(x.diff)}</span>` : ""}${x.decision && x.decision !== "comment" ? ` · <span class="tag st" data-s="evaluated" data-d="${x.decision}">${x.decision === "verified" ? "Accepted" : "Needs changes"}</span>` : ""}${x.score ? ` · ${x.score}/5` : ""}</div>${x.text ? `<div class="quote">${esc(x.text)}</div>` : ""}</div>`).join("");
    }
    box.innerHTML = h;
    box.querySelectorAll("#diffSeg button").forEach((b) => (b.onclick = () => { const d = b.dataset.d; S.notes = { ...(S.notes || blankNotes()), difficulty: S.notes?.difficulty === d ? null : d }; touchNotes(); renderStatus(); }));
    const ta = $("noteText"); ta.oninput = () => { S.notes = { ...(S.notes || blankNotes()), text: ta.value }; touchNotes(); };
    const et = $("evalText"); if (et) { et.value = evalDraft.key === cur ? evalDraft.text : ""; et.oninput = () => (evalDraft = { key: cur, text: et.value }); }
    const done = $("doneBtn"); if (done) done.onclick = async () => { if (S.drawing) finish(); await save({ submit: true }); };
    box.querySelectorAll("[data-open]").forEach((b) => (b.onclick = () => loadVersion(b.dataset.open)));
    if (target && $("evNote")) {   // evaluator controls exist only for evaluators
      box.querySelectorAll("[data-sc]").forEach((b) => (b.onclick = () => review(target, { score: +b.dataset.sc })));
      $("evNote").onclick = () => { const t = $("evalText").value.trim(); if (!t) return toast("Write a note first"); review(target, { comment: t }); };
      $("evAccept").onclick = () => review(target, { comment: $("evalText").value.trim(), decision: "verified" });
      $("evReject").onclick = () => { const t = $("evalText").value.trim(); if (!t && !confirm("Ask for changes without a note? A note tells the annotator what to fix.")) return; review(target, { comment: t, decision: "rejected" }); };
    }
  }
  async function review(v, { score, comment, decision = "comment" }) {
    try {
      await PV.api(`/annotations/${mainAid(v)}/reviews`, { method: "POST", json: { score: score || undefined, comment: comment || undefined, decision } });
      v.reviews = await PV.api(`/annotations/${mainAid(v)}/reviews`);
      if (decision !== "comment") v.status[Object.keys(v.aid).find((k) => v.aid[k] === mainAid(v))] = decision;
      v.stage = stageOfVersion(v); noteProgress();
      toast(decision === "verified" ? `Accepted ${v.annotator}'s version` : decision === "rejected" ? `Sent back to ${v.annotator} with your note` : score ? `Scored ${score}/5` : "Note saved");
      if (comment || decision !== "comment") evalDraft = { key: null, text: "" };
      renderStatus(); renderPanel();
    } catch (e) { toast(e.status === 403 ? (v.authorId === myId() ? "You can't evaluate your own version" : "Evaluating needs evaluator access") : e.status === 409 ? "It has to be marked complete before you can accept it or ask for changes" : `Could not save (${e.message})`); }
  }

  // ------------------------------------------------------------ profile control + modal
  function showWho() {
    const p = active(), w = $("who"), btn = $("profileBtn");
    if (w) w.textContent = `${p.name} · ${p.role}${p.expertise && p.expertise !== "Unspecified" ? " · " + p.expertise : ""}`;
    if (!btn) return;
    btn.querySelector("span").textContent = p.name;
    const img = btn.querySelector("img"); img.hidden = !p.picture; if (p.picture) img.src = p.picture;
    btn.title = `${p.name} · ${p.role}${p.expertise !== "Unspecified" ? " · " + p.expertise : ""} — edit your profile`;
  }
  const pick = (id, v) => $(id).querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
  function openModal() {
    const p = active();
    $("annName").value = p.name; pick("annRole", p.role); pick("annExp", p.expertise);
    $("profEmail").textContent = p.email;
    const img = $("profPic"); img.hidden = !p.picture; if (p.picture) img.src = p.picture;
    $("annRole").querySelector('[data-v="Evaluator"]').disabled = !p.canEvaluate;
    $("annNote").textContent = p.canEvaluate ? "" : "Evaluator access is given by an admin.";
    $("annModal").hidden = false; setTimeout(() => $("annName").focus(), 0);
  }
  function closeModal() { $("annModal").hidden = true; }
  /** saved work in this browser follows a rename */
  function renameLocal(from, to) {
    if (from === to) return;
    for (const prefix of ["pv_ver:", "pv_score:"]) for (const k of ls.keys(prefix)) {
      if (!k.endsWith(":" + from)) continue;
      const r = ls.get(k); if (!r) continue;
      if (prefix === "pv_ver:") r.annotator = to;
      ls.set(k.slice(0, -from.length) + to, r); ls.del(k);
    }
    for (const k of ls.keys("pv_score:")) { const r = ls.get(k); if (r && r.evaluator === from) { r.evaluator = to; ls.set(k, r); } }
    if (S.ver && S.ver.base === from) S.ver.base = to;
  }
  /** saves from before sign-in ("default", hand-made profiles) are removed: only work tied to an account stays */
  function purgeOld() {
    for (const k of ls.keys("pv_edit:")) ls.del(k);
    ls.del("pv_profiles"); ls.del("pv_profile_active");
    for (const prefix of ["pv_ver:", "pv_score:"]) for (const k of ls.keys(prefix)) { const r = ls.get(k); if (!r || !r.account) ls.del(k); }
  }
  function bind() {
    purgeOld();
    if (!$("annModal")) return;
    for (const id of ["annRole", "annExp"]) $(id).querySelectorAll("button").forEach((b) => (b.onclick = () => $(id).querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b))));
    $("annForm").onsubmit = async (e) => {
      e.preventDefault();
      const name = cleanName($("annName").value), before = active();
      if (!name) { $("annNote").textContent = "Enter a name (letters, digits, space . _ -; “model” is reserved)."; return; }
      const role = $("annRole").querySelector(".on")?.dataset.v || "Annotator", expertise = $("annExp").querySelector(".on")?.dataset.v || "Unspecified";
      $("annOk").disabled = true; $("annNote").textContent = "";
      try {
        if (before.local) { ls.set(PREVIEW, { name, role, expertise }); setAccount(null); }
        else setAccount(await PV.api("/me", { method: "PATCH", json: { display_name: name, expertise, work_role: role } }));
      } catch (err) {
        $("annOk").disabled = false;
        $("annNote").textContent = err.status === 401 ? "Your sign-in has expired. Reload the page to sign in again; nothing was saved." : err.message || "Could not save your profile.";
        return;
      }
      $("annOk").disabled = false; renameLocal(before.name, active().name); closeModal(); toast("Profile saved");
      if (S.sheet) { if (!isEval()) S.cmpB = null; panel(); draw(); }
    };
    $("annCancel").onclick = closeModal;
    $("annModal").onkeydown = (e) => { if (e.key === "Escape") { e.stopPropagation(); closeModal(); } };
    $("profileBtn").onclick = openModal;
    showWho();
  }
  bind();

  root.Ann = { ...Pure, setAccount, active, versions, prepare, markClean, initial, onChange, save, reset, exportAll, runInfo, loadVersion, panel: renderPanel, viewingOther: () => { const b = S.ver?.base; return b && b !== MODEL && b !== meKey() && !S.ver.copy ? vname(b) : null; }, drawOverlay, showWho,
    loadProgress, stageOf, stageName, STAGES };
})(typeof window !== "undefined" ? window : globalThis);
