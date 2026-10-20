"""Synthetic history uploads preserve journal data and never count a play twice."""
import io
import json
from datetime import datetime

import pytest

import app as app_module
import integrations
import journal
import todo

NOW = datetime(2026, 9, 10, 12)


@pytest.fixture
def history_client(tmp_path, monkeypatch):
    config = app_module.app.config
    monkeypatch.setitem(config, "TESTING", True)
    for key, name, data, save in [
        ("JOURNAL_FILE", "journal.json", journal._empty(), journal.save),
        ("DATA_FILE", "tasks.json", todo._empty(), todo.save),
        ("INTEGRATIONS_FILE", "integrations.json", integrations._empty(), integrations.save),
    ]:
        monkeypatch.setitem(config, key, str(tmp_path / name))
        save(str(tmp_path / name), data)
    with app_module.app.test_client() as client:
        yield client, tmp_path


def play(identity, stamp="2026-09-09T12:00:00Z"):
    return {"ts": stamp, "master_metadata_track_name": "Song " + identity,
            "master_metadata_album_artist_name": "Artist", "ms_played": 180000,
            "spotify_track_uri": "spotify:track:" + identity}


def upload(client, rows, name="history.json"):
    return client.post("/integrations/spotify/history/import", content_type="multipart/form-data",
                       data={"history": (io.BytesIO(json.dumps(rows).encode()), name)})


def music(root):
    return journal.get_entry_by_date(journal.load(str(root / "journal.json")), "2026-09-09")["music"]


def test_repeated_history_import_is_idempotent_after_reopening(history_client):
    client, root = history_client
    rows = [play("one"), play("two", "2026-09-09T12:04:00Z")]
    assert upload(client, rows).status_code == 302
    assert music(root)["tracks"] == 2
    before = (root / "journal.json").read_bytes()
    assert upload(client, rows, "renamed-copy.json").status_code == 302
    assert music(root)["tracks"] == 2
    assert music(root)["minutes"] == 6
    assert (root / "journal.json").read_bytes() == before


def test_overlapping_history_files_and_repeated_rows_count_each_play_once(history_client):
    client, root = history_client
    one, two, three = play("one"), play("two", "2026-09-09T12:04:00Z"), play("three", "2026-09-09T12:08:00Z")
    upload(client, [one, two])
    upload(client, [two, three, three])
    value = music(root)
    assert value["tracks"] == 3
    assert value["minutes"] == 9
    assert value["distinct"] == 3
    assert value["top_artists"] == [{"name": "Artist", "count": 3}]


@pytest.mark.parametrize("bad", [
    {"ts": "not-a-date", "ms_played": 1000},
    {"ts": "2026-02-30T12:00:00Z", "ms_played": 1000},
    {"ts": 123, "ms_played": 1000},
    {"ts": "2026-09-09T12:00:00Z", "ms_played": "Infinity"},
    "not a record",
])
def test_invalid_history_batch_is_reported_without_writing(history_client, bad):
    client, root = history_client
    store = journal.load(str(root / "journal.json"))
    journal.upsert_entry(store, "2026-09-09", "Keep title", "Keep body", now=NOW)
    journal.save(str(root / "journal.json"), store)
    before = {path.name: path.read_bytes() for path in root.iterdir() if path.is_file()}
    reply = upload(client, [play("good"), bad])
    assert reply.status_code == 302
    with client.session_transaction() as session:
        assert any("failed" in message.lower() or "invalid" in message.lower() for _, message in session.get("_flashes", []))
    assert {path.name: path.read_bytes() for path in root.iterdir() if path.is_file()} == before


def test_zip_upload_explains_supported_format_and_preserves_data(history_client):
    client, root = history_client
    before = (root / "journal.json").read_bytes()
    reply = client.post("/integrations/spotify/history/import", content_type="multipart/form-data",
        data={"history": (io.BytesIO(b"PK\x03\x04synthetic archive"), "history.zip")})
    assert reply.status_code == 302
    with client.session_transaction() as session:
        assert any("JSON" in message for _, message in session.get("_flashes", []))
    assert (root / "journal.json").read_bytes() == before


def test_import_keeps_legacy_snapshot_without_adding_it_again(history_client):
    client, root = history_client
    path = str(root / "journal.json")
    store = journal.load(path)
    legacy = {"tracks": 17, "minutes": 52, "source": "spotify", "sources": ["history_import", "spotify"],
              "custom_legacy_field": {"kept": True}}
    journal.set_entry_music(store, "2026-09-09", legacy, now=NOW)
    journal.save(path, store)
    upload(client, [play("one")])
    entry = journal.get_entry_by_date(journal.load(path), "2026-09-09")
    assert entry["music"]["tracks"] == 1
    assert entry["music"]["source"] == "history_import"
    assert entry["music"]["source_label"] == "Imported history"
    assert entry["music_legacy"] == legacy


