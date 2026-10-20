from datetime import datetime, timezone
import pytest
from datapom.domain import places


def test_device_origin_survives_sync_and_independent_routes(tmp_path):
    rows = [dict(sample(minute), source_device="phone") for minute in (0, 5, 10, 15)]
    laptop = [dict(row, id="laptop-" + row["id"], source_device="laptop", lon=row["lon"] + .05) for row in rows]
    places.append_samples(tmp_path, rows + laptop)
    saved = places.load_samples(tmp_path)
    assert {row["source_device"] for row in saved} == {"phone", "laptop"}
    phone_day = places.day_summary(rows + laptop, [])
    laptop_day = places.day_summary(rows + laptop, [], source_device="laptop")
    assert phone_day["source_device"] == "phone"
    assert laptop_day["source_device"] == "laptop"
    assert len(phone_day["samples"]) == len(laptop_day["samples"]) == 4
    assert phone_day["summary"]["recorded_seconds"] == laptop_day["summary"]["recorded_seconds"] == 900
    assert len(phone_day["routes"]) == len(laptop_day["routes"]) == 1
    assert places.clean_sample(sample(0)).get("source_device") is None
    with pytest.raises(ValueError):
        places.clean_sample(dict(sample(0), source_device="other"))


def sample(minute, lon=121.5, accuracy=10, session="one"):
    return {"id": str(minute) + session, "at": f"2026-09-08T12:{minute:02}:00+08:00",
            "lat": 31.2, "lon": lon, "accuracy_m": accuracy, "session": session}


HOME = {"id": "home", "name": "Home", "lat": 31.2, "lon": 121.5, "radius_m": 100}


def test_distance_and_radius_match():
    assert places.distance_m(31.2, 121.5, 31.2, 121.5) == 0
    assert places.match_place(sample(0), [HOME])["id"] == "home"
    assert places.match_place(sample(0, lon=122), [HOME]) is None
    assert places.match_place(sample(0, accuracy=1000), [HOME]) is None


def test_ten_minute_visit_with_arrival_departure_estimates():
    visits = places.visits([sample(0), sample(2), sample(10), sample(12, lon=121.51)], [HOME])
    assert len(visits) == 1
    assert visits[0]["place_id"] == "home"
    assert visits[0]["duration_seconds"] == 600
    assert visits[0]["estimated"] is True
    assert visits[0]["departure_after"] == sample(10)["at"]
    assert visits[0]["departure_before"] == sample(12)["at"]


def test_pass_by_and_large_gaps_do_not_invent_stays():
    assert places.visits([sample(0), sample(1), sample(2, lon=122)], [HOME]) == []
    assert places.visits([sample(0), sample(30)], [HOME]) == []
    assert places.visits([sample(0), sample(10, session="two")], [HOME]) == []


def test_smallest_matching_place_wins_over_parent_city():
    city = {**HOME, "id": "city", "radius_m": 30000}
    assert places.match_place(sample(0), [city, HOME])["id"] == "home"


def test_append_is_idempotent_and_retains_all_history(tmp_path):
    places.append_samples(tmp_path, [sample(0), sample(2)])
    places.append_samples(tmp_path, [sample(0)])
    assert len(places.load_samples(tmp_path)) == 2
    with pytest.raises(ValueError):
        places.append_samples(tmp_path, [{**sample(4), "lat": 95}])
    assert len(places.load_samples(tmp_path)) == 2


def test_date_filter_uses_recorded_local_date(tmp_path):
    places.append_samples(tmp_path, [{**sample(0), "at": "2026-09-08T00:02:00+08:00"}])
    assert len(places.load_samples(tmp_path, "2026-09-08", "2026-09-08")) == 1
    assert places.load_samples(tmp_path, "2026-09-07", "2026-09-07") == []


def test_unknown_stop_uses_fixed_anchor_not_a_moving_walk():
    stop = places.visits([sample(0), sample(3, lon=121.5002), sample(10, lon=121.5003), sample(12, lon=121.51)], [])
    assert len(stop) == 1
    assert stop[0]["place_id"] is None
    assert stop[0]["name"] == "Unsaved place"
    assert stop[0]["duration_seconds"] == 600
    assert stop[0]["lon"] == 121.5
    assert places.visits([sample(0), sample(2, lon=121.5008), sample(4, lon=121.5016), sample(6, lon=121.5024)], []) == []


