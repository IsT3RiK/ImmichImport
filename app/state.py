"""Persistence of import job progress so imports survive interruptions.

The running import writes a small JSON snapshot to STATE_DIR after every
meaningful transition (folder started / finished, disk unplugged, done). If the
disk is unplugged mid-import — or the container is restarted while a job was
running — the snapshot lets us detect the interruption and offer the user a
resume: only the folders not yet marked ``done`` are re-run, and immich-go's
per-file checksum dedup skips whatever was already uploaded inside them.

Only one import runs at a time, so a single ``current.json`` file is enough.
Writes are atomic (temp file + os.replace) to avoid a torn snapshot if the
process dies mid-write.
"""
from __future__ import annotations

import json
import os
import tempfile
import threading

from . import config

_CURRENT = config.STATE_DIR / "current.json"
_lock = threading.Lock()


def _ensure_dir() -> bool:
    try:
        config.STATE_DIR.mkdir(parents=True, exist_ok=True)
        return True
    except OSError:
        return False


def save_current(snapshot: dict) -> None:
    """Atomically persist the current job snapshot. Best-effort (never raises)."""
    if not _ensure_dir():
        return
    with _lock:
        try:
            fd, tmp = tempfile.mkstemp(dir=str(config.STATE_DIR), suffix=".tmp")
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as fh:
                    json.dump(snapshot, fh, ensure_ascii=False, indent=2)
                os.replace(tmp, _CURRENT)
            finally:
                if os.path.exists(tmp):
                    try:
                        os.remove(tmp)
                    except OSError:
                        pass
        except OSError:
            pass


def load_current() -> dict | None:
    """Return the persisted job snapshot, or None if there is none / unreadable."""
    with _lock:
        try:
            with open(_CURRENT, encoding="utf-8") as fh:
                data = json.load(fh)
            return data if isinstance(data, dict) else None
        except (OSError, ValueError):
            return None


def clear_current() -> None:
    """Delete the persisted snapshot (import finished cleanly or was discarded)."""
    with _lock:
        try:
            os.remove(_CURRENT)
        except OSError:
            pass
