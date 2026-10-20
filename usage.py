"""Phone-usage (Android / Samsung) parse + aggregate. Zero Flask imports.

Unlike the cloud integrations there is no REST API to pull: the phone *pushes*
usage stats to /integrations/phone/ingest. `parse_push` normalizes an inbound
push (a single day dict OR a batch of archived days) into our per-day `usage`
dicts. The aggregation helpers mirror the
RescueTime ones: injectable date bounds, skip entries lacking usable usage, and
degrade gracefully on too few points. Pure — no network, no clock except the
injectable `now`.
"""
from datetime import datetime

_DOW_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
_TOP_APPS_CAP = 8


def _valid_date(s):
    if not isinstance(s, str):
        return False
    try:
        return datetime.strptime(s, "%Y-%m-%d").date().isoformat() == s
    except ValueError:
        return False


def _int(v):
    """Coerce to a non-negative int; junk -> 0."""
    try:
        n = int(round(float(v)))
    except (TypeError, ValueError, OverflowError):
        return 0
    return n if n > 0 else 0


def _str_or_none(v):
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _parse_top_apps(raw):
    if not isinstance(raw, list):
        return []
    apps = []
    for a in raw:
        if not isinstance(a, dict):
            continue
        name = _str_or_none(a.get("name")) or _str_or_none(a.get("label"))
        if not name:
            continue
        label = _str_or_none(a.get("label")) or name
        apps.append({
            "name": name, "label": label,
            "min": _int(a.get("min")), "opens": _int(a.get("opens")),
        })
    apps.sort(key=lambda x: x["min"], reverse=True)
    return apps[:_TOP_APPS_CAP]


def _parse_one(day, fetched):
    """One inbound day dict -> normalized usage dict, or None if unusable."""
    if not isinstance(day, dict):
        return None
    date = day.get("date")
    if not _valid_date(date):
        return None
    result = {
        "date": date,
        "screen_min": _int(day.get("screen_min")),
        "unlocks": _int(day.get("unlocks")),
        "top_apps": _parse_top_apps(day.get("top_apps")),
        "first_use": _str_or_none(day.get("first_use")),
        "last_use": _str_or_none(day.get("last_use")),
        "source": "phone",
        "fetched": fetched,
    }
    for field in ("details_available", "recovered"):
        if isinstance(day.get(field), bool):
            result[field] = day[field]
    return result


def merge_day(previous, incoming):
    """Backfill fills missing dates; expired detail cannot downgrade saved data."""
    if previous and (incoming.get("recovered") is True or
                     (previous.get("details_available", True) and
                      incoming.get("details_available") is False)):
        return previous
    return incoming


def parse_push(payload, now=None):
    """Normalize an inbound phone push into a list of usage dicts.

    Accepts either a single day dict or a batch of archived days.
    Defensive: coerces/clamps types, caps top_apps at 8, and
    skips any day lacking a valid YYYY-MM-DD `date`. Returns a (possibly empty)
    list in the order received.
    """
    fetched = (now or datetime.now()).replace(microsecond=0).isoformat()
    if isinstance(payload, dict):
        days = [payload]
    elif isinstance(payload, list):
        days = payload
    else:
        return []
    out = []
    for day in days:
        parsed = _parse_one(day, fetched)
        if parsed is not None:
            out.append(parsed)
    return out


# --------------------------------------------------------------------------- #
# aggregation helpers (mirror the RescueTime helpers in journal.py)
# --------------------------------------------------------------------------- #

def _filter_entries_by_date(entries, start, end):
    return [
        e for e in entries
        if (start is None or e.get("date", "") >= start)
        and (end is None or e.get("date", "") <= end)
    ]


def _entry_usage(entry):
    """Return the usage dict if it has usable data (screen_min or top_apps),
    else None. Mirror this in analytics.js as usageOf()."""
    u = entry.get("usage")
    if isinstance(u, dict) and (u.get("screen_min") or u.get("top_apps")):
        return u
    return None


def _entry_mood(entry):
    m = entry.get("mood")
    if isinstance(m, bool):
        return None
    if isinstance(m, (int, float)) and 1 <= m <= 7:
        return int(m)
    return None


