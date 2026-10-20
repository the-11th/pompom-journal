"""Spotify Web API client. Zero Flask imports.

OAuth is delegated to oauth.py (Authorization Code Grant, HTTP Basic). Network
is behind the injectable transport (default oauth.urllib_transport); tests pass
a fake so no test hits the network.
"""
import urllib.parse
from datetime import datetime, timedelta

import oauth

_AUTHORIZE = "https://accounts.spotify.com/authorize"
_TOKEN = "https://accounts.spotify.com/api/token"
_API = "https://api.spotify.com"
_SCOPE = ("user-read-recently-played user-top-read user-read-playback-state "
          "user-read-currently-playing user-library-read playlist-read-private "
          "playlist-read-collaborative user-follow-read user-read-playback-position")


def build_authorize_url(client_id, redirect_uri, state):
    return oauth.build_authorize_url(_AUTHORIZE, client_id, redirect_uri, state, _SCOPE)


def exchange_code(client_id, client_secret, code, redirect_uri, transport=None, now=None):
    return oauth.exchange_code(_TOKEN, client_id, client_secret, code, redirect_uri,
                               transport=transport, now=now)


def refresh_tokens(client_id, client_secret, refresh_token, transport=None, now=None, prev=None):
    return oauth.refresh_tokens(_TOKEN, client_id, client_secret, refresh_token,
                                transport=transport, now=now,
                                prev=prev or {"refresh_token": refresh_token})


def token_expired(tokens, now=None):
    return oauth.token_expired(tokens, now=now)


def _get(access_token, path, transport):
    transport = transport or oauth.urllib_transport
    headers = {"Authorization": f"Bearer {access_token}"}
    status, payload = transport("GET", f"{_API}{path}", headers, None)
    return status, payload


def fetch_recently_played(access_token, transport=None):
    status, payload = _get(access_token, "/v1/me/player/recently-played?limit=50", transport)
    return _expect_json(status, payload, "recently-played")


def fetch_top(access_token, kind, time_range, transport=None):
    q = urllib.parse.urlencode({"time_range": time_range, "limit": 20})
    status, payload = _get(access_token, f"/v1/me/top/{kind}?{q}", transport)
    return _expect_json(status, payload, "top")


def fetch_audio_features(access_token, ids, transport=None):
    """Audio features for up to 100 track ids. Returns None on 403 (the
    endpoint is deprecated for apps created after Nov 2024)."""
    if not ids:
        return {"audio_features": []}
    q = urllib.parse.urlencode({"ids": ",".join(ids)})
    status, payload = _get(access_token, f"/v1/audio-features?{q}", transport)
    if status == 403:
        return None
    return _expect_json(status, payload, "audio-features")


def _expect_json(status, payload, label, allow_empty=False):
    if status == 204 and allow_empty:
        return {}
    if status == 401:
        raise PermissionError("Spotify token expired")
    if status != 200:
        raise RuntimeError(f"Spotify {label} error {status}: {payload}")
    return payload or {}


def fetch_playback_state(access_token, transport=None):
    status, payload = _get(access_token, "/v1/me/player", transport)
    return _expect_json(status, payload, "playback-state", allow_empty=True)


def fetch_currently_playing(access_token, transport=None):
    status, payload = _get(access_token, "/v1/me/player/currently-playing", transport)
    return _expect_json(status, payload, "currently-playing", allow_empty=True)


def fetch_queue(access_token, transport=None):
    status, payload = _get(access_token, "/v1/me/player/queue", transport)
    return _expect_json(status, payload, "queue")


def fetch_devices(access_token, transport=None):
    status, payload = _get(access_token, "/v1/me/player/devices", transport)
    return _expect_json(status, payload, "devices")


def fetch_saved_tracks(access_token, transport=None):
    status, payload = _get(access_token, "/v1/me/tracks?limit=50", transport)
    return _expect_json(status, payload, "saved-tracks")


def fetch_saved_albums(access_token, transport=None):
    status, payload = _get(access_token, "/v1/me/albums?limit=50", transport)
    return _expect_json(status, payload, "saved-albums")


def fetch_saved_episodes(access_token, transport=None):
    status, payload = _get(access_token, "/v1/me/episodes?limit=50", transport)
    return _expect_json(status, payload, "saved-episodes")


def fetch_current_user_playlists(access_token, transport=None):
    status, payload = _get(access_token, "/v1/me/playlists?limit=50", transport)
    return _expect_json(status, payload, "playlists")


def fetch_playlist_items(access_token, playlist_id, transport=None):
    quoted = urllib.parse.quote(str(playlist_id), safe="")
    status, payload = _get(access_token, f"/v1/playlists/{quoted}/tracks?limit=100", transport)
    return _expect_json(status, payload, "playlist-items")


