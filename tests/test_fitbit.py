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


import json as _json
from urllib.parse import urlparse, parse_qs


def test_build_authorize_url():
    url = fitbit.build_authorize_url("CID", "http://127.0.0.1:5001/cb", "xyz")
    q = parse_qs(urlparse(url).query)
    assert url.startswith("https://www.fitbit.com/oauth2/authorize")
    assert q["client_id"] == ["CID"] and q["scope"] == ["sleep"]
    assert q["state"] == ["xyz"] and q["response_type"] == ["code"]
    assert q["redirect_uri"] == ["http://127.0.0.1:5001/cb"]


def _fake_transport(expect_url_contains, response, status=200, sink=None):
    def t(method, url, headers, body):
        if sink is not None:
            sink.append((method, url, headers, body))
        assert expect_url_contains in url
        return status, response
    return t


def test_exchange_code_returns_tokens():
    resp = {"access_token": "A", "refresh_token": "R",
            "scope": "sleep", "expires_in": 28800}
    sink = []
    t = _fake_transport("oauth2/token", resp, sink=sink)
    tokens = fitbit.exchange_code("CID", "SEC", "CODE",
                                  "http://127.0.0.1:5001/cb", transport=t, now=1000.0)
    assert tokens["access_token"] == "A" and tokens["expires_at"] == 1000.0 + 28800
    # HTTP Basic auth header present
    _, _, headers, body = sink[0]
    assert headers["Authorization"].startswith("Basic ")
    assert "grant_type=authorization_code" in body


def test_refresh_tokens():
    resp = {"access_token": "A2", "refresh_token": "R2",
            "scope": "sleep", "expires_in": 28800}
    t = _fake_transport("oauth2/token", resp)
    tokens = fitbit.refresh_tokens("CID", "SEC", "R", transport=t, now=5.0)
    assert tokens["access_token"] == "A2" and tokens["refresh_token"] == "R2"


def test_fetch_sleep_calls_dated_endpoint():
    sink = []
    t = _fake_transport("/sleep/date/2026-06-29.json", STAGED, sink=sink)
    raw = fitbit.fetch_sleep("ACCESS", "2026-06-29", transport=t)
    assert raw == STAGED
    _, url, headers, _ = sink[0]
    assert headers["Authorization"] == "Bearer ACCESS"
    assert url.endswith("/1.2/user/-/sleep/date/2026-06-29.json")