def test_later_live_sync_retains_imported_display_and_saves_live_snapshot(history_client):
    client, root = history_client
    upload(client, [play("one")])
    path = str(root / "journal.json")
    store = journal.load(path)
    shown = music(root)
    live = {"tracks": 4, "minutes": 12, "source": "spotify", "fetched": "2026-09-10T12:00:00"}
    journal.set_entry_music(store, "2026-09-09", live, now=NOW)
    journal.save(path, store)
    entry = journal.get_entry_by_date(journal.load(path), "2026-09-09")
    assert entry["music"] == shown
    assert entry["music_live"] == live


@pytest.mark.parametrize("first_source", ["spotify", "history_import"])
def test_provider_reconciliation_saves_live_results_when_import_arrives_during_fetch(history_client, first_source):
    from copy import deepcopy
    import provider_sync
    client, root = history_client
    path = str(root / "journal.json")
    initial = journal.load(path)
    first = {"tracks": 1, "minutes": 3, "source": first_source}
    journal.set_entry_music(initial, "2026-09-09", first, now=NOW)
    journal.save(path, initial)
    fetched = deepcopy(initial)
    live = {"tracks": 2, "minutes": 6, "source": "spotify"}
    journal.set_entry_music(fetched, "2026-09-09", live, now=NOW)
    upload(client, [play("history")])
    current = journal.load(path)
    istore = integrations._empty()
    provider_sync.reconcile("spotify", istore, deepcopy(istore), deepcopy(istore), initial, fetched, current,
                            {"synced": ["2026-09-09"], "errors": []}, now=NOW)
    entry = journal.get_entry_by_date(current, "2026-09-09")
    assert entry["music"]["tracks"] == 1
    assert entry["music_live"] == live


@pytest.mark.parametrize("broken", [{}, [], {"version": 1}, False])
def test_corrupt_saved_history_is_preserved_before_any_new_import(history_client, broken):
    client, root = history_client
    path = str(root / "journal.json")
    data = journal.load(path)
    entry = journal.upsert_entry(data, "2026-09-09", "Keep", "", now=NOW)
    entry["music_history"] = broken
    journal.save(path, data)
    before = (root / "journal.json").read_bytes()
    upload(client, [play("new")])
    assert (root / "journal.json").read_bytes() == before
    with client.session_transaction() as session:
        assert any("review" in message for _, message in session.get("_flashes", []))


def test_small_imports_add_duration_before_rounding_and_preserve_full_artist_counts(history_client):
    client, root = history_client
    first = []
    for i in range(12):
        row = play(str(i), f"2026-09-09T12:{i:02d}:00Z")
        row.update(ms_played=20000, master_metadata_album_artist_name="Artist " + str(i))
        first.append(row)
    upload(client, first)
    later = [play("return", "2026-09-09T13:00:00Z")]
    later[0].update(ms_played=20000, master_metadata_album_artist_name="Artist 9")
    upload(client, later)
    shown = music(root)
    assert shown["minutes"] == 4
    assert shown["top_artists"][0] == {"name": "Artist 9", "count": 2}
    upload(client, list(reversed(first + later)))
    assert music(root) == shown


def test_import_validates_later_saved_day_before_changing_caller():
    from copy import deepcopy
    import music_history
    import spotify
    data = journal._empty()
    later = journal.upsert_entry(data, "2026-09-10", "Keep", "", now=NOW)
    later["music_history"] = {"version": 1}
    before = deepcopy(data)
    with pytest.raises(ValueError, match="review"):
        music_history.import_plays(data, spotify.parse_streaming_history([
            play("first"), play("later", "2026-09-10T12:00:00Z")]), now=NOW)
    assert data == before


def test_entry_view_excludes_internal_history_receipts_and_retained_sources(history_client):
    client, root = history_client
    upload(client, [play("one")])
    data = journal.load(str(root / "journal.json"))
    entry = journal.get_entry_by_date(data, "2026-09-09")
    view = journal.entry_view(data, entry)
    assert view["music"]["source"] == "history_import"
    assert "music_history" not in view
    assert "music_live" not in view
    assert "music_legacy" not in view
    assert entry["music_history"]["receipts"]
    analytics = client.get("/journal/analytics/data").get_json()["entries"][0]
    assert analytics["music"]["source"] == "history_import"
    assert analytics["music"]["source_label"] == "Imported history"
    assert not {"music_history", "music_live", "music_legacy"} & analytics.keys()


def test_provider_reconciliation_updates_live_snapshot_for_already_imported_day(history_client):
    from copy import deepcopy
    import provider_sync
    client, root = history_client
    upload(client, [play("one")])
    initial = journal.load(str(root / "journal.json"))
    fetched, current = deepcopy(initial), deepcopy(initial)
    live = {"tracks": 9, "minutes": 27, "source": "spotify"}
    journal.set_entry_music(fetched, "2026-09-09", live, now=NOW)
    istore = integrations._empty()
    provider_sync.reconcile("spotify", istore, deepcopy(istore), deepcopy(istore), initial, fetched, current,
                            {"synced": ["2026-09-09"], "errors": []}, now=NOW)
    entry = journal.get_entry_by_date(current, "2026-09-09")
    assert entry["music"]["tracks"] == 1
    assert entry["music_live"] == live
