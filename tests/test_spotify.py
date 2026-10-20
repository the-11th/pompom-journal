from datapom.integrations import spotify
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
    scopes = set(q["scope"][0].split())
    assert {"user-read-recently-played", "user-top-read"}.issubset(scopes)
    assert {"user-read-playback-state", "user-read-currently-playing",
            "user-library-read", "playlist-read-private",
            "playlist-read-collaborative", "user-follow-read",
            "user-read-playback-position"}.issubset(scopes)


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


def test_fetch_new_endpoints_and_204_empty():
    sink = []
    assert spotify.fetch_playback_state("ACCESS",
        transport=_fake("/v1/me/player", {}, status=204, sink=sink)) == {}
    assert spotify.fetch_currently_playing("ACCESS",
        transport=_fake("/v1/me/player/currently-playing", {}, status=204)) == {}
    spotify.fetch_queue("ACCESS", transport=_fake("/v1/me/player/queue", {"queue": []}))
    spotify.fetch_devices("ACCESS", transport=_fake("/v1/me/player/devices", {"devices": []}))
    spotify.fetch_saved_tracks("ACCESS", transport=_fake("/v1/me/tracks", {"items": []}))
    spotify.fetch_saved_albums("ACCESS", transport=_fake("/v1/me/albums", {"items": []}))
    spotify.fetch_saved_episodes("ACCESS", transport=_fake("/v1/me/episodes", {"items": []}))
    spotify.fetch_current_user_playlists("ACCESS", transport=_fake("/v1/me/playlists", {"items": []}))
    spotify.fetch_playlist_items("ACCESS", "pl1", transport=_fake("/v1/playlists/pl1/tracks", {"items": []}))
    spotify.fetch_followed_artists("ACCESS", transport=_fake("/v1/me/following", {"artists": {"items": []}}))
    assert sink[0][2]["Authorization"] == "Bearer ACCESS"


def test_fetch_new_endpoint_401_and_error():
    import pytest
    with pytest.raises(PermissionError):
        spotify.fetch_devices("ACCESS", transport=_fake("devices", {"error": "x"}, status=401))
    with pytest.raises(RuntimeError):
        spotify.fetch_saved_tracks("ACCESS", transport=_fake("tracks", {"error": "x"}, status=500))


# ---------------------------------------------------------------------------
# Pure parse / merge / summarize / taste helpers
# ---------------------------------------------------------------------------

RP = {"items": [
    {"played_at": "2026-06-29T22:10:00.000Z",
     "context": {"type": "playlist", "uri": "spotify:playlist:p1"},
     "track": {"id": "t1", "name": "Song A", "duration_ms": 200000,
               "explicit": True, "is_local": False,
               "album": {"id": "alb1", "name": "Album A"},
               "artists": [{"name": "Phoebe Bridgers"}]}},
    {"played_at": "2026-06-29T21:00:00.000Z",
     "track": {"id": "t2", "name": "Song B", "duration_ms": 180000,
               "album": {"name": "Album B"},
               "artists": [{"name": "Phoebe Bridgers"}, {"name": "Boygenius"}]}},
]}


def test_parse_recently_played():
    plays = spotify.parse_recently_played(RP)
    assert plays[0]["track_id"] == "t1" and plays[0]["date"] == "2026-06-29"
    assert plays[0]["duration_ms"] == 200000
    assert plays[0]["album"] == {"id": "alb1", "name": "Album A"}
    assert plays[0]["context"] == {"type": "playlist", "uri": "spotify:playlist:p1"}
    assert plays[0]["explicit"] is True and plays[0]["is_local"] is False
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
    assert s["top_tracks"][0] == {"name": "Song A · Phoebe Bridgers", "count": 1}
    assert s["top_albums"][0] == {"name": "Album A", "count": 1}
    assert s["contexts"] == {"playlist": 1}
    assert s["explicit_tracks"] == 1 and s["local_tracks"] == 0
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
    assert taste["short_term"]["tracks"] == ["Song A"]
    assert taste["short_term"]["artists"][0] == "Phoebe Bridgers"
    assert taste["short_term"]["genres"][0] == "indie"   # most common
    # Existing stored/readers shape remains available during the transition.
    assert taste["tracks"]["short_term"] == ["Song A"]


