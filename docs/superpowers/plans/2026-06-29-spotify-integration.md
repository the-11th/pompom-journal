# Spotify Integration Implementation Plan (Plan B of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a full Spotify listening integration (OAuth connect → per-day music data on each journal day → Music analytics tab + taste view), reusing the shared `oauth.py` / `integrations-sync.js` / analytics-tab groundwork landed in Plan A.

**Architecture:** Pure `spotify.py` (OAuth via `oauth.py` with Spotify endpoints; recently-played / top / audio-features fetch behind the injectable transport; pure parse + per-day aggregation + taste builder). Per-day listening lands on `entry["music"]`; the taste snapshot (top tracks/artists/genres by term) lives in `data/integrations.json` under `spotify.taste`. A rolling raw-plays buffer (also in the integrations store) lets re-syncs accumulate a day's plays without double-counting. A new **Music** analytics tab mirrors the Sleep/Productivity tabs.

**Tech Stack:** Python 3.12+ stdlib only (Flask + pytest; `urllib`), vanilla JS, server-rendered Jinja, JSON file storage.

## Global Constraints

- **No new runtime dependencies.** `requirements.txt` stays `flask==3.1.0` + `pytest==8.3.4`. HTTP via stdlib `urllib` (through `oauth.urllib_transport`).
- **Pure-logic / thin-HTTP split.** `spotify.py`, `integrations.py`, and the `journal.py` additions have ZERO Flask imports. Network behind the injectable `transport(method,url,headers,body) -> (status, json)` seam. **No test hits the network** (fake transports).
- **Injectable clock** (`now=None`) in time-sensitive logic.
- **Styling mandatory.** New UI uses `:root` CSS vars (no hardcoded theme colors), themed widgets, `window.confirmModal` for destructive actions. Add a `style.css` rule for any new class.
- **TDD.** Failing test first → watch fail → implement → watch pass → commit. Init stores via `_empty()`/`_seeded()`.
- **Tests run with:** `.venv/bin/python -m pytest`.
- **Secrets** (Spotify client secret + tokens) live only in gitignored `data/integrations.json`; never logged or rendered back (client-secret input is a password field with no value).
- **Spotify OAuth:** Authorization Code Grant via `oauth.py` (HTTP Basic, client secret); scopes `user-read-recently-played user-top-read`; authorize `https://accounts.spotify.com/authorize`, token `https://accounts.spotify.com/api/token`; redirect URI `http://127.0.0.1:5001/integrations/spotify/callback`.
- **Spotify per-day is forward-only** (recently-played caps at ~50 tracks / ~24h — no historical backfill); daily totals are best-effort.
- **Audio features degrade gracefully:** a 403 from `/v1/audio-features` (deprecated for apps created after Nov 2024) → store `None` for the feature fields and hide the feature-dependent charts; everything else still works.

## File Structure

- **New** `spotify.py` — OAuth wrappers (via `oauth.py`) + recently-played/top/audio-features fetch + pure parse/aggregate/taste.
- **New** `tests/test_spotify.py`.
- **Modify** `integrations.py` — `set_taste`/`get_taste` + raw-plays buffer accessors.
- **Modify** `journal.py` — `music` entry field + `set_entry_music` + analytics helpers + payload.
- **Modify** `app.py` — Spotify OAuth routes + taste endpoint + `_spotify_sync` + sync route.
- **Modify** `static/integrations-sync.js` — add the `spotify` registry entry + `renderMusic`.
- **Modify** `static/analytics.js` — Music tab (+ taste fetch).
- **Modify** `templates/integrations.html` — Spotify card.
- **Modify** `templates/journal_entry.html` — music panel row.
- **Modify** `static/style.css`, `CLAUDE.md`, and the test files.

---

## Task 1: `spotify.py` — OAuth wrappers + fetch (injectable transport)

**Files:**
- Create: `spotify.py`, `tests/test_spotify.py`

**Interfaces:**
- Consumes: `oauth.{build_authorize_url, exchange_code, refresh_tokens, token_expired, urllib_transport}`.
- Produces:
  - `build_authorize_url(client_id, redirect_uri, state) -> str` (scope `user-read-recently-played user-top-read`)
  - `exchange_code(client_id, client_secret, code, redirect_uri, transport=None, now=None) -> tokens`
  - `refresh_tokens(client_id, client_secret, refresh_token, transport=None, now=None) -> tokens`
  - `token_expired(tokens, now=None) -> bool`
  - `fetch_recently_played(access_token, transport=None) -> json` (401 → `PermissionError`)
  - `fetch_top(access_token, kind, time_range, transport=None) -> json` (`kind` in `{"tracks","artists"}`, `time_range` in `{"short_term","medium_term","long_term"}`; 401 → `PermissionError`)
  - `fetch_audio_features(access_token, ids, transport=None) -> json|None` (403 → `None`; empty ids → `{"audio_features": []}` without a call)

- [ ] **Step 1: Write failing tests**

```python
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
```

- [ ] **Step 2: Run to verify fail**

Run: `.venv/bin/python -m pytest tests/test_spotify.py -v`
Expected: FAIL (`ModuleNotFoundError: No module named 'spotify'`).

- [ ] **Step 3: Implement the OAuth/fetch half of `spotify.py`**

```python
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
```

- [ ] **Step 4: Run to verify pass**

Run: `.venv/bin/python -m pytest tests/test_spotify.py -v`
Expected: PASS (7 passed).

- [ ] **Step 5: Commit**

```bash
git add spotify.py tests/test_spotify.py
git commit -m "feat: spotify OAuth wrappers + fetch (recently-played/top/audio-features)"
```

---

## Task 2: `spotify.py` — pure parse, merge, summarize, taste

**Files:**
- Modify: `spotify.py`, `tests/test_spotify.py`