def fetch_followed_artists(access_token, transport=None):
    q = urllib.parse.urlencode({"type": "artist", "limit": 50})
    status, payload = _get(access_token, f"/v1/me/following?{q}", transport)
    return _expect_json(status, payload, "followed-artists")


# ---------------------------------------------------------------------------
# Pure parse / merge / summarize / taste helpers (no network, no clock except
# injectable now=None)
# ---------------------------------------------------------------------------

def _clean_dict(d):
    return {k: v for k, v in d.items() if v is not None}


def _artist_names(raw):
    return [a.get("name") for a in (raw or []) if isinstance(a, dict) and a.get("name")]


def _track_id(uri):
    if not uri:
        return None
    text = str(uri)
    if text.startswith("spotify:track:"):
        return text.rsplit(":", 1)[-1] or None
    if "/track/" in text:
        return text.split("/track/", 1)[1].split("?", 1)[0].split("/", 1)[0] or None
    return None


def _context(raw):
    if not isinstance(raw, dict):
        return None
    return _clean_dict({"type": raw.get("type"), "uri": raw.get("uri"),
                        "href": raw.get("href")})


def _album(raw):
    if not isinstance(raw, dict):
        return None
    out = {"id": raw.get("id"), "name": raw.get("name"),
           "release_date": raw.get("release_date"),
           "total_tracks": raw.get("total_tracks"),
           "album_type": raw.get("album_type"),
           "uri": raw.get("uri")}
    artists = _artist_names(raw.get("artists"))
    if artists:
        out["artists"] = artists
    return _clean_dict(out)


def _track(raw):
    if not isinstance(raw, dict):
        return {}
    album = _album(raw.get("album"))
    out = {
        "track_id": raw.get("id") or _track_id(raw.get("uri")),
        "name": raw.get("name"),
        "artists": _artist_names(raw.get("artists")),
        "duration_ms": raw.get("duration_ms", 0) or 0,
        "uri": raw.get("uri"),
        "type": raw.get("type"),
        "explicit": raw.get("explicit") if "explicit" in raw else None,
        "is_local": raw.get("is_local") if "is_local" in raw else None,
        "album": album,
    }
    return _clean_dict(out)


def _episode(raw):
    if not isinstance(raw, dict):
        return {}
    show = raw.get("show") if isinstance(raw.get("show"), dict) else {}
    return _clean_dict({
        "episode_id": raw.get("id") or (raw.get("uri") or "").split(":")[-1],
        "name": raw.get("name"),
        "duration_ms": raw.get("duration_ms", 0) or 0,
        "uri": raw.get("uri"),
        "show": show.get("name"),
        "release_date": raw.get("release_date"),
        "explicit": raw.get("explicit") if "explicit" in raw else None,
        "is_externally_hosted": raw.get("is_externally_hosted"),
    })


def _playable(raw):
    if not isinstance(raw, dict):
        return {}
    if raw.get("type") == "episode" or "show" in raw:
        return _episode(raw)
    return _track(raw)


def _device(raw):
    raw = raw if isinstance(raw, dict) else {}
    return {
        "id": raw.get("id"),
        "name": raw.get("name"),
        "type": raw.get("type"),
        "is_active": raw.get("is_active"),
        "is_private_session": raw.get("is_private_session"),
        "is_restricted": raw.get("is_restricted"),
        "volume_percent": raw.get("volume_percent"),
        "supports_volume": raw.get("supports_volume"),
    }


def parse_recently_played(payload):
    out = []
    for item in (payload or {}).get("items") or []:
        track = _track((item or {}).get("track"))
        played_at = (item or {}).get("played_at", "")
        play = {
            "played_at": played_at,
            "date": played_at[:10],
            "track_id": track.get("track_id"),
            "name": track.get("name"),
            "artists": track.get("artists") or [],
            "duration_ms": track.get("duration_ms", 0),
        }
        for key in ("album", "explicit", "is_local"):
            if key in track:
                play[key] = track[key]
        ctx = _context((item or {}).get("context"))
        if ctx:
            play["context"] = ctx
        out.append(play)
    return out


def parse_playback_state(payload):
    payload = payload or {}
    return _clean_dict({
        "timestamp": payload.get("timestamp"),
        "progress_ms": payload.get("progress_ms"),
        "is_playing": payload.get("is_playing"),
        "shuffle_state": payload.get("shuffle_state"),
        "repeat_state": payload.get("repeat_state"),
        "context": _context(payload.get("context")),
        "device": _device(payload.get("device")) if payload.get("device") else None,
        "item": _playable(payload.get("item")),
    })


def parse_queue(payload):
    payload = payload or {}
    return {
        "currently_playing": _playable(payload.get("currently_playing")),
        "queue": [_playable(item) for item in payload.get("queue") or [] if item],
    }


def parse_devices(payload):
    return [_device(d) for d in (payload or {}).get("devices") or []]


