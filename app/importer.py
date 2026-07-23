"""Background import job manager driving the immich-go binary.

A single job runs at a time (imports touch the same Immich server). Each job
runs immich-go once per selected folder, streaming combined stdout/stderr into
an in-memory log buffer exposed via polling or SSE.

Resilience: progress is tracked per folder and persisted to STATE_DIR after
every transition. A monitor thread watches the disk while the import runs; if
the disk is unplugged (or the container restarts mid-import) the job is marked
``interrupted`` and kept resumable. Resuming re-runs only the folders not yet
``done`` — immich-go's per-file checksum dedup skips whatever was already
uploaded inside a partially-imported folder.

Live counters (uploaded / found / duplicates / errors) are parsed from
immich-go's output *server-side* (see ``Progress``) so every window gets the
authoritative numbers from ``/api/jobs/active`` without replaying the whole log.
"""
from __future__ import annotations

import os
import re
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Literal

from . import config, fs, settings, state

JobStatus = Literal["running", "success", "error", "cancelled", "interrupted"]
FolderStatus = Literal["pending", "running", "done", "failed", "interrupted"]

# Number of trailing log lines persisted so a resume prompt can show context.
_LOG_TAIL = 40
# Cap the in-memory live log so a long import (thousands of progress lines) does
# not balloon memory or force a huge replay on every window reconnect. The full
# log still lives in immich-go's own log file if ever needed for debugging.
_LOG_KEEP = 300

# immich-go (--no-ui) prints a progress line ~every 500ms, plus a per-folder
# final report with "  <label> : <n>" lines. We parse both server-side so every
# window gets authoritative counters without replaying the whole log.
_RE_LIVE = re.compile(
    r"Immich read (\d+)%, Assets found: (\d+), Upload errors: (\d+), Uploaded (\d+)"
)
_RE_REPORT = re.compile(r"^\s*(.+?)\s*:\s*(\d+)\b")
_RE_IMPORTING = re.compile(r"=== Importing '(.*)' ===")
_REPORT_LABELS = [
    ("uploaded successfully", "uploaded"),
    ("server asset upgraded", "upgraded"),
    ("server has duplicate", "server_dup"),
    ("discarded local duplicate", "local_dup"),
    ("discarded unsupported", "unsupported"),
    ("upload failed", "errors"),
    ("server error", "errors"),
    ("file access error", "errors"),
    ("incomplete processing", "errors"),
]