**Interfaces:**
- Produces:
  - `parse_recently_played(json) -> [{played_at, date, track_id, name, artists:[str], duration_ms}]` — **pure**; `played_at` is the raw ISO timestamp, `date` is its `YYYY-MM-DD` (local-naive, first 10 chars).
  - `merge_plays(buffer, new_plays, now=None, keep_days=3) -> dict` — **pure**; `buffer` is `{date: {played_at: play}}`; merges `new_plays` (dedup by `played_at` within a date), drops dates older than `keep_days` from today. Returns the new buffer.
  - `summarize_day(plays, audio_features=None, now=None) -> dict` — **pure**; one date's list of plays → `{tracks, minutes, distinct, top_artists:[{name,count}], valence, energy, danceability, tempo, source:"spotify", fetched}`. `minutes = round(sum(duration_ms)/60000)`; `distinct` = unique `track_id` count; `top_artists` by play count desc, top 5; feature fields are the mean over `audio_features` (a list of `{id: features}` or a `{"audio_features": [...]}` payload) for the day's track ids, or `None` when `audio_features` is None/empty.
  - `build_taste(tops, now=None) -> dict` — **pure**; `tops` is `{"tracks": {term: payload}, "artists": {term: payload}}` for terms `short_term/medium_term/long_term`; returns `{tracks:{term:[names]}, artists:{term:[names]}, genres:{term:[names]}, fetched}`. Genres are aggregated from each term's artist objects' `genres`, counted, top 10.

- [ ] **Step 1: Write failing tests**

```python
# append to tests/test_spotify.py
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
```

- [ ] **Step 2: Run to verify fail**

Run: `.venv/bin/python -m pytest tests/test_spotify.py -k "parse_recently or merge_plays or summarize or build_taste" -v`
Expected: FAIL (`AttributeError: ... parse_recently_played`).

- [ ] **Step 3: Implement the pure half of `spotify.py`**

```python
# add to spotify.py
from datetime import timedelta


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
```

- [ ] **Step 4: Run to verify pass**

Run: `.venv/bin/python -m pytest tests/test_spotify.py -v`
Expected: PASS (all spotify tests).

- [ ] **Step 5: Commit**

```bash
git add spotify.py tests/test_spotify.py
git commit -m "feat: spotify pure parse/merge/summarize/taste"
```

---

## Task 3: `integrations.py` — taste + plays-buffer accessors

**Files:**
- Modify: `integrations.py`
- Test: `tests/test_integrations.py`

**Interfaces:**
- Produces: `set_taste(data, name, taste) -> data` / `get_taste(data, name) -> dict|None` (provider `["taste"]`); `set_plays_buffer(data, name, buffer) -> data` / `get_plays_buffer(data, name) -> dict` (provider `["plays_buffer"]`, defaults `{}`). `clear_provider` also drops `taste` and `plays_buffer`.

- [ ] **Step 1: Write failing tests**

```python
# add to tests/test_integrations.py
def test_taste_roundtrip():
    d = I._empty()
    assert I.get_taste(d, "spotify") is None
    I.set_taste(d, "spotify", {"genres": {"short_term": ["indie"]}})
    assert I.get_taste(d, "spotify")["genres"]["short_term"] == ["indie"]


def test_plays_buffer_roundtrip_and_clear():
    d = I._empty()
    assert I.get_plays_buffer(d, "spotify") == {}
    I.set_plays_buffer(d, "spotify", {"2026-06-29": {"ts": {"track_id": "t1"}}})
    assert "2026-06-29" in I.get_plays_buffer(d, "spotify")
    I.clear_provider(d, "spotify")
    assert I.get_plays_buffer(d, "spotify") == {} and I.get_taste(d, "spotify") is None
```

- [ ] **Step 2: Run to verify fail**

Run: `.venv/bin/python -m pytest tests/test_integrations.py -k "taste or plays_buffer" -v`
Expected: FAIL (`AttributeError: ... set_taste`).

- [ ] **Step 3: Implement in `integrations.py`**

```python
def set_taste(data, name, taste):
    get_provider(data, name)["taste"] = taste
    return data


def get_taste(data, name):
    return get_provider(data, name).get("taste")


def set_plays_buffer(data, name, buffer):
    get_provider(data, name)["plays_buffer"] = buffer
    return data


def get_plays_buffer(data, name):
    return get_provider(data, name).get("plays_buffer") or {}
```

Extend `clear_provider` to also drop the new keys:

```python
def clear_provider(data, name):
    p = get_provider(data, name)
    p.pop("tokens", None)
    p.pop("last_sync", None)
    p.pop("oauth_state", None)
    p.pop("api_key", None)
    p.pop("taste", None)
    p.pop("plays_buffer", None)
    return data
```

- [ ] **Step 4: Run to verify pass**

Run: `.venv/bin/python -m pytest tests/test_integrations.py -v`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add integrations.py tests/test_integrations.py
git commit -m "feat: integrations spotify taste + plays-buffer accessors"
```

---

## Task 4: `journal.py` — music field, writer, analytics helpers, payload

**Files:**
- Modify: `journal.py`
- Test: `tests/test_journal.py`

**Interfaces:**
- Consumes: `get_entry_by_date`, `upsert_entry`, `_valid_date`, `_filter_entries_by_date`, `_entry_mood`.
- Produces:
  - `set_entry_music(data, date, value, now=None) -> entry` (get-or-create like `set_entry_sleep`; `value=None` clears).
  - `load()` defaults each entry's `music` to `None`.
  - `_entry_music(entry) -> dict|None` (usable when it has a dict with a truthy `tracks`).
  - `music_minutes_series(entries, start=None, end=None) -> [{date, minutes}]` sorted.
  - `music_tracks_series(entries, start=None, end=None) -> [{date, tracks}]` sorted.
  - `music_top_artists(entries, start=None, end=None) -> [{name, count}]` aggregated, top 10.
  - `music_feature_averages(entries, start=None, end=None) -> {valence, energy, danceability, tempo}` (each mean over days where present, or None).
  - `music_mood_pairs(entries, start=None, end=None) -> [{valence, mood}]` same-day, both present (valence not None and mood not None).
  - `music_stats(entries, start=None, end=None) -> {avg_minutes, total_tracks, days}` (None avg on empty).
  - `analytics_payload` entries gain `"music": _entry_music(e)`.

- [ ] **Step 1: Write failing tests**

```python
# add to tests/test_journal.py
def _entry_music(date, minutes, tracks=10, valence=None, artists=None):
    return {"date": date, "tags": {}, "numbers": {}, "body": "", "mood": None,
            "sleep": None, "rescuetime": None,
            "music": {"tracks": tracks, "minutes": minutes, "distinct": tracks,
                      "top_artists": artists or [{"name": "Phoebe Bridgers", "count": 3}],
                      "valence": valence, "energy": None, "danceability": None,
                      "tempo": None, "source": "spotify", "fetched": "x"}}