def test_parse_playback_queue_devices_and_library_shapes():
    track = {"id": "t1", "name": "Song A", "duration_ms": 200000,
             "explicit": True, "is_local": False,
             "album": {"id": "a1", "name": "Album A"},
             "artists": [{"id": "ar1", "name": "Artist A"}]}
    playback = spotify.parse_playback_state({
        "timestamp": 123, "progress_ms": 42, "is_playing": True,
        "shuffle_state": False, "repeat_state": "off",
        "context": {"type": "album", "uri": "spotify:album:a1"},
        "device": {"id": "d1", "name": "Kitchen", "type": "Speaker", "is_active": True},
        "item": track,
    })
    assert playback["item"]["track_id"] == "t1"
    assert playback["device"]["name"] == "Kitchen"
    assert playback["context"]["type"] == "album"

    queue = spotify.parse_queue({"currently_playing": track, "queue": [track]})
    assert queue["currently_playing"]["name"] == "Song A"
    assert queue["queue"][0]["album"]["name"] == "Album A"

    devices = spotify.parse_devices({"devices": [{"id": "d1", "name": "Kitchen",
        "type": "Speaker", "is_active": True, "volume_percent": 33}]})
    assert devices == [{"id": "d1", "name": "Kitchen", "type": "Speaker",
                        "is_active": True, "is_private_session": None,
                        "is_restricted": None, "volume_percent": 33,
                        "supports_volume": None}]

    assert spotify.parse_saved_tracks({"items": [{"added_at": "now", "track": track}]})[0]["name"] == "Song A"
    assert spotify.parse_saved_albums({"items": [{"added_at": "now", "album": {"id": "a1", "name": "Album A",
        "artists": [{"name": "Artist A"}], "total_tracks": 10, "release_date": "2020"}}]})[0]["total_tracks"] == 10
    assert spotify.parse_saved_episodes({"items": [{"added_at": "now", "episode": {"id": "e1",
        "name": "Episode", "duration_ms": 1000, "show": {"name": "Show"}}}]})[0]["show"] == "Show"
    assert spotify.parse_playlists({"items": [{"id": "p1", "name": "Mix", "public": False,
        "collaborative": True, "owner": {"display_name": "Me"}, "tracks": {"total": 3}}]})[0]["tracks_total"] == 3
    assert spotify.parse_playlist_items({"items": [{"added_at": "now", "track": track}]})[0]["track_id"] == "t1"
    assert spotify.parse_followed_artists({"artists": {"items": [{"id": "ar1", "name": "Artist A",
        "genres": ["indie"], "followers": {"total": 5}}]}})[0]["followers"] == 5


def test_parse_streaming_history_and_group_by_day():
    history = {"items": [
        {"ts": "2026-06-29T22:10:00Z", "master_metadata_track_name": "Song A",
         "master_metadata_album_artist_name": "Artist A",
         "master_metadata_album_album_name": "Album A", "ms_played": 123000,
         "spotify_track_uri": "spotify:track:t1", "platform": "ios",
         "reason_start": "trackdone", "reason_end": "fwdbtn",
         "shuffle": True, "skipped": False, "offline": False},
        {"endTime": "2026-06-30 01:05", "trackName": "Song B",
         "artistName": "Artist B", "albumName": "Album B", "msPlayed": "45000"},
    ]}
    plays = spotify.parse_streaming_history(history)
    assert plays[0]["source"] == "history_import"
    assert plays[0]["played_at"] == "2026-06-29T22:10:00Z"
    assert plays[0]["track_id"] == "t1" and plays[0]["duration_ms"] == 123000
    assert plays[0]["platform"] == "ios" and plays[0]["shuffle"] is True
    assert plays[1]["date"] == "2026-06-30"
    grouped = spotify.group_plays_by_day(plays)
    assert list(grouped) == ["2026-06-29", "2026-06-30"]
    assert grouped["2026-06-29"][0]["name"] == "Song A"
