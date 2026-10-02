"""FastAPI application: tree browsing, recursive counts and import jobs."""
from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config, fs, i18n, immich_check, logging_setup, settings, version
from .importer import manager

logging_setup.configure(config.LOG_LEVEL)
log = logging_setup.get_logger("http")

app = FastAPI(title="Immich Import", docs_url=None, redoc_url=None)

STATIC_DIR = Path(__file__).parent / "static"


def _client_ip(request: Request) -> str:
    """Best-effort client IP: honour a reverse proxy's X-Forwarded-For."""
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    real = request.headers.get("x-real-ip")
    if real:
        return real.strip()
    return request.client.host if request.client else "-"


@app.middleware("http")
async def access_log(request: Request, call_next):
    """One access line per request, in the same format as application logs.

    The IP/method/path are also pushed into the logging context, so anything the
    handler logs (a scan, a job start) is attributed to the request that caused
    it instead of floating context-free in the output.
    """
    ip = _client_ip(request)
    path = request.url.path
    if request.url.query:
        path = f"{path}?{request.url.query}"
    started = time.monotonic()
    with logging_setup.request_context(ip, request.method, path):
        try:
            response = await call_next(request)
        except Exception:
            log.exception("unhandled error", extra={"status": 500})
            raise
        ms = (time.monotonic() - started) * 1000
        status = response.status_code
        # Static assets and the UI's polling endpoints would drown the log at
        # INFO, so they sit at DEBUG; anything that failed is always visible.
        noisy = path.startswith(("/static/", "/api/status", "/api/jobs"))
        if status >= 500:
            level = logging.ERROR
        elif status >= 400:
            level = logging.WARNING
        else:
            level = logging.DEBUG if noisy else logging.INFO
        log.log(level, "%.1f ms", ms, extra={"status": status})
    return response


def get_lang(
    x_lang: str | None = Header(default=None),
    accept_language: str | None = Header(default=None),
) -> str:
    """Resolve the response language for user-facing messages (X-Lang > Accept-Language)."""
    return i18n.pick_lang(accept_language, x_lang)


class ImportRequest(BaseModel):
    paths: list[str]
    dryRun: bool = False


class ProbeRequest(BaseModel):
    url: str


class CheckRequest(BaseModel):
    url: str
    apiKey: str


class CompleteRequest(BaseModel):
    url: str
    apiKey: str
    albumMode: str | None = None


class DiscoverRequest(BaseModel):
    scanCidr: str | None = None


@app.get("/api/config")
def get_config() -> dict:
    return {
        "version": version.__version__,
        "importRoot": str(config.IMPORT_ROOT),
        "immichUrl": settings.immich_url(),
        "albumMode": settings.album_mode(),
        "apiKeySet": settings.has_api_key(),
        "lockedByEnv": settings.LOCKED_BY_ENV,
        "setupCompleted": settings.is_setup_completed(),
    }


# --- setup wizard -----------------------------------------------------------
@app.get("/api/setup/state")
def setup_state() -> dict:
    """Current connection state, so the frontend knows whether to show the wizard."""
    return {
        "immichUrl": settings.immich_url(),
        "hasApiKey": settings.has_api_key(),
        "albumMode": settings.album_mode(),
        "lockedByEnv": settings.LOCKED_BY_ENV,
        "setupCompleted": settings.is_setup_completed(),
        "apiKeyUrl": settings.api_key_url_for(settings.immich_url()) if settings.immich_url() else "",
    }


@app.post("/api/setup/discover")
def setup_discover(req: DiscoverRequest, lang: str = Depends(get_lang)) -> dict:
    """Propose Immich addresses found on the container's network (+ optional scan)."""
    result = immich_check.discover()
    cidr = (req.scanCidr or "").strip()
    result["scanned"] = None
    if cidr:
        try:
            extra = immich_check.scan_subnet(cidr)
            seen = {c["url"] for c in result["candidates"]}
            for cand in extra:
                if cand["url"] not in seen:
                    result["candidates"].append(cand)
            result["scanned"] = cidr
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=i18n.tr("err.scanInvalid", lang)) from exc
    return result


