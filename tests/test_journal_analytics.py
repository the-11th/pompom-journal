"""Tests for the pure analytics aggregation helpers in journal.py.

Fixed dates for determinism; no file I/O needed (helpers take plain lists).
Entry fixtures mirror the real entry shape: date, tags {sid: [names]},
numbers {sid: float}, body, created.
"""

from datapom.domain import journal
from datetime import datetime


def _entry(date, tags=None, numbers=None, body="", created=None, mood=None):
    return {
        "id": date,  # id is irrelevant to aggregation; reuse the date
        "date": date,
        "title": "t",
        "body": body,
        "created": created or (date + "T09:00:00"),
        "tags": tags or {},
        "numbers": numbers or {},
        "mood": mood,
    }


# --------------------------------------------------------------------------- #
# _filter_entries_by_date + describe
# --------------------------------------------------------------------------- #

def test_filter_by_date_inclusive_bounds():
    entries = [_entry("2026-06-01"), _entry("2026-06-05"), _entry("2026-06-10")]
    got = journal._filter_entries_by_date(entries, "2026-06-05", "2026-06-10")
    assert [e["date"] for e in got] == ["2026-06-05", "2026-06-10"]


def test_filter_by_date_none_bounds_means_unbounded():
    entries = [_entry("2026-06-01"), _entry("2026-06-10")]
    assert journal._filter_entries_by_date(entries, None, None) == entries


def test_describe_basic_stats():
    d = journal.describe([1, 2, 2, 3, 4])
    assert d["mean"] == 2.4
    assert d["median"] == 2
    assert d["mode"] == 2
    assert d["min"] == 1 and d["max"] == 4 and d["count"] == 5
    assert round(d["stdev"], 4) == 1.1402


def test_describe_mode_none_when_all_unique():
    assert journal.describe([1, 2, 3])["mode"] is None


def test_describe_stdev_none_for_single_value():
    d = journal.describe([7])
    assert d["stdev"] is None and d["mean"] == 7 and d["count"] == 1


def test_describe_empty_is_all_none():
    d = journal.describe([])
    assert d == {"mean": None, "median": None, "mode": None,
                 "stdev": None, "min": None, "max": None, "count": 0}


# --------------------------------------------------------------------------- #
# Tag aggregations
# --------------------------------------------------------------------------- #

SID = "sec-people"


def test_tag_frequency_counts_per_tag():
    entries = [
        _entry("2026-06-01", tags={SID: ["alex", "sam"]}),
        _entry("2026-06-02", tags={SID: ["alex"]}),
        _entry("2026-06-03", tags={"other": ["alex"]}),  # different section ignored
    ]
    assert journal.tag_frequency(entries, SID, None, None) == {"alex": 2, "sam": 1}


def test_tag_frequency_respects_date_range():
    entries = [
        _entry("2026-06-01", tags={SID: ["alex"]}),
        _entry("2026-06-09", tags={SID: ["alex"]}),
    ]
    assert journal.tag_frequency(entries, SID, "2026-06-05", None) == {"alex": 1}


def test_tag_cooccurrence_pairs_within_entry():
    entries = [
        _entry("2026-06-01", tags={SID: ["alex", "sam"]}),
        _entry("2026-06-02", tags={SID: ["alex", "sam"]}),
        _entry("2026-06-03", tags={SID: ["alex"]}),  # lone tag, no pair
    ]
    co = journal.tag_cooccurrence(entries, SID, None, None)
    assert co["alex"]["sam"] == 2
    assert co["sam"]["alex"] == 2
    assert "alex" not in co.get("alex", {})  # no self-pair


def test_tag_trend_buckets_by_iso_week():
    entries = [
        _entry("2026-06-01", tags={SID: ["alex"]}),  # ISO week 23
        _entry("2026-06-02", tags={SID: ["alex"]}),  # week 23
        _entry("2026-06-08", tags={SID: ["alex"]}),  # week 24
    ]
    trend = journal.tag_trend(entries, SID, "alex", None, None)
    assert trend == [
        {"week": "2026-W23", "count": 2},
        {"week": "2026-W24", "count": 1},
    ]


def test_tag_streak_runs_and_average():
    entries = [
        _entry("2026-06-01", tags={SID: ["walk"]}),
        _entry("2026-06-02", tags={SID: ["walk"]}),  # run of 2
        _entry("2026-06-05", tags={SID: ["walk"]}),  # gap -> new run
        _entry("2026-06-06", tags={SID: ["walk"]}),
        _entry("2026-06-07", tags={SID: ["walk"]}),  # run of 3 (latest)
    ]
    s = journal.tag_streak(entries, SID, "walk")
    assert s == {"current": 3, "longest": 3, "avg": 2.5}


def test_tag_streak_absent_tag_is_zeroes():
    assert journal.tag_streak([], SID, "walk") == {"current": 0, "longest": 0, "avg": 0}


# --------------------------------------------------------------------------- #
# Temporal & numeric aggregations
# --------------------------------------------------------------------------- #

NUM = "sec-sleep"


def test_numeric_series_sorted_and_filtered():
    entries = [
        _entry("2026-06-03", numbers={NUM: 7.0}),
        _entry("2026-06-01", numbers={NUM: 6.5}),
        _entry("2026-06-02", numbers={}),  # no value -> skipped
    ]
    assert journal.numeric_series(entries, NUM, None, None) == [
        {"date": "2026-06-01", "value": 6.5},
        {"date": "2026-06-03", "value": 7.0},
    ]


def test_dow_averages_by_weekday():
    # 2026-06-01 is a Monday.
    entries = [
        _entry("2026-06-01", numbers={NUM: 6.0}),  # Mon
        _entry("2026-06-08", numbers={NUM: 8.0}),  # Mon
        _entry("2026-06-02", numbers={NUM: 5.0}),  # Tue
    ]
    dow = journal.dow_averages(entries, NUM, None, None)
    assert dow["Mon"] == 7.0
    assert dow["Tue"] == 5.0
    assert dow["Wed"] is None


def test_word_counts_counts_body_words():
    entries = [
        _entry("2026-06-02", body="three little words"),
        _entry("2026-06-01", body=""),
    ]
    assert journal.word_counts(entries, None, None) == [
        {"date": "2026-06-01", "count": 0},
        {"date": "2026-06-02", "count": 3},
    ]


def test_entry_gaps_between_consecutive_dates():
    entries = [_entry("2026-06-01"), _entry("2026-06-02"), _entry("2026-06-06")]
    assert journal.entry_gaps(entries, None, None) == [
        {"gap_days": 1, "after_date": "2026-06-02"},
        {"gap_days": 4, "after_date": "2026-06-06"},
    ]


