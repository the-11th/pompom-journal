from datapom.integrations import google_health as gh
from urllib.parse import urlparse, parse_qs

STAGES = {"dataPoints": [{
    "sleep": {
        "interval": {"startTime": "2026-06-28T05:14:00Z", "startUtcOffset": "-25200s",
                     "endTime": "2026-06-28T12:58:00Z", "endUtcOffset": "-25200s"},
        "sleepType": "STAGES",
        "sleepStages": [
            {"stageType": "DEEP", "duration": "4260s"},    # 71m
            {"stageType": "LIGHT", "duration": "14400s"},  # 240m
            {"stageType": "REM", "duration": "5400s"},     # 90m
            {"stageType": "AWAKE", "duration": "1800s"}],  # 30m
        "sleepSummary": {"efficiency": 92}}}]}

CLASSIC = {"dataPoints": [{
    "sleep": {
        "interval": {"startTime": "2026-06-28T05:00:00Z", "startUtcOffset": "-25200s",
                     "endTime": "2026-06-28T12:00:00Z", "endUtcOffset": "-25200s"},
        "sleepType": "CLASSIC", "sleepStages": [],
        "sleepSummary": {"efficiency": 88}}}]}


def test_build_authorize_url_scope_and_extras():
    url = gh.build_authorize_url("CID", "http://127.0.0.1:5001/cb", "st8")
    q = parse_qs(urlparse(url).query)
    assert url.startswith("https://accounts.google.com/o/oauth2/v2/auth?")
    assert q["scope"] == ["https://www.googleapis.com/auth/googlehealth.sleep.readonly"]
    assert q["access_type"] == ["offline"] and q["prompt"] == ["consent"]


def test_parse_stages_record():
    s = gh.parse_sleep(STAGES)
    # local clock = UTC minus 7h (offset -25200s): 05:14Z -> 22:14 prev, 12:58Z -> 05:58
    assert s["start"] == "22:14" and s["end"] == "05:58"
    assert s["stages"] == {"deep": 71, "light": 240, "rem": 90, "wake": 30}
    assert s["duration_min"] == 71 + 240 + 90        # non-awake sum = 401
    assert s["efficiency"] == 92 and s["score"] is None and s["quality"] == 92
    assert s["source"] == "google"


def test_parse_classic_has_no_stages():
    s = gh.parse_sleep(CLASSIC)
    assert s["stages"] is None
    assert s["duration_min"] == 7 * 60   # interval fallback: 7h
    assert s["quality"] == 88


def test_parse_no_records_returns_none():
    assert gh.parse_sleep({"dataPoints": []}) is None


def test_parse_efficiency_absent_quality_none():
    data = {"dataPoints": [{"sleep": {
        "interval": {"startTime": "2026-06-28T05:00:00Z", "startUtcOffset": "0s",
                     "endTime": "2026-06-28T11:00:00Z", "endUtcOffset": "0s"},
        "sleepType": "CLASSIC", "sleepStages": [], "sleepSummary": {}}}]}
    s = gh.parse_sleep(data)
    assert s["efficiency"] is None and s["quality"] is None


def test_fetch_sleep_endpoint_filter_and_401():
    import pytest
    sink = []
    def t(method, url, headers, body):
        sink.append((url, headers)); return 200, {"dataPoints": []}
    gh.fetch_sleep("ACCESS", "2026-06-28", transport=t)
    url, headers = sink[0]
    assert url.startswith("https://health.googleapis.com/v4/users/me/dataTypes/sleep/dataPoints?")
    assert "civil_end_time" in url and "2026-06-28" in url
    assert headers["Authorization"] == "Bearer ACCESS"
    def t401(method, url, headers, body):
        return 401, {"error": "x"}
    with pytest.raises(PermissionError):
        gh.fetch_sleep("ACCESS", "2026-06-28", transport=t401)


def test_exchange_code_body_auth():
    resp = {"access_token": "A", "refresh_token": "R", "expires_in": 3600}
    sink = []
    def t(method, url, headers, body):
        sink.append((url, headers, body)); return 200, resp
    tok = gh.exchange_code("CID", "SEC", "CODE", "cb", transport=t, now=1.0)
    url, headers, body = sink[0]
    assert url == "https://oauth2.googleapis.com/token"
    assert "Authorization" not in headers and "client_secret=SEC" in body
    assert tok["access_token"] == "A"
