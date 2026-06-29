import spotify
from datetime import datetime
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


# ---------------------------------------------------------------------------
# Pure parse / merge / summarize / taste helpers
# ---------------------------------------------------------------------------

RP = {"items": [
    {"played_at": "2026-06-29T22:10:00.000Z",
     "track": {"id": "t1", "name": "Song A", "duration_ms": 200000,
               "artists": [{"name": "Phoebe Bridgers"}]}},
    {"played_at": "2026-06-29T21:00:00.000Z",
     "track": {"id": "t2", "name": "Song B", "duration_ms": 180000,
               "artists": [{"name": "Phoebe Bridgers"}, {"name": "Boygenius"}]}},
]}


def test_parse_recently_played():
    plays = spotify.parse_recently_played(RP)
    assert plays[0]["track_id"] == "t1" and plays[0]["date"] == "2026-06-29"
    assert plays[0]["duration_ms"] == 200000
    assert plays[1]["artists"] == ["Phoebe Bridgers", "Boygenius"]


def test_merge_plays_dedupes_and_prunes():
    plays = spotify.parse_recently_played(RP)
    buf = spotify.merge_plays({}, plays, now=datetime(2026, 6, 29, 23, 0, 0))
    # re-merge the same plays -> no duplicates
    buf = spotify.merge_plays(buf, plays, now=datetime(2026, 6, 29, 23, 0, 0))
    assert len(buf["2026-06-29"]) == 2
    # an old play is pruned (keep_days=3 from 2026-06-29)
    old = [{"played_at": "2026-06-01T10:00:00.000Z", "date": "2026-06-01",
            "track_id": "x", "name": "Old", "artists": ["Y"], "duration_ms": 1000}]
    buf2 = spotify.merge_plays(buf, old, now=datetime(2026, 6, 29, 23, 0, 0))
    assert "2026-06-01" not in buf2


def test_summarize_day_counts_and_artists():
    plays = spotify.parse_recently_played(RP)
    s = spotify.summarize_day(plays)
    assert s["tracks"] == 2 and s["distinct"] == 2
    assert s["minutes"] == round(380000 / 60000)   # 6
    assert s["top_artists"][0] == {"name": "Phoebe Bridgers", "count": 2}
    assert s["valence"] is None   # no audio features supplied


def test_summarize_day_audio_feature_means():
    plays = spotify.parse_recently_played(RP)
    feats = {"audio_features": [
        {"id": "t1", "valence": 0.6, "energy": 0.8, "danceability": 0.5, "tempo": 120},
        {"id": "t2", "valence": 0.4, "energy": 0.6, "danceability": 0.7, "tempo": 100}]}
    s = spotify.summarize_day(plays, audio_features=feats)
    assert s["valence"] == 0.5 and s["energy"] == 0.7
    assert s["tempo"] == 110


def test_build_taste_genres_from_artists():
    tops = {
        "tracks": {"short_term": {"items": [{"name": "Song A"}]},
                   "medium_term": {"items": []}, "long_term": {"items": []}},
        "artists": {"short_term": {"items": [
                        {"name": "Phoebe Bridgers", "genres": ["indie", "folk"]},
                        {"name": "Boygenius", "genres": ["indie"]}]},
                    "medium_term": {"items": []}, "long_term": {"items": []}},
    }
    taste = spotify.build_taste(tops)
    assert taste["tracks"]["short_term"] == ["Song A"]
    assert taste["artists"]["short_term"][0] == "Phoebe Bridgers"
    assert taste["genres"]["short_term"][0] == "indie"   # most common
