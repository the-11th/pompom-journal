"""Receipt-backed Spotify imports. Pure logic; one journal save commits a batch."""
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
import re

import journal
import spotify


def _empty():
    return {"version": 1, "receipts": [], "duration_ms": 0, "track_ids": [],
            "artists": {}, "tracks": {}, "albums": {}}


def _validate(value):
    if not isinstance(value, dict) or type(value.get("version")) is not int or value["version"] != 1:
        raise ValueError("Saved Spotify history needs review before importing")
    receipts = value.get("receipts")
    if (not isinstance(receipts, list) or any(not isinstance(key, str) or not re.fullmatch(r"[a-f0-9]{64}", key) for key in receipts)
            or len(set(receipts)) != len(receipts)):
        raise ValueError("Saved Spotify history receipts need review")
    if type(value.get("duration_ms")) is not int or value["duration_ms"] < 0:
        raise ValueError("Saved Spotify history duration needs review")
    if not isinstance(value.get("track_ids"), list) or any(not isinstance(key, str) for key in value["track_ids"]):
        raise ValueError("Saved Spotify history track identities need review")
    for field in ("artists", "tracks", "albums"):
        counts = value.get(field)
        if not isinstance(counts, dict) or any(not isinstance(key, str) or type(count) is not int or count < 0 for key, count in counts.items()):
            raise ValueError("Saved Spotify history totals need review")


def _identity(play):
    stamp = datetime.fromisoformat(play["played_at"].replace("Z", "+00:00"))
    # Both export formats describe UTC stream-end times; legacy endTime omits
    # the offset. No approximate matching against API play times is attempted.
    stamp = stamp.replace(tzinfo=timezone.utc) if stamp.tzinfo is None else stamp.astimezone(timezone.utc)
    track = play.get("track_id") or [play.get("name"), play.get("artists") or []]
    return hashlib.sha256(json.dumps([stamp.isoformat(), track, play.get("duration_ms", 0)],
                                    ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def _top(counts, limit):
    return [{"name": name, "count": count} for name, count in
            sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:limit]]


def _summary(value, now):
    return {"tracks": len(value["receipts"]), "minutes": round(value["duration_ms"] / 60000),
            "distinct": len(value["track_ids"]), "top_artists": _top(value["artists"], 5),
            "top_tracks": _top(value["tracks"], 10), "top_albums": _top(value["albums"], 5),
            "contexts": {}, "source": "history_import", "sources": ["history_import"],
            "source_label": "Imported history", "fetched": now.replace(microsecond=0).isoformat()}


def import_plays(data, plays, now=None):
    """Merge exact imported play identities; preserve legacy/live snapshots.

    Imported totals are authoritative for covered dates. A replay is a no-op,
    including timestamps. Work on a copy so malformed later data cannot leave
    an earlier date partly applied to the caller's store.
    """
    now = now or datetime.now()
    grouped = spotify.group_plays_by_day(plays)
    if not grouped:
        raise ValueError("Choose a history JSON file containing plays")
    work = deepcopy(data)
    changed, added = [], 0
    for date, rows in grouped.items():
        if not journal._valid_date(date):
            raise ValueError("Invalid history date")
        entry = journal.get_entry_by_date(work, date)
        saved = (entry or {}).get("music_history")
        history = deepcopy(_empty() if saved is None else saved)
        _validate(history)
        receipts, tracks = set(history["receipts"]), set(history["track_ids"])
        before = len(receipts)
        for play in rows:
            receipt = _identity(play)
            if receipt in receipts:
                continue
            duration = play.get("duration_ms", 0)
            if type(duration) is not int or duration < 0:
                raise ValueError("Invalid history duration")
            receipts.add(receipt)
            history["duration_ms"] += duration
            name, artists = play.get("name"), play.get("artists") or []
            if not isinstance(artists, list) or any(not isinstance(artist, str) for artist in artists):
                raise ValueError("Invalid history artist")
            label = str(name or "") + (" · " + ", ".join(artists) if artists else "")
            if play.get("track_id") or name:
                tracks.add(play.get("track_id") or label)
            if name:
                history["tracks"][label] = history["tracks"].get(label, 0) + 1
            for artist in artists:
                history["artists"][artist] = history["artists"].get(artist, 0) + 1
            album = play.get("album")
            album = album.get("name") if isinstance(album, dict) else album
            if album:
                history["albums"][album] = history["albums"].get(album, 0) + 1
        if len(receipts) == before:
            continue
        if entry is None:
            entry = journal.upsert_entry(work, date, date, "", now=now)
        if entry.get("music_history") is None:
            entry["music_legacy"] = deepcopy(entry.get("music"))
            if entry.get("music") and not journal._music_is_imported(entry["music"]):
                entry["music_live"] = deepcopy(entry["music"])
        history["receipts"], history["track_ids"] = sorted(receipts), sorted(tracks)
        entry["music_history"] = history
        journal.set_entry_music(work, date, _summary(history, now), now=now)
        added += len(receipts) - before
        changed.append(date)
    if changed:
        data.clear()
        data.update(work)
    return {"days": changed, "plays": added}
