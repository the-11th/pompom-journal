"""RescueTime Analytic Data API client. Zero Flask imports.

Auth is a personal API key (no OAuth). Network is behind an injectable
transport (default oauth.urllib_transport); tests pass a fake.
"""
import math
import urllib.error
import urllib.parse
from datetime import datetime

import oauth

_FEED = "https://www.rescuetime.com/anapi/daily_summary_feed"
_ANALYTIC = "https://www.rescuetime.com/anapi/data"

# Feed field (sans the trailing "_hours") -> display name for top categories.
_CATEGORY_FIELDS = {
    "software_development": "Software Development",
    "communication_and_scheduling": "Communication And Scheduling",
    "business": "Business",
    "design_and_composition": "Design And Composition",
    "reference_and_learning": "Reference And Learning",
    "social_networking": "Social Networking",
    "entertainment": "Entertainment",
    "news": "News",
    "shopping": "Shopping",
    "utilities": "Utilities",
    "uncategorized": "Uncategorized",
}


class RescueTimeError(RuntimeError):
    """Safe provider failure: never reflect URLs, credentials or response bodies."""
    def __init__(self, status=None):
        self.status = status
        message = {401: "Reconnect RescueTime with a valid API key.",
                   403: "This report is not available with this RescueTime account or key.",
                   429: "RescueTime rate limit reached. Try again later."}.get(
                       status, "RescueTime could not be reached. Try again later.")
        super().__init__(message)


def _get(api_key, endpoint, params, transport=None):
    transport = transport or oauth.urllib_transport
    url = endpoint + "?" + urllib.parse.urlencode({"format": "json", **params})
    try:
        status, payload = transport("GET", url, {"Authorization": "Bearer " + api_key}, None)
    except urllib.error.HTTPError as exc:
        raise RescueTimeError(exc.code) from None
    except Exception:
        raise RescueTimeError() from None
    if status != 200:
        raise RescueTimeError(status)
    return payload


def fetch_daily_summary(api_key, transport=None):
    """Recent completed days (the feed excludes today)."""
    payload = _get(api_key, _FEED, {}, transport)
    if not isinstance(payload, list):
        raise ValueError("RescueTime returned an invalid daily summary.")
    return payload


# Productivity score (RescueTime -2..2) -> human label, for tooltips/notes.
_PRODUCTIVITY_LABELS = {
    2: "very productive", 1: "productive", 0: "neutral",
    -1: "distracting", -2: "very distracting",
}


def fetch_activities(api_key, date, transport=None):
    """Per-activity (application/website) breakdown for a single day.

    Uses the Analytic Data API (`anapi/data`) with `restrict_kind=activity` and
    the rank perspective (ordered by time spent). `date` is 'YYYY-MM-DD' (the
    range is restricted to that single day). Returns raw API JSON.
    """
    return _report(api_key, date, "activity", transport=transport)


def fetch_hourly(api_key, date, transport=None):
    return _report(api_key, date, "activity", perspective="interval", transport=transport)


def fetch_documents(api_key, date, transport=None):
    return _report(api_key, date, "document", transport=transport)


def _report(api_key, date, kind, perspective="rank", transport=None):
    if not isinstance(date, str) or datetime.strptime(date, "%Y-%m-%d").date().isoformat() != date:
        raise ValueError("Choose a valid report date")
    params = {"perspective": perspective, "restrict_kind": kind,
              "restrict_begin": date, "restrict_end": date}
    if perspective == "interval":
        params["resolution_time"] = "hour"
    payload = _get(api_key, _ANALYTIC, params, transport)
    validate_report(payload)
    return payload


def validate_report(payload):
    if not isinstance(payload, dict) or not isinstance(payload.get("rows"), list):
        raise ValueError("RescueTime returned an invalid report.")
    headers = payload.get("row_headers")
    if headers is not None and (not isinstance(headers, list) or any(not isinstance(h, str) for h in headers)):
        raise ValueError("RescueTime returned invalid report columns.")
    if headers and (_column(headers, ("activity",)) is None or
                    _column(headers, ("time spent (seconds)", "time spent")) is None):
        raise ValueError("RescueTime did not return activity and duration columns.")
    minimum = len(headers) if headers else 4
    if any(not isinstance(row, (list, tuple)) or len(row) < minimum for row in payload["rows"]):
        raise ValueError("RescueTime returned incomplete report rows.")


def _number(value):
    if isinstance(value, bool):
        return None
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return result if math.isfinite(result) else None


def _column(headers, names, default=None):
    for i, header in enumerate(headers):
        if isinstance(header, str) and header.strip().lower() in names:
            return i
    return default


