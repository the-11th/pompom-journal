"""Tests for usage.py — the pure phone-usage parse/aggregate module.

Mirrors the RescueTime test style: fixed `now`, no network, defensive parse
cases, and each aggregation helper over empty/sparse/normal data.
"""
from datetime import datetime

from datapom.integrations import usage

NOW = datetime(2026, 7, 7, 2, 5, 0)

# A well-formed single-day push payload from the phone worker.
DAY = {
    "date": "2026-07-06",
    "screen_min": 312,
    "unlocks": 87,
    "top_apps": [
        {"name": "com.instagram.android", "label": "Instagram", "min": 74, "opens": 41},
        {"name": "com.google.android.youtube", "label": "YouTube", "min": 63, "opens": 19},
    ],
    "first_use": "07:42",
    "last_use": "23:15",
}


# --------------------------------------------------------------------------- #
# parse_push
# --------------------------------------------------------------------------- #

def test_parse_push_single_dict_returns_list():
    out = usage.parse_push(DAY, now=NOW)
    assert isinstance(out, list) and len(out) == 1
    u = out[0]
    assert u["date"] == "2026-07-06"
    assert u["screen_min"] == 312
    assert u["unlocks"] == 87
    assert u["first_use"] == "07:42" and u["last_use"] == "23:15"
    assert u["source"] == "phone"
    assert u["fetched"] == "2026-07-07T02:05:00"


def test_parse_push_list_returns_multiple_days():
    d2 = dict(DAY, date="2026-07-05", screen_min=201)
    out = usage.parse_push([DAY, d2], now=NOW)
    assert [u["date"] for u in out] == ["2026-07-06", "2026-07-05"]
    assert out[1]["screen_min"] == 201


def test_parse_push_top_apps_sorted_and_capped():
    apps = [{"name": f"app{i}", "label": f"L{i}", "min": i} for i in range(12)]
    out = usage.parse_push(dict(DAY, top_apps=apps), now=NOW)[0]
    assert len(out["top_apps"]) == 8            # capped at 8
    mins = [a["min"] for a in out["top_apps"]]
    assert mins == sorted(mins, reverse=True)   # sorted desc
    assert out["top_apps"][0]["min"] == 11


def test_parse_push_clamps_negatives_and_coerces_types():
    out = usage.parse_push({
        "date": "2026-07-06",
        "screen_min": "-5",
        "unlocks": -10,
        "top_apps": [{"name": "x", "label": "X", "min": "-3", "opens": "-7"}],
    }, now=NOW)[0]
    assert out["screen_min"] == 0
    assert out["unlocks"] == 0
    # negative-minute app is clamped to 0 (still kept)
    assert out["top_apps"][0]["min"] == 0
    # negative opens clamped to 0
    assert out["top_apps"][0]["opens"] == 0


def test_parse_push_opens_present_and_missing():
    out = usage.parse_push({
        "date": "2026-07-06", "screen_min": 100,
        "top_apps": [
            {"name": "a", "label": "A", "min": 30, "opens": "12.7"},  # coerced/rounded
            {"name": "b", "label": "B", "min": 20},                   # missing -> 0
        ],
    }, now=NOW)[0]
    by_name = {a["name"]: a for a in out["top_apps"]}
    assert by_name["a"]["opens"] == 13
    assert by_name["b"]["opens"] == 0


def test_parse_push_label_falls_back_to_name():
    out = usage.parse_push({
        "date": "2026-07-06", "screen_min": 10,
        "top_apps": [{"name": "com.foo.bar", "min": 5}],
    }, now=NOW)[0]
    assert out["top_apps"][0]["label"] == "com.foo.bar"


def test_parse_push_missing_date_skipped():
    out = usage.parse_push([DAY, {"screen_min": 100}], now=NOW)
    assert [u["date"] for u in out] == ["2026-07-06"]


def test_parse_push_invalid_date_skipped():
    out = usage.parse_push({"date": "not-a-date", "screen_min": 100}, now=NOW)
    assert out == []


def test_parse_push_malformed_top_apps_ignored():
    out = usage.parse_push({
        "date": "2026-07-06", "screen_min": 10,
        "top_apps": "garbage",
    }, now=NOW)[0]
    assert out["top_apps"] == []


def test_parse_push_none_or_junk_payload():
    assert usage.parse_push(None, now=NOW) == []
    assert usage.parse_push("nope", now=NOW) == []
    assert usage.parse_push(42, now=NOW) == []


def test_parse_push_missing_times_default_none():
    out = usage.parse_push({"date": "2026-07-06", "screen_min": 10}, now=NOW)[0]
    assert out["first_use"] is None and out["last_use"] is None


# --------------------------------------------------------------------------- #
# aggregation helpers
# --------------------------------------------------------------------------- #

def _entry(date, usage_dict=None, mood=None):
    return {"date": date, "usage": usage_dict, "mood": mood}


def _u(screen_min=100, unlocks=50, top_apps=None):
    return {
        "date": "x", "screen_min": screen_min, "unlocks": unlocks,
        "top_apps": top_apps or [], "first_use": None, "last_use": None,
        "source": "phone", "fetched": "x",
    }