def test_unknown_stop_rejects_inaccurate_fixes_and_session_gaps():
    assert places.visits([sample(0), sample(10, accuracy=5000)], []) == []
    assert places.visits([sample(0), sample(30)], []) == []
    assert places.visits([sample(0), sample(10, session="two")], []) == []


def test_city_labels_a_stop_without_turning_travel_into_a_visit():
    city = {**HOME, "id": "shanghai", "name": "Shanghai", "radius_m": 30000, "is_city": True}
    stop = places.visits([sample(0), sample(10), sample(12, lon=121.51)], [city])
    assert len(stop) == 1
    assert stop[0]["place_id"] is None
    assert stop[0]["city_id"] == "shanghai"
    assert stop[0]["name"] == "Unsaved place · Shanghai"
    assert places.visits([sample(0), sample(3, lon=121.51), sample(6, lon=121.52)], [city]) == []


def test_inaccurate_sample_does_not_claim_a_departure():
    stop = places.visits([sample(0), sample(10), sample(12, accuracy=2000)], [HOME])
    assert stop[0]["departure_before"] is None


def test_tracking_manifest_changes_only_with_changed_days(tmp_path):
    places.append_samples(tmp_path, [sample(0)])
    original = places.manifest(tmp_path)
    assert original[0]["date"] == "2026-09-08"
    assert original[0]["bytes"] > 0 and len(original[0]["sha256"]) == 64
    places.append_samples(tmp_path, [sample(0)])
    assert places.manifest(tmp_path) == original
    places.append_samples(tmp_path, [sample(5)])
    assert places.manifest(tmp_path)[0]["sha256"] != original[0]["sha256"]


def test_corrupt_day_is_preserved_and_does_not_hide_other_history(tmp_path):
    (tmp_path / "2026-09-07.json").write_text("corrupt day")
    places.append_samples(tmp_path, [sample(0)])
    assert len(places.load_samples(tmp_path)) == 1
    assert (tmp_path / "2026-09-07.json.bak").read_text() == "corrupt day"


def test_malformed_observation_is_a_validation_error():
    with pytest.raises(ValueError):
        places.clean_sample(None)


def test_duration_totals_combine_repeat_visits_without_merging_distant_stops():
    rows = [
        {"place_id": "home", "name": "Home", "lat": 31.2, "lon": 121.5, "duration_seconds": 300},
        {"place_id": "home", "name": "Home", "lat": 31.2, "lon": 121.5, "duration_seconds": 600},
        {"place_id": None, "name": "Unsaved place", "lat": 31.3, "lon": 121.5, "duration_seconds": 300},
        {"place_id": None, "name": "Unsaved place", "lat": 31.3, "lon": 121.5002, "duration_seconds": 300},
        {"place_id": None, "name": "Unsaved place", "lat": 31.4, "lon": 121.5, "duration_seconds": 300},
    ]
    totals = places.duration_totals(rows)
    assert [(r["duration_seconds"], r["visits"]) for r in totals] == [(900, 2), (600, 2), (300, 1)]
    assert totals[1]["lat"] == 31.3


def test_archive_is_lossless_receipt_stable_and_late_samples_stay_compressed(tmp_path):
    rows = [sample(n) for n in range(30)]
    places.append_samples(tmp_path, rows, now=datetime(2026, 9, 8, tzinfo=timezone.utc))
    before = places.load_samples(tmp_path)
    receipt = places.manifest(tmp_path)
    assert places.archive_samples(tmp_path, now=datetime(2026, 9, 9, tzinfo=timezone.utc)) == ["2026-09-08"]
    assert not (tmp_path / "2026-09-08.json").exists()
    assert (tmp_path / "2026-09-08.json.gz").stat().st_size < receipt[0]["bytes"]
    assert places.load_samples(tmp_path) == before
    assert places.manifest(tmp_path) == receipt
    places.append_samples(tmp_path, [sample(30)])
    assert len(places.load_samples(tmp_path)) == 31
    assert not (tmp_path / "2026-09-08.json").exists()
    assert places.archive_samples(tmp_path, now=datetime(2026, 9, 9, tzinfo=timezone.utc)) == []