def test_creation_hours_histogram():
    entries = [
        _entry("2026-06-01", created="2026-06-01T09:30:00"),
        _entry("2026-06-02", created="2026-06-02T09:05:00"),
        _entry("2026-06-03", created="2026-06-03T22:00:00"),
    ]
    hours = journal.creation_hours(entries, None, None)
    assert hours[9] == 2
    assert hours[22] == 1
    assert hours[0] == 0
    assert len(hours) == 24


def test_creation_hours_preserves_recorded_local_hour_across_timezones():
    entries = [
        _entry("2026-09-01", created="2026-09-01T09:30:00+08:00"),
        _entry("2026-09-02", created="2026-09-02T09:05:00-07:00"),
        _entry("2026-09-10", created="2026-09-10T22:00:00Z"),
    ]
    hours = journal.creation_hours(entries, None, None)
    assert hours[9] == 2
    assert hours[22] == 1
    assert hours[1] == 0


def test_date_density_presence_per_day():
    entries = [_entry("2026-06-01"), _entry("2026-06-03")]
    assert journal.date_density(entries, None, None) == {"2026-06-01": 1, "2026-06-03": 1}


# --------------------------------------------------------------------------- #
# Entry-level aggregations
# --------------------------------------------------------------------------- #

def test_entry_streak_current_longest_last():
    entries = [
        _entry("2026-06-01"), _entry("2026-06-02"), _entry("2026-06-03"),  # run 3
        _entry("2026-06-10"), _entry("2026-06-11"),  # run 2 (latest)
    ]
    assert journal.entry_streak(entries) == {
        "current": 2, "longest": 3, "last_date": "2026-06-11"}


def test_entry_streak_empty():
    assert journal.entry_streak([]) == {"current": 0, "longest": 0, "last_date": None}


def test_section_coverage_marks_filled_sections():
    entries = [
        _entry("2026-06-01", tags={"a": ["x"]}, numbers={"b": 1.0}),
        _entry("2026-06-02", tags={"a": []}),  # empty tag list -> not covered
    ]
    cov = journal.section_coverage(entries, ["a", "b"], None, None)
    assert cov == [
        {"date": "2026-06-01", "covered": ["a", "b"]},
        {"date": "2026-06-02", "covered": []},
    ]


# --------------------------------------------------------------------------- #
# Mood aggregations (mood is int 1..7 or null; nulls are always ignored)
# --------------------------------------------------------------------------- #

def test_mood_series_sorted_and_skips_nulls():
    entries = [
        _entry("2026-06-03", mood=7),
        _entry("2026-06-01", mood=4),
        _entry("2026-06-02", mood=None),  # no mood -> skipped
    ]
    assert journal.mood_series(entries, None, None) == [
        {"date": "2026-06-01", "mood": 4},
        {"date": "2026-06-03", "mood": 7},
    ]


def test_mood_series_respects_date_range():
    entries = [
        _entry("2026-06-01", mood=3),
        _entry("2026-06-09", mood=6),
    ]
    assert journal.mood_series(entries, "2026-06-05", None) == [
        {"date": "2026-06-09", "mood": 6},
    ]


def test_mood_dow_averages_by_weekday():
    # 2026-06-01 is a Monday.
    entries = [
        _entry("2026-06-01", mood=6),  # Mon
        _entry("2026-06-08", mood=4),  # Mon
        _entry("2026-06-02", mood=5),  # Tue
        _entry("2026-06-03", mood=None),  # Wed, no mood
    ]
    dow = journal.mood_dow_averages(entries, None, None)
    assert dow["Mon"] == 5.0
    assert dow["Tue"] == 5.0
    assert dow["Wed"] is None
    assert set(dow) == {"Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"}


def test_mood_distribution_counts_each_value_1_to_7():
    entries = [
        _entry("2026-06-01", mood=5),
        _entry("2026-06-02", mood=5),
        _entry("2026-06-03", mood=7),
        _entry("2026-06-04", mood=None),  # ignored
    ]
    dist = journal.mood_distribution(entries, None, None)
    assert dist == {1: 0, 2: 0, 3: 0, 4: 0, 5: 2, 6: 0, 7: 1}


def test_mood_by_date_maps_date_to_mood_skipping_nulls():
    entries = [
        _entry("2026-06-01", mood=4),
        _entry("2026-06-02", mood=None),
        _entry("2026-06-03", mood=6),
    ]
    assert journal.mood_by_date(entries, None, None) == {
        "2026-06-01": 4, "2026-06-03": 6}


def test_mood_numeric_pairs_pairs_same_day_values():
    entries = [
        _entry("2026-06-01", numbers={NUM: 8.0}, mood=6),
        _entry("2026-06-02", numbers={NUM: 5.0}, mood=3),
        _entry("2026-06-03", numbers={NUM: 7.0}, mood=None),  # no mood -> skip
        _entry("2026-06-04", mood=5),                          # no number -> skip
    ]
    pairs = journal.mood_numeric_pairs(entries, NUM, None, None)
    assert pairs == [
        {"date": "2026-06-01", "value": 8.0, "mood": 6},
        {"date": "2026-06-02", "value": 5.0, "mood": 3},
    ]


def test_mood_numeric_pairs_respects_date_range():
    entries = [
        _entry("2026-06-01", numbers={NUM: 8.0}, mood=6),
        _entry("2026-06-09", numbers={NUM: 5.0}, mood=3),
    ]
    assert journal.mood_numeric_pairs(entries, NUM, "2026-06-05", None) == [
        {"date": "2026-06-09", "value": 5.0, "mood": 3},
    ]


# --------------------------------------------------------------------------- #
# Expanded numeric aggregations (numeric_* helpers powering the Numeric tab)
# --------------------------------------------------------------------------- #

def test_numeric_stats_summary_and_latest():
    entries = [
        _entry("2026-06-01", numbers={NUM: 6.0}),
        _entry("2026-06-03", numbers={NUM: 8.0}),  # latest dated value
        _entry("2026-06-02", numbers={NUM: 7.0}),
        _entry("2026-06-04", numbers={}),          # no value -> ignored
    ]
    s = journal.numeric_stats(entries, NUM, None, None)
    assert s["count"] == 3
    assert s["mean"] == 7.0
    assert s["median"] == 7.0
    assert s["min"] == 6.0 and s["max"] == 8.0
    assert s["latest"] == 8.0  # value on the most recent dated entry
    assert round(s["stdev"], 4) == 1.0


def test_numeric_stats_empty_is_zero_count():
    s = journal.numeric_stats([], NUM, None, None)
    assert s["count"] == 0
    assert s["mean"] is None and s["latest"] is None and s["stdev"] is None


def test_numeric_histogram_buckets_span_min_max():
    entries = [_entry("2026-06-0%d" % i, numbers={NUM: float(i)}) for i in range(1, 5)]
    hist = journal.numeric_histogram(entries, NUM, 2, None, None)
    assert len(hist) == 2
    assert hist[0]["lo"] == 1.0 and hist[-1]["hi"] == 4.0
    assert sum(b["count"] for b in hist) == 4


