# Fitbit → Google Health API Sleep Migration — Design

**Date:** 2026-06-29
**Status:** Approved (brainstorm) — ready for implementation plan
**Scope:** Replace the Fitbit sleep connector with a Google Health API connector.
The legacy Fitbit Web API turns down **September 2026**; Google Health API reads
the same device sleep data via different OAuth, endpoints, and response schema.

## Goal

Auto-fill each journal day's sleep from the **Google Health API** instead of
Fitbit, with no change to the user-facing sleep model or analytics. Connect once
via Google OAuth on the Manage-page Integrations section.

## Decisions (resolved in brainstorming)

1. **Replace Fitbit** — remove the Fitbit connector entirely; Google Health
   becomes the sole sleep source. Provider key `"fitbit"` → `"google"`; UI label
   **"Google Health"**.
2. **Auto loopback callback** flow (not the manual code-paste flow): redirect URI
   `http://127.0.0.1:5001/integrations/google/callback`.
3. **Testing-mode reality is accepted:** the `googlehealth.sleep.readonly` scope
   is Restricted, so until a Google security review the app runs in Testing mode
   (≤100 test users; **refresh tokens expire after 7 days** → periodic reconnect).
   The connect/reconnect UX is the same few-click OAuth flow.

## Constraints (unchanged from prior integrations)

- **Zero new runtime dependencies** — stdlib `urllib` via `oauth.urllib_transport`.
- **Pure-logic / thin-HTTP split** — `google_health.py`, `oauth.py`, and any
  `journal.py`/`integrations.py` changes have ZERO Flask imports; network behind
  the injectable `transport(method,url,headers,body) -> (status, json)` seam;
  **no test hits the network** (fake transports).
- **Injectable clock** (`now=None`) preserved.
- **Styling** — the Google Health card matches the dark amber/monospace theme via
  `:root` vars; secret input is a password field with no `value`.
- **TDD**; secrets live only in gitignored `data/integrations.json`.

## What stays vs. changes

**Provider-agnostic — unchanged:** the `entry["sleep"]` model, `set_entry_sleep`,
the sleep analytics helpers, the **Sleep** analytics tab, and the entry-form
`#sleep-panel` (the `integrations-sync.js` registry drives it by `panelId:
"sleep-panel"`, `key: "sleep"`). Only the connector changes.

---

## Components

### `oauth.py` (extended — Spotify/Basic default unchanged)

Google's token endpoint wants client credentials in the **POST body** (not HTTP
Basic), the authorize URL needs extra params, and Google omits `refresh_token`
on refresh. Add:

- `build_authorize_url(authorize_url, client_id, redirect_uri, state, scope,
  extra=None)` — `extra` dict merged into the query (Google passes
  `{"access_type": "offline", "prompt": "consent"}`).
- `exchange_code(...)` / `refresh_tokens(...)` gain a `client_auth="basic"`
  param; `client_auth="body"` puts `client_id`/`client_secret` in the form body
  and sends no `Authorization` header. Fitbit/Spotify keep the `"basic"` default.
- `normalize_token_response(raw, now=None, prev=None)` — when `raw` has no
  `refresh_token`, fall back to `prev`'s (so a Google refresh doesn't wipe the
  stored refresh token). `refresh_tokens` threads the old token through as
  `prev`.

### `google_health.py` (new, pure; uses `oauth.py`)

Endpoints: authorize `https://accounts.google.com/o/oauth2/v2/auth`, token
`https://oauth2.googleapis.com/token`, API base `https://health.googleapis.com`.
Scope `https://www.googleapis.com/auth/googlehealth.sleep.readonly`.

- `build_authorize_url(client_id, redirect_uri, state)` → `oauth.build_authorize_url(_AUTHORIZE, …, scope=_SCOPE, extra={"access_type":"offline","prompt":"consent"})`.
- `exchange_code(client_id, client_secret, code, redirect_uri, transport=None, now=None)` → `oauth.exchange_code(_TOKEN, …, client_auth="body")`.
- `refresh_tokens(client_id, client_secret, refresh_token, transport=None, now=None, prev=None)` → `oauth.refresh_tokens(_TOKEN, …, client_auth="body", prev=prev)`.
- `token_expired(tokens, now=None)` → `oauth.token_expired`.
- `fetch_sleep(access_token, date, transport=None)` → `GET
  /v4/users/me/dataTypes/sleep/dataPoints?pageSize=25&filter=<f>` where `<f>` is
  `sleep.interval.civil_end_time >= "<date>" AND sleep.interval.civil_end_time <
  "<date+1>"` (URL-encoded), Bearer auth. `401 → PermissionError`; non-200 →
  `RuntimeError`.
