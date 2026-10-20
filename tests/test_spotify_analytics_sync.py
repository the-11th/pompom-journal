"""Partial Spotify snapshots retain earlier sections and release local writes."""
from copy import deepcopy
from datetime import datetime
from threading import Event, Thread

import pytest

import app as app_module
import integrations
import journal
import spotify
import todo

SECTIONS = [
    ("playback", "fetch_playback_state", "parse_playback_state"),
    ("queue", "fetch_queue", "parse_queue"),
    ("devices", "fetch_devices", "parse_devices"),
    ("saved_tracks", "fetch_saved_tracks", "parse_saved_tracks"),
    ("saved_albums", "fetch_saved_albums", "parse_saved_albums"),
    ("saved_episodes", "fetch_saved_episodes", "parse_saved_episodes"),
    ("playlists", "fetch_current_user_playlists", "parse_playlists"),
    ("followed_artists", "fetch_followed_artists", "parse_followed_artists"),
]


def snapshot():
    return {"playback": {"kept": "playback"}, "queue": {"kept": "queue"},
            "devices": [{"kept": "devices"}], "playlists": [{"kept": "playlists"}],
            "followed_artists": [{"kept": "followed_artists"}],
            "library": {key: {"kept": key} for key in ("saved_tracks", "saved_albums", "saved_episodes")},
            "fetched": "2026-09-01T12:00:00"}


@pytest.fixture
def store(tmp_path, monkeypatch):
    app = app_module.app
    for key, name, data, save in [
        ("DATA_FILE", "tasks.json", todo._empty(), todo.save),
        ("JOURNAL_FILE", "journal.json", journal._empty(), journal.save),
        ("INTEGRATIONS_FILE", "integrations.json", integrations._empty(), integrations.save),
    ]:
        monkeypatch.setitem(app.config, key, str(tmp_path / name))
        save(str(tmp_path / name), data)
    monkeypatch.setitem(app.config, "TESTING", True)
    data = integrations.load(app.config["INTEGRATIONS_FILE"])
    integrations.set_tokens(data, "spotify", {"access_token": "synthetic", "expires_at": 9e9})
    integrations.set_analytics(data, "spotify", snapshot())
    integrations.set_last_sync(data, "spotify", "2026-09-02T12:00:00")
    integrations.save(app.config["INTEGRATIONS_FILE"], data)
    for label, fetch, parse in SECTIONS:
        monkeypatch.setattr(spotify, fetch, lambda token, label=label: {"fresh": label})
        monkeypatch.setattr(spotify, parse, lambda raw: raw)
    return app


def section(value, label):
    return value["library"][label] if label.startswith("saved_") else value[label]


@pytest.mark.parametrize("label,fetch,parse", SECTIONS)
def test_partial_snapshot_preserves_failed_section_and_success_timestamps(store, monkeypatch, label, fetch, parse):
    def failed(token):
        raise OSError("Synthetic temporary failure")
    monkeypatch.setattr(spotify, fetch, failed)
    with store.test_client() as client:
        reply = client.post("/integrations/spotify/analytics")
    assert reply.status_code == 200
    saved = integrations.load(store.config["INTEGRATIONS_FILE"])
    value = integrations.get_analytics(saved, "spotify")
    assert section(value, label) == section(snapshot(), label)
    assert value["fetched"] == snapshot()["fetched"]
    assert saved["spotify"]["last_sync"] == "2026-09-02T12:00:00"
    assert reply.json["ok"] is False
    assert reply.json["errors"] == [label + ": Synthetic temporary failure"]
    other = next(name for name, _, _ in SECTIONS if name != label)
    assert section(value, other) == {"fresh": other}


def test_successful_analytics_refresh_does_not_delay_daily_play_sync(store):
    with store.test_client() as client:
        reply = client.post("/integrations/spotify/analytics")
    assert reply.json["ok"] is True
    saved = integrations.load(store.config["INTEGRATIONS_FILE"])
    assert saved["spotify"]["last_sync"] == "2026-09-02T12:00:00"
    assert saved["spotify"]["analytics"]["fetched"] != snapshot()["fetched"]