class Progress:
    """Authoritative live tally parsed from immich-go output.

    Duplicates only surface in immich-go's end-of-folder report, never in the
    live line, so per-folder report values are staged in ``rep`` and folded into
    the cumulative totals when the folder closes (next folder, or job end via
    ``finalize()``). Totals accumulate across every folder of the job.
    """

    def __init__(self) -> None:
        self.cum = dict(uploaded=0, upgraded=0, server_dup=0, local_dup=0,
                        unsupported=0, errors=0, found=0)
        self.cur = dict(found=0, uploaded=0, errors=0, read_pct=0)
        self.rep: dict[str, int] = {}
        self.folder_open = False
        self.current_folder: str | None = None
        self._stall = 0  # consecutive full-read ticks with no upload progress

    @staticmethod
    def _reconcile_dups(found, up, err, upg, uns, sdup, ldup):
        """Derive the true duplicate count arithmetically so a missing or
        renamed immich-go report label can never leave it wrongly at 0.

        Everything discovered (``found``) that was neither uploaded, errored,
        upgraded nor unsupported IS a duplicate. Any duplicate the text report
        didn't label is attributed to the server side (local duplicates are
        always reported reliably as "discarded local duplicate").
        """
        arith = found - up - err - upg - uns
        if arith < 0:
            arith = 0
        extra = arith - (sdup + ldup)
        if extra > 0:
            sdup += extra
        return sdup, ldup

    def _fold(self) -> None:
        if not self.folder_open:
            return
        up = self.rep.get("uploaded", self.cur["uploaded"])
        upg = self.rep.get("upgraded", 0)
        uns = self.rep.get("unsupported", 0)
        err = self.rep.get("errors", self.cur["errors"])
        sdup, ldup = self._reconcile_dups(
            self.cur["found"], up, err, upg, uns,
            self.rep.get("server_dup", 0), self.rep.get("local_dup", 0))
        self.cum["uploaded"] += up
        self.cum["upgraded"] += upg
        self.cum["unsupported"] += uns
        self.cum["errors"] += err
        self.cum["server_dup"] += sdup
        self.cum["local_dup"] += ldup
        self.cum["found"] += self.cur["found"]
        self.cur = dict(found=0, uploaded=0, errors=0, read_pct=0)
        self.rep = {}
        self.folder_open = False
        self._stall = 0

    def feed(self, line: str) -> None:
        mi = _RE_IMPORTING.search(line)
        if mi:
            self._fold()               # close previous folder, if any
            self.folder_open = True
            self.current_folder = mi.group(1)
            return
        m = _RE_LIVE.search(line)
        if m:
            self.folder_open = True
            read_pct = int(m.group(1))
            new_up = int(m.group(4))
            # Detect duplicate-skipping: everything is discovered (read 100%)
            # yet Uploaded no longer moves → immich-go is skipping duplicates.
            if read_pct >= 100 and new_up == self.cur["uploaded"]:
                self._stall += 1
            else:
                self._stall = 0
            self.cur["read_pct"] = read_pct
            self.cur["found"] = int(m.group(2))
            self.cur["errors"] = int(m.group(3))
            self.cur["uploaded"] = new_up
            return
        rl = _RE_REPORT.match(line)
        if rl:
            label = rl.group(1).lower()
            val = int(rl.group(2))
            for needle, key in _REPORT_LABELS:
                if needle in label:
                    if key == "errors":
                        self.rep["errors"] = self.rep.get("errors", 0) + val
                    else:
                        self.rep[key] = val
                    break

    def finalize(self) -> None:
        self._fold()

    def as_dict(self) -> dict:
        # Virtually fold the currently-open folder (preferring its final-report
        # values, falling back to the live line) WITHOUT mutating state, so a
        # snapshot taken at any instant — including a terminal one read before
        # finalize() runs — always reflects correct totals.
        eff = dict(self.cum)
        dups_estimated = False
        if self.folder_open:
            up = self.rep.get("uploaded", self.cur["uploaded"])
            upg = self.rep.get("upgraded", 0)
            uns = self.rep.get("unsupported", 0)
            err = self.rep.get("errors", self.cur["errors"])
            found_cur = self.cur["found"]
            if self.rep:
                # Folder report emitted → exact reconciliation.
                sdup, ldup = self._reconcile_dups(
                    found_cur, up, err, upg, uns,
                    self.rep.get("server_dup", 0), self.rep.get("local_dup", 0))
            elif self.cur["read_pct"] >= 100 and self._stall >= 3:
                # Everything discovered and uploads stalled → the pending assets
                # are being skipped as duplicates. Estimate live; the exact
                # count firms up from the report at folder close.
                sdup, ldup = self._reconcile_dups(found_cur, up, err, upg, uns, 0, 0)
                dups_estimated = (sdup + ldup) > 0
            else:
                # Still discovering / actively uploading: pending assets are not
                # classified yet — don't guess (that would fake duplicates).
                sdup, ldup = 0, 0
            eff["uploaded"] += up
            eff["upgraded"] += upg
            eff["unsupported"] += uns
            eff["errors"] += err
            eff["server_dup"] += sdup
            eff["local_dup"] += ldup
            eff["found"] += found_cur
        found = eff["found"]
        uploaded = eff["uploaded"]
        errors = eff["errors"]
        dups = eff["server_dup"] + eff["local_dup"]
        unsupported = eff["unsupported"]
        upgraded = eff["upgraded"]
        processed = uploaded + errors + dups + unsupported + upgraded
        remaining = max(found - processed, 0)
        pct = min(100, round(processed / found * 100)) if found > 0 else 0
        return {
            "found": found, "uploaded": uploaded, "errors": errors,
            "dups": dups, "serverDup": eff["server_dup"],
            "localDup": eff["local_dup"], "upgraded": upgraded,
            "unsupported": unsupported, "processed": processed,
            "remaining": remaining, "readPct": self.cur["read_pct"], "pct": pct,
            "dupsEstimated": dups_estimated,
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
    progress: Progress = field(default_factory=Progress)
    return_code: int | None = None
    started_at: float = field(default_factory=time.time)
    ended_at: float | None = None
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    _proc: subprocess.Popen | None = field(default=None, repr=False)
    _cancel: bool = False
    _interrupted: bool = False
    _current_abs: str | None = field(default=None, repr=False)
    _done: threading.Event = field(default_factory=threading.Event, repr=False)

    @property
    def paths(self) -> list[str]:
        return [f.path for f in self.folders]

    def log(self, line: str) -> None:
        clean = line.rstrip("\n")
        with self._lock:
            self.logs.append(clean)
            self.log_total += 1
            # Bound the buffer: keep only the most recent lines.
            if len(self.logs) > _LOG_KEEP:
                del self.logs[0:len(self.logs) - _LOG_KEEP]
            self.progress.feed(clean)

    def finalize_progress(self) -> None:
        with self._lock:
            self.progress.finalize()

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
        if self._is_running():
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
        if self._is_running():
            return False
        state.clear_current()
        return True

    def cancel(self, job_id: str) -> bool:
        job = self._jobs.get(job_id)
        if not job or job.status != "running":
            return False
        job._cancel = True
        proc = job._proc
        if proc and proc.poll() is None:
            proc.terminate()
        return True

    # -- command building ---------------------------------------------------
    def _build_cmd(self, job: Job, abs_path: str) -> list[str]:
        album = settings.album_mode()
        cmd = [
            config.IMMICH_GO_BIN, "upload", "from-folder",
            "--no-ui",
            "--server", settings.immich_url(),
            "--api-key", settings.immich_api_key(),
            "--recursive",
        ]
        if album and album != "NONE":
            cmd.append(f"--folder-as-album={album}")
        if job.dry_run and "--dry-run" not in config.IMMICH_GO_EXTRA_ARGS:
            cmd.append("--dry-run")
        cmd.extend(config.IMMICH_GO_EXTRA_ARGS)
        cmd.append(abs_path)
        return cmd

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
            current = job._current_abs
            # Only meaningful while a folder is actively being imported.
            if not current:
                continue
            gone = not os.path.exists(current)
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
                proc = job._proc
                if proc and proc.poll() is None:
                    proc.terminate()
                return

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

            failed = 0
            for folder in job.folders:
                if folder.status == "done":
                    continue  # resume: skip completed folders
                if job._cancel:
                    job.log("[warn] Cancelled by user.")
                    job.status = "cancelled"
                    return
                if job._interrupted:
                    break

                try:
                    abs_path = str(fs.safe_resolve(folder.path))
                except fs.UnsafePathError as exc:
                    job.log(f"[error] Skipping unsafe path {folder.path!r}: {exc}")
                    folder.status = "failed"
                    failed += 1
                    job.persist()
                    continue

                # Guard: the folder must actually be present (disk plugged in).
                if not os.path.exists(abs_path):
                    job._interrupted = True
                    job.log(f"[warn] Dossier introuvable (disque absent ?) : "
                            f"'{folder.path or '<root>'}'. Import interrompu.")
                    break

                label = folder.path or "<root>"
                folder.status = "running"
                job.persist()
                job.log(f"\n[info] === Importing '{label}' ===")
                rc = self._run_one(job, abs_path)

                if job._interrupted:
                    folder.status = "interrupted"
                    job.persist()
                    break
                if rc != 0:
                    folder.status = "failed"
                    failed += 1
                    job.log(f"[error] immich-go exited with code {rc} for '{label}'.")
                else:
                    folder.status = "done"
                    job.log(f"[ok] Finished '{label}'.")
                job.persist()

            if job._interrupted:
                job.status = "interrupted"
                remaining = sum(1 for f in job.folders if f.status != "done")
                job.log(f"\n[warn] Import interrompu. {remaining} dossier(s) "
                        f"restant(s) — rebranche le disque pour reprendre.")
            else:
                done = sum(1 for f in job.folders if f.status == "done")
                job.return_code = 1 if failed else 0
                job.status = "error" if failed else "success"
                job.log(f"\n[info] Done. {done}/{len(job.folders)} folder(s) succeeded.")
        except Exception as exc:  # noqa: BLE001 - surface any crash into logs
            job.log(f"[error] Import crashed: {exc!r}")
            job.status = "error"
        finally:
            job.ended_at = time.time()
            job._done.set()
            job._current_abs = None
            job.finalize_progress()  # fold the last folder's report into totals
            job.persist()
            # Clean terminal states clear the resume state; interrupted keeps it.
            if job.status in ("success", "cancelled"):
                state.clear_current()

    def _run_one(self, job: Job, abs_path: str) -> int:
        cmd = self._build_cmd(job, abs_path)
        job.log(f"[cmd] {self._redacted(cmd)}")
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
        job._current_abs = abs_path
        assert proc.stdout is not None
        for line in proc.stdout:
            job.log(line)
            if (job._cancel or job._interrupted) and proc.poll() is None:
                proc.terminate()
        proc.wait()
        job._proc = None
        job._current_abs = None
        return proc.returncode


manager = JobManager()