def test_numeric_histogram_all_equal_values_single_bucket():
    entries = [_entry("2026-06-01", numbers={NUM: 5.0}),
               _entry("2026-06-02", numbers={NUM: 5.0})]
    hist = journal.numeric_histogram(entries, NUM, 4, None, None)
    assert len(hist) == 1
    assert hist[0]["lo"] == 5.0 and hist[0]["hi"] == 5.0 and hist[0]["count"] == 2


def test_numeric_histogram_too_few_points_empty():
    assert journal.numeric_histogram([], NUM, 4, None, None) == []


def test_numeric_regression_slope_intercept():
    # values 6,7,8 on consecutive days -> slope 1/day, intercept 6 at day 0.
    entries = [
        _entry("2026-06-01", numbers={NUM: 6.0}),
        _entry("2026-06-02", numbers={NUM: 7.0}),
        _entry("2026-06-03", numbers={NUM: 8.0}),
    ]
    reg = journal.numeric_regression(entries, NUM, None, None)
    assert reg["n"] == 3
    assert round(reg["slope"], 6) == 1.0
    assert round(reg["intercept"], 6) == 6.0


def test_numeric_regression_too_few_points_is_none():
    reg = journal.numeric_regression([_entry("2026-06-01", numbers={NUM: 6.0})],
                                     NUM, None, None)
    assert reg == {"slope": None, "intercept": None, "n": 1}


def test_numeric_by_date_sorted():
    entries = [
        _entry("2026-06-03", numbers={NUM: 8.0}),
        _entry("2026-06-01", numbers={NUM: 6.0}),
        _entry("2026-06-02", numbers={}),  # skipped
    ]
    assert journal.numeric_by_date(entries, NUM, None, None) == [
        {"date": "2026-06-01", "value": 6.0},
        {"date": "2026-06-03", "value": 8.0},
    ]


def test_numeric_correlation_matrix_pairwise():
    A, B = "sec-a", "sec-b"
    entries = [
        _entry("2026-06-01", numbers={A: 1.0, B: 2.0}),
        _entry("2026-06-02", numbers={A: 2.0, B: 4.0}),
        _entry("2026-06-03", numbers={A: 3.0, B: 6.0}),  # perfectly correlated
    ]
    m = journal.numeric_correlation_matrix(entries, [A, B], None, None)
    assert len(m["pairs"]) == 1  # one symmetric pair, no self-pairs
    p = m["pairs"][0]
    assert {p["a"], p["b"]} == {A, B}
    assert p["n"] == 3
    assert round(p["r"], 6) == 1.0


def test_numeric_correlation_matrix_skips_insufficient_overlap():
    A, B = "sec-a", "sec-b"
    entries = [_entry("2026-06-01", numbers={A: 1.0, B: 2.0})]  # only n=1 overlap
    m = journal.numeric_correlation_matrix(entries, [A, B], None, None)
    assert m["pairs"] == []


def test_numeric_period_delta_vs_previous_window():
    # window 06-03..06-04 (mean 8) vs previous equal window 06-01..06-02 (mean 6)
    entries = [
        _entry("2026-06-01", numbers={NUM: 6.0}),
        _entry("2026-06-02", numbers={NUM: 6.0}),
        _entry("2026-06-03", numbers={NUM: 8.0}),
        _entry("2026-06-04", numbers={NUM: 8.0}),
    ]
    d = journal.numeric_period_delta(entries, NUM, "2026-06-03", "2026-06-04")
    assert d["current_mean"] == 8.0
    assert d["previous_mean"] == 6.0
    assert d["delta"] == 2.0
    assert round(d["pct"], 4) == round(2.0 / 6.0 * 100, 4)


def test_numeric_period_delta_none_without_bounds():
    d = journal.numeric_period_delta([], NUM, None, None)
    assert d["current_mean"] is None and d["delta"] is None


def test_numeric_streaks_relative_to_mean():
    # values 1,2,8,9,3 mean=4.6: above=[8,9] run2; current run ends below.
    entries = [
        _entry("2026-06-01", numbers={NUM: 1.0}),
        _entry("2026-06-02", numbers={NUM: 2.0}),
        _entry("2026-06-03", numbers={NUM: 8.0}),
        _entry("2026-06-04", numbers={NUM: 9.0}),
        _entry("2026-06-05", numbers={NUM: 3.0}),
    ]
    s = journal.numeric_streaks(entries, NUM, None, None)
    assert s["longest_above"] == 2
    assert s["longest_below"] == 2
    assert s["current"] != 0  # a signed current run length


def test_numeric_streaks_empty():
    assert journal.numeric_streaks([], NUM, None, None) == {
        "longest_above": 0, "longest_below": 0, "current": 0}


def test_numeric_cumulative_running_sum():
    entries = [
        _entry("2026-06-02", numbers={NUM: 3.0}),
        _entry("2026-06-01", numbers={NUM: 2.0}),
        _entry("2026-06-03", numbers={NUM: 5.0}),
    ]
    assert journal.numeric_cumulative(entries, NUM, None, None) == [
        {"date": "2026-06-01", "total": 2.0},
        {"date": "2026-06-02", "total": 5.0},
        {"date": "2026-06-03", "total": 10.0},
    ]


def test_numeric_coverage_logged_fraction():
    entries = [
        _entry("2026-06-01", numbers={NUM: 6.0}),
        _entry("2026-06-02", numbers={}),
        _entry("2026-06-03", numbers={NUM: 7.0}),
        _entry("2026-06-04", numbers={}),
    ]
    cov = journal.numeric_coverage(entries, NUM, None, None)
    assert cov["logged"] == 2
    assert cov["total_entries"] == 4
    assert cov["pct"] == 50.0


def test_numeric_coverage_no_entries_zero_pct():
    cov = journal.numeric_coverage([], NUM, None, None)
    assert cov == {"logged": 0, "total_entries": 0, "pct": 0}


# --------------------------------------------------------------------------- #
# analytics_payload
# --------------------------------------------------------------------------- #

def test_analytics_payload_shape():
    data = journal._empty()
    sec = journal.add_section(data, "people", "tag", "#e0a955")
    journal.add_section_tag(data, sec["id"], "alex")
    journal.upsert_entry(
        data, "2026-06-10", "title", "two words",
        tags={sec["id"]: ["alex"]}, numbers={}, mood=5,
        now=datetime(2026, 6, 10, 9, 0, 0),
    )
    payload = journal.analytics_payload(data)

    assert set(payload) == {"sections", "entries", "date_range"}
    s = payload["sections"][0]
    assert set(s) == {"id", "name", "type", "color", "tags", "unit", "chart_opts"}
    assert s["name"] == "people" and s["tags"] == ["alex"]
    e = payload["entries"][0]
    assert set(e) == {"date", "tags", "numbers", "body", "created", "mood", "sleep", "rescuetime", "music", "usage", "health", "document"}
    assert e["document"] is None
    assert e["date"] == "2026-06-10"
    assert e["mood"] == 5
    assert payload["date_range"] == {"min": "2026-06-10", "max": "2026-06-10"}


