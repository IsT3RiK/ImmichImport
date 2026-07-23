"""Filesystem helpers: safe path resolution, tree listing and asset counts.

All paths exchanged with the frontend are POSIX-style **relative** paths rooted
at IMPORT_ROOT (the mounted disk). The empty string / "." denotes the root
itself. Absolute paths never leave this module: they are resolved here and
validated to stay confined under IMPORT_ROOT (anti path-traversal).
"""
from __future__ import annotations

import os
from pathlib import Path, PurePosixPath

from . import config


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
                    disks.append({
                        "name": entry.name,
                        "path": to_rel(p),
                        "isMount": is_mount,
                    })
            accessible = True
        except (PermissionError, OSError):
            accessible = False
    disks.sort(key=lambda d: d["name"].lower())
    return {
        "exists": exists,
        "accessible": accessible,
        "present": entry_count > 0,
        "disks": disks,
    }


def list_children(rel: str) -> dict:
    """List immediate sub-folders of ``rel`` with non-recursive asset counts.

    Returns a dict: {"path": rel, "children": [ {name, path, photos, videos,
    subdirs, hasChildren}, ... ]}. Only directories are returned as nodes;
    file counts of the *current* folder are attached to its own node when it
    was produced by the parent listing.
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
            photos = videos = subdirs = 0
            has_children = False
            try:
                with os.scandir(child_abs) as sub:
                    for e in sub:
                        try:
                            if e.is_dir(follow_symlinks=False):
                                subdirs += 1
                                has_children = True
                                continue
                        except OSError:
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
                "path": to_rel(child_abs),
                "photos": photos,
                "videos": videos,
                "subdirs": subdirs,
                "hasChildren": has_children,
            })
    children.sort(key=lambda c: c["name"].lower())
    return {"path": to_rel(base), "children": children}


def recursive_count(rel: str) -> dict:
    """Walk ``rel`` fully and return total photo/video counts."""
    base = safe_resolve(rel)
    photos = videos = 0
    for _root, _dirs, files in os.walk(base, followlinks=False):
        for name in files:
            kind = _classify(name)
            if kind == "photo":
                photos += 1
            elif kind == "video":
                videos += 1
    return {"path": to_rel(base), "photos": photos, "videos": videos}


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
