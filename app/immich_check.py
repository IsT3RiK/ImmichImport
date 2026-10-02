"""Immich reachability & credential checks + network discovery for the wizard.

Everything here runs *server-side* (the browser can't reach Immich cross-origin
anyway) using only the standard library — no extra dependency, fully offline.

Philosophy, mirrored from the sibling ImmichDupFinder wizard:
  * propose before asking (discover candidate servers on the container's network);
  * verify before saving (probe the URL, then validate the API key for real);
  * explain every failure so a non-technical user knows what to do next.
"""
from __future__ import annotations

import ipaddress
import json
import socket
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed

from .settings import normalize_immich_url

PING_PATHS = ("/api/server/ping", "/api/server-info/ping")
VERSION_PATHS = ("/api/server/version", "/api/server-info/version")
ME_PATHS = ("/api/users/me", "/api/user/me")

PROBE_TIMEOUT = 3.0
CHECK_TIMEOUT = 15.0
SCAN_TIMEOUT = 1.0
DEFAULT_PORT = 2283


# --- low-level HTTP ----------------------------------------------------------
def _request(url: str, api_key: str | None = None, timeout: float = PROBE_TIMEOUT,
             method: str = "GET", data: bytes | None = None):
    """Request ``url`` → (status:int|None, body:bytes|None, err:str|None).

    ``status is None`` means the host was unreachable (DNS/refused/timeout).
    """
    headers = {"Accept": "application/json"}
    if api_key:
        headers["x-api-key"] = api_key
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read(), None
    except urllib.error.HTTPError as exc:
        # The server answered with an error status (401/403/404/5xx…).
        body = b""
        try:
            body = exc.read()
        except Exception:  # noqa: BLE001 - body is best-effort only
            pass
        return exc.code, body, None
    except (urllib.error.URLError, socket.timeout, TimeoutError, OSError) as exc:
        reason = getattr(exc, "reason", exc)
        return None, None, str(reason)


def _fetch_version(base: str, timeout: float = PROBE_TIMEOUT, api_key: str | None = None) -> str | None:
    for path in VERSION_PATHS:
        status, body, _ = _request(base + path, api_key=api_key, timeout=timeout)
        if status and status < 300 and body:
            try:
                data = json.loads(body)
                if isinstance(data, dict) and data.get("major") is not None:
                    return f"{data['major']}.{data.get('minor', 0)}.{data.get('patch', 0)}"
            except ValueError:
                pass
    return None


def _is_immich(base: str, timeout: float) -> tuple[bool, str | None]:
    """True + version if ``base`` responds to Immich's ping (``{"res":"pong"}``)."""
    for path in PING_PATHS:
        status, body, _ = _request(base + path, timeout=timeout)
        if status and status < 300 and body:
            try:
                data = json.loads(body)
            except ValueError:
                data = None
            if isinstance(data, dict) and data.get("res") == "pong":
                return True, _fetch_version(base, timeout)
    return False, None


# --- probe a single URL ------------------------------------------------------
def probe(raw_url: str) -> dict:
    base = normalize_immich_url(raw_url)
    if not base.lower().startswith(("http://", "https://")):
        base = "http://" + base
    ok, version = False, None
    last_err = None
    for path in PING_PATHS:
        status, body, err = _request(base + path, timeout=PROBE_TIMEOUT)
        if status is None:
            last_err = err
            continue
        if status >= 300:
            last_err = f"HTTP {status}"
            continue
        try:
            data = json.loads(body) if body else None
        except ValueError:
            data = None
        if isinstance(data, dict) and data.get("res") == "pong":
            ok, version = True, _fetch_version(base, PROBE_TIMEOUT)
            break
        last_err = "not-immich"
    return {"ok": ok, "url": base, "version": version, "error": None if ok else (last_err or "unreachable")}


# --- validate an API key -----------------------------------------------------
def _perm_from(status: int | None) -> str:
    if status is None:
        return "unknown"
    if status == 403:
        return "missing"
    if status == 401:
        return "unknown"
    return "ok"


