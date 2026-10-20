"""Complete activity imports and on-demand reports, with no real account I/O."""
from copy import deepcopy
from datetime import datetime, timedelta
from urllib.parse import parse_qs, urlparse

import pytest

import app as app_module
from integrations import store as integrations
import journal
from integrations import provider_sync
from integrations import rescuetime
import todo

NOW = datetime(2026, 9, 19, 14, 0)
DAY = "2026-09-18"
HEADERS = ["Rank", "Time Spent (seconds)", "Number of People", "Activity", "Category", "Productivity"]
ACTIVITIES = {"row_headers": HEADERS, "rows": [[1, 120, 1, "Editor", "Development", 2], [2, 20, 1, "example.com", "Reference", None]]}
HOURLY = {"row_headers": ["Date", *HEADERS[1:]], "rows": [[DAY + "T09:00:00", 120, 1, "Editor", "Development", 2]]}
DOCUMENTS = {"row_headers": [*HEADERS[:4], "Document", *HEADERS[4:]], "rows": [[1, 90, 1, "example.com", "A page title", "Reference", 1]]}


def connected():
    data = integrations._empty()
    integrations.set_api_key(data, "rescuetime", "synthetic")
    return data


def fake_reports(monkeypatch):
    for name, value in [("activities", ACTIVITIES), ("hourly", HOURLY), ("documents", DOCUMENTS)]:
        monkeypatch.setattr(rescuetime, "fetch_" + name, lambda *args, value=value, **kw: deepcopy(value))


def test_preserve_all_activities_and_seconds():
    payload = {"row_headers": HEADERS, "rows": [[i, 1, 1, f"app{i}", "Other", 0] for i in range(12)]}
    rows = rescuetime.parse_activities(payload)
    assert len(rows) == 12
    assert sum(row["min"] for row in rows) == pytest.approx(0.2)


@pytest.mark.parametrize("seconds", [float("nan"), float("inf"), -5, True, "bad"])
def test_invalid_durations_are_ignored(seconds):
    assert rescuetime.parse_activities({"rows": [[1, seconds, 1, "bad", "Other", 0]]}) == []


def test_fetch_detail_uses_headers_and_validated_query():
    calls = []
    def transport(method, url, headers, body):
        calls.append((method, url, headers))
        return 200, HOURLY
    rescuetime.fetch_hourly("secret", DAY, transport=transport)
    method, url, headers = calls[0]
    query = parse_qs(urlparse(url).query)
    assert method == "GET" and headers["Authorization"] == "Bearer secret"
    assert "secret" not in url and query["resolution_time"] == ["hour"]
    assert query["perspective"] == ["interval"]
    with pytest.raises(ValueError):
        rescuetime.fetch_documents("secret", "not-a-date", transport=transport)
    assert len(calls) == 1


def test_errors_do_not_echo_credentials_or_remote_body():
    with pytest.raises(rescuetime.RescueTimeError) as error:
        rescuetime.fetch_activities("secret", DAY, transport=lambda *a: (403, {"error": "secret echoed"}))
    assert error.value.status == 403
    assert "secret" not in str(error.value)


def test_detail_parses_by_column_names_and_keeps_titles_as_text():
    assert rescuetime.parse_hourly(HOURLY)[0] == {
        "date": DAY, "hour": 9, "name": "Editor", "min": 2,
        "category": "Development", "productivity": 2,
    }
    assert rescuetime.parse_documents(DOCUMENTS)[0] == {
        "name": "example.com", "title": "A page title", "min": 1.5,
        "category": "Reference", "productivity": 1,
    }
    shuffled = {"row_headers": ["Document", "Activity", "Time Spent (seconds)", "Productivity", "Category"],
                "rows": [["<script>unsafe</script>", "site", 10, -2, "Video"]]}
    assert rescuetime.parse_documents(shuffled)[0]["title"] == "<script>unsafe</script>"
    with pytest.raises(ValueError):
        rescuetime.parse_documents({"error": "not a report"})


def test_sync_backfills_previously_capped_rows(monkeypatch):
    fake_reports(monkeypatch)
    monkeypatch.setattr(rescuetime, "fetch_daily_summary", lambda key: [{"date": DAY, "total_hours": 2}])
    data = journal._empty()
    journal.set_entry_rescuetime(data, DAY, {"pulse": 80, "total_min": 120, "top_activities": [{"name": "old", "min": 120}]}, now=NOW)
    provider_sync.rescuetime_sync(connected(), data, now=NOW + timedelta(days=2))
    value = journal.get_entry_by_date(data, DAY)["rescuetime"]
    assert value["activity_version"] == 2
    assert value["pulse"] == 80
    assert len(value["top_activities"]) == 2


