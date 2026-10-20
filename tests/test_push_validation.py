"""Push data stays canonical and malformed input cannot claim a fresh sync."""
from datetime import datetime

import pytest

import app as app_module
from integrations import health
from integrations import store as integrations
import journal
from integrations import usage

NOW = datetime(2026, 9, 10, 12)


@pytest.mark.parametrize("module,fields", [
    (usage, ["screen_min", "unlocks"]),
    (health, ["steps", "distance_m", "calories", "resting_hr", "avg_hr", "min_hr", "max_hr"]),
])
@pytest.mark.parametrize("value", [float("inf"), float("-inf"), "1e999", "Infinity"])
def test_nonfinite_push_metrics_are_junk(module, fields, value):
    parsed = module.parse_push({"date": "2026-09-10", **dict.fromkeys(fields, value)}, now=NOW)[0]
    assert all(parsed[field] == 0 for field in fields)


@pytest.mark.parametrize("module", [usage, health])
@pytest.mark.parametrize("date", ["2026-9-10", "2026-09-1", "2026-9-1", "2026-02-29", "2026-09-10T12:00"])
def test_push_skips_noncanonical_days(module, date):
    assert module.parse_push({"date": date}, now=NOW) == []


@pytest.mark.parametrize("time", ["24:00", "12:60", "aa:bb", "-1:30", "2026-09-10T25:00:00"])
def test_health_skips_invalid_clock_times(time):
    parsed = health.parse_push({"date": "2026-09-10", "heart_rate": [
        {"time": time, "bpm": 70}, {"time": "23:59", "bpm": 80},
    ]}, now=NOW)[0]
    assert parsed["heart_rate_samples"] == [{"time": "23:59", "bpm": 80}]
    assert parsed["avg_hr"] == 80


@pytest.mark.parametrize("provider", ["phone", "health"])
@pytest.mark.parametrize("payload", [None, {}, [], "bad", [{"date": "bad"}], {"date": "2026-9-10"}])
def test_rejected_push_does_not_change_store_or_success_time(tmp_path, monkeypatch, provider, payload):
    config = app_module.app.config
    jpath, ipath = tmp_path / "journal.json", tmp_path / "integrations.json"
    monkeypatch.setitem(config, "TESTING", True)
    monkeypatch.setitem(config, "JOURNAL_FILE", str(jpath))
    monkeypatch.setitem(config, "INTEGRATIONS_FILE", str(ipath))
    journal.save(str(jpath), journal._empty())
    istore = integrations._empty()
    integrations.set_token(istore, provider, "synthetic-push-token")
    integrations.set_last_sync(istore, provider, "2026-09-09T12:00:00")
    integrations.save(str(ipath), istore)
    before = [path.read_bytes() for path in (jpath, ipath)]
    with app_module.app.test_client() as client:
        reply = client.post(f"/integrations/{provider}/ingest", json=payload,
                            headers={"Authorization": "Bearer synthetic-push-token"})
    assert reply.status_code == 400
    assert reply.get_json()["ok"] is False
    assert [path.read_bytes() for path in (jpath, ipath)] == before


@pytest.mark.parametrize("date", ["2026-9-10", "2026-09-1", "2026-9-1"])
def test_journal_date_key_must_be_canonical(date):
    store = journal._empty()
    with pytest.raises(ValueError, match="Invalid date"):
        journal.upsert_entry(store, date, "Title", "Body", now=NOW)
    assert store["entries"] == []
