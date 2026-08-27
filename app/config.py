"""Configuration loaded from environment variables."""
from __future__ import annotations

import os
import shlex
from pathlib import Path

from .namematcher import NameList


def _clean(val: str | None) -> str:
    return (val or "").strip()


def _clean_list(val: str | None) -> list[str]:
    """Split a comma-separated env value into a clean list of patterns."""
    return [p.strip() for p in (val or "").split(",") if p.strip()]


# Root of the mounted external disk (mounted :ro in the container).
IMPORT_ROOT = Path(_clean(os.environ.get("IMPORT_ROOT")) or "/import").resolve()

# --- Immich connection --------------------------------------------------------
# RAW environment values (None when unset): these decide whether the connection
# is "locked by env" (both provided => the setup wizard is skipped and the UI
# can't change them). The effective, wizard-aware values are resolved in
# ``settings.py`` (env value OR what the user validated in the assistant).
ENV_IMMICH_URL = _clean(os.environ.get("IMMICH_URL")) or None
ENV_IMMICH_API_KEY = _clean(os.environ.get("IMMICH_API_KEY")) or None
ENV_ALBUM_MODE = (_clean(os.environ.get("ALBUM_MODE")).upper() or None)

# Back-compat defaulted values (kept for any external reference); prefer the
# resolvers in settings.py (settings.immich_url(), settings.immich_api_key()…).
IMMICH_URL = ENV_IMMICH_URL or "http://immich_server:2283"
IMMICH_API_KEY = ENV_IMMICH_API_KEY or ""

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

# What immich-go does when the SERVER returns an error: "stop" (its own
# default), "continue", or a maximum number of errors to tolerate.
#
# immich-go ships with "stop", which aborts the WHOLE run on the very first
# server error - and since discovery runs alongside uploading, everything not
# yet discovered is simply never seen. One dropped connection on a 18 000-photo
# folder ended the import after 511 files, with no indication that 17 500 had
# never been looked at. For an unattended import over a slow USB disk that is
# the wrong default: a transient network glitch must not silently truncate the
# job. Errors are listed per file in the recap, so nothing is hidden by going on.
ON_ERRORS = _clean(os.environ.get("IMPORT_ON_ERRORS")) or "continue"

# Extra raw args appended to every immich-go invocation (advanced).
IMMICH_GO_EXTRA_ARGS = shlex.split(_clean(os.environ.get("IMMICH_GO_EXTRA_ARGS")))

# HTTP port the web UI listens on inside the container.
PORT = int(_clean(os.environ.get("PORT")) or "8080")

# Verbosity of the application log (DEBUG, INFO, WARNING, ERROR).
LOG_LEVEL = (_clean(os.environ.get("LOG_LEVEL")) or "INFO").upper()

# --- What counts as an asset --------------------------------------------------
# These sets MUST mirror immich-go's ``filetypes.DefaultSupportedMedia``
# (v0.32.0, internal/filetypes/supported.go). The tree view exists to promise
# what immich-go will import; every extension that appears here but not there
# inflates the counts with files that will never be uploaded, and every
# extension missing here hides files that WILL be uploaded. Both directions have
# bitten this app before — keep the two lists in sync when bumping immich-go.
#
# Deliberately absent: .nrw. It appears in immich-go's RAW extension table but
# NOT in DefaultSupportedMedia, so immich-go does not upload it.
PHOTO_EXTS = {
    ".3fr", ".ari", ".arw", ".avif", ".bmp", ".cap", ".cin", ".cr2",
    ".cr3", ".crw", ".dcr", ".dng", ".erf", ".fff", ".gif", ".heic",
    ".heif", ".hif", ".iiq", ".insp", ".jpe", ".jpeg", ".jpg", ".jxl",
    ".k25", ".kdc", ".mrw", ".nef", ".orf", ".ori", ".pef", ".png",
    ".psd", ".raf", ".raw", ".rw2", ".rwl", ".sr2", ".srf", ".srw",
    ".tif", ".tiff", ".webp", ".x3f",
}
VIDEO_EXTS = {
    ".3gp", ".avi", ".flv", ".insv", ".m2ts", ".m4v", ".mkv", ".mov",
    ".mp4", ".mpg", ".mts", ".webm", ".wmv",
}
# Companion metadata files: never assets on their own, but worth reporting in
# the diagnostic so a folder full of .xmp doesn't look mysteriously "empty".
SIDECAR_EXTS = {".xmp", ".json", ".mp"}

# --- What gets skipped --------------------------------------------------------
# immich-go's own built-in ban list (v0.32.0, adapters/shared/bannedFiles.go).
# It is applied by immich-go whether we like it or not, so the tree must apply
# it too. A trailing "/" means the rule matches directories only.
IMMICH_GO_BANNED_DEFAULTS = (
    "@eaDir/",
    "@__thumb/",           # QNAP
    "SYNOFILE_THUMB_*.*",  # Synology
    "Lightroom Catalog/",
    "thumbnails/",         # Android
    ".DS_Store",           # macOS Finder metadata
    "/._*",                # macOS resource forks
    ".Spotlight-V100/",    # macOS system index
    ".photostructure/",
    "Recently Deleted/",   # iCloud
)

# Extra exclusions this app adds on top. immich-go does NOT know these, so they
# are ALSO forwarded to it via --ban-file (see importer._build_cmd) — otherwise
# the app would hide files that immich-go would happily upload, recreating the
# very mismatch we are fixing. Override with IMPORT_EXCLUDE (comma-separated).
DEFAULT_EXTRA_BANNED = (
    "$RECYCLE.BIN/",              # Windows recycle bin
    "System Volume Information/",  # Windows
    "#recycle/",                  # Synology
    "@Recycle/",                  # QNAP
    ".Trash-*/",                  # Linux
    ".Trashes/",                  # macOS
    "lost+found/",
)
EXTRA_BANNED_PATTERNS = tuple(
    _clean_list(os.environ.get("IMPORT_EXCLUDE")) or DEFAULT_EXTRA_BANNED
)

# The single matcher used by fs.py for both listing and counting.
BANNED = NameList(list(IMMICH_GO_BANNED_DEFAULTS) + list(EXTRA_BANNED_PATTERNS))


def config_summary() -> dict:
    """Non-secret config exposed to the frontend for display."""
    return {
        "import_root": str(IMPORT_ROOT),
        "immich_url": IMMICH_URL,
        "album_mode": ALBUM_MODE,
        "api_key_set": bool(IMMICH_API_KEY),
    }
