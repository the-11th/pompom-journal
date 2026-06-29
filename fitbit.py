"""Fitbit Web API client. Zero Flask imports.

OAuth is delegated to oauth.py; only the sleep-specific fetch/parse live here.
Network is behind oauth.urllib_transport (tests pass a fake transport).
"""
from datetime import datetime

import oauth

_AUTHORIZE = "https://www.fitbit.com/oauth2/authorize"
_TOKEN = "https://api.fitbit.com/oauth2/token"
_API = "https://api.fitbit.com"


def build_authorize_url(client_id, redirect_uri, state, scope="sleep"):
    return oauth.build_authorize_url(_AUTHORIZE, client_id, redirect_uri, state, scope)


def exchange_code(client_id, client_secret, code, redirect_uri, transport=None, now=None):
    return oauth.exchange_code(_TOKEN, client_id, client_secret, code, redirect_uri,
                               transport=transport, now=now)


def refresh_tokens(client_id, client_secret, refresh_token, transport=None, now=None):
    return oauth.refresh_tokens(_TOKEN, client_id, client_secret, refresh_token,
                                transport=transport, now=now)


def normalize_token_response(raw, now=None):
    return oauth.normalize_token_response(raw, now=now)


def token_expired(tokens, now=None):
    return oauth.token_expired(tokens, now=now)


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


def fetch_sleep(access_token, date, transport=None):
    """Fetch raw sleep data from the Fitbit API for the given date (YYYY-MM-DD)."""
    transport = transport or oauth.urllib_transport
    url = f"{_API}/1.2/user/-/sleep/date/{date}.json"
    headers = {"Authorization": f"Bearer {access_token}"}
    status, payload = transport("GET", url, headers, None)
    if status == 401:
        raise PermissionError("Fitbit token expired")
    if status != 200:
        raise RuntimeError(f"Fitbit sleep error {status}: {payload}")
    return payload
