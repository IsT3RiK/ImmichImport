"use strict";

/* ============================================================================
   Assistant de première configuration (vanilla JS, hors-ligne).
   --------------------------------------------------------------------------
   Hypothèse : la personne qui lance le conteneur ne connaît ni Docker ni les
   variables d'environnement. Elle ne doit jamais avoir à deviner une adresse ni
   chercher où se trouve une clé API.

   Trois principes (repris d'ImmichDupFinder) :
     - on propose avant de demander (détection réseau automatique) ;
     - on vérifie avant d'enregistrer (rien n'est sauvé tant que la connexion
       n'a pas réellement fonctionné) ;
     - chaque erreur est expliquée, avec ce qu'il faut faire ensuite.

   Rendu entièrement piloté ici (aucun markup dans index.html) : à chaque étape
   ou changement de langue, on re-rend tout le contenu à partir de l'état `S`.
   ========================================================================== */

(function () {
  const t = (k, p) => I18N.t(k, p);
  const STEP_KEYS = [
    "wizard.step.start", "wizard.step.server", "wizard.step.key",
    "wizard.step.album", "wizard.step.ready",
  ];
  const ALBUM_MODES = ["FOLDER", "PATH", "NONE"];

  const S = {
    step: 0,
    serverUrl: "", serverVersion: null,
    discovery: null, discovering: false,
    showManual: false, manualUrl: "", manualError: null, probing: false,
    scanCidr: "", scanning: false,
    apiKey: "", check: null, verifying: false,
    albumMode: "FOLDER",
    finishing: false, finishError: null,
    onDone: null, onCancel: null,
  };

  let root = null;
  let unsub = null;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* --- inline icons (currentColor, no external asset) ------------------- */
  const IC = {
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    server: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>',
    key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3"/></svg>',
    ext: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
    wifi: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>',
    left: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>',
    right: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>',
    globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>',
  };
  const spinner = '<span class="wiz-spin"></span>';

  /* --- lifecycle ------------------------------------------------------- */
  function open(opts) {
    opts = opts || {};
    S.onDone = opts.onDone || null;
    S.onCancel = opts.onCancel || null;
    S.step = 0;
    S.serverUrl = (opts.initial && opts.initial.url) || "";
    S.manualUrl = S.serverUrl;
    S.albumMode = (opts.initial && opts.initial.albumMode) || "FOLDER";
    S.apiKey = ""; S.check = null; S.discovery = null; S.serverVersion = null;
    S.showManual = false; S.manualError = null; S.finishError = null;
    if (!root) {
      root = document.createElement("div");
      root.className = "wiz-overlay";
      document.body.appendChild(root);
    }
    document.body.classList.add("wiz-open");
    unsub = I18N.onChange(render);
    document.addEventListener("keydown", onKey);
    render();
  }

  function close() {
    if (unsub) { unsub(); unsub = null; }
    document.removeEventListener("keydown", onKey);
    document.body.classList.remove("wiz-open");
    if (root) { root.remove(); root = null; }
  }

  function onKey(e) {
    if (e.key === "Escape" && S.onCancel) S.onCancel();
  }

  /* --- render ---------------------------------------------------------- */
  function render() {
    if (!root) return;
    root.innerHTML =
      `<div class="wiz-modal" role="dialog" aria-modal="true" aria-labelledby="wiz-title">
        <header class="wiz-head">
          <div class="wiz-brand"><span class="wiz-brand-ic">${IC.key}</span>
            <h1 id="wiz-title" class="wiz-title">${esc(t("wizard.header"))}</h1></div>
          <label class="wiz-lang" title="${esc(t("lang.label"))}">
            <span class="wiz-lang-ic">${IC.globe}</span>
            <select id="wiz-lang-sel" aria-label="${esc(t("lang.label"))}">${langOptions()}</select>
          </label>
          <div class="wiz-strip">${filmStrip()}</div>
        </header>
        <div class="wiz-body">${stepBody()}</div>
        <footer class="wiz-foot">${footer()}</footer>
      </div>`;
    bind();
    // Kick off network discovery the moment we land on the server step.
    if (S.step === 1 && !S.discovery && !S.discovering) doDiscover(null);
  }

  function langOptions() {
    return I18N.LANGS.map((l) =>
      `<option value="${l.code}"${l.code === I18N.lang ? " selected" : ""}>${l.flag} ${esc(l.label)}</option>`
    ).join("");
  }

  function filmStrip() {
    return `<ol class="wiz-film" aria-label="${esc(t("wizard.progressAria"))}">` +
      STEP_KEYS.map((key, i) => {
        const cls = i < S.step ? "done" : i === S.step ? "current" : "todo";
        const label = i === S.step
          ? `<span class="wiz-film-label">${esc(t(key))}</span>` : "";
        return `<li class="wiz-film-item"><span class="wiz-film-dot ${cls}"${i === S.step ? ' aria-current="step"' : ""}></span>${label}</li>`;
      }).join("") + `</ol>`;
  }

  /* --- step bodies ----------------------------------------------------- */
  function stepBody() {
    switch (S.step) {
      case 0: return stepStart();
      case 1: return stepServer();
      case 2: return stepKey();
      case 3: return stepAlbum();
      case 4: return stepReady();
      default: return "";
    }
  }

  function stepStart() {
    return `<div class="wiz-step">
      <h2 class="wiz-h2">${esc(t("wizard.start.title"))}</h2>
      <p class="wiz-lead">${esc(t("wizard.start.intro"))}</p>
      <ul class="wiz-bullets">
        <li><span class="wiz-bic accent">${IC.server}</span>${esc(t("wizard.start.b1"))}</li>
        <li><span class="wiz-bic accent">${IC.key}</span>${esc(t("wizard.start.b2"))}</li>
        <li><span class="wiz-bic keep">${IC.check}</span>${esc(t("wizard.start.b3"))}</li>
      </ul>
    </div>`;
  }

  function stepServer() {
    let html = `<div class="wiz-step">
      <h2 class="wiz-h2">${esc(t("wizard.server.title"))}</h2>
      <p class="wiz-sub">${esc(t("wizard.server.subtitle"))}</p>`;

    if (S.discovering) {
      html += `<p class="wiz-info">${spinner}${esc(t("wizard.server.searching"))}</p>`;
    }

    const cands = S.discovery && S.discovery.candidates || [];
    if (cands.length) {
      html += `<div class="wiz-label">${esc(t("wizard.server.found", { n: cands.length }))}</div>
        <div class="wiz-cards">` +
        cands.map((c) => {
          const on = S.serverUrl === c.url;
          return `<button type="button" class="wiz-card${on ? " on" : ""}" data-pick="${esc(c.url)}" data-ver="${esc(c.version || "")}" aria-pressed="${on}">
            <span class="wiz-card-ic">${IC.check}</span>
            <span class="wiz-card-main"><span class="wiz-card-url">${esc(c.url)}</span>
            <span class="wiz-card-sub">${esc(c.source)}${c.version ? " · Immich " + esc(c.version) : ""}</span></span>
          </button>`;
        }).join("") + `</div>`;
    } else if (S.discovery && !S.discovering) {
      html += `<p class="wiz-warn">${IC.alert}${esc(t("wizard.server.noneFound"))}</p>`;
    }

    if (!S.discovering) {
      html += `<div class="wiz-row-btns">
        <button type="button" class="wiz-btn sm" id="wiz-rediscover">${IC.refresh}${esc(t("wizard.server.relaunch"))}</button>
        <button type="button" class="wiz-btn sm" id="wiz-togglemanual">${IC.search}${esc(t("wizard.server.manual"))}</button>
      </div>`;
    }

    if (S.showManual) {
      const subnets = (S.discovery && S.discovery.subnets) || [];
      html += `<div class="wiz-panel">
        <label class="wiz-flabel" for="wiz-url">${esc(t("wizard.server.addr"))}</label>
        <div class="wiz-inline">
          <input class="wiz-input" id="wiz-url" type="text" value="${esc(S.manualUrl)}" placeholder="${esc(t("wizard.server.addrPlaceholder"))}" autocomplete="off" spellcheck="false" />
          <button type="button" class="wiz-btn outline" id="wiz-probe"${S.probing || !S.manualUrl.trim() ? " disabled" : ""}>${S.probing ? spinner : ""}${esc(t("wizard.server.test"))}</button>
        </div>
        <p class="wiz-hint">${esc(t("wizard.server.addrHint"))}</p>
        ${S.manualError ? `<p class="wiz-err">${esc(S.manualError)}</p>` : ""}
        ${subnets.length ? `<label class="wiz-flabel mt" for="wiz-cidr">${esc(t("wizard.server.scanLabel"))}</label>
        <div class="wiz-inline">
          <select class="wiz-input" id="wiz-cidr">
            <option value="">${esc(t("wizard.server.scanPlaceholder"))}</option>
            ${subnets.map((s) => `<option value="${esc(s.cidr)}"${s.cidr === S.scanCidr ? " selected" : ""}>${esc(s.cidr)} · ${esc(s.label)}${s.detected ? " · " + esc(t("wizard.server.detected")) : ""}</option>`).join("")}
          </select>
          <button type="button" class="wiz-btn outline" id="wiz-scan"${S.scanning || !S.scanCidr ? " disabled" : ""}>${S.scanning ? spinner : IC.wifi}${esc(t("wizard.server.scan"))}</button>
        </div>
        <p class="wiz-hint">${esc(t("wizard.server.scanHint"))}</p>` : ""}
      </div>`;
    }

    if (S.serverUrl) {
      html += `<p class="wiz-kept"><span class="wiz-dot-keep"></span>${esc(t("wizard.server.kept"))} <span class="wiz-mono">${esc(S.serverUrl)}</span>${S.serverVersion ? " · Immich " + esc(S.serverVersion) : ""}</p>`;
    }
    return html + `</div>`;
  }

  function stepKey() {
    const apiKeyLink = S.serverUrl
      ? S.serverUrl.replace(/\/+$/, "") + "/user-settings?isOpen=api-keys" : "#";
    let html = `<div class="wiz-step">
      <h2 class="wiz-h2">${esc(t("wizard.key.title"))}</h2>
      <p class="wiz-sub">${esc(t("wizard.key.subtitle"))}</p>
      <ol class="wiz-steps">
        <li><span class="wiz-num">01</span><span>${esc(t("wizard.key.s1"))}</span></li>
        <li><span class="wiz-num">02</span><span>${esc(t("wizard.key.s2"))}</span></li>
        <li><span class="wiz-num">03</span><span>${esc(t("wizard.key.s3"))}</span></li>
      </ol>
      <a class="wiz-btn accent" href="${esc(apiKeyLink)}" target="_blank" rel="noopener noreferrer">${IC.ext}${esc(t("wizard.key.open"))}</a>
      <p class="wiz-hint">${esc(t("wizard.key.openHint"))}</p>
      <label class="wiz-flabel mt" for="wiz-key">${esc(t("wizard.key.paste"))}</label>
      <div class="wiz-inline">
        <input class="wiz-input" id="wiz-key" type="password" value="${esc(S.apiKey)}" placeholder="${esc(t("wizard.key.pastePlaceholder"))}" autocomplete="off" spellcheck="false" />
        <button type="button" class="wiz-btn primary" id="wiz-verify"${S.verifying || !S.apiKey.trim() ? " disabled" : ""}>${S.verifying ? spinner : ""}${esc(t("wizard.key.verify"))}</button>
      </div>`;

    if (S.check) {
      const ok = S.check.ok;
      html += `<div class="wiz-check ${ok ? "ok" : "bad"}">`;
      if (ok) {
        const who = S.check.user && S.check.user.email
          ? t("wizard.key.connectedAs", { email: S.check.user.email })
          : t("wizard.key.connected");
        html += `<p class="wiz-check-head"><span class="wiz-dot-keep"></span>${esc(who)}${S.check.version ? " · Immich " + esc(S.check.version) : ""}</p>`;
      } else {
        html += `<p class="wiz-check-head bad">${IC.x}${esc(checkError(S.check.error))}</p>`;
      }
      html += `<ul class="wiz-perms">
        ${permRow(S.check.permissions.account, t("wizard.key.permAccount"))}
        ${permRow(S.check.permissions.albums, t("wizard.key.permAlbums"))}
      </ul></div>`;
    }
    return html + `</div>`;
  }

  function permRow(state, label) {
    const ic = state === "ok" ? `<span class="wiz-perm-ic ok">${IC.check}</span>`
      : state === "missing" ? `<span class="wiz-perm-ic bad">${IC.x}</span>`
        : `<span class="wiz-perm-ic warn">${IC.alert}</span>`;
    const tag = state === "ok" ? t("wizard.key.granted")
      : state === "missing" ? t("wizard.key.missing") : t("wizard.key.unknown");
    return `<li>${ic}<span class="wiz-perm-lbl">${esc(label)}</span><span class="wiz-perm-tag ${state}">${esc(tag)}</span></li>`;
  }

  function checkError(err) {
    if (!err) return t("wizard.key.errUnreachable");
    if (err.code === "keyRejected") return t("wizard.key.errKeyRejected");
    if (err.code === "httpStatus") return t("wizard.key.errHttp", { detail: err.detail });
    return t("wizard.key.errUnreachable");
  }

  function stepAlbum() {
    return `<div class="wiz-step">
      <h2 class="wiz-h2">${esc(t("wizard.album.title"))}</h2>
      <p class="wiz-sub">${esc(t("wizard.album.subtitle"))}</p>
      <div class="wiz-cards">` +
      ALBUM_MODES.map((m) => {
        const on = S.albumMode === m;
        const key = m.toLowerCase();
        const rec = m === "FOLDER"
          ? `<span class="wiz-tag">${esc(t("wizard.album.recommended"))}</span>` : "";
        return `<button type="button" class="wiz-card${on ? " on" : ""}" data-album="${m}" aria-pressed="${on}">
          <span class="wiz-radio${on ? " on" : ""}"></span>
          <span class="wiz-card-main"><span class="wiz-card-title">${esc(t("wizard.album." + key + ".title"))}${rec}</span>
          <span class="wiz-card-sub">${esc(t("wizard.album." + key + ".detail"))}</span></span>
        </button>`;
      }).join("") + `</div></div>`;
  }

  function stepReady() {
    const albumLabel = t("wizard.album." + S.albumMode.toLowerCase() + ".title");
    return `<div class="wiz-step">
      <h2 class="wiz-h2">${esc(t("wizard.ready.title"))}</h2>
      <dl class="wiz-recap">
        <div><dt>${esc(t("wizard.ready.server"))}</dt><dd class="wiz-mono">${esc(S.serverUrl)}${S.serverVersion ? " · " + esc(S.serverVersion) : ""}</dd></div>
        <div><dt>${esc(t("wizard.ready.account"))}</dt><dd class="wiz-mono">${esc((S.check && S.check.user && S.check.user.email) || "—")}</dd></div>
        <div><dt>${esc(t("wizard.ready.albums"))}</dt><dd>${esc(albumLabel)}</dd></div>
      </dl>
      <p class="wiz-info">${IC.check}${esc(t("wizard.ready.note"))}</p>
      ${S.finishError ? `<p class="wiz-err">${esc(t("wizard.ready.failed", { error: S.finishError }))}</p>` : ""}
    </div>`;
  }

  /* --- footer / navigation --------------------------------------------- */
  function canContinue() {
    if (S.step === 1) return S.serverUrl.length > 0;
    if (S.step === 2) return !!(S.check && S.check.ok);
    return true;
  }

  function footer() {
    let left = S.onCancel
      ? `<button type="button" class="wiz-link" id="wiz-cancel">${esc(t("wizard.cancel"))}</button>` : "";
    let right = "";
    if (S.step > 0) {
      right += `<button type="button" class="wiz-btn" id="wiz-back">${IC.left}${esc(t("wizard.back"))}</button>`;
    }
    if (S.step < 4) {
      const label = S.step === 0 ? t("wizard.start.cta") : t("wizard.continue");
      right += `<button type="button" class="wiz-btn primary lg" id="wiz-next"${canContinue() ? "" : " disabled"}>${esc(label)}${IC.right}</button>`;
    } else {
      right += `<button type="button" class="wiz-btn primary lg" id="wiz-finish"${S.finishing ? " disabled" : ""}>${S.finishing ? spinner : IC.check}${esc(S.finishing ? t("wizard.ready.saving") : t("wizard.ready.cta"))}</button>`;
    }
    return `${left}<div class="wiz-foot-right">${right}</div>`;
  }

  /* --- event binding --------------------------------------------------- */
  function bind() {
    const sel = root.querySelector("#wiz-lang-sel");
    if (sel) sel.addEventListener("change", (e) => I18N.setLang(e.target.value));

    on("#wiz-cancel", "click", () => { if (S.onCancel) S.onCancel(); });
    on("#wiz-back", "click", () => { S.step = Math.max(0, S.step - 1); render(); });
    on("#wiz-next", "click", () => { if (canContinue()) { S.step = Math.min(4, S.step + 1); render(); } });
    on("#wiz-finish", "click", doFinish);

    // Step 1 — server
    on("#wiz-rediscover", "click", () => { S.discovery = null; doDiscover(null); });
    on("#wiz-togglemanual", "click", () => { S.showManual = !S.showManual; render(); });
    on("#wiz-probe", "click", () => doProbe(S.manualUrl.trim()));
    const url = root.querySelector("#wiz-url");
    if (url) {
      // Toggle the button imperatively on each keystroke: a full re-render here
      // would steal focus from the field the user is typing in.
      url.addEventListener("input", (e) => {
        S.manualUrl = e.target.value;
        const b = root.querySelector("#wiz-probe");
        if (b) b.disabled = S.probing || !S.manualUrl.trim();
      });
      url.addEventListener("keydown", (e) => { if (e.key === "Enter" && S.manualUrl.trim()) doProbe(S.manualUrl.trim()); });
    }
    const cidr = root.querySelector("#wiz-cidr");
    if (cidr) cidr.addEventListener("change", (e) => { S.scanCidr = e.target.value; render(); });
    on("#wiz-scan", "click", () => doDiscover(S.scanCidr));
    root.querySelectorAll("[data-pick]").forEach((el) => {
      el.addEventListener("click", () => {
        S.serverUrl = el.getAttribute("data-pick");
        S.serverVersion = el.getAttribute("data-ver") || null;
        render();
      });
    });

    // Step 2 — key
    const key = root.querySelector("#wiz-key");
    if (key) {
      // Enable "Verify" as the user types (no full re-render → focus is kept);
      // and drop a stale connection result the moment the key changes.
      key.addEventListener("input", (e) => {
        S.apiKey = e.target.value;
        const b = root.querySelector("#wiz-verify");
        if (b) b.disabled = S.verifying || !S.apiKey.trim();
        if (S.check) {
          S.check = null;
          const c = root.querySelector(".wiz-check");
          if (c) c.remove();
        }
      });
      key.addEventListener("keydown", (e) => { if (e.key === "Enter" && S.apiKey.trim()) doVerify(); });
    }
    on("#wiz-verify", "click", doVerify);

    // Step 3 — album
    root.querySelectorAll("[data-album]").forEach((el) => {
      el.addEventListener("click", () => { S.albumMode = el.getAttribute("data-album"); render(); });
    });
  }

  function on(sel, evt, fn) {
    const el = root.querySelector(sel);
    if (el) el.addEventListener(evt, fn);
  }

  /* --- server calls ---------------------------------------------------- */
  async function doDiscover(cidr) {
    if (cidr) S.scanning = true; else S.discovering = true;
    S.manualError = null;
    render();
    try {
      const r = await fetch("/api/setup/discover", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scanCidr: cidr || null }),
      });
      if (r.ok) {
        const data = await r.json();
        S.discovery = data;
        // A single candidate and nothing chosen yet: pre-select it.
        if (!S.serverUrl && data.candidates.length === 1) {
          S.serverUrl = data.candidates[0].url;
          S.serverVersion = data.candidates[0].version;
        }
        if (!data.candidates.length) S.showManual = true;
      } else {
        const e = await r.json().catch(() => ({}));
        S.manualError = e.detail || t("wizard.server.probeFail");
        S.showManual = true;
      }
    } catch (_) {
      S.discovery = S.discovery || { candidates: [], subnets: [] };
      S.showManual = true;
    } finally {
      S.discovering = false; S.scanning = false;
      render();
    }
  }

  async function doProbe(url) {
    if (!url) return;
    S.probing = true; S.manualError = null; render();
    try {
      const r = await fetch("/api/setup/probe", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await r.json();
      if (data.ok) {
        S.serverUrl = data.url; S.serverVersion = data.version;
        S.manualUrl = data.url; S.manualError = null;
      } else {
        S.manualError = data.error === "not-immich"
          ? t("wizard.server.probeNotImmich") : t("wizard.server.probeFail");
      }
    } catch (_) {
      S.manualError = t("wizard.server.probeFail");
    } finally {
      S.probing = false; render();
    }
  }

  async function doVerify() {
    if (!S.apiKey.trim()) return;
    S.verifying = true; render();
    try {
      const r = await fetch("/api/setup/check", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: S.serverUrl, apiKey: S.apiKey.trim() }),
      });
      S.check = await r.json();
    } catch (_) {
      S.check = { ok: false, error: null, user: null, version: null, permissions: { account: "unknown", albums: "unknown" } };
    } finally {
      S.verifying = false; render();
    }
  }

  async function doFinish() {
    S.finishing = true; S.finishError = null; render();
    try {
      const r = await fetch("/api/setup/complete", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: S.serverUrl, apiKey: S.apiKey.trim(), albumMode: S.albumMode }),
      });
      if (r.ok) {
        const done = S.onDone;
        close();
        if (done) done();
        return;
      }
      const e = await r.json().catch(() => ({}));
      S.finishError = e.detail || String(r.status);
    } catch (e) {
      S.finishError = String(e);
    } finally {
      S.finishing = false;
      if (root) render();
    }
  }

  window.Wizard = { open, close };
})();
