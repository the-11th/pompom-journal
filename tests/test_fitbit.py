# tests/test_fitbit.py
import time
import fitbit

STAGED = {
    "sleep": [{
        "isMainSleep": True,
        "dateOfSleep": "2026-06-29",
        "startTime": "2026-06-28T23:14:00.000",
        "endTime": "2026-06-29T06:58:00.000",
        "minutesAsleep": 431,
        "efficiency": 92,
        "type": "stages",
        "levels": {"summary": {
            "deep": {"minutes": 71}, "light": {"minutes": 240},
            "rem": {"minutes": 90}, "wake": {"minutes": 30}}},
    }],
}

CLASSIC = {
    "sleep": [{
        "isMainSleep": True, "dateOfSleep": "2026-06-29",
        "startTime": "2026-06-28T23:00:00.000",
        "endTime": "2026-06-29T06:00:00.000",
        "minutesAsleep": 400, "efficiency": 88, "type": "classic",
        "levels": {"summary": {
            "asleep": {"minutes": 400}, "restless": {"minutes": 20},
            "awake": {"minutes": 10}}},
    }],
}


def test_parse_staged_sleep():
    s = fitbit.parse_sleep(STAGED)
    assert s["start"] == "23:14" and s["end"] == "06:58"
    assert s["duration_min"] == 431 and s["efficiency"] == 92
    assert s["stages"] == {"deep": 71, "light": 240, "rem": 90, "wake": 30}
    assert s["score"] is None and s["quality"] == 92
    assert s["source"] == "fitbit"


def test_parse_classic_has_no_stages():
    s = fitbit.parse_sleep(CLASSIC)
    assert s["stages"] is None and s["quality"] == 88


def test_parse_prefers_main_sleep():
    data = {"sleep": [
        {"isMainSleep": False, "startTime": "2026-06-29T13:00:00.000",
         "endTime": "2026-06-29T13:30:00.000", "minutesAsleep": 30,
         "efficiency": 50, "type": "classic", "levels": {"summary": {}}},
        STAGED["sleep"][0],
    ]}
    assert fitbit.parse_sleep(data)["duration_min"] == 431


def test_parse_no_records_returns_none():
    assert fitbit.parse_sleep({"sleep": []}) is None


def test_parse_uses_score_when_present():
    data = {"sleep": [dict(STAGED["sleep"][0])], "sleepScore": 84}
    s = fitbit.parse_sleep(data)
    assert s["score"] == 84 and s["quality"] == 84


def test_normalize_token_response_sets_expiry():
    raw = {"access_token": "A", "refresh_token": "R",
           "scope": "sleep", "expires_in": 28800}
    t = fitbit.normalize_token_response(raw, now=1000.0)
    assert t["access_token"] == "A" and t["expires_at"] == 1000.0 + 28800


def test_token_expired():
    t = {"expires_at": 1000.0}
    assert fitbit.token_expired(t, now=2000.0) is True
    assert fitbit.token_expired(t, now=900.0) is False