def test_refresh_failure_returns_retained_snapshot_without_writes(store, monkeypatch):
    data = integrations.load(store.config["INTEGRATIONS_FILE"])
    integrations.set_credentials(data, "spotify", "synthetic-id", "synthetic-secret")
    integrations.set_tokens(data, "spotify", {"access_token": "synthetic", "refresh_token": "synthetic-refresh", "expires_at": 0})
    integrations.save(store.config["INTEGRATIONS_FILE"], data)
    def failed(*args, **kwargs):
        raise OSError("Synthetic token failure")
    monkeypatch.setattr(spotify, "refresh_tokens", failed)
    with store.test_client() as client:
        reply = client.post("/integrations/spotify/analytics")
    assert reply.status_code == 200
    assert reply.json["ok"] is False
    assert reply.json["analytics"] == snapshot()
    assert integrations.load(store.config["INTEGRATIONS_FILE"]) == data


def test_all_failed_sections_leave_file_bytes_unchanged(store, monkeypatch):
    from pathlib import Path
    def failed(token):
        raise OSError("Synthetic temporary failure")
    for _, fetch, _ in SECTIONS:
        monkeypatch.setattr(spotify, fetch, failed)
    path = Path(store.config["INTEGRATIONS_FILE"])
    before = path.read_bytes()
    with store.test_client() as client:
        reply = client.get("/integrations/spotify/analytics")
    assert reply.json["ok"] is False
    assert len(reply.json["errors"]) == 8
    assert path.read_bytes() == before


def test_snapshot_clock_and_reconcile_preserve_newer_section(store):
    import provider_sync
    initial = integrations.load(store.config["INTEGRATIONS_FILE"])
    fetched, current = deepcopy(initial), deepcopy(initial)
    result = provider_sync.spotify_analytics(fetched, now=datetime(2026, 9, 10, 12))
    assert result["analytics"]["fetched"] == "2026-09-10T12:00:00"
    current["spotify"]["analytics"]["library"]["saved_tracks"] = {"newer": 90}
    current["spotify"]["analytics"]["fetched"] = "2026-09-10T12:01:00"
    merged = provider_sync.reconcile_spotify_analytics(initial, fetched, current, result)
    assert merged["ok"] is False
    assert merged["analytics"]["library"]["saved_tracks"] == {"newer": 90}
    assert merged["analytics"]["library"]["saved_albums"] == {"fresh": "saved_albums"}
    assert merged["analytics"]["fetched"] == "2026-09-10T12:01:00"


@pytest.mark.parametrize("operation", ["save", "disconnect", "credentials"])
def test_analytics_fetch_allows_local_work_and_discards_changed_connection(store, monkeypatch, operation):
    entered, release, completed = Event(), Event(), Event()
    errors, replies = [], {}
    def wait(token):
        entered.set()
        assert release.wait(5)
        return {"fresh": "playback"}
    monkeypatch.setattr(spotify, "fetch_playback_state", wait)
    def sync():
        try:
            with store.test_client() as client:
                replies["sync"] = client.post("/integrations/spotify/analytics")
        except BaseException as exc:
            errors.append(exc)
    def change():
        try:
            with store.test_client() as client:
                if operation == "save":
                    replies["local"] = client.post("/journal/2026-09-09/autosave", json={"body": "Kept during analytics refresh"})
                elif operation == "disconnect":
                    replies["local"] = client.post("/integrations/spotify/disconnect")
                else:
                    replies["local"] = client.post("/integrations/spotify/credentials", data={"client_id": "replacement", "client_secret": "new"})
        except BaseException as exc:
            errors.append(exc)
        finally:
            completed.set()
    worker = Thread(target=sync, daemon=True)
    worker.start()
    assert entered.wait(2)
    local = Thread(target=change, daemon=True)
    local.start()
    try:
        assert completed.wait(1), "Provider network I/O blocked local work for at least1 second"
    finally:
        release.set()
        worker.join(5)
        local.join(5)
    assert not errors
    data = integrations.load(store.config["INTEGRATIONS_FILE"])
    if operation == "save":
        assert journal.get_entry_by_date(journal.load(store.config["JOURNAL_FILE"]), "2026-09-09")["body"] == "Kept during analytics refresh"
        assert replies["sync"].json["ok"] is True
    else:
        assert replies["sync"].json["ok"] is False
        assert integrations.get_analytics(data, "spotify") == ({} if operation == "disconnect" else snapshot())