def test_analytics_payload_excludes_archived_sections():
    data = journal._empty()
    keep = journal.add_section(data, "people", "tag", "#e0a955")
    gone = journal.add_section(data, "work", "tag", "#e06666")
    journal.archive_section(data, gone["id"])
    payload = journal.analytics_payload(data)
    names = [s["name"] for s in payload["sections"]]
    assert names == ["people"]
    assert keep["id"] in {s["id"] for s in payload["sections"]}


def test_analytics_payload_empty_date_range():
    payload = journal.analytics_payload(journal._empty())
    assert payload["entries"] == []
    assert payload["date_range"] == {"min": None, "max": None}


def test_shared_analytics_range_includes_nonempty_tracked_dates():
    assert journal.analytics_date_range(
        {"min": "2026-09-10", "max": "2026-09-10"},
        {"min": "2026-09-05", "max": "2026-09-12"},
        [{"date": "2026-09-01", "count": 1}, {"date": "2026-09-15", "count": 4}],
    ) == {"min": "2026-09-01", "max": "2026-09-15"}


def test_shared_analytics_range_ignores_empty_corrupt_and_invalid_tracking_days():
    days = [{"date": "2026-01-01", "count": 0},
            {"date": "2026-12-31", "count": -1},
            {"date": "2026-02-30", "count": 2},
            {"date": "2026-09-10", "count": True}]
    assert journal.analytics_date_range({}, {}, days) == {"min": None, "max": None}
    assert journal.analytics_date_range({}, {}, [{"date": "2026-09-10", "count": 1}]) == {
        "min": "2026-09-10", "max": "2026-09-10"}


def test_analytics_payload_omits_suggestions_and_dormant():
    """Suggestion blocks moved to the Manage page; the payload no longer carries
    them (the Manage route computes its own)."""
    data = journal._empty()
    sec = journal.add_section(data, "people", "tag", "#e0a955")
    journal.add_section_tag(data, sec["id"], "alex")
    journal.upsert_entry(
        data, "2026-06-10", "title",
        "running running running mountains mountains",
        tags={sec["id"]: ["alex"]}, numbers={}, mood=5,
        now=datetime(2026, 6, 10, 9, 0, 0),
    )
    payload = journal.analytics_payload(data)
    assert "suggestions" not in payload
    assert "dormant" not in payload


# --------------------------------------------------------------------------- #
# word_frequency
# --------------------------------------------------------------------------- #

def test_word_frequency_counts_and_orders():
    entries = [
        _entry("2026-06-01", body="apple apple banana"),
        _entry("2026-06-02", body="apple cherry cherry cherry"),
    ]
    got = journal.word_frequency(entries)
    # cherry 3, apple 3 (tie -> alphabetical), banana 1
    assert got[0] == {"word": "apple", "count": 3}
    assert got[1] == {"word": "cherry", "count": 3}
    assert {"word": "banana", "count": 1} in got


def test_word_frequency_strips_stopwords_and_short_tokens():
    entries = [_entry("2026-06-01", body="the and a I go to running running")]
    words = {w["word"] for w in journal.word_frequency(entries)}
    # stopwords (the/and/a/to) and sub-min-length tokens (i, go) are dropped.
    assert "running" in words
    assert "the" not in words and "and" not in words
    assert "go" not in words and "i" not in words


def test_word_frequency_respects_date_bounds_and_limit():
    entries = [
        _entry("2026-06-01", body="alpha alpha"),
        _entry("2026-06-10", body="beta beta beta"),
    ]
    got = journal.word_frequency(entries, start="2026-06-05", end=None)
    assert [w["word"] for w in got] == ["beta"]
    limited = journal.word_frequency(
        [_entry("2026-06-01", body="alpha beta gamma")], limit=2)
    assert len(limited) == 2


def test_word_frequency_lowercases_alphanumeric():
    entries = [_entry("2026-06-01", body="Running, RUNNING! running.")]
    got = journal.word_frequency(entries)
    assert got == [{"word": "running", "count": 3}]


# --------------------------------------------------------------------------- #
# tag_suggestions
# --------------------------------------------------------------------------- #

# A fixed "now" used across v2 suggestion tests; window = last 30 days.
_NOW = datetime(2026, 6, 30, 9, 0, 0)


def _sug_store(bodies_by_date, tags=None, archived=None, dismissed=None):
    """Build a store with a single 'people' tag section, given {date: body}."""
    data = journal._empty()
    sec = journal.add_section(data, "people", "tag", "#e0a955")
    for t in tags or []:
        journal.add_section_tag(data, sec["id"], t)
    for t in archived or []:
        journal.add_section_tag(data, sec["id"], t)
        journal.remove_section_tag(data, sec["id"], t)
    for date, body in bodies_by_date.items():
        journal.upsert_entry(data, date, "t", body,
                             now=datetime.strptime(date, "%Y-%m-%d"))
    if dismissed:
        data["dismissed_suggestions"].update(dismissed)
    return data, sec


def test_tag_suggestions_v2_shape_and_min_days():
    # "running" appears on 3 distinct days -> qualifies; "swimming" on 2 -> not.
    data, _ = _sug_store({
        "2026-06-20": "running swimming",
        "2026-06-22": "running swimming",
        "2026-06-24": "running",
    })
    got = journal.tag_suggestions(data, now=_NOW)
    by_word = {s["word"]: s for s in got}
    assert "running" in by_word
    assert by_word["running"] == {"word": "running", "count": 3, "days": 3}
    assert "swimming" not in by_word   # only 2 distinct days


def test_tag_suggestions_excludes_stopwords_including_everything():
    data, _ = _sug_store({
        "2026-06-20": "everything something really running",
        "2026-06-22": "everything something running",
        "2026-06-24": "everything running",
    })
    words = {s["word"] for s in journal.tag_suggestions(data, now=_NOW)}
    assert "running" in words
    assert "everything" not in words and "something" not in words
    assert "really" not in words


def test_tag_suggestions_excludes_known_and_archived_tags():
    data, _ = _sug_store(
        {
            "2026-06-20": "Alex Alex jogging",
            "2026-06-22": "alex jogging",
            "2026-06-24": "alex jogging",
        },
        archived=["alex"],
    )
    words = {s["word"] for s in journal.tag_suggestions(data, now=_NOW)}
    assert "alex" not in words   # archived tag still excluded
    assert "jogging" in words


def test_tag_suggestions_window_excludes_old_entries():
    # The 2026-05-01 entry is >30 days before now -> ignored even with 3 hits.
    data, _ = _sug_store({
        "2026-05-01": "running running running",
        "2026-06-20": "running",
        "2026-06-22": "running",
    })
    words = {s["word"] for s in journal.tag_suggestions(data, now=_NOW)}
    # Only 2 in-window days remain for "running" -> below min_days.
    assert "running" not in words


