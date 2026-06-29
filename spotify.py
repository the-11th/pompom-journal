"""Spotify Web API client. Zero Flask imports.

OAuth is delegated to oauth.py (Authorization Code Grant, HTTP Basic). Network
is behind the injectable transport (default oauth.urllib_transport); tests pass
a fake so no test hits the network.
"""
import urllib.parse
from datetime import datetime

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
