# Fitbit Sleep Integration — Design

**Date:** 2026-06-29
**Status:** Approved (brainstorm) — ready for implementation plan
**Scope:** Fitbit **only**. RescueTime and Spotify are deferred but the
integration store is shaped so they slot in later with no schema change.

## Goal

After each night, automatically fill **sleep data** (bedtime, wake time,
duration, quality, and stage breakdown) into the matching journal day, and add
a dedicated **Sleep** tab to the analytics page. The user connects their Fitbit
account once via an in-app settings page; thereafter sleep data appears on
journal entries without manual entry.

## Constraints (from CLAUDE.md)

- **Zero extra runtime dependencies.** Use the Python **stdlib `urllib`** for all
  HTTP/OAuth; `requirements.txt` stays `flask` + `pytest` only.
- **Strict pure-logic / thin-HTTP split.** Domain logic has zero Flask imports;
  network access lives behind a single injectable seam (mirrors the existing
  `now=None` injectable-clock pattern) so **no test ever hits the network**.
- **Styling is mandatory.** Every new UI element uses the dark amber/monospace
  theme (`:root` vars, themed inputs/buttons, `confirmModal`, `enhanceSelect`).
- **TDD.** Tests written first; unit tests use fixed `now`, fake transport, and
  `tmp_path`; route tests use Flask `test_client()` with temp files.
- The server **auto-quits ~2 s after the last browser tab closes**, so there is
  no persistent background process — sync is triggered by browser activity, not
  a daemon/cron.

## Decisions (resolved in brainstorming)

1. **Sync trigger:** on journal-page load, a background JSON sync of the last
   ~7 days (throttled), plus an explicit **"Sync now"** button. No daemon/cron.
2. **HTTP:** stdlib `urllib` (no `requests`).
3. **Credentials:** in-app settings page; Client ID/Secret + tokens persisted to
   gitignored `data/integrations.json`.
4. **Data model:** dedicated structured `entry["sleep"]` field + a **bespoke
   Sleep analytics tab** (built like the Mood tab), under the **Journal lens**.
5. **Quality metric:** use Fitbit **efficiency** (0–100); opportunistically
   prefer the **sleep score** if the API returns it. Store both; `quality` =
   `score if score is not None else efficiency`.
6. **Backfill window:** 30 days on first connect; 7-day window on each on-load
   sync.

---

## Components

### New: `fitbit.py` (zero Flask, injectable network seam)

The `transport` parameter is a callable
`transport(method, url, headers, body) -> (status_int, parsed_json_or_text)`.
It defaults to a real `urllib`-based implementation; tests pass a fake.

- `build_authorize_url(client_id, redirect_uri, state, scope="sleep")` → str.
  Authorization Code Grant URL at `https://www.fitbit.com/oauth2/authorize`.
- `exchange_code(client_id, client_secret, code, redirect_uri, transport=...)`
  → token dict. POSTs to `https://api.fitbit.com/oauth2/token` with **HTTP Basic
  auth** (`client_id:client_secret`), `grant_type=authorization_code`. No PKCE
  (we hold the secret; this is a confidential local app).
- `refresh_tokens(client_id, client_secret, refresh_token, transport=...)`
  → token dict. `grant_type=refresh_token`.
- `token_expired(tokens, now=None)` → bool. Compares stored `expires_at`
  (computed from `expires_in` at fetch time) against `now` with a small skew
  margin.
- `fetch_sleep(access_token, date, transport=...)` → raw JSON. Calls
  `GET https://api.fitbit.com/1.2/user/-/sleep/date/<YYYY-MM-DD>.json`.
- `parse_sleep(api_json)` → **pure** sleep dict (see model below) or `None` when
  there is no usable sleep record. Selects the record with `isMainSleep == true`
  (falls back to the longest record if none is flagged); naps ignored. Reads
  stage minutes from `levels.summary` (`deep`/`light`/`rem`/`wake`) when present
  (`1.2` "stages" sleep); for classic (non-staged) sleep, `stages` is `None`.
- `normalize_token_response(raw, now=None)` → tokens dict with `access_token`,
  `refresh_token`, `scope`, `expires_at` (absolute ISO/epoch), `fetched`.

All time-dependent functions accept `now=None`.

### New: `integrations.py` (credentials/token store)

Same forgiving-`load()` / atomic-`save()` pattern as `journal.py`/`todo.py`.

- `_empty()` → `{"fitbit": {}, "rescuetime": {}, "spotify": {}}`.
- `load(path)` → forgiving read (missing file → `_empty()`; corrupt → `.bak` +
  `_empty()`; missing provider keys defaulted).
- `save(path, data)` → atomic temp-file + `os.replace`.
- Small accessors: `get_provider(data, name)`, `set_credentials(data, name,
  client_id, client_secret)`, `set_tokens(data, name, tokens)`,
  `clear_provider(data, name)`, `is_connected(data, name)`,
  `last_sync(data, name)` / `set_last_sync(data, name, when)`.