def _activity(row, headers, kind="activity"):
    def cell(names, default=None):
        i = _column(headers, names, default)
        return row[i] if i is not None and i < len(row) else None
    seconds = _number(cell(("time spent (seconds)", "time spent"), 1))
    name = cell(("activity",), 3)
    if seconds is None or seconds <= 0 or not isinstance(name, str) or not name.strip():
        return None
    cat = cell(("category",), 4 if kind != "document" else 5)
    prod = _number(cell(("productivity",), 5 if kind != "document" else 6))
    return {"name": name, "min": seconds / 60,
            "category": cat if isinstance(cat, str) else None,
            "productivity": int(prod) if prod in (-2, -1, 0, 1, 2) else None}


def parse_activities(payload, cap=None):
    """Analytic Data API 'activity' response -> per-activity rows. Pure.

    Returns `[{name, min, category, productivity}]` sorted by minutes desc and
    optionally capped for display. Preserve fractional minutes and every activity. Defensive:
    tolerates a non-dict payload, missing/short rows, and non-numeric cells.
    Column positions are located from `row_headers` when present, falling back
    to RescueTime's documented order:
    `[Rank, Time Spent (seconds), Number of People, Activity, Category, Productivity]`.
    """
    if not isinstance(payload, dict):
        return []
    rows = payload.get("rows")
    if not isinstance(rows, list):
        return []
    headers = payload.get("row_headers") or []
    if not isinstance(headers, list):
        return []
    out = []
    for row in rows:
        if not isinstance(row, (list, tuple)):
            continue
        item = _activity(row, headers)
        if item:
            out.append(item)
    out.sort(key=lambda a: a["min"], reverse=True)
    return out if cap is None else out[:max(0, cap)]


def _detail_columns(payload, names):
    validate_report(payload)
    headers = payload.get("row_headers") or []
    index = _column(headers, names)
    if index is None or _column(headers, ("activity",)) is None or _column(headers, ("time spent (seconds)", "time spent")) is None:
        raise ValueError("RescueTime did not return the requested detail columns.")
    return headers, index


def parse_documents(payload):
    headers, index = _detail_columns(payload, ("document", "document name", "details"))
    out = []
    for row in payload["rows"]:
        if not isinstance(row, (list, tuple)) or index >= len(row):
            continue
        item = _activity(row, headers, "document")
        if item and isinstance(row[index], str) and row[index].strip():
            out.append({**item, "title": row[index]})
    return sorted(out, key=lambda item: item["min"], reverse=True)


def parse_hourly(payload):
    headers, index = _detail_columns(payload, ("date", "time", "date/time"))
    out = []
    for row in payload["rows"]:
        if not isinstance(row, (list, tuple)) or index >= len(row):
            continue
        item = _activity(row, headers)
        try:
            stamp = datetime.fromisoformat(row[index])
        except (TypeError, ValueError):
            continue
        if item:
            out.append({**item, "date": stamp.date().isoformat(), "hour": stamp.hour})
    return sorted(out, key=lambda item: (item["date"], item["hour"], -item["min"]))


def activity_summary(date, activities, now=None):
    """Totals for today/older dates absent from the summary feed; no invented pulse."""
    result = {"date": date, "pulse": None, "total_min": 0, "productive_min": 0,
              "neutral_min": 0, "distracting_min": 0, "unrated_min": 0,
              "source": "rescuetime", "summary_source": "activities",
              "fetched": (now or datetime.now()).replace(microsecond=0).isoformat()}
    categories = {}
    for item in activities:
        minutes, score = item["min"], item.get("productivity")
        field = "unrated_min" if score is None else "productive_min" if score > 0 else "distracting_min" if score < 0 else "neutral_min"
        result[field] += minutes
        result["total_min"] += minutes
        category = item.get("category") or "Uncategorized"
        categories[category] = categories.get(category, 0) + minutes
    result["top_categories"] = sorted([{"name": k, "min": v} for k, v in categories.items()], key=lambda item: item["min"], reverse=True)
    return result


def _min(row, field):
    return round(max(0, _number(row.get(field)) or 0) * 60)


def parse_day(row, now=None):
    """One daily_summary_feed row -> our per-day rescuetime dict."""
    cats = []
    for field, name in _CATEGORY_FIELDS.items():
        minutes = _min(row, field + "_hours")
        if minutes > 0:
            cats.append({"name": name, "min": minutes})
    cats.sort(key=lambda c: c["min"], reverse=True)
    fetched = (now or datetime.now()).replace(microsecond=0).isoformat()
    return {
        "date": row.get("date"),
        "pulse": row.get("productivity_pulse"),
        "productive_min": _min(row, "all_productive_hours"),
        "distracting_min": _min(row, "all_distracting_hours"),
        "neutral_min": _min(row, "neutral_hours"),
        "unrated_min": 0,
        "total_min": _min(row, "total_hours"),
        "top_categories": cats,
        "source": "rescuetime",
        "fetched": fetched,
    }