def test_set_entry_music_create_update_clear():
    data = journal._seeded()
    journal.set_entry_music(data, "2026-06-29", {"tracks": 10, "minutes": 40})
    assert journal.get_entry_by_date(data, "2026-06-29")["music"]["minutes"] == 40
    journal.set_entry_music(data, "2026-06-29", {"tracks": 12, "minutes": 55})
    assert journal.get_entry_by_date(data, "2026-06-29")["music"]["minutes"] == 55
    assert sum(e["date"] == "2026-06-29" for e in data["entries"]) == 1
    journal.set_entry_music(data, "2026-06-29", None)
    assert journal.get_entry_by_date(data, "2026-06-29")["music"] is None


def test_music_minutes_series_sorted():
    entries = [_entry_music("2026-06-29", 40), _entry_music("2026-06-28", 90)]
    assert journal.music_minutes_series(entries) == [
        {"date": "2026-06-28", "minutes": 90}, {"date": "2026-06-29", "minutes": 40}]


def test_music_top_artists_aggregated():
    e1 = _entry_music("2026-06-28", 40, artists=[{"name": "Phoebe Bridgers", "count": 3}])
    e2 = _entry_music("2026-06-29", 50, artists=[{"name": "Phoebe Bridgers", "count": 2},
                                                 {"name": "Boygenius", "count": 4}])
    top = journal.music_top_artists([e1, e2])
    assert top[0] == {"name": "Phoebe Bridgers", "count": 5}
    assert {"name": "Boygenius", "count": 4} in top


def test_music_mood_pairs_requires_valence_and_mood():
    e1 = _entry_music("2026-06-28", 40, valence=0.6); e1["mood"] = 5
    e2 = _entry_music("2026-06-29", 50, valence=None); e2["mood"] = 4  # no valence
    assert journal.music_mood_pairs([e1, e2]) == [{"valence": 0.6, "mood": 5}]


def test_music_feature_averages_skip_none():
    e1 = _entry_music("2026-06-28", 40, valence=0.6)
    e2 = _entry_music("2026-06-29", 50, valence=0.4)
    avg = journal.music_feature_averages([e1, e2])
    assert avg["valence"] == 0.5 and avg["energy"] is None


def test_music_stats_empty():
    assert journal.music_stats([]) == {"avg_minutes": None, "total_tracks": 0, "days": 0}


def test_load_defaults_music(tmp_path):
    p = tmp_path / "j.json"
    data = journal._seeded()
    journal.upsert_entry(data, "2026-06-29", "Day", "b")
    journal.save(str(p), data)
    assert journal.load(str(p))["entries"][0]["music"] is None


def test_payload_carries_music():
    data = journal._seeded()
    journal.set_entry_music(data, "2026-06-29", {"tracks": 10, "minutes": 40})
    p = journal.analytics_payload(data)
    assert p["entries"][0]["music"]["minutes"] == 40
```

- [ ] **Step 2: Run to verify fail**

Run: `.venv/bin/python -m pytest tests/test_journal.py -k "music or payload_carries_music" -v`
Expected: FAIL (`AttributeError: ... set_entry_music`).

- [ ] **Step 3: Implement**

In `load()`, beside `e.setdefault("rescuetime", None)`, add:

```python
            e.setdefault("music", None)
```

After `set_entry_rescuetime`, add:

```python
def set_entry_music(data, date, value, now=None):
    """Set (or clear, with value=None) the auto-filled Spotify music dict for
    `date`. Same get-or-create rule as set_entry_sleep."""
    if not _valid_date(date):
        raise ValueError(f"Invalid date: {date!r}")
    now = now or datetime.now()
    entry = get_entry_by_date(data, date)
    if entry is None:
        entry = upsert_entry(data, date, date, "", now=now)
    entry["music"] = value
    entry["updated"] = now.isoformat()
    return entry
```

Add the helpers near the rescuetime helpers:

```python
def _entry_music(entry):
    m = entry.get("music")
    if isinstance(m, dict) and m.get("tracks"):
        return m
    return None


def music_minutes_series(entries, start=None, end=None):
    out = []
    for e in _filter_entries_by_date(entries, start, end):
        m = _entry_music(e)
        if m:
            out.append({"date": e["date"], "minutes": m.get("minutes", 0)})
    out.sort(key=lambda d: d["date"])
    return out


def music_tracks_series(entries, start=None, end=None):
    out = []
    for e in _filter_entries_by_date(entries, start, end):
        m = _entry_music(e)
        if m:
            out.append({"date": e["date"], "tracks": m.get("tracks", 0)})
    out.sort(key=lambda d: d["date"])
    return out


def music_top_artists(entries, start=None, end=None):
    counts = {}
    for e in _filter_entries_by_date(entries, start, end):
        m = _entry_music(e)
        if not m:
            continue
        for a in m.get("top_artists") or []:
            counts[a["name"]] = counts.get(a["name"], 0) + a.get("count", 0)
    rows = [{"name": n, "count": c} for n, c in counts.items()]
    rows.sort(key=lambda d: d["count"], reverse=True)
    return rows[:10]


