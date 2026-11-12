// PlantViz sign-in: Google account -> Specimetrics API token -> short-lived read access to the private site content.
// New accounts wait for approval by an admin. Nothing private is stored in this public site; slides and tool data
// live in private Azure storage and are fetched with a 1-hour signed link after sign-in.
"use strict";
(function () {
  const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
  const API = LOCAL ? "http://localhost:8000" : "https://specimetrics-api.bluemeadow-a9f76135.westus.azurecontainerapps.io";
  const CLIENT_ID = "743757012749-kmfdfv0822o4e2aj94hv9d0lioblkqm9.apps.googleusercontent.com";
  const KEY = "pv_auth", CKEY = "pv_content";
  const store = {
    get(k) { try { const v = JSON.parse(localStorage.getItem(k) || "null"); return v && v.exp > Date.now() + 60e3 ? v : null; } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
    del(k) { try { localStorage.removeItem(k); } catch {} },
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  let gisReady = null;
  function loadGis() {
    gisReady ??= new Promise((ok, fail) => {
      const s = document.createElement("script");
      s.src = "https://accounts.google.com/gsi/client"; s.async = true; s.onload = ok; s.onerror = () => fail(new Error("Could not load Google sign-in"));
      document.head.appendChild(s);
    });
    return gisReady;
  }

  // ---- staying signed in: renew the 1-hour token while someone is working; if it lapses anyway, sign in again in place
  const raw = () => { try { return JSON.parse(localStorage.getItem(KEY) || "null"); } catch { return null; } };
  let refreshing = null, lastActive = Date.now();
  for (const ev of ["pointerdown", "keydown", "wheel"]) addEventListener(ev, () => (lastActive = Date.now()), true);
  function refresh() {
    const a = raw(); if (!a || a.exp <= Date.now()) return Promise.resolve();
    refreshing ??= fetch(API + "/auth/refresh", { method: "POST", headers: { Authorization: `Bearer ${a.token}` } })
      .then((r) => (r.ok ? r.json() : null)).then((j) => { if (j) store.set(KEY, { token: j.access_token, exp: Date.now() + j.expires_in * 1000, user: j.user }); })
      .catch(() => {}).finally(() => { refreshing = null; });
    return refreshing;
  }
  setInterval(() => { const a = raw(); if (a && a.exp > Date.now() && a.exp - Date.now() < 20 * 60e3 && Date.now() - lastActive < 15 * 60e3) refresh(); }, 60e3);
  let reauthing = null;
  /** the sign-in card over the page; resolves once signed in again, rejects if the person cancels */
  function reauth() {
    reauthing ??= new Promise((ok, fail) => {
      const ov = document.createElement("div"); ov.id = "pvReauth";
      ov.innerHTML = `<div class="pvReauthBox"><div id="pvReauthGate"></div><button type="button" id="pvReauthCancel">Not now</button></div>`;
      document.body.appendChild(ov);
      const end = () => { ov.remove(); reauthing = null; };
      ov.querySelector("#pvReauthCancel").onclick = () => { end(); fail(Object.assign(new Error("Not signed in"), { status: 401 })); };
      signIn(ov.querySelector("#pvReauthGate"), { title: "Sign in again", what: "carry on: your work on screen is kept" }).then((a) => { end(); ok(a); });
    });
    return reauthing;
  }
  async function api(path, opts = {}) {
    let a = raw();
    if (a && a.exp > Date.now() && a.exp - Date.now() < 5 * 60e3) { await refresh(); a = raw(); }
    const headers = { ...(opts.headers || {}) };
    if (a && a.exp > Date.now()) headers.Authorization = `Bearer ${a.token}`;
    if (opts.json !== undefined) { headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(opts.json); }
    const r = await fetch(API + path, { ...opts, headers });
    if (r.status === 401 && !opts.noReauth && !opts.retried) { store.del(KEY); await reauth(); return api(path, { ...opts, retried: true }); }
    if (r.status === 401) { signOut(false); throw Object.assign(new Error("Signed out"), { status: 401 }); }
    if (!r.ok) { let d = ""; try { d = (await r.json()).detail; } catch {} throw Object.assign(new Error(d || `Error ${r.status}`), { status: r.status }); }
    return r.status === 204 ? null : r.json();
  }

  function signOut(reload = true) {
    store.del(KEY); store.del(CKEY);
    try { window.google?.accounts.id.disableAutoSelect(); } catch {}
    if (reload) location.reload();
  }

  const css = `
  .pv-auth{max-width:380px;margin:18vh auto 0;padding:28px;font:14px/1.5 Inter,system-ui,sans-serif;color:var(--fg,#eaeaea)}
  .pv-auth .k{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--dim,#888)}
  .pv-auth .k a{color:inherit;text-decoration:none}
  .pv-auth h1{font-weight:300;font-size:30px;margin:6px 0 10px;color:var(--fg,#fff)}
  .pv-auth p{color:var(--dim,#aaa);margin:0 0 18px}
  .pv-auth .err{color:var(--err,#ff8a80);min-height:1.4em;margin-top:12px}
  .pv-auth button{background:var(--raise,#222);color:var(--fg,#eee);border:1px solid var(--faint,#444);border-radius:6px;padding:7px 14px;font:inherit;cursor:pointer;margin-right:8px}
  .pv-auth button:hover{border-color:#888}
  #pvReauth{position:fixed;inset:0;z-index:40;display:grid;place-items:center;background:rgba(0,0,0,.6);padding:16px}
  .pvReauthBox{background:var(--panel,#0b0b0b);border:1px solid var(--faint,#333);padding:0 0 18px;text-align:center;max-width:440px;width:100%}
  .pvReauthBox .pv-auth{margin:0 auto;text-align:left}
  .pv-auth textarea{width:100%;box-sizing:border-box;background:var(--field,#111);color:var(--fg,#ddd);border:1px solid var(--faint,#333);border-radius:6px;padding:8px;font:inherit;margin:4px 0 12px}`;

  /** Show the sign-in card in `el` until the user is an approved (active) account. Resolves {token, user}. */
  function signIn(el, { title = "PlantViz", what = "this page" } = {}) {
    if (!document.getElementById("pv-auth-css")) {
      const st = document.createElement("style"); st.id = "pv-auth-css"; st.textContent = css; document.head.appendChild(st);
    }
    return new Promise((resolve) => {
      const done = (a) => { el.innerHTML = ""; el.hidden = true; resolve(a); };
      const card = (inner) => { el.hidden = false; el.innerHTML = `<div class="pv-auth"><div class="k"><a href="../">PlantViz</a></div><h1>${esc(title)}</h1>${inner}<div class="err" id="pvErr"></div></div>`; };
      const err = (m) => { const e = el.querySelector("#pvErr"); if (e) e.textContent = m; };

      async function checkUser() {
        const a = store.get(KEY);
        if (!a) return showButton();
        try {
          const u = await api("/me", { noReauth: true });
          a.user = u; store.set(KEY, a);
          if (u.status === "active") return done(a);
          showWaiting(u);
        } catch (e) { if (e.status === 401) showButton(); else card(`<p>Could not reach the server.</p><button id="pvRetry">Try again</button>`), (el.querySelector("#pvRetry").onclick = checkUser), err(e.message); }
      }

      function showWaiting(u) {
        const msg = u.status === "pending"
          ? `Signed in as <b>${esc(u.email)}</b>. Your account is waiting for approval by the PlantViz admin. You can come back once you are approved.`
          : `Signed in as <b>${esc(u.email)}</b>. This account is ${esc(u.status)}. Contact the PlantViz admin.`;
        card(`<p>${msg}</p><button id="pvAgain">Check again</button><button id="pvOut">Sign out</button>`);
        el.querySelector("#pvAgain").onclick = checkUser;
        el.querySelector("#pvOut").onclick = () => signOut();
      }

      async function onCredential(resp) {
        err("");
        try {
          const note = el.querySelector("#pvNote")?.value?.trim() || undefined;
          const r = await fetch(API + "/auth/google", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ credential: resp.credential, note }) });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(j.detail || `Sign-in failed (${r.status})`);
          store.set(KEY, { token: j.access_token, exp: Date.now() + j.expires_in * 1000, user: j.user });
          checkUser();
        } catch (e) { err(e.message); }
      }

      async function showButton() {
        card(`<p>Sign in with your Google account to open ${esc(what)}. New accounts are approved by the PlantViz admin.</p>
          <div class="k">Note for the admin (new accounts, optional)</div><textarea id="pvNote" rows="2" maxlength="300" placeholder="Name, institution, why you would like access"></textarea>
          <div id="pvBtn"></div>`);
        try {
          await loadGis();
          google.accounts.id.initialize({ client_id: CLIENT_ID, callback: onCredential, auto_select: true, itp_support: true });
          google.accounts.id.renderButton(el.querySelector("#pvBtn"), { theme: "filled_black", size: "large", text: "signin_with", shape: "pill" });
        } catch (e) { err(e.message); }
      }

      checkUser();
    });
  }

  /** {base, query}: read access to private site content; url(path) builds a signed URL. Cached until it expires. */
  async function content() {
    let c = store.get(CKEY);
    if (!c) { const j = await api("/content/access"); c = { base: j.base, query: j.query, exp: Date.now() + j.expires_in * 1000 }; store.set(CKEY, c); }
    return { ...c, url: (p) => `${c.base}/${p.replace(/^\/+/, "")}?${c.query}` };
  }

  window.PV = { API, api, reauth, refresh, signIn, signOut, content, user: () => raw()?.user || null, esc };
})();
