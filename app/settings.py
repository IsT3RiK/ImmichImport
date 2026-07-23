"""Connection settings — environment OR setup wizard, persisted in STATE_DIR.

The Immich URL, API key and album mode can come from two places:

* **Environment variables** (``IMMICH_URL`` + ``IMMICH_API_KEY``). When *both*
  are set the connection is *locked*: the UI can't change it and the setup
  wizard is skipped. This is the "frozen deployment" path.
* **The setup wizard**, for someone who only knows how to launch a container.
  What they validate is written to ``STATE_DIR/settings.json`` (a writable
  volume) and takes precedence over a lone env default.

The API key never leaves the backend — the browser only ever learns whether one
is set, never its value.
"""
from __future__ import annotations

import json
import os
import tempfile
import threading

from . import config

_FILE = config.STATE_DIR / "settings.json"
_lock = threading.Lock()


# --- tiny JSON key/value store (atomic, best-effort) -------------------------
def _load() -> dict:
    try:
        with open(_FILE, encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _atomic_write(data: dict) -> None:
    try:
        config.STATE_DIR.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=str(config.STATE_DIR), suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(data, fh, ensure_ascii=False, indent=2)
            os.replace(tmp, _FILE)
        finally:
            if os.path.exists(tmp):
                try:
                    os.remove(tmp)
                except OSError:
                    pass
    except OSError:
        pass


def read_setting(key: str):
    return _load().get(key)


def write_setting(key: str, value) -> None:
    with _lock:
        data = _load()
        data[key] = value
        _atomic_write(data)


def clear_setting(key: str) -> None:
    with _lock:
        data = _load()
        if key in data:
            del data[key]
            _atomic_write(data)


# --- connection resolution ---------------------------------------------------
def normalize_immich_url(url: str) -> str:
    """Trim a user-entered URL: no trailing slash, no stray ``/api`` suffix."""
    out = (url or "").strip().rstrip("/")
    if out.lower().endswith("/api"):
        out = out[:-4]
    return out


# Both env vars present => the connection is frozen by the environment.
LOCKED_BY_ENV = config.ENV_IMMICH_URL is not None and config.ENV_IMMICH_API_KEY is not None


def _resolve(env_value, key: str):
    # When locked, the env is authoritative. Otherwise a lone env var is only a
    # default: what the user validated in the wizard wins (else a stray
    # IMMICH_URL in a compose file would make the wizard inoperative).
    if LOCKED_BY_ENV:
        return env_value
    return read_setting(key) or env_value


def immich_url() -> str:
    url = _resolve(config.ENV_IMMICH_URL, "immichUrl") or ""
    return normalize_immich_url(url) if url else ""


def immich_api_key() -> str:
    return _resolve(config.ENV_IMMICH_API_KEY, "immichApiKey") or ""


def album_mode() -> str:
    return (_resolve(config.ENV_ALBUM_MODE, "albumMode") or "FOLDER").upper()


def has_api_key() -> bool:
    return bool(immich_api_key())


def get_connection() -> dict | None:
    url, key = immich_url(), immich_api_key()
    if not url or not key:
        return None
    return {"url": url, "apiKey": key}


def save_connection(url: str, api_key: str | None, album: str | None = None) -> None:
    """Persist what the wizard validated. Refused when locked by the environment."""
    if LOCKED_BY_ENV:
        raise RuntimeError("locked by env")
    write_setting("immichUrl", normalize_immich_url(url))
    if api_key is not None and api_key.strip():
        write_setting("immichApiKey", api_key.strip())
    if album:
        write_setting("albumMode", album.upper())


# --- setup-wizard completion -------------------------------------------------
_SETUP_KEY = "setupCompleted"


def is_setup_completed() -> bool:
    # Nothing to configure when the env locks the connection.
    if LOCKED_BY_ENV:
        return True
    return read_setting(_SETUP_KEY) == "1"


def mark_setup_completed() -> None:
    write_setting(_SETUP_KEY, "1")


def reset_setup() -> None:
    clear_setting(_SETUP_KEY)


def api_key_url_for(url: str) -> str:
    """Direct link to the API-keys screen of an Immich instance."""
    return normalize_immich_url(url) + "/user-settings?isOpen=api-keys"
