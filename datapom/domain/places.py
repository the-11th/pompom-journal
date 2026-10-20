"""Offline location observations and conservative visit aggregation; zero Flask."""
from datetime import datetime
from pathlib import Path
from collections import OrderedDict
from threading import RLock
import math
import hashlib
import json
import shutil
import gzip
import os
import tempfile
from datapom.domain import journal_media


_MANIFEST_CACHE_LIMIT = 2048
_manifest_cache = OrderedDict()
_manifest_cache_lock = RLock()


def _day_fingerprint(root, date):
    """Notice external writers without keeping file contents in memory."""
    stamps = []
    for suffix in (".json.gz", ".json"):
        try:
            stat = (root / (date + suffix)).stat()
            stamps.append((stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns))
        except FileNotFoundError:
            stamps.append(None)
    return tuple(stamps)


def _day_receipt(root, date):
    key = (str(root), date)
    for _ in range(3):
        fingerprint = _day_fingerprint(root, date)
        with _manifest_cache_lock:
            cached = _manifest_cache.get(key)
            if cached and cached[0] == fingerprint:
                _manifest_cache.move_to_end(key)
                return dict(cached[1])
        rows = _day_values(root, date)
        raw = _day_bytes(rows)
        result = {"date": date, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(), "count": len(rows)}
        if fingerprint != _day_fingerprint(root, date):
            continue
        with _manifest_cache_lock:
            _manifest_cache[key] = (fingerprint, result)
            _manifest_cache.move_to_end(key)
            while len(_manifest_cache) > _MANIFEST_CACHE_LIMIT:
                _manifest_cache.popitem(last=False)
        return dict(result)
    # A concurrently changing day is safe to recompute on the next request.
    return result


def distance_m(lat1, lon1, lat2, lon2):
    a, b = math.radians(lat1), math.radians(lat2)
    dlat, dlon = b - a, math.radians(lon2 - lon1)
    h = math.sin(dlat / 2) ** 2 + math.cos(a) * math.cos(b) * math.sin(dlon / 2) ** 2
    return 6371008.8 * 2 * math.asin(min(1, math.sqrt(h)))


def match_place(sample, places):
    candidates = []
    for place in places:
        if place.get("archived"):
            continue
        radius = place.get("radius_m", 100)
        accuracy = sample.get("accuracy_m", 1000)
        if accuracy > radius:
            continue
        dist = distance_m(sample["lat"], sample["lon"], place["lat"], place["lon"])
        if dist <= radius:
            candidates.append((radius, dist, place["id"], place))
    return min(candidates, default=(None, None, None, None))[-1]


