"""RescueTime Analytic Data API client. Zero Flask imports.

Auth is a personal API key (no OAuth). Network is behind an injectable
transport (default oauth.urllib_transport); tests pass a fake.
"""
import urllib.parse
from datetime import datetime

import oauth

_FEED = "https://www.rescuetime.com/api/1/daily_summary_feed"

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
