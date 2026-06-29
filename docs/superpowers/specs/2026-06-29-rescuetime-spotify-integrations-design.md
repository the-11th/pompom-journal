# RescueTime + Spotify Integrations — Design

**Date:** 2026-06-29
**Status:** Approved (brainstorm) — ready for implementation plans
**Scope:** Two new providers (RescueTime, Spotify), full pipeline each
(connect → daily journal data → analytics tab), built on the integration
infrastructure established by the Fitbit feature. Implemented as **two plans**
(RescueTime first, Spotify second) sharing groundwork landed in the RescueTime
plan.

## Goal

Auto-fill each journal day with **RescueTime** productivity data and **Spotify**
listening data, each with a dedicated analytics tab — mirroring the shipped
Fitbit sleep integration. The user connects each provider once on the
Integrations page.

## Constraints (from CLAUDE.md — same as Fitbit)

- **Zero new runtime dependencies.** stdlib `urllib` for all HTTP/OAuth.
- **Pure-logic / thin-HTTP split.** New domain modules have ZERO Flask imports;
  network behind a single injectable `transport(method,url,headers,body) ->
  (status, json)` seam; **no test hits the network**.
- **Injectable clock** (`now=None`) in time-sensitive logic.
- **Styling mandatory** — `:root` vars, themed widgets, `confirmModal`,
  `enhanceSelect`; no raw/native chrome.
- **TDD.** Tests first; fake transports; temp `INTEGRATIONS_FILE`; fixed `now`.
- **Secrets** (Spotify client secret/tokens, RescueTime API key) live only in
  the gitignored `data/integrations.json`; never logged or rendered back.
- Server auto-quits with the last tab → sync is browser-triggered, no daemon.

## Decisions (resolved in brainstorming)

1. **Full pipeline for both** (connect + per-day journal data + analytics tab).
2. **RescueTime auth = personal API key** (rescuetime.com/anapi/manage); no OAuth.
3. **Spotify auth = OAuth 2.0** (Authorization Code + client secret, like Fitbit).
4. **Spotify data = comprehensive + audio features**, with audio features
   **degrading gracefully** to null/hidden charts on a 403 (deprecated for apps
   created after Nov 2024). Plus a taste view (top tracks/artists by term).
5. **Spotify per-day is forward-only** (recently-played caps at ~50 tracks/24h —
   no historical backfill); **RescueTime backfills** (daily_summary_feed returns
   recent days). Daily totals are best-effort for Spotify.
6. **`oauth.py` extraction** — the generic OAuth2 helpers move out of `fitbit.py`
   into a shared module both Fitbit and Spotify use.

---

## Shared infrastructure changes

### `oauth.py` (new, pure, zero Flask)

Extract the generic OAuth2 Authorization-Code-Grant helpers currently in
`fitbit.py`, parameterized by endpoint URLs:

- `build_authorize_url(authorize_url, client_id, redirect_uri, state, scope) -> str`
- `exchange_code(token_url, client_id, client_secret, code, redirect_uri,
  transport=None, now=None) -> tokens`
- `refresh_tokens(token_url, client_id, client_secret, refresh_token,
  transport=None, now=None) -> tokens`
- `token_expired(tokens, now=None) -> bool`
- `normalize_token_response(raw, now=None) -> tokens`
- `urllib_transport(method, url, headers, body) -> (status, json)` — the shared
  default transport.

`fitbit.py` keeps its existing public functions (`build_authorize_url`,
`exchange_code`, `refresh_tokens`, `token_expired`, `fetch_sleep`, `parse_sleep`,
`normalize_token_response`) as **thin wrappers** that call `oauth.py` with the
Fitbit endpoints, so its tests stay green unchanged. `spotify.py` uses
`oauth.py` directly with the Spotify endpoints.

### Generalized entry panel + sync JS

`static/fitbit-sync.js` → **`static/integrations-sync.js`** (rename), driven by a
small per-provider registry. On the journal entry page it iterates connected
providers, each throttled independently (panel carries `data-sync-<provider>`
state), POSTs that provider's sync endpoint, and renders the provider's row in
place. On the `/integrations` settings page it wires each provider's "Sync now".
Render functions per provider produce a themed row (built via `textContent`, not
`innerHTML`). The entry-form panel area holds one row per connected provider
(sleep / productivity / music), each with the same three states (data /
connected-but-empty / connect-link).

