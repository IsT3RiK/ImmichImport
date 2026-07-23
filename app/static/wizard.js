"use strict";

/* ============================================================================
   Assistant de première configuration (vanilla JS, hors-ligne).
   --------------------------------------------------------------------------
   Calqué sur l'assistant d'ImmichDupFinder, adapté à l'import.

   Hypothèse : la personne qui lance le conteneur ne connaît ni Docker ni les
   variables d'environnement. Elle ne doit jamais avoir à deviner une adresse ni
   chercher où se trouve une clé API.

   Trois principes :
     - on propose avant de demander (détection réseau automatique : noms de
       service Docker, passerelle, host.docker.internal, et chaque interface
       réseau de la machine/du conteneur) ;
     - on vérifie avant d'enregistrer (rien n'est sauvé tant que la connexion
       n'a pas réellement fonctionné) ;
     - chaque erreur est expliquée, avec ce qu'il faut faire ensuite.

   Le rendu est entièrement piloté ici : à chaque étape ou changement de langue,
   tout le contenu est re-rendu depuis l'état `S`.
   ========================================================================== */

(function () {
  const t = (k, p) => I18N.t(k, p);

  const STEP_KEYS = [
    "wizard.step.start", "wizard.step.server", "wizard.step.key",
    "wizard.step.album", "wizard.step.ready",
  ];
  const ALBUM_MODES = ["FOLDER", "PATH", "NONE"];

  /** Permissions à cocher dans Immich pour qu'immich-go puisse importer. */
  const KEY_PERMS = [
    { token: "asset.upload", required: true },
    { token: "asset.read", required: false },
    { token: "album.create", required: false },
    { token: "album.read", required: false },
  ];

  const S = {
    step: 0,
    serverUrl: "", serverVersion: null,
    discovery: null, discovering: false,
    showManual: false, manualUrl: "", manualError: null, probing: false,
    scanCidr: "", scanning: false,
    apiKey: "", check: null, verifying: false,
    browserUrl: "",
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

  /** Échappe puis rend les **passages en gras** de la copie. */
  function rich(s) {
    return esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  }

  /* --- icônes inline (currentColor, aucun asset externe) ---------------- */
  const IC = {
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    checkCircle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="8.5 12.5 11 15 16 9.5"/></svg>',
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
    caret: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
  };
  const spinner = '<span class="wiz-spin"></span>';

  /* --- cycle de vie ----------------------------------------------------- */
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
    S.browserUrl = "";
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
    if (e.key !== "Escape") return;
    // Échap referme d'abord le menu de langue, seulement ensuite l'assistant.
    const menu = root && root.querySelector("#wiz-lang-menu");
    if (menu && !menu.hidden) { closeLangMenu(); return; }
    if (S.onCancel) S.onCancel();
  }

  /* --- rendu ------------------------------------------------------------ */
  function render() {
    if (!root) return;
    root.innerHTML =
      `<div class="wiz-modal" role="dialog" aria-modal="true" aria-labelledby="wiz-title">
        <header class="wiz-head">
          <h1 id="wiz-title" class="wiz-title">${esc(t("wizard.header"))}</h1>
          ${langSwitch()}
          <div class="wiz-strip">${filmStrip()}</div>
        </header>
        <div class="wiz-body">${stepBody()}</div>
        <footer class="wiz-foot">${footer()}</footer>
      </div>`;
    bind();
    // La détection démarre dès l'arrivée sur l'étape, sans clic supplémentaire.
    if (S.step === 1 && !S.discovery && !S.discovering) doDiscover(null);
  }

  /* Le même sélecteur que la barre principale : globe + menu de verre listant
     les langues avec drapeau et nom complet (pas un <select> natif). */
  function langSwitch() {
    const cur = I18N.LANGS.find((l) => l.code === I18N.lang) || I18N.LANGS[0];
    return `<div class="lang-switch wiz-langswitch">
      <button type="button" class="lang-btn" id="wiz-lang-btn" aria-haspopup="listbox"
              aria-expanded="false" aria-label="${esc(t("lang.label"))}" title="${esc(cur.label)}">
        <span class="lang-globe" aria-hidden="true">${IC.globe}</span>
        <span class="lang-current">${esc(cur.code.toUpperCase())}</span>
        <span class="lang-caret" aria-hidden="true">${IC.caret}</span>
      </button>
      <ul class="lang-menu" id="wiz-lang-menu" role="listbox" aria-label="${esc(t("lang.label"))}" hidden></ul>
    </div>`;
  }

  function langMenuHtml() {
    return I18N.LANGS.map((l) => {
      const active = l.code === I18N.lang;
      return `<li role="option" data-lang="${l.code}"` +
        ` class="lang-option${active ? " active" : ""}"` +
        ` aria-selected="${active ? "true" : "false"}">` +
        `<span class="lang-flag" aria-hidden="true">${l.flag}</span>` +
        `<span class="lang-name">${esc(l.label)}</span>` +
        `<span class="lang-check" aria-hidden="true">${active ? "✓" : ""}</span>` +
        `</li>`;
    }).join("");
  }

  function closeLangMenu() {
    if (!root) return;
    const menu = root.querySelector("#wiz-lang-menu");
    const btn = root.querySelector("#wiz-lang-btn");
    if (menu && !menu.hidden) {
      menu.hidden = true;
      if (btn) btn.setAttribute("aria-expanded", "false");
    }
  }

  /** La bande-film : une vue par étape, exposée à mesure qu'on avance. */
  function filmStrip() {
    return `<ol class="wiz-film" aria-label="${esc(t("wizard.progressAria"))}">` +
      STEP_KEYS.map((key, i) => {
        const cls = i < S.step ? "done" : i === S.step ? "current" : "todo";
        const label = i === S.step
          ? `<span class="wiz-film-label">${esc(t(key))}</span>` : "";
        return `<li class="wiz-film-item"><span class="wiz-film-dot ${cls}"${i === S.step ? ' aria-current="step"' : ""}></span>${label}</li>`;
      }).join("") + `</ol>`;
  }

  /* --- libellés localisés venus du backend ------------------------------ */
  function srcLabel(src) {
    if (!src) return "";
    switch (src.kind) {
      case "docker": return t("wizard.server.src.docker", { host: src.host });
      case "gateway": return t("wizard.server.src.gateway");
      case "dockerHost": return t("wizard.server.src.dockerHost");
      case "localhost": return t("wizard.server.src.localhost");
      case "iface": return t("wizard.server.src.iface", { iface: src.iface });
      case "scan": return t("wizard.server.src.scan");
      default: return "";
    }
  }

  function subnetLabel(s) {
    return s.kind === "iface"
      ? t("wizard.server.subnet.iface", { iface: s.iface })
      : t("wizard.server.subnet.common");
  }

  /* --- étapes ----------------------------------------------------------- */
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
        <li><span class="wiz-bic keep">${IC.checkCircle}</span>${esc(t("wizard.start.b3"))}</li>
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

    const cands = (S.discovery && S.discovery.candidates) || [];
    if (cands.length) {
      html += `<div class="wiz-label">${esc(t("wizard.server.found", { n: cands.length, count: cands.length }))}</div>
        <div class="wiz-cards">` +
        cands.map((c) => {
          const on = S.serverUrl === c.url;
          return `<button type="button" class="wiz-card${on ? " on" : ""}" data-pick="${esc(c.url)}" data-ver="${esc(c.version || "")}" aria-pressed="${on}">
            <span class="wiz-card-ic">${IC.checkCircle}</span>
            <span class="wiz-card-main"><span class="wiz-card-url">${esc(c.url)}</span>
            <span class="wiz-card-sub">${esc(srcLabel(c.source))}${c.version ? " · Immich " + esc(c.version) : ""}</span></span>
          </button>`;
        }).join("") + `</div>`;
    } else if (S.discovery && !S.discovering) {
      html += `<p class="wiz-warn">${IC.alert}<span>${esc(t("wizard.server.noneFound"))}</span></p>`;
    }

    if (!S.discovering) {
      html += `<div class="wiz-row-btns">
        <button type="button" class="wiz-btn sm" id="wiz-rediscover">${IC.refresh}${esc(t("wizard.server.relaunch"))}</button>
        <button type="button" class="wiz-btn sm" id="wiz-togglemanual">${IC.search}${esc(t("wizard.server.notSeen"))}</button>
      </div>`;
    }

    if (S.showManual) {
      const subnets = (S.discovery && S.discovery.subnets) || [];
      html += `<div class="wiz-panel">
        <div>
          <label class="wiz-flabel" for="wiz-url">${esc(t("wizard.server.addr"))}</label>
          <div class="wiz-inline">
            <input class="wiz-input" id="wiz-url" type="text" value="${esc(S.manualUrl)}" placeholder="${esc(t("wizard.server.addrPlaceholder"))}" autocomplete="off" spellcheck="false" />
            <button type="button" class="wiz-btn outline" id="wiz-probe"${S.probing || !S.manualUrl.trim() ? " disabled" : ""}>${S.probing ? spinner : ""}${esc(t("wizard.server.test"))}</button>
          </div>
          <p class="wiz-hint">${esc(t("wizard.server.addrHint"))}</p>
          ${S.manualError ? `<p class="wiz-err">${esc(S.manualError)}</p>` : ""}
        </div>
        ${subnets.length ? `<div>
          <label class="wiz-flabel" for="wiz-cidr">${esc(t("wizard.server.scanLabel"))}</label>
          <div class="wiz-inline">
            <select class="wiz-input" id="wiz-cidr">
              <option value="">${esc(t("wizard.server.scanPlaceholder"))}</option>
              ${subnets.map((s) => `<option value="${esc(s.cidr)}"${s.cidr === S.scanCidr ? " selected" : ""}>${esc(s.cidr)} · ${esc(subnetLabel(s))}${s.detected ? " · " + esc(t("wizard.server.detected")) : ""}</option>`).join("")}
            </select>
            <button type="button" class="wiz-btn outline" id="wiz-scan"${S.scanning || !S.scanCidr ? " disabled" : ""}>${S.scanning ? spinner : IC.wifi}${esc(t("wizard.server.scan"))}</button>
          </div>
          <p class="wiz-hint">${esc(t("wizard.server.scanHint"))}</p>
        </div>` : ""}
      </div>`;
    }

    if (S.serverUrl) {
      html += `<p class="wiz-kept"><span class="wiz-dot-keep"></span><span>${esc(t("wizard.server.kept"))} <span class="wiz-mono">${esc(S.serverUrl)}</span>${S.serverVersion ? " · Immich " + esc(S.serverVersion) : ""}</span></p>`;
    }
    return html + `</div>`;
  }

  /** Une adresse `http://immich-server:2283` n'est joignable que depuis Docker. */
  function isBrowserReachable(url) {
    try {
      const host = new URL(url).hostname;
      return host.includes(".") || host === "localhost";
    } catch (_) {
      return false;
    }
  }

  function browserBase() {
    if (S.browserUrl) return S.browserUrl;
    if (S.serverUrl && isBrowserReachable(S.serverUrl)) return S.serverUrl;
    return `${window.location.protocol}//${window.location.hostname}:2283`;
  }

  function stepKey() {
    const link = browserBase().replace(/\/+$/, "") + "/user-settings?isOpen=api-keys";
    let html = `<div class="wiz-step">
      <h2 class="wiz-h2">${esc(t("wizard.key.title"))}</h2>
      <p class="wiz-sub">${esc(t("wizard.key.subtitle"))}</p>
      <ol class="wiz-steps">
        <li><span class="wiz-num">01</span><span>${rich(t("wizard.key.s1"))}</span></li>
        <li><span class="wiz-num">02</span><span>${rich(t("wizard.key.s2"))}</span></li>
        <li><span class="wiz-num">03</span><span>${rich(t("wizard.key.s3"))}</span></li>
      </ol>
      <div>
        <a class="wiz-btn accent" href="${esc(link)}" target="_blank" rel="noopener noreferrer">${IC.ext}${esc(t("wizard.key.open"))}</a>
        <details class="wiz-details">
          <summary>${esc(t("wizard.key.linkFail"))}</summary>
          <div class="wiz-details-body">
            <p>${esc(t("wizard.key.linkFailBody"))}</p>
            <input class="wiz-input" id="wiz-browserurl" type="text" value="${esc(browserBase())}" placeholder="${esc(t("wizard.server.addrPlaceholder"))}" autocomplete="off" spellcheck="false" />
            <p>${esc(t("wizard.key.linkFailAlt"))}</p>
          </div>
        </details>
      </div>
      ${keyPermissions()}
      <div>
        <label class="wiz-flabel" for="wiz-key">${esc(t("wizard.key.paste"))}</label>
        <div class="wiz-inline">
          <input class="wiz-input" id="wiz-key" type="password" value="${esc(S.apiKey)}" placeholder="${esc(t("wizard.key.pastePlaceholder"))}" autocomplete="off" spellcheck="false" />
          <button type="button" class="wiz-btn primary" id="wiz-verify"${S.verifying || !S.apiKey.trim() ? " disabled" : ""}>${S.verifying ? spinner : ""}${esc(t("wizard.key.verify"))}</button>
        </div>
      </div>`;

    if (S.check) {
      const ok = S.check.ok;
      html += `<div class="wiz-check ${ok ? "ok" : "bad"}">`;
      if (ok) {
        const who = S.check.user && S.check.user.email
          ? t("wizard.key.connectedAs", { email: S.check.user.email })
          : t("wizard.key.connected");
        const ver = S.check.version ? t("wizard.key.connectedVersion", { version: S.check.version }) : "";
        html += `<p class="wiz-check-head"><span class="wiz-dot-keep"></span><span>${esc(who)}${esc(ver)}</span></p>`;
      } else {
        html += `<p class="wiz-check-head bad">${IC.x}<span>${esc(checkError(S.check.error))}</span></p>`;
      }
      html += `<ul class="wiz-perms">
        ${permRow(S.check.permissions.account, t("check.account.label"), t("check.account.hint"))}
        ${permRow(S.check.permissions.albums, t("check.albums.label"), t("check.albums.hint"))}
      </ul></div>`;
    }
    return html + `</div>`;
  }

  /** La liste exacte des permissions à cocher, avec ce que chacune sert. */
  function keyPermissions() {
    const req = t("wizard.key.required");
    const rec = t("wizard.key.recommended");
    return `<div class="wiz-permsbox">
      <p class="wiz-permsintro">${rich(t("wizard.key.permsIntro"))}</p>
      <ul class="wiz-permslist">` +
      KEY_PERMS.map((p) =>
        `<li><code class="wiz-token${p.required ? " req" : ""}">${esc(p.token)}</code>` +
        `<span class="wiz-token-lbl">${esc(t("perm." + p.token))}</span>` +
        `<span class="wiz-token-tag${p.required ? " req" : ""}">${esc(p.required ? req : rec)}</span></li>`
      ).join("") +
      `</ul>
      <p class="wiz-permsnote">${esc(t("wizard.key.permsNote", { req, rec }))}</p>
    </div>`;
  }

  function permRow(state, label, hint) {
    const ic = state === "ok" ? `<span class="wiz-perm-ic ok">${IC.checkCircle}</span>`
      : state === "missing" ? `<span class="wiz-perm-ic bad">${IC.x}</span>`
        : `<span class="wiz-perm-ic warn">${IC.alert}</span>`;
    const tag = state === "ok" ? t("check.granted")
      : state === "missing" ? t("check.missing", { hint }) : t("check.unknown");
    return `<li>${ic}<span class="wiz-perm-lbl">${esc(label)}<span class="wiz-perm-state">${esc(tag)}</span></span></li>`;
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
      <p class="wiz-info">${IC.checkCircle}<span>${esc(t("wizard.ready.note"))}</span></p>
      ${S.finishError ? `<p class="wiz-err">${esc(t("wizard.ready.failed", { error: S.finishError }))}</p>` : ""}
    </div>`;
  }

  /* --- pied / navigation ------------------------------------------------ */
  function canContinue() {
    if (S.step === 1) return S.serverUrl.length > 0;
    if (S.step === 2) return !!(S.check && S.check.ok);
    return true;
  }

  function footer() {
    const left = S.onCancel
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

  /* --- branchement des événements --------------------------------------- */
  function bind() {
    // Sélecteur de langue (même composant que la barre principale).
    const langBtn = root.querySelector("#wiz-lang-btn");
    const langMenu = root.querySelector("#wiz-lang-menu");
    if (langBtn && langMenu) {
      langBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (langMenu.hidden) {
          langMenu.innerHTML = langMenuHtml();
          langMenu.hidden = false;
          langBtn.setAttribute("aria-expanded", "true");
        } else {
          closeLangMenu();
        }
      });
      langMenu.addEventListener("click", (e) => {
        const li = e.target.closest("[data-lang]");
        if (!li) return;
        e.stopPropagation();
        I18N.setLang(li.dataset.lang); // déclenche un re-rendu complet
      });
    }
    // Un clic ailleurs dans la fenêtre referme le menu.
    root.addEventListener("click", closeLangMenu);

    on("#wiz-cancel", "click", () => { if (S.onCancel) S.onCancel(); });
    on("#wiz-back", "click", () => { S.step = Math.max(0, S.step - 1); render(); });
    on("#wiz-next", "click", () => { if (canContinue()) { S.step = Math.min(4, S.step + 1); render(); } });
    on("#wiz-finish", "click", doFinish);

    // Étape serveur
    on("#wiz-rediscover", "click", () => { S.discovery = null; doDiscover(null); });
    on("#wiz-togglemanual", "click", () => { S.showManual = !S.showManual; render(); });
    on("#wiz-probe", "click", () => doProbe(S.manualUrl.trim()));
    const url = root.querySelector("#wiz-url");
    if (url) {
      // On bascule le bouton à la main : un re-rendu complet à chaque frappe
      // volerait le focus du champ en cours de saisie.
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

    // Étape clé
    const burl = root.querySelector("#wiz-browserurl");
    if (burl) burl.addEventListener("input", (e) => { S.browserUrl = e.target.value; });
    const key = root.querySelector("#wiz-key");
    if (key) {
      key.addEventListener("input", (e) => {
        S.apiKey = e.target.value;
        const b = root.querySelector("#wiz-verify");
        if (b) b.disabled = S.verifying || !S.apiKey.trim();
        if (S.check) {
          S.check = null;
          const c = root.querySelector(".wiz-check");
          if (c) c.remove();
          const n = root.querySelector("#wiz-next");
          if (n) n.disabled = true;
        }
      });
      key.addEventListener("keydown", (e) => { if (e.key === "Enter" && S.apiKey.trim()) doVerify(); });
    }
    on("#wiz-verify", "click", doVerify);

    // Étape album
    root.querySelectorAll("[data-album]").forEach((el) => {
      el.addEventListener("click", () => { S.albumMode = el.getAttribute("data-album"); render(); });
    });
  }

  function on(sel, evt, fn) {
    const el = root.querySelector(sel);
    if (el) el.addEventListener(evt, fn);
  }

  /* --- appels serveur ---------------------------------------------------- */
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
        // Un seul serveur trouvé : on le pré-sélectionne, il n'y a rien à choisir.
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
        S.manualError = t("wizard.server.probeFail");
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
      S.check = { ok: false, error: null, user: null, version: null,
                  permissions: { account: "unknown", albums: "unknown" } };
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
