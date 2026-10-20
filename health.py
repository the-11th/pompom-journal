"""Daily health-data parse helpers. Zero Flask imports.

Xiaomi/Mi Fitness does not provide a stable public cloud API for personal
health history, so Datapom receives normalized data pushed from a bridge
(Health Connect, export importer, or a small Android companion) and stores it
per journal day.
"""
from datetime import datetime

_SAMPLES_CAP = 288


def _valid_date(s):
    if not isinstance(s, str):
        return False
    try:
        return datetime.strptime(s, "%Y-%m-%d").date().isoformat() == s
    except ValueError:
        return False


def _int(v):
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


def _time_of(sample):
    raw = _str_or_none(sample.get("time") or sample.get("ts") or sample.get("timestamp"))
    if not raw:
        return None
    if "T" in raw:
        raw = raw.split("T", 1)[1]
    if (len(raw) >= 5 and raw[2] == ":" and raw[:2].isascii() and raw[:2].isdigit()
            and raw[3:5].isascii() and raw[3:5].isdigit()
            and int(raw[:2]) < 24 and int(raw[3:5]) < 60):
        return raw[:5]
    return None


def _parse_heart_rate(raw):
    if not isinstance(raw, list):
        return []
    samples = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        bpm = _int(item.get("bpm") or item.get("heart_rate") or item.get("value"))
        when = _time_of(item)
        if not bpm or not when:
            continue
        samples.append({"time": when, "bpm": bpm})
    samples.sort(key=lambda s: s["time"])
    return samples[:_SAMPLES_CAP]


def _parse_one(day, fetched):
    if not isinstance(day, dict):
        return None
    date = day.get("date")
    if not _valid_date(date):
        return None
    samples = _parse_heart_rate(
        day.get("heart_rate_samples") or day.get("heart_rate") or day.get("hr")
    )
    bpms = [s["bpm"] for s in samples]
    avg_hr = _int(day.get("avg_hr") or day.get("average_hr"))
    if not avg_hr and bpms:
        avg_hr = round(sum(bpms) / len(bpms))
    return {
        "date": date,
        "steps": _int(day.get("steps")),
        "distance_m": _int(day.get("distance_m") or day.get("distance")),
        "calories": _int(day.get("calories") or day.get("active_calories")),
        "resting_hr": _int(day.get("resting_hr") or day.get("resting_heart_rate")),
        "avg_hr": avg_hr,
        "min_hr": min(bpms) if bpms else _int(day.get("min_hr")),
        "max_hr": max(bpms) if bpms else _int(day.get("max_hr")),
        "heart_rate_samples": samples,
        "source": _str_or_none(day.get("source")) or "xiaomi",
        "fetched": fetched,
    }


def parse_push(payload, now=None):
    """Normalize inbound health data into per-day dicts.

    Accepts a single day dict or a list of day dicts. Supported fields:
    ``date``, ``steps``, optional ``distance_m``, ``calories``,
    ``resting_hr``, ``avg_hr``, and ``heart_rate``/``heart_rate_samples`` as
    ``[{time|ts|timestamp, bpm|heart_rate|value}]``.
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
