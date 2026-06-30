"""Generic OAuth2 Authorization-Code-Grant helpers (HTTP Basic client auth).

Zero Flask imports. Network is isolated behind an injectable `transport`
callable so no test hits the network. Endpoint URLs are passed in by each
provider (fitbit.py, spotify.py).
"""
import base64
import json
import time
import urllib.parse
import urllib.request
from datetime import datetime


def urllib_transport(method, url, headers, body):
    """Default real transport using urllib. Tests pass a fake instead."""
    data = body.encode("utf-8") if isinstance(body, str) else body
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8"))


def normalize_token_response(raw, now=None, prev=None):
    """Provider token JSON -> our tokens dict with an absolute `expires_at`.

    `refresh_token` falls back to `prev`'s when the response omits one (Google
    omits it on refresh; Spotify sometimes does too)."""
    t = now if now is not None else time.time()
    refresh = raw.get("refresh_token") or (prev or {}).get("refresh_token")
    return {
        "access_token": raw.get("access_token"),
        "refresh_token": refresh,
        "scope": raw.get("scope"),
        "expires_at": t + float(raw.get("expires_in", 0)),
        "fetched": datetime.now().replace(microsecond=0).isoformat(),
    }


def token_expired(tokens, now=None):
    """True when the access token is at/within 60 s of expiry."""
    t = now if now is not None else time.time()
    return t >= float((tokens or {}).get("expires_at", 0)) - 60


def build_authorize_url(authorize_url, client_id, redirect_uri, state, scope, extra=None):
    params = {
        "client_id": client_id,
        "response_type": "code",
        "scope": scope,
        "redirect_uri": redirect_uri,
        "state": state,
    }
    if extra:
        params.update(extra)
    return f"{authorize_url}?{urllib.parse.urlencode(params)}"


def _basic_auth(client_id, client_secret):
    raw = f"{client_id}:{client_secret}".encode("utf-8")
    return "Basic " + base64.b64encode(raw).decode("ascii")


def _post_token(token_url, client_id, client_secret, form, transport, now,
                client_auth, prev):
    transport = transport or urllib_transport
    headers = {"Content-Type": "application/x-www-form-urlencoded"}
    if client_auth == "body":
        form = dict(form, client_id=client_id, client_secret=client_secret)
    else:
        headers["Authorization"] = _basic_auth(client_id, client_secret)
    status, payload = transport("POST", token_url, headers, urllib.parse.urlencode(form))
    if status != 200:
        raise RuntimeError(f"OAuth token error {status}: {payload}")
    return normalize_token_response(payload, now=now, prev=prev)


def exchange_code(token_url, client_id, client_secret, code, redirect_uri,
                  transport=None, now=None, client_auth="basic"):
    return _post_token(token_url, client_id, client_secret, {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
    }, transport, now, client_auth, None)


def refresh_tokens(token_url, client_id, client_secret, refresh_token,
                   transport=None, now=None, client_auth="basic", prev=None):
    return _post_token(token_url, client_id, client_secret, {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
    }, transport, now, client_auth, prev)