def music_feature_averages(entries, start=None, end=None):
    keys = ("valence", "energy", "danceability", "tempo")
    buckets = {k: [] for k in keys}
    for e in _filter_entries_by_date(entries, start, end):
        m = _entry_music(e)
        if not m:
            continue
        for k in keys:
            if m.get(k) is not None:
                buckets[k].append(m[k])
    return {k: (round(sum(v) / len(v), 3 if k != "tempo" else 1) if v else None)
            for k, v in buckets.items()}


def music_mood_pairs(entries, start=None, end=None):
    out = []
    for e in _filter_entries_by_date(entries, start, end):
        m = _entry_music(e)
        mood = _entry_mood(e)
        if m and m.get("valence") is not None and mood is not None:
            out.append({"valence": m["valence"], "mood": mood})
    return out


def music_stats(entries, start=None, end=None):
    rows = [_entry_music(e) for e in _filter_entries_by_date(entries, start, end)]
    rows = [m for m in rows if m]
    if not rows:
        return {"avg_minutes": None, "total_tracks": 0, "days": 0}
    mins = [m.get("minutes", 0) for m in rows]
    return {"avg_minutes": round(sum(mins) / len(mins)),
            "total_tracks": sum(m.get("tracks", 0) for m in rows),
            "days": len(rows)}
```

In `analytics_payload`, add `"music": _entry_music(e),` beside `"rescuetime"`.

- [ ] **Step 4: Run to verify pass**

Run: `.venv/bin/python -m pytest tests/test_journal.py -k "music or payload_carries_music" -v`
Expected: PASS.

- [ ] **Step 5: Full journal suite + commit**

```bash
.venv/bin/python -m pytest tests/test_journal.py tests/test_journal_analytics.py -q
git add journal.py tests/test_journal.py
git commit -m "feat: journal music field + analytics helpers + payload"
```

> Note: update `tests/test_journal_analytics.py::test_analytics_payload_shape` expected key set to include `"music"` (it currently lists `date, tags, numbers, body, created, mood, sleep, rescuetime`) in this commit.

---

## Task 5: `app.py` — Spotify OAuth routes + taste endpoint

**Files:**
- Modify: `app.py`
- Test: `tests/test_journal_app.py`

**Interfaces:**
- Consumes: `integrations.*`, `spotify.{build_authorize_url, exchange_code}`, `secrets`.
- Produces routes: `POST /integrations/spotify/credentials`, `GET /integrations/spotify/connect`, `GET /integrations/spotify/callback`, `POST /integrations/spotify/disconnect`, `GET /integrations/spotify/taste`. Helper `_spotify_redirect_uri()`. The callback kicks `_spotify_sync()` (defined in Task 6) — add a minimal `_spotify_sync` stub in THIS task that returns `{"connected": False, "synced": [], "errors": []}` so the attribute exists; Task 6 replaces its body.

These mirror the Fitbit routes exactly (see `app.py` `fitbit_credentials`/`fitbit_connect`/`fitbit_callback`/`fitbit_disconnect`). The `integrations_page` view must also pass Spotify status (`spotify_connected`, `spotify_has_creds`, `spotify_client_id`, `spotify_last_sync`, `spotify_redirect_uri`).

- [ ] **Step 1: Write failing tests**

```python
# add to tests/test_journal_app.py
def test_spotify_save_credentials_and_connect(client, app):
    client.post("/integrations/spotify/credentials",
                data={"client_id": "CID", "client_secret": "SEC"})
    d = I.load(app.config["INTEGRATIONS_FILE"])
    assert d["spotify"]["client_id"] == "CID"
    r = client.get("/integrations/spotify/connect")
    assert r.status_code == 302
    assert "accounts.spotify.com/authorize" in r.headers["Location"]
    assert "state=" in r.headers["Location"]


def test_spotify_callback_exchanges_code(client, app, monkeypatch):
    client.post("/integrations/spotify/credentials",
                data={"client_id": "CID", "client_secret": "SEC"})
    client.get("/integrations/spotify/connect")
    state = I.load(app.config["INTEGRATIONS_FILE"])["spotify"]["oauth_state"]
    monkeypatch.setattr("spotify.exchange_code",
        lambda *a, **k: {"access_token": "A", "refresh_token": "R",
                         "scope": "s", "expires_at": 9e9})
    monkeypatch.setattr("app._spotify_sync", lambda *a, **k: {"connected": True, "synced": [], "errors": []})
    r = client.get(f"/integrations/spotify/callback?code=C&state={state}")
    assert r.status_code == 302
    assert I.is_connected(I.load(app.config["INTEGRATIONS_FILE"]), "spotify")


def test_spotify_callback_state_mismatch(client, app):
    client.post("/integrations/spotify/credentials",
                data={"client_id": "CID", "client_secret": "SEC"})
    r = client.get("/integrations/spotify/callback?code=C&state=WRONG")
    assert r.status_code == 302
    assert not I.is_connected(I.load(app.config["INTEGRATIONS_FILE"]), "spotify")


def test_spotify_taste_endpoint(client, app):
    d = I.load(app.config["INTEGRATIONS_FILE"])
    I.set_taste(d, "spotify", {"genres": {"short_term": ["indie"]}})
    I.save(app.config["INTEGRATIONS_FILE"], d)
    body = client.get("/integrations/spotify/taste").get_json()
    assert body["genres"]["short_term"] == ["indie"]


def test_spotify_disconnect(client, app):
    d = I.load(app.config["INTEGRATIONS_FILE"])
    I.set_tokens(d, "spotify", {"access_token": "A", "refresh_token": "R"})
    I.save(app.config["INTEGRATIONS_FILE"], d)
    client.post("/integrations/spotify/disconnect")
    assert not I.is_connected(I.load(app.config["INTEGRATIONS_FILE"]), "spotify")
```

- [ ] **Step 2: Run to verify fail**

Run: `.venv/bin/python -m pytest tests/test_journal_app.py -k "spotify" -v`
Expected: FAIL (404 / missing route).

- [ ] **Step 3: Implement in `app.py`**

Add `import spotify` near the other integration imports. Add the minimal stub + routes:

```python
def _spotify_sync(force=False, focus_date=None, now=None):
    """Placeholder; fully implemented in the sync task."""
    return {"connected": False, "synced": [], "errors": []}