@app.post("/api/setup/probe")
def setup_probe(req: ProbeRequest) -> dict:
    """Test a hand-typed URL (nothing is saved)."""
    result = immich_check.probe(req.url)
    url = result["url"]
    result["apiKeyUrl"] = settings.api_key_url_for(url) if url else ""
    return result


@app.post("/api/setup/check")
def setup_check(req: CheckRequest) -> dict:
    """Validate an API key and report per-scope permissions (nothing is saved)."""
    return immich_check.check_credentials(req.url, req.apiKey)


@app.post("/api/setup/complete")
def setup_complete(req: CompleteRequest, lang: str = Depends(get_lang)) -> dict:
    """Re-validate, persist the connection, then close the wizard."""
    if settings.LOCKED_BY_ENV:
        raise HTTPException(status_code=403, detail=i18n.tr("err.locked", lang))
    check = immich_check.check_credentials(req.url, req.apiKey)
    if not check.get("ok"):
        # Never save a connection that doesn't work — the whole point of the wizard.
        raise HTTPException(status_code=400, detail=i18n.tr("err.connInvalid", lang))
    try:
        settings.save_connection(req.url, req.apiKey, req.albumMode)
    except RuntimeError as exc:
        raise HTTPException(status_code=403, detail=i18n.tr("err.locked", lang)) from exc
    settings.mark_setup_completed()
    return {"ok": True}


@app.get("/api/status")
def get_status() -> dict:
    """Live disk-presence status, polled by the frontend for hot-plug detection."""
    return fs.root_status()


@app.get("/api/tree")
def get_tree(path: str = Query(""), lang: str = Depends(get_lang)) -> dict:
    try:
        return fs.list_children(path)
    except fs.UnsafePathError:
        raise HTTPException(status_code=400, detail=i18n.tr("err.invalidPath", lang))
    except (FileNotFoundError, NotADirectoryError):
        raise HTTPException(status_code=404, detail=i18n.tr("err.folderNotFound", lang))


@app.get("/api/scan")
def get_scan(path: str = Query(""), top: int = Query(30, ge=1, le=200),
             lang: str = Depends(get_lang)) -> dict:
    """Diagnostic breakdown of one folder: counted vs ignored vs excluded.

    This is the endpoint that answers "the tree announces 250 000 files but the
    import only found 12 000": it reports every file seen, which ban pattern
    excluded what, and the extensions that were encountered but classified as
    neither photo nor video. It walks the whole subtree, so it is deliberately
    NOT called by the tree view - only on demand.
    """
    try:
        return fs.scan_report(path, top=top)
    except fs.UnsafePathError:
        raise HTTPException(status_code=400, detail=i18n.tr("err.invalidPath", lang))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=i18n.tr("err.folderNotFound", lang))


@app.get("/api/count")
def get_count(path: str = Query(""), lang: str = Depends(get_lang)) -> dict:
    try:
        # While an import runs, immich-go is reading the same (slow) disk: a
        # count missing from the cache is deferred rather than walked, and the
        # tree asks again once the import is over.
        res = fs.recursive_count(path, walk=not manager.is_running())
        if res is None:
            return {"path": path, "photos": None, "videos": None, "deferred": True}
        return res
    except fs.UnsafePathError:
        raise HTTPException(status_code=400, detail=i18n.tr("err.invalidPath", lang))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail=i18n.tr("err.folderNotFound", lang))


@app.post("/api/count/refresh")
def refresh_counts() -> dict:
    """Forget cached counts (the tree's reload button): the next counts are
    read from the disk again."""
    fs.clear_count_cache()
    return {"cleared": True}


@app.post("/api/import")
def start_import(req: ImportRequest, lang: str = Depends(get_lang)) -> dict:
    log.info("import requested: %d path(s), dryRun=%s", len(req.paths), req.dryRun)
    try:
        job = manager.start(req.paths, dry_run=req.dryRun)
    except RuntimeError as exc:  # already running
        raise HTTPException(status_code=409, detail=i18n.tr(str(exc), lang))
    except ValueError as exc:  # empty selection
        raise HTTPException(status_code=400, detail=i18n.tr(str(exc), lang))
    return {"jobId": job.id, "paths": job.paths}


@app.get("/api/import/resumable")
def get_resumable() -> dict:
    """Return a persisted interrupted import (if any) so the UI can offer resume."""
    return {"resumable": manager.resumable()}


