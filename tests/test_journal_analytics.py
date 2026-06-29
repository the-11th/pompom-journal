"""Tests for the pure analytics aggregation helpers in journal.py.

Fixed dates for determinism; no file I/O needed (helpers take plain lists).
Entry fixtures mirror the real entry shape: date, tags {sid: [names]},
numbers {sid: float}, body, created.
"""

import journal
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

    assert set(payload) == {"sections", "entries", "date_range",
                            "suggestions", "dormant"}
    s = payload["sections"][0]
    assert set(s) == {"id", "name", "type", "color", "tags", "unit"}
    assert s["name"] == "people" and s["tags"] == ["alex"]
    e = payload["entries"][0]
    assert set(e) == {"date", "tags", "numbers", "body", "created", "mood"}
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


def test_analytics_payload_carries_suggestions_and_dormant():
    """The payload exposes range-independent suggestion blocks with sane shapes."""
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
    assert isinstance(payload["suggestions"], list)
    assert isinstance(payload["dormant"], list)
    # "running"/"mountains" recur and are not tags -> suggested.
    sug_words = {s["word"] for s in payload["suggestions"]}
    assert "running" in sug_words
    for s in payload["suggestions"]:
        assert set(s) == {"word", "count"}
    for d in payload["dormant"]:
        assert set(d) == {"name", "section_id", "last_date", "days_since"}


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

def test_tag_suggestions_excludes_known_tags():
    data = journal._empty()
    sec = journal.add_section(data, "people", "tag", "#e0a955")
    journal.add_section_tag(data, sec["id"], "alex")
    journal.upsert_entry(
        data, "2026-06-10", "t", "alex alex running running",
        now=datetime(2026, 6, 10, 9, 0, 0),
    )
    got = journal.tag_suggestions(data)
    words = {s["word"] for s in got}
    assert "running" in words
    assert "alex" not in words   # already a registered tag


def test_tag_suggestions_excludes_archived_tags_case_insensitive():
    data = journal._empty()
    sec = journal.add_section(data, "people", "tag", "#e0a955")
    journal.add_section_tag(data, sec["id"], "alex")
    journal.remove_section_tag(data, sec["id"], "alex")   # -> archived_tags
    journal.upsert_entry(
        data, "2026-06-10", "t", "Alex Alex jogging jogging",
        now=datetime(2026, 6, 10, 9, 0, 0),
    )
    words = {s["word"] for s in journal.tag_suggestions(data)}
    assert "alex" not in words   # archived tag, still excluded
    assert "jogging" in words


def test_tag_suggestions_uses_data_entries_when_none():
    data = journal._empty()
    journal.add_section(data, "people", "tag", "#e0a955")
    journal.upsert_entry(
        data, "2026-06-10", "t", "swimming swimming",
        now=datetime(2026, 6, 10, 9, 0, 0),
    )
    got = journal.tag_suggestions(data)
    assert {"word": "swimming", "count": 2} in got


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