def _spotify_redirect_uri():
    return url_for("spotify_callback", _external=True)


@app.route("/integrations/spotify/credentials", methods=["POST"])
def spotify_credentials():
    data = integrations.load(integrations_file())
    integrations.set_credentials(
        data, "spotify",
        request.form.get("client_id", "").strip(),
        request.form.get("client_secret", "").strip())
    integrations.save(integrations_file(), data)
    flash("Spotify credentials saved.")
    return redirect(url_for("integrations_page"))


@app.route("/integrations/spotify/connect")
def spotify_connect():
    data = integrations.load(integrations_file())
    sp = integrations.get_provider(data, "spotify")
    if not (sp.get("client_id") and sp.get("client_secret")):
        flash("Enter your Spotify Client ID and Secret first.")
        return redirect(url_for("integrations_page"))
    state = secrets.token_urlsafe(16)
    sp["oauth_state"] = state
    integrations.save(integrations_file(), data)
    return redirect(spotify.build_authorize_url(sp["client_id"], _spotify_redirect_uri(), state))


@app.route("/integrations/spotify/callback")
def spotify_callback():
    data = integrations.load(integrations_file())
    sp = integrations.get_provider(data, "spotify")
    if request.args.get("error"):
        flash(f"Spotify authorization failed: {request.args.get('error')}")
        return redirect(url_for("integrations_page"))
    if not request.args.get("state") or request.args.get("state") != sp.get("oauth_state"):
        flash("Spotify authorization state mismatch; please try again.")
        return redirect(url_for("integrations_page"))
    try:
        tokens = spotify.exchange_code(
            sp["client_id"], sp["client_secret"],
            request.args.get("code"), _spotify_redirect_uri())
    except Exception as exc:  # noqa: BLE001
        flash(f"Spotify connection failed: {exc}")
        return redirect(url_for("integrations_page"))
    integrations.set_tokens(data, "spotify", tokens)
    sp.pop("oauth_state", None)
    integrations.save(integrations_file(), data)
    _spotify_sync()
    flash("Spotify connected.")
    return redirect(url_for("integrations_page"))


@app.route("/integrations/spotify/disconnect", methods=["POST"])
def spotify_disconnect():
    data = integrations.load(integrations_file())
    integrations.clear_provider(data, "spotify")
    integrations.save(integrations_file(), data)
    flash("Spotify disconnected.")
    return redirect(url_for("integrations_page"))


@app.route("/integrations/spotify/taste")
def spotify_taste():
    data = integrations.load(integrations_file())
    return jsonify(integrations.get_taste(data, "spotify") or {})
```

Extend `integrations_page`'s `render_template(...)` call with:

```python
        spotify_connected=integrations.is_connected(data, "spotify"),
        spotify_has_creds=bool(integrations.get_provider(data, "spotify").get("client_id")
                               and integrations.get_provider(data, "spotify").get("client_secret")),
        spotify_client_id=integrations.get_provider(data, "spotify").get("client_id", ""),
        spotify_last_sync=integrations.last_sync(data, "spotify"),
        spotify_redirect_uri=_spotify_redirect_uri(),
```

- [ ] **Step 4: Run to verify pass**

Run: `.venv/bin/python -m pytest tests/test_journal_app.py -k "spotify" -v`
Expected: PASS (5 passed).

- [ ] **Step 5: Commit**

```bash
git add app.py tests/test_journal_app.py
git commit -m "feat: Spotify OAuth routes + taste endpoint"
```

---

## Task 6: `app.py` — `_spotify_sync` orchestration + sync route

**Files:**
- Modify: `app.py`
- Test: `tests/test_journal_app.py`

**Interfaces:**
- Consumes: `integrations.*` (incl. `get_plays_buffer`/`set_plays_buffer`/`set_taste`), `spotify.{token_expired, refresh_tokens, fetch_recently_played, parse_recently_played, merge_plays, summarize_day, fetch_audio_features, fetch_top, build_taste}`, `journal.{load, save, set_entry_music}`.
- Produces: `_spotify_sync(force=False, focus_date=None, now=None) -> {connected, synced, errors}` (replaces the Task 5 stub); route `POST /integrations/spotify/sync` returning `{ok, connected, synced, errors, music:{<focus>: music|null}}` reading optional `?date=`.

**Sync logic:** not-connected short-circuit; refresh tokens if `spotify.token_expired` (and on a `PermissionError` from a fetch, refresh once + retry); fetch recently-played → `parse_recently_played` → `merge_plays` into the stored buffer (dedup + prune to 3 days); for each date in the merged buffer, fetch audio features for that day's track ids (`fetch_audio_features` → may be `None`), `summarize_day`, and `set_entry_music`; persist the buffer; refresh the taste snapshot (`fetch_top` for tracks+artists × 3 terms → `build_taste` → `set_taste`); set `last_sync`. Per-date and taste errors are caught into `errors[]` without aborting. The JSON envelope key is `music` (the `integrations-sync.js` registry uses `key: "music"`).

- [ ] **Step 1: Write failing tests**

```python
# add to tests/test_journal_app.py
_RP = {"items": [
    {"played_at": "2026-06-29T22:10:00.000Z",
     "track": {"id": "t1", "name": "A", "duration_ms": 200000,
               "artists": [{"name": "Phoebe Bridgers"}]}}]}


def _connect_spotify(app):
    d = I.load(app.config["INTEGRATIONS_FILE"])
    I.set_credentials(d, "spotify", "CID", "SEC")
    I.set_tokens(d, "spotify", {"access_token": "A", "refresh_token": "R", "expires_at": 9e9})
    I.save(app.config["INTEGRATIONS_FILE"], d)