def test_archive_leaves_today_and_preserves_corrupt_compressed_bytes(tmp_path):
    places.append_samples(tmp_path, [sample(0)], now=datetime(2026, 9, 8, tzinfo=timezone.utc))
    assert places.archive_samples(tmp_path, now=datetime(2026, 9, 8, tzinfo=timezone.utc)) == []
    broken = tmp_path / "2026-09-07.json.gz"
    broken.write_bytes(b"not gzip")
    assert len(places.load_samples(tmp_path)) == 1
    assert (tmp_path / "2026-09-07.json.gz.bak").read_bytes() == b"not gzip"


def test_immutable_ids_cannot_move_dates_even_when_history_is_compressed(tmp_path):
    places.append_samples(tmp_path, [sample(0)])
    places.archive_samples(tmp_path, now=datetime(2026, 9, 9, tzinfo=timezone.utc))
    with pytest.raises(ValueError, match="ID already"):
        places.append_samples(tmp_path, [{**sample(0), "at": "2026-09-09T12:00:00+08:00"}])
    with pytest.raises(ValueError, match="ID already"):
        places.append_samples(tmp_path, [sample(5), {**sample(5), "lon": 121.6}])
    assert len(places.load_samples(tmp_path)) == 1


def test_optional_measured_motion_survives_roundtrip(tmp_path):
    row = {**sample(0), "speed_mps": 83.3, "speed_accuracy_mps": 0.5, "bearing": 270, "provider": "gps", "mode": "precise"}
    places.append_samples(tmp_path, [row])
    assert {k: places.load_samples(tmp_path)[0][k] for k in row} == row
    for key, value in [("speed_mps", -1), ("speed_accuracy_mps", float("nan")), ("bearing", 360)]:
        with pytest.raises(ValueError):
            places.clean_sample({**row, key: value})


def test_append_automatically_archives_past_days_but_keeps_current_day_plain(tmp_path):
    places.append_samples(tmp_path, [sample(0)], now=datetime(2026, 9, 8, tzinfo=timezone.utc))
    assert (tmp_path / "2026-09-08.json").exists()
    today = {**sample(5), "at": "2026-09-09T12:05:00+08:00"}
    places.append_samples(tmp_path, [today], now=datetime(2026, 9, 9, tzinfo=timezone.utc))
    assert not (tmp_path / "2026-09-08.json").exists()
    assert (tmp_path / "2026-09-08.json.gz").exists()
    assert (tmp_path / "2026-09-09.json").exists()
    assert len(places.load_samples(tmp_path)) == 2


def day_fixture():
    return [{**sample(0), "mode": "precise"}, sample(5, lon=121.50002), sample(10),
            {**sample(11, lon=121.5008), "speed_mps": 1.2},
            {**sample(12, lon=121.5038), "speed_mps": 4.8},
            {**sample(13, lon=121.5138), "speed_mps": 15},
            sample(14, lon=121.52, accuracy=500), sample(15, lon=121.521),
            sample(16, lon=121.522, session="two"), sample(35, lon=121.53)]


def test_daily_route_replay_respects_gaps_and_motion_uncertainty():
    day = places.day_summary(day_fixture(), [HOME], "2026-09-08")
    assert day["summary"]["recorded_seconds"] == 780
    assert day["summary"]["stop_seconds"] == 600
    assert day["summary"]["stay_count"] == 1
    assert day["summary"]["distance_m"] > 1000
    assert [r["mode"] for r in day["segments"]] == ["stationary", "stationary", "walking", "cycling", "vehicle"]
    assert len(day["routes"]) == 4
    at = places.position_at(day, 12 * 60 + 11.5)
    assert at["transport"] == "cycling"
    assert at["lon"] == pytest.approx(121.5023)
    assert places.position_at(day, 12 * 60 + 14) is None
    assert places.position_at(day, 12 * 60 + 15.5) is None
    assert places.position_at(day, 12 * 60 + 25) is None
    assert places.day_summary([], [], "2026-09-08")["summary"]["avg_moving_speed_mps"] is None