### Analytics tabs

Two new tabs in `static/analytics.js`, mirroring the **Sleep** tab exactly:
**Productivity** (gated on `hasRescueTime`) and **Music** (gated on `hasMusic`),
both `lens: ["journal"]`, registered in `PANELS`, charts via the `CHARTS`
registry and `U.*` SVG utilities. No hardcoded theme colors.

### Journal data model + payload

`journal._empty()`/`load()` default each entry's `rescuetime` and `music` to
`None` (same migration treatment as `sleep`/`mood`). Writers
`set_entry_rescuetime(data, date, value, now=None)` and `set_entry_music(data,
date, value, now=None)` reuse the get-or-create rule (like `set_entry_sleep`).
`analytics_payload` carries both fields per entry.

---

## RescueTime

### `rescuetime.py` (new, pure, injectable transport)

- `fetch_daily_summary(api_key, transport=None) -> list` — `GET
  https://www.rescuetime.com/api/1/daily_summary_feed?key=<key>&format=json`;
  returns recent days (≈ last two weeks), enabling backfill. Raises on non-200.
- `parse_day(row) -> dict` — **pure**, one feed row → `{date,
  pulse, productive_min, distracting_min, neutral_min, total_min,
  top_categories: [{name, min}], source: "rescuetime", fetched}`. Derives:
  - `pulse` = `productivity_pulse` (0–100).
  - minutes from the feed's `*_hours` fields (`all_productive_hours`,
    `all_distracting_hours`, `neutral_hours`, `total_hours`) × 60.
  - `top_categories` = the feed's per-bucket `*_hours` (business, communication,
    software development, entertainment, social, news, design, etc.), sorted
    desc, top 5, minutes each.
  - `date` = the row's `date` (YYYY-MM-DD) → the journal day directly.

### Data model — `entry["rescuetime"]`

```json
{
  "pulse": 72,
  "productive_min": 214,
  "distracting_min": 38,
  "neutral_min": 51,
  "total_min": 303,
  "top_categories": [{"name": "Software Development", "min": 142}, ...],
  "source": "rescuetime",
  "fetched": "2026-06-29T18:02:00"
}
```

Read-only on the entry form; a re-sync overwrites it. Days with no RescueTime
data have no field.

### Routes (thin)

| Route | Method | Purpose |
|---|---|---|
| `POST /integrations/rescuetime/key` | POST | Save the API key (PRG + flash) |
| `POST /integrations/rescuetime/disconnect` | POST | Clear the key (confirmModal) |
| `POST /integrations/rescuetime/sync` | POST | JSON: fetch daily summary, write `entry.rescuetime` for each returned day missing it (or `force`), set `last_sync`; returns `{ok, connected, synced:[dates], errors:[], data:{<focus>: rescuetime|null}}` |

`is_connected` for RescueTime = a non-empty `api_key` (no tokens).
`integrations.set_api_key(data, "rescuetime", key)` accessor added.

### Pure analytics helpers (in `journal.py`)

Mirroring the sleep helpers (ignore entries lacking the field; injectable date
bounds): `rescuetime_pulse_series`, `rescuetime_time_series`
(`[{date, productive_min, distracting_min, neutral_min}]`),
`rescuetime_category_totals` (`{category: total_min}` over range, top-N),
`rescuetime_dow_averages` (avg productive minutes Mon–Sun),
`productivity_mood_pairs` (`[{pulse, mood}]` same-day),
`rescuetime_stats` (`{avg_pulse, avg_productive_min, days}`),
`_entry_rescuetime`.

### Productivity analytics tab (Journal lens, `hasRescueTime`)

Stat cards (avg pulse, avg productive time, days tracked); pulse over time
(0–100 axis) + rolling avg; productive vs distracting vs neutral (stacked);
time-by-category bars; avg productive minutes by weekday; productivity↔mood
scatter (Pearson r).

---

## Spotify