- `parse_sleep(api_json, now=None) -> dict|None` — **pure, defensive** (see Data
  notes). Returns the same shape as the old Fitbit parser:
  `{start, end, duration_min, efficiency, score, quality, stages, source:"google",
  fetched}` (or `None` when no usable record).

### Data notes (parser)

A sleep data point is `{ "sleep": { "interval": {startTime, startUtcOffset,
endTime, endUtcOffset}, "sleepType": "STAGES"|"CLASSIC", "sleepStages":
[{stageType: DEEP|LIGHT|REM|AWAKE, duration: "3600s"}], "sleepSummary": {…} } }`
wrapped under a top-level `{ "dataPoints": [...], "nextPageToken": … }`.

- **Record selection:** if multiple data points, pick the longest by interval; one
  per night is normal.
- **`start`/`end`:** local clock `"HH:MM"` derived from `interval.startTime`/
  `endTime` shifted by `startUtcOffset`/`endUtcOffset`.
- **`duration_min`:** from `sleepSummary` total-duration if present; else sum of
  non-`AWAKE` `sleepStages[].duration` (parse `"3600s"` → 3600 s → minutes); else
  `endTime − startTime`.
- **`stages`:** `{deep, light, rem, wake}` minutes summed from `sleepStages`
  (`stageType` → key, `duration` → minutes); `None` when `sleepType == "CLASSIC"`
  or no stages.
- **`efficiency`:** from `sleepSummary` if present, else `None`.
- **`score`:** `None` (Google Health exposes no sleep score, like Fitbit);
  `quality = score if score is not None else efficiency`.
- **Exact `sleepSummary` field names are confirmed against a live response during
  implementation; the parser degrades gracefully (duration from stages/interval,
  efficiency `None`) if a field is absent.** Tests use representative fixtures
  for both `STAGES` and `CLASSIC` records.

### `integrations.py`

`_PROVIDERS` tuple: `"fitbit"` → `"google"` (now `("google", "rescuetime",
"spotify")`). No other store changes (tokens/credentials/oauth_state accessors
are provider-generic). Old `data/integrations.json` files with a `fitbit` key are
harmless (ignored); no migration needed (Fitbit was never connected).

### `app.py` (thin)

Replace the Fitbit routes/helpers with Google equivalents:

| Route | Method | Purpose |
|---|---|---|
| `POST /integrations/google/credentials` | POST | Save Client ID/Secret (PRG + flash) |
| `GET /integrations/google/connect` | GET | random `state`, redirect to Google authorize (offline + consent) |
| `GET /integrations/google/callback` | GET | validate state + `?error=`, exchange code, store tokens, kick 30-day backfill |
| `POST /integrations/google/disconnect` | POST | clear tokens (confirmModal) |
| `POST /integrations/google/sync` | POST | JSON: refresh-on-401-retry, fetch per recent day, write `entry.sleep`; `?days=N` (default 7), optional `?date=`; returns `{ok, connected, synced, errors, sleep:{<date>: sleep|null}}` |

- `_google_redirect_uri()` ← `url_for("google_callback", _external=True)`.
- `_google_sync(days=7, force=False, focus_date=None, now=None)` mirrors the old
  `_fitbit_sync` (per-date loop, skip days already having `entry.sleep`,
  401→refresh→retry, per-day error isolation, set `last_sync`). On refresh it
  passes the stored refresh token as `prev` so Google's omitted refresh token is
  preserved.
- `_integrations_context()` — `fitbit_*` keys → `google_*`
  (`google_connected`, `google_has_creds`, `google_client_id`,
  `google_last_sync`, `google_redirect_uri`).
- Remove `import fitbit`; delete `fitbit.py` and `tests/test_fitbit.py`.

### Templates + JS

