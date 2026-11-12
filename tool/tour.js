// Specimetrics — guided tutorial. Opens once per browser, can be skipped at any step and reopened with the ? button.
// Uses tool.js globals (showTab, setTool, S) at call time; tool.js loads after this file.
"use strict";
(function (root) {
  const KEY = "pv_tour";
  // try: a small task on the highlighted part; done(): has the person done it? (checked while the step is open)
  // The page stays usable during the tour: anything tried is a normal edit, Undo takes it back and nothing is saved without Save.
  const changedSince = (k, now) => (st) => st[k] !== undefined && now() !== st[k];
  const STEPS = [
    { title: "Welcome to Specimetrics", text: "Here you correct what the model found on each herbarium sheet, measure the plant, and save your work. The tour is hands-on: most steps ask you to try the highlighted control, and turn green once you have. Anything you try is a normal edit, Ctrl Z undoes it, and nothing is saved until you press Save. Skip whenever you like; ? reopens it." },
    { at: ["#pickBtn", "#prev", "#next"], title: "Pick a specimen", text: "Open the list to choose a specimen, or step through with the arrows (← and → on the keyboard). Sets fold open and closed with a click on their name; the search box finds a name, institution or catalog number, and the stage menu shows only specimens at one stage. The coloured dot is each specimen's stage.", try: "Open the list, then close it again.", watch: () => !document.getElementById("pickPanel").hidden, done: (st) => st.seen },
    { at: ["#stageChip"], title: "Where this specimen is", text: "Not started, Annotating, Annotated (an annotator marked it complete), In evaluation, Evaluated. The chip shows the furthest anyone has got; click it for the Status tab." },
    { at: ["#uploadBtn"], only: () => document.getElementById("uploadBtn").offsetWidth > 0, title: "Add your own images", text: "Choose or drop one or many images, pick a set or start a new one, and optionally add a name. They appear straight away under Uploaded, with an empty mask to fill in. The models run on them later." },
    { at: ["#views"], title: "Look at it in different ways", text: "Photo is the sheet. Plant only hides everything but the mask. Mask shows what counts as plant: the model's first guess, which you can correct. Depth shows what lies on top of what. P cycles through them.", try: "Click Mask, then Photo.", check: (st) => { if (S.view === "mask") st.mask = true; return st.mask && S.view === "photo"; } },
    { at: ["#overlay"], title: "Show or hide your lines", text: "Lines On shows everything you've drawn: blades, culms, widths, spines, contours. Off clears the view so you can see the plant underneath; the selected line still shows and lines can be picked from the list. O switches between them.", try: "Press O twice (or click Off, then On).", check: (st) => { if (S.overlay === "off") st.off = true; return st.off && S.overlay !== "off"; } },
    { at: ["#fitBtn"], tool: "select", title: "Moving around the sheet", text: "Scroll to zoom at the cursor. Drag to pan, or hold Space and drag while a tool is active. Fit (F) shows the whole sheet and 0 goes to 100 %. Tab hides all the panels for more room.", try: "Zoom in with the scroll wheel, then press F.", start: () => ({ s: V.s }), check: (st) => { if (Math.abs(V.s - st.s) > 0.05) st.zoomed = true; return !!st.zoomed; } },
    { at: ["#magicPair"], tool: "wand_add", title: "Magic select: the fastest way to fix the mask", text: "Click a part of the plant and every connected area of similar colour is added (+). Click a label or stain with − to remove it. Hold Alt to swap between them. The sign on the cursor shows which one you're about to do.", try: "Click once on the plant in the image.", start: () => ({ r: S.rev }), check: (st) => S.rev !== st.r },
    { at: ["#toolOpts"], tool: "wand_add", title: "Tolerance with [ and ]", text: "] raises the tolerance, so a click picks up more colours; [ lowers it, so it picks up fewer. Your last click updates as you change it, so you can dial it in while you watch. Turn off Connected to select that colour everywhere on the sheet.", try: "Press ] three times, then [ once, and watch the number.", start: () => ({ t: S.tol }), check: (st) => S.tol !== st.t },
    { at: ["#quickPair", "#toolOpts"], tool: "quick_add", title: "Quick selection", text: "Paint over part of the plant and the selection grows into similar colour around your stroke. + adds to the active part, − removes (Q twice). [ and ] make the round brush smaller or larger; Tolerance sets how far the colour may differ.", try: "Press ] to make the brush bigger, then paint a short stroke over a leaf.", start: () => ({ b: S.brushPx, r: S.rev }), check: (st) => S.brushPx !== st.b || S.rev !== st.r },
    { at: ["#brushPair", "#toolOpts"], tool: "brush_add", title: "Brush for the fine detail", text: "Paint plant in with + or wipe it out with −. [ makes the brush smaller and ] larger: the circle on the cursor shows its size. Hold Alt to swap add and erase. The mask shows over the photo while a mask tool is active.", try: "Press [ and ] and watch the circle on the image change.", start: () => ({ b: S.brushPx }), check: (st) => S.brushPx !== st.b },
    { at: ["#panel"], tab: "mask", tool: "wand_add", title: "Mask parts", text: "The mask can be split into parts, each with a class (leaf, stem, flower, fruit, root…) and its own colour. Magic and Brush paint into the active part, marked with a dot and shown in the bottom bar. Click a row to make it active, click its colour dot to pick any colour, change its class (choose Other to give it your own name), hide it, or remove it. + New part starts another." },
    { at: ['[data-tool="select"]'], tool: "select", tab: "mask", title: "Select an area of the mask", text: "With Edit, click an area of the mask to select it; Shift+click adds more areas. A small bar appears beside it: make it a new part of a chosen class, move it into the active part, select the whole part, or remove it from the mask (Delete)." },
    { at: ["#snapBtn"], tool: "select", title: "Snap does the careful clicking", text: "With Snap on (S), lines follow the plant in the mask and widths take a single click. It works best once the mask is right. Hold Shift to place one click exactly by hand, or turn Snap off.", try: "Press S twice.", start: () => ({ n: 0, v: S.snap }), check: (st) => { if (S.snap !== st.v) { st.n++; st.v = S.snap; } return st.n >= 2; } },
    { at: ['[data-tool="blade"]', '[data-tool="culm"]'], title: "Trace blades and culms", text: "Blade (B) runs from the ligule to the tip, Culm (C) from the base to the inflorescence. Click the start and the end and the line follows the organ. If it strays, add a click where it should go. Enter or double-click finishes, Backspace removes the last stretch, Esc cancels.", try: "Pick Blade, click the base and the tip of a leaf, then press Enter.", start: () => ({ n: S.objects.length }), check: (st) => S.objects.length > st.n },
    { at: ["#panel"], tab: "work", title: "Describe what you drew", text: "Select a blade or culm and its row in this list shows buttons for its condition: Intact, Broken, Folded or Rolled for blades; Base, Truncated or Folded for culms. Broken blades are left out of the blade length. Each row also has Edit and Delete buttons when you point at it." },
    { at: ['[data-tool="blade_width"]', '[data-tool="culm_width"]'], title: "Measure widths", text: "Width (W) and Diam. (D): one click on a blade or culm measures straight across it and links to that organ. Where the plant is unclear, place both edges by hand with Shift+click." },
    { at: ['[data-tool="spine"]'], title: "Spine: the smart annotator", text: "Spine (T) works on any organ, not just grasses. Click along it and its midline traces itself, with widths measured across it. Enter to finish." },
    { at: ["#panel"], tab: "work", title: "Fine-tune a spine", text: "Select a spine and its controls appear here and in the bar beside it. − and + spread more or fewer width markers evenly. In the bar, Add width places a marker where you click on the spine; click a marker's end to select it (it turns yellow) and Delete width removes it. Drag a round handle to set a width by hand. Click a vertex and press K to mark a fold; red rings are suggested folds, which a click accepts. R shows the ribbon view." },
    { at: ['[data-tool="contour"]'], title: "Contour", text: "Contour (L): click points or drag freehand around a shape, then press Enter or double-click to close it and see its area." },
    { at: ['[data-tool="select"]'], tool: "select", title: "Edit what you've placed", text: "Edit (V): click a line to select it and drag its square handles to move points. A bar appears beside the selected line: switch it between blade and culm (or blade and culm width), add a point (or double-click the line), delete the point you clicked, extend the line from its end or its start, or delete the line. Esc deselects." },
    { at: ["#undoBtn", "#saveBtn"], tool: "select", title: "Undo and save", text: "Undo (Ctrl Z) steps back. Save (Ctrl S) stores your lines, mask and notes under your name in the database, where the team can see them; it only sends what changed. Demo sheets save in this browser. The button stays dark while you have unsaved changes; meanwhile a draft is kept in this browser, so if the page closes before you save, the tool offers it back next time." },
    { at: ["#panel"], tab: "status", title: "Status, difficulty and notes", text: "Rate how hard the specimen is (Easy, Moderate, Difficult, Not possible) and think aloud in the notes: what you see, what's hard, what you decided. They save with Save. When you're finished, Mark complete tells evaluators it's ready; saving changes later reopens it. Evaluators write their own notes here, score the version, and Accept it or ask for changes.", try: "Pick a difficulty.", start: () => ({ d: S.notes?.difficulty }), check: (st) => (S.notes?.difficulty || null) !== (st.d || null) },
    { at: ["#panel"], tab: "work", title: "Measure", text: "Everything you draw is summarised here with its value. Click a trait, or press 1 to 6, to highlight it on the sheet and see its spread. Click a row to jump to that line." },
    { at: ["#panel"], tab: "spec", title: "Specimen details", text: "Correct the name, collector, locality and more, add a reason, and Save. Yellow “check” tags mark values filled in automatically that need a person to look at them. Evaluators can Confirm a value, and History shows who changed what." },
    { at: ["#panel"], tab: "vers", title: "Versions", text: "Each person's latest saved work is listed here, and every earlier save is kept in the database history. Click one to view it and edit your own copy. Evaluators compare two versions as A and B. Export downloads the saved work as a file, and Reset discards yours for this sheet." },
    { at: ["#models"], tab: "work", title: "Three models", text: "Each one made its own mask for this sheet. Switch between them here, or press M, and start from whichever fits the plant best." },
    { at: ["#panel"], tab: "model", title: "About the model", text: "This tab shows how the selected model was trained, how accurate it was, and how long it took on this sheet." },
    { at: ["#adminLink"], tab: "work", only: () => document.getElementById("adminLink").offsetWidth > 0, title: "Approving people", text: "As an admin, you open Admin to approve new accounts, set each person's role, and see what they've done." },
    { at: ["#profileBtn", "#lockBtn"], tab: "work", title: "Your account", text: "Click your name to edit your display name, role and expertise. Your work is saved under that name. Sign out is at the far right." },
    { at: ["#tourBtn", "#themeBtn"], title: "You're ready", text: "Reopen this tour with ?. The sun or moon switches between dark and white. Hover over any tool for a reminder, and press H for the full list of shortcuts." },
  ];
  const $ = (id) => document.getElementById(id);
  let i = 0, toolBefore = null, list = STEPS, st = {}, timer = 0;
  const isOpen = () => !$("tour").hidden;
  const remember = () => { try { localStorage.setItem(KEY, "done"); } catch {} };

  function boxFor(step) {
    const rects = (step.at || []).map((s) => document.querySelector(s)).filter(Boolean).map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0);
    if (!rects.length) return null;
    const pad = 4, left = Math.min(...rects.map((r) => r.left)) - pad, top = Math.min(...rects.map((r) => r.top)) - pad;
    return { left, top, width: Math.max(...rects.map((r) => r.right)) + pad - left, height: Math.max(...rects.map((r) => r.bottom)) + pad - top };
  }

  function place() {
    if (!isOpen()) return;
    const hole = $("tourHole"), card = $("tourCard"), b = boxFor(list[i]), gap = 14, W = innerWidth, H = innerHeight, w = card.offsetWidth, h = card.offsetHeight;
    hole.hidden = !b;
    $("tour").classList.toggle("plain", !b);
    if (!b) { card.style.left = `${(W - w) / 2}px`; card.style.top = `${(H - h) / 2}px`; return; }
    Object.assign(hole.style, { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px` });
    // beside the target when it fits, otherwise above or below it
    const spots = [[b.left + b.width + gap, b.top], [b.left - w - gap, b.top], [b.left, b.top + b.height + gap], [b.left, b.top - h - gap]];
    const fits = ([x, y]) => x >= 8 && x + w <= W - 8 && y >= -H && y <= H;
    const vertical = (s, k) => k < 2 || (s[1] >= 8 && s[1] + h <= H - 8);
    const [x, y] = spots.find((s, k) => fits(s) && vertical(s, k)) || [(W - w) / 2, (H - h) / 2];
    card.style.left = `${Math.max(8, Math.min(W - w - 8, x))}px`;
    card.style.top = `${Math.max(8, Math.min(H - h - 8, y))}px`;
  }

  function render() {
    const s = list[i];
    if (s.tab) showTab(s.tab);
    if (s.tool) setTool(s.tool);
    $("tourNum").textContent = `${i + 1} of ${list.length}`;
    $("tourTitle").textContent = s.title;
    $("tourText").textContent = s.text;
    st = s.start ? s.start() : {}; $("tourTry").hidden = !s.try; $("tourTry").classList.remove("ok"); $("tourTryText").textContent = s.try || "";
    $("tour").classList.toggle("live", !!s.at);   // with a target the page stays usable: try the highlighted control
    $("tourBack").disabled = i === 0;
    $("tourNext").textContent = i === list.length - 1 ? "Finish" : "Next";
    place(); requestAnimationFrame(place);
  }
  /** a step's small task: watched while it is open; a tick when done (Next always works) */
  function poll() {
    if (!isOpen()) return; const s = list[i]; if (!s.try) return;
    if (s.watch && s.watch()) st.seen = true;
    let ok = false; try { ok = s.check ? !!s.check(st) : s.done ? !!s.done(st) : false; } catch {}
    if (ok && !$("tourTry").classList.contains("ok")) { $("tourTry").classList.add("ok"); $("tourTryText").textContent = "Done. Next when you're ready."; }
    place();
  }
  function go(d) { const n = i + d; if (n < 0) return; if (n >= list.length) return close(); i = n; render(); }
  function close() { $("tour").hidden = true; clearInterval(timer); remember(); showTab("work"); if (toolBefore) setTool(toolBefore); }
  function open() { if (isOpen()) return; list = STEPS.filter((x) => !x.only || x.only()); toolBefore = S.tool; i = 0; $("tour").hidden = false; render(); $("tourNext").focus(); clearInterval(timer); timer = setInterval(poll, 250); }

  $("tourNext").onclick = () => go(1);
  $("tourBack").onclick = () => go(-1);
  $("tourSkip").onclick = close;
  $("tourBtn").onclick = open;
  addEventListener("resize", place);
  addEventListener("keydown", (e) => {
    if (!isOpen() || ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement?.tagName)) return;
    if (e.key === "Escape") { e.stopPropagation(); close(); } else if (e.key === "ArrowRight") { e.stopPropagation(); e.preventDefault(); go(1); } else if (e.key === "ArrowLeft") { e.stopPropagation(); e.preventDefault(); go(-1); }
    else if (e.key === "Enter" && document.activeElement && $("tourCard").contains(document.activeElement)) { /* the focused tour button */ }
    else if (document.activeElement && $("tourCard").contains(document.activeElement)) document.activeElement.blur();   // shortcuts go to the tool, not the tour buttons
  }, true);

  /** the first visit in this browser (not during a slide demo) */
  function maybeOpen() {
    let seen = false; try { seen = localStorage.getItem(KEY) === "done"; } catch {}
    if (!seen && !new URLSearchParams(location.search).has("from")) open();
  }
  root.Tour = { open, close, maybeOpen, isOpen, count: () => list.length };
})(window);
