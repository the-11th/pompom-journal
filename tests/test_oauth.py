from integrations import oauth
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


def test_build_authorize_url_extra_params():
    url = oauth.build_authorize_url(
        "https://accounts.google.com/o/oauth2/v2/auth", "CID", "http://127.0.0.1/cb",
        "st8", "scope.x", extra={"access_type": "offline", "prompt": "consent"})
    q = parse_qs(urlparse(url).query)
    assert q["access_type"] == ["offline"] and q["prompt"] == ["consent"]
    assert q["scope"] == ["scope.x"] and q["state"] == ["st8"]


def test_exchange_code_body_auth_puts_creds_in_body():
    resp = {"access_token": "A", "refresh_token": "R", "scope": "s", "expires_in": 3600}
    sink = []
    def t(method, url, headers, body):
        sink.append((headers, body)); return 200, resp
    tok = oauth.exchange_code("https://x/token", "CID", "SEC", "CODE", "cb",
                              transport=t, now=1000.0, client_auth="body")
    headers, body = sink[0]
    assert "Authorization" not in headers
    assert "client_id=CID" in body and "client_secret=SEC" in body
    assert tok["access_token"] == "A"


def test_refresh_preserves_prev_refresh_token():
    # Google omits refresh_token on refresh; keep the stored one.
    resp = {"access_token": "A2", "scope": "s", "expires_in": 3600}  # no refresh_token
    def t(method, url, headers, body):
        return 200, resp
    tok = oauth.refresh_tokens("https://x/token", "CID", "SEC", "OLDR",
                               transport=t, now=5.0, client_auth="body",
                               prev={"refresh_token": "OLDR"})
    assert tok["access_token"] == "A2"
    assert tok["refresh_token"] == "OLDR"


def test_normalize_keeps_response_refresh_token_over_prev():
    raw = {"access_token": "A", "refresh_token": "NEW", "expires_in": 10}
    tok = oauth.normalize_token_response(raw, now=0.0, prev={"refresh_token": "OLD"})
    assert tok["refresh_token"] == "NEW"
