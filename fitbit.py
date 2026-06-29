"""Fitbit Web API client. Zero Flask imports.

Network access is isolated behind an injectable `transport` callable; tests
pass a fake transport so no test hits the network.
"""
import base64
import json
import time
import urllib.parse
import urllib.request
from datetime import datetime

_AUTHORIZE = "https://www.fitbit.com/oauth2/authorize"
_TOKEN = "https://api.fitbit.com/oauth2/token"
_API = "https://api.fitbit.com"


def _clock(iso):
    """'2026-06-28T23:14:00.000' -> '23:14' (local clock, no tz math)."""
    return datetime.strptime(iso[:19], "%Y-%m-%dT%H:%M:%S").strftime("%H:%M")


def _main_record(records):
    """The isMainSleep record, else the longest by minutesAsleep, else None."""
    if not records:
        return None
    for r in records:
        if r.get("isMainSleep"):
            return r
    return max(records, key=lambda r: r.get("minutesAsleep", 0))


def _stages(rec):
    """{deep,light,rem,wake} minutes for a 'stages' record, else None."""
    if rec.get("type") != "stages":
        return None
    summary = (rec.get("levels") or {}).get("summary") or {}
    out = {}
    for key in ("deep", "light", "rem", "wake"):
        out[key] = int((summary.get(key) or {}).get("minutes", 0))
    return out


def parse_sleep(api_json, now=None):
    """Fitbit sleep-by-date JSON -> our sleep dict, or None when no record.

    Selects the main sleep record; naps ignored. quality = score if the API
    exposes one (rare), else efficiency. `stages` is None for classic sleep.
    """
    rec = _main_record((api_json or {}).get("sleep") or [])
    if rec is None:
        return None
    efficiency = rec.get("efficiency")
    score = api_json.get("sleepScore")
    quality = score if score is not None else efficiency
    fetched = (now or datetime.now()).replace(microsecond=0).isoformat()
    return {
        "start": _clock(rec["startTime"]),
        "end": _clock(rec["endTime"]),
        "duration_min": int(rec.get("minutesAsleep", 0)),
        "efficiency": efficiency,
        "score": score,
        "quality": quality,
        "stages": _stages(rec),
        "source": "fitbit",
        "fetched": fetched,
    }


def normalize_token_response(raw, now=None):
    """Fitbit token JSON -> our tokens dict with an absolute `expires_at`."""
    t = now if now is not None else time.time()
    return {
        "access_token": raw.get("access_token"),
        "refresh_token": raw.get("refresh_token"),
        "scope": raw.get("scope"),
        "expires_at": t + float(raw.get("expires_in", 0)),
        "fetched": datetime.now().replace(microsecond=0).isoformat(),
    }


def token_expired(tokens, now=None):
    """True when the access token is at/within 60 s of expiry."""
    t = now if now is not None else time.time()
    return t >= float((tokens or {}).get("expires_at", 0)) - 60


def build_authorize_url(client_id, redirect_uri, state, scope="sleep"):
    """Build the Fitbit OAuth2 authorization URL."""
    q = urllib.parse.urlencode({
        "client_id": client_id,
        "response_type": "code",
        "scope": scope,
        "redirect_uri": redirect_uri,
        "state": state,
    })
    return f"{_AUTHORIZE}?{q}"


def _urllib_transport(method, url, headers, body):
    """Default real transport using urllib. Tests replace this with a fake."""
    data = body.encode("utf-8") if isinstance(body, str) else body
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8"))


def _basic_auth(client_id, client_secret):
    raw = f"{client_id}:{client_secret}".encode("utf-8")
    return "Basic " + base64.b64encode(raw).decode("ascii")


def _post_token(client_id, client_secret, form, transport, now):
    transport = transport or _urllib_transport
    headers = {
        "Authorization": _basic_auth(client_id, client_secret),
        "Content-Type": "application/x-www-form-urlencoded",
    }
    body = urllib.parse.urlencode(form)
    status, payload = transport("POST", _TOKEN, headers, body)
    if status != 200:
        raise RuntimeError(f"Fitbit token error {status}: {payload}")
    return normalize_token_response(payload, now=now)


def exchange_code(client_id, client_secret, code, redirect_uri,
                  transport=None, now=None):
    """Exchange an authorization code for tokens."""
    return _post_token(client_id, client_secret, {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
    }, transport, now)


def refresh_tokens(client_id, client_secret, refresh_token,
                   transport=None, now=None):
    """Refresh an access token using a refresh token."""
    return _post_token(client_id, client_secret, {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
    }, transport, now)


def fetch_sleep(access_token, date, transport=None):
    """Fetch raw sleep data from the Fitbit API for the given date (YYYY-MM-DD)."""
    transport = transport or _urllib_transport
    url = f"{_API}/1.2/user/-/sleep/date/{date}.json"
    headers = {"Authorization": f"Bearer {access_token}"}
    status, payload = transport("GET", url, headers, None)
    if status == 401:
        raise PermissionError("Fitbit token expired")
    if status != 200:
        raise RuntimeError(f"Fitbit sleep error {status}: {payload}")
    return payload