def check_credentials(raw_url: str, api_key: str) -> dict:
    """Validate (URL, key). Reports the account, version and per-scope permissions.

    Return shape mirrors the frontend's expectations:
      {ok, error, user:{email,name}|None, version,
       permissions:{account, albums, jobs}}
    """
    base = normalize_immich_url(raw_url)
    if not base.lower().startswith(("http://", "https://")):
        base = "http://" + base

    empty_perms = {"account": "unknown", "albums": "unknown", "jobs": "unknown"}

    # 1) Identity: /users/me proves the key is accepted and reachable.
    me_status = None
    me_body = None
    me_err = None
    for path in ME_PATHS:
        st, body, err = _request(base + path, api_key=api_key, timeout=CHECK_TIMEOUT)
        me_status, me_body, me_err = st, body, err
        if st is not None and st != 404:
            break

    if me_status is None:
        return {"ok": False, "error": {"code": "unreachable", "detail": me_err},
                "user": None, "version": None, "permissions": empty_perms}
    if me_status == 401:
        return {"ok": False, "error": {"code": "keyRejected"},
                "user": None, "version": None, "permissions": empty_perms}
    if me_status >= 300:
        return {"ok": False, "error": {"code": "httpStatus", "detail": str(me_status)},
                "user": None, "version": None, "permissions": empty_perms}

    user = None
    if me_body:
        try:
            parsed = json.loads(me_body)
            if isinstance(parsed, dict):
                user = {"email": parsed.get("email", ""), "name": parsed.get("name", "")}
        except ValueError:
            pass

    # 2) Album read permission (only matters when album mode is on).
    albums_status, _, _ = _request(base + "/api/albums", api_key=api_key, timeout=CHECK_TIMEOUT)

    # 3) Job control. immich-go pauses Immich's background jobs during the
    # upload (PUT /api/jobs/<name>: admin key with job.create) and refuses to
    # start when it can't. The same route is called with an invalid job name
    # and no command: Immich checks the rights first (403 when missing), then
    # rejects the request itself (400) — nothing is ever paused.
    jobs_status, _, _ = _request(base + "/api/jobs/immich-import-permission-check",
                                 api_key=api_key, timeout=CHECK_TIMEOUT,
                                 method="PUT", data=b"{}")
    if jobs_status == 403:
        jobs_perm = "missing"
    elif jobs_status is not None and 400 <= jobs_status < 500 and jobs_status not in (401, 404):
        jobs_perm = "ok"
    else:
        jobs_perm = "unknown"

    permissions = {"account": "ok", "albums": _perm_from(albums_status),
                   "jobs": jobs_perm}
    version = _fetch_version(base, PROBE_TIMEOUT, api_key=api_key)
    return {"ok": True, "error": None, "user": user, "version": version, "permissions": permissions}


# --- network discovery -------------------------------------------------------
# Candidate addresses are probed server-side and only the ones that answer
# Immich's ping are returned. Sources are structured ({kind, ...}) so the
# frontend can localize them; interface names come straight from the OS.
DOCKER_HOSTNAMES = ("immich_server", "immich-server", "immich")

try:
    import psutil  # cross-platform interface enumeration (friendly names + netmasks)
except Exception:  # noqa: BLE001 - optional; discovery degrades gracefully without it
    psutil = None


def _is_private_v4(ip: str) -> bool:
    """RFC1918 only — deliberately excludes link-local (169.254/16) APIPA
    addresses, which belong to disconnected adapters and are never scannable."""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return any(addr in ipaddress.ip_network(net)
               for net in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))


def _default_gateway() -> str | None:
    """The container's default gateway = very often the Docker host (Linux)."""
    try:
        with open("/proc/net/route", encoding="utf-8") as fh:
            for line in fh.readlines()[1:]:
                fields = line.strip().split()
                if len(fields) >= 3 and fields[1] == "00000000":
                    gw = int(fields[2], 16)
                    return socket.inet_ntoa(gw.to_bytes(4, "little"))
    except (OSError, ValueError):
        pass
    return None


def _local_networks() -> list[dict]:
    """Every non-loopback IPv4 interface: {address, prefix, cidr, iface}.

    This is what turns the wizard's server step into a rich, named list — one
    entry per real network the container/host is attached to (LAN, VPN, Docker
    bridges, VMware/WSL adapters…), each labelled with its OS interface name.
    """
    out: list[dict] = []
    if psutil is None:
        # Fallback: at least our own resolvable IPv4s (no interface names).
        try:
            for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
                ip = info[4][0]
                if ip and not ip.startswith("127."):
                    out.append({"address": ip, "prefix": 24, "iface": "",
                                "cidr": f"{ip.rsplit('.', 1)[0]}.0/24"})
        except OSError:
            pass
        return out
    try:
        for iface, addrs in psutil.net_if_addrs().items():
            for a in addrs:
                if a.family != socket.AF_INET:
                    continue
                ip = a.address
                if not ip or ip.startswith("127."):
                    continue
                try:
                    net = ipaddress.ip_network(f"{ip}/{a.netmask or '255.255.255.0'}", strict=False)
                    prefix = net.prefixlen
                    cidr = str(net)
                except ValueError:
                    prefix, cidr = 24, f"{ip.rsplit('.', 1)[0]}.0/24"
                out.append({"address": ip, "prefix": prefix, "iface": iface, "cidr": cidr})
    except Exception:  # noqa: BLE001
        pass
    return out


