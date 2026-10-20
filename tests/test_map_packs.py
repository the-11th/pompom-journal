import struct
import hashlib
import json
import pytest
from datapom.domain import map_packs


def test_region_retry_reuses_caller_identity_without_rewriting_store(tmp_path):
    identity = 'a' * 32
    first = map_packs.add_region(tmp_path, ' Trip ', ['120', '30', '122', '32'], identity=identity)
    path = tmp_path / 'regions.json'
    before = path.read_bytes()
    second = map_packs.add_region(tmp_path, 'Trip', [120, 30, 122, 32], identity=identity)
    assert first == second and second['id'] == identity
    assert path.read_bytes() == before
    assert len(map_packs._extra(tmp_path)) == 1
    with pytest.raises(ValueError, match='different'):
        map_packs.add_region(tmp_path, 'Changed trip', [120, 30, 122, 32], identity=identity)
    assert path.read_bytes() == before


@pytest.mark.parametrize('identity', ['', 'region', '../bad', 'a' * 31, 'A' * 32, 42])
def test_region_retry_identity_must_match_the_existing_record_format(tmp_path, identity):
    with pytest.raises(ValueError):
        map_packs.add_region(tmp_path, 'Trip', [120, 30, 122, 32], identity=identity)
    assert not (tmp_path / 'regions.json').exists()


def test_initial_catalog_covers_requested_regions_and_fremont():
    catalog = {p["id"]: p for p in map_packs.catalog()}
    assert set(catalog) == {"world", "shanghai", "beijing", "bay-area"}
    bay = catalog["bay-area"]
    assert len(bay["counties"]) == 9
    west, south, east, north = bay["bounds"]
    assert west < -121.9886 < east and south < 37.5485 < north
    assert south <= 36.892976 and north >= 38.8643 and west <= -123.632497 and east >= -121.208178


def test_pmtiles_header_validation(tmp_path):
    path = tmp_path / "world.pmtiles"
    path.write_bytes(b"not a map")
    with pytest.raises(ValueError):
        map_packs.read_header(path)
    data = bytearray(127)
    data[:8] = b"PMTiles\x03"
    data[97:101] = bytes([2, 2, 1, 0])
    data[101] = 5
    struct.pack_into("<iiii", data, 102, -1800000000, -850000000, 1800000000, 850000000)
    path.write_bytes(data)
    assert map_packs.read_header(path)["max_zoom"] == 5


def test_pack_manifest_shows_missing_and_installed_sizes(tmp_path):
    result = map_packs.manifest(tmp_path)
    assert all(p["status"] == "not_downloaded" for p in result)
    assert all(p["bytes"] is None for p in result)


def test_custom_region_validated_before_spawning_download(tmp_path):
    with pytest.raises(ValueError):
        map_packs.add_region(tmp_path, "Trip", [0, 0, 999, 999])
    region = map_packs.add_region(tmp_path, "Vacation", [120, 30, 122, 32])
    assert region["name"] == "Vacation"
    assert region["id"] in [p["id"] for p in map_packs.manifest(tmp_path)]


def test_custom_region_coordinates_are_saved_as_numbers(tmp_path):
    region = map_packs.add_region(tmp_path, "Vacation", ["120", "30", "122", "32"])
    assert region["bounds"] == [120.0, 30.0, 122.0, 32.0]
    assert json.loads((tmp_path / 'regions.json').read_text())[0]['bounds'] == region['bounds']


def test_malformed_region_rows_do_not_break_map_manager_or_hide_valid_regions(tmp_path):
    identity = 'a' * 32
    valid = {'id': identity, 'name': ' Vacation ', 'bounds': ['120', '30', '122', '32'], 'max_zoom': 15}
    invalid = [None, {'id': 5}, {**valid, 'id': 'b' * 32, 'bounds': [0, 0, float('nan'), 20]},
               {**valid, 'id': 'c' * 32, 'name': []}, {**valid, 'id': 'd' * 32, 'max_zoom': 'bad'},
               {**valid, 'id': 'e' * 32, 'bounds': [122, 30, 120, 32]}]
    (tmp_path / 'regions.json').write_text(json.dumps([*invalid, valid, valid]))
    result = map_packs.manifest(tmp_path)
    assert len(result) == 5
    assert result[-1]['name'] == 'Vacation'
    assert result[-1]['bounds'] == [120.0, 30.0, 122.0, 32.0]


