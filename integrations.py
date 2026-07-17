"""Third-party integration credential/token store. Zero Flask imports.

Same forgiving-load / atomic-save pattern as journal.py and todo.py. Each
top-level key is a provider; values hold credentials + OAuth tokens + sync
bookkeeping. Shaped so rescuetime/spotify slot in with no schema change.
"""
import json
import hashlib
import os
import secrets
import tempfile
import uuid
from datetime import datetime, timedelta

_PROVIDERS = ("google", "rescuetime", "spotify", "phone", "health", "mobile")


def _empty():
    return {name: {} for name in _PROVIDERS}


def load(path):
    """Read the store. Missing file -> empty. Corrupt -> backed up to .bak +
    empty. Missing provider keys defaulted."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            parsed = json.load(f)
    except FileNotFoundError:
        return _empty()
    except json.JSONDecodeError:
        try:
            os.replace(path, path + ".bak")
        except OSError:
            pass
        return _empty()
    if not isinstance(parsed, dict):
        try:
            os.replace(path, path + ".bak")
        except OSError:
            pass
        return _empty()
    for name in _PROVIDERS:
        if not isinstance(parsed.get(name), dict):
            parsed[name] = {}
    return parsed


def save(path, data):
    """Atomic write (temp file + os.replace)."""
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(path)))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def get_provider(data, name):
    return data.setdefault(name, {})


def set_credentials(data, name, client_id, client_secret):
    p = get_provider(data, name)
    p["client_id"] = client_id
    p["client_secret"] = client_secret
    return data


def set_tokens(data, name, tokens):
    get_provider(data, name)["tokens"] = tokens
    return data


def set_api_key(data, name, key):
    get_provider(data, name)["api_key"] = key
    return data


def set_token(data, name, token):
    """Store a shared bearer token (phone-usage push auth). Distinct from the
    RescueTime `api_key`; both count as "connected"."""
    get_provider(data, name)["token"] = token
    return data


def get_token(data, name):
    return get_provider(data, name).get("token")


def set_taste(data, name, taste):
    get_provider(data, name)["taste"] = taste
    return data


def get_taste(data, name):
    return get_provider(data, name).get("taste")


def set_plays_buffer(data, name, buffer):
    get_provider(data, name)["plays_buffer"] = buffer
    return data


def get_plays_buffer(data, name):
    return get_provider(data, name).get("plays_buffer") or {}


def set_analytics(data, name, analytics):
    get_provider(data, name)["analytics"] = analytics
    return data


def get_analytics(data, name):
    return get_provider(data, name).get("analytics") or {}


def clear_provider(data, name):
    p = get_provider(data, name)
    p.pop("tokens", None)
    p.pop("last_sync", None)
    p.pop("oauth_state", None)
    p.pop("api_key", None)
    p.pop("token", None)
    p.pop("taste", None)
    p.pop("plays_buffer", None)
    p.pop("analytics", None)
    return data


def is_connected(data, name):
    p = get_provider(data, name)
    tokens = p.get("tokens")
    if tokens and tokens.get("access_token"):
        return True
    return bool(p.get("api_key") or p.get("token"))


def last_sync(data, name):
    return get_provider(data, name).get("last_sync")


def set_last_sync(data, name, when):
    get_provider(data, name)["last_sync"] = when
    return data


# Mobile journal/task app --------------------------------------------------- #

def _token_digest(token):
    return hashlib.sha256((token or "").encode("utf-8")).hexdigest()


def _iso_now(now=None):
    if isinstance(now, str):
        return now
    return (now or datetime.now()).isoformat()


def _mobile_enrollment_fresh(enrollment, now=None):
    """Pairing codes are valid for ten minutes and exactly one exchange."""
    try:
        created = datetime.fromisoformat(enrollment.get("created", ""))
        current = datetime.fromisoformat(_iso_now(now))
    except (TypeError, ValueError):
        return False
    return created <= current <= created + timedelta(minutes=10)


def issue_mobile_enrollment(data, now=None):
    """Create a single-use pairing secret. Only its SHA-256 digest is stored."""
    token = secrets.token_urlsafe(32)
    mobile = get_provider(data, "mobile")
    mobile.setdefault("enrollments", []).append({
        "digest": _token_digest(token), "created": _iso_now(now)})
    # Pairing codes are deliberately short-lived in practice; cap abandoned
    # records so a long-running local install cannot grow without bound.
    mobile["enrollments"] = mobile["enrollments"][-20:]
    return token


def enroll_mobile_device(data, enrollment_token, device_name, now=None):
    """Consume a pairing secret and return ``(public_device, bearer_token)``.

    Returns None for an unknown/already-consumed secret. Device bearer tokens
    are independently generated and stored only as hashes.
    """
    mobile = get_provider(data, "mobile")
    digest = _token_digest(enrollment_token)
    enrollments = mobile.setdefault("enrollments", [])
    # Prune stale codes before matching so an abandoned QR cannot remain a
    # permanent credential and the store stays forgiving across old versions.
    enrollments[:] = [e for e in enrollments if _mobile_enrollment_fresh(e, now)]
    match = next((e for e in enrollments
                  if secrets.compare_digest(e.get("digest", ""), digest)), None)
    if match is None:
        return None
    enrollments.remove(match)
    bearer = secrets.token_urlsafe(40)
    device = {
        "id": uuid.uuid4().hex,
        "name": (device_name or "Android phone").strip()[:80] or "Android phone",
        "token_digest": _token_digest(bearer),
        "created": _iso_now(now),
        "last_seen": _iso_now(now),
    }
    mobile.setdefault("devices", []).append(device)
    return mobile_device_public(device), bearer


def mobile_device_public(device):
    return {key: device.get(key) for key in ("id", "name", "created", "last_seen")}


def authenticate_mobile_device(data, bearer_token, now=None):
    digest = _token_digest(bearer_token)
    for device in get_provider(data, "mobile").setdefault("devices", []):
        if secrets.compare_digest(device.get("token_digest", ""), digest):
            device["last_seen"] = _iso_now(now)
            return mobile_device_public(device)
    return None


def revoke_mobile_device(data, device_id):
    mobile = get_provider(data, "mobile")
    before = len(mobile.setdefault("devices", []))
    mobile["devices"] = [d for d in mobile["devices"] if d.get("id") != device_id]
    mobile.setdefault("requests", {}).pop(device_id, None)
    return len(mobile["devices"]) != before


def mobile_devices(data):
    return [mobile_device_public(d)
            for d in get_provider(data, "mobile").setdefault("devices", [])]


def mobile_request_receipt(data, device_id, request_id):
    if not request_id:
        return None
    return (get_provider(data, "mobile").setdefault("requests", {})
            .get(device_id, {}).get(request_id))


def remember_mobile_request(data, device_id, request_id, status, body):
    if not request_id:
        return data
    requests = get_provider(data, "mobile").setdefault("requests", {})
    device_requests = requests.setdefault(device_id, {})
    device_requests[request_id] = {"status": int(status), "body": body}
    # Dict insertion order is stable; retain the newest 200 receipts/device.
    while len(device_requests) > 200:
        device_requests.pop(next(iter(device_requests)))
    return data
