import spotify
from urllib.parse import urlparse, parse_qs


def _fake(expect_in, response, status=200, sink=None):
    def t(method, url, headers, body):
        if sink is not None:
            sink.append((method, url, headers, body))
        assert expect_in in url
        return status, response
    return t


def test_build_authorize_url_scopes():
    url = spotify.build_authorize_url("CID", "http://127.0.0.1:5001/cb", "st8")
    q = parse_qs(urlparse(url).query)
    assert url.startswith("https://accounts.spotify.com/authorize?")
    assert q["client_id"] == ["CID"] and q["state"] == ["st8"]
    assert q["scope"] == ["user-read-recently-played user-top-read"]


def test_exchange_code_uses_spotify_token_url():
    resp = {"access_token": "A", "refresh_token": "R", "scope": "s", "expires_in": 3600}
    sink = []
    tok = spotify.exchange_code("CID", "SEC", "CODE", "cb",
                                transport=_fake("accounts.spotify.com/api/token", resp, sink=sink), now=1000.0)
    assert tok["access_token"] == "A" and tok["expires_at"] == 1000.0 + 3600
    assert sink[0][2]["Authorization"].startswith("Basic ")


def test_fetch_recently_played_bearer_and_endpoint():
    sink = []
    raw = spotify.fetch_recently_played("ACCESS",
        transport=_fake("/v1/me/player/recently-played", {"items": []}, sink=sink))
    assert raw == {"items": []}
    _, url, headers, _ = sink[0]
    assert headers["Authorization"] == "Bearer ACCESS"
    assert "limit=50" in url


def test_fetch_recently_played_401_raises():
    import pytest
    with pytest.raises(PermissionError):
        spotify.fetch_recently_played("ACCESS",
            transport=_fake("recently-played", {"error": "x"}, status=401))


def test_fetch_top_endpoint():
    sink = []
    spotify.fetch_top("ACCESS", "artists", "short_term",
                      transport=_fake("/v1/me/top/artists", {"items": []}, sink=sink))
    assert "time_range=short_term" in sink[0][1] and "limit=20" in sink[0][1]


def test_fetch_audio_features_403_returns_none():
    out = spotify.fetch_audio_features("ACCESS", ["a", "b"],
        transport=_fake("/v1/audio-features", {"error": "deprecated"}, status=403))
    assert out is None


def test_fetch_audio_features_empty_ids_no_call():
    called = []
    def t(*a):
        called.append(a)
        return 200, {}
    out = spotify.fetch_audio_features("ACCESS", [], transport=t)
    assert out == {"audio_features": []} and called == []