def _build_candidates() -> list[dict]:
    """Likely Immich URLs to probe, with a structured (localizable) source."""
    out: list[dict] = []
    seen: set[str] = set()

    def push(url: str, source: dict) -> None:
        if url in seen:
            return
        seen.add(url)
        out.append({"url": url, "source": source})

    # 1. Same Docker network: reach Immich by its service name.
    for host in DOCKER_HOSTNAMES:
        push(f"http://{host}:{DEFAULT_PORT}", {"kind": "docker", "host": host})
    # 2. Immich on the Docker host, from inside the container.
    gw = _default_gateway()
    if gw:
        push(f"http://{gw}:{DEFAULT_PORT}", {"kind": "gateway"})
    push(f"http://host.docker.internal:{DEFAULT_PORT}", {"kind": "dockerHost"})
    # 3. Same machine (network_mode: host, or running outside Docker).
    push(f"http://localhost:{DEFAULT_PORT}", {"kind": "localhost"})
    # 4. The container's own interface addresses (useful on macvlan / host net).
    for net in _local_networks():
        push(f"http://{net['address']}:{DEFAULT_PORT}",
             {"kind": "iface", "iface": net["iface"]})
    return out


def suggested_subnets() -> list[dict]:
    """Private subnets offered in the manual scan selector.

    First what the container actually sees, then the most common home ranges
    (the container is often on an isolated Docker network while Immich sits on
    the LAN, reachable by routing but invisible to interface enumeration).
    """
    out: list[dict] = []
    seen: set[str] = set()

    for net in _local_networks():
        if not _is_private_v4(net["address"]):
            continue
        # A /16 is 65k hosts, a /32 is none: fall back to the address's /24,
        # which is what "my local network" means in practice.
        if 22 <= net["prefix"] <= 30:
            cidr = net["cidr"]
        else:
            cidr = f"{net['address'].rsplit('.', 1)[0]}.0/24"
        if cidr in seen:
            continue
        seen.add(cidr)
        out.append({"cidr": cidr, "kind": "iface", "iface": net["iface"], "detected": True})

    for cidr in ("192.168.1.0/24", "192.168.0.0/24", "10.0.0.0/24", "192.168.2.0/24"):
        if cidr in seen:
            continue
        seen.add(cidr)
        out.append({"cidr": cidr, "kind": "common", "detected": False})
    return out


def discover() -> dict:
    """Probe every likely Immich address concurrently; keep the ones that answer."""
    candidates = _build_candidates()
    found = []
    seen = set()
    with ThreadPoolExecutor(max_workers=16) as pool:
        futures = {pool.submit(_is_immich, c["url"], PROBE_TIMEOUT): c for c in candidates}
        for fut in as_completed(futures):
            c = futures[fut]
            try:
                ok, version = fut.result()
            except Exception:  # noqa: BLE001
                ok, version = False, None
            if ok and c["url"] not in seen:
                seen.add(c["url"])
                found.append({"url": c["url"], "source": c["source"], "version": version})
    return {"candidates": found, "subnets": suggested_subnets()}


def scan_subnet(cidr: str) -> list[dict]:
    """Probe every host of a private subnet (max /22) for an Immich server.

    Deliberately restricted to private ranges and 1024 hosts: this route is
    exposed without authentication and must not become a generic scanner.
    """
    net = ipaddress.ip_network(cidr, strict=False)
    if not _is_private_v4(str(net.network_address)):
        raise ValueError("not-private")
    hosts = list(net.hosts())
    if len(hosts) > 1024:
        raise ValueError("too-large")

    found = []
    with ThreadPoolExecutor(max_workers=64) as pool:
        futures = {pool.submit(_is_immich, f"http://{ip}:{DEFAULT_PORT}", SCAN_TIMEOUT): str(ip)
                   for ip in hosts}
        for fut in as_completed(futures):
            ip = futures[fut]
            try:
                ok, version = fut.result()
            except Exception:  # noqa: BLE001
                ok, version = False, None
            if ok:
                found.append({"url": f"http://{ip}:{DEFAULT_PORT}",
                              "source": {"kind": "scan"}, "version": version})
    return found
