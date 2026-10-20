"""Offline PMTiles catalog, validated local files, and explicit Mac downloads."""
from pathlib import Path
from datetime import datetime, timezone
from contextlib import contextmanager
import hashlib
import json
import os
import re
import struct
import subprocess
import threading
import uuid
import urllib.request
import shutil
from datapom.domain import journal_media

_jobs = {}
_guard = threading.RLock()


class MapVersionChanged(ValueError):
    """A byte reader belongs to a different installed archive."""


@contextmanager
def readable_pack(root, identity, version=None):
    """Hold publication stable until the caller opens its response stream."""
    if not journal_media.IDENTITY.fullmatch(identity):
        raise FileNotFoundError(identity)
    root = Path(root)
    path = root / (identity + '.pmtiles')
    with _guard:
        if not path.is_file():
            raise FileNotFoundError(identity)
        if version:
            try:
                current = _installed_metadata(path, root / (identity + '.json'))['sha256']
            except (ValueError, OSError) as exc:
                raise MapVersionChanged('Map archive is no longer available') from exc
            if version != current:
                raise MapVersionChanged('Map archive changed; refresh its manifest')
        yield path


def catalog():
    return [
        {"id": "world", "name": "World overview", "bounds": [-180, -85.0511, 180, 85.0511], "max_zoom": 5},
        {"id": "shanghai", "name": "Shanghai", "bounds": [120.85, 30.65, 122.25, 31.90], "max_zoom": 15},
        {"id": "beijing", "name": "Beijing", "bounds": [115.35, 39.40, 117.55, 41.10], "max_zoom": 15},
        {"id": "bay-area", "name": "San Francisco Bay Area · all nine counties",
         # Census nine-county combined extent, padded to include offshore areas.
         "bounds": [-123.65, 36.85, -121.20, 38.90], "max_zoom": 15,
         "counties": ["Alameda", "Contra Costa", "Marin", "Napa", "San Francisco", "San Mateo", "Santa Clara", "Solano", "Sonoma"]},
    ]


def read_header(path):
    with Path(path).open("rb") as stream:
        raw = stream.read(127)
    if len(raw) < 127 or raw[:8] != b"PMTiles\x03" or raw[99] != 1:
        raise ValueError("This is not a supported vector map pack")
    return {"min_zoom": raw[100], "max_zoom": raw[101],
            "bounds": [x / 1e7 for x in struct.unpack_from("<iiii", raw, 102)]}


def _extra(root):
    path = Path(root) / "regions.json"
    values = _read_json(path, [])
    if not isinstance(values, list):
        return []
    result, seen = [], set()
    for region in values:
        if not isinstance(region, dict):
            continue
        identity, name, zoom = region.get("id"), region.get("name"), region.get("max_zoom", 15)
        if (not isinstance(identity, str) or not re.fullmatch(r"[a-f0-9]{32}", identity)
                or identity in seen or not isinstance(name, str) or not name.strip() or len(name) > 200
                or type(zoom) is not int or not 0 <= zoom <= 18):
            continue
        try:
            bounds = _bounds(region.get("bounds"))
        except (TypeError, ValueError):
            continue
        result.append({**region, "name": name.strip(), "bounds": bounds, "max_zoom": zoom})
        seen.add(identity)
    return result


def _read_json(path, fallback):
    try:
        return json.loads(path.read_text()) if path.exists() else fallback
    except (ValueError, OSError):
        if path.exists():
            try:
                shutil.copy2(path, path.with_suffix(path.suffix + ".bak"))
            except OSError:
                pass
        return fallback


def _bounds(bounds):
    if not isinstance(bounds, list) or len(bounds) != 4:
        raise ValueError("A map area is required")
    a = journal_media.coordinate({"lon": bounds[0], "lat": bounds[1]})
    b = journal_media.coordinate({"lon": bounds[2], "lat": bounds[3]})
    if a["lon"] >= b["lon"] or a["lat"] >= b["lat"] or abs(a["lat"]) > 85.0511 or abs(b["lat"]) > 85.0511:
        raise ValueError("Choose an area inside the map")
    return [a["lon"], a["lat"], b["lon"], b["lat"]]


def add_region(root, name, bounds, identity=None):
    if not isinstance(name, str) or not name.strip() or len(name) > 200:
        raise ValueError("Name and a map area are required")
    if identity is not None and (not isinstance(identity, str) or not re.fullmatch(r"[a-f0-9]{32}", identity)):
        raise ValueError("Invalid map region ID")
    region = {"id": identity or uuid.uuid4().hex, "name": name.strip(), "bounds": _bounds(bounds), "max_zoom": 15}
    with _guard:
        extra = _extra(root)
        existing = next((item for item in extra if item["id"] == region["id"]), None)
        if existing is not None:
            if any(existing.get(field) != region[field] for field in ("name", "bounds", "max_zoom")):
                raise ValueError("This map region ID already belongs to a different area")
            return existing
        extra.append(region)
        journal_media.save(Path(root) / "regions.json", extra)
        return region


def _file_stamp(stat):
    """Detect replacements and same-size edits without rehashing stable packs."""
    return [stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns]


def _inspect_pack(path, source=None):
    before = _file_stamp(path.stat())
    header = read_header(path)
    with path.open("rb") as stream:
        if _file_stamp(os.fstat(stream.fileno())) != before:
            raise ValueError("Map pack changed during verification")
        digest = hashlib.file_digest(stream, "sha256").hexdigest()
        if _file_stamp(os.fstat(stream.fileno())) != before:
            raise ValueError("Map pack changed during verification")
    if _file_stamp(path.stat()) != before:
        raise ValueError("Map pack changed during verification")
    return {**header, "sha256": digest, "bytes": before[2], "file_stamp": before,
            "downloaded_at": datetime.now(timezone.utc).isoformat(), "build": source}


