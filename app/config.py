"""Configuration loaded from environment variables."""
from __future__ import annotations

import os
import shlex
from pathlib import Path


def _clean(val: str | None) -> str:
    return (val or "").strip()


# Root of the mounted external disk (mounted :ro in the container).
IMPORT_ROOT = Path(_clean(os.environ.get("IMPORT_ROOT")) or "/import").resolve()

# Immich server reachable from inside the container (same docker network).
IMMICH_URL = _clean(os.environ.get("IMMICH_URL")) or "http://immich_server:2283"
IMMICH_API_KEY = _clean(os.environ.get("IMMICH_API_KEY"))

# Path to the immich-go binary baked into the image.
IMMICH_GO_BIN = _clean(os.environ.get("IMMICH_GO_BIN")) or "/usr/local/bin/immich-go"

# Writable directory where import job state is persisted so that an interrupted
# import (disk unplugged, container restarted) can be detected and resumed.
# This must be a writable volume — NOT the :ro import disk.
STATE_DIR = Path(_clean(os.environ.get("STATE_DIR")) or "/state").resolve()

# How often (seconds) the running import checks that the disk is still present.
# When it vanishes mid-import the job is interrupted and made resumable.
DISK_MONITOR_INTERVAL = float(_clean(os.environ.get("DISK_MONITOR_INTERVAL")) or "2")

# Album strategy passed to immich-go: FOLDER, PATH or NONE.
ALBUM_MODE = (_clean(os.environ.get("ALBUM_MODE")) or "FOLDER").upper()

# Extra raw args appended to every immich-go invocation (advanced).
IMMICH_GO_EXTRA_ARGS = shlex.split(_clean(os.environ.get("IMMICH_GO_EXTRA_ARGS")))

# HTTP port the web UI listens on inside the container.
PORT = int(_clean(os.environ.get("PORT")) or "8080")

# File extensions used to count / classify assets in the tree view.
PHOTO_EXTS = {
    ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tif", ".tiff", ".webp",
    ".heic", ".heif", ".raw", ".dng", ".cr2", ".cr3", ".nef", ".arw",
    ".rw2", ".orf", ".raf", ".sr2", ".pef", ".srw", ".avif", ".jxl",
}
VIDEO_EXTS = {
    ".mp4", ".mov", ".avi", ".mkv", ".m4v", ".3gp", ".webm", ".mpg",
    ".mpeg", ".wmv", ".flv", ".mts", ".m2ts", ".ts", ".insv", ".mxf",
}


def config_summary() -> dict:
    """Non-secret config exposed to the frontend for display."""
    return {
        "import_root": str(IMPORT_ROOT),
        "immich_url": IMMICH_URL,
        "album_mode": ALBUM_MODE,
        "api_key_set": bool(IMMICH_API_KEY),
    }