def test_spotify_sync_writes_music(client, app, monkeypatch):
    _connect_spotify(app)
    monkeypatch.setattr("spotify.fetch_recently_played", lambda tok, transport=None: _RP)
    monkeypatch.setattr("spotify.fetch_audio_features", lambda tok, ids, transport=None: None)
    monkeypatch.setattr("spotify.fetch_top", lambda tok, kind, tr, transport=None: {"items": []})
    r = client.post("/integrations/spotify/sync?date=2026-06-29")
    body = r.get_json()
    assert body["ok"] and body["connected"]
    assert "2026-06-29" in body["synced"]
    import journal
    jdata = journal.load(app.config["JOURNAL_FILE"])
    assert journal.get_entry_by_date(jdata, "2026-06-29")["music"]["tracks"] == 1


def test_spotify_sync_not_connected(client, app):
    body = client.post("/integrations/spotify/sync").get_json()
    assert body["ok"] and body["connected"] is False


def test_spotify_sync_refreshes_taste(client, app, monkeypatch):
    _connect_spotify(app)
    monkeypatch.setattr("spotify.fetch_recently_played", lambda tok, transport=None: {"items": []})
    monkeypatch.setattr("spotify.fetch_audio_features", lambda tok, ids, transport=None: None)
    monkeypatch.setattr("spotify.fetch_top",
        lambda tok, kind, tr, transport=None: {"items": [{"name": "X", "genres": ["indie"]}]}
        if kind == "artists" else {"items": [{"name": "Song"}]})
    client.post("/integrations/spotify/sync")
    taste = I.get_taste(I.load(app.config["INTEGRATIONS_FILE"]), "spotify")
    assert taste["artists"]["short_term"] == ["X"]
```

- [ ] **Step 2: Run to verify fail**

Run: `.venv/bin/python -m pytest tests/test_journal_app.py -k "spotify_sync" -v`
Expected: FAIL (the stub returns connected False / no music written).

- [ ] **Step 3: Replace the `_spotify_sync` stub body in `app.py`**

```python
def _spotify_sync(force=False, focus_date=None, now=None):
    istore = integrations.load(integrations_file())
    if not integrations.is_connected(istore, "spotify"):
        return {"connected": False, "synced": [], "errors": []}
    sp = integrations.get_provider(istore, "spotify")
    tokens = sp["tokens"]
    cid, csecret = sp.get("client_id"), sp.get("client_secret")
    errors = []

    if spotify.token_expired(tokens) and tokens.get("refresh_token") and cid:
        try:
            tokens = spotify.refresh_tokens(cid, csecret, tokens["refresh_token"])
            integrations.set_tokens(istore, "spotify", tokens)
        except Exception:  # noqa: BLE001
            pass

    def _recent():
        try:
            return spotify.fetch_recently_played(tokens["access_token"])
        except PermissionError:
            if cid and tokens.get("refresh_token"):
                new = spotify.refresh_tokens(cid, csecret, tokens["refresh_token"])
                tokens.update(new)
                integrations.set_tokens(istore, "spotify", tokens)
                return spotify.fetch_recently_played(tokens["access_token"])
            raise

    jdata = journal.load(journal_file())
    synced = []
    try:
        plays = spotify.parse_recently_played(_recent())
        buffer = spotify.merge_plays(
            integrations.get_plays_buffer(istore, "spotify"), plays, now=now)
        integrations.set_plays_buffer(istore, "spotify", buffer)
        for date, by_ts in buffer.items():
            day_plays = list(by_ts.values())
            ids = [p["track_id"] for p in day_plays if p.get("track_id")]
            try:
                feats = spotify.fetch_audio_features(tokens["access_token"], ids)
            except Exception as exc:  # noqa: BLE001
                feats, _ = None, errors.append(f"features {date}: {exc}")
            journal.set_entry_music(jdata, date, spotify.summarize_day(day_plays, feats, now=now))
            synced.append(date)
        journal.save(journal_file(), jdata)
    except Exception as exc:  # noqa: BLE001
        errors.append(str(exc))

    # Taste snapshot (best-effort).
    try:
        terms = ("short_term", "medium_term", "long_term")
        tops = {"tracks": {}, "artists": {}}
        for kind in ("tracks", "artists"):
            for term in terms:
                tops[kind][term] = spotify.fetch_top(tokens["access_token"], kind, term)
        integrations.set_taste(istore, "spotify", spotify.build_taste(tops, now=now))
    except Exception as exc:  # noqa: BLE001
        errors.append(f"taste: {exc}")

    integrations.set_last_sync(istore, "spotify",
                               (now or datetime.now()).replace(microsecond=0).isoformat())
    integrations.save(integrations_file(), istore)
    return {"connected": True, "synced": synced, "errors": errors}


@app.route("/integrations/spotify/sync", methods=["POST"])
def spotify_sync_route():
    focus = request.args.get("date")
    result = _spotify_sync(focus_date=focus)
    music = {}
    if focus and result["connected"]:
        entry = journal.get_entry_by_date(journal.load(journal_file()), focus)
        music = {focus: (entry or {}).get("music")}
    return jsonify({"ok": True, **result, "music": music})
```

- [ ] **Step 4: Run to verify pass**

Run: `.venv/bin/python -m pytest tests/test_journal_app.py -k "spotify_sync" -v`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add app.py tests/test_journal_app.py
git commit -m "feat: Spotify sync orchestration (recently-played buffer + taste) + endpoint"
```

---

## Task 7: Spotify UI — settings card + entry panel row + sync registry

**Files:**
- Modify: `templates/integrations.html`, `templates/journal_entry.html`, `app.py` (`_render_entry` context), `static/integrations-sync.js`, `static/style.css`
- Test: `tests/test_journal_app.py`

**Interfaces:**
- Consumes: `integrations.is_connected(.., "spotify")`, `last_sync`, the entry's `music` field; the `integrations-sync.js` `PROVIDERS` registry.
- Produces: the Spotify settings card (OAuth connect, mirroring the Fitbit card), the entry-form `#spotify-panel` row (three states), the registry entry + `renderMusic`, and `_render_entry` passing the spotify context.

- [ ] **Step 1: Write failing route tests**

