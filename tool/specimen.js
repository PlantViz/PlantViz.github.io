// Specimetrics — specimen metadata editor (Specimen tab). Values live in the database; every change is versioned by the API.
// Uses tool.js globals (S, $, toast, status, Ann) at call time; tool.js loads after this file.
"use strict";
(function (root) {
  const byId = (id) => document.getElementById(id);   // local: this file loads before tool.js
  const GROUPS = [
    ["Identification", [["scientific_name", "Scientific name"], ["family", "Family"]]],
    ["Collection", [["collector", "Collector"], ["collector_number", "Collector no."], ["collection_date", "Date"]]],
    ["Location", [["country", "Country"], ["state_province", "State / province"], ["locality", "Locality", "area"], ["latitude", "Latitude", "num"], ["longitude", "Longitude", "num"]]],
    ["Record", [["institution_code", "Institution"], ["catalog_number", "Catalog no."], ["record_url", "Record link"], ["image_url", "Image link"], ["licence", "Licence"], ["rights_holder", "Rights holder"], ["contributor", "Contributor"]]],
    ["Sheet", [["has_ruler", "Ruler", "ruler"], ["notes", "Notes", "area"]]],
  ];
  const FIELDS = GROUPS.flatMap(([, f]) => f.map((x) => x[0]));
  const M = { index: null, spec: null, ex: null, token: 0, busy: false };
  const esc = (t) => PV.esc(t);
  const str = (v) => (v == null ? "" : String(v));
  const when = (iso) => { try { return new Date(iso + (iso.endsWith("Z") ? "" : "Z")).toLocaleString([], { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };
  const role = () => PV.user()?.role;
  const canEdit = () => ["annotator", "evaluator", "admin"].includes(role());
  const canConfirm = () => ["evaluator", "admin"].includes(role());
  const box = () => byId("metaBox");
  const input = (f) => box().querySelector(`[data-f="${f}"]`);
  const changes = () => { const out = {}; if (!M.spec) return out; for (const f of FIELDS) { const e = input(f); if (e && e.value.trim() !== str(M.spec.metadata[f].value)) out[f] = e.value.trim(); } return out; };
  const dirty = () => Object.keys(changes()).length > 0;
  const review = () => (M.spec ? FIELDS.filter((f) => M.spec.metadata[f].needs_review) : []);
  const flag = () => { const b = document.querySelector('#tabs [data-p="spec"]'); if (b) b.classList.toggle("flag", review().length > 0); };
  const say = (t) => { box().innerHTML = `<div class="sub gap">${esc(t)}</div>`; flag(); };

  async function specimenId(ex) {
    if (!M.index) {
      const r = await PV.api("/specimens?limit=500");
      M.index = new Map(r.items.map((x) => [x.file_name, x.id]));
    }
    return ex.specId || M.index.get(ex.file_name);
  }

  /** the tool opened another example */
  async function show(ex) {
    const t = ++M.token; M.spec = null; M.ex = ex; flag();
    if (!ex.group) return say("Demo example: its details come from the herbarium record and can't be edited here.");
    if (S.plain) return say("Metadata needs sign-in; this local preview has no server.");
    box().innerHTML = `<div class="sub gap">Loading details…</div>`;
    try {
      const id = await specimenId(ex); if (t !== M.token) return;
      if (!id) return say("This specimen isn't in the database yet.");
      const sp = await PV.api(`/specimens/${id}`); if (t !== M.token) return;
      M.spec = sp; render();
    } catch (e) {
      if (t !== M.token) return;
      box().innerHTML = `<div class="sub gap">Could not load the details (${esc(e.message)}). <button class="small" id="metaRetry">Try again</button></div>`;
      byId("metaRetry").onclick = () => show(ex);
    }
  }

  function fieldHtml([f, label, kind]) {
    const m = M.spec.metadata[f], v = str(m.value), off = canEdit() ? "" : " disabled", src = m.source ? `From ${m.source}${m.confidence ? ` · ${m.confidence} confidence` : ""}` : "";
    const control = kind === "area" ? `<textarea rows="2" data-f="${f}"${off}>${esc(v)}</textarea>`
      : kind === "ruler" ? `<select data-f="${f}"${off}>${["", "yes", "no", "unclear"].map((o) => `<option value="${o}"${o === v ? " selected" : ""}>${o || "—"}</option>`).join("")}</select>`
      : `<input data-f="${f}" value="${esc(v)}" autocomplete="off"${kind === "num" ? ' inputmode="decimal"' : ""}${off}>`;
    return `<div class="mf"><div class="ml"><span title="${esc(src)}">${label}</span>${m.needs_review ? `<span class="tag rv" title="${esc(src)}">check</span>` : ""}<span class="grow"></span>`
      + (m.needs_review && canConfirm() ? `<button type="button" class="mini" data-ok="${f}" title="The current value is right">Confirm</button>` : "")
      + `<button type="button" class="mini" data-h="${f}" title="Earlier values">History</button></div>${control}<div class="mh" data-hist="${f}" hidden></div></div>`;
  }

  function render() {
    const n = review().length;
    box().innerHTML = `<div class="rowx gap"><span class="k">Details</span><span class="grow"></span>${n ? `<span class="sub">${n} to check</span>` : `<span class="sub">all checked</span>`}${n && canConfirm() ? '<button type="button" class="mini" id="metaAll" title="Mark every value marked “check” as right">Confirm all</button>' : ""}</div>`
      + (canEdit() ? "" : `<div class="sub note">View only: an admin can give your account annotator access.</div>`)
      + GROUPS.map(([g, fs]) => `<div class="mg">${g}</div>` + fs.map(fieldHtml).join("")).join("")
      + (canEdit() ? `<div class="mfoot" id="metaFoot" hidden><input id="metaReason" placeholder="Why this change? (optional)" maxlength="300" autocomplete="off"><div class="rowx"><span class="sub" id="metaCount"></span><span class="grow"></span><button type="button" class="small" id="metaDiscard">Discard</button><button type="button" class="small on" id="metaSave">Save</button></div><div class="sub err" id="metaErr"></div></div>` : "");
    box().querySelectorAll("[data-f]").forEach((e) => (e.oninput = e.onchange = sync));
    box().querySelectorAll("[data-ok]").forEach((b) => (b.onclick = () => confirmFields([b.dataset.ok])));
    box().querySelectorAll("[data-h]").forEach((b) => (b.onclick = () => history(b.dataset.h)));
    const all = byId("metaAll"); if (all) all.onclick = () => confirmFields(review());
    if (canEdit()) { byId("metaSave").onclick = saveEdits; byId("metaDiscard").onclick = render; }
    flag(); sync();
  }

  function sync() {
    const c = changes(), n = Object.keys(c).length;
    box().querySelectorAll("[data-f]").forEach((e) => e.classList.toggle("edited", e.dataset.f in c));
    const foot = byId("metaFoot"); if (!foot) return;
    foot.hidden = !n; byId("metaCount").textContent = `${n} change${n === 1 ? "" : "s"}`;
    if (S && S.sheet) status(n ? "Unsaved specimen details" : "");
  }

  async function send(body, done) {
    if (M.busy || !M.spec) return; M.busy = true;
    const err = byId("metaErr"); if (err) err.textContent = "";
    try {
      const sp = await PV.api(`/specimens/${M.spec.id}/metadata`, { method: "PATCH", json: body });
      M.spec = sp; render(); applyToTool(); toast(done); status("");
    } catch (e) {
      const msg = e.status === 401 ? "Your sign-in has expired. Reload the page to sign in again; nothing was saved." : e.message || "Could not save.";
      if (err) err.textContent = msg; else toast(msg);
    }
    M.busy = false;
  }
  const saveEdits = () => { const c = changes(), n = Object.keys(c).length; if (n) send({ fields: c, reason: byId("metaReason").value.trim() || undefined }, `Saved ${n} change${n === 1 ? "" : "s"}`); };
  const confirmFields = (list) => { if (dirty()) return toast("Save or discard your changes first"); if (list.length) send({ confirm: list }, `Confirmed ${list.length} value${list.length === 1 ? "" : "s"}`); };

  async function history(f) {
    const el = box().querySelector(`[data-hist="${f}"]`);
    if (!el.hidden) { el.hidden = true; return; }
    el.hidden = false; el.textContent = "Loading…";
    try {
      const rows = (await PV.api(`/specimens/${M.spec.id}/metadata/history?field=${f}`)).filter((r) => r.old != null || r.author);
      el.innerHTML = rows.length ? rows.map((r) => `<div><b>${esc(str(r.new) || "(empty)")}</b>${str(r.old) !== str(r.new) ? ` <span>was ${esc(str(r.old) || "(empty)")}</span>` : " <span>confirmed</span>"}<br><span>${esc(r.author || r.source || "")} · ${when(r.at)}${r.reason ? ` · ${esc(r.reason)}` : ""}</span></div>`).join("") : "No changes yet.";
    } catch (e) { el.textContent = e.message || "Could not load the history."; }
  }

  /** names and labels shown elsewhere follow the saved values */
  function applyToTool() {
    const v = (f) => str(M.spec.metadata[f].value), ex = M.ex;
    ex.species = v("scientific_name") || "Unknown";
    buildMenu();
    if (S.sheet && S.sheet.id === ex.id) { Object.assign(S.sheet, { species: ex.species, institution: v("institution_code"), catalog: v("catalog_number"), state: v("state_province"), date: v("collection_date"), rights: v("licence"), record_url: v("record_url") }); sheetInfo(S.sheet); }
  }

  // ---------------------------------------------------------------- uploads
  const canUpload = () => !S.plain && canEdit();
  const pendingEntry = (x) => ({ id: "db" + x.id, specId: x.id, group: "Uploaded", challenge: "Uploaded", file_name: x.file_name, species: x.scientific_name || "Unknown", institution: x.institution_code || "", catalog: x.catalog_number || "",
    width: x.width, height: x.height, out_of_domain: false, pending: true, runs: {}, views: {}, files: {},
    why: "Uploaded specimen. The models haven't run on it yet, so there is no predicted mask or depth; you can draw lines and paint a mask by hand." });

  /** specimens uploaded through the tool join the list; they have no model results until the models are run on them */
  async function addUploaded() {
    if (S.plain) return [];
    const r = await PV.api("/specimens?limit=500");
    const known = new Set(S.meta.examples.map((x) => x.specId).filter(Boolean)), added = [];
    M.index = new Map(r.items.map((x) => [x.file_name, x.id]));
    for (const x of r.items) if (x.source === "upload" && !known.has(x.id)) { const e = pendingEntry(x); S.meta.examples.push(e); added.push(e); }
    return added;
  }

  let chosen = [];
  function setFiles(list) {
    chosen = [...list].filter((f) => /^image\//.test(f.type) || /\.(tiff?|jpe?g|png|jfif)$/i.test(f.name));
    byId("upPick").textContent = chosen.length ? `${chosen.length} image${chosen.length === 1 ? "" : "s"} selected` : "Choose images or drop them here";
    byId("upList").innerHTML = chosen.map((f, i) => `<div data-i="${i}"><span>${esc(f.name)}</span><em>${(f.size / 1e6).toFixed(1)} MB</em></div>`).join("");
    byId("upGo").disabled = !chosen.length;
  }
  async function openUpload() {
    byId("upErr").textContent = ""; byId("upForm").reset(); setFiles([]); byId("upNew").hidden = true; byId("upModal").hidden = false;
    const sel = byId("upSet"); sel.innerHTML = `<option value="">Uploaded (no set)</option>`;
    try { for (const p of await PV.api("/projects")) sel.insertAdjacentHTML("beforeend", `<option value="${esc(p.name)}">${esc(p.name)} (${p.n_specimens})</option>`); } catch {}
    sel.insertAdjacentHTML("beforeend", `<option value="__new">+ New set…</option>`);
  }
  const closeUpload = () => { if (!M.uploading) byId("upModal").hidden = true; };

  async function upload() {
    const set = byId("upSet").value === "__new" ? byId("upNew").value.trim() : byId("upSet").value;
    if (byId("upSet").value === "__new" && !set) { byId("upErr").textContent = "Enter a name for the new set."; return; }
    const details = {};
    for (const [id, f] of [["upName", "scientific_name"], ["upInst", "institution_code"], ["upColl", "collector"]]) { const v = byId(id).value.trim(); if (v) details[f] = v; }
    M.uploading = true; byId("upGo").disabled = byId("upCancel").disabled = true; byId("upErr").textContent = "";
    let failed = 0, firstNew = null, firstAny = null;
    for (let i = 0; i < chosen.length; i++) {
      const row = byId("upList").querySelector(`[data-i="${i}"]`), note = row.querySelector("em");
      note.textContent = "uploading…"; row.scrollIntoView({ block: "nearest" });
      try {
        const fd = new FormData(); fd.append("image", chosen[i], chosen[i].name);
        if (set) fd.append("project", set);
        if (Object.keys(details).length) fd.append("metadata", JSON.stringify(details));
        const r = await PV.api("/uploads", { method: "POST", body: fd });
        note.textContent = r.duplicate ? "already in the database" : "uploaded";
        firstAny ??= r.specimen_id; if (!r.duplicate) firstNew ??= r.specimen_id;
      } catch (e) { failed++; note.textContent = e.status === 401 ? "sign-in expired" : e.message || "failed"; note.classList.add("bad"); }
    }
    M.uploading = false; byId("upCancel").disabled = false;
    try { await addUploaded(); buildMenu(); } catch (e) { byId("upErr").textContent = `Uploaded, but the list could not refresh (${e.message}). Reload the page.`; return; }
    if (failed) { byId("upErr").textContent = `${failed} of ${chosen.length} could not be uploaded.`; byId("upGo").disabled = false; return; }
    byId("upModal").hidden = true; toast(`${chosen.length} image${chosen.length === 1 ? "" : "s"} done`);
    const k = S.meta.examples.findIndex((x) => x.specId === (firstNew ?? firstAny));
    if (k >= 0) openExample(k);
  }

  function bindUpload() {
    if (!byId("upModal")) return;
    byId("uploadBtn").onclick = openUpload;
    byId("upCancel").onclick = closeUpload;
    byId("upFiles").onchange = (e) => setFiles(e.target.files);
    byId("upSet").onchange = (e) => { byId("upNew").hidden = e.target.value !== "__new"; if (!byId("upNew").hidden) byId("upNew").focus(); };
    byId("upForm").onsubmit = (e) => { e.preventDefault(); if (chosen.length && !M.uploading) upload(); };
    byId("upModal").onkeydown = (e) => { if (e.key === "Escape") { e.stopPropagation(); closeUpload(); } };
    const d = byId("upDrop");
    for (const t of ["dragenter", "dragover"]) d.addEventListener(t, (e) => { e.preventDefault(); d.classList.add("over"); });
    for (const t of ["dragleave", "drop"]) d.addEventListener(t, (e) => { e.preventDefault(); d.classList.remove("over"); });
    d.addEventListener("drop", (e) => { if (e.dataTransfer?.files?.length) setFiles(e.dataTransfer.files); });
  }
  bindUpload();
  const showUploadButton = () => { byId("uploadBtn").hidden = !canUpload(); };

  root.Meta = { specimenId, show, dirty, addUploaded, showUploadButton, upload, setFiles, openUpload };
})(window);
