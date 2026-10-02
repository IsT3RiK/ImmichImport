"""Filesystem helpers: safe path resolution, tree listing and asset counts.

All paths exchanged with the frontend are POSIX-style **relative** paths rooted
at IMPORT_ROOT (the mounted disk). The empty string / "." denotes the root
itself. Absolute paths never leave this module: they are resolved here and
validated to stay confined under IMPORT_ROOT (anti path-traversal).

Counting rules live in ``config`` and mirror immich-go's own supported-media
table and ban list, so that what the tree promises is what immich-go imports.
``scan_report`` exists to explain any remaining gap in plain numbers.
"""
from __future__ import annotations

import logging
import os
import threading
import time
from collections import Counter
from pathlib import Path, PurePosixPath

from . import config

log = logging.getLogger("immichimport.fs")


class UnsafePathError(ValueError):
    """Raised when a requested path escapes IMPORT_ROOT."""


def safe_resolve(rel: str) -> Path:
    """Resolve a client-supplied relative path to an absolute Path under root.

    Raises UnsafePathError on any attempt to traverse outside IMPORT_ROOT
    (via ``..``, absolute paths or symlinks that point elsewhere).
    """
    rel = (rel or "").strip()
    # Normalise: strip leading slashes so it is always treated as relative.
    rel = rel.lstrip("/")
    # Reject NUL and other obvious garbage early.
    if "\x00" in rel:
        raise UnsafePathError("invalid path")

    candidate = (config.IMPORT_ROOT / rel).resolve()
    root = config.IMPORT_ROOT
    if candidate != root and root not in candidate.parents:
        raise UnsafePathError(f"path escapes import root: {rel!r}")
    return candidate


def to_rel(abs_path: Path) -> str:
    """Return the POSIX relative path of ``abs_path`` from IMPORT_ROOT."""
    rel = abs_path.resolve().relative_to(config.IMPORT_ROOT)
    return str(PurePosixPath(rel)) if str(rel) != "." else ""


def _classify(name: str) -> str | None:
    ext = os.path.splitext(name)[1].lower()
    if ext in config.PHOTO_EXTS:
        return "photo"
    if ext in config.VIDEO_EXTS:
        return "video"
    return None


def banned_reason(rel_path: str, is_dir: bool) -> str | None:
    """Return the ban pattern excluding this entry, or None if it is kept.

    Applied to the SAME relative paths on both sides of the fence: here for the
    tree/counts, and inside immich-go for the actual import.
    """
    return config.BANNED.match(rel_path, is_dir)


def root_status() -> dict:
    """Report whether an external disk is currently mounted under IMPORT_ROOT.

    IMPORT_ROOT is the *parent* directory where the NAS mounts USB disks
    (bind-mounted with rslave propagation, so plug/unplug events show up live).
    Each plugged disk appears as an immediate sub-directory; when it is a real
    mountpoint we flag it as such. ``present`` is True as soon as anything is
    visible under the root, which the frontend polls to detect hot-plugging.
    """
    root = config.IMPORT_ROOT
    exists = root.is_dir()
    disks: list[dict] = []
    entry_count = 0
    accessible = False
    sig: list[tuple] = []
    if exists:
        try:
            with os.scandir(root) as it:
                for entry in it:
                    entry_count += 1
                    try:
                        is_dir = entry.is_dir(follow_symlinks=False)
                    except OSError:
                        is_dir = False
                    if not is_dir:
                        continue
                    p = Path(entry.path)
                    try:
                        is_mount = os.path.ismount(p)
                    except OSError:
                        is_mount = False
                    try:
                        sig.append((entry.name, entry.stat(follow_symlinks=False).st_dev))
                    except OSError:
                        sig.append((entry.name, None))
                    disks.append({
                        "name": entry.name,
                        "path": to_rel(p),
                        "isMount": is_mount,
                    })
            accessible = True
        except (PermissionError, OSError):
            accessible = False
    disks.sort(key=lambda d: d["name"].lower())
    _check_disk_signature(tuple(sorted(sig, key=lambda x: x[0])))
    return {
        "exists": exists,
        "accessible": accessible,
        "present": entry_count > 0,
        "disks": disks,
    }


