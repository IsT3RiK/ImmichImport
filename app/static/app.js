"use strict";

// ---- state ----------------------------------------------------------------
// nodes: path -> { path, name, checked, indeterminate, childrenLoaded,
//                  parent, el, boxEl, childrenEl, twistyEl, recEl }
const nodes = new Map();
let running = false;

// Live-stream health tracking (see "resilient live streaming" below).
let currentEs = null;      // active EventSource, or null
let currentJobId = null;   // job id we believe we're streaming
let lastEventTs = 0;       // ms timestamp of the last SSE event received
let resyncing = false;     // guard against overlapping resync() calls
const STREAM_STALE_MS = 10000; // no SSE traffic this long => treat as dropped

const $tree = document.getElementById("tree");
const $selection = document.getElementById("selection");
const $import = document.getElementById("import");
const $cancel = document.getElementById("cancel");
const $logs = document.getElementById("logs");
const $status = document.getElementById("status");
const $meta = document.getElementById("meta");
const $diskBanner = document.getElementById("disk-banner");
const $diskDot = document.getElementById("disk-dot");
const $resumePrompt = document.getElementById("resume-prompt");
const $resumeDetail = document.getElementById("resume-detail");
const $resumeGo = document.getElementById("resume-go");
const $resumeDiscard = document.getElementById("resume-discard");
const $dryRun = document.getElementById("dry-run");
const $progress = document.getElementById("progress");
const $progressFill = document.getElementById("progress-fill");
const $progressPct = document.getElementById("progress-pct");
const $progressStats = document.getElementById("progress-stats");
const $progressExtra = document.getElementById("progress-extra");
const $liveHead = document.getElementById("live-head");
const $recap = document.getElementById("recap");
const $logsFold = document.getElementById("logs-fold");
const $langBtn = document.getElementById("lang-btn");
const $langMenu = document.getElementById("lang-menu");
const $langCurrent = document.getElementById("lang-current");
const $setupBtn = document.getElementById("setup-btn");
const $appVersion = document.getElementById("app-version");

// ---- i18n bindings --------------------------------------------------------
// Short aliases over the global I18N module (defined in i18n.js). `t` is the
// translator; the retained-state vars below let relocalize() re-render every
// dynamic surface when the language changes at runtime (no page reload).
const t = (key, params) => I18N.t(key, params);
let lastCfg = null;        // last /api/config, to re-render the meta bar
let lastFolders = null;    // last job folders (server truth), running or done
let lastJobStatus = null;  // status of the job lastFolders belongs to
// True once the user has ticked a box in THIS tab. Until then the selection
// panel belongs to the server's job: the checkboxes are empty after a reload or
// a VPN reconnect, and rebuilding the panel from them is what used to erase the
// imported folder's path from the screen.
let selectionTouched = false;
let lastStatus = null;     // { key, params, cls } | { raw, cls } for the status line

// ---- disk hot-plug detection ----------------------------------------------
// Poll /api/status; when the disk appears/disappears, refresh the tree so the
// user never has to reload the page after (un)plugging the external drive.
let diskPresent = null; // null = unknown (first poll)
const DISK_POLL_MS = 4000;

async function pollDisk() {
  let st;
  try {
    st = await fetch("/api/status").then((r) => (r.ok ? r.json() : null));
  } catch {
    st = null;
  }
  if (!st) {
    setDiskUi(false, t("disk.backendUnreachable"));
    return;
  }
  renderDiskDot(st);
  const present = !!st.present;
  // The import runs on the SERVER, not in this tab. Whenever the backend is
  // reachable, reconcile with its truth: adopt an in-progress job (started here
  // or elsewhere), re-attach a stream that dropped (VPN toggled, laptop slept),
  // or fall back to idle. resync() is cheap and safe to call repeatedly.
  if (present) resync();
  if (present !== diskPresent) {
    const first = diskPresent === null;
    diskPresent = present;
    if (present) {
      setDiskUi(true, "");
      // Don't blow away an in-progress import view; only rebuild the tree.
      if (!running) {
        rebuildTree();
        // Disk is back — surface any interrupted import for resume/restart.
        checkResume();
      }
    } else {
      setDiskUi(false, t("disk.none"));
      // Can't resume without the disk: hide the prompt until it returns.
      hideResume();
      if (!first && !running) {
        nodes.clear();
        $tree.innerHTML = "";
        refreshSelection();
      }
    }
  }
}

function renderDiskDot(st) {
  const mounts = (st.disks || []).filter((d) => d.isMount).length;
  if (st.present) {
    $diskDot.className = "disk-dot ok";
    $diskDot.title = mounts
      ? t("disk.mounted", { count: mounts })
      : t("disk.contentDetected");
  } else {
    $diskDot.className = "disk-dot off";
    $diskDot.title = t("disk.noneShort");
  }
}

function setDiskUi(present, message) {
  if (message) {
    $diskBanner.textContent = message;
    $diskBanner.hidden = false;
    $diskBanner.className = "disk-banner " + (present ? "ok" : "warn");
  } else {
    $diskBanner.hidden = true;
  }
}

function rebuildTree() {
  nodes.clear();
  $tree.innerHTML = "";
  loadChildren("", $tree).then(refreshSelection);
}

