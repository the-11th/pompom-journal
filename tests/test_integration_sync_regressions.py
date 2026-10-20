"""Provider refresh tests use fixed clocks and synthetic responses only."""
from datetime import datetime

import pytest

import app as app_module
import integrations
import journal
import todo
import spotify


NOW = datetime(2026, 9, 10, 9, 30)


@pytest.fixture
def app(tmp_path):
    app = app_module.app
    app.config.update(TESTING=True, JOURNAL_FILE=str(tmp_path / "journal.json"),
                      DATA_FILE=str(tmp_path / "tasks.json"),
                      INTEGRATIONS_FILE=str(tmp_path / "integrations.json"))
    journal.save(app.config["JOURNAL_FILE"], journal._empty())
    todo.save(app.config["DATA_FILE"], todo._empty())
    data = integrations._empty()
    for provider in ("google", "spotify"):
        integrations.set_tokens(data, provider, {"access_token": "synthetic", "expires_at": 9e9})
    integrations.set_api_key(data, "rescuetime", "synthetic")
    for provider in ("google", "rescuetime", "spotify"):
        integrations.set_last_sync(data, provider, "2026-09-09T09:30:00")
    integrations.save(app.config["INTEGRATIONS_FILE"], data)
    return app


def test_google_focus_day_is_included_outside_recent_window(app, monkeypatch):
    fetched = []
    monkeypatch.setattr("google_health.fetch_sleep", lambda token, date: fetched.append(date) or {})
    monkeypatch.setattr("google_health.parse_sleep", lambda raw, now=None: None)
    with app.app_context():
        app_module._google_sync(days=1, focus_date="2026-08-02", now=NOW)
    assert fetched == ["2026-09-10", "2026-08-02"]


def test_google_current_sleep_refreshes_while_old_complete_day_stays_cached(app, monkeypatch):
    data = journal.load(app.config["JOURNAL_FILE"])
    for date in ("2026-09-10", "2026-09-09"):
        journal.set_entry_sleep(data, date, {"duration_min": 120}, now=NOW)
    journal.save(app.config["JOURNAL_FILE"], data)
    fetched = []
    monkeypatch.setattr("google_health.fetch_sleep", lambda token, date: fetched.append(date) or {})
    monkeypatch.setattr("google_health.parse_sleep", lambda raw, now=None: {"duration_min": 480})
    with app.app_context():
        result = app_module._google_sync(days=2, now=NOW)
    assert fetched == ["2026-09-10"]
    assert result["synced"] == ["2026-09-10"]
    saved = journal.load(app.config["JOURNAL_FILE"])
    assert journal.get_entry_by_date(saved, "2026-09-10")["sleep"]["duration_min"] == 480


@pytest.mark.parametrize("provider", ["google", "rescuetime", "spotify"])
@pytest.mark.parametrize("force", ["1", "0"])
def test_manual_force_flag_reaches_provider(app, monkeypatch, provider, force):
    received = {}
    def fake_sync(**kwargs):
        received.update(kwargs)
        return {"connected": True, "synced": [], "errors": []}
    monkeypatch.setattr(app_module, f"_{provider}_sync", fake_sync)
    response = app.test_client().post(f"/integrations/{provider}/sync?force={force}&date=2026-08-02")
    assert response.status_code == 200
    assert received.get("force") is (force == "1")
    assert received["focus_date"] == "2026-08-02"


@pytest.mark.parametrize("provider", ["google", "rescuetime", "spotify"])
def test_invalid_focus_date_is_rejected_before_provider_request(app, monkeypatch, provider):
    calls = []
    monkeypatch.setattr(app_module, f"_{provider}_sync", lambda **kwargs: calls.append(kwargs))
    response = app.test_client().post(f"/integrations/{provider}/sync?date=not-a-date")
    assert response.status_code == 400
    assert not calls


def test_rescuetime_today_refreshes_partial_totals_and_preserves_prior_details_on_failure(app, monkeypatch):
    data = journal.load(app.config["JOURNAL_FILE"])
    previous_apps = [{"name": "editor", "min": 20, "productivity": 2}]
    journal.set_entry_rescuetime(data, "2026-09-10", {
        "pulse": 50, "total_min": 30, "top_activities": previous_apps,
    }, now=NOW)
    journal.save(app.config["JOURNAL_FILE"], data)
    monkeypatch.setattr("rescuetime.fetch_daily_summary", lambda key: [{
        "date": "2026-09-10", "productivity_pulse": 80, "total_hours": 2,
    }])
    def failed_activities(*args):
        raise RuntimeError("Synthetic activity outage")
    monkeypatch.setattr("rescuetime.fetch_activities", failed_activities)
    with app.app_context():
        result = app_module._rescuetime_sync(now=NOW)
    assert result["synced"] == ["2026-09-10"]
    current = journal.get_entry_by_date(journal.load(app.config["JOURNAL_FILE"]), "2026-09-10")["rescuetime"]
    assert current["total_min"] == 120 and current["pulse"] == 80
    assert current["top_activities"] == previous_apps
    assert result["errors"]
    assert integrations.last_sync(integrations.load(app.config["INTEGRATIONS_FILE"]), "rescuetime") == "2026-09-09T09:30:00"