def parse_saved_tracks(payload):
    out = []
    for row in (payload or {}).get("items") or []:
        item = _track((row or {}).get("track"))
        if item:
            item["added_at"] = (row or {}).get("added_at")
            out.append(item)
    return out


def parse_saved_albums(payload):
    out = []
    for row in (payload or {}).get("items") or []:
        item = _album((row or {}).get("album"))
        if item:
            item["added_at"] = (row or {}).get("added_at")
            out.append(item)
    return out


def parse_saved_episodes(payload):
    out = []
    for row in (payload or {}).get("items") or []:
        item = _episode((row or {}).get("episode"))
        if item:
            item["added_at"] = (row or {}).get("added_at")
            out.append(item)
    return out


def parse_playlists(payload):
    out = []
    for pl in (payload or {}).get("items") or []:
        if not isinstance(pl, dict):
            continue
        owner = pl.get("owner") if isinstance(pl.get("owner"), dict) else {}
        tracks = pl.get("tracks") if isinstance(pl.get("tracks"), dict) else {}
        out.append(_clean_dict({
            "id": pl.get("id"),
            "name": pl.get("name"),
            "owner": owner.get("display_name") or owner.get("id"),
            "public": pl.get("public"),
            "collaborative": pl.get("collaborative"),
            "tracks_total": tracks.get("total"),
            "uri": pl.get("uri"),
        }))
    return out


def parse_playlist_items(payload):
    out = []
    for row in (payload or {}).get("items") or []:
        item = _playable((row or {}).get("track"))
        if item:
            item["added_at"] = (row or {}).get("added_at")
            added_by = (row or {}).get("added_by")
            if isinstance(added_by, dict):
                item["added_by"] = added_by.get("id")
            out.append(item)
    return out


def parse_followed_artists(payload):
    artists = ((payload or {}).get("artists") or {}).get("items") or []
    out = []
    for art in artists:
        if not isinstance(art, dict):
            continue
        followers = art.get("followers") if isinstance(art.get("followers"), dict) else {}
        out.append(_clean_dict({
            "id": art.get("id"),
            "name": art.get("name"),
            "genres": art.get("genres") or [],
            "followers": followers.get("total"),
            "popularity": art.get("popularity"),
            "uri": art.get("uri"),
        }))
    return out


def merge_plays(buffer, new_plays, now=None, keep_days=3):
    buf = {d: dict(plays) for d, plays in (buffer or {}).items()}
    for p in new_plays:
        date = p.get("date")
        if not date:
            continue
        buf.setdefault(date, {})[p["played_at"]] = p
    cutoff = ((now or datetime.now()).date() - timedelta(days=keep_days - 1)).isoformat()
    return {d: plays for d, plays in buf.items() if d >= cutoff}


def _feature_means(features_payload, track_ids):
    rows = (features_payload or {}).get("audio_features") if isinstance(features_payload, dict) else None
    if not rows:
        return {"valence": None, "energy": None, "danceability": None, "tempo": None}
    wanted = set(track_ids)
    picked = [f for f in rows if f and f.get("id") in wanted]
    if not picked:
        return {"valence": None, "energy": None, "danceability": None, "tempo": None}
    def mean(key, ndigits):
        vals = [f[key] for f in picked if f.get(key) is not None]
        return round(sum(vals) / len(vals), ndigits) if vals else None
    return {"valence": mean("valence", 3), "energy": mean("energy", 3),
            "danceability": mean("danceability", 3), "tempo": mean("tempo", 1)}


def summarize_day(plays, audio_features=None, now=None):
    track_ids = [p["track_id"] for p in plays if p.get("track_id")]
    minutes = round(sum(p.get("duration_ms", 0) for p in plays) / 60000)
    artist_counts = {}
    track_counts = {}
    album_counts = {}
    contexts = {}
    explicit_tracks = 0
    local_tracks = 0
    for p in plays:
        if p.get("name"):
            label = p["name"]
            artists = ", ".join(p.get("artists") or [])
            if artists:
                label = f"{label} · {artists}"
            track_counts[label] = track_counts.get(label, 0) + 1
        for a in p.get("artists") or []:
            artist_counts[a] = artist_counts.get(a, 0) + 1
        album = p.get("album")
        album_name = album.get("name") if isinstance(album, dict) else album
        if album_name:
            album_counts[album_name] = album_counts.get(album_name, 0) + 1
        context = p.get("context")
        context_type = context.get("type") if isinstance(context, dict) else context
        if context_type:
            contexts[context_type] = contexts.get(context_type, 0) + 1
        if p.get("explicit") is True:
            explicit_tracks += 1
        if p.get("is_local") is True:
            local_tracks += 1
    top = [{"name": n, "count": c} for n, c in artist_counts.items()]
    top.sort(key=lambda d: d["count"], reverse=True)
    top_tracks = [{"name": n, "count": c} for n, c in track_counts.items()]
    top_tracks.sort(key=lambda d: d["count"], reverse=True)
    top_albums = [{"name": n, "count": c} for n, c in album_counts.items()]
    top_albums.sort(key=lambda d: d["count"], reverse=True)
    feats = _feature_means(audio_features, track_ids)
    fetched = (now or datetime.now()).replace(microsecond=0).isoformat()
    return {
        "tracks": len(plays),
        "minutes": minutes,
        "distinct": len(set(track_ids)),
        "top_artists": top[:5],
        "top_tracks": top_tracks[:10],
        "top_albums": top_albums[:5],
        "contexts": contexts,
        "explicit_tracks": explicit_tracks,
        "local_tracks": local_tracks,
        "valence": feats["valence"],
        "energy": feats["energy"],
        "danceability": feats["danceability"],
        "tempo": feats["tempo"],
        "source": "spotify",
        "fetched": fetched,
    }