// ---- resume of an interrupted import --------------------------------------
// After the disk is (re)plugged, ask the backend whether a previous import was
// interrupted mid-way. If so, offer the user to resume the remaining folders
// or discard the state and start a fresh selection.
async function checkResume() {
  if (running) return;
  let data;
  try {
    data = await fetch("/api/import/resumable").then((r) => (r.ok ? r.json() : null));
  } catch {
    return;
  }
  const r = data && data.resumable;
  if (!r || r.remaining <= 0) {
    hideResume();
    return;
  }
  // Reflect the persisted mode: resuming keeps the job's original dry-run flag.
  $dryRun.checked = !!r.dryRun;
  const dryNote = r.dryRun ? ` <b>🧪 ${t("resume.simMode")}</b>` : "";
  const when = r.updatedAt ? I18N.date(r.updatedAt) : t("resume.unknownDate");
  const pending = (r.folders || [])
    .filter((f) => f.status !== "done")
    .map((f) => (f.path === "" ? t("common.root") : escapeHtml(f.path)));
  const listed = pending.slice(0, 8).map((p) => `<li>${p}</li>`).join("");
  const more = pending.length > 8
    ? `<li>${t("resume.more", { count: pending.length - 8 })}</li>`
    : "";
  $resumeDetail.innerHTML =
    t("resume.intro", { when: escapeHtml(when) }) + dryNote + " " +
    t("resume.done", { done: r.done, total: r.total, count: r.done }) + ", " +
    t("resume.remaining", { remaining: r.remaining, count: r.remaining }) + " :" +
    `<ul>${listed}${more}</ul>` +
    t("resume.outro");
  $resumePrompt.hidden = false;
}

function hideResume() {
  $resumePrompt.hidden = true;
}

$resumeGo.addEventListener("click", async () => {
  $resumeGo.disabled = true;
  hideResume();
  setRunning(true);
  startStats($dryRun.checked);
  setStatusKey("status.resuming", "run");
  try {
    const r = await fetch("/api/import/resume", { method: "POST" });
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      setStatusKey("status.error", "err", { msg: e.detail || r.status });
      setRunning(false);
      $resumeGo.disabled = false;
      return;
    }
    const { jobId } = await r.json();
    streamJob(jobId);
  } catch (e) {
    setStatusKey("status.networkError", "err", { msg: String(e) });
    setRunning(false);
  } finally {
    $resumeGo.disabled = false;
  }
});

$resumeDiscard.addEventListener("click", async () => {
  try {
    await fetch("/api/import/discard", { method: "POST" });
  } catch {
    /* ignore */
  }
  hideResume();
  setStatusKey("status.discarded", "");
});

// ---- recursive-count fetch queue (throttled) ------------------------------
const countQueue = [];
let countActive = 0;
const COUNT_CONCURRENCY = 4;