def test_jitter_does_not_accumulate_and_teleports_do_not_make_routes():
    jitter = [sample(n, lon=121.5 + (n % 2) * 0.00003) for n in range(12)]
    day = places.day_summary(jitter, [], "2026-09-08")
    assert day["summary"]["distance_m"] == 0
    assert day["summary"]["moving_seconds"] == 0
    assert day["visits"][0]["duration_seconds"] == 660
    jump = places.day_summary([sample(0), sample(1, lon=-122), sample(2)], [], "2026-09-08")
    assert jump["segments"] == []
    assert places.position_at(jump, 720.5) is None


def test_small_precise_steps_keep_measured_walking_and_fast_rail_is_retained():
    walk = places.day_summary([sample(0), {**sample(1, lon=121.50007), "at": "2026-09-08T12:00:05+08:00", "speed_mps": 1.3}], [], "2026-09-08")
    assert walk["segments"][0]["mode"] == "walking"
    assert walk["summary"]["distance_m"] > 5
    rail = places.day_summary([sample(0), {**sample(1, lon=121.552), "speed_mps": 83.3}], [], "2026-09-08")
    assert rail["segments"][0]["mode"] == "vehicle"
    assert rail["summary"]["distance_m"] > 4500


def test_invalid_fixes_break_coverage_and_hour_bins_split_observed_intervals():
    bad = places.day_summary([sample(0), {**sample(1), "lat": 99}, sample(2)], [], "2026-09-08")
    assert bad["segments"] == []
    rows = [{**sample(0), "at": "2026-09-08T12:58:00+08:00"},
            {**sample(1), "at": "2026-09-08T13:03:00+08:00"}]
    day = places.day_summary(rows, [], "2026-09-08")
    assert day["hourly"][12]["recorded_seconds"] == 120
    assert day["hourly"][13]["recorded_seconds"] == 180
    compact = {key: day[key] for key in ("date", "summary", "visits", "hourly")}
    assert places.aggregate_days([compact]) == places.aggregate_days([day])


def test_repeated_clock_hour_is_ambiguous_but_explicit_offset_photo_is_not():
    rows = [{**sample(0), "at": "2026-11-01T01:00:00-04:00"},
            {**sample(5), "at": "2026-11-01T01:05:00-04:00"},
            {**sample(10, session="two"), "at": "2026-11-01T01:00:00-05:00"},
            {**sample(15, session="two"), "at": "2026-11-01T01:05:00-05:00"}]
    day = places.day_summary(rows, [], "2026-11-01")
    assert places.position_at(day, 62) is None
    assert places.photo_location({"id": "photo", "captured_at": "2026-11-01T01:02:00"}, day) is None
    assert places.photo_location({"id": "photo", "captured_at": "2026-11-01T01:02:00-04:00"}, day)


def test_photo_matching_keeps_gps_and_only_infers_with_recorded_time_coverage():
    day = places.day_summary(day_fixture(), [], "2026-09-08")
    gps = {"id": "photo", "location": {"lat": 30, "lon": 120}, "captured_at": None}
    assert places.photo_location(gps, day)["source"] == "gps"
    inferred = places.photo_location({"id": "photo", "captured_at": "2026-09-08T12:11:30"}, day)
    assert inferred["source"] == "route" and inferred["estimated"]
    assert inferred["lon"] == pytest.approx(121.5023)
    assert places.photo_location({"id": "photo", "captured_at": "2026-09-08T12:11:30+08:00"}, day)["lon"] == inferred["lon"]
    assert places.photo_location({"id": "photo", "captured_at": "2026-09-08T12:14:00"}, day) is None
    assert places.photo_location({"id": "photo", "captured_at": "2026-09-07T12:11:30"}, day) is None
    assert places.photo_location({"id": "photo", "captured_at": None}, day) is None


