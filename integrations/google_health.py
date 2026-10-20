"""Google Health API sleep client. Zero Flask imports.

OAuth delegated to oauth.py (Google: client creds in the POST body,
access_type=offline + prompt=consent for a refresh token). Network behind the
injectable transport (default oauth.urllib_transport); tests pass a fake.
"""
import urllib.parse
from datetime import datetime, timedelta

from . import oauth

_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth"
_TOKEN = "https://oauth2.googleapis.com/token"
_API = "https://health.googleapis.com"
_SCOPE = "https://www.googleapis.com/auth/googlehealth.sleep.readonly"
_STAGE_KEYS = {"DEEP": "deep", "LIGHT": "light", "REM": "rem", "AWAKE": "wake"}


def build_authorize_url(client_id, redirect_uri, state):
    return oauth.build_authorize_url(
        _AUTHORIZE, client_id, redirect_uri, state, _SCOPE,
        extra={"access_type": "offline", "prompt": "consent"})


def exchange_code(client_id, client_secret, code, redirect_uri, transport=None, now=None):
    return oauth.exchange_code(_TOKEN, client_id, client_secret, code, redirect_uri,
                               transport=transport, now=now, client_auth="body")


def refresh_tokens(client_id, client_secret, refresh_token, transport=None, now=None, prev=None):
    return oauth.refresh_tokens(_TOKEN, client_id, client_secret, refresh_token,
                                transport=transport, now=now, client_auth="body", prev=prev)


def token_expired(tokens, now=None):
    return oauth.token_expired(tokens, now=now)


def fetch_sleep(access_token, date, transport=None):
    """Sleep data points whose civil end-date is `date` (YYYY-MM-DD)."""
    transport = transport or oauth.urllib_transport
    nxt = (datetime.strptime(date, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
    flt = (f'sleep.interval.civil_end_time >= "{date}" '
           f'AND sleep.interval.civil_end_time < "{nxt}"')
    q = urllib.parse.urlencode({"pageSize": 25, "filter": flt})
    url = f"{_API}/v4/users/me/dataTypes/sleep/dataPoints?{q}"
    status, payload = transport("GET", url, {"Authorization": f"Bearer {access_token}"}, None)
    if status == 401:
        raise PermissionError("Google token expired")
    if status != 200:
        raise RuntimeError(f"Google Health sleep error {status}: {payload}")
    return payload


def _seconds(dur):
    """'4260s' -> 4260 (int seconds)."""
    try:
        return int(float(str(dur).rstrip("s")))
    except (TypeError, ValueError):
        return 0


def _local_clock(iso, offset):
    """RFC3339 UTC time + offset like '-25200s' -> local 'HH:MM'."""
    base = datetime.strptime(iso[:19], "%Y-%m-%dT%H:%M:%S")
    return (base + timedelta(seconds=_seconds(offset))).strftime("%H:%M")


def _main_record(points):
    """Longest sleep payload by interval length, or None."""
    sleeps = [p["sleep"] for p in points if isinstance(p.get("sleep"), dict)]
    if not sleeps:
        return None
    def span(s):
        iv = s.get("interval") or {}
        try:
            a = datetime.strptime(iv["startTime"][:19], "%Y-%m-%dT%H:%M:%S")
            b = datetime.strptime(iv["endTime"][:19], "%Y-%m-%dT%H:%M:%S")
            return (b - a).total_seconds()
        except (KeyError, ValueError):
            return 0
    return max(sleeps, key=span)


def parse_sleep(api_json, now=None):
    rec = _main_record((api_json or {}).get("dataPoints") or [])
    if rec is None:
        return None
    iv = rec.get("interval") or {}
    start = _local_clock(iv["startTime"], iv.get("startUtcOffset", "0s"))
    end = _local_clock(iv["endTime"], iv.get("endUtcOffset", "0s"))

    stages = None
    if rec.get("sleepType") == "STAGES" and rec.get("sleepStages"):
        stages = {"deep": 0, "light": 0, "rem": 0, "wake": 0}
        for st in rec["sleepStages"]:
            key = _STAGE_KEYS.get(st.get("stageType"))
            if key:
                stages[key] += round(_seconds(st.get("duration")) / 60)

    summary = rec.get("sleepSummary") or {}
    if summary.get("totalSleepDuration") or summary.get("duration"):
        duration_min = round(_seconds(summary.get("totalSleepDuration")
                                      or summary.get("duration")) / 60)
    elif stages:
        duration_min = stages["deep"] + stages["light"] + stages["rem"]
    else:
        a = datetime.strptime(iv["startTime"][:19], "%Y-%m-%dT%H:%M:%S")
        b = datetime.strptime(iv["endTime"][:19], "%Y-%m-%dT%H:%M:%S")
        duration_min = round((b - a).total_seconds() / 60)

    efficiency = summary.get("efficiency")
    score = None
    quality = score if score is not None else efficiency
    fetched = (now or datetime.now()).replace(microsecond=0).isoformat()
    return {
        "start": start, "end": end, "duration_min": duration_min,
        "efficiency": efficiency, "score": score, "quality": quality,
        "stages": stages, "source": "google", "fetched": fetched,
    }