def _installed_metadata(path, sidecar):
    # Never call finish_pack here: an interrupted .part file must not replace
    # the usable installed archive while rebuilding its metadata.
    with _guard:
        metadata = _read_json(sidecar, {})
        if not isinstance(metadata, dict):
            metadata = {}
        header = read_header(path)
        stamp = _file_stamp(path.stat())
        if (not journal_media.BLOB.fullmatch(str(metadata.get("sha256", "")))
                or metadata.get("bytes") != stamp[2] or metadata.get("file_stamp") != stamp):
            recovered = _inspect_pack(path, metadata.get("build"))
            for key in ("downloaded_at", "estimated_bytes"):
                if key in metadata:
                    recovered[key] = metadata[key]
            journal_media.save(sidecar, recovered)
            metadata = recovered
        return {**{key: metadata[key] for key in ("sha256", "bytes", "file_stamp", "downloaded_at", "build", "estimated_bytes")
                   if key in metadata}, **header}


def manifest(root):
    root = Path(root)
    result = []
    for region in catalog() + _extra(root):
        identity = region["id"]
        item = {**region, "status": "not_downloaded", "bytes": None, "downloaded_bytes": 0,
                "attribution": "© OpenStreetMap contributors · Protomaps", "source": "OpenStreetMap / Natural Earth"}
        path, meta = root / (identity + ".pmtiles"), root / (identity + ".json")
        metadata = _read_json(meta, {})
        if isinstance(metadata, dict):
            item["estimated_bytes"] = metadata.get("estimated_bytes", metadata.get("bytes"))
        if path.exists():
            try:
                item.update(_installed_metadata(path, meta), status="ready")
                item["url"] = "/journal/media/maps/file/" + identity
            except (ValueError, OSError):
                item["status"] = "invalid"
        with _guard:
            job = _jobs.get(str(root / identity))
            if job:
                available = item["status"] == "ready"
                item.update(job)
                item["download_status"] = job.get("status")
                if available:
                    item["status"] = "ready"
        part = root / (identity + ".part.pmtiles")
        if part.exists():
            item["downloaded_bytes"] = part.stat().st_size
        result.append(item)
    return result


def finish_pack(root, identity, source=None):
    root = Path(root)
    part = root / (identity + ".part.pmtiles")
    path = root / (identity + ".pmtiles")
    with _guard:
        candidate = part if part.exists() else path
        metadata = _inspect_pack(candidate, source)
        if candidate == part:
            os.replace(part, path)
            metadata["file_stamp"] = _file_stamp(path.stat())
        journal_media.save(root / (identity + ".json"), metadata)
    return metadata


def estimate_bytes(output):
    match = re.search(r"archive size of ([0-9.]+)\s*([kMGT]?B)", output)
    if not match:
        return None
    return round(float(match[1]) * {"B": 1, "kB": 1000, "MB": 1000000, "GB": 1000000000, "TB": 1000000000000}[match[2]])


def download(root, identity, estimate=False):
    root = Path(root)
    region = next((p for p in catalog() + _extra(root) if p["id"] == identity), None)
    if region is None:
        raise ValueError("Unknown map region")
    tool = root.parent / "tools" / "pmtiles"
    if not tool.is_file():
        raise ValueError("Install the Mac map downloader with scripts/install_map_tools.py")
    key = str(root / identity)
    with _guard:
        if _jobs.get(key, {}).get("status") in ("downloading", "checking_size"):
            return
        _jobs[key] = {"status": "checking_size" if estimate else "downloading", "error": None}

    def run():
        try:
            root.mkdir(parents=True, exist_ok=True)
            with urllib.request.urlopen("https://build-metadata.protomaps.dev/builds.json", timeout=30) as response:
                builds = json.load(response)
            build = max(b["key"] for b in builds if re.fullmatch(r"\d{8}\.pmtiles", b.get("key", "")))
            source = "https://build.protomaps.com/" + build
            command = [str(tool), "extract", source, str(root / (identity + ".part.pmtiles")),
                       "--maxzoom=" + str(region["max_zoom"]), "--download-threads=4"]
            if identity != "world":
                command.append("--bbox=" + ",".join(map(str, region["bounds"])))
            if estimate:
                command.append("--dry-run")
            log = root / (identity + "-download.log")
            with log.open("w") as stream:
                process = subprocess.run(command, stdout=stream, stderr=subprocess.STDOUT, timeout=7200)
            output = log.read_text(errors="replace")
            if process.returncode:
                raise ValueError("Map download interrupted. Retry to download this region again.")
            if not estimate:
                subprocess.run([str(tool), "verify", str(root / (identity + ".part.pmtiles"))], check=True, capture_output=True)
                finish_pack(root, identity, build)
            with _guard:
                _jobs.pop(key, None)
                if estimate:
                    metadata = _read_json(root / (identity + ".json"), {})
                    metadata["estimated_bytes"] = estimate_bytes(output)
                    journal_media.save(root / (identity + ".json"), metadata)
        except Exception as exc:
            with _guard:
                _jobs[key] = {"status": "failed", "error": str(exc)}
    threading.Thread(target=run, daemon=True, name="map-download-" + identity).start()