`data/integrations.json` is covered by the existing `data/*` gitignore rule.

### Modified: `journal.py`

- `set_entry_sleep(data, date, sleep, now=None)` — get-or-create the entry for
  `date` (reusing `upsert_entry`'s get-or-create logic), set `entry["sleep"]`,
  bump `updated`. `sleep=None` clears it.
- `_empty()` / `load()` migration: each entry defaults `sleep` to `None`
  (`e.setdefault("sleep", None)`), consistent with how `mood` is handled.
- **Sleep analytics pure helpers** (injectable date bounds; ignore nights
  without a `sleep` field; degrade gracefully on too few points):
  - `sleep_series(entries, start=None, end=None)` → `[{date, hours}]`
    (duration_min / 60), newest-last for charting.
  - `sleep_quality_series(entries, ...)` → `[{date, quality}]`.
  - `sleep_stage_averages(entries, ...)` → `{deep, light, rem, wake}` mean
    minutes over staged nights.
  - `sleep_dow_averages(entries, ...)` → 7 mean-duration values Mon–Sun.
  - `bedtime_series(entries, ...)` → `[{date, bed_min, wake_min}]` where the
    clock times are minutes-from-midnight (bedtimes after noon wrap to negative
    / pre-midnight so the consistency band reads naturally).
  - `sleep_coverage(entries, ...)` → `{nights, span_days, pct}`.
  - `sleep_mood_pairs(entries, ...)` → `[{hours, mood}]` same-day pairs for the
    sleep↔mood correlation (ignores null moods / missing sleep).
  - `sleep_stats(entries, ...)` → `{avg_hours, avg_quality, avg_bedtime,
    avg_waketime, nights}` for the tab's stat cards.
- `analytics_payload` carries each entry's `sleep` (the structured dict or
  `null`) so the client can compute/render without a new endpoint.

### Modified: `app.py` (thin routes only)

`app.config["INTEGRATIONS_FILE"]` (default `data/integrations.json`) + an
`integrations_file()` helper, mirroring `data_file()` / `journal_file()`. The
Fitbit redirect URI is derived from the request host
(`http://127.0.0.1:5001/integrations/fitbit/callback`).

| Route | Method | Purpose |
|---|---|---|
| `/integrations` | GET | Settings page: creds form, connect/disconnect, status, last-synced, "Backfill 30 days" + "Sync now". |
| `/integrations/fitbit/credentials` | POST | Save Client ID/Secret (PRG + flash). |
| `/integrations/fitbit/connect` | GET | Generate `state` (stored in store + session), build authorize URL, redirect to Fitbit. |
| `/integrations/fitbit/callback` | GET | Validate `state`, `exchange_code`, store tokens, flash, redirect to `/integrations`; kicks a 30-day backfill. |
| `/integrations/fitbit/disconnect` | POST | Clear Fitbit tokens (confirmModal-guarded). |
| `/integrations/fitbit/sync` | POST | JSON. Sync `?days=N` (default 7). Refresh tokens if expired, fetch missing days' sleep, write `entry.sleep`, set `last_sync`. Returns `{ok, connected, synced:[dates], errors:[...], sleep:{<shown_date>:sleep|null}}`. |

**Sync internals** (a thin helper in `app.py` that orchestrates the pure
functions): for each target date lacking `entry.sleep` (or when forced), call
`fitbit.fetch_sleep` → `fitbit.parse_sleep` → `journal.set_entry_sleep`. On a
`401`, `refresh_tokens` once and retry. Network/transport exceptions are caught
per-day and reported in `errors` without failing the whole sync.

### New static assets

- `static/fitbit-sync.js` (journal entry page): if connected and `last_sync`
  older than ~1 h, POST `/integrations/fitbit/sync` in the background, then fill
  the entry's **sleep panel** in place for the shown date (same
  background-endpoint + re-render pattern as task notes/subtasks). The **"Sync
  now"** button calls the same path explicitly and re-renders.
- `static/analytics.js`: add the **Sleep** tab to the `CHARTS` registry
  (`lens: ["journal"]`, gated on `hasSleep`) with the charts listed below,
  reusing the existing `U.*` SVG utilities and the mood-over-time chart pattern.

### Sleep panel on the entry form

Read-only display on `journal_entry.html` (rendered like the mood row): shows
🛌 bedtime → wake, duration (`7h 11m`), quality (`Quality 92` or
`Quality (efficiency) 92` when no score), and a compact stage bar when staged.
When not connected, a subtle "Connect Fitbit" link to `/integrations`. When
connected but no data for the day, a muted "No sleep data" line.

---

## Sleep data model (on the entry)

