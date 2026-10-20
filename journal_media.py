"""Journal media and ordered documents. Plain data and files; no HTTP framework."""
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
import copy
import hashlib
import io
import json
import math
import os
import re
import tempfile
import warnings

from todo import _HEX_COLOR_RE, _TAG_NAME_RE

IDENTITY = re.compile(r"^[A-Za-z0-9_-]{1,100}$")
BLOB = re.compile(r"^[a-f0-9]{64}$")
MAX_IMAGE_BYTES = 80 * 1024 * 1024


def _empty():
    return {"assets": {}, "places": {}, "messages": {}, "receipts": {},
            "groups": {name: {"id": name, "name": name, "share_entry": name == "people",
                               "color": None, "tags": [], "rev": 0}
                       for name in ("people", "meals", "foods", "locations")},
            "settings": {"tracking_enabled": False, "min_visit_minutes": 5,
                         "retention": "forever"}, "rev": 0}


def load(path):
    path = Path(path)
    empty = _empty()
    try:
        value = json.loads(path.read_text())
        if not isinstance(value, dict):
            raise ValueError("Invalid media store")
    except FileNotFoundError:
        return empty
    except (ValueError, UnicodeError):
        path.replace(str(path) + ".bak")
        return empty
    for key, default in empty.items():
        if not isinstance(value.get(key), type(default)):
            value[key] = default
    for key, default in empty["settings"].items():
        value["settings"].setdefault(key, default)
    for place in value["places"].values():
        if isinstance(place, dict):
            place.setdefault("starred", False)
    for group in value["groups"].values():
        if isinstance(group, dict):
            group.setdefault("tags", [])
    return value