def test_tag_suggestions_window_boundary_inclusive():
    # 30-day window relative to 2026-06-30 => start 2026-06-01 inclusive.
    data, _ = _sug_store({
        "2026-06-01": "running",
        "2026-06-15": "running",
        "2026-06-30": "running",
    })
    words = {s["word"] for s in journal.tag_suggestions(data, now=_NOW)}
    assert "running" in words


def test_tag_suggestions_dismissed_within_cooldown_excluded_then_resurfaces():
    bodies = {
        "2026-06-20": "running",
        "2026-06-22": "running",
        "2026-06-24": "running",
    }
    # Dismissed 10 days ago -> within 30-day cooldown -> suppressed.
    data, _ = _sug_store(bodies, dismissed={"running": "2026-06-20"})
    words = {s["word"] for s in journal.tag_suggestions(data, now=_NOW)}
    assert "running" not in words
    # Dismissed 31 days ago -> cooldown expired -> resurfaces.
    data2, _ = _sug_store(bodies, dismissed={"running": "2026-05-30"})
    words2 = {s["word"] for s in journal.tag_suggestions(data2, now=_NOW)}
    assert "running" in words2


def test_tag_suggestions_ordering_and_limit():
    data, _ = _sug_store({
        "2026-06-18": "alpha beta gamma",
        "2026-06-20": "alpha beta gamma",
        "2026-06-22": "alpha beta",       # alpha:3d, beta:3d, gamma:2d
        "2026-06-24": "alpha beta",        # alpha:4d, beta:4d
        "2026-06-26": "alpha",             # alpha:5d
    })
    got = journal.tag_suggestions(data, now=_NOW)
    # alpha (5 days) before beta (4 days); gamma drops (2 days < 3).
    words = [s["word"] for s in got]
    assert words[:2] == ["alpha", "beta"]
    assert "gamma" not in words
    limited = journal.tag_suggestions(data, now=_NOW, limit=1)
    assert [s["word"] for s in limited] == ["alpha"]


# --------------------------------------------------------------------------- #
# suggestion_occurrences
# --------------------------------------------------------------------------- #

def test_suggestion_occurrences_whole_word_case_insensitive():
    data, _ = _sug_store({
        "2026-06-20": "I went Running today",
        "2026-06-22": "rerunning is not a match",   # substring, not whole word
        "2026-06-24": "running again",
    })
    occ = journal.suggestion_occurrences(data, "running", now=_NOW)
    dates = [o["date"] for o in occ]
    assert dates == ["2026-06-24", "2026-06-20"]   # newest first; 06-22 skipped
    assert "**Running**" in occ[1]["snippet"]


def test_suggestion_occurrences_snippet_truncation_and_ellipsis():
    long_body = ("padding " * 20) + "running " + ("trailing " * 20)
    data, _ = _sug_store({"2026-06-20": long_body})
    occ = journal.suggestion_occurrences(data, "running", now=_NOW,
                                         snippet_radius=20)
    snip = occ[0]["snippet"]
    assert "**running**" in snip
    assert snip.startswith("…") and snip.endswith("…")
    assert len(snip) < len(long_body)


def test_suggestion_occurrences_window_and_empty_bodies():
    data, _ = _sug_store({
        "2026-05-01": "running",      # out of window
        "2026-06-20": "",             # empty body
        "2026-06-22": "running",
    })
    occ = journal.suggestion_occurrences(data, "running", now=_NOW)
    assert [o["date"] for o in occ] == ["2026-06-22"]
    assert journal.suggestion_occurrences(data, "", now=_NOW) == []


# --------------------------------------------------------------------------- #
# dismiss_suggestion
# --------------------------------------------------------------------------- #

def test_dismiss_suggestion_records_today_idempotent():
    data = journal._empty()
    journal.dismiss_suggestion(data, "Running", now=_NOW)
    assert data["dismissed_suggestions"] == {"running": "2026-06-30"}
    journal.dismiss_suggestion(data, "running", now=_NOW)
    assert data["dismissed_suggestions"] == {"running": "2026-06-30"}


# --------------------------------------------------------------------------- #
# apply_tag_suggestion
# --------------------------------------------------------------------------- #

def test_apply_tag_suggestion_permanent_adds_master_and_tags_days():
    data, sec = _sug_store({"2026-06-20": "running", "2026-06-22": "running"})
    journal.apply_tag_suggestion(
        data, "running", sec["id"], ["2026-06-20", "2026-06-22"],
        permanent=True, now=_NOW)
    assert "running" in journal.section_by_id(data, sec["id"])["tags"]
    for d in ("2026-06-20", "2026-06-22"):
        e = journal.get_entry_by_date(data, d)
        assert e["tags"][sec["id"]] == ["running"]


def test_apply_tag_suggestion_temporary_tags_days_only():
    data, sec = _sug_store({"2026-06-20": "running"})
    journal.apply_tag_suggestion(
        data, "running", sec["id"], ["2026-06-20"], permanent=False, now=_NOW)
    assert "running" not in journal.section_by_id(data, sec["id"])["tags"]
    assert journal.get_entry_by_date(data, "2026-06-20")["tags"][sec["id"]] \
        == ["running"]
    # Derives as a temporary tag.
    assert "running" in journal.temporary_tags(data).get(sec["id"], [])


def test_apply_tag_suggestion_creates_missing_entry_and_dedupes():
    data, sec = _sug_store({})
    # No entry on this date -> get-or-create.
    journal.apply_tag_suggestion(
        data, "running", sec["id"], ["2026-06-25"], permanent=False, now=_NOW)
    e = journal.get_entry_by_date(data, "2026-06-25")
    assert e is not None and e["tags"][sec["id"]] == ["running"]
    # Applying again does not duplicate.
    journal.apply_tag_suggestion(
        data, "running", sec["id"], ["2026-06-25"], permanent=False, now=_NOW)
    assert journal.get_entry_by_date(data, "2026-06-25")["tags"][sec["id"]] \
        == ["running"]


def test_apply_tag_suggestion_bad_section_no_crash():
    data, _ = _sug_store({"2026-06-20": "running"})
    # Unknown section -> add_section_tag no-ops, entry tag dropped by upsert.
    journal.apply_tag_suggestion(
        data, "running", "nope", ["2026-06-20"], permanent=True, now=_NOW)
    e = journal.get_entry_by_date(data, "2026-06-20")
    assert "nope" not in (e.get("tags") or {})


def test_apply_tag_suggestion_invalid_word_raises():
    data, sec = _sug_store({})
    import pytest
    with pytest.raises(ValueError):
        journal.apply_tag_suggestion(
            data, "bad!name", sec["id"], ["2026-06-20"], permanent=False,
            now=_NOW)


