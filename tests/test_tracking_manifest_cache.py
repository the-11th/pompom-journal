"""Receipt caching never changes the authoritative daily observation format."""
import gzip
import hashlib
import os

from datapom.domain import journal_media
from datapom.domain import places
import pytest


DAY = "2026-09-08"


def rows(identity="one", day=DAY):
    row = places.clean_sample({"id": identity, "at": day + "T12:00:00+08:00",
                               "lat": 31.2, "lon": 121.5, "accuracy_m": 10})
    return {identity: row}


def receipt(values, day=DAY):
    raw = places._day_bytes(values)
    return {"date": day, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(), "count": len(values)}


def count_reads(monkeypatch):
    calls = []
    original = places._day_values

    def counted(root, date):
        calls.append(date)
        return original(root, date)

    monkeypatch.setattr(places, "_day_values", counted)
    return calls


def test_unchanged_manifest_reuses_receipts_and_returns_independent_objects(tmp_path, monkeypatch):
    journal_media.save(tmp_path / (DAY + ".json"), rows())
    calls = count_reads(monkeypatch)
    first = places.manifest(tmp_path)
    first[0]["sha256"] = "caller mutation"
    assert places.manifest(tmp_path) == [receipt(rows())]
    assert calls == [DAY]


def test_external_atomic_replacement_invalidates_same_size_same_mtime(tmp_path, monkeypatch):
    path = tmp_path / (DAY + ".json")
    journal_media.save(path, rows("one"))
    before = path.stat()
    places.manifest(tmp_path)
    journal_media.save(path, rows("two"))
    os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
    assert path.stat().st_size == before.st_size
    assert places.manifest(tmp_path) == [receipt(rows("two"))]


def test_external_in_place_change_invalidates_preserved_mtime(tmp_path):
    path = tmp_path / (DAY + ".json")
    path.write_bytes(places._day_bytes(rows("one")))
    before = path.stat()
    places.manifest(tmp_path)
    with path.open("r+b") as stream:
        stream.write(places._day_bytes(rows("two")))
    os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
    assert path.stat().st_ino == before.st_ino
    assert path.stat().st_size == before.st_size
    assert places.manifest(tmp_path) == [receipt(rows("two"))]


def test_delete_and_recreate_never_reuse_a_missing_days_receipt(tmp_path):
    path = tmp_path / (DAY + ".json")
    journal_media.save(path, rows())
    places.manifest(tmp_path)
    path.unlink()
    assert places.manifest(tmp_path) == []
    journal_media.save(path, rows("new"))
    assert places.manifest(tmp_path) == [receipt(rows("new"))]


def test_plain_gzip_migration_and_interrupted_duplicate_are_receipt_stable(tmp_path):
    path = tmp_path / (DAY + ".json")
    journal_media.save(path, rows())
    expected = places.manifest(tmp_path)
    packed = path.with_suffix(".json.gz")
    packed.write_bytes(gzip.compress(places._day_bytes(rows())))
    assert places.manifest(tmp_path) == expected
    path.unlink()
    assert places.manifest(tmp_path) == expected
    journal_media.save(path, rows("two"))
    packed.unlink()
    assert places.manifest(tmp_path) == [receipt(rows("two"))]


def test_corrupt_day_invalidates_cache_preserves_backup_and_recovers(tmp_path):
    path = tmp_path / (DAY + ".json.gz")
    path.write_bytes(gzip.compress(places._day_bytes(rows())))
    places.manifest(tmp_path)
    path.write_bytes(b"interrupted compressed file")
    assert places.manifest(tmp_path) == [receipt({})]
    assert path.with_suffix(".gz.bak").read_bytes() == b"interrupted compressed file"
    path.write_bytes(gzip.compress(places._day_bytes(rows("recovered"))))
    assert places.manifest(tmp_path) == [receipt(rows("recovered"))]


def test_analytics_manifest_skips_conflicting_day_without_weakening_sync(tmp_path):
    path = tmp_path / (DAY + ".json")
    journal_media.save(path, rows())
    conflicting = rows()
    conflicting["one"]["lat"] = 32.1
    path.with_suffix(".json.gz").write_bytes(gzip.compress(places._day_bytes(conflicting)))
    other_day = "2026-09-09"
    journal_media.save(tmp_path / (other_day + ".json"), rows("two", other_day))
    with pytest.raises(ValueError, match="already belongs"):
        places.manifest(tmp_path)
    assert places.manifest(tmp_path, skip_invalid=True) == [receipt(rows("two", other_day), other_day)]


def test_cache_is_bounded_across_stores_and_evicted_receipts_recompute(tmp_path, monkeypatch):
    monkeypatch.setattr(places, "_MANIFEST_CACHE_LIMIT", 2, raising=False)
    calls = count_reads(monkeypatch)
    for index in range(3):
        root = tmp_path / str(index)
        journal_media.save(root / (DAY + ".json"), rows(str(index)))
        assert places.manifest(root) == [receipt(rows(str(index)))]
    assert len(places._manifest_cache) <= 2
    assert places.manifest(tmp_path / "0") == [receipt(rows("0"))]
    assert calls == [DAY] * 4