@pytest.mark.parametrize("provider", ["google", "spotify"])
def test_partial_provider_failure_does_not_advance_success_timestamp(app, monkeypatch, provider):
    if provider == "google":
        def fetch(*args):
            raise RuntimeError("Synthetic outage")
        monkeypatch.setattr("google_health.fetch_sleep", fetch)
    else:
        monkeypatch.setattr("spotify.fetch_recently_played", lambda token: {"items": []})
        def fetch(*args):
            raise RuntimeError("Synthetic taste outage")
        monkeypatch.setattr("spotify.fetch_top", fetch)
    with app.app_context():
        result = getattr(app_module, f"_{provider}_sync")(now=NOW)
    assert result["errors"]
    assert integrations.last_sync(integrations.load(app.config["INTEGRATIONS_FILE"]), provider) == "2026-09-09T09:30:00"


def test_spotify_refresh_preserves_stored_refresh_token_when_response_omits_it():
    previous = {'access_token': 'old-access', 'refresh_token': 'keep-refresh'}
    refreshed = spotify.refresh_tokens('synthetic-client', 'synthetic-secret', 'keep-refresh',
        transport=lambda *args: (200, {'access_token': 'new-access', 'expires_in': 3600}),
        now=1000, prev=previous)
    assert refreshed['refresh_token'] == 'keep-refresh'
    assert refreshed['expires_at'] == 4600


def test_spotify_sync_refresh_keeps_credentials_and_uses_injected_clock(app, monkeypatch):
    data = integrations.load(app.config['INTEGRATIONS_FILE'])
    integrations.set_credentials(data, 'spotify', 'synthetic-client', 'synthetic-secret')
    integrations.set_tokens(data, 'spotify', {'access_token': 'old', 'refresh_token': 'keep',
                                            'expires_at': NOW.timestamp() - 10})
    integrations.save(app.config['INTEGRATIONS_FILE'], data)
    seen = {}
    def refresh(cid, secret, token, transport=None, now=None, prev=None):
        seen.update(now=now, prev=prev)
        return {'access_token': 'fresh', 'refresh_token': (prev or {}).get('refresh_token'),
                'expires_at': (now or 0) + 3600}
    monkeypatch.setattr(spotify, 'refresh_tokens', refresh)
    monkeypatch.setattr(spotify, 'fetch_recently_played', lambda token: {'items': []})
    monkeypatch.setattr(spotify, 'fetch_top', lambda *args: {'items': []})
    with app.app_context():
        app_module._spotify_sync(now=NOW)
    assert seen['now'] == NOW.timestamp()
    assert seen['prev']['refresh_token'] == 'keep'
    assert integrations.get_provider(integrations.load(app.config['INTEGRATIONS_FILE']), 'spotify')['tokens']['refresh_token'] == 'keep'


def test_refreshed_classic_sleep_removes_stale_stage_numbers_only():
    from datetime import timedelta
    data = journal._empty()
    manual = journal.add_section(data, 'manual number', 'numeric', '#e0a955')
    other = journal.add_section(data, 'other provider', 'numeric', '#e0a955', managed='other', metric='deep_sleep')
    journal.upsert_entry(data, '2026-09-10', 'Day', '', numbers={manual['id']: 5, other['id']: 77}, now=NOW)
    staged = {'duration_min': 480, 'quality': 90, 'stages': {'deep': 60, 'rem': 90, 'light': 300, 'wake': 30}}
    # An unrelated managed metric must not become Google's output destination.
    journal.apply_sleep_metrics(data, '2026-09-10', staged, now=NOW)
    google_stages = [s['id'] for s in data['sections'] if s.get('managed') == journal._GOOGLE_SLEEP_PROVIDER
                     and s.get('metric') in journal._SLEEP_STAGE_METRICS.values()]
    later = NOW + timedelta(minutes=1)
    journal.apply_sleep_metrics(data, '2026-09-10', {'duration_min': 480, 'quality': 90}, now=later)
    entry = journal.get_entry_by_date(data, '2026-09-10')
    assert all(sid not in entry['numbers'] for sid in google_stages)
    assert entry['numbers'][manual['id']] == 5 and entry['numbers'][other['id']] == 77
    assert entry['updated'] == later.isoformat()
    journal.apply_sleep_metrics(data, '2026-09-10', {'duration_min': 480, 'quality': 90}, now=later + timedelta(minutes=1))
    assert entry['updated'] == later.isoformat()
