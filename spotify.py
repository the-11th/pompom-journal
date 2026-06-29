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
_SCOPE = "user-read-recently-played user-top-read"


def build_authorize_url(client_id, redirect_uri, state):
    return oauth.build_authorize_url(_AUTHORIZE, client_id, redirect_uri, state, _SCOPE)


def exchange_code(client_id, client_secret, code, redirect_uri, transport=None, now=None):
    return oauth.exchange_code(_TOKEN, client_id, client_secret, code, redirect_uri,
                               transport=transport, now=now)


def refresh_tokens(client_id, client_secret, refresh_token, transport=None, now=None):
    return oauth.refresh_tokens(_TOKEN, client_id, client_secret, refresh_token,
                                transport=transport, now=now)


def token_expired(tokens, now=None):
    return oauth.token_expired(tokens, now=now)


def _get(access_token, path, transport):
    transport = transport or oauth.urllib_transport
    headers = {"Authorization": f"Bearer {access_token}"}
    status, payload = transport("GET", f"{_API}{path}", headers, None)
    return status, payload


def fetch_recently_played(access_token, transport=None):
    status, payload = _get(access_token, "/v1/me/player/recently-played?limit=50", transport)
    if status == 401:
        raise PermissionError("Spotify token expired")
    if status != 200:
        raise RuntimeError(f"Spotify recently-played error {status}: {payload}")
    return payload


def fetch_top(access_token, kind, time_range, transport=None):
    q = urllib.parse.urlencode({"time_range": time_range, "limit": 20})
    status, payload = _get(access_token, f"/v1/me/top/{kind}?{q}", transport)
    if status == 401:
        raise PermissionError("Spotify token expired")
    if status != 200:
        raise RuntimeError(f"Spotify top error {status}: {payload}")
    return payload


def fetch_audio_features(access_token, ids, transport=None):
    """Audio features for up to 100 track ids. Returns None on 403 (the
    endpoint is deprecated for apps created after Nov 2024)."""
    if not ids:
        return {"audio_features": []}
    q = urllib.parse.urlencode({"ids": ",".join(ids)})
    status, payload = _get(access_token, f"/v1/audio-features?{q}", transport)
    if status == 403:
        return None
    if status == 401:
        raise PermissionError("Spotify token expired")
    if status != 200:
        raise RuntimeError(f"Spotify audio-features error {status}: {payload}")
    return payload


# ---------------------------------------------------------------------------
# Pure parse / merge / summarize / taste helpers (no network, no clock except
# injectable now=None)
# ---------------------------------------------------------------------------

def parse_recently_played(payload):
    out = []
    for item in (payload or {}).get("items") or []:
        track = item.get("track") or {}
        played_at = item.get("played_at", "")
        out.append({
            "played_at": played_at,
            "date": played_at[:10],
            "track_id": track.get("id"),
            "name": track.get("name"),
            "artists": [a.get("name") for a in (track.get("artists") or []) if a.get("name")],
            "duration_ms": track.get("duration_ms", 0),
        })
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
    for p in plays:
        for a in p.get("artists") or []:
            artist_counts[a] = artist_counts.get(a, 0) + 1
    top = [{"name": n, "count": c} for n, c in artist_counts.items()]
    top.sort(key=lambda d: d["count"], reverse=True)
    feats = _feature_means(audio_features, track_ids)
    fetched = (now or datetime.now()).replace(microsecond=0).isoformat()
    return {
        "tracks": len(plays),
        "minutes": minutes,
        "distinct": len(set(track_ids)),
        "top_artists": top[:5],
        "valence": feats["valence"],
        "energy": feats["energy"],
        "danceability": feats["danceability"],
        "tempo": feats["tempo"],
        "source": "spotify",
        "fetched": fetched,
    }


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
    return {"tracks": tracks, "artists": artists, "genres": genres,
            "fetched": (now or datetime.now()).replace(microsecond=0).isoformat()}
