"""Application logging: one line format for every message, on stdout.

Why this exists: before it, nothing the app itself did was visible in
``docker logs`` — only uvicorn's access lines. Job progress, immich-go
invocations and the exclusions applied to the tree all went to an in-memory
buffer that never left the process, which made "the UI announced 250 000 files
and immich-go found 12 000" impossible to diagnose from the outside.

Every record — HTTP access and application alike — is rendered as::

    IP | METHOD | PATH | STATUS | TIMESTAMP | LEVEL | message

Fields that don't apply to a given record are rendered as ``-``. Request-scoped
fields are carried by a ContextVar so that an application log emitted deep
inside a request handler is attributed to that request without any plumbing.

Never log the Immich API key: importer.py redacts it before logging the
command line, and nothing here should ever be handed a raw key.
"""
from __future__ import annotations

import contextvars
import logging
import sys
import time
from contextlib import contextmanager

# Request-scoped context, populated by the HTTP middleware in main.py.
_ctx: contextvars.ContextVar[dict] = contextvars.ContextVar("log_ctx", default={})

_FIELDS = ("ip", "method", "path", "status")
_FORMAT = "%(ip)s | %(method)s | %(path)s | %(status)s | %(asctime)s | %(levelname)s | %(message)s"
_DATEFMT = "%Y-%m-%dT%H:%M:%S%z"


@contextmanager
def request_context(ip: str | None, method: str | None, path: str | None):
    """Attach IP/method/path to every log record emitted inside this block."""
    token = _ctx.set({"ip": ip or "-", "method": method or "-", "path": path or "-"})
    try:
        yield
    finally:
        _ctx.reset(token)


class ContextFilter(logging.Filter):
    """Fill the format's extra fields from the request context or with ``-``.

    An explicit ``extra=`` on the call site always wins: that is how the access
    middleware reports a status code, and how the importer tags job lines.
    """

    def filter(self, record: logging.LogRecord) -> bool:  # noqa: D102
        ctx = _ctx.get()
        for field in _FIELDS:
            if not hasattr(record, field):
                setattr(record, field, ctx.get(field, "-"))
        return True


class _Formatter(logging.Formatter):
    converter = time.localtime

    def format(self, record: logging.LogRecord) -> str:
        # Keep the layout on ONE line: a stack trace or an embedded newline must
        # not break `docker logs | grep` for the rest of the pipeline.
        text = super().format(record)
        return text.replace("\n", " ⏎ ")


def configure(level: str = "INFO") -> None:
    """Install the stdout handler on the root logger (idempotent).

    uvicorn's own loggers are re-parented onto it so access lines, error lines
    and application lines share a single format and a single stream.
    """
    root = logging.getLogger()
    handler: logging.Handler | None = None
    for existing in root.handlers:
        if getattr(existing, "_immichimport", False):
            handler = existing
            break
    if handler is None:
        stream = sys.stdout
        # The container's stdout may be ASCII by default (and a Windows dev
        # console usually is): force UTF-8 so an accented job message can never
        # take the whole log line down with a UnicodeEncodeError.
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except (AttributeError, ValueError):
            pass
        handler = logging.StreamHandler(stream)
        handler._immichimport = True  # type: ignore[attr-defined]
        handler.addFilter(ContextFilter())
        root.addHandler(handler)
    handler.setFormatter(_Formatter(_FORMAT, datefmt=_DATEFMT))
    root.setLevel(getattr(logging, level.upper(), logging.INFO))

    # uvicorn installs its own handlers with its own format; drop them and let
    # everything bubble up to the root handler above.
    for name in ("uvicorn", "uvicorn.error", "uvicorn.access"):
        lg = logging.getLogger(name)
        lg.handlers.clear()
        lg.propagate = True
    # Our middleware already logs one access line per request with the full
    # context; uvicorn's would be a duplicate in a different shape.
    logging.getLogger("uvicorn.access").disabled = True
    # Third-party chatter (one INFO line per outgoing HTTP call, one per event
    # loop selector) has no place in an import log; keep it for real problems.
    for name in ("httpx", "httpcore", "asyncio", "urllib3"):
        logging.getLogger(name).setLevel(logging.WARNING)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(f"immichimport.{name}")