# --------------------------------------------------------------------------- #
# dormant_tags
# --------------------------------------------------------------------------- #

def test_dormant_tags_surfaces_long_unused_people_tags():
    data = journal._empty()
    sec = journal.add_section(data, "people", "tag", "#e0a955")
    journal.upsert_entry(
        data, "2026-05-01", "t", "", tags={sec["id"]: ["alex"]},
        now=datetime(2026, 5, 1, 9, 0, 0),
    )
    now = datetime(2026, 6, 10)   # 40 days later
    got = journal.dormant_tags(data, now=now)
    assert len(got) == 1
    d = got[0]
    assert d["name"] == "alex" and d["section_id"] == sec["id"]
    assert d["last_date"] == "2026-05-01" and d["days_since"] == 40


def test_dormant_tags_threshold_boundary_and_recent_excluded():
    data = journal._empty()
    sec = journal.add_section(data, "people", "tag", "#e0a955")
    journal.upsert_entry(
        data, "2026-06-01", "t", "", tags={sec["id"]: ["recent"]},
        now=datetime(2026, 6, 1, 9, 0, 0),
    )
    journal.upsert_entry(
        data, "2026-05-20", "t", "", tags={sec["id"]: ["old"]},
        now=datetime(2026, 5, 20, 9, 0, 0),
    )
    now = datetime(2026, 6, 10)   # recent=9d ago, old=21d ago
    names = {d["name"] for d in journal.dormant_tags(data, now=now)}
    assert "old" in names         # exactly 21 days -> dormant (>= threshold)
    assert "recent" not in names  # 9 days -> active


def test_dormant_tags_matches_people_section_by_name():
    data = journal._empty()
    people = journal.add_section(data, "people", "tag", "#e0a955")
    work = journal.add_section(data, "work", "tag", "#e06666")
    journal.upsert_entry(
        data, "2026-05-01", "t", "", tags={people["id"]: ["alex"],
                                           work["id"]: ["projectx"]},
        now=datetime(2026, 5, 1, 9, 0, 0),
    )
    got = journal.dormant_tags(data, now=datetime(2026, 6, 10))
    names = {d["name"] for d in got}
    assert names == {"alex"}   # only the people section is scanned


def test_dormant_tags_sorted_most_dormant_first():
    data = journal._empty()
    sec = journal.add_section(data, "people", "tag", "#e0a955")
    journal.upsert_entry(data, "2026-04-01", "t", "",
                         tags={sec["id"]: ["older"]},
                         now=datetime(2026, 4, 1, 9, 0, 0))
    journal.upsert_entry(data, "2026-05-01", "t", "",
                         tags={sec["id"]: ["newer"]},
                         now=datetime(2026, 5, 1, 9, 0, 0))
    got = journal.dormant_tags(data, now=datetime(2026, 6, 10))
    assert [d["name"] for d in got] == ["older", "newer"]


# --------------------------------------------------------------------------- #
# mood_tag_uplift
# --------------------------------------------------------------------------- #

def test_mood_tag_uplift_is_tag_mean_minus_baseline():
    sid = "people"
    entries = [
        _entry("2026-06-01", tags={sid: ["alex"]}, mood=6),
        _entry("2026-06-02", tags={sid: ["alex"]}, mood=6),
        _entry("2026-06-03", tags={}, mood=2),
        _entry("2026-06-04", tags={}, mood=2),
    ]
    got = journal.mood_tag_uplift(entries)
    row = [r for r in got if r["name"] == "alex"][0]
    assert row["section_id"] == sid
    assert row["avg_mood"] == 6
    assert row["baseline"] == 4        # (6+6+2+2)/4
    assert row["uplift"] == 2
    assert row["n"] == 2


def test_mood_tag_uplift_ignores_null_moods():
    sid = "people"
    entries = [
        _entry("2026-06-01", tags={sid: ["alex"]}, mood=5),
        _entry("2026-06-02", tags={sid: ["alex"]}, mood=None),
        _entry("2026-06-03", tags={}, mood=3),
    ]
    got = journal.mood_tag_uplift(entries, min_n=1)
    row = [r for r in got if r["name"] == "alex"][0]
    assert row["n"] == 1 and row["avg_mood"] == 5
    assert row["baseline"] == 4        # (5+3)/2; null ignored


def test_mood_tag_uplift_min_n_gate_and_ranking():
    sid = "people"
    entries = [
        _entry("2026-06-01", tags={sid: ["alex"]}, mood=7),
        _entry("2026-06-02", tags={sid: ["alex"]}, mood=7),
        _entry("2026-06-03", tags={sid: ["bob"]}, mood=1),   # n=1, gated out
        _entry("2026-06-04", tags={sid: ["cara", "cara_dup"]}, mood=3),
        _entry("2026-06-05", tags={sid: ["cara"]}, mood=3),
    ]
    got = journal.mood_tag_uplift(entries, min_n=2)
    names = [r["name"] for r in got]
    assert "bob" not in names          # below min_n
    assert names[0] == "alex"          # largest |uplift| first


# --------------------------------------------------------------------------- #
# Sleep analytics tab — payload regression test
# --------------------------------------------------------------------------- #

def test_payload_includes_sleep_for_sleep_tab():
    """analytics_payload entries carry a sleep dict (incl. nested stages)."""
    data = journal._seeded()
    journal.set_entry_sleep(data, "2026-06-29", {
        "duration_min": 420, "start": "23:00", "end": "06:00",
        "quality": 90, "efficiency": 90, "score": None,
        "stages": {"deep": 60, "light": 240, "rem": 90, "wake": 30},
        "source": "fitbit", "fetched": "x",
    })
    p = journal.analytics_payload(data)
    assert p["entries"][0]["sleep"]["stages"]["deep"] == 60


# RescueTime analytics tab — payload regression test
# --------------------------------------------------------------------------- #

def test_payload_includes_rescuetime():
    """analytics_payload entries carry a rescuetime dict for the Productivity tab."""
    from datapom.domain import journal
    data = journal._seeded()
    journal.set_entry_rescuetime(data, "2026-06-28",
        {"pulse": 70, "productive_min": 120, "distracting_min": 20,
         "neutral_min": 10, "total_min": 150,
         "top_categories": [{"name": "Software Development", "min": 100}],
         "source": "rescuetime", "fetched": "x"})
    p = journal.analytics_payload(data)
    assert p["entries"][0]["rescuetime"]["pulse"] == 70


def _rt_entry(date, activities):
    """A minimal usable rescuetime entry carrying a top_activities list."""
    return {
        "id": date, "date": date, "title": "t", "body": "",
        "tags": {}, "numbers": {}, "mood": None,
        "rescuetime": {
            "pulse": 60, "total_min": 300, "top_categories": [],
            "top_activities": activities, "source": "rescuetime", "fetched": "x",
        },
    }