def parse_streaming_history(payload_or_list):
    if isinstance(payload_or_list, dict):
        rows = payload_or_list.get("items", payload_or_list.get("plays"))
    else:
        rows = payload_or_list
    if not isinstance(rows, list) or not rows:
        raise ValueError("Choose a history JSON file containing a list of plays")
    out = []
    for index, row in enumerate(rows, 1):
        if not isinstance(row, dict):
            raise ValueError(f"Invalid history row {index}: expected an object")
        played_at = row.get("ts") or row.get("endTime") or ""
        if not isinstance(played_at, str):
            raise ValueError(f"Invalid history row {index}: timestamp must be text")
        try:
            stamp = datetime.fromisoformat(played_at.replace("Z", "+00:00"))
            if stamp.date().isoformat() != played_at[:10]:
                raise ValueError()
        except ValueError as exc:
            raise ValueError(f"Invalid history row {index}: choose a valid timestamp") from exc
        name = row.get("master_metadata_track_name") or row.get("trackName")
        artist = row.get("master_metadata_album_artist_name") or row.get("artistName")
        album = row.get("master_metadata_album_album_name") or row.get("albumName")
        if any(value is not None and not isinstance(value, str) for value in (name, artist, album)):
            raise ValueError(f"Invalid history row {index}: names must be text")
        duration_ms = row.get("ms_played", row.get("msPlayed", 0))
        try:
            if isinstance(duration_ms, bool):
                raise ValueError()
            parsed_duration = int(duration_ms)
            if parsed_duration < 0 or float(duration_ms) != parsed_duration:
                raise ValueError()
            duration_ms = parsed_duration
        except (TypeError, ValueError, OverflowError) as exc:
            raise ValueError(f"Invalid history row {index}: play duration must be a non-negative integer") from exc
        play = {
            "played_at": played_at,
            "date": played_at[:10],
            "name": name,
            "artists": [artist] if artist else [],
            "album": {"name": album} if album else None,
            "duration_ms": duration_ms,
            "track_id": _track_id(row.get("spotify_track_uri") or row.get("spotifyTrackUri")),
            "source": "history_import",
        }
        for src, dest in (("platform", "platform"), ("reason_start", "reason_start"),
                          ("reason_end", "reason_end"), ("shuffle", "shuffle"),
                          ("skipped", "skipped"), ("offline", "offline")):
            if src in row:
                play[dest] = row[src]
        out.append(_clean_dict(play))
    return out


def group_plays_by_day(plays):
    grouped = {}
    for play in plays or []:
        date = play.get("date") or (play.get("played_at") or "")[:10]
        if not date:
            continue
        grouped.setdefault(date, []).append(play)
    return dict(sorted(grouped.items()))


_TERMS = ("short_term", "medium_term", "long_term")


def build_taste(tops, now=None):
    def names(payload):
        return [it.get("name") for it in (payload or {}).get("items") or [] if it.get("name")]
    tracks = {t: names((tops.get("tracks") or {}).get(t)) for t in _TERMS}
    artists = {t: names((tops.get("artists") or {}).get(t)) for t in _TERMS}
    genres = {}
    for t in _TERMS:
        counts = {}
        for art in ((tops.get("artists") or {}).get(t) or {}).get("items") or []:
            for g in art.get("genres") or []:
                counts[g] = counts.get(g, 0) + 1
        genres[t] = [g for g, _ in sorted(counts.items(), key=lambda kv: kv[1], reverse=True)][:10]
    fetched = (now or datetime.now()).replace(microsecond=0).isoformat()
    taste = {
        t: {"artists": artists[t], "tracks": tracks[t], "genres": genres[t]}
        for t in _TERMS
    }
    taste.update({"tracks": tracks, "artists": artists, "genres": genres,
                  "fetched": fetched})
    return taste