### `spotify.py` (new, pure, uses `oauth.py`)

OAuth: authorize `https://accounts.spotify.com/authorize`, token
`https://accounts.spotify.com/api/token` (HTTP Basic), scopes
`user-read-recently-played user-top-read`. Redirect URI
`http://127.0.0.1:5001/integrations/spotify/callback`.

- `fetch_recently_played(access_token, transport=None) -> json` — `GET
  /v1/me/player/recently-played?limit=50`. 401 → `PermissionError` (refresh+retry
  like Fitbit).
- `fetch_top(access_token, kind, time_range, transport=None) -> json` —
  `/v1/me/top/{tracks|artists}?time_range={short|medium|long}_term&limit=20`.
- `fetch_audio_features(access_token, ids, transport=None) -> json|None` — `GET
  /v1/audio-features?ids=…`; on **403 returns `None`** (deprecated for new apps).
- `parse_recently_played(json) -> [{played_at, track_id, name, artists:[names],
  duration_ms, popularity, explicit}]` — **pure**.
- `summarize_day(plays, audio_features=None) -> dict` — **pure**, aggregate one
  date's plays → the `entry["music"]` model below; audio-feature averages are
  `None` when `audio_features` is None/empty.
- `build_taste(top_tracks_by_term, top_artists_by_term) -> dict` — **pure**;
  genres derived from artists.

### Data model — `entry["music"]` (per day)

```json
{
  "tracks": 37,
  "minutes": 142,
  "distinct": 29,
  "top_artists": [{"name": "Phoebe Bridgers", "count": 6}, ...],
  "valence": 0.58,
  "energy": 0.71,
  "danceability": 0.62,
  "tempo": 118.4,
  "source": "spotify",
  "fetched": "2026-06-29T18:05:00"
}
```

Audio-feature fields (`valence`/`energy`/`danceability`/`tempo`) are `null` when
the endpoint 403s. Per-day data is **forward-only**: each sync reads
recently-played (last ~50 / ~24h), groups by `played_at` date, and writes/merges
the day's summary. Tracks already counted are de-duped by `(track_id, played_at)`
so re-syncs don't double-count.

### Taste snapshot (not per-day)

Stored in `data/integrations.json` under `spotify.taste`, refreshed each sync:

```json
{
  "tracks": {"short_term": [...], "medium_term": [...], "long_term": [...]},
  "artists": {"short_term": [...], ...},
  "genres": {"short_term": [...], ...},
  "fetched": "..."
}
```

Exposed via `GET /integrations/spotify/taste` (read-only JSON) for the Music tab.

### Routes (thin, OAuth mirrors Fitbit)

| Route | Method | Purpose |
|---|---|---|
| `POST /integrations/spotify/credentials` | POST | Save client id/secret |
| `GET /integrations/spotify/connect` | GET | random `state`, redirect to authorize |
| `GET /integrations/spotify/callback` | GET | validate state + `?error=`, exchange code, refresh taste, flash |
| `POST /integrations/spotify/disconnect` | POST | clear tokens (confirmModal) |
| `POST /integrations/spotify/sync` | POST | JSON: refresh-on-401, fetch recently-played → write per-day `entry.music`; refresh taste snapshot; set `last_sync`; returns `{ok, connected, synced:[dates], errors:[], data:{<focus>: music|null}}` |
| `GET /integrations/spotify/taste` | GET | the stored taste snapshot JSON |

### Pure analytics helpers (in `journal.py`)

`music_minutes_series` (`[{date, minutes}]`), `music_tracks_series`,
`music_mood_pairs` (`[{valence, mood}]` same-day, both present),
`music_feature_averages` (`{valence, energy, danceability, tempo}` over range,
None-safe), `music_top_artists` (`[{name, count}]` aggregated over range),
`music_stats` (`{avg_minutes, total_tracks, days}`), `_entry_music`.

### Music analytics tab (Journal lens, `hasMusic`)