def test_rescuetime_top_activities_aggregates_and_sorts():
    from datapom.domain import journal
    entries = [
        _rt_entry("2026-06-01", [
            {"name": "github.com", "min": 60, "category": "Dev", "productivity": 2},
            {"name": "youtube.com", "min": 30, "category": "Video", "productivity": -2},
        ]),
        _rt_entry("2026-06-02", [
            {"name": "github.com", "min": 40, "category": "Dev", "productivity": 2},
        ]),
    ]
    rows = journal.rescuetime_top_activities(entries)
    assert rows[0] == {"name": "github.com", "min": 100,
                       "category": "Dev", "productivity": 2}
    assert rows[1]["name"] == "youtube.com" and rows[1]["min"] == 30


def test_rescuetime_top_activities_ignores_days_without_breakdown():
    from datapom.domain import journal
    data = journal._seeded()
    # legacy day: rescuetime present, but no top_activities
    journal.set_entry_rescuetime(data, "2026-06-05",
        {"pulse": 70, "total_min": 150, "top_categories": [], "source": "rescuetime", "fetched": "x"})
    assert journal.rescuetime_top_activities(data["entries"]) == []


def test_rescuetime_activity_minutes_series_zero_fills():
    from datapom.domain import journal
    entries = [
        _rt_entry("2026-06-01", [{"name": "github.com", "min": 60}]),
        _rt_entry("2026-06-02", [{"name": "youtube.com", "min": 45}]),
    ]
    out = journal.rescuetime_activity_minutes_series(entries, top_n=6)
    assert out["dates"] == ["2026-06-01", "2026-06-02"]
    assert out["series"]["github.com"] == [60, 0]
    assert out["series"]["youtube.com"] == [0, 45]


# Music analytics tab — payload regression test
# --------------------------------------------------------------------------- #

def test_payload_includes_music():
    from datapom.domain import journal
    data = journal._seeded()
    journal.set_entry_music(data, "2026-06-29",
        {"tracks": 10, "minutes": 40, "distinct": 9,
         "top_artists": [{"name": "Phoebe Bridgers", "count": 3}],
         "valence": 0.6, "energy": 0.7, "danceability": 0.5, "tempo": 118,
         "source": "spotify", "fetched": "x"})
    p = journal.analytics_payload(data)
    assert p["entries"][0]["music"]["minutes"] == 40


def test_payload_includes_sanitized_rich_music_dict():
    from datapom.domain import journal
    data = journal._seeded()
    journal.set_entry_music(data, "2026-06-29", {
        "tracks": 2,
        "minutes": 8,
        "top_tracks": [{"name": "Song A", "artist": "Artist A", "count": 2}],
        "top_albums": [{"name": "Album A", "artist": "Artist A", "count": 2}],
        "contexts": [{"name": "focus", "minutes": 8}],
        "source": "spotify_import",
        "access_token": "secret",
        "nested": {"refresh_token": "secret", "kept": "ok"},
    })
    music = journal.analytics_payload(data)["entries"][0]["music"]
    assert music["top_tracks"][0]["name"] == "Song A"
    assert music["top_albums"][0]["name"] == "Album A"
    assert music["contexts"][0]["name"] == "focus"
    assert "access_token" not in music
    assert music["nested"] == {"kept": "ok"}


# --------------------------------------------------------------------------- #
# Leading-indicators analytics (Spec 3): lagged correlations / uplift
# --------------------------------------------------------------------------- #

def _sleep_entry(date, hours=None, quality=None, mood=None):
    e = _entry(date, mood=mood)
    if hours is not None or quality is not None:
        e["sleep"] = {
            "duration_min": (hours * 60) if hours is not None else 420,
            "quality": quality,
            "source": "test", "fetched": "x",
        }
    return e


def test_shift_date_forward_and_backward():
    assert journal._shift_date("2026-06-01", 1) == "2026-06-02"
    assert journal._shift_date("2026-06-30", 1) == "2026-07-01"
    assert journal._shift_date("2026-06-01", -1) == "2026-05-31"
    assert journal._shift_date("2026-06-01", 0) == "2026-06-01"


def test_lagged_pairs_only_when_both_exist():
    pred = {"2026-06-01": 5.0, "2026-06-02": 6.0, "2026-06-03": 7.0}
    target = {"2026-06-02": 3.0, "2026-06-03": 4.0}  # no 06-01 target
    # lag=1: pred[D] vs target[D+1]
    got = journal.lagged_pairs(pred, target, 1)
    # 06-01 -> 06-02 (5,3); 06-02 -> 06-03 (6,4); 06-03 -> 06-04 missing
    assert sorted(got) == [(5.0, 3.0), (6.0, 4.0)]


def test_lagged_pairs_lag_zero_is_same_day():
    pred = {"2026-06-01": 5.0, "2026-06-02": 6.0}
    target = {"2026-06-01": 3.0, "2026-06-02": 4.0}
    got = journal.lagged_pairs(pred, target, 0)
    assert sorted(got) == [(5.0, 3.0), (6.0, 4.0)]


def test_predictor_by_date_numeric():
    sid = "sleep_num"
    entries = [
        _entry("2026-06-01", numbers={sid: 7.0}),
        _entry("2026-06-02", numbers={}),
        _entry("2026-06-03", numbers={sid: 8.0}),
    ]
    got = journal._predictor_by_date(entries, ("numeric", sid), None, None)
    assert got == {"2026-06-01": 7.0, "2026-06-03": 8.0}


def test_predictor_by_date_sleep_hours_and_quality():
    entries = [
        _sleep_entry("2026-06-01", hours=8, quality=90),
        _sleep_entry("2026-06-02", hours=6, quality=None),
    ]
    hours = journal._predictor_by_date(entries, ("sleep", "hours"), None, None)
    assert hours == {"2026-06-01": 8.0, "2026-06-02": 6.0}
    qual = journal._predictor_by_date(entries, ("sleep", "quality"), None, None)
    # quality None on 06-02 is skipped
    assert qual == {"2026-06-01": 90}


def test_lagged_correlation_matches_pearson():
    sid = "n"
    # pred[D] perfectly correlated with mood[D+1]
    entries = [
        _entry("2026-06-01", numbers={sid: 1.0}, mood=None),
        _entry("2026-06-02", numbers={sid: 2.0}, mood=2),
        _entry("2026-06-03", numbers={sid: 3.0}, mood=3),
        _entry("2026-06-04", numbers={sid: 4.0}, mood=4),
        _entry("2026-06-05", numbers={sid: None}, mood=5),
    ]
    got = journal.lagged_correlation(entries, ("numeric", sid), lag=1)
    # pairs: (1,2),(2,3),(3,4),(4,5) -> perfect +1
    assert got["n"] == 4
    assert round(got["r"], 6) == 1.0
    xs = [1.0, 2.0, 3.0, 4.0]
    ys = [2, 3, 4, 5]
    assert round(got["r"], 9) == round(journal._pearson(xs, ys), 9)


