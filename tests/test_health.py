from datetime import datetime

import health

NOW = datetime(2026, 7, 7, 2, 5, 0)


def test_parse_push_single_day_steps_and_hr_summary():
    out = health.parse_push({
        "date": "2026-07-06",
        "steps": "12345",
        "resting_hr": "58",
        "heart_rate": [
            {"time": "08:00", "bpm": 70},
            {"timestamp": "2026-07-06T13:30:00", "value": "92"},
        ],
    }, now=NOW)

    assert len(out) == 1
    day = out[0]
    assert day["date"] == "2026-07-06"
    assert day["steps"] == 12345
    assert day["resting_hr"] == 58
    assert day["avg_hr"] == 81
    assert day["min_hr"] == 70
    assert day["max_hr"] == 92
    assert day["heart_rate_samples"] == [
        {"time": "08:00", "bpm": 70},
        {"time": "13:30", "bpm": 92},
    ]
    assert day["source"] == "xiaomi"
    assert day["fetched"] == "2026-07-07T02:05:00"


def test_parse_push_list_skips_invalid_days_and_preserves_source():
    out = health.parse_push([
        {"date": "2026-07-06", "steps": 100, "source": "health_connect"},
        {"date": "not-a-date", "steps": 200},
    ], now=NOW)

    assert [d["date"] for d in out] == ["2026-07-06"]
    assert out[0]["source"] == "health_connect"


def test_parse_push_clamps_junk_and_uses_explicit_average():
    out = health.parse_push({
        "date": "2026-07-06",
        "steps": -50,
        "avg_hr": 77,
        "heart_rate_samples": [
            {"time": "bad", "bpm": 70},
            {"time": "10:00", "bpm": -10},
        ],
    }, now=NOW)[0]

    assert out["steps"] == 0
    assert out["avg_hr"] == 77
    assert out["heart_rate_samples"] == []


def test_parse_push_rejects_junk_payload():
    assert health.parse_push(None, now=NOW) == []
    assert health.parse_push("nope", now=NOW) == []
