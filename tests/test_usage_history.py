from datetime import datetime

import app as app_module
from integrations import store as integrations
import journal
from integrations import usage

NOW = datetime(2026, 10, 19, 22)


def test_recovery_preserves_quality_and_does_not_invent_unlock_counts():
    recovered = usage.parse_push({
        "date": "2026-10-10", "screen_min": 130, "unlocks": 0,
        "details_available": False, "recovered": True,
        "top_apps": [{"name": "sample", "min": 130, "opens": 0}],
    }, now=NOW)[0]
    assert recovered["details_available"] is False
    assert recovered["recovered"] is True
    entries = [{"date": recovered["date"], "usage": recovered}]
    assert usage.usage_unlocks_series(entries) == []
    assert usage.usage_stats(entries)["avg_unlocks"] is None
    assert usage.usage_stats(entries)["avg_screen_min"] == 130


def test_backfill_cannot_replace_existing_usage_or_other_journal_fields(tmp_path, monkeypatch):
    config = app_module.app.config
    jpath, ipath = tmp_path / "journal.json", tmp_path / "integrations.json"
    monkeypatch.setitem(config, "TESTING", True)
    monkeypatch.setitem(config, "JOURNAL_FILE", str(jpath))
    monkeypatch.setitem(config, "INTEGRATIONS_FILE", str(ipath))
    data = journal._empty()
    entry = journal.upsert_entry(data, "2026-10-10", "Keep", "Personal text", now=NOW)
    original = {"screen_min": 110, "unlocks": 12}
    journal.set_entry_usage(data, entry["date"], original, now=NOW)
    journal.save(str(jpath), data)
    creds = integrations._empty()
    integrations.set_token(creds, "phone", "test-token")
    integrations.save(str(ipath), creds)
    payload = [{"date": "2026-10-10", "screen_min": 200, "recovered": True},
               {"date": "2026-10-11", "screen_min": 130, "recovered": True,
                "details_available": False}]
    with app_module.app.test_client() as client:
        result = client.post("/integrations/phone/ingest", json=payload,
                             headers={"Authorization": "Bearer test-token"})
    assert result.status_code == 200
    assert result.get_json()["dates"] == ["2026-10-10", "2026-10-11"]
    saved = journal.load(str(jpath))
    old = journal.get_entry_by_date(saved, "2026-10-10")
    assert old["usage"] == original
    assert old["body"] == "Personal text"
    assert old["updated"] == NOW.isoformat()
    assert journal.get_entry_by_date(saved, "2026-10-11")["usage"]["screen_min"] == 130