def list_children(rel: str) -> dict:
    """List immediate sub-folders of ``rel`` with non-recursive asset counts.

    Returns a dict: {"path": rel, "children": [ {name, path, photos, videos,
    subdirs, hasChildren, excluded}, ... ]}. Only directories are returned as
    nodes. Directories banned by ``config.BANNED`` are still listed — hiding
    them outright would puzzle a user who can see them in a file browser — but
    flagged ``excluded`` with zeroed counts, since immich-go will skip them.
    """
    base = safe_resolve(rel)
    if not base.is_dir():
        raise NotADirectoryError(rel)

    children: list[dict] = []
    with os.scandir(base) as it:
        for entry in it:
            try:
                if not entry.is_dir(follow_symlinks=False):
                    continue
            except OSError:
                continue
            child_abs = Path(entry.path)
            child_rel = to_rel(child_abs)
            excluded = banned_reason(child_rel, True)
            photos = videos = subdirs = 0
            has_children = False
            if excluded:
                # Skipped by immich-go: report it, but never promise its content.
                children.append({
                    "name": entry.name,
                    "path": child_rel,
                    "photos": 0,
                    "videos": 0,
                    "subdirs": 0,
                    "hasChildren": False,
                    "excluded": excluded,
                })
                continue
            try:
                with os.scandir(child_abs) as sub:
                    for e in sub:
                        try:
                            if e.is_dir(follow_symlinks=False):
                                if not banned_reason(f"{child_rel}/{e.name}", True):
                                    subdirs += 1
                                    has_children = True
                                continue
                        except OSError:
                            continue
                        if banned_reason(f"{child_rel}/{e.name}", False):
                            continue
                        kind = _classify(e.name)
                        if kind == "photo":
                            photos += 1
                        elif kind == "video":
                            videos += 1
            except PermissionError:
                pass
            children.append({
                "name": entry.name,
                "path": child_rel,
                "photos": photos,
                "videos": videos,
                "subdirs": subdirs,
                "hasChildren": has_children,
                "excluded": None,
            })
    children.sort(key=lambda c: c["name"].lower())
    return {"path": to_rel(base), "children": children}


def _walk_kept(base: Path):
    """Walk ``base`` yielding (dir_rel, filenames), pruning banned directories.

    Pruning mirrors immich-go: a banned directory is not descended into at all,
    so its whole subtree disappears from the counts exactly as it does from the
    import.
    """
    for root_dir, dirs, files in os.walk(base, followlinks=False):
        root_rel = to_rel(Path(root_dir))
        kept_dirs = []
        for d in dirs:
            child_rel = f"{root_rel}/{d}" if root_rel else d
            if banned_reason(child_rel, True):
                continue
            kept_dirs.append(d)
        dirs[:] = kept_dirs  # in-place: this is what prunes the walk
        yield root_rel, files


# --- recursive count cache ----------------------------------------------------
# A recursive count walks a whole subtree of a slow USB disk. The tree asks for
# one per visible folder, so without a cache the same files were walked once
# per level of the tree, again on every reload, and again while immich-go was
# reading that same disk. One walk now fills the cache for EVERY folder below
# the one asked for, so unfolding the tree afterwards costs nothing.
_COUNT_TTL = 30 * 60
_count_cache: dict[str, tuple[float, int, int]] = {}
_cache_lock = threading.Lock()
# One walk at a time per disk: a child requested while its parent is being
# walked waits, then finds its figure in the cache instead of re-reading it.
_walk_locks: dict[str, threading.Lock] = {}
_disk_sig: tuple | None = None


def _check_disk_signature(sig: tuple) -> None:
    """Drop every cached count when the set of mounted disks changes: a disk
    swapped under the same name must not inherit the previous one's figures."""
    global _disk_sig
    with _cache_lock:
        if _disk_sig is not None and sig != _disk_sig:
            _count_cache.clear()
            log.info("disk change detected - count cache cleared")
        _disk_sig = sig


def clear_count_cache() -> None:
    with _cache_lock:
        _count_cache.clear()


def _cached(rel: str) -> dict | None:
    with _cache_lock:
        hit = _count_cache.get(rel)
    if not hit or time.monotonic() - hit[0] > _COUNT_TTL:
        return None
    return {"path": rel, "photos": hit[1], "videos": hit[2]}


def _walk_lock(rel: str) -> threading.Lock:
    disk = rel.split("/", 1)[0]
    with _cache_lock:
        return _walk_locks.setdefault(disk, threading.Lock())


