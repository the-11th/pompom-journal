import oauth
from urllib.parse import urlparse, parse_qs


def _fake(expect_in, response, status=200, sink=None):
    def t(method, url, headers, body):
        if sink is not None:
            sink.append((method, url, headers, body))
        assert expect_in in url
        return status, response
    return t


def test_build_authorize_url():
    url = oauth.build_authorize_url(
        "https://example.com/authorize", "CID", "http://127.0.0.1/cb", "xyz", "sleep")
    q = parse_qs(urlparse(url).query)
    assert url.startswith("https://example.com/authorize?")
    assert q["client_id"] == ["CID"] and q["scope"] == ["sleep"]
    assert q["state"] == ["xyz"] and q["response_type"] == ["code"]
    assert q["redirect_uri"] == ["http://127.0.0.1/cb"]


def test_exchange_code_basic_auth_and_grant():
    resp = {"access_token": "A", "refresh_token": "R", "scope": "sleep", "expires_in": 3600}
    sink = []
    t = _fake("token", resp, sink=sink)
    tok = oauth.exchange_code("https://x/token", "CID", "SEC", "CODE",
                              "http://127.0.0.1/cb", transport=t, now=1000.0)
    assert tok["access_token"] == "A" and tok["expires_at"] == 1000.0 + 3600
    _, _, headers, body = sink[0]
    assert headers["Authorization"].startswith("Basic ")
    assert "grant_type=authorization_code" in body


def test_refresh_tokens():
    resp = {"access_token": "A2", "refresh_token": "R2", "scope": "s", "expires_in": 3600}
    tok = oauth.refresh_tokens("https://x/token", "CID", "SEC", "R",
                               transport=_fake("token", resp), now=5.0)
    assert tok["access_token"] == "A2"


def test_token_expired():
    assert oauth.token_expired({"expires_at": 1000.0}, now=2000.0) is True
    assert oauth.token_expired({"expires_at": 1000.0}, now=900.0) is False


def test_token_error_raises():
    import pytest
    with pytest.raises(RuntimeError):
        oauth.exchange_code("https://x/token", "C", "S", "CODE", "cb",
                            transport=_fake("token", {"error": "bad"}, status=400))