def test_estimated_download_sizes_use_cli_decimal_units():
    assert map_packs.estimate_bytes("Extract will produce archive size of 3.6 MB") == 3600000
    assert map_packs.estimate_bytes("archive size of 831 kB") == 831000
    assert map_packs.estimate_bytes("No tiles in area") is None


def test_corrupt_optional_catalog_metadata_does_not_hide_valid_packs(tmp_path):
    (tmp_path / "regions.json").write_text("broken")
    (tmp_path / "world.json").write_text("broken")
    assert len(map_packs.manifest(tmp_path)) == 4


def test_an_installed_pack_remains_available_while_updating(tmp_path):
    data = bytearray(127)
    data[:8] = b"PMTiles\x03"
    data[97:102] = bytes([2, 2, 1, 0, 5])
    struct.pack_into("<iiii", data, 102, -1800000000, -850000000, 1800000000, 850000000)
    (tmp_path / "world.pmtiles").write_bytes(data)
    key = str(tmp_path / "world")
    try:
        map_packs._jobs[key] = {"status": "downloading"}
        pack = map_packs.manifest(tmp_path)[0]
        assert pack["status"] == "ready"
        assert pack["download_status"] == "downloading"
        assert pack["url"].endswith("/world")
    finally:
        map_packs._jobs.pop(key, None)


def installed_pack(path):
    data = bytearray(127)
    data[:8] = b"PMTiles\x03"
    data[97:102] = bytes([2, 2, 1, 0, 5])
    struct.pack_into("<iiii", data, 102, -1800000000, -850000000, 1800000000, 850000000)
    path.write_bytes(data)
    return data


@pytest.mark.parametrize("sidecar", [None, "corrupt json", '{"sha256": "invalid", "bytes": 127}'])
def test_manifest_recovers_metadata_once_without_publishing_partial_pack(tmp_path, monkeypatch, sidecar):
    path = tmp_path / "world.pmtiles"
    original = installed_pack(path)
    partial = tmp_path / "world.part.pmtiles"
    partial.write_bytes(b"unfinished download")
    metadata = tmp_path / "world.json"
    if sidecar is not None:
        metadata.write_text(sidecar)
    calls = []
    real_digest = hashlib.file_digest
    def digest(stream, algorithm):
        calls.append(stream.name)
        return real_digest(stream, algorithm)
    monkeypatch.setattr(map_packs.hashlib, "file_digest", digest)
    first = map_packs.manifest(tmp_path)[0]
    assert first["status"] == "ready"
    assert first["bytes"] == len(original)
    assert first["sha256"] == hashlib.sha256(original).hexdigest()
    assert json.loads(metadata.read_text())["sha256"] == first["sha256"]
    assert path.read_bytes() == original
    assert partial.read_bytes() == b"unfinished download"
    second = map_packs.manifest(tmp_path)[0]
    assert second["sha256"] == first["sha256"]
    assert calls == [str(path)]


def test_recovered_metadata_is_refreshed_when_the_installed_file_changes(tmp_path):
    path = tmp_path / "world.pmtiles"
    installed_pack(path)
    first = map_packs.manifest(tmp_path)[0]
    with path.open("ab") as stream:
        stream.write(b"changed archive")
    second = map_packs.manifest(tmp_path)[0]
    assert second["sha256"] != first["sha256"]
    assert second["bytes"] == path.stat().st_size


def test_invalid_file_is_never_advertised_as_ready_even_with_old_metadata(tmp_path):
    (tmp_path / "world.pmtiles").write_bytes(b"invalid map")
    (tmp_path / "world.json").write_text(json.dumps({"sha256": "a" * 64, "bytes": 11, "status": "ready"}))
    assert map_packs.manifest(tmp_path)[0]["status"] == "invalid"


def test_metadata_alone_cannot_advertise_a_missing_pack_as_ready(tmp_path):
    (tmp_path / "world.json").write_text(json.dumps({"sha256": "a" * 64, "bytes": 127, "status": "ready"}))
    pack = map_packs.manifest(tmp_path)[0]
    assert pack["status"] == "not_downloaded"
    assert pack["bytes"] is None


def test_same_size_edit_invalidates_cached_checksum(tmp_path):
    path = tmp_path / "world.pmtiles"
    original = installed_pack(path)
    first = map_packs.manifest(tmp_path)[0]
    changed = bytearray(original)
    changed[126] ^= 1
    path.write_bytes(changed)
    second = map_packs.manifest(tmp_path)[0]
    assert first["bytes"] == second["bytes"]
    assert first["sha256"] != second["sha256"]