```json
"sleep": {
  "start": "23:14",
  "end": "06:58",
  "duration_min": 431,
  "efficiency": 92,
  "score": 84,
  "quality": 84,
  "stages": {"deep": 71, "light": 240, "rem": 90, "wake": 30},
  "source": "fitbit",
  "fetched": "2026-06-29T08:12:00"
}
```

- `score` is `null` when the API does not expose it; `quality = score if score
  is not None else efficiency`.
- `stages` is `null` for classic (non-staged) sleep records.
- **Date attribution:** Fitbit's `dateOfSleep` (the morning of waking) maps to
  the journal date — last night's sleep lands on today's entry.
- Read-only on the form; a re-sync overwrites it. Days with no Fitbit data have
  no `sleep` field (defaults to `null` via `load()`).

## Analytics — Sleep tab (Journal lens, gated on `hasSleep`)

Charts (top→bottom), all on the existing SVG `CHARTS` registry:

1. **Stat cards** — avg duration, avg quality, avg bedtime/waketime, nights
   tracked.
2. **Duration over time** (hrs) with a 7-night rolling-average overlay.
3. **Quality over time** (score/efficiency).
4. **Bedtime & wake-time consistency** band/scatter (clock-time per night).
5. **Average duration by day of week** bars.
6. **Stage composition** (avg deep/light/REM/awake) — stacked bar.
7. **Sleep ↔ mood correlation** scatter with a Pearson `r` (cross-domain).
8. **Nights-tracked coverage**.

`hasSleep` is true when any in-range entry has a `sleep` field.

## OAuth specifics

- **Grant:** Authorization Code Grant (confidential client; client secret held
  locally). No PKCE.
- **Scope:** `sleep`.
- **Authorize:** `https://www.fitbit.com/oauth2/authorize`
- **Token:** `https://api.fitbit.com/oauth2/token` (HTTP Basic
  `base64(client_id:client_secret)`).
- **Redirect URI:** `http://127.0.0.1:5001/integrations/fitbit/callback`
  (the user registers this exact URI in their Fitbit dev app; localhost http is
  permitted by Fitbit).
- **Tokens:** access token ~8 h; store `expires_at`; refresh via
  `refresh_token` on expiry or a `401`.
- **Rate limit:** 150 requests/hour/user — backfilling 30 days (≈30 calls) and
  7-day on-load syncs are well within budget.

## Error handling

- Not connected → sync endpoint returns `{ok:true, connected:false}`; UI shows
  the connect link; no errors surfaced.
- Token refresh fails (revoked/expired refresh token) → mark disconnected,
  surface a "reconnect" prompt on the settings page.
- Per-day fetch/parse failure → caught, added to `errors[]`, sync continues for
  other days.
- Corrupt `integrations.json` → backed up to `.bak`, `_empty()` returned
  (forgiving load).
- All secrets stay in the gitignored data dir; never logged.

## Testing (TDD, tests first)

- **`tests/test_fitbit.py`** — `parse_sleep` (staged record, classic record,
  multiple records picks main, no-record → None, missing score → quality uses
  efficiency); `build_authorize_url`; `exchange_code` / `refresh_tokens` /
  `token_expired` with a **fake transport**; `normalize_token_response`.
- **`tests/test_integrations.py`** — `_empty`/`load`/`save` round-trip, forgiving
  load + `.bak` on corruption, provider accessors, `is_connected`, last-sync.
- **`tests/test_journal.py`** (extend) — `set_entry_sleep` create/update/clear;
  `load()` defaults `sleep`; each sleep analytics helper with a fixed dataset
  (including empty/too-few-points degradation) and injectable date bounds.
- **`tests/test_app.py` / `tests/test_journal_app.py`** (extend) — routes via
  `test_client()` with temp `INTEGRATIONS_FILE` and a **monkeypatched
  `fitbit` transport**: credentials save, connect redirect + `state`, callback
  token exchange, disconnect, and `/integrations/fitbit/sync` writing
  `entry.sleep` (including the 401→refresh→retry path and the per-day error
  path). No network in any test.

## Files

- **New:** `fitbit.py`, `integrations.py`, `static/fitbit-sync.js`,
  `templates/integrations.html`, `tests/test_fitbit.py`,
  `tests/test_integrations.py`.
- **Modified:** `journal.py` (sleep field + helpers + payload), `app.py`
  (routes + sync orchestration + config), `static/analytics.js` (Sleep tab),
  `templates/journal_entry.html` (sleep panel), `templates/base.html` (nav link
  to `/integrations` + load `fitbit-sync.js` on the entry page), `style.css`
  (`.sleep-panel*`, `.integration*`, Sleep-tab chart styles), `CLAUDE.md`
  (document the integration), `tests/test_journal*.py`.

## Out of scope (deferred)

- RescueTime and Spotify providers (store is shaped for them; not implemented).
- Activity/steps/heart-rate Fitbit data (sleep only).
- A real OS-level nightly cron/daemon.