def test_daily_analytics_aggregates_only_observed_intervals():
    rows = day_fixture() + [{**r, "id": r["id"] + "next", "at": r["at"].replace("2026-09-08", "2026-09-09")} for r in day_fixture()]
    analytics = places.location_analytics(rows, [HOME])
    assert analytics["summary"]["days_tracked"] == 2
    assert analytics["summary"]["recorded_seconds"] == 1560
    assert analytics["place_totals"][0]["duration_seconds"] == 1200
    assert analytics["hourly"][12]["recorded_seconds"] == 1560
    assert sum(row["recorded_seconds"] for row in analytics["dow"]) == 1560


def test_history_analytics_matches_memory_aggregates_and_filters_recorded_dates(tmp_path):
    rows = day_fixture() + [{**r, "id": r["id"] + "next", "at": r["at"].replace("2026-09-08", "2026-09-09")} for r in day_fixture()]
    places.append_samples(tmp_path, rows, now=datetime(2026, 9, 9, tzinfo=timezone.utc))
    assert places.history_analytics(tmp_path, [HOME]) == places.location_analytics(rows, [HOME])
    assert places.history_analytics(tmp_path, [HOME], "2026-09-08", "2026-09-08") == places.location_analytics(day_fixture(), [HOME])
    assert places.history_analytics(tmp_path, [HOME], "2026-09-10") == places.aggregate_days([])
    assert places.history_analytics(tmp_path, [HOME], end="2026-09-07") == places.aggregate_days([])


def test_history_analytics_retains_only_compact_days_and_skips_invalid_only_days(tmp_path, monkeypatch):
    places.append_samples(tmp_path, day_fixture(), now=datetime(2026, 9, 9, tzinfo=timezone.utc))
    places.append_samples(tmp_path, [{**sample(0), "id": "poor", "at": "2026-09-09T12:00:00+08:00", "accuracy_m": 500}], now=datetime(2026, 9, 9, tzinfo=timezone.utc))
    original = places.aggregate_days
    def inspect(days):
        assert len(days) == 1
        assert set(days[0]) == {"date", "summary", "visits", "hourly"}
        return original(days)
    monkeypatch.setattr(places, "aggregate_days", inspect)
    def disallow_bulk_load(*args, **kwargs):
        pytest.fail("History analytics must load one date at a time")
    monkeypatch.setattr(places, "load_samples", disallow_bulk_load)
    result = places.history_analytics(tmp_path, [HOME])
    assert result["summary"]["days_tracked"] == 1
    assert [day["date"] for day in result["days"]] == ["2026-09-08"]


def test_python_and_javascript_daily_analysis_agree():
    import json
    from pathlib import Path
    import shutil
    import subprocess
    node = shutil.which("node")
    if not node:
        pytest.skip("Node unavailable")
    photos = [{"id": "gps", "location": {"lat": 31, "lon": 121}},
              {"id": "route", "captured_at": "2026-09-08T12:11:30"}]
    payload = {"date": "2026-09-08", "samples": day_fixture(), "places": [HOME], "photos": photos}
    script = "const L=require('./static/location-day.js');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{const d=JSON.parse(s);console.log(JSON.stringify(L.analyze(d.date,d.samples,d.places,d.photos)));});"
    result = subprocess.run([node, "-e", script], cwd=Path(__file__).resolve().parents[1], input=json.dumps(payload), text=True, capture_output=True, check=True)
    assert json.loads(result.stdout) == places.day_summary(day_fixture(), [HOME], payload["date"], photos)
    payload["samples"] += [{**r, "id": r["id"] + "next", "at": r["at"].replace("2026-09-08", "2026-09-09")} for r in day_fixture()]
    aggregate_script = "const L=require('./static/location-day.js');let s='';process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>{const d=JSON.parse(s);console.log(JSON.stringify(L.aggregate(['2026-09-08','2026-09-09'].map(date=>L.analyze(date,d.samples,d.places)))));});"
    result = subprocess.run([node, "-e", aggregate_script], cwd=Path(__file__).resolve().parents[1], input=json.dumps(payload), text=True, capture_output=True, check=True)
    assert json.loads(result.stdout) == places.location_analytics(payload["samples"], [HOME])
