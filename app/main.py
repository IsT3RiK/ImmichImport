"""FastAPI application: tree browsing, recursive counts and import jobs."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import config, fs
from .importer import manager

app = FastAPI(title="Immich Import", docs_url=None, redoc_url=None)

STATIC_DIR = Path(__file__).parent / "static"


class ImportRequest(BaseModel):
    paths: list[str]
    dryRun: bool = False


@app.get("/api/config")
def get_config() -> dict:
    return {
        "importRoot": str(config.IMPORT_ROOT),
        "immichUrl": config.IMMICH_URL,
        "albumMode": config.ALBUM_MODE,
        "apiKeySet": bool(config.IMMICH_API_KEY),
    }


@app.get("/api/status")
def get_status() -> dict:
    """Live disk-presence status, polled by the frontend for hot-plug detection."""
    return fs.root_status()


@app.get("/api/tree")
def get_tree(path: str = Query("")) -> dict:
    try:
        return fs.list_children(path)
    except fs.UnsafePathError:
        raise HTTPException(status_code=400, detail="invalid path")
    except (FileNotFoundError, NotADirectoryError):
        raise HTTPException(status_code=404, detail="folder not found")


@app.get("/api/count")
def get_count(path: str = Query("")) -> dict:
    try:
        return fs.recursive_count(path)
    except fs.UnsafePathError:
        raise HTTPException(status_code=400, detail="invalid path")
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="folder not found")


@app.post("/api/import")
def start_import(req: ImportRequest) -> dict:
    try:
        job = manager.start(req.paths, dry_run=req.dryRun)
    except RuntimeError as exc:  # already running
        raise HTTPException(status_code=409, detail=str(exc))
    except ValueError as exc:  # empty selection
        raise HTTPException(status_code=400, detail=str(exc))
    return {"jobId": job.id, "paths": job.paths}


@app.get("/api/import/resumable")
def get_resumable() -> dict:
    """Return a persisted interrupted import (if any) so the UI can offer resume."""
    return {"resumable": manager.resumable()}


@app.post("/api/import/resume")
def resume_import() -> dict:
    try:
        job = manager.resume()
    except RuntimeError as exc:  # already running
        raise HTTPException(status_code=409, detail=str(exc))
    except ValueError as exc:  # nothing to resume
        raise HTTPException(status_code=400, detail=str(exc))
    return {"jobId": job.id, "paths": job.paths}


@app.post("/api/import/discard")
def discard_resumable() -> dict:
    """Discard a persisted interrupted import (user chose to start over)."""
    ok = manager.discard_resumable()
    if not ok:
        raise HTTPException(status_code=409, detail="an import is running")
    return {"discarded": True}


@app.get("/api/jobs/active")
def active_job() -> dict:
    """Current job with its live progress — lets a reconnecting/reloading window
    render the counters instantly without replaying the whole log."""
    job = manager.active_job
    return job.active_view() if job else {"jobId": None}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str, since: int = Query(0, ge=0)) -> dict:
    job = manager.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    return job.snapshot(since=since)


@app.post("/api/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict:
    ok = manager.cancel(job_id)
    if not ok:
        raise HTTPException(status_code=409, detail="job not running")
    return {"cancelled": True}


@app.get("/api/jobs/{job_id}/stream")
async def stream_job(job_id: str) -> StreamingResponse:
    job = manager.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")

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
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
