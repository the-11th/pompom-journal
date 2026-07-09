"""RescueTime Analytic Data API client. Zero Flask imports.

Auth is a personal API key (no OAuth). Network is behind an injectable
transport (default oauth.urllib_transport); tests pass a fake.
"""
import urllib.parse
from datetime import datetime

import oauth

_FEED = "https://www.rescuetime.com/api/1/daily_summary_feed"
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


def fetch_daily_summary(api_key, transport=None):
    """Recent daily summaries (≈ last two weeks), newest first."""
    transport = transport or oauth.urllib_transport
    q = urllib.parse.urlencode({"key": api_key, "format": "json"})
    url = f"{_FEED}?{q}"
    status, payload = transport("GET", url, {}, None)
    if status != 200:
        raise RuntimeError(f"RescueTime error {status}: {payload}")
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
    transport = transport or oauth.urllib_transport
    q = urllib.parse.urlencode({
        "key": api_key,
        "format": "json",
        "perspective": "rank",
        "restrict_kind": "activity",
        "restrict_begin": date,
        "restrict_end": date,
    })
    url = f"{_ANALYTIC}?{q}"
    status, payload = transport("GET", url, {}, None)
    if status != 200:
        raise RuntimeError(f"RescueTime error {status}: {payload}")
    return payload


def parse_activities(payload, cap=8):
    """Analytic Data API 'activity' response -> per-activity rows. Pure.

    Returns `[{name, min, category, productivity}]` sorted by minutes desc and
    capped at `cap`; activities that round to 0 minutes are dropped. Defensive:
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

    def col(substr, default):
        for i, h in enumerate(headers):
            if isinstance(h, str) and substr in h.lower():
                return i
        return default

    i_sec = col("time spent", 1)
    i_name = col("activity", 3)
    i_cat = col("category", 4)
    i_prod = col("productivity", 5)

    out = []
    for row in rows:
        if not isinstance(row, (list, tuple)):
            continue
        cell = lambda i: row[i] if 0 <= i < len(row) else None  # noqa: E731
        name = cell(i_name)
        if not name:
            continue
        try:
            seconds = float(cell(i_sec) or 0)
        except (TypeError, ValueError):
            seconds = 0.0
        minutes = round(seconds / 60)
        if minutes <= 0:
            continue
        raw_prod = cell(i_prod)
        try:
            productivity = int(raw_prod) if raw_prod is not None else None
        except (TypeError, ValueError):
            productivity = None
        raw_cat = cell(i_cat)
        out.append({
            "name": str(name),
            "min": minutes,
            "category": str(raw_cat) if raw_cat is not None else None,
            "productivity": productivity,
        })
    out.sort(key=lambda a: a["min"], reverse=True)
    return out[:cap]


def _min(row, field):
    return round(float(row.get(field, 0) or 0) * 60)


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
        "total_min": _min(row, "total_hours"),
        "top_categories": cats[:5],
        "source": "rescuetime",
        "fetched": fetched,
    }