def save(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(data, stream, ensure_ascii=False, allow_nan=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def coordinate(value):
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("Location must contain latitude and longitude")
    try:
        lat, lon = float(value["lat"]), float(value["lon"])
    except (KeyError, TypeError, ValueError):
        raise ValueError("Location must contain latitude and longitude")
    if not math.isfinite(lat) or not math.isfinite(lon) or abs(lat) > 90 or abs(lon) > 180:
        raise ValueError("Location is outside the map")
    return {"lat": lat, "lon": lon}


def _text(value, limit=100000):
    if not isinstance(value, str) or len(value) > limit:
        raise ValueError("Text is invalid or too long")
    return value


def _identity(value):
    if not isinstance(value, str) or not IDENTITY.fullmatch(value):
        raise ValueError("Invalid record ID")
    return value


def tags(value):
    if not isinstance(value, dict):
        raise ValueError("Tags must be grouped")
    out = {}
    for group, names in value.items():
        _identity(group)
        if not isinstance(names, list):
            raise ValueError("Tags must be a list")
        clean = []
        for name in names:
            n = _text(name, 100).strip().lower()
            # Photo labels retain their broader text policy; sharing with entry
            # tags below applies the journal's Unicode name allowlist.
            if n and not any(ord(c) < 32 for c in n) and n not in clean:
                clean.append(n)
        if clean:
            out[group] = clean
    return out


def validate_document(value):
    if not isinstance(value, list) or len(value) > 5000:
        raise ValueError("Invalid journal document")
    out, used = [], set()
    for raw in value:
        if not isinstance(raw, dict):
            raise ValueError("Invalid document block")
        identity = _identity(raw.get("id"))
        if identity in used:
            raise ValueError("Duplicate document block")
        used.add(identity)
        kind = raw.get("type")
        block = {"id": identity, "type": kind}
        if kind == "text":
            block["text"] = _text(raw.get("text", ""))
            block["links"] = []
            links = raw.get("links", [])
            if not isinstance(links, list):
                raise ValueError("Photo links must be a list")
            for link in links:
                if not isinstance(link, dict):
                    raise ValueError("Invalid photo text link")
                start, end = link.get("start"), link.get("end")
                # Offsets are Unicode code points on the wire (not JS UTF-16 units).
                if type(start) is not int or type(end) is not int or not 0 <= start < end <= len(block["text"]):
                    raise ValueError("Photo text link is outside its paragraph")
                if not isinstance(link.get("photos", []), list):
                    raise ValueError("Photo links must name photos")
                photos = [_identity(p) for p in link.get("photos", [])]
                if not photos:
                    raise ValueError("Photo text link needs a photo")
                block["links"].append({"start": start, "end": end, "photos": photos})
        elif kind in ("photo", "message"):
            key = "asset_id" if kind == "photo" else "message_id"
            identity = _identity(raw.get(key))
            if kind == "photo" and not BLOB.fullmatch(identity):
                raise ValueError("Invalid photo ID")
            block[key] = identity
            block["caption"] = _text(raw.get("caption", ""))
            block["caption_visible"] = bool(raw.get("caption_visible", True))
            block["hidden"] = bool(raw.get("hidden", False))
            block["tags"] = tags(raw.get("tags", {}))
            block["location_visible"] = bool(raw.get("location_visible", False))
            block["location_label"] = _text(raw.get("location_label", ""), 300)
            color = raw.get("location_color")
            if color is not None and not _HEX_COLOR_RE.fullmatch(str(color)):
                raise ValueError("Invalid location color")
            block["location_color"] = color
            block["width"] = raw.get("width") if raw.get("width") in ("small", "medium", "full") else "full"
            edited = raw.get("edited_asset_id")
            if edited is not None and not BLOB.fullmatch(str(edited)):
                raise ValueError("Invalid edited photo")
            block["edited_asset_id"] = edited
        else:
            raise ValueError("Unknown document block type")
        out.append(block)
    photo_ids = {b["id"] for b in out if b["type"] == "photo"}
    for b in out:
        if b["type"] == "text":
            if any(p not in photo_ids for link in b["links"] for p in link["photos"]):
                raise ValueError("Photo text link references a missing photo")
    return out


def document_body(document):
    return "\n".join(b.get("text", "") for b in document if b["type"] == "text")


def shared_tags(document, data, sections):
    by_name = {s["name"].lower(): s["id"] for s in sections if s.get("type") == "tag"}
    result = defaultdict(set)
    for block in document:
        if block.get("type") != "photo":
            continue
        for gid, names in block.get("tags", {}).items():
            group = data["groups"].get(gid, {})
            sid = by_name.get(group.get("name", "").lower())
            if group.get("share_entry") and sid:
                result[sid].update(n.strip().lower() for n in names if _TAG_NAME_RE.fullmatch(n.strip().lower()))
    return {sid: sorted(names) for sid, names in result.items()}


def _clean_record(kind, old, patch):
    if not isinstance(patch, dict):
        raise ValueError("Invalid record change")
    allowed = {
        "assets": {"location", "location_label", "captured_at", "is_sticker", "edit_layers", "source_asset_id"},
        "places": {"name", "lat", "lon", "radius_m", "color", "city", "is_city", "archived", "starred"},
        "groups": {"name", "share_entry", "color", "archived", "tags"},
        "messages": {"caption", "date", "imported", "hidden"},
    }[kind]
    if set(patch) - allowed:
        raise ValueError("Unknown or read-only record field")
    for field in ("is_sticker", "is_city", "archived", "share_entry", "imported", "hidden"):
        if field in patch and type(patch[field]) is not bool:
            raise ValueError(f"{field.replace('_', ' ').capitalize()} must be true or false")
    if "caption" in patch:
        _text(patch["caption"])
    if "date" in patch:
        value = _text(patch["date"], 10)
        if datetime.strptime(value, "%Y-%m-%d").date().isoformat() != value:
            raise ValueError("Choose a valid YYYY-MM-DD date")
    record = {**old, **patch}
    if kind == "groups":
        record["tags"] = tags({"group": record.get("tags", [])}).get("group", [])
    if kind == "places":
        record.update(coordinate(record))
        record.setdefault("starred", False)
        if type(record["starred"]) is not bool:
            raise ValueError("Place star must be a boolean")
        radius = float(record.get("radius_m", 100))
        if not math.isfinite(radius) or not 10 <= radius <= 500000:
            raise ValueError("Place radius must be between 10 m and 500 km")
        record["radius_m"] = radius
    if kind in ("places", "groups"):
        if not _text(record.get("name", ""), 200).strip():
            raise ValueError("A name is required")
    if "color" in record and record["color"] is not None and not _HEX_COLOR_RE.fullmatch(str(record["color"])):
        raise ValueError("Invalid color")
    if "location" in patch:
        record["location"] = coordinate(patch["location"])
    if "location_label" in patch:
        _text(patch["location_label"], 300)
    if "captured_at" in patch and patch["captured_at"] is not None:
        datetime.fromisoformat(patch["captured_at"])
    if "edit_layers" in patch and len(json.dumps(patch["edit_layers"], allow_nan=False)) > 5_000_000:
        raise ValueError("Photo edit has too many strokes")
    return record


def apply_changes(data, changes, now=None):
    if not isinstance(changes, list) or len(changes) > 500:
        raise ValueError("Invalid change batch")
    work = copy.deepcopy(data)
    result = {"accepted": [], "conflicts": []}
    for change in changes:
        if not isinstance(change, dict):
            raise ValueError("Invalid record change")
        op = _identity(change.get("op_id"))
        kind, identity = change.get("kind"), _identity(change.get("id"))
        if kind not in ("assets", "places", "groups", "messages"):
            raise ValueError("Unknown record kind")
        if op in work["receipts"]:
            result["accepted"].append(op)
            continue
        old = work[kind].get(identity)
        if (old.get("rev", 0) if old else None) != change.get("base_rev"):
            result["conflicts"].append({"op_id": op, "kind": kind, "id": identity, "current": old})
            continue
        if kind in ("assets", "messages") and old is None:
            raise ValueError("Import the file or message before editing it")
        record = _clean_record(kind, old or {}, change.get("patch"))
        record.update(id=identity, rev=(old or {}).get("rev", 0) + 1,
                      updated=(now or datetime.now()).isoformat())
        work[kind][identity] = record
        work["receipts"][op] = True
        work["rev"] += 1
        result["accepted"].append(op)
    data.clear()
    data.update(work)
    return result


def _gps(exif):
    try:
        gps = exif.get_ifd(34853)
        def degrees(key):
            values = gps[key]
            return float(values[0]) + float(values[1]) / 60 + float(values[2]) / 3600
        return coordinate({"lat": degrees(2) * (-1 if gps[1] == "S" else 1),
                           "lon": degrees(4) * (-1 if gps[3] == "W" else 1)})
    except (KeyError, TypeError, ValueError, ZeroDivisionError):
        return None


def import_image(root, content, filename="photo", now=None):
    from PIL import Image, ImageOps, UnidentifiedImageError
    from pillow_heif import register_heif_opener
    register_heif_opener()
    if not content or len(content) > MAX_IMAGE_BYTES:
        raise ValueError("Choose a photo smaller than 80 MB")
    root = Path(root)
    digest = hashlib.sha256(content).hexdigest()
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            image = Image.open(io.BytesIO(content))
            if image.format not in ("JPEG", "PNG", "WEBP", "GIF", "HEIF", "AVIF"):
                raise ValueError("Unsupported photo format")
            image.load()
        exif = image.getexif()
        details = exif.get_ifd(34665) if 34665 in exif else {}
        raw_date = details.get(36867) or exif.get(36867) or exif.get(306)
        captured = None
        try:
            captured = datetime.strptime(raw_date, "%Y:%m:%d %H:%M:%S").isoformat()
            offset = details.get(36881) or exif.get(36881)
            if offset and re.fullmatch(r"[+-]\d\d:\d\d", offset):
                captured += offset
        except (ValueError, TypeError):
            pass
        fmt = image.format
        location = _gps(exif)
        image = ImageOps.exif_transpose(image)
        width, height = image.size
        target = root / digest
        target.mkdir(parents=True, exist_ok=True)
        original = target / "original"
        if not original.exists():
            tmp = target / "original.part"
            with tmp.open("wb") as f:
                f.write(content)
                f.flush()
                os.fsync(f.fileno())
            tmp.replace(original)
        for name, size in (("preview.webp", 1600), ("thumb.webp", 320)):
            if not (target / name).exists():
                preview = image.copy()
                preview.thumbnail((size, size))
                if preview.mode not in ("RGB", "RGBA"):
                    preview = preview.convert("RGBA")
                preview.save(target / (name + ".part"), "WEBP", quality=86)
                (target / (name + ".part")).replace(target / name)
        return {"id": digest, "rev": 0, "filename": Path(filename).name[:200],
                "original": f"{digest}/original", "preview": f"{digest}/preview.webp",
                "thumbnail": f"{digest}/thumb.webp", "bytes": len(content),
                "mime": Image.MIME.get(fmt, "application/octet-stream"),
                "width": width, "height": height, "captured_at": captured,
                "original_captured_at": captured, "location": location,
                "original_location": location, "location_label": "",
                "created": (now or datetime.now()).isoformat(), "is_sticker": False}
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ValueError("This file could not be read as a photo") from exc


def photo_references(document):
    """Full photo blocks take display precedence over text-only references."""
    blocks = document or []
    photos = [block for block in blocks if block.get("type") == "photo" and isinstance(block.get("asset_id"), str)]
    by_block_id = {photo.get("id"): photo["asset_id"] for photo in photos}
    seen = {photo["asset_id"] for photo in photos}
    for block in blocks:
        if block.get("type") != "text":
            continue
        for link in block.get("links", []):
            for identity in link.get("photos", []):
                if isinstance(identity, str):
                    identity = by_block_id.get(identity, identity)
                if not isinstance(identity, str) or not identity or identity in seen:
                    continue
                seen.add(identity)
                photos.append({"type": "photo", "asset_id": identity, "linked_only": True})
    return photos


def photo_analytics(entries, start=None, end=None):
    """Count unique photos at their latest in-range use, retaining display details."""
    found, direct, counts, series = {}, set(), defaultdict(Counter), Counter()
    for entry in sorted(entries, key=lambda row: row.get("date", ""), reverse=True):
        date = entry.get("date", "")
        if (start and date < start) or (end and date > end):
            continue
        for block in photo_references(entry.get("document")):
            identity = block["asset_id"]
            prior = found.get(identity)
            merged = copy.deepcopy((prior or {}).get("tags", {}))
            for gid, names in block.get("tags", {}).items():
                merged[gid] = sorted(set(merged.get(gid, [])) | set(names))
            if prior is None:
                series[date] += 1
            if prior is None or (identity not in direct and not block.get("linked_only")):
                found[identity] = {**copy.deepcopy(block), "date": prior["date"] if prior else date,
                                   "details_date": date}
                found[identity].pop("linked_only", None)
            found[identity]["tags"] = merged
            if not block.get("linked_only"):
                direct.add(identity)
    for photo in found.values():
        for gid, names in photo.get("tags", {}).items():
            counts[gid].update(set(names))
    return {"photos": len(found), "gallery": sorted(found.values(), key=lambda x: x["date"], reverse=True),
            "tags": {gid: dict(c) for gid, c in counts.items()}, "series": dict(sorted(series.items()))}


def rebase_links(before, after, links):
    """Keep links over unchanged text when command markers grow on commit."""
    from difflib import SequenceMatcher
    matches = SequenceMatcher(None, before, after, autojunk=False).get_matching_blocks()
    result = []
    for link in links:
        for a, b, size in matches:
            if a <= link['start'] and link['end'] <= a + size:
                result.append({**link, 'start': link['start'] + b - a, 'end': link['end'] + b - a})
                break
    return result


def replace_document_body(document, body):
    """Reconcile an older plain-text client without dropping embedded media."""
    document = copy.deepcopy(document)
    before = document_body(document)
    if before == body:
        return document
    start, end, new_end = 0, len(before), len(body)
    while start < min(end, new_end) and before[start] == body[start]:
        start += 1
    while end > start and new_end > start and before[end - 1] == body[new_end - 1]:
        end -= 1
        new_end -= 1
    offset, inserted = 0, False
    for block in document:
        if block['type'] != 'text':
            continue
        text = block.get('text', '')
        last = offset + len(text)
        if start <= last and end >= offset:
            value = text[:max(0, start - offset)]
            if not inserted:
                value += body[start:new_end]
                inserted = True
            value += text[max(0, end - offset):]
            block['links'] = rebase_links(text, value, block.get('links', []))
            block['text'] = value
        offset = last + 1
    if document_body(document) != body:
        # A plain-text client can remove a paragraph boundary that contained a
        # photo. Keep every media record and all text in one paragraph in that case.
        combined_links, offset = [], 0
        for block in validate_document(document):
            if block['type'] == 'text':
                combined_links.extend({**link, 'start': link['start'] + offset, 'end': link['end'] + offset} for link in block.get('links', []))
                offset += len(block['text']) + 1
        projected = document_body(document)
        first = next((b for b in document if b['type'] == 'text'), None)
        if first is None:
            import uuid
            first = {'id': uuid.uuid4().hex, 'type': 'text'}
            document.insert(0, first)
        document = [b for b in document if b['type'] != 'text' or b is first]
        first.update(text=body, links=rebase_links(projected, body, combined_links))
    return document