def test_sync_queries_today_and_focus_outside_summary_feed(monkeypatch):
    calls = []
    monkeypatch.setattr(rescuetime, "fetch_daily_summary", lambda key: [])
    monkeypatch.setattr(rescuetime, "fetch_activities", lambda key, date: calls.append(date) or ACTIVITIES)
    data = journal._empty()
    result = provider_sync.rescuetime_sync(connected(), data, focus_date="2026-08-01", now=NOW)
    assert set(calls) == {"2026-09-19", "2026-08-01"}
    assert set(result["synced"]) == set(calls)
    for date in calls:
        value = journal.get_entry_by_date(data, date)["rescuetime"]
        assert value["total_min"] == pytest.approx(140 / 60)
        assert value["productive_min"] == 2 and value["pulse"] is None
        assert value["unrated_min"] == pytest.approx(20 / 60)


def test_refreshing_old_detail_preserves_official_summary(monkeypatch):
    fake_reports(monkeypatch)
    monkeypatch.setattr(rescuetime, "fetch_daily_summary", lambda key: [])
    data = journal._empty()
    journal.set_entry_rescuetime(data, "2026-08-01", {
        "pulse": 85, "total_min": 180, "productive_min": 150,
    }, now=NOW)
    provider_sync.rescuetime_sync(connected(), data, focus_date="2026-08-01", now=NOW)
    result = journal.get_entry_by_date(data, "2026-08-01")["rescuetime"]
    assert result["pulse"] == 85 and result["total_min"] == 180
    assert result["activity_version"] == 2


def test_detail_cache_preserves_success_on_partial_failure(monkeypatch):
    fake_reports(monkeypatch)
    data = connected()
    first = provider_sync.rescuetime_detail(data, DAY, now=NOW)
    assert first["reports"]["documents"]["rows"][0]["title"] == "A page title"
    def forbidden(*args, **kwargs):
        raise rescuetime.RescueTimeError(403)
    monkeypatch.setattr(rescuetime, "fetch_documents", forbidden)
    cached = provider_sync.rescuetime_detail(data, DAY, now=NOW + timedelta(minutes=1))
    assert cached["reports"]["documents"]["status"] == "ok"
    refreshed = provider_sync.rescuetime_detail(data, DAY, force=True, now=NOW + timedelta(minutes=2))
    assert refreshed["reports"]["activities"]["status"] == "ok"
    assert refreshed["reports"]["documents"]["status"] == "unavailable"
    assert refreshed["reports"]["documents"]["rows"] == first["reports"]["documents"]["rows"]
    assert refreshed["reports"]["documents"]["fetched"] == NOW.isoformat()
    assert refreshed["reports"]["documents"]["message"]


def test_invalid_report_never_replaces_cached_rows(monkeypatch):
    fake_reports(monkeypatch)
    data = connected()
    first = provider_sync.rescuetime_detail(data, DAY, now=NOW)
    monkeypatch.setattr(rescuetime, "fetch_hourly", lambda *a: {"error": "invalid"})
    second = provider_sync.rescuetime_detail(data, DAY, force=True, now=NOW)
    assert second["reports"]["hourly"]["rows"] == first["reports"]["hourly"]["rows"]
    assert second["reports"]["hourly"]["status"] == "error"


def test_hourly_totals_include_unrated_and_no_nested_double_count():
    rows = rescuetime.parse_hourly(HOURLY)
    rows.append({"hour": 9, "min": 0.5, "productivity": None})
    bins = journal.rescuetime_hourly_totals(rows)
    assert len(bins) == 24
    assert bins[9] == {"hour": 9, "productive_min": 2, "neutral_min": 0,
                       "distracting_min": 0, "unrated_min": 0.5, "total_min": 2.5}


