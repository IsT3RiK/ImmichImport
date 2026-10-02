"""Background import job manager driving the immich-go binary.

A single job runs at a time (imports touch the same Immich server). Each job
runs immich-go ONCE over every selected folder. immich-go starts by
downloading the whole Immich asset index and every album before it sends a
single file; running it once per folder repeated that preparation (and the
pause/resume of Immich's background jobs) for each folder.

Resilience: progress is tracked per folder and persisted to STATE_DIR after
every transition. A monitor thread watches the disk while the import runs; if
the disk is unplugged (or the container restarts mid-import) the job is marked
``interrupted`` and kept resumable. Resuming re-runs the folders not yet
``done`` — immich-go's per-file checksum dedup skips whatever was already
uploaded.

Live counters are taken from immich-go's own per-file events, streamed through
a FIFO as its JSON log (see ``_open_event_pipe``): every upload, duplicate and
error is counted as it happens, nothing is estimated. Its stdout progress line
only supplies the index-read percentage and the number of assets found.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import signal
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Literal

from . import config, fs, logging_setup, settings, state

log = logging_setup.get_logger("job")

JobStatus = Literal["running", "success", "error", "cancelled", "interrupted"]
FolderStatus = Literal["pending", "running", "done", "failed", "interrupted",
                       "cancelled"]

# Number of trailing log lines persisted so a resume prompt can show context.
_LOG_TAIL = 40
# Cap the in-memory live log. It only bounds what a reconnecting window can
# scroll back through - every line is ALSO written to stdout (docker logs), so
# raising it costs memory, never history. 300 was far too low to diagnose a
# job: immich-go emits a progress line twice a second, so the end-of-folder
# report scrolled out of reach within minutes.
_LOG_KEEP = int(os.environ.get("LOG_KEEP") or 20000)
# Per-file errors kept in memory for the UI. The full list always stays on disk
# in the job's .jsonl file, so this cap only bounds what the recap can list.
_ERR_KEEP = 500
# Generic (file-less) problems kept, deduplicated: "failed to create album",
# "<folder>: file does not exist"...
_ISSUE_KEEP = 50
# Attribute keys immich-go uses to carry the error text. It logs "error" from
# RecordAssetError but plain "err" from Log().Error("Error", "err", …) — reading
# only the first one left half the list with an empty reason.
_ERR_KEYS = ("error", "err", "reason", "message")
# Never rendered: they describe the record itself, not the problem.
_META_KEYS = {"time", "level", "msg", "file", "source"}
# immich-go log directories retained under STATE_DIR (one per job).
_JOB_LOG_DIRS_KEEP = 10
# How long immich-go gets to shut down cleanly after SIGINT (resume Immich's
# background jobs, flush pending album additions) before it is killed.
_STOP_GRACE = 90.0
# immich-go's final error when the run went to the end but some files failed
# (with --on-errors=continue). Any other final error means the run itself broke.
_FILE_ERRORS_ONLY = "Some errors have occurred"

# immich-go (--no-ui) prints a progress line ~every 500ms. "Immich read" is the
# share of the SERVER's asset index downloaded so far — not the local disk.
_RE_LIVE = re.compile(
    r"Immich read (\d+)%, Assets found: (\d+), Upload errors: (\d+), Uploaded (\d+)"
)
_RE_REPORT = re.compile(r"^\s*(.+?)\s*:\s*(\d+)\b")
_RE_IMPORTING = re.compile(r"=== Importing '(.*)' ===")
# Characters immich-go reads as a glob pattern in a path argument
# (fshelper.HasMagic, Unix): such a path is expanded instead of opened, so a
# folder such as "Vacances [2013]" matches nothing - or another folder. There
# is no escape syntax; see _immich_go_arg.
_GLOB_MAGIC = re.compile(r"[*?\[\\]")
_GLOB_SAFE = str.maketrans({"[": "(", "]": ")", "*": "_", "?": "_", "\\": "_"})

# immich-go event names (fileevent.Code.String(), v0.32.0) -> our counters.
# The same strings are the event "msg" in its JSON log AND the labels of its
# end-of-run report, so both sources share this table. Keep it in sync when
# bumping immich-go. The "discovered ..." ones describe what the SCAN dropped
# before any upload; they explain an "announced vs found" gap.
_EVENT_KEYS = {
    "uploaded successfully": "uploaded",
    "server asset upgraded": "upgraded",
    "server has duplicate": "server_dup",
    "discarded server better": "server_dup",
    "discarded local duplicate": "local_dup",
    "discarded unsupported": "unsupported",
    "discarded banned": "filtered",
    "discarded filtered": "filtered",
    "discarded not selected": "filtered",
    "upload failed": "errors",
    "server error": "errors",
    "file access error": "errors",
    "incomplete processing": "errors",
    "discovered banned file": "disc_banned",
    "discovered unknown file": "disc_unknown",
    "discovered unsupported file": "disc_unsupported",
}
_COUNTERS = ("uploaded", "upgraded", "server_dup", "local_dup", "unsupported",
             "filtered", "errors", "disc_banned", "disc_unknown",
             "disc_unsupported")


class Progress:
    """Authoritative live tally of one immich-go run.

    Two sources, in order of preference:

    * ``event()`` — immich-go's per-file events, streamed live from its JSON
      log. Exact, including duplicates, as they happen.
    * ``feed()`` — its stdout: the live progress line (index read %, assets
      found, uploads) and, as a fallback when the event stream is unavailable,
      the end-of-run report.

    Duplicates are never guessed: a figure is shown only once immich-go has
    reported it.
    """

    def __init__(self) -> None:
        self.ev = dict.fromkeys(_COUNTERS, 0)
        self.live_events = False
        self.rep_raw: dict[str, int] = {}
        self.found = 0
        self.live_uploaded = 0
        self.live_errors = 0
        self.read_pct = 0
        # immich-go prints "Immich read 100%" until it knows the size of the
        # index, so 100 % means nothing until a lower value has been seen.
        self.index_partial = False
        self.index_done = False
        self.albums_read = 0
        self.expected = 0  # assets announced by the tree for this run
        self.current_folder: str | None = None

    def feed(self, line: str) -> None:
        mi = _RE_IMPORTING.search(line)
        if mi:
            self.current_folder = mi.group(1)
            return
        m = _RE_LIVE.search(line)
        if m:
            self.read_pct = int(m.group(1))
            if self.read_pct < 100:
                self.index_partial = True
            elif self.index_partial:
                self.index_done = True
            self.found = int(m.group(2))
            self.live_errors = int(m.group(3))
            self.live_uploaded = int(m.group(4))
            return
        rl = _RE_REPORT.match(line)
        if rl:
            label = rl.group(1).strip().lower()
            if label in _EVENT_KEYS:
                self.rep_raw[label] = int(rl.group(2))

    def event(self, rec: dict) -> None:
        msg = str(rec.get("msg") or "")
        key = _EVENT_KEYS.get(msg)
        if key:
            self.ev[key] += 1
            self.live_events = True
        elif msg.startswith("Assets on the server"):
            self.index_done = True
        elif msg == "got album from the server":
            self.albums_read += 1

    def _counts(self) -> dict:
        if self.live_events:
            return dict(self.ev)
        c = dict.fromkeys(_COUNTERS, 0)
        if self.rep_raw:
            for label, val in self.rep_raw.items():
                c[_EVENT_KEYS[label]] += val
        else:
            c["uploaded"] = self.live_uploaded
            c["errors"] = self.live_errors
        return c

    def as_dict(self) -> dict:
        c = self._counts()
        dups = c["server_dup"] + c["local_dup"]
        processed = (c["uploaded"] + c["upgraded"] + dups + c["unsupported"]
                     + c["filtered"] + c["errors"])
        # The tree's count is known up-front; immich-go's "found" grows as it
        # discovers files. Whichever is larger is the honest target.
        target = max(self.expected, self.found)
        remaining = max(target - processed, 0)
        pct = min(100, round(processed / target * 100)) if target > 0 else 0
        if processed == 0 and not self.index_done:
            phase = "index"
        elif processed == 0:
            phase = "albums"
        else:
            phase = "upload"
        disc = c["disc_banned"] + c["disc_unknown"] + c["disc_unsupported"]
        return {
            "found": self.found, "expected": self.expected, "target": target,
            "uploaded": c["uploaded"], "errors": c["errors"],
            "dups": dups, "serverDup": c["server_dup"],
            "localDup": c["local_dup"], "upgraded": c["upgraded"],
            "unsupported": c["unsupported"], "filtered": c["filtered"],
            "processed": processed, "remaining": remaining, "pct": pct,
            "phase": phase,
            "readPct": self.read_pct if self.index_partial else 0,
            "albumsRead": self.albums_read,
            # Scan-side exclusions: files immich-go saw on disk and dropped
            # before any upload was attempted.
            "discBanned": c["disc_banned"],
            "discUnknown": c["disc_unknown"],
            "discUnsupported": c["disc_unsupported"],
            "discSkipped": disc,
            "currentFolder": self.current_folder,
        }


@dataclass
class Folder:
    path: str
    status: FolderStatus = "pending"

    def to_dict(self) -> dict:
        return {"path": self.path, "status": self.status}


@dataclass
class Job:
    id: str
    folders: list[Folder]
    status: JobStatus = "running"
    dry_run: bool = False
    logs: list[str] = field(default_factory=list)
    log_total: int = 0
    # Per-file failures, extracted from immich-go's JSON log (see _record_error).
    errors: list[dict] = field(default_factory=list)
    errors_total: int = 0
    # File-less problems, deduplicated: {key: {kind, detail, count}}
    issues: dict = field(default_factory=dict)
    # Failed files per selected folder, to tell which folders are incomplete.
    folder_errors: dict = field(default_factory=dict)
    progress: Progress = field(default_factory=Progress)
    return_code: int | None = None
    started_at: float = field(default_factory=time.time)
    ended_at: float | None = None
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    _proc: subprocess.Popen | None = field(default=None, repr=False)
    _cancel: bool = False
    _interrupted: bool = False
    _stop_sent: bool = False
    _file_errors_only: bool = False
    _current_roots: list = field(default_factory=list, repr=False)
    _run_seq: int = field(default=0, repr=False)
    _done: threading.Event = field(default_factory=threading.Event, repr=False)

    @property
    def paths(self) -> list[str]:
        return [f.path for f in self.folders]

    # Prefixes emitted by this module, as opposed to raw immich-go output -
    # which is far too chatty (two progress lines a second) to sit at INFO.
    _LEVELS = (("[error]", logging.ERROR), ("[warn]", logging.WARNING),
               ("[info]", logging.INFO), ("[ok]", logging.INFO),
               ("[cmd]", logging.INFO))

    def log(self, line: str) -> None:
        clean = line.rstrip("\n")
        stripped = clean.strip()
        # Mirror to stdout so `docker logs` tells the whole story; the in-memory
        # buffer only feeds the UI.
        if stripped:
            level = logging.DEBUG
            for prefix, lvl in self._LEVELS:
                if stripped.startswith(prefix):
                    level = lvl
                    break
            log.log(level, "job=%s %s", self.id, stripped)
        with self._lock:
            self.logs.append(clean)
            self.log_total += 1
            # Bound the buffer: keep only the most recent lines.
            if len(self.logs) > _LOG_KEEP:
                del self.logs[0:len(self.logs) - _LOG_KEEP]
            self.progress.feed(clean)

    def on_event(self, rec: dict) -> None:
        with self._lock:
            self.progress.event(rec)

    def _progress_dict(self) -> dict:
        done = sum(1 for f in self.folders if f.status == "done")
        return {**self.progress.as_dict(),
                "totalFolders": len(self.folders), "doneFolders": done}

    def persist(self) -> None:
        """Write a durable snapshot of progress to STATE_DIR (best-effort)."""
        with self._lock:
            snap = {
                "id": self.id,
                "status": self.status,
                "dryRun": self.dry_run,
                "returnCode": self.return_code,
                "folders": [f.to_dict() for f in self.folders],
                "startedAt": self.started_at,
                "endedAt": self.ended_at,
                "updatedAt": time.time(),
                "logTail": self.logs[-_LOG_TAIL:],
                "progress": self._progress_dict(),
            }
        state.save_current(snap)

    def counts(self) -> dict:
        done = sum(1 for f in self.folders if f.status == "done")
        return {
            "total": len(self.folders),
            "done": done,
            "remaining": len(self.folders) - done,
        }

    def active_view(self) -> dict:
        """Lightweight view (no log lines) for /api/jobs/active — lets a
        reconnecting window render the live counters immediately."""
        with self._lock:
            return {
                "jobId": self.id,
                "status": self.status,
                "dryRun": self.dry_run,
                "returnCode": self.return_code,
                "paths": [f.path for f in self.folders],
                "folders": [f.to_dict() for f in self.folders],
                "startedAt": self.started_at,
                "endedAt": self.ended_at,
                "progress": self._progress_dict(),
            }

    def errors_view(self, limit: int = 200) -> dict:
        """The list behind the "N errors" figure: which files failed, and why.

        A bare count is unactionable — you cannot retry, fix or ignore what you
        cannot name. ``total`` is the real number of failures; ``errors`` is
        capped so a run that fails on thousands of files still answers fast.
        """
        with self._lock:
            return {
                "jobId": self.id,
                "total": self.errors_total,
                "kept": len(self.errors),
                "errors": self.errors[:max(limit, 0)],
                "issues": sorted(self.issues.values(),
                                 key=lambda i: i["count"], reverse=True),
            }

    def snapshot(self, since: int = 0) -> dict:
        with self._lock:
            base = self.log_total - len(self.logs)  # absolute index of logs[0]
            start = max(since - base, 0)
            return {
                "id": self.id,
                "status": self.status,
                "dryRun": self.dry_run,
                "returnCode": self.return_code,
                "paths": [f.path for f in self.folders],
                "folders": [f.to_dict() for f in self.folders],
                "startedAt": self.started_at,
                "endedAt": self.ended_at,
                "totalLines": self.log_total,
                "lines": self.logs[start:],
                "progress": self._progress_dict(),
            }


class JobManager:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._jobs: dict[str, Job] = {}
        self._active: str | None = None

    def get(self, job_id: str) -> Job | None:
        return self._jobs.get(job_id)

    @property
    def active_job(self) -> Job | None:
        with self._lock:
            return self._jobs.get(self._active) if self._active else None

    def _is_running(self) -> bool:
        return bool(self._active and self._jobs[self._active].status == "running")

    def is_running(self) -> bool:
        with self._lock:
            return self._is_running()

    # -- start / resume -----------------------------------------------------
    def start(self, paths: list[str], dry_run: bool = False) -> Job:
        """Start a fresh import over the (deduped) selection, discarding any
        previously persisted interrupted state."""
        with self._lock:
            if self._is_running():
                raise RuntimeError("an import is already running")
            deduped = fs.dedup_selection(paths)
            if not deduped:
                raise ValueError("no folder selected")
            state.clear_current()
            job = Job(id=uuid.uuid4().hex[:12],
                      folders=[Folder(p) for p in deduped],
                      dry_run=dry_run)
            self._jobs[job.id] = job
            self._active = job.id
        log.info("job=%s start dryRun=%s folders=%s", job.id, dry_run,
                 ", ".join(p or "<root>" for p in job.paths))
        self._prune_log_dirs()
        job.persist()
        threading.Thread(target=self._run, args=(job,), daemon=True).start()
        return job

    def resume(self) -> Job:
        """Resume a persisted interrupted import: keep ``done`` folders, re-run
        the rest (pending / failed / interrupted)."""
        persisted = state.load_current()
        with self._lock:
            if self._is_running():
                raise RuntimeError("an import is already running")
            if not persisted or not self._is_resumable(persisted):
                raise ValueError("no resumable import")
            folders = [
                Folder(f["path"], f.get("status", "pending"))
                for f in persisted.get("folders", [])
                if f.get("path") is not None
            ]
            if not any(f.status != "done" for f in folders):
                raise ValueError("nothing left to resume")
            job = Job(id=persisted.get("id") or uuid.uuid4().hex[:12],
                      folders=folders,
                      dry_run=bool(persisted.get("dryRun", False)))
            self._jobs[job.id] = job
            self._active = job.id
        log.info("job=%s resume folders=%s", job.id,
                 ", ".join(p or "<root>" for p in job.paths))
        job.persist()
        threading.Thread(target=self._run, args=(job, True), daemon=True).start()
        return job

    @staticmethod
    def _is_resumable(persisted: dict) -> bool:
        # "running" persisted means the container died mid-import -> resumable.
        if persisted.get("status") not in ("interrupted", "running"):
            return False
        folders = persisted.get("folders", [])
        return any(f.get("status") != "done" for f in folders)

    def resumable(self) -> dict | None:
        """Describe a persisted interrupted import for the resume prompt, or None."""
        if self.is_running():
            return None
        persisted = state.load_current()
        if not persisted or not self._is_resumable(persisted):
            return None
        folders = persisted.get("folders", [])
        done = sum(1 for f in folders if f.get("status") == "done")
        return {
            "id": persisted.get("id"),
            "status": persisted.get("status"),
            "dryRun": bool(persisted.get("dryRun", False)),
            "total": len(folders),
            "done": done,
            "remaining": len(folders) - done,
            "folders": folders,
            "updatedAt": persisted.get("updatedAt"),
            "logTail": persisted.get("logTail", []),
        }

    def discard_resumable(self) -> bool:
        if self.is_running():
            return False
        state.clear_current()
        return True

    def cancel(self, job_id: str) -> bool:
        job = self._jobs.get(job_id)
        if not job or job.status != "running":
            return False
        job._cancel = True
        self._stop_proc(job)
        return True

    def _stop_proc(self, job: Job) -> None:
        """Ask immich-go to stop the way it expects: SIGINT (Ctrl+C).

        immich-go pauses Immich's background jobs (thumbnails, metadata, video
        conversion, faces, smart search) for the duration of the upload and
        batches album additions. Only its SIGINT handler runs the shutdown that
        resumes those jobs and flushes the albums — SIGTERM kills it on the
        spot, leaving the server's jobs paused and recent photos out of their
        album. It is killed only if it ignores the request for too long.
        """
        proc = job._proc
        if not proc or proc.poll() is not None or job._stop_sent:
            return
        job._stop_sent = True
        job.log("[info] Arrêt d'immich-go en cours (reprise des tâches Immich, "
                "enregistrement des albums)…")
        try:
            proc.send_signal(signal.SIGINT)
        except OSError:
            return

        def _reap() -> None:
            try:
                proc.wait(timeout=_STOP_GRACE)
            except subprocess.TimeoutExpired:
                job.log("[warn] immich-go ne répond pas : arrêt forcé. Vérifie "
                        "dans Immich (Administration > Tâches) qu'aucune tâche "
                        "n'est restée en pause.")
                proc.kill()

        threading.Thread(target=_reap, daemon=True).start()

    # -- command building ---------------------------------------------------
    def _build_cmd(self, job: Job, abs_paths: list[str], log_file: str,
                   log_level: str) -> list[str]:
        album = settings.album_mode()
        cmd = [
            config.IMMICH_GO_BIN, "upload", "from-folder",
            "--no-ui",
            "--server", settings.immich_url(),
            "--api-key", settings.immich_api_key(),
            "--recursive",
            # Never let one server hiccup truncate the whole import (see
            # config.ON_ERRORS). immich-go's default is "stop".
            f"--on-errors={config.ON_ERRORS}",
        ]
        # Forward OUR extra exclusions to immich-go so both sides filter the
        # same set, from the same source of truth (config.EXTRA_BANNED_PATTERNS
        # is also what fs.py counts with). --ban-file APPENDS to immich-go's
        # built-in defaults; it cannot remove them, so a default such as
        # "thumbnails/" stays banned inside immich-go whatever we pass - which
        # is why config.BANNED replays those defaults instead of pretending the
        # app could lift them.
        for pattern in config.EXTRA_BANNED_PATTERNS:
            cmd.append(f"--ban-file={pattern}")
        if album and album != "NONE":
            cmd.append(f"--folder-as-album={album}")
        if job.dry_run and "--dry-run" not in config.IMMICH_GO_EXTRA_ARGS:
            cmd.append("--dry-run")
        # immich-go writes its per-file events to a LOG FILE, never to stdout.
        # JSON so it can be parsed exactly. INFO when it goes to the live event
        # pipe (nothing hits the disk); ERROR when it is a plain file, so a
        # 250 000-file import doesn't write a gigabyte of INFO lines.
        cmd.extend(["--log-file", log_file,
                    "--log-type", "JSON",
                    "--log-level", log_level])
        cmd.extend(config.IMMICH_GO_EXTRA_ARGS)
        cmd.extend(abs_paths)
        return cmd

    @staticmethod
    def _job_log_dir(job: Job):
        d = config.STATE_DIR / "logs" / job.id
        d.mkdir(parents=True, exist_ok=True)
        return d

    @staticmethod
    def _prune_log_dirs() -> None:
        """Keep only the most recent job log directories (best-effort)."""
        base = config.STATE_DIR / "logs"
        try:
            dirs = sorted((d for d in base.iterdir() if d.is_dir()),
                          key=lambda d: d.stat().st_mtime, reverse=True)
        except OSError:
            return
        for old in dirs[_JOB_LOG_DIRS_KEEP:]:
            shutil.rmtree(old, ignore_errors=True)

    @staticmethod
    def _open_event_pipe(path) -> tuple[int, int] | None:
        """Create the FIFO immich-go will use as its log file.

        Returns (read_fd, keeper_write_fd), or None when FIFOs are unavailable
        (the caller then falls back to a plain ERROR-level log file). The
        keeper write end stays open until immich-go has exited, so the reader
        never sees a premature end-of-file — and is never left blocked if
        immich-go dies before opening its log.
        """
        if not hasattr(os, "mkfifo"):
            return None
        try:
            if os.path.lexists(path):
                os.unlink(path)
            os.mkfifo(path, 0o600)
            rfd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
            try:
                wfd = os.open(path, os.O_WRONLY)
            except OSError:
                os.close(rfd)
                raise
            os.set_blocking(rfd, True)
            return rfd, wfd
        except OSError as exc:
            log.warning("event pipe unavailable (%s) — falling back to a log "
                        "file; duplicates will only be counted at the end", exc)
            try:
                os.unlink(path)
            except OSError:
                pass
            return None

    @staticmethod
    def _resolve_logged_file(raw: str, roots: list[tuple[str, str, str]]
                             ) -> tuple[str, str | None]:
        """Turn immich-go's "<fsname>:<relative>" into (absolute, folder).

        ``roots`` holds (folder, real absolute path, argument given to
        immich-go). immich-go names each filesystem after the base name of its
        argument, so "Photos:2020/img.jpg" means <root>/2020/img.jpg for the
        argument ending with "Photos". Two selected folders can share a name;
        the file's existence then decides. Anything that doesn't fit is passed
        through untouched rather than guessed.
        """
        raw = (raw or "").replace("\\", "/")
        head, sep, tail = raw.partition(":")
        if not sep:
            return raw, None
        matches = [(rel, ab) for rel, ab, arg in roots
                   if os.path.basename(arg.rstrip("/")) == head]
        if not matches and len(roots) == 1 and not os.path.isabs(raw):
            matches = [(roots[0][0], roots[0][1])]
        for rel, ab in matches:
            full = os.path.join(ab, tail)
            if len(matches) == 1 or os.path.exists(full):
                return full, rel
        return raw, None

    @staticmethod
    def _error_detail(rec: dict) -> str:
        """Extract the human-readable reason from one log record.

        immich-go is not consistent about the attribute it puts the error in, so
        the known keys are tried in order and anything else it attached (album
        name, path...) is appended rather than dropped.
        """
        for key in _ERR_KEYS:
            val = rec.get(key)
            if isinstance(val, str) and val:
                return val
            if val:
                return str(val)
        extra = [f"{k}={v}" for k, v in rec.items()
                 if k not in _META_KEYS and not isinstance(v, (dict, list))]
        return ", ".join(extra)

    def _record_error(self, job: Job, rec: dict,
                      roots: list[tuple[str, str, str]]) -> bool:
        """Record one ERROR-level log record. Returns True for a file error.

        Two shapes come out of that log and they must not be mixed:

        * records carrying a ``file`` — one failed photo or video, listed
          individually with its size;
        * records without one ("failed to create album", "<dir>: file does not
          exist") — a general problem, deduplicated with a count, because a
          hundred identical lines say nothing more than one.

        ``context canceled`` is dropped outright: when an upload dies, every
        pending transfer reports it, and immich-go filters that same noise out
        of its own output.

        Sizes are stat'ed here, while the disk is still mounted: immich-go logs
        the file and the error but not the size, and the recap is read long
        after the run.
        """
        kind = str(rec.get("msg") or "")
        detail = self._error_detail(rec)
        if "context canceled" in (kind + " " + detail).lower():
            return False
        if kind.startswith(_FILE_ERRORS_ONLY):
            # The run's closing summary, not a problem of its own.
            job._file_errors_only = True
            return False

        raw = rec.get("file")
        if isinstance(raw, dict):  # assets.Asset logs a group
            raw = raw.get("FileName") or raw.get("OriginalFileName") or ""
        if not isinstance(raw, str):
            raw = ""

        if not raw:
            # No file: a general problem. Fold identical ones together.
            key = f"{kind}\n{detail}"
            with job._lock:
                entry = job.issues.get(key)
                if entry:
                    entry["count"] += 1
                elif len(job.issues) < _ISSUE_KEEP:
                    job.issues[key] = {"kind": kind, "detail": detail,
                                       "count": 1}
            return False

        full, folder = self._resolve_logged_file(raw, roots)
        rel = raw
        if folder is not None:
            try:
                rel = os.path.relpath(full, config.IMPORT_ROOT).replace("\\", "/")
            except ValueError:
                rel = full
        size = None
        try:
            size = os.path.getsize(full)
        except OSError:
            pass
        with job._lock:
            job.errors_total += 1
            if folder is not None:
                job.folder_errors[folder] = job.folder_errors.get(folder, 0) + 1
            if len(job.errors) < _ERR_KEEP:
                job.errors.append({
                    "name": os.path.basename(rel) or rel,
                    "path": rel,
                    "size": size,
                    "kind": kind,
                    "detail": detail,
                    "time": rec.get("time") or "",
                })
        return True

    @staticmethod
    def _immich_go_arg(job: Job, abs_path: str, link_dir) -> str:
        """The path to hand immich-go for ``abs_path``.

        immich-go expands any argument containing * ? [ or \\ as a glob
        pattern, and offers no way to escape them. Such a folder is passed
        through a symbolic link with a plain name instead. The link's name is
        the folder's own name with those characters replaced, because
        immich-go names the album of the files sitting directly in the folder
        (and the first level of a PATH album) after its argument.
        """
        if not _GLOB_MAGIC.search(abs_path):
            return abs_path
        name = os.path.basename(abs_path.rstrip("/"))
        safe = name.translate(_GLOB_SAFE) if _GLOB_MAGIC.search(name) else name
        link = link_dir / safe
        try:
            link_dir.mkdir(parents=True, exist_ok=True)
            os.symlink(abs_path, link)
        except OSError as exc:
            job.log(f"[warn] Impossible de contourner les caractères spéciaux "
                    f"de '{abs_path}' ({exc}) : immich-go risque de ne pas "
                    f"trouver ce dossier.")
            return abs_path
        if safe != name:
            job.log(f"[info] '{name}' contient des caractères qu'immich-go lit "
                    f"comme un motif ([ ] * ? \\) : il lui est transmis sous le "
                    f"nom '{safe}', qui sera aussi celui de son album.")
        return str(link)

    @staticmethod
    def _parse_record(line: str) -> dict | None:
        line = line.strip()
        if not line.startswith("{"):
            return None
        try:
            rec = json.loads(line)
        except ValueError:
            return None
        return rec if isinstance(rec, dict) else None

    def _read_events(self, job: Job, rfd: int, keep_file,
                     roots: list[tuple[str, str, str]]) -> None:
        """Drain immich-go's live JSON log. It must never stop reading: a full
        pipe would block immich-go itself, so every record is handled in its
        own try."""
        try:
            keep = open(keep_file, "a", encoding="utf-8")
        except OSError:
            keep = None
        try:
            with os.fdopen(rfd, "r", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    try:
                        rec = self._parse_record(line)
                        if rec is None:
                            continue
                        job.on_event(rec)
                        if str(rec.get("level", "")).upper() == "ERROR":
                            if keep:
                                keep.write(line.strip() + "\n")
                            self._record_error(job, rec, roots)
                    except Exception:  # noqa: BLE001 - keep draining
                        log.exception("job=%s bad event record", job.id)
        except Exception:  # noqa: BLE001
            log.exception("job=%s event reader crashed", job.id)
        finally:
            if keep:
                keep.close()

    def _collect_errors(self, job: Job, log_file,
                        roots: list[tuple[str, str, str]]) -> None:
        """Fallback without the event pipe: read the ERROR log back after the
        run."""
        try:
            fh = open(log_file, encoding="utf-8", errors="replace")
        except OSError:
            return
        with fh:
            for line in fh:
                rec = self._parse_record(line)
                if rec and str(rec.get("level", "")).upper() == "ERROR":
                    self._record_error(job, rec, roots)

    @staticmethod
    def _redacted(cmd: list[str]) -> str:
        out = []
        redact_next = False
        for tok in cmd:
            if redact_next:
                out.append("***")
                redact_next = False
            elif tok == "--api-key":
                out.append(tok)
                redact_next = True
            else:
                out.append(tok)
        return " ".join(out)

    # -- disk monitor -------------------------------------------------------
    def _monitor(self, job: Job) -> None:
        """Interrupt the import if the disk being read disappears."""
        while not job._done.wait(config.DISK_MONITOR_INTERVAL):
            if job._cancel or job._interrupted:
                return
            current = list(job._current_roots)
            # Only meaningful while immich-go is actually running.
            if not current:
                continue
            gone = any(not os.path.exists(p) for p in current)
            if not gone:
                # Fallback: the whole root went empty (parent unmounted).
                try:
                    gone = not fs.root_status().get("present", True)
                except Exception:  # noqa: BLE001
                    gone = False
            if gone:
                job._interrupted = True
                job.log("[warn] Disque débranché — interruption de l'import. "
                        "Rebranche le disque pour reprendre.")
                self._stop_proc(job)
                return

    def _compute_expected(self, job: Job, paths: list[str]) -> None:
        """Count, from the tree, the assets this run is about to import.

        Runs alongside immich-go's index download (a network phase), and the
        counts are usually already cached from browsing the tree.
        """
        total = 0
        for p in paths:
            try:
                d = fs.recursive_count(p)
                total += d["photos"] + d["videos"]
            except Exception:  # noqa: BLE001 - one bad folder must not hide the rest
                log.debug("job=%s count failed for %r", job.id, p)
        with job._lock:
            job.progress.expected = total

    # -- run ----------------------------------------------------------------
    def _run(self, job: Job, resuming: bool = False) -> None:
        monitor = threading.Thread(target=self._monitor, args=(job,), daemon=True)
        monitor.start()
        try:
            if not settings.immich_api_key():
                job.log("[error] IMMICH_API_KEY is not set — aborting.")
                job.status = "error"
                return

            todo = [f for f in job.folders if f.status != "done"]
            if resuming:
                already = len(job.folders) - len(todo)
                job.log(f"[info] Reprise de l'import : {already} dossier(s) déjà "
                        f"terminé(s), {len(todo)} restant(s).")
            if job.dry_run:
                job.log("[info] 🧪 Mode SIMULATION (--dry-run) : immich-go "
                        "n'enverra AUCUN fichier, aucune modification dans Immich.")
            job.log(f"[info] Starting import of {len(todo)} folder(s).")

            runnable: list[tuple[Folder, str]] = []
            for folder in todo:
                try:
                    abs_path = str(fs.safe_resolve(folder.path))
                except fs.UnsafePathError as exc:
                    job.log(f"[error] Skipping unsafe path {folder.path!r}: {exc}")
                    folder.status = "failed"
                    continue
                # Guard: the folder must actually be present (disk plugged in).
                if not os.path.exists(abs_path):
                    job._interrupted = True
                    job.log(f"[warn] Dossier introuvable (disque absent ?) : "
                            f"'{folder.path or '<root>'}'. Import interrompu.")
                    break
                runnable.append((folder, abs_path))

            if runnable and not job._interrupted and not job._cancel:
                for folder, _ in runnable:
                    folder.status = "running"
                job.persist()
                threading.Thread(target=self._compute_expected,
                                 args=(job, [f.path for f, _ in runnable]),
                                 daemon=True).start()
                label = " · ".join(f.path or "<root>" for f, _ in runnable)
                job.log(f"\n[info] === Importing '{label}' ===")
                rc = self._run_immich_go(job, runnable)
                self._settle_folders(job, runnable, rc)
                job.persist()

            if job._interrupted:
                job.status = "interrupted"
                remaining = sum(1 for f in job.folders if f.status != "done")
                job.log(f"\n[warn] Import interrompu. {remaining} dossier(s) "
                        f"restant(s) — rebranche le disque pour reprendre.")
            elif job._cancel:
                job.log("[warn] Cancelled by user.")
                job.status = "cancelled"
            else:
                done = sum(1 for f in job.folders if f.status == "done")
                failed = sum(1 for f in job.folders if f.status == "failed")
                job.return_code = 1 if failed else 0
                job.status = "error" if failed else "success"
                job.log(f"\n[info] Done. {done}/{len(job.folders)} folder(s) succeeded.")
        except Exception as exc:  # noqa: BLE001 - surface any crash into logs
            job.log(f"[error] Import crashed: {exc!r}")
            job.status = "error"
        finally:
            job.ended_at = time.time()
            job._done.set()
            job._current_roots = []
            prog = job.progress.as_dict()
            log.info(
                "job=%s end status=%s found=%d uploaded=%d dups=%d errors=%d "
                "banned=%d unknown=%d unsupported=%d",
                job.id, job.status, prog["found"], prog["uploaded"],
                prog["dups"], prog["errors"], prog["discBanned"],
                prog["discUnknown"], prog["discUnsupported"],
            )
            job.persist()
            # Clean terminal states clear the resume state; interrupted keeps it.
            if job.status in ("success", "cancelled"):
                state.clear_current()

    def _settle_folders(self, job: Job, runnable: list[tuple[Folder, str]],
                        rc: int) -> None:
        """Give each folder of the run its final status.

        With --on-errors=continue, immich-go goes to the end and still exits
        non-zero when any file failed. Only the folders holding those files are
        then incomplete; a non-zero exit for any other reason means the run
        itself broke, and every folder must be re-run.
        """
        folders = [f for f, _ in runnable]
        if job._interrupted:
            new = {f.path: "interrupted" for f in folders}
        elif job._cancel:
            new = {f.path: "cancelled" for f in folders}
        elif rc == 0:
            new = {f.path: "done" for f in folders}
        elif job._file_errors_only and any(job.folder_errors.get(f.path)
                                           for f in folders):
            new = {f.path: ("failed" if job.folder_errors.get(f.path) else "done")
                   for f in folders}
        else:
            new = {f.path: "failed" for f in folders}
            job.log(f"[error] immich-go exited with code {rc}.")
        for f in folders:
            f.status = new[f.path]
            label = f.path or "<root>"
            if f.status == "done":
                job.log(f"[ok] Finished '{label}'.")
            elif f.status == "failed" and job.folder_errors.get(f.path):
                job.log(f"[warn] '{label}' : {job.folder_errors[f.path]} "
                        f"fichier(s) en erreur.")

    def _run_immich_go(self, job: Job, runnable: list[tuple[Folder, str]]) -> int:
        job._run_seq += 1
        log_dir = self._job_log_dir(job)
        keep_file = log_dir / f"{job._run_seq:03d}.jsonl"
        pipe_path = log_dir / f"{job._run_seq:03d}.pipe"
        abs_paths = [ab for _, ab in runnable]
        link_root = log_dir / f"{job._run_seq:03d}.links"
        # One sub-directory per folder: two folders may end up with the same
        # link name.
        args = [self._immich_go_arg(job, ab, link_root / str(i))
                for i, ab in enumerate(abs_paths)]
        roots = [(f.path, ab, arg) for (f, ab), arg in zip(runnable, args)]

        pipe = self._open_event_pipe(pipe_path)
        if pipe:
            cmd = self._build_cmd(job, args, str(pipe_path), "INFO")
        else:
            cmd = self._build_cmd(job, args, str(keep_file), "ERROR")
        job.log(f"[cmd] {self._redacted(cmd)}")

        reader = None
        try:
            if pipe:
                reader = threading.Thread(target=self._read_events,
                                          args=(job, pipe[0], keep_file, roots),
                                          daemon=True)
                reader.start()
            try:
                proc = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    bufsize=1,
                )
            except FileNotFoundError:
                job.log(f"[error] immich-go binary not found at {config.IMMICH_GO_BIN}")
                return 127
            job._proc = proc
            job._current_roots = abs_paths
            assert proc.stdout is not None
            for line in proc.stdout:
                job.log(line)
                if _FILE_ERRORS_ONLY in line:
                    job._file_errors_only = True
                if job._cancel or job._interrupted:
                    self._stop_proc(job)
            proc.wait()
            return proc.returncode
        finally:
            if pipe:
                os.close(pipe[1])  # immich-go is gone: let the reader hit EOF
                if reader:
                    reader.join(timeout=30)
                try:
                    os.unlink(pipe_path)
                except OSError:
                    pass
            else:
                # Before clearing _current_roots: the disk must still be
                # mounted to stat the failed files.
                self._collect_errors(job, keep_file, roots)
            shutil.rmtree(link_root, ignore_errors=True)  # the links, never their targets
            job._proc = None
            job._current_roots = []
            if job.errors_total:
                job.log(f"[warn] {job.errors_total} fichier(s) en erreur — "
                        f"détail dans le récapitulatif.")


manager = JobManager()