Stat cards (avg minutes/day, total tracks, days); minutes-listened over time +
rolling avg; top artists (range-aggregated) bars; **taste view** (top
tracks/artists/genres by 4wk/6mo/all-time, fetched from
`/integrations/spotify/taste`); and — **only when audio features are present** —
valence↔mood scatter (Pearson r) and an audio-feature radar
(valence/energy/danceability + normalized tempo). `hasMusic` true when any
in-range entry has a `music` object with `tracks`.

---

## Sync triggers (generalized)

`static/integrations-sync.js` on the journal entry page syncs each connected
provider on load (throttled per provider via `data-sync-<provider>` last-sync
attributes), then renders that provider's panel row in place. The settings page
exposes per-provider "Sync now" buttons. Each provider has its own sync endpoint
(above) returning the focus date's data so the panel updates without a full
reload.

## Error handling

- Not connected → sync endpoint returns `{ok:true, connected:false}`.
- RescueTime: a 401/invalid key → flash "reconnect" on settings; per-day parse
  errors collected into `errors[]`.
- Spotify: token refresh failure → mark disconnected + reconnect prompt; 401 on
  recently-played → refresh once + retry; audio-features 403 → null features
  (not an error); per-day errors isolated.
- Corrupt `integrations.json` → `.bak` + empty (existing forgiving load).
- Secrets never logged or rendered (password fields have no value attr).

## Testing (TDD)

- **`tests/test_oauth.py`** — generic build/exchange/refresh/expired with a fake
  transport; confirm Fitbit wrappers still pass (existing `tests/test_fitbit.py`).
- **`tests/test_rescuetime.py`** — `parse_day` (pulse, minute conversions, top
  categories ordering, missing fields), `fetch_daily_summary` with a fake
  transport.
- **`tests/test_spotify.py`** — `parse_recently_played`, `summarize_day` (counts,
  minutes, distinct, top artists, feature averages present/None), `build_taste`
  (genre derivation), OAuth via `oauth.py`, `fetch_audio_features` 403 → None.
- **`tests/test_integrations.py`** — `set_api_key`, RescueTime `is_connected`,
  `spotify.taste` round-trip.
- **`tests/test_journal.py`** — `set_entry_rescuetime`/`set_entry_music`,
  `load()` defaults, every new analytics helper with fixed data + bounds.
- **`tests/test_journal_app.py`** — routes for both providers (key save,
  RescueTime sync writes field; Spotify connect/callback/state-mismatch/error,
  sync writes per-day music incl. 401-refresh, taste endpoint, audio-features
  403 path), with monkeypatched transports and temp `INTEGRATIONS_FILE`.
- **`tests/test_journal_analytics.py`** — payload carries `rescuetime`/`music`;
  analytics/data route exposes them.
- No network in any test.

## Files

- **New:** `oauth.py`, `rescuetime.py`, `spotify.py`, `static/integrations-sync.js`
  (rename of `fitbit-sync.js`), `tests/test_oauth.py`, `tests/test_rescuetime.py`,
  `tests/test_spotify.py`.
- **Modified:** `fitbit.py` (delegate to `oauth.py`), `integrations.py`
  (`set_api_key`, taste accessors, RescueTime `is_connected`), `journal.py`
  (two entry fields + writers + analytics helpers + payload), `app.py` (provider
  routes + sync orchestration), `static/analytics.js` (Productivity + Music
  tabs), `templates/integrations.html` (RescueTime + Spotify cards),
  `templates/journal_entry.html` (provider panel rows + load
  `integrations-sync.js`), `templates/base.html` (if script-load location
  changes), `static/style.css` (new tab + panel styles), `CLAUDE.md`, and the
  test files above.

## Implementation order (two plans)

1. **Plan A — RescueTime** (includes the shared groundwork: `oauth.py`
   extraction, `integrations-sync.js` rename/generalization, entry-panel-row
   generalization, the provider analytics-tab pattern). Simpler (API key) — it
   validates the generalized infrastructure end-to-end.
2. **Plan B — Spotify** (OAuth via `oauth.py`, recently-played per-day summary,
   audio-feature graceful degradation, taste snapshot + endpoint, Music tab).

## Out of scope (deferred)

- Historical Spotify backfill (API can't provide it).
- RescueTime hourly/real-time detail (daily summary only).
- A real OS-level scheduler.