```python
# add to tests/test_journal_app.py
def test_integrations_page_has_spotify_card(client):
    r = client.get("/integrations")
    assert b"Spotify" in r.data


def test_entry_shows_connect_spotify_when_not_connected(client):
    r = client.get("/journal")
    assert b"Connect Spotify" in r.data
```

- [ ] **Step 2: Run to verify fail** — `.venv/bin/python -m pytest tests/test_journal_app.py -k "spotify_card or connect_spotify" -v` → FAIL.

- [ ] **Step 3: `_render_entry` context** — add to the `render_template` in `_render_entry`:

```python
        spotify_connected=integrations.is_connected(istore, "spotify"),
        spotify_last_sync=integrations.last_sync(istore, "spotify"),
        music=(entry or {}).get("music"),
```

- [ ] **Step 4: Spotify card in `templates/integrations.html`** (after the RescueTime `</section>`, mirroring the Fitbit OAuth card — credential form + Connect/Sync now/Disconnect):

```html
  <section class="integration-card">
    <h2>Spotify <span class="integration-status {{ 'on' if spotify_connected else 'off' }}">
      {{ 'Connected' if spotify_connected else 'Not connected' }}</span></h2>
    <p class="muted">Auto-fills daily listening (tracks, minutes, top artists, and
      — when available — audio features) into your journal, plus a taste view.
      Register an app at <code>developer.spotify.com</code> with redirect URL
      <code>{{ spotify_redirect_uri }}</code>.</p>
    <form method="post" action="{{ url_for('spotify_credentials') }}" class="integration-creds">
      <label>Client ID <input name="client_id" value="{{ spotify_client_id }}"></label>
      <label>Client Secret <input name="client_secret" type="password"></label>
      <button type="submit">Save credentials</button>
    </form>
    {% if spotify_has_creds and not spotify_connected %}
      <a class="btn" href="{{ url_for('spotify_connect') }}">Connect to Spotify</a>
    {% elif spotify_connected %}
      <p class="muted">Last synced: {{ spotify_last_sync or 'never' }}</p>
      <button type="button" id="spotify-sync-now" class="btn">Sync now</button>
      <form method="post" action="{{ url_for('spotify_disconnect') }}" style="display:inline">
        <button type="submit" class="btn danger"
                data-confirm="Disconnect Spotify and remove stored tokens?">Disconnect</button>
      </form>
    {% endif %}
  </section>
```

- [ ] **Step 5: Music panel row in `templates/journal_entry.html`** (sibling of `#rescuetime-panel`):

```html
  <div class="integ-row music-row" id="spotify-panel"
       data-date="{{ date }}"
       data-connected="{{ '1' if spotify_connected else '0' }}"
       data-last-sync="{{ spotify_last_sync or '' }}">
    {% if music %}
      <span class="music-icon">🎧</span>
      <span class="music-min">{{ music.minutes }} min</span>
      <span class="music-tracks">{{ music.tracks }} tracks</span>
      {% if music.top_artists %}<span class="music-artist">{{ music.top_artists[0].name }}</span>{% endif %}
    {% elif spotify_connected %}
      <span class="muted">No listening data for this day</span>
    {% else %}
      <a class="muted" href="{{ url_for('integrations_page') }}">Connect Spotify →</a>
    {% endif %}
  </div>
```

- [ ] **Step 6: Registry entry + `renderMusic` in `static/integrations-sync.js`**

Add the render function next to `renderRescuetime`:

```javascript
  function renderMusic(panel, m) {
    if (!m) return;
    const kids = [span("music-icon", "🎧"),
                  span("music-min", `${m.minutes} min`),
                  span("music-tracks", `${m.tracks} tracks`)];
    if (m.top_artists && m.top_artists[0]) kids.push(span("music-artist", m.top_artists[0].name));
    panel.replaceChildren(...kids);
  }
```

Add to the `PROVIDERS` array:

```javascript
    { name: "spotify", panelId: "spotify-panel", key: "music",
      syncPath: "/integrations/spotify/sync", render: renderMusic },
```

- [ ] **Step 7: `.music-row` styles in `static/style.css`** (mirror `.rt-row`, theme vars only):

```css
.music-row { display:flex; gap:.6rem; align-items:center; flex-wrap:wrap;
  font-size:.85rem; color:var(--muted); margin:.4rem 0; }
.music-row .music-min { color:var(--text); }
.music-row .music-artist { color:var(--accent); }
```

- [ ] **Step 8: Verify + commit**

```bash
node -c static/integrations-sync.js && echo "JS OK"
.venv/bin/python -m pytest tests/test_journal_app.py -q && .venv/bin/python -m pytest -q
git add app.py templates/integrations.html templates/journal_entry.html static/integrations-sync.js static/style.css tests/test_journal_app.py
git commit -m "feat: Spotify settings card + entry music panel row + sync registry"
```

---

## Task 8: Analytics **Music** tab

**Files:**
- Modify: `static/analytics.js`, `static/style.css` (if needed)
- Test: `tests/test_journal_analytics.py`, `tests/test_journal_app.py`

**Interfaces:**
- Consumes: `analytics_payload` entries' `music` field; the `/integrations/spotify/taste` endpoint; the existing `U.*`/`CHARTS`/`PANELS` machinery and the Sleep/Productivity tabs as templates.
- Produces: a `Music` tab, `lens: ["journal"]`, gated on `hasMusic` (`_data.entries.some(e => e && e.music && e.music.tracks)`), with charts derived in JS matching the Python helpers, plus a taste section fetched from the endpoint, plus audio-feature charts shown ONLY when feature data is present.

- [ ] **Step 1: Payload/route regression tests**

```python
# tests/test_journal_analytics.py
def test_payload_includes_music():
    import journal
    data = journal._seeded()
    journal.set_entry_music(data, "2026-06-29",
        {"tracks": 10, "minutes": 40, "distinct": 9,
         "top_artists": [{"name": "Phoebe Bridgers", "count": 3}],
         "valence": 0.6, "energy": 0.7, "danceability": 0.5, "tempo": 118,
         "source": "spotify", "fetched": "x"})
    p = journal.analytics_payload(data)
    assert p["entries"][0]["music"]["minutes"] == 40
```