def clean_sample(raw):
    if not isinstance(raw, dict):
        raise ValueError("Location observation must be an object")
    point = journal_media.coordinate(raw)
    identity = journal_media._identity(raw.get("id"))
    try:
        stamp = datetime.fromisoformat(raw["at"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError("Invalid location timestamp") from exc
    if stamp.tzinfo is None:
        raise ValueError("Location timestamp needs a timezone")
    accuracy = float(raw.get("accuracy_m", 1000))
    if not math.isfinite(accuracy) or accuracy < 0:
        raise ValueError("Invalid location accuracy")
    result = {**point, "id": identity, "at": stamp.isoformat(), "accuracy_m": accuracy,
              "session": str(raw.get("session", ""))[:100],
              "mode": raw["mode"] if raw.get("mode") in ("detailed", "precise") else "visits"}
    for field, maximum in (("speed_mps", 400), ("speed_accuracy_mps", None), ("bearing", 360)):
        if raw.get(field) is None:
            continue
        try:
            value = float(raw[field])
        except (ValueError, TypeError) as exc:
            raise ValueError("Invalid location " + field) from exc
        if not math.isfinite(value) or value < 0 or (maximum is not None and (value >= maximum if field == "bearing" else value > maximum)):
            raise ValueError("Invalid location " + field)
        result[field] = value
    if raw.get("provider") is not None:
        result["provider"] = str(raw["provider"])[:40]
    if "source_device" in raw:
        if raw["source_device"] not in ("phone", "laptop"):
            raise ValueError("Invalid location device")
        result["source_device"] = raw["source_device"]
    return result


def source_device(sample):
    # The only historical recorder was Android. Preserve old receipt hashes by
    # interpreting missing origin without rewriting the immutable observation.
    return sample.get("source_device", "phone")


def _read_day(path):
    if not path.exists():
        return {}
    try:
        value = json.loads(gzip.decompress(path.read_bytes()) if path.suffix == ".gz" else path.read_bytes())
        if not isinstance(value, dict):
            raise ValueError("Invalid day store")
        clean = {}
        for key, sample in value.items():
            normalized = clean_sample(sample)
            if normalized["id"] != key:
                raise ValueError("Invalid observation identity")
            clean[key] = normalized
        return clean
    except (ValueError, TypeError, KeyError, AttributeError, OSError, EOFError):
        shutil.copy2(path, path.with_suffix(path.suffix + ".bak"))
        return {}


def _days(root):
    return sorted({p.name[:10] for pattern in ("????-??-??.json", "????-??-??.json.gz") for p in Path(root).glob(pattern)})


def _day_values(root, date):
    result = {}
    for suffix in (".json.gz", ".json"):
        for identity, row in _read_day(Path(root) / (date + suffix)).items():
            if identity in result and row != result[identity]:
                raise ValueError("Location ID already belongs to another observation")
            result[identity] = row
    return result


def _day_bytes(rows):
    return json.dumps(rows, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _save_compressed(path, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    packed = gzip.compress(_day_bytes(rows), compresslevel=9, mtime=0)
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".tracking-", delete=False) as stream:
        temporary = stream.name
        try:
            stream.write(packed)
            stream.flush()
            os.fsync(stream.fileno())
        except BaseException:
            os.unlink(temporary)
            raise
    try:
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def archive_samples(root, now=None):
    """Losslessly compress past day observations; shared maps/photos stay separate.

    The gzip contains the same ID-keyed observations, including every timestamp.
    Atomic replacement precedes removing the old JSON, so an interrupted archive
    can leave two identical files, but cannot leave a missing day.
    """
    today = (now or datetime.now().astimezone()).date().isoformat()
    changed = []
    for plain in sorted(Path(root).glob("????-??-??.json")):
        date = plain.stem
        if date >= today:
            continue
        rows = _day_values(root, date)
        _save_compressed(plain.with_suffix(".json.gz"), rows)
        plain.unlink()
        changed.append(date)
    return changed


def append_samples(root, samples, now=None):
    if not isinstance(samples, list) or len(samples) > 20000:
        raise ValueError("Invalid location batch")
    clean = [clean_sample(raw) for raw in samples]
    grouped = {}
    for sample in clean:
        grouped.setdefault(sample["at"][:10], []).append(sample)
    # IDs are immutable across dates as well as within a day. Validate the full
    # batch before any writes, including days which have already been archived.
    known = {day: _day_values(root, day) for day in _days(root)}
    identities = {identity: row for rows in known.values() for identity, row in rows.items()}
    for row in clean:
        if row["id"] in identities and identities[row["id"]] != row:
            raise ValueError("Location ID already belongs to another observation")
        identities[row["id"]] = row
    pending = {}
    today = (now or datetime.now().astimezone()).date().isoformat()
    for date, batch in grouped.items():
        compressed = date < today or (Path(root) / (date + ".json.gz")).exists()
        path = Path(root) / (date + (".json.gz" if compressed else ".json"))
        old = known.get(date, {}).copy()
        for sample in batch:
            if sample["id"] in old and old[sample["id"]] != sample:
                raise ValueError("Location ID already belongs to another observation")
            old[sample["id"]] = sample
        pending[path] = old
    for path, observations in pending.items():
        if path.suffix == ".gz":
            _save_compressed(path, observations)
            path.with_suffix("").unlink(missing_ok=True)
        else:
            journal_media.save(path, observations)
    archive_samples(root, now=now)
    return [s["id"] for s in clean]


def load_samples(root, start=None, end=None):
    result = []
    for date in _days(root):
        if (start and date < start) or (end and date > end):
            continue
        result.extend(_day_values(root, date).values())
    return sorted(result, key=lambda s: (datetime.fromisoformat(s["at"]).timestamp(), s["id"]))


def manifest(root, *, skip_invalid=False):
    """Small day receipts let USB sync skip unchanged history indefinitely.

    Dashboard bounds can skip conflicting day files without hiding healthy
    history. Sync retains strict validation so an invalid day is never ACKed.
    """
    root = Path(root).resolve()
    days = _days(root)
    with _manifest_cache_lock:
        for key in list(_manifest_cache):
            if key[0] == str(root) and key[1] not in days:
                del _manifest_cache[key]
    # Canonical uncompressed receipts stay stable across plain/gzip migration.
    result = []
    for date in days:
        try:
            result.append(_day_receipt(root, date))
        except ValueError:
            if not skip_invalid:
                raise
    return result


def visits(samples, places, min_minutes=10, max_gap_seconds=600):
    """Observed dwell time, never interpolated across missing or poor fixes.

    An unsaved stop uses a fixed first-fix anchor. Moving the anchor with every
    sample would incorrectly classify a slow walk as a visit. Cities provide
    context for these stops, rather than treating travel across a city as dwell.
    """
    origins = {source_device(row) for row in samples}
    if len(origins) > 1:
        return sorted([{**visit, "source_device": origin} for origin in sorted(origins)
                       for visit in visits([r for r in samples if source_device(r) == origin], places, min_minutes, max_gap_seconds)], key=lambda v: v["arrival"])
    rows = sorted(samples, key=lambda s: datetime.fromisoformat(s["at"]).timestamp())
    result, run = [], []
    current = None
    specific = [p for p in places if not p.get("is_city")]
    cities = [p for p in places if p.get("is_city")]
    def flush(next_sample=None):
        if not run:
            return
        elapsed = (datetime.fromisoformat(run[-1]["at"]) - datetime.fromisoformat(run[0]["at"])).total_seconds()
        if elapsed >= min_minutes * 60:
            result.append({"id": run[0]["id"], "place_id": current.get("id"), "name": current["name"],
                           "arrival": run[0]["at"], "departure_after": run[-1]["at"],
                           "departure_before": next_sample["at"] if next_sample else None,
                           "duration_seconds": elapsed, "estimated": True,
                           "lat": current["lat"], "lon": current["lon"],
                           "city_id": current.get("city_id")})
    for row in rows:
        accurate = row.get("accuracy_m", 1000) <= 100
        moving = row.get("speed_mps", 0) >= .5 and row.get("speed_accuracy_mps", 0) <= max(1, row.get("speed_mps", 0) * .5)
        place = match_place(row, specific) if accurate else None
        gap = bool(run) and ((datetime.fromisoformat(row["at"]) - datetime.fromisoformat(run[-1]["at"])).total_seconds() > max_gap_seconds
                             or row.get("session") != run[-1].get("session"))
        same_unknown = (accurate and not gap and not place and current and not current.get("id")
                        and distance_m(row["lat"], row["lon"], current["lat"], current["lon"]) <= 100)
        same_saved = place and current and place["id"] == current.get("id")
        if gap or not accurate or moving or not (same_unknown or same_saved):
            flush(None if gap or not accurate else row)
            run = []
            current = None
        if not accurate or moving:
            continue
        if not current:
            city = match_place(row, cities)
            current = place or {"id": None, "name": "Unsaved place" + (" · " + city["name"] if city else ""),
                                "lat": row["lat"], "lon": row["lon"], "city_id": city["id"] if city else None}
        run.append(row)
    flush()
    return result


def duration_totals(visits):
    """Sum observed dwell, keeping distinct unknown places geographically apart."""
    totals = []
    for visit in visits:
        same = next((row for row in totals if (
            row["place_id"] == visit.get("place_id") if visit.get("place_id") else
            row["place_id"] is None and distance_m(row["lat"], row["lon"], visit["lat"], visit["lon"]) <= 100
        )), None)
        if same is None:
            same = {key: visit.get(key) for key in ("place_id", "name", "lat", "lon")}
            same.update(duration_seconds=0, visits=0)
            totals.append(same)
        same["duration_seconds"] += visit["duration_seconds"]
        same["visits"] += 1
    return sorted(totals, key=lambda row: (-row["duration_seconds"], row["name"]))


MODES = ("stationary", "walking", "cycling", "vehicle", "unknown")
MAX_ACCURACY_M = 100
MAX_GAP_SECONDS = 600
MAX_SPEED_MPS = 400


def _seconds(at):
    return datetime.fromisoformat(at).timestamp()


def _minute(at):
    value = datetime.fromisoformat(at)
    return value.hour * 60 + value.minute + value.second / 60 + value.microsecond / 60000000


def _rounded(value):
    """Keep Python/JS chart payloads stable without reducing stored precision."""
    if isinstance(value, float):
        return round(value, 6)
    if isinstance(value, list):
        return [_rounded(v) for v in value]
    if isinstance(value, dict):
        return {k: _rounded(v) for k, v in value.items()}
    return value


def _transport(speed):
    # Speed bands are estimates, not evidence of a particular vehicle. A car,
    # train and bus overlap; high-speed travel is deliberately left unknown.
    return "stationary" if speed < .5 else "walking" if speed < 2.5 else "cycling" if speed < 7 else "vehicle" if speed <= 100 else "unknown"


def _analysis_rows(samples, date):
    rows = []
    for raw in samples:
        if not isinstance(raw, dict) or not isinstance(raw.get("at"), str) or (date and raw["at"][:10] != date):
            continue
        try:
            stamp = datetime.fromisoformat(raw["at"])
            if stamp.tzinfo is None:
                continue
            try:
                row = clean_sample(raw)
            except (ValueError, TypeError, KeyError):
                # Keep an invalid fix as a boundary; dropping it outright could
                # draw a route through the interval whose GPS was unusable.
                row = {"at": stamp.isoformat(), "id": str(raw.get("id", "")), "accuracy_m": 1000}
                if raw.get("source_device") in ("phone", "laptop"):
                    row["source_device"] = raw["source_device"]
            rows.append(row)
        except (ValueError, TypeError):
            continue
    return sorted(rows, key=lambda r: (_seconds(r["at"]), r["id"]))


def day_summary(samples, saved_places, date=None, photos=None, source_device=None):
    """One recorded local day, with replayable routes and conservative estimates.

    Recorded time includes only adjacent accurate fixes in the same session
    within ten minutes. Speed and distance ignore GPS jitter; measured Android
    speed helps retain small, real steps between five-second fixes. Maps and
    photo files are shared assets and never become part of the day archive.
    """
    rows = _analysis_rows(samples, date)
    date = date or (rows[0]["at"][:10] if rows else None)
    if date:
        rows = [r for r in rows if r["at"][:10] == date]
    origin = source_device or ("phone" if any(r.get("source_device", "phone") == "phone" and r.get("accuracy_m", 1000) <= MAX_ACCURACY_M for r in rows) else "laptop" if any(r.get("source_device") == "laptop" for r in rows) else "phone")
    if origin not in ("phone", "laptop"):
        raise ValueError("Invalid location device")
    rows = [r for r in rows if r.get("source_device", "phone") == origin]
    points, routes, segments = [], [], []
    previous = None
    recent = []
    for row in rows:
        if row.get("accuracy_m", 1000) > MAX_ACCURACY_M:
            previous, recent = None, []
            continue
        points.append(row)
        elapsed = _seconds(row["at"]) - _seconds(previous["at"]) if previous else 0
        connected = previous and 0 < elapsed <= MAX_GAP_SECONDS and row.get("session") == previous.get("session")
        distance = distance_m(previous["lat"], previous["lon"], row["lat"], row["lon"]) if connected else 0
        connected = connected and distance / elapsed <= MAX_SPEED_MPS
        if not connected:
            routes.append([row])
            recent = [row]
        else:
            routes[-1].append(row)
            uncertainty = max(3, math.hypot(previous["accuracy_m"], row["accuracy_m"]))
            measured = row.get("speed_mps")
            trusted = measured is not None and row.get("speed_accuracy_mps", 0) <= max(1, measured * .5)
            recent = [p for p in recent if _seconds(row["at"]) - _seconds(p["at"]) <= 30]
            context_motion = any(distance_m(p["lat"], p["lon"], row["lat"], row["lon"]) > max(3, math.hypot(p["accuracy_m"], row["accuracy_m"])) for p in recent)
            if distance <= uncertainty and not context_motion and not (trusted and measured >= .5):
                distance, speed = 0, 0
            else:
                speed = distance / elapsed
                if trusted and measured >= .5 and abs(measured - speed) <= max(3, speed * .75):
                    speed = measured
            mode = _transport(speed)
            if mode == "stationary":
                distance = 0
            segments.append({"id": previous["id"] + ":" + row["id"], "from": previous, "to": row,
                             "start": previous["at"], "end": row["at"], "duration_seconds": elapsed,
                             "distance_m": distance, "speed_mps": speed, "mode": mode, "estimated": True})
            recent.append(row)
        previous = row
    stops = []
    # Derive stops per connected route so rejected jumps cannot become dwell.
    for route in routes:
        for visit in visits(route, saved_places):
            stops.append({**visit, "start": visit["arrival"], "end": visit["departure_after"]})
    transport = [{"mode": mode,
                  "duration_seconds": sum(s["duration_seconds"] for s in segments if s["mode"] == mode),
                  "distance_m": sum(s["distance_m"] for s in segments if s["mode"] == mode)} for mode in MODES]
    moving = sum(s["duration_seconds"] for s in segments if s["mode"] != "stationary")
    distance = sum(s["distance_m"] for s in segments)
    summary = {"sample_count": len(points), "distance_m": distance,
               "recorded_seconds": sum(s["duration_seconds"] for s in segments),
               "moving_seconds": moving, "stop_seconds": sum(v["duration_seconds"] for v in stops),
               "stationary_seconds": transport[0]["duration_seconds"], "stay_count": len(stops),
               "max_speed_mps": max((s["speed_mps"] for s in segments), default=0),
               "avg_moving_speed_mps": distance / moving if moving else None,
               "transport": transport, "first_at": points[0]["at"] if points else None,
               "last_at": points[-1]["at"] if points else None}
    day = {"date": date, "source_device": origin, "samples": points, "routes": routes, "segments": segments, "visits": stops, "summary": summary, "photos": [], "hourly": _hourly(segments)}
    day["photos"] = [p for photo in photos or [] if (p := photo_location(photo, day)) is not None]
    return _rounded(day)


def _interpolate(segment, fraction, at):
    a, b = segment["from"], segment["to"]
    # Take the short longitude arc across the date line.
    delta = (b["lon"] - a["lon"] + 540) % 360 - 180
    lon = (a["lon"] + delta * fraction + 540) % 360 - 180
    return _rounded({"lat": a["lat"] + (b["lat"] - a["lat"]) * fraction, "lon": lon,
                     "at": at, "accuracy_m": max(a["accuracy_m"], b["accuracy_m"]),
                     "speed_mps": segment["speed_mps"], "transport": segment["mode"], "estimated": True})


def at_time(day, at):
    """Replay only where a recorded interval supports the requested instant."""
    try:
        target = float(at) / 1000 if isinstance(at, (float, int)) else _seconds(at)
    except (ValueError, TypeError):
        return None
    for segment in day["segments"]:
        start, end = _seconds(segment["start"]), _seconds(segment["end"])
        if start <= target <= end:
            stamp = datetime.fromtimestamp(target, tz=datetime.fromisoformat(segment["start"]).tzinfo).isoformat()
            return _interpolate(segment, (target - start) / (end - start), stamp)
    for row in day["samples"]:
        if abs(_seconds(row["at"]) - target) < .001:
            return {"lat": row["lat"], "lon": row["lon"], "at": row["at"], "accuracy_m": row["accuracy_m"],
                    "speed_mps": row.get("speed_mps"), "transport": "unknown", "estimated": False}
    return None


def position_at(day, minute_of_day):
    """Resolve the recorded wall clock, never the viewing device's timezone.

    An offset change can repeat a wall-clock hour. Ambiguous times intentionally
    have no position instead of choosing the wrong visit or photo placement.
    """
    try:
        minute_of_day = float(minute_of_day)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(minute_of_day) or not 0 <= minute_of_day < 1440:
        return None
    offsets = {datetime.fromisoformat(r["at"]).utcoffset() for r in day["samples"]}
    matches = []
    from datetime import timedelta, timezone
    for offset in offsets:
        stamp = datetime.fromisoformat(day["date"]).replace(tzinfo=timezone(offset)) + timedelta(minutes=minute_of_day)
        point = at_time(day, stamp.isoformat())
        if point is not None and abs(_minute(point["at"]) - minute_of_day) < .000001:
            matches.append(point)
    return matches[0] if len(matches) == 1 else None


def photo_location(photo, day):
    """Return a map pin; never change the photo's original location metadata."""
    if not isinstance(photo, dict):
        return None
    base = {"asset_id": photo.get("asset_id", photo.get("id")), "captured_at": photo.get("captured_at")}
    try:
        if photo.get("location") is not None:
            return {**base, **journal_media.coordinate(photo["location"]), "source": "gps", "estimated": False}
    except (ValueError, TypeError, KeyError):
        pass
    try:
        stamp = datetime.fromisoformat(photo.get("captured_at"))
    except (TypeError, ValueError):
        return None
    if stamp.tzinfo is None:
        point = position_at(day, _minute(stamp.isoformat())) if stamp.date().isoformat() == day["date"] else None
    else:
        point = at_time(day, stamp.isoformat())
    return {**base, "lat": point["lat"], "lon": point["lon"], "source": "route", "estimated": True} if point else None


def location_analytics(samples, saved_places):
    grouped = {}
    for row in samples:
        if isinstance(row, dict) and isinstance(row.get("at"), str):
            grouped.setdefault(row["at"][:10], []).append(row)
    return aggregate_days([day_summary(rows, saved_places, date) for date, rows in sorted(grouped.items())])


def history_analytics(root, saved_places, start=None, end=None):
    """Analyze history one day at a time, retaining only compact chart inputs.

    Old observations can number millions. Discard each day's full route before
    opening the next archive; memory grows with compact summaries and visits,
    rather than all the original five-second GPS fixes.
    """
    days = []
    for date in _days(root):
        if (start and date < start) or (end and date > end):
            continue
        day = day_summary(list(_day_values(root, date).values()), saved_places, date)
        if day["summary"]["sample_count"]:
            days.append({key: day[key] for key in ("date", "summary", "visits", "hourly")})
        del day
    return aggregate_days(days)


def _hourly(segments):
    hourly = [{"hour": hour, "recorded_seconds": 0, "moving_seconds": 0, "distance_m": 0} for hour in range(24)]
    for segment in segments:
        start = _minute(segment["start"]) * 60
        remaining = segment["duration_seconds"]
        while remaining > 0:
            hour = int(start // 3600) % 24
            seconds = min(remaining, 3600 - start % 3600)
            hourly[hour]["recorded_seconds"] += seconds
            hourly[hour]["moving_seconds"] += seconds if segment["mode"] != "stationary" else 0
            hourly[hour]["distance_m"] += segment["distance_m"] * seconds / segment["duration_seconds"]
            remaining -= seconds
            start += seconds
    return hourly


def aggregate_days(days):
    """Compact cross-day aggregates; no raw routes, map tiles or image copies."""
    keys = ("sample_count", "distance_m", "recorded_seconds", "moving_seconds", "stop_seconds", "stationary_seconds", "stay_count")
    summary = {key: sum(day["summary"][key] for day in days) for key in keys}
    summary.update(days_tracked=sum(bool(day["summary"]["sample_count"]) for day in days),
                   max_speed_mps=max((day["summary"]["max_speed_mps"] for day in days), default=0),
                   avg_moving_speed_mps=summary["distance_m"] / summary["moving_seconds"] if summary["moving_seconds"] else None,
                   transport=[{"mode": mode, **{key: sum(row[key] for day in days for row in day["summary"]["transport"] if row["mode"] == mode) for key in ("duration_seconds", "distance_m")}} for mode in MODES])
    hourly = [{"hour": hour, "recorded_seconds": 0, "moving_seconds": 0, "distance_m": 0} for hour in range(24)]
    dow = [{"day": day, "recorded_seconds": 0, "moving_seconds": 0, "distance_m": 0, "days_tracked": 0} for day in range(7)]
    for day in days:
        weekday = datetime.fromisoformat(day["date"]).weekday()
        dow[weekday]["days_tracked"] += bool(day["summary"]["sample_count"])
        for key in ("recorded_seconds", "moving_seconds", "distance_m"):
            dow[weekday][key] += day["summary"][key]
        for hour, values in enumerate(day.get("hourly") or _hourly(day.get("segments", []))):
            for key in ("recorded_seconds", "moving_seconds", "distance_m"):
                hourly[hour][key] += values[key]
    return _rounded({"days": [{"date": day["date"], "summary": day["summary"], "visits": day["visits"]} for day in days],
                     "summary": summary, "place_totals": duration_totals([v for day in days for v in day["visits"]]), "hourly": hourly, "dow": dow})