def test_entry_usage_usable_and_unusable():
    assert usage._entry_usage(_entry("d", _u(screen_min=100))) is not None
    assert usage._entry_usage(_entry("d", _u(screen_min=0, top_apps=[{"name": "a", "min": 5}]))) is not None
    assert usage._entry_usage(_entry("d", _u(screen_min=0, top_apps=[]))) is None
    assert usage._entry_usage(_entry("d", None)) is None
    assert usage._entry_usage(_entry("d", "junk")) is None


def test_usage_minutes_series():
    entries = [_entry("2026-07-05", _u(screen_min=200)),
               _entry("2026-07-06", _u(screen_min=300)),
               _entry("2026-07-07", None)]
    out = usage.usage_minutes_series(entries)
    assert out == [{"date": "2026-07-05", "screen_min": 200},
                   {"date": "2026-07-06", "screen_min": 300}]


def test_usage_minutes_series_date_bounds():
    entries = [_entry("2026-07-01", _u(screen_min=100)),
               _entry("2026-07-06", _u(screen_min=300))]
    out = usage.usage_minutes_series(entries, start="2026-07-05", end="2026-07-07")
    assert out == [{"date": "2026-07-06", "screen_min": 300}]


def test_usage_unlocks_series():
    entries = [_entry("2026-07-06", _u(unlocks=80)),
               _entry("2026-07-05", _u(unlocks=40))]
    out = usage.usage_unlocks_series(entries)
    assert out == [{"date": "2026-07-05", "unlocks": 40},
                   {"date": "2026-07-06", "unlocks": 80}]


def test_usage_top_apps_aggregated_sorted_capped():
    entries = [
        _entry("2026-07-05", _u(top_apps=[
            {"name": "ig", "label": "Instagram", "min": 30, "opens": 10}])),
        _entry("2026-07-06", _u(top_apps=[
            {"name": "ig", "label": "Instagram", "min": 40, "opens": 15},
            {"name": "yt", "label": "YouTube", "min": 60, "opens": 5}])),
    ]
    out = usage.usage_top_apps(entries)
    assert out[0] == {"name": "ig", "label": "Instagram", "min": 70, "opens": 25}
    assert out[1] == {"name": "yt", "label": "YouTube", "min": 60, "opens": 5}
    assert len(out) <= 8


def test_usage_top_apps_opens_default_zero():
    # apps parsed from old data have no "opens" key -> aggregates to 0.
    entries = [_entry("2026-07-05", _u(top_apps=[{"name": "ig", "label": "IG", "min": 30}]))]
    out = usage.usage_top_apps(entries)
    assert out[0] == {"name": "ig", "label": "IG", "min": 30, "opens": 0}


def test_usage_app_minutes_series_shape_topn_and_zerofill():
    entries = [
        _entry("2026-07-05", _u(top_apps=[
            {"name": "ig", "label": "Instagram", "min": 30, "opens": 5},
            {"name": "yt", "label": "YouTube", "min": 10, "opens": 2}])),
        _entry("2026-07-06", _u(top_apps=[
            {"name": "ig", "label": "Instagram", "min": 40, "opens": 6},
            {"name": "sp", "label": "Spotify", "min": 25, "opens": 1}])),
        _entry("2026-07-07", None),  # no usable usage -> skipped
    ]
    out = usage.usage_app_minutes_series(entries, top_n=2)
    # top-2 apps by total minutes: ig (70), then sp (25) > yt (10)
    assert [a["name"] for a in out["apps"]] == ["ig", "sp"]
    assert out["apps"][0]["label"] == "Instagram"
    assert out["dates"] == ["2026-07-05", "2026-07-06"]
    # zero-fill: ig present both days; sp only on 07-06
    assert out["series"]["ig"] == [30, 40]
    assert out["series"]["sp"] == [0, 25]


def test_usage_app_minutes_series_empty():
    out = usage.usage_app_minutes_series([])
    assert out == {"apps": [], "dates": [], "series": {}}


def test_usage_dow_averages():
    # 2026-07-06 is a Monday, 2026-07-07 Tuesday.
    entries = [_entry("2026-07-06", _u(screen_min=200)),
               _entry("2026-07-07", _u(screen_min=100))]
    out = usage.usage_dow_averages(entries)
    assert out["Mon"] == 200
    assert out["Tue"] == 100
    assert out["Wed"] is None


def test_usage_mood_pairs_ignores_null_mood():
    entries = [_entry("2026-07-05", _u(screen_min=200), mood=5),
               _entry("2026-07-06", _u(screen_min=300), mood=None),
               _entry("2026-07-07", None, mood=4)]
    out = usage.usage_mood_pairs(entries)
    assert out == [{"screen_min": 200, "mood": 5}]


def test_usage_stats():
    entries = [_entry("2026-07-05", _u(screen_min=200, unlocks=40)),
               _entry("2026-07-06", _u(screen_min=300, unlocks=80))]
    s = usage.usage_stats(entries)
    assert s == {"avg_screen_min": 250, "avg_unlocks": 60, "days": 2}


def test_usage_stats_empty():
    assert usage.usage_stats([]) == {
        "avg_screen_min": None, "avg_unlocks": None, "days": 0}