```python
# tests/test_journal_app.py
def test_analytics_data_entries_carry_music(client, app):
    import journal
    jdata = journal.load(app.config["JOURNAL_FILE"])
    journal.set_entry_music(jdata, "2026-06-29",
        {"tracks": 10, "minutes": 40, "distinct": 9, "top_artists": [],
         "valence": None, "energy": None, "danceability": None, "tempo": None,
         "source": "spotify", "fetched": "x"})
    journal.save(app.config["JOURNAL_FILE"], jdata)
    body = client.get("/journal/analytics/data").get_json()
    assert any(e.get("music") for e in body["entries"])
```

Run: `.venv/bin/python -m pytest tests/test_journal_analytics.py tests/test_journal_app.py -k "music" -v` → PASS (payload already carries music from Task 4).

- [ ] **Step 2: Add the Music tab to `analytics.js`**

Mirror the **Sleep/Productivity** tabs (read them first):
1. `const hasMusic = _data.entries.some(function (e) { return e && e.music && e.music.tracks; });` next to `hasRescueTime`.
2. Register `{ id: "music", label: "Music", lens: ["journal"], needs: hasMusic }` in `PANELS` (after Productivity).
3. Add a `musicOf(e)` helper mirroring `_entry_music` (truthy `tracks`).
4. Chart descriptors (`panel: "music"`), reusing `U.*`:
   - **Stat cards**: avg minutes/day, total tracks, days (mirror `music_stats`).
   - **Minutes listened over time** + 7-day rolling avg (mirror the duration-over-time chart; derive from `e.music.minutes`).
   - **Top artists** bars (aggregate `e.music.top_artists[].count` across range, top 10 — mirror `music_top_artists`).
   - **Taste view**: an async `fetch("/integrations/spotify/taste")` (cache once); render top artists/tracks/genres for short/medium/long term as themed lists (reuse existing list/`.stat-*` styling; degrade to a muted "no taste yet" line when the payload is empty). This is the one chart that loads data outside `_data` — fetch in the panel's render and inject when resolved.
   - **Audio features present?** Compute `hasFeatures = entries.some(e => musicOf(e) && e.music.valence != null)`. ONLY when true:
     - **valence ↔ mood** scatter with Pearson `r` (mirror the mood scatter; pairs from `music.valence` + `e.mood`).
     - **audio-feature averages** bars/radar (valence/energy/danceability + normalized tempo; mirror `music_feature_averages`). When `hasFeatures` is false, render a single muted note "Audio features unavailable for this Spotify app" instead.

All colors from CSS vars / section hex; no hardcoded theme colors.

- [ ] **Step 3: JS syntax + app render check**

```bash
node -c static/analytics.js && echo "JS OK"
```
Run the app, seed a couple of `entry.music` values (with and without `valence`), open `/journal/analytics`, Journal lens → confirm the **Music** tab shows only with data, the taste section loads, and the feature charts appear only when valence is present (else the muted note).

- [ ] **Step 4: Full suite + commit**

```bash
.venv/bin/python -m pytest -q
git add static/analytics.js static/style.css tests/test_journal_analytics.py tests/test_journal_app.py
git commit -m "feat: analytics Music tab (Spotify, taste + graceful audio-features)"
```

---

## Task 9: Document Spotify in `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the Integrations section** to document: `spotify.py` (OAuth via `oauth.py` with Spotify endpoints + scopes; `fetch_recently_played`/`fetch_top`/`fetch_audio_features` with 403→None degradation; pure `parse_recently_played`/`merge_plays`/`summarize_day`/`build_taste`); the forward-only per-day model + the rolling plays-buffer dedup; `integrations.py` taste + plays-buffer accessors; the `entry["music"]` model + `set_entry_music` + `load()` default; the `/integrations/spotify/*` routes (OAuth mirror of Fitbit) + the taste endpoint + `_spotify_sync` (recently-played → buffer → per-day music + taste refresh, 401-retry); the `integrations-sync.js` spotify registry entry + music panel row; the music analytics helpers + the **Music** tab (`lens: ["journal"]`, `hasMusic`, taste fetch, audio-feature charts gated on `hasFeatures`); new CSS. Update the **Data files** note (`spotify` provider now holds tokens + `taste` + `plays_buffer`) and the entry-field list (`music`). Note the audio-features deprecation caveat. With this, all three planned integrations (Fitbit, RescueTime, Spotify) are shipped.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document Spotify integration in CLAUDE.md"
```

---

## Self-Review (completed by plan author)

- **Spec coverage (Spotify):** OAuth+fetch (T1), pure parse/merge/summarize/taste (T2), integrations taste+buffer (T3), journal music field+helpers+payload (T4), OAuth routes+taste endpoint (T5), `_spotify_sync` incl. 401-retry + dedup buffer + taste refresh + audio-features-None (T6), settings card + music panel row + registry (T7), Music tab with taste + graceful audio-features (T8), docs (T9). Forward-only/no-backfill, graceful 403, and "all info about songs + time listened" (minutes/tracks/distinct/top artists/audio features/taste) all map to tasks.
- **Placeholder scan:** none — pure/backend tasks carry complete code; UI/chart tasks (T7–T8) give concrete code or explicit "mirror the Sleep/Productivity tab" steps, verified by route/payload tests + `node -c`.
- **Type consistency:** transport seam `(method,url,headers,body)->(status,json)`; spotify fetch signatures; play dict (`played_at,date,track_id,name,artists,duration_ms`); music dict (`tracks,minutes,distinct,top_artists,valence,energy,danceability,tempo,source,fetched`); taste dict (`tracks,artists,genres,fetched`); `_spotify_sync(...)->{connected,synced,errors}`; `set_entry_music(data,date,value,now=None)` — consistent across T1–T8. The Task 5 `_spotify_sync` stub is replaced (same signature) in T6, mirroring the Fitbit Task-6/7 split that worked.
