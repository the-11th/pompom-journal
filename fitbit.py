"""Fitbit Web API client. Zero Flask imports.

Network access is isolated behind an injectable `transport` callable (added in
the next task); the parsing helpers here are pure so no test hits the network.
"""
import time
from datetime import datetime


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