def test_lagged_correlation_lag_changes_pairs():
    sid = "n"
    entries = [
        _entry("2026-06-01", numbers={sid: 1.0}, mood=1),
        _entry("2026-06-02", numbers={sid: 2.0}, mood=2),
        _entry("2026-06-03", numbers={sid: 3.0}, mood=3),
    ]
    lag0 = journal.lagged_correlation(entries, ("numeric", sid), lag=0)
    lag1 = journal.lagged_correlation(entries, ("numeric", sid), lag=1)
    assert lag0["n"] == 3   # same-day: 3 pairs
    assert lag1["n"] == 2   # shifted: 2 pairs


def test_lagged_tag_uplift_after_mean_vs_baseline():
    sid = "people"
    # tag "gym" on 06-01, 06-03; the DAY AFTER (06-02, 06-04) has mood 6.
    entries = [
        _entry("2026-06-01", tags={sid: ["gym"]}, mood=3),
        _entry("2026-06-02", tags={}, mood=6),
        _entry("2026-06-03", tags={sid: ["gym"]}, mood=3),
        _entry("2026-06-04", tags={}, mood=6),
        _entry("2026-06-05", tags={}, mood=2),
    ]
    got = journal.lagged_tag_uplift(entries, lag=1, min_n=2)
    row = [r for r in got if r["name"] == "gym"][0]
    assert row["n"] == 2                 # 06-02 and 06-04 moods
    assert row["after_mean"] == 6
    # baseline = mean of all in-range moods with a value = (3+6+3+6+2)/5 = 4
    assert row["baseline"] == 4
    assert row["uplift"] == 2
    assert row["section_id"] == sid


def test_lagged_tag_uplift_min_n_gate():
    sid = "people"
    entries = [
        _entry("2026-06-01", tags={sid: ["rare"]}, mood=3),
        _entry("2026-06-02", tags={}, mood=6),
    ]
    got = journal.lagged_tag_uplift(entries, lag=1, min_n=2)
    assert [r for r in got if r["name"] == "rare"] == []


def test_lagged_difficulty_effect_after_hard_task():
    # Hard task completed 06-01 and 06-03; day-after moods are high.
    tasks = {
        "archive": [
            {"completed": "2026-06-01T20:00:00", "difficulty": "hard"},
            {"completed": "2026-06-03T20:00:00", "difficulty": "hard"},
            {"completed": "2026-06-02T20:00:00", "difficulty": "easy"},
        ]
    }
    entries = [
        _entry("2026-06-01", mood=3),
        _entry("2026-06-02", mood=7),   # day after a hard task
        _entry("2026-06-03", mood=3),
        _entry("2026-06-04", mood=7),   # day after a hard task
        _entry("2026-06-05", mood=1),
    ]
    got = journal.lagged_difficulty_effect(entries, tasks, lag=1, min_n=2)
    assert got["n"] == 2
    assert got["after_mean"] == 7
    assert got["baseline"] == 4.2       # (3+7+3+7+1)/5
    assert round(got["uplift"], 6) == round(7 - 4.2, 6)


def test_lagged_difficulty_effect_min_n_gate():
    tasks = {"archive": [{"completed": "2026-06-01T20:00:00", "difficulty": "hard"}]}
    entries = [_entry("2026-06-01", mood=3), _entry("2026-06-02", mood=6)]
    got = journal.lagged_difficulty_effect(entries, tasks, lag=1, min_n=2)
    assert got is None


def test_leading_indicators_ranks_and_drops_sub_min_n():
    sid = "n"
    # A strong numeric predictor with enough pairs, plus a weak/sparse one.
    entries = [
        _entry("2026-06-01", numbers={sid: 1.0}, mood=1),
        _entry("2026-06-02", numbers={sid: 2.0}, mood=2),
        _entry("2026-06-03", numbers={sid: 3.0}, mood=3),
        _entry("2026-06-04", numbers={sid: 4.0}, mood=4),
        _entry("2026-06-05", numbers={sid: 5.0}, mood=5),
        _entry("2026-06-06", numbers={sid: 6.0}, mood=6),
    ]
    got = journal.leading_indicators(entries, lag=1, min_n=5)
    # numeric predictor has 5 lagged pairs (D->D+1 for 06-01..06-05) -> qualifies
    kinds = [row["kind"] for row in got]
    assert "numeric" in kinds
    num = [r for r in got if r["kind"] == "numeric"][0]
    assert num["n"] == 5
    assert num["key"] == sid
    assert num["direction"] in ("+", "-")


def test_leading_indicators_empty_when_nothing_qualifies():
    entries = [
        _entry("2026-06-01", numbers={"n": 1.0}, mood=1),
        _entry("2026-06-02", numbers={"n": 2.0}, mood=2),
    ]
    # min_n high enough that no predictor reaches it
    assert journal.leading_indicators(entries, lag=1, min_n=5) == []


def test_leading_indicators_merges_continuous_and_categorical():
    sid_num = "n"
    sid_tag = "people"
    tasks = {"archive": [
        {"completed": "2026-06-0%dT20:00:00" % d, "difficulty": "hard"}
        for d in range(1, 6)
    ]}
    entries = []
    for i in range(1, 8):
        d = "2026-06-%02d" % i
        entries.append(_entry(d, numbers={sid_num: float(i)},
                              tags={sid_tag: ["gym"]}, mood=i if i <= 7 else 7))
    got = journal.leading_indicators(entries, lag=1, min_n=2, tasks=tasks)
    kinds = set(r["kind"] for r in got)
    assert "numeric" in kinds
    assert "tag" in kinds
    # sorted by magnitude descending
    mags = [abs(r.get("r", r.get("uplift", 0))) for r in got]
    assert mags == sorted(mags, reverse=True)


def test_lag_profile_r_per_lag_and_peak():
    sid = "n"
    # Build so the correlation peaks at lag=1 (pred[D] == mood[D+1]).
    entries = [
        _entry("2026-06-01", numbers={sid: 1.0}, mood=9),
        _entry("2026-06-02", numbers={sid: 2.0}, mood=1),
        _entry("2026-06-03", numbers={sid: 3.0}, mood=2),
        _entry("2026-06-04", numbers={sid: 4.0}, mood=3),
        _entry("2026-06-05", numbers={sid: 5.0}, mood=4),
        _entry("2026-06-06", numbers={sid: 6.0}, mood=5),
    ]
    prof = journal.lag_profile(entries, ("numeric", sid), lags=(0, 1, 2, 3))
    lags = [p["lag"] for p in prof]
    assert lags == [0, 1, 2, 3]
    # lag=1 should give a perfect +1 (pred[D]=i -> mood[D+1]=i)
    lag1 = [p for p in prof if p["lag"] == 1][0]
    assert round(lag1["r"], 6) == 1.0
    assert lag1["n"] == 5