function enqueueCount(path, el) {
  countQueue.push({ path, el });
  pumpCounts();
}
function pumpCounts() {
  while (countActive < COUNT_CONCURRENCY && countQueue.length) {
    const { path, el } = countQueue.shift();
    countActive++;
    fetch(`/api/count?path=${encodeURIComponent(path)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && el.isConnected) el.innerHTML = badgeInner(d.photos, d.videos);
      })
      .catch(() => {})
      .finally(() => {
        countActive--;
        pumpCounts();
      });
  }
}

// ---- rendering ------------------------------------------------------------
// One uniform badge per folder: always photos AND videos, so a row always reads
// the same way. The figure covers the folder *and its subfolders* — i.e. exactly
// what immich-go would import — which is the only number that matters here.
function badgeInner(photos, videos) {
  return `<span class="ic">📷</span>${I18N.n(photos || 0)}` +
    `<span class="dot">·</span>` +
    `<span class="ic">🎬</span>${I18N.n(videos || 0)}`;
}

function makeNode(child, parentPath) {
  const path = child.path;
  const wrap = document.createElement("div");
  wrap.className = "node";

  const row = document.createElement("div");
  row.className = "node-row";
  row.setAttribute("role", "treeitem");

  const twisty = document.createElement("span");
  twisty.className = "twisty " + (child.hasChildren ? "closed" : "leaf");

  const box = document.createElement("input");
  box.type = "checkbox";

  const folder = document.createElement("span");
  folder.className = "folder-ic";
  folder.textContent = "📁";

  const name = document.createElement("span");
  name.className = "node-name";
  name.textContent = child.name;

  const spacer = document.createElement("span");
  spacer.className = "spacer";

  // Single badge: the recursive photo/video count, filled in by enqueueCount().
  const rec = document.createElement("span");
  rec.className = "badge badge-total";
  rec.title = t("badge.totalTitle");
  rec.innerHTML = `<span class="badge-wait">…</span>`;

  row.append(twisty, box, folder, name, spacer, rec);
  const childrenEl = document.createElement("div");
  childrenEl.className = "children";
  childrenEl.hidden = true;
  wrap.append(row, childrenEl);

  const node = {
    path, name: child.name, checked: false, indeterminate: false,
    childrenLoaded: false, hasChildren: child.hasChildren,
    parent: parentPath, el: wrap, boxEl: box, rowEl: row, folderEl: folder,
    childrenEl, twistyEl: twisty, recEl: rec,
  };
  nodes.set(path, node);

  // inherit parent's checked state for freshly-loaded children
  const parent = parentPath !== null ? nodes.get(parentPath) : null;
  if (parent && parent.checked && !parent.indeterminate) {
    node.checked = true;
  }
  applyBox(node);

  box.addEventListener("change", () => {
    selectionTouched = true;  // an actual click: the panel is this tab's again
    onToggle(node, box.checked);
  });
  twisty.addEventListener("click", () => {
    if (child.hasChildren) toggleExpand(node);
  });
  name.addEventListener("click", () => {
    if (child.hasChildren) toggleExpand(node);
  });

  enqueueCount(path, rec);
  return node;
}

function applyBox(node) {
  node.boxEl.checked = node.checked;
  node.boxEl.indeterminate = node.indeterminate;
  if (node.rowEl) {
    node.rowEl.classList.toggle("selected", node.checked && !node.indeterminate);
  }
}

async function toggleExpand(node) {
  if (node.childrenEl.hidden === false) {
    node.childrenEl.hidden = true;
    node.twistyEl.className = "twisty closed";
    node.folderEl.textContent = "📁";
    return;
  }
  if (!node.childrenLoaded) {
    node.twistyEl.className = "twisty loading";
    await loadChildren(node.path, node.childrenEl);
    node.childrenLoaded = true;
  }
  node.childrenEl.hidden = false;
  node.twistyEl.className = "twisty open";
  node.folderEl.textContent = "📂";
}

async function loadChildren(path, container) {
  const r = await fetch(`/api/tree?path=${encodeURIComponent(path)}`);
  if (!r.ok) return;
  const data = await r.json();
  container.innerHTML = "";
  for (const child of data.children) {
    const node = makeNode(child, path);
    container.appendChild(node.el);
  }
}

// ---- tri-state cascade ----------------------------------------------------
function onToggle(node, value) {
  node.checked = value;
  node.indeterminate = false;
  applyBox(node);
  // cascade down to every loaded descendant
  cascadeDown(node, value);
  // recompute ancestors up to the root
  updateAncestors(node.parent);
  refreshSelection();
}

function cascadeDown(node, value) {
  for (const child of loadedChildren(node)) {
    child.checked = value;
    child.indeterminate = false;
    applyBox(child);
    cascadeDown(child, value);
  }
}

function loadedChildren(node) {
  const out = [];
  for (const el of node.childrenEl.children) {
    // first child of each .node wrapper is the row; find node by matching
    const n = nodeFromWrapper(el);
    if (n) out.push(n);
  }
  return out;
}

function nodeFromWrapper(wrapperEl) {
  for (const n of nodes.values()) {
    if (n.el === wrapperEl) return n;
  }
  return null;
}

function updateAncestors(path) {
  if (path === null) return;
  const node = nodes.get(path);
  if (!node) return;
  const kids = loadedChildren(node);
  if (kids.length) {
    const allChecked = kids.every((k) => k.checked && !k.indeterminate);
    const anySel = kids.some((k) => k.checked || k.indeterminate);
    if (allChecked) {
      node.checked = true; node.indeterminate = false;
    } else if (anySel) {
      node.checked = false; node.indeterminate = true;
    } else {
      node.checked = false; node.indeterminate = false;
    }
    applyBox(node);
  }
  updateAncestors(node.parent);
}

// ---- selection collection (minimal top-most set) --------------------------
function collectSelection() {
  const selected = [];
  // Top-level nodes are those whose parent has no node in the map: the disks
  // at IMPORT_ROOT have parent === "" (the root itself, which has no node).
  const roots = [...nodes.values()].filter((n) => !nodes.has(n.parent));
  function walk(node) {
    if (node.checked && !node.indeterminate) {
      selected.push(node.path);
      return; // immich-go recurses; don't descend
    }
    for (const child of loadedChildren(node)) walk(child);
  }
  for (const r of roots) walk(r);
  return selected;
}

function refreshSelection() {
  // The server's job wins over this tab's checkboxes — while it runs AND after
  // it ends. A reconnecting or reloaded window has no box ticked, so falling
  // back to the DOM here would replace "DISK1/Photos" with "no folder
  // selected" the instant the job finished. Only an explicit click by the user
  // (selectionTouched) hands the panel back to the checkbox selection.
  if (lastFolders && (running || !selectionTouched)) {
    renderJobFolders(lastFolders, lastJobStatus);
    $import.disabled = running || collectSelection().length === 0;
    return;
  }
  if (running) return;  // running, but the folder list hasn't arrived yet
  const sel = collectSelection();
  if (!sel.length) {
    $selection.textContent = t("selection.none");
    $import.disabled = true || running;
    return;
  }
  const items = sel.map((p) => `<li>${p === "" ? t("common.root") : escapeHtml(p)}</li>`).join("");
  $selection.innerHTML = t("selection.toImport", { count: sel.length }) + `<ul>${items}</ul>`;
  $import.disabled = running;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- live progress (authoritative from the SERVER) ------------------------
// The backend parses immich-go's output and computes every counter, exposing
// them via /api/jobs/active and SSE "progress" events. This tab just renders
// what the server reports — no more replaying thousands of log lines to rebuild
// the totals on reload (that was the reload-latency culprit). The raw log is
// kept only as a bounded tail behind a collapsed "details" fold, for debugging.
const S = {
  active: false, startTs: 0, dryRun: false,
  // client-side upload-rate smoothing for the ETA readout
  rate: 0, lastUploaded: 0, lastRateTs: 0, flatTicks: 0,
  // processed-rate smoothing (uploads + dups + errors + …) drives the ETA,
  // so the remaining time still counts down while immich-go skips duplicates.
  procRate: 0, lastProcessed: 0,
  // Exact number of assets to import, summed from the tree's recursive counts
  // (authoritative, known up-front) — NOT immich-go's slow, drip-fed `found`.
  // This is what makes the ETA trustworthy.
  expectedTotal: 0,
};

// Total assets across the currently-selected top-most folders, taken from the
// backend's recursive count (the same figure shown in the Σ badges). Summed at
// import start so the ETA/remaining/% are anchored to a real target instead of
// immich-go's laggy discovery counter.
async function computeExpectedTotal(paths) {
  let total = 0;
  for (const p of paths || []) {
    try {
      const d = await fetchJson(`/api/count?path=${encodeURIComponent(p)}`);
      if (d) total += (d.photos || 0) + (d.videos || 0);
    } catch (_) { /* ignore a single failed count */ }
  }
  return total;
}

// Assets immich-go has already classified (sent, duplicate, errored, …). Used
// with expectedTotal to derive an accurate remaining count and %.
function processedCount(p) {
  return (p.uploaded || 0) + (p.dups || 0) + (p.errors || 0) +
    (p.unsupported || 0) + (p.upgraded || 0);
}

// Remaining assets: prefer our exact tree total; fall back to immich-go's own
// `remaining` only when we don't have a tree count yet.
function expectedRemaining(p) {
  if (S.expectedTotal > 0) {
    return Math.max(S.expectedTotal - processedCount(p), 0);
  }
  return p.remaining || 0;
}

// Bounded in-memory log tail (debug fold only). We never render the whole
// thing: append to a ring buffer and only paint the <pre> when the fold is
// open, so a long import can't thrash the DOM.
const LOG_KEEP = 200;
let logBuffer = [];
function clearLogs() {
  logBuffer = [];
  if ($logs) $logs.textContent = "";
}
function pushLog(line) {
  logBuffer.push(line);
  if (logBuffer.length > LOG_KEEP) logBuffer.splice(0, logBuffer.length - LOG_KEEP);
  if ($logsFold && $logsFold.open) renderLogs();
}
function renderLogs() {
  if (!$logs) return;
  $logs.textContent = logBuffer.join("\n");
  $logs.scrollTop = $logs.scrollHeight;
}
if ($logsFold) {
  $logsFold.addEventListener("toggle", () => { if ($logsFold.open) renderLogs(); });
}

function startStats(dryRun) {
  S.active = true;
  S.startTs = Date.now();
  S.dryRun = !!dryRun;
  S.rate = 0;
  S.lastUploaded = 0;
  S.lastRateTs = Date.now();
  S.flatTicks = 0;
  S.procRate = 0;
  S.lastProcessed = 0;
  S.expectedTotal = 0;
  clearLogs();
  $recap.hidden = true;
  $recap.innerHTML = "";
  $progress.hidden = false;
  applyProgress(null);
}

// Render the counters from a server-provided progress object (or a neutral
// "preparing" state when null). Replaces the old client-side log parsing.
function applyProgress(p) {
  if (!S.active) return;
  S.lastProgress = p; // retained so relocalize() can re-render on language change
  if (!p) {
    $progress.classList.add("working", "indeterminate");
    $progressFill.style.width = "0%";
    $progressPct.textContent = t("progress.preparing");
    $progressStats.innerHTML = "";
    $progressExtra.textContent = "";
    $liveHead.innerHTML =
      `<span class="spinner"></span><span class="live-phase">${t("progress.starting")}</span>` +
      `<span class="live-badge"><span class="live-dot"></span>${t("live.badge")}</span>`;
    return;
  }
  // Prefer our exact tree total for the % and remaining count; fall back to
  // immich-go's own figures until computeExpectedTotal() resolves.
  const remaining = expectedRemaining(p);
  let pct;
  if (S.expectedTotal > 0) {
    pct = Math.min(100, Math.round(processedCount(p) / S.expectedTotal * 100));
  } else {
    pct = p.pct || 0;
  }
  $progressFill.style.width = pct + "%";
  $progressPct.textContent =
    (S.expectedTotal > 0 || p.found > 0)
      ? pct + " %"
      : t("progress.preparingIndex");
  const foundLabel = S.expectedTotal > 0 ? S.expectedTotal : p.found;
  $progressStats.innerHTML =
    chip("📤", t("chip.uploaded"), p.uploaded) +
    chip("🔁", t("chip.dups"), p.dupsEstimated ? "≈ " + I18N.n(p.dups) : p.dups,
      p.dupsEstimated ? "est" : "") +
    chip("⚠️", t("chip.errors"), p.errors, p.errors > 0 ? "err" : "") +
    chip("⏳", t("chip.remaining"), remaining) +
    chip("📦", t("chip.toImport"), foundLabel);
  updateLiveHead(p, remaining);
}

// Spinner + phase label + current folder, plus a smoothed upload-rate / ETA.
// immich-go's --no-ui output has no per-file names, so we describe the phase
// (scanning / uploading / de-duplicating) rather than fake a per-file bar.
function updateLiveHead(p, remaining) {
  if (remaining == null) remaining = expectedRemaining(p);
  const now = Date.now();
  const dt = (now - S.lastRateTs) / 1000;
  if (dt >= 1) {
    // Upload rate (for the "N /s" readout and the phase heuristic).
    const dUp = (p.uploaded || 0) - S.lastUploaded;
    if (dUp > 0) {
      const inst = dUp / dt;
      S.rate = S.rate ? S.rate * 0.6 + inst * 0.4 : inst;
      S.flatTicks = 0;
    } else {
      S.flatTicks++;
    }
    S.lastUploaded = p.uploaded || 0;
    // Processed rate (uploads + dups + errors + …) drives the ETA, so the
    // countdown keeps moving while immich-go is only skipping duplicates.
    const proc = processedCount(p);
    const dProc = proc - S.lastProcessed;
    if (dProc > 0) {
      const instP = dProc / dt;
      S.procRate = S.procRate ? S.procRate * 0.6 + instP * 0.4 : instP;
    }
    S.lastProcessed = proc;
    S.lastRateTs = now;
  }
  let phase, indeterminate = false;
  if (p.readPct < 100 && p.found > 0 && (p.uploaded || 0) === 0) {
    phase = t("phase.scanning", { pct: p.readPct });
    indeterminate = true;
  } else if (S.flatTicks >= 3 && remaining > 0) {
    phase = t("phase.dedup");
    indeterminate = true;
  } else {
    phase = S.dryRun ? t("phase.simulating") : t("phase.transferring");
  }
  $progress.classList.add("working");
  $progress.classList.toggle("indeterminate", indeterminate);
  const folder = p.currentFolder
    ? `<span class="live-folder" title="${escapeHtml(p.currentFolder)}">${escapeHtml(p.currentFolder)}</span>`
    : "";
  $liveHead.innerHTML =
    `<span class="spinner"></span><span class="live-phase">${phase}</span>${folder}` +
    `<span class="live-badge"><span class="live-dot"></span>${t("live.badge")}</span>`;
  // ETA from the processed-rate against the exact remaining count; show the
  // upload rate separately when files are actively being sent.
  let extra = "";
  const etaRate = S.procRate > 0 ? S.procRate : S.rate;
  if (remaining > 0 && etaRate > 0) {
    extra = t("eta.remaining", { time: fmtDuration(remaining / etaRate) });
    if (S.rate > 0 && S.flatTicks < 3) extra += " · " + t("eta.rate", { rate: Math.round(S.rate) });
  } else if (S.rate > 0 && S.flatTicks < 3) {
    extra = t("eta.rate", { rate: Math.round(S.rate) });
  }
  $progressExtra.textContent = extra;
}

function chip(icon, label, val, cls) {
  const shown = typeof val === "number" ? I18N.n(val) : val;
  return `<span class="stat-chip ${cls || ""}"><span class="ic">${icon}</span>` +
    `<b>${shown}</b> <span class="lbl">${label}</span></span>`;
}

function fmtDuration(secs) {
  secs = Math.round(secs);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  const uh = t("dur.h"), um = t("dur.min"), us = t("dur.s");
  if (h) return `${h} ${uh} ${String(m).padStart(2, "0")} ${um} ${String(s).padStart(2, "0")} ${us}`;
  if (m) return `${m} ${um} ${String(s).padStart(2, "0")} ${us}`;
  return `${s} ${us}`;
}

function recapRow(label, val) {
  const shown = typeof val === "number" ? I18N.n(val) : val;
  return `<div class="recap-row"><span>${label}</span><b>${shown}</b></div>`;
}

function finishStats(d) {
  if (!S.active) return;
  S.active = false;
  let secs;
  if (d && d.startedAt && d.endedAt) secs = Math.max(0, d.endedAt - d.startedAt);
  else secs = (Date.now() - S.startTs) / 1000;
  $progressFill.style.width = "100%";
  $progress.classList.remove("working", "indeterminate");
  $progress.hidden = true; // stop the spinner; the recap card takes over
  // Retain the result so relocalize() can re-render the recap in a new language
  // without recomputing the timings.
  S.recapData = d;
  S.recapSecs = secs;
  S.recapDry = S.dryRun;
  renderRecap();
}

function renderRecap() {
  const d = S.recapData;
  const p = (d && d.progress) || {};
  const serverDup = p.serverDup || 0;
  const localDup = p.localDup || 0;
  const dups = p.dups != null ? p.dups : serverDup + localDup;
  const statusKey =
    ["success", "error", "cancelled", "interrupted"].includes(d && d.status)
      ? d.status : "default";
  const head = t("recap.head." + statusKey);
  const dupsStr = I18N.n(dups) +
    (dups ? t("recap.dupsDetail", { server: serverDup, local: localDup }) : "");
  $recap.innerHTML =
    `<div class="recap-head">${head}${S.recapDry ? t("recap.simSuffix") : ""}</div>` +
    `<div class="recap-grid">` +
    recapRow(t("recap.uploaded"), p.uploaded || 0) +
    (p.upgraded ? recapRow(t("recap.upgraded"), p.upgraded) : "") +
    recapRow(t("recap.dups"), dupsStr) +
    (p.unsupported ? recapRow(t("recap.unsupported"), p.unsupported) : "") +
    recapRow(t("recap.errors"), p.errors || 0) +
    recapRow(t("recap.found"), p.found || 0) +
    // Files immich-go saw on disk and dropped BEFORE any upload: banned by a
    // pattern, unknown type, or unsupported format. Without this row the gap
    // between what the tree announced and "total found" is invisible.
    (p.discSkipped
      ? recapRow(t("recap.discSkipped"),
                 I18N.n(p.discSkipped) + t("recap.discDetail", {
                   banned: p.discBanned || 0,
                   unknown: p.discUnknown || 0,
                   unsupported: p.discUnsupported || 0,
                 }))
      : "") +
    recapRow(t("recap.time"), fmtDuration(S.recapSecs)) +
    `</div>` +
    (S.recapDry ? `<div class="recap-note">${t("recap.simNote")}</div>` : "");
  $recap.hidden = false;
}

// ---- import + live logs ---------------------------------------------------
$import.addEventListener("click", async () => {
  const paths = collectSelection();
  if (!paths.length) return;
  const dryRun = $dryRun.checked;
  lastFolders = null;       // drop the previous job's panel
  lastJobStatus = null;
  selectionTouched = false; // the new job owns the panel from now on
  setRunning(true);
  startStats(dryRun);
  setStatusKey(dryRun ? "status.startingSim" : "status.starting", "run");
  try {
    const r = await fetch("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths, dryRun }),
    });
    if (!r.ok) {
      setRunning(false);
      if (r.status === 409) {
        // Someone already started an import. Don't launch a second one — attach
        // to the running job so this window shows it live instead of erroring.
        await resync();
        return;
      }
      const e = await r.json().catch(() => ({}));
      setStatusKey("status.error", "err", { msg: e.detail || r.status });
      return;
    }
    const { jobId } = await r.json();
    streamJob(jobId);
  } catch (e) {
    setStatusKey("status.networkError", "err", { msg: String(e) });
    setRunning(false);
  }
});

$cancel.addEventListener("click", async () => {
  if (!$cancel.dataset.jobId) return;
  await fetch(`/api/jobs/${$cancel.dataset.jobId}/cancel`, { method: "POST" });
});

// ---- resilient live streaming ---------------------------------------------
// The import lives on the SERVER; this tab only observes it via an SSE stream.
// Connections are fragile (VPN toggling, sleep, proxy idle-timeouts) and a dead
// socket can stay "open" for minutes without firing onerror. So we never trust
// a single connection: attachStream() (re)opens one and resets the view, the
// server sends periodic "ping" heartbeats to prove liveness, and a watchdog
// re-attaches whenever heartbeats stop. resync() reconciles the whole UI with
// whatever the backend reports — running, just-finished, or idle.

function closeEs() {
  if (currentEs) {
    try { currentEs.close(); } catch (_) { /* ignore */ }
  }
  currentEs = null;
}

function fetchJson(url) {
  return fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
}

// Render the folders of the server's job into the selection panel, with a
// per-folder status glyph, so a reattached window shows WHAT was (or is being)
// imported instead of "nothing selected". Kept on screen after the job ends —
// success or error — until the user picks a new selection.
function renderJobFolders(folders, status) {
  if (!folders || !folders.length) return;
  lastFolders = folders; // retained so relocalize() can re-render on lang change
  if (status !== undefined) lastJobStatus = status;
  const glyph = (s) => ({
    done: "✅", running: "⏳", failed: "❌", interrupted: "⏸", pending: "•",
  })[s] || "•";
  const items = folders.map((f) =>
    `<li>${glyph(f.status)} ${f.path === "" ? t("common.root") : escapeHtml(f.path)}</li>`
  ).join("");
  const key = (lastJobStatus === "running" || lastJobStatus == null)
    ? "selection.importing" : "selection.imported";
  $selection.innerHTML =
    t(key, { count: folders.length }) + `<ul>${items}</ul>`;
}

// Re-read the job's folders from the server (the only place that still knows
// them after a reload) and re-render the panel with their final statuses.
async function refreshJobFolders() {
  const active = await fetchJson("/api/jobs/active");
  if (active && active.jobId && active.folders && active.folders.length) {
    renderJobFolders(active.folders, active.status);
  }
}

// Expand the tree down to each job folder and tick its checkbox, so the
// arborescence reflects what's importing (best-effort; ignores load errors).
async function revealJobFolders(paths) {
  for (const p of paths || []) {
    if (!p) continue;
    try { await revealPath(p); } catch (_) { /* ignore */ }
  }
}

async function revealPath(fullPath) {
  const parts = fullPath.split("/");
  let acc = "";
  for (let i = 0; i < parts.length; i++) {
    acc = acc ? acc + "/" + parts[i] : parts[i];
    const node = nodes.get(acc);
    if (!node) return; // path not present in the current tree — give up quietly
    if (i < parts.length - 1) {
      if (!node.childrenLoaded) {
        await loadChildren(node.path, node.childrenEl);
        node.childrenLoaded = true;
      }
      node.childrenEl.hidden = false;
      node.twistyEl.className = "twisty open";
      node.folderEl.textContent = "📂";
    } else {
      onToggle(node, true);
      if (node.rowEl && node.rowEl.scrollIntoView) {
        node.rowEl.scrollIntoView({ block: "nearest" });
      }
    }
  }
}

// Open a fresh SSE stream for a job. The stream sends the current progress plus
// a short log tail (no full replay), then live "progress"/"log" events.
function attachStream(jobId, snap) {
  closeEs();
  currentJobId = jobId;
  $cancel.dataset.jobId = jobId;
  const dryRun = !!(snap && snap.dryRun);
  $dryRun.checked = dryRun;
  hideResume();
  setRunning(true);
  startStats(dryRun);
  // Keep the selection panel and tree in sync with what's ACTUALLY importing
  // (the job on the server), not this tab's checkboxes — so a reattached window
  // shows the folder(s) in progress instead of an empty "nothing selected".
  if (snap) {
    selectionTouched = false;  // the panel now mirrors the server's job
    renderJobFolders(snap.folders, snap.status);
    revealJobFolders(snap.paths);
    if (snap.progress) applyProgress(snap.progress);
    // Anchor the ETA to the exact asset count from the tree. Only count folders
    // that still need work (on a resume, the done ones are skipped as dups but
    // aren't re-counted here) — falls back to immich-go's `remaining` until it
    // resolves. Covers all three entry points: import, resume and reattach.
    const pending = (snap.folders || []).filter((f) => f.status !== "done")
      .map((f) => f.path);
    const anchorPaths = pending.length ? pending : (snap.paths || []);
    computeExpectedTotal(anchorPaths).then((t) => {
      if (S.active && currentJobId === jobId) S.expectedTotal = t;
    });
  }
  lastEventTs = Date.now();
  const es = new EventSource(`/api/jobs/${jobId}/stream`);
  currentEs = es;
  es.addEventListener("ping", () => { lastEventTs = Date.now(); });
  es.addEventListener("progress", (ev) => {
    lastEventTs = Date.now();
    applyProgress(JSON.parse(ev.data));
  });
  es.addEventListener("log", (ev) => {
    lastEventTs = Date.now();
    pushLog(JSON.parse(ev.data));
  });
  es.addEventListener("done", (ev) => {
    lastEventTs = Date.now();
    const d = JSON.parse(ev.data);
    closeEs();
    currentJobId = null;
    finalizeJob(d);
  });
  es.onerror = () => {
    // Dropped or refused. Never trust the socket and never silently give up:
    // tear it down and let the watchdog re-attach once the backend answers.
    closeEs();
  };
}

function finalizeJob(d) {
  finishStats(d);
  if (d.status === "success") setStatusKey("status.success", "ok");
  else if (d.status === "cancelled") setStatusKey("status.cancelled", "err");
  else if (d.status === "interrupted") setStatusKey("status.interrupted", "err");
  else setStatusKey("status.errorCode", "err", { code: d.returnCode });
  setRunning(false);
  // Refresh resume state: interrupted -> prompt appears when disk returns;
  // clean finish -> any stale prompt is cleared.
  checkResume();
  // running is now false: the panel falls back to the job's folders (not to the
  // empty checkbox set), then their final ✅/❌ glyphs are pulled from the
  // server. Failing that fetch changes nothing on screen — the paths stay.
  if (d && d.status) lastJobStatus = d.status;
  refreshSelection();
  refreshJobFolders();
}

// Entry point used right after POST /api/import (or /resume) succeeds.
async function streamJob(jobId) {
  const snap = await fetchJson(`/api/jobs/${jobId}`);
  attachStream(jobId, snap);
}

// Reconcile the UI with the server's truth. Idempotent and safe to spam: it
// only re-attaches when the current stream is missing or stale, renders a job
// that finished while we were disconnected, and — crucially — never clobbers
// the view when the backend is simply unreachable (VPN off): it freezes and
// retries, so toggling the VPN back on transparently restores the live view.
async function resync() {
  if (resyncing) return;
  resyncing = true;
  try {
    let active;
    try {
      const r = await fetch("/api/jobs/active");
      active = r.ok ? await r.json() : undefined;
    } catch (_) {
      active = undefined; // backend unreachable — do NOT touch the UI
    }
    if (active === undefined) return; // keep current view, retry next tick

    if (!active.jobId) {
      // Backend confirms no job exists. Drop any stale "running" view.
      if (running || currentEs) {
        closeEs();
        currentJobId = null;
        setRunning(false);
        checkResume();
      }
      return;
    }

    if (active.status === "running") {
      const healthy = currentEs && currentJobId === active.jobId &&
        (Date.now() - lastEventTs) < STREAM_STALE_MS;
      if (healthy) return; // already watching this job on a live stream
      const snap = await fetchJson(`/api/jobs/${active.jobId}`);
      attachStream(active.jobId, snap);
      setStatusKey((snap && snap.dryRun) ? "status.liveSim" : "status.live", "run");
      return;
    }

    // Job finished while we were away: render its final state exactly once.
    if (currentJobId !== active.jobId || running) {
      const snap = await fetchJson(`/api/jobs/${active.jobId}`);
      if (snap) {
        closeEs();
        currentJobId = active.jobId;
        selectionTouched = false;
        renderJobFolders(snap.folders, snap.status);
        startStats(!!snap.dryRun);
        for (const line of (snap.lines || [])) pushLog(line);
        finalizeJob({
          status: snap.status, returnCode: snap.returnCode,
          startedAt: snap.startedAt, endedAt: snap.endedAt,
          progress: snap.progress,
        });
      }
    }
  } finally {
    resyncing = false;
  }
}

// If a job should be running but heartbeats have stopped (dropped VPN, slept
// laptop, dead proxy), force a resync to re-attach the live stream.
async function streamWatchdog() {
  if (!running) return;
  if (!currentEs || (Date.now() - lastEventTs) > STREAM_STALE_MS) {
    resync();
    return;
  }
  // Healthy stream: cheaply refresh the per-folder status (✅/⏳) and counters
  // without pulling the whole log back (since=huge => no log lines returned).
  const snap = await fetchJson(`/api/jobs/${currentJobId}?since=1000000000`);
  if (snap && running) {
    renderJobFolders(snap.folders, snap.status);
    if (snap.progress) applyProgress(snap.progress);
  }
}

function setRunning(v) {
  running = v;
  $import.disabled = v || collectSelection().length === 0;
  $dryRun.disabled = v;
  $cancel.hidden = !v;
}
// Localized status: retains the key/params so relocalize() can re-translate the
// status line when the language changes. Prefer this over setStatus().
function setStatusKey(key, cls, params) {
  lastStatus = { key, params, cls };
  $status.textContent = t(key, params);
  $status.className = "status " + (cls || "");
}
// Raw status text (already-built string, cannot be re-translated afterwards).
function setStatus(msg, cls) {
  lastStatus = { raw: msg, cls };
  $status.textContent = msg;
  $status.className = "status " + (cls || "");
}

// ---- language switch ------------------------------------------------------
function updateLangButton() {
  const cur = I18N.LANGS.find((l) => l.code === I18N.lang) || I18N.LANGS[0];
  $langCurrent.textContent = cur.code.toUpperCase();
  $langBtn.title = cur.label;
}

function buildLangMenu() {
  $langMenu.innerHTML = I18N.LANGS.map((l) => {
    const active = l.code === I18N.lang;
    return `<li role="option" data-lang="${l.code}"` +
      ` class="lang-option${active ? " active" : ""}"` +
      ` aria-selected="${active ? "true" : "false"}">` +
      `<span class="lang-flag" aria-hidden="true">${l.flag}</span>` +
      `<span class="lang-name">${l.label}</span>` +
      `<span class="lang-check" aria-hidden="true">${active ? "✓" : ""}</span>` +
      `</li>`;
  }).join("");
}

function openLangMenu() {
  buildLangMenu();
  $langMenu.hidden = false;
  $langBtn.setAttribute("aria-expanded", "true");
}
function closeLangMenu() {
  if ($langMenu.hidden) return;
  $langMenu.hidden = true;
  $langBtn.setAttribute("aria-expanded", "false");
}

function setupLangSwitch() {
  updateLangButton();
  $langBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if ($langMenu.hidden) openLangMenu(); else closeLangMenu();
  });
  $langMenu.addEventListener("click", (e) => {
    const li = e.target.closest("[data-lang]");
    if (!li) return;
    e.stopPropagation();
    I18N.setLang(li.dataset.lang);
    closeLangMenu();
    $langBtn.focus();
  });
  // Close on any outside click or Escape.
  document.addEventListener("click", () => closeLangMenu());
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$langMenu.hidden) { closeLangMenu(); $langBtn.focus(); }
  });
}

// ---- setup wizard entry points ---------------------------------------------
// Reopen the assistant on demand (gear button) to change the Immich server, the
// API key or the album mode. Cancellable, since a working config already exists.
async function reopenWizard() {
  if (!window.Wizard || !lastCfg) return;
  await new Promise((resolve) => {
    Wizard.open({
      initial: { url: lastCfg.immichUrl, albumMode: lastCfg.albumMode },
      onCancel: () => { Wizard.close(); resolve(); },
      onDone: resolve,
    });
  });
  await refreshConfig();
}

// Re-read the server config and repaint everything that depends on it.
async function refreshConfig() {
  const cfg = await fetchJson("/api/config");
  if (!cfg) return;
  lastCfg = cfg;
  renderMeta(cfg);
  // The connection may have changed: rebuild the tree against the new server.
  if (!running) {
    diskPresent = null;
    await pollDisk();
    refreshSelection();
  }
}

// Non-secret config bar (root / Immich URL / album mode / API-key warning).
function renderMeta(cfg) {
  // Bottom-left version tag: the container is built straight from GitHub, so
  // this is how you tell which build is actually running.
  $appVersion.textContent = cfg.version ? `v${cfg.version}` : "";
  const key = cfg.apiKeySet
    ? ""
    : ` · <span class="warn">${t("meta.apiKeyMissing")}</span>`;
  $meta.innerHTML =
    `${t("meta.root")} : <code>${escapeHtml(cfg.importRoot)}</code> · ` +
    `${t("meta.immich")} : <code>${escapeHtml(cfg.immichUrl)}</code> · ` +
    `${t("meta.albums")} : <code>${escapeHtml(cfg.albumMode)}</code>${key}`;
}

// Re-render every dynamic surface after a runtime language change — the vanilla
// equivalent of a framework re-render. Static [data-i18n] nodes are handled by
// I18N.setLang(); this covers everything built imperatively from retained state.
function relocalize() {
  updateLangButton();
  if (lastCfg) renderMeta(lastCfg);
  // Tree badge tooltips (folder names are data and stay; only titles localize).
  for (const node of nodes.values()) {
    if (node.recEl) node.recEl.title = t("badge.totalTitle");
  }
  // Selection panel: job folders vs this tab's checkbox selection — the choice
  // lives in refreshSelection(), which handles both cases.
  refreshSelection();
  // Live progress card / final recap card.
  if (S.active) applyProgress(S.lastProgress);
  else if (!$recap.hidden && S.recapData) renderRecap();
  // Status line — only re-translatable when it was set via a key.
  if (lastStatus && lastStatus.key) {
    setStatusKey(lastStatus.key, lastStatus.cls, lastStatus.params);
  }
  // Resume prompt: re-fetch + re-render if it is currently shown.
  if (!$resumePrompt.hidden) checkResume();
}

// ---- boot -----------------------------------------------------------------
async function boot() {
  setupLangSwitch();
  I18N.applyStatic(document);   // apply the detected language to static strings
  I18N.onChange(relocalize);    // re-render dynamic surfaces on every switch
  let cfg = await fetch("/api/config").then((r) => r.json());
  lastCfg = cfg;
  renderMeta(cfg);
  // First run: gate the whole app behind the setup wizard until a working
  // Immich connection has been validated and saved. Skipped when the connection
  // is locked by env vars (setupCompleted is then always true).
  if (!cfg.setupCompleted && !cfg.lockedByEnv && window.Wizard) {
    await new Promise((resolve) => {
      Wizard.open({
        initial: { url: cfg.immichUrl, albumMode: cfg.albumMode },
        onCancel: null, // no escape on first run — the app needs a connection
        onDone: async () => {
          cfg = await fetch("/api/config").then((r) => r.json());
          lastCfg = cfg;
          renderMeta(cfg);
          resolve();
        },
      });
    });
  }
  // The gear only makes sense when the UI is allowed to change the connection.
  if (!cfg.lockedByEnv) {
    $setupBtn.hidden = false;
    $setupBtn.addEventListener("click", reopenWizard);
  }
  // Initial disk check drives the first tree load (handles "no disk yet").
  await pollDisk();
  refreshSelection();
  setInterval(pollDisk, DISK_POLL_MS);
  // Independent of disk polling, watch the live stream's health: a VPN drop or
  // slept laptop can leave the SSE socket hung "open" for minutes without an
  // error, so if heartbeats stop we force a resync from the server.
  setInterval(streamWatchdog, 4000);
}

document.getElementById("reload").addEventListener("click", () => {
  nodes.clear();
  $tree.innerHTML = "";
  diskPresent = null; // force re-evaluation so the tree rebuilds
  pollDisk().then(refreshSelection);
});

boot();