@pytest.fixture
def app(tmp_path):
    app = app_module.app
    app.config.update(TESTING=True, DATA_FILE=str(tmp_path / "tasks.json"),
                      JOURNAL_FILE=str(tmp_path / "journal.json"),
                      INTEGRATIONS_FILE=str(tmp_path / "integrations.json"))
    todo.save(app.config["DATA_FILE"], todo._empty())
    journal.save(app.config["JOURNAL_FILE"], journal._empty())
    integrations.save(app.config["INTEGRATIONS_FILE"], connected())
    return app


def test_detail_route_isolated_validated_and_persisted(app, monkeypatch):
    fake_reports(monkeypatch)
    client = app.test_client()
    assert client.post("/integrations/rescuetime/detail?date=bad").status_code == 400
    response = client.post("/integrations/rescuetime/detail?date=" + DAY)
    assert response.status_code == 200 and response.json["connected"]
    assert response.json["reports"]["hourly"]["rows"][0]["hour"] == 9
    saved = integrations.load(app.config["INTEGRATIONS_FILE"])
    assert DAY in integrations.get_analytics(saved, "rescuetime")["days"]
    assert not journal.load(app.config["JOURNAL_FILE"])["entries"]


def test_detail_disconnect_during_fetch_discards_response(app, monkeypatch):
    fake_reports(monkeypatch)
    def disconnected(*args):
        current = integrations.load(app.config["INTEGRATIONS_FILE"])
        integrations.clear_provider(current, "rescuetime")
        integrations.save(app.config["INTEGRATIONS_FILE"], current)
        return ACTIVITIES
    monkeypatch.setattr(rescuetime, "fetch_activities", disconnected)
    body = app.test_client().post("/integrations/rescuetime/detail?date=" + DAY).json
    assert body["connected"] is False and not body.get("reports")
    assert not integrations.get_analytics(integrations.load(app.config["INTEGRATIONS_FILE"]), "rescuetime")


def test_changing_api_key_clears_private_detail_cache():
    data = connected()
    integrations.set_analytics(data, "rescuetime", {"days": {DAY: {"private": "old account"}}})
    integrations.set_last_sync(data, "rescuetime", NOW.isoformat())
    integrations.set_api_key(data, "rescuetime", "replacement")
    assert not integrations.get_analytics(data, "rescuetime")
    assert integrations.last_sync(data, "rescuetime") is None


def test_daily_time_series_preserves_unrated_minutes():
    assert journal.rescuetime_time_series([{"date": DAY, "rescuetime": {
        "total_min": 3, "productive_min": 2, "unrated_min": 1,
    }}]) == [{"date": DAY, "productive_min": 2, "distracting_min": 0,
              "neutral_min": 0, "unrated_min": 1}]


def test_final_summary_replaces_provisional_unrated_time(monkeypatch):
    fake_reports(monkeypatch)
    monkeypatch.setattr(rescuetime, "fetch_daily_summary", lambda key: [{
        "date": DAY, "total_hours": 1, "neutral_hours": 1, "productivity_pulse": 50,
    }])
    data = journal._empty()
    journal.set_entry_rescuetime(data, DAY, {
        "total_min": 60, "unrated_min": 60, "summary_source": "activities",
    }, now=NOW)
    provider_sync.rescuetime_sync(connected(), data, now=NOW)
    result = journal.get_entry_by_date(data, DAY)["rescuetime"]
    assert result["neutral_min"] == 60 and result["unrated_min"] == 0


@pytest.mark.parametrize("invalid", [
    {"row_headers": ["Error"], "rows": [["unexpected response"]]},
    {"row_headers": HEADERS, "rows": [[1]]},
])
def test_malformed_activity_report_preserves_cache(monkeypatch, invalid):
    fake_reports(monkeypatch)
    data = connected()
    first = provider_sync.rescuetime_detail(data, DAY, now=NOW)
    monkeypatch.setattr(rescuetime, "fetch_activities", lambda *a: invalid)
    refreshed = provider_sync.rescuetime_detail(data, DAY, force=True, now=NOW)
    assert refreshed["reports"]["activities"]["status"] == "error"
    assert refreshed["reports"]["activities"]["rows"] == first["reports"]["activities"]["rows"]


def test_analytics_exposes_connection_without_credentials(app):
    payload = app.test_client().get("/journal/analytics/data").json
    assert payload["rescuetime_connected"] is True
    assert "synthetic" not in str(payload)
    integrations.save(app.config["INTEGRATIONS_FILE"], integrations._empty())
    assert app.test_client().get("/journal/analytics/data").json["rescuetime_connected"] is False