def usage_minutes_series(entries, start=None, end=None):
    out = []
    for e in _filter_entries_by_date(entries, start, end):
        u = _entry_usage(e)
        if u:
            out.append({"date": e["date"], "screen_min": u.get("screen_min", 0)})
    out.sort(key=lambda d: d["date"])
    return out


def usage_unlocks_series(entries, start=None, end=None):
    out = []
    for e in _filter_entries_by_date(entries, start, end):
        u = _entry_usage(e)
        if u and u.get("details_available") is not False:
            out.append({"date": e["date"], "unlocks": u.get("unlocks", 0)})
    out.sort(key=lambda d: d["date"])
    return out


def usage_top_apps(entries, start=None, end=None):
    """Aggregate per-app minutes AND opens across the range.

    Rows are ``{name, label, min, opens}`` sorted by total minutes desc, capped
    at 8. ``opens`` defaults to 0 for apps parsed from data that predates the
    per-app open-count field.
    """
    totals, opens, labels = {}, {}, {}
    for e in _filter_entries_by_date(entries, start, end):
        u = _entry_usage(e)
        if not u:
            continue
        for a in u.get("top_apps") or []:
            name = a.get("name")
            if not name:
                continue
            totals[name] = totals.get(name, 0) + (a.get("min") or 0)
            opens[name] = opens.get(name, 0) + (a.get("opens") or 0)
            labels.setdefault(name, a.get("label") or name)
    rows = [{"name": k, "label": labels[k], "min": v, "opens": opens[k]}
            for k, v in totals.items()]
    rows.sort(key=lambda a: a["min"], reverse=True)
    return rows[:_TOP_APPS_CAP]


def usage_app_minutes_series(entries, start=None, end=None, top_n=6):
    """Per-day minutes for the top-``top_n`` apps (by total minutes in range).

    Shape (for a stacked/multi-line chart)::

        {"apps": [{"name", "label"}],   # top-N apps, most minutes first
         "dates": ["YYYY-MM-DD", ...],  # sorted dates of usable entries
         "series": {name: [minutes-per-date...]}}  # zero-filled, aligned to dates

    Days where an app has no recorded minutes contribute 0. Ignores entries
    lacking usable usage; returns empty structure when there's no data.
    """
    top = usage_top_apps(entries, start, end)[:max(0, top_n)]
    apps = [{"name": a["name"], "label": a["label"]} for a in top]
    keep = {a["name"] for a in apps}

    # date -> {name: minutes} for kept apps only.
    by_date = {}
    for e in _filter_entries_by_date(entries, start, end):
        u = _entry_usage(e)
        if not u:
            continue
        date = e.get("date")
        day = by_date.setdefault(date, {})
        for a in u.get("top_apps") or []:
            name = a.get("name")
            if name in keep:
                day[name] = day.get(name, 0) + (a.get("min") or 0)

    dates = sorted(by_date)
    series = {a["name"]: [by_date[d].get(a["name"], 0) for d in dates] for a in apps}
    return {"apps": apps, "dates": dates, "series": series}


def usage_dow_averages(entries, start=None, end=None):
    buckets = {i: [] for i in range(7)}
    for e in _filter_entries_by_date(entries, start, end):
        u = _entry_usage(e)
        if u:
            d = datetime.strptime(e["date"], "%Y-%m-%d").date()
            buckets[d.weekday()].append(u.get("screen_min", 0))
    return {_DOW_NAMES[i]: (sum(v) / len(v) if v else None)
            for i, v in buckets.items()}


def usage_mood_pairs(entries, start=None, end=None):
    out = []
    for e in _filter_entries_by_date(entries, start, end):
        u = _entry_usage(e)
        m = _entry_mood(e)
        if u and m is not None:
            out.append({"screen_min": u.get("screen_min", 0), "mood": m})
    return out


def usage_stats(entries, start=None, end=None):
    rows = [_entry_usage(e) for e in _filter_entries_by_date(entries, start, end)]
    rows = [r for r in rows if r]
    if not rows:
        return {"avg_screen_min": None, "avg_unlocks": None, "days": 0}
    screen = [r.get("screen_min", 0) for r in rows]
    unlocks = [r.get("unlocks", 0) for r in rows if r.get("details_available") is not False]
    return {
        "avg_screen_min": round(sum(screen) / len(screen)),
        "avg_unlocks": round(sum(unlocks) / len(unlocks)) if unlocks else None,
        "days": len(rows),
    }