@app.post("/api/import/resume")
def resume_import(lang: str = Depends(get_lang)) -> dict:
    try:
        job = manager.resume()
    except RuntimeError as exc:  # already running
        raise HTTPException(status_code=409, detail=i18n.tr(str(exc), lang))
    except ValueError as exc:  # nothing to resume
        raise HTTPException(status_code=400, detail=i18n.tr(str(exc), lang))
    return {"jobId": job.id, "paths": job.paths}


@app.post("/api/import/discard")
def discard_resumable(lang: str = Depends(get_lang)) -> dict:
    """Discard a persisted interrupted import (user chose to start over)."""
    ok = manager.discard_resumable()
    if not ok:
        raise HTTPException(status_code=409, detail=i18n.tr("err.importRunning", lang))
    return {"discarded": True}


@app.get("/api/jobs/active")
def active_job() -> dict:
    """Current job with its live progress — lets a reconnecting/reloading window
    render the counters instantly without replaying the whole log."""
    job = manager.active_job
    return job.active_view() if job else {"jobId": None}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str, since: int = Query(0, ge=0), lang: str = Depends(get_lang)) -> dict:
    job = manager.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=i18n.tr("err.jobNotFound", lang))
    return job.snapshot(since=since)


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str, lang: str = Depends(get_lang)) -> dict:
    ok = manager.cancel(job_id)
    if not ok:
        raise HTTPException(status_code=409, detail=i18n.tr("err.jobNotRunning", lang))
    return {"cancelled": True}


@app.get("/api/jobs/{job_id}/errors")
def job_errors(job_id: str, limit: int = Query(200, ge=1, le=2000),
               lang: str = Depends(get_lang)) -> dict:
    """List the files that failed, with their size and the reason.

    This is what the "N errors" figure links to: a count nobody can act on
    becomes a list of names you can retry, fix or ignore.
    """
    job = manager.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=i18n.tr("err.jobNotFound", lang))
    return job.errors_view(limit=limit)


@app.get("/api/jobs/{job_id}/stream")
async def stream_job(job_id: str, lang: str = Depends(get_lang)) -> StreamingResponse:
    job = manager.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=i18n.tr("err.jobNotFound", lang))

    async def event_gen():
        # No full-history replay: send the current progress snapshot plus only a
        # short log tail (for the debug fold). This is what cured the reload
        # latency — a reconnecting window no longer streams thousands of lines.
        snap = job.snapshot(since=0)
        yield f"event: progress\ndata: {json.dumps(snap['progress'])}\n\n"
        for line in snap["lines"][-25:]:
            yield f"event: log\ndata: {json.dumps(line)}\n\n"
        sent = snap["totalLines"]
        while True:
            snap = job.snapshot(since=sent)
            for line in snap["lines"]:
                yield f"event: log\ndata: {json.dumps(line)}\n\n"
            sent = snap["totalLines"]
            yield f"event: progress\ndata: {json.dumps(snap['progress'])}\n\n"
            if snap["status"] != "running":
                yield (
                    "event: done\ndata: "
                    + json.dumps({
                        "status": snap["status"],
                        "returnCode": snap["returnCode"],
                        "startedAt": snap["startedAt"],
                        "endedAt": snap["endedAt"],
                        "progress": snap["progress"],
                    })
                    + "\n\n"
                )
                return
            # Heartbeat: keeps proxies/VPNs from idling the connection out and
            # lets the client detect a silently-dropped socket (no ping => stale).
            yield "event: ping\ndata: {}\n\n"
            await asyncio.sleep(0.6)

    return StreamingResponse(event_gen(), media_type="text/event-stream")


@app.get("/")
def index() -> HTMLResponse:
    """Serve the page with cache-busted asset URLs.

    Without this, a browser holding yesterday's app.js keeps showing the old UI
    after a redeploy — the container is up to date and the screen is not, which
    is exactly the kind of confusion the version tag is meant to remove. The
    page itself is revalidated on every load, and every asset URL carries the
    version, so a new release can never be masked by a stale cache.
    """
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    html = html.replace("__APP_VERSION__", version.__version__)
    return HTMLResponse(html, headers={"Cache-Control": "no-cache"})


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