- `_integrations_cards.html`: the **Fitbit** card → **Google Health** card
  (same structure: Client ID/Secret form → `google_credentials`; Connect →
  `google_connect`; Sync now `id="google-sync-now"`; Disconnect → confirmModal).
  Copy references the Google Cloud project + `googlehealth.sleep.readonly` scope +
  test-user requirement.
- `static/integrations-sync.js`: the `fitbit` registry entry →
  `{ name: "google", panelId: "sleep-panel", key: "sleep",
  syncPath: "/integrations/google/sync", render: renderSleep }` (`renderSleep`
  unchanged). Button id `#fitbit-sync-now` → `#google-sync-now`.
- `templates/journal_entry.html` `#sleep-panel`: `data-connected` reads
  `google_connected`; `data-last-sync` reads `google_last_sync`; the
  not-connected link text "Connect Fitbit to auto-fill sleep →" → "Connect Google
  Health to auto-fill sleep →".
- `app.py` `_render_entry`: pass `google_connected` / `google_last_sync` (was
  `fitbit_*`); `sleep=(entry or {}).get("sleep")` unchanged.

## Error handling

- Not connected → sync returns `{ok:true, connected:false}`.
- Refresh fails (`invalid_grant`, expired 7-day token) → surface a reconnect
  prompt; the Integrations card shows **Connect to Google Health** again.
- Per-day fetch/parse errors collected into `errors[]`; loop continues.
- Callback never 500s (flash + redirect on `exchange_code` failure or state
  mismatch).
- Secrets never logged or rendered back.

## Testing (TDD)

- **`tests/test_oauth.py`** (extend): body-auth token exchange (creds in body, no
  Authorization header), `extra` authorize params (`access_type=offline`,
  `prompt=consent`), refresh-token preservation via `prev`. Existing Basic-auth
  tests stay (Spotify path).
- **`tests/test_google_health.py`** (new): `parse_sleep` for a `STAGES` record, a
  `CLASSIC` record (no stages), multiple-records selection, no-record → `None`,
  duration fallback (stages/interval) and efficiency-absent → quality `None`;
  `build_authorize_url` (scope + offline + consent); `exchange_code`/
  `refresh_tokens` via fake transport (body creds); `fetch_sleep` endpoint +
  filter + 401→PermissionError.
- **`tests/test_journal_app.py`**: the Fitbit route tests are rewritten as Google
  (`/integrations/google/*`) — credentials/connect-redirect/callback/state-
  mismatch/disconnect, sync writes `entry.sleep` (monkeypatched transport),
  401→refresh→retry, not-connected; the entry-panel "Connect Google Health" + the
  manage-page Google card; `/integrations/google/sync` JSON shape.
- **`tests/test_journal.py`** / sleep helpers: unchanged (provider-agnostic).
  The sleep parser tests move from `test_fitbit.py` to `test_google_health.py`
  with Google JSON fixtures.

## Docs

- **README:** replace the "Fitbit sleep integration" section with a **Google
  Health sleep integration** section — create a Google Cloud project + enable the
  Google Health API, create an **OAuth 2.0 Client ID (Web application)** with
  redirect URI `http://127.0.0.1:5001/integrations/google/callback`, add the
  `https://www.googleapis.com/auth/googlehealth.sleep.readonly` scope, **add your
  Google account as a Test user**, then connect from journal → Manage →
  Integrations. Note the testing-mode 7-day reconnect.
- **CLAUDE.md:** Fitbit references → Google Health (`google_health.py`, the
  `/integrations/google/*` routes, provider key `google`, the `oauth.py`
  body-auth/extra-params/refresh-preserve additions).

## Files

- **New:** `google_health.py`, `tests/test_google_health.py`.
- **Modified:** `oauth.py`, `integrations.py`, `app.py`,
  `static/integrations-sync.js`, `templates/_integrations_cards.html`,
  `templates/journal_entry.html`, `static/style.css` (if any new class),
  `README.md`, `CLAUDE.md`, `tests/test_oauth.py`, `tests/test_journal_app.py`.
- **Removed:** `fitbit.py`, `tests/test_fitbit.py`.

## Out of scope

- Google Health data beyond sleep (activity, heart rate, etc.).
- Passing the Google security review / production publishing (testing mode is
  accepted).
- Migrating any existing Fitbit tokens (none exist).