def recursive_count(rel: str, walk: bool = True) -> dict | None:
    """Total photo/video counts of ``rel`` and its subfolders.

    Served from the cache when possible. With ``walk=False`` a cache miss
    returns None instead of reading the disk.
    """
    base = safe_resolve(rel)
    key = to_rel(base)
    hit = _cached(key)
    if hit or not walk:
        return hit
    with _walk_lock(key):
        hit = _cached(key)  # filled meanwhile by the walk of an ancestor
        if hit:
            return hit
        direct: dict[str, list[int]] = {}
        for root_rel, files in _walk_kept(base):
            counts = direct.setdefault(root_rel, [0, 0])
            for name in files:
                file_rel = f"{root_rel}/{name}" if root_rel else name
                if banned_reason(file_rel, False):
                    continue
                kind = _classify(name)
                if kind == "photo":
                    counts[0] += 1
                elif kind == "video":
                    counts[1] += 1
        # Fold every folder into its parent, deepest first, so each one ends
        # up holding its whole subtree.
        for d in sorted(direct, key=lambda r: r.count("/"), reverse=True):
            if d == key:
                continue
            parent = d.rsplit("/", 1)[0] if "/" in d else ""
            if parent in direct:
                direct[parent][0] += direct[d][0]
                direct[parent][1] += direct[d][1]
        now = time.monotonic()
        with _cache_lock:
            for d, (photos, videos) in direct.items():
                _count_cache[d] = (now, photos, videos)
        photos, videos = direct.get(key, [0, 0])
    return {"path": key, "photos": photos, "videos": videos}


def scan_report(rel: str, top: int = 30) -> dict:
    """Explain, in numbers, why a folder yields the asset count that it does.

    This is the answer to "the disk holds 250 000 files but the import only
    found 12 000": it breaks every file down into counted / ignored (with the
    exact extensions responsible) / excluded by a ban pattern, so the gap stops
    being a mystery and becomes a list.
    """
    base = safe_resolve(rel)
    started = time.monotonic()

    photos = videos = sidecars = ignored = 0
    files_total = dirs_total = 0
    ignored_exts: Counter[str] = Counter()
    sidecar_exts: Counter[str] = Counter()
    banned_files: Counter[str] = Counter()
    banned_dirs: Counter[str] = Counter()
    unreadable = 0

    for root_dir, dirs, files in os.walk(base, followlinks=False, onerror=None):
        root_rel = to_rel(Path(root_dir))
        kept_dirs = []
        for d in dirs:
            child_rel = f"{root_rel}/{d}" if root_rel else d
            reason = banned_reason(child_rel, True)
            if reason:
                banned_dirs[reason] += 1
                continue
            kept_dirs.append(d)
        dirs[:] = kept_dirs
        dirs_total += len(kept_dirs)

        for name in files:
            files_total += 1
            file_rel = f"{root_rel}/{name}" if root_rel else name
            reason = banned_reason(file_rel, False)
            if reason:
                banned_files[reason] += 1
                continue
            ext = os.path.splitext(name)[1].lower() or "(sans extension)"
            kind = _classify(name)
            if kind == "photo":
                photos += 1
            elif kind == "video":
                videos += 1
            elif ext in config.SIDECAR_EXTS:
                sidecars += 1
                sidecar_exts[ext] += 1
            else:
                ignored += 1
                ignored_exts[ext] += 1

    elapsed = round(time.monotonic() - started, 2)
    assets = photos + videos
    report = {
        "path": to_rel(base),
        "filesTotal": files_total,
        "dirsTotal": dirs_total,
        "photos": photos,
        "videos": videos,
        "assets": assets,
        "sidecars": sidecars,
        "ignored": ignored,
        "unreadable": unreadable,
        "ignoredByExt": [
            {"ext": e, "count": n} for e, n in ignored_exts.most_common(top)
        ],
        "sidecarsByExt": [
            {"ext": e, "count": n} for e, n in sidecar_exts.most_common(top)
        ],
        "excludedFiles": [
            {"pattern": p, "count": n} for p, n in banned_files.most_common()
        ],
        "excludedDirs": [
            {"pattern": p, "count": n} for p, n in banned_dirs.most_common()
        ],
        "elapsedSeconds": elapsed,
    }
    log.info(
        "scan '%s': %d assets (%d photos, %d videos) on %d files — "
        "%d ignored, %d sidecars, %d banned files, %d banned dirs in %ss",
        report["path"] or "<root>", assets, photos, videos, files_total,
        ignored, sidecars, sum(banned_files.values()), sum(banned_dirs.values()),
        elapsed,
    )
    return report


def dedup_selection(paths: list[str]) -> list[str]:
    """Reduce a selection to its top-most ancestors.

    If a selected path is already covered by another selected ancestor it is
    dropped (immich-go recurses, so the ancestor already includes it).
    """
    norm = sorted({(p or "").strip().strip("/") for p in paths})
    result: list[str] = []
    for p in norm:
        # Empty string == root: it covers everything, short-circuit.
        if p == "":
            return [""]
        covered = False
        for q in result:
            if p == q or p.startswith(q + "/"):
                covered = True
                break
        if not covered:
            result.append(p)
    return result
