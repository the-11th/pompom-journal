# Fitbit → Google Health Sleep Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Fitbit sleep connector with a Google Health API connector — same `entry["sleep"]` model, Sleep analytics tab, and entry panel; only the OAuth + fetch + parse changes.

**Architecture:** Extend the shared `oauth.py` to support Google's quirks (client creds in the POST body, extra authorize params, refresh-token preservation). Add a pure `google_health.py` (OAuth wrappers + per-day sleep fetch + defensive parse). Swap the `/integrations/fitbit/*` routes/sync/context for `/integrations/google/*`, rename the provider key `fitbit`→`google`, repoint the UI card + sync registry + entry panel, and delete `fitbit.py`.

**Tech Stack:** Python 3.12+ stdlib only (Flask + pytest; `urllib`), vanilla JS, server-rendered Jinja, JSON file storage.

## Global Constraints

- **No new runtime dependencies.** `requirements.txt` stays `flask==3.1.0` + `pytest==8.3.4`. HTTP via `oauth.urllib_transport`.
- **Pure-logic / thin-HTTP split.** `oauth.py`, `google_health.py`, `integrations.py` changes have ZERO Flask imports. Network behind the injectable `transport(method,url,headers,body) -> (status, json)` seam. **No test hits the network** (fake transports).
- **Injectable clock** (`now=None`) preserved.
- **Styling mandatory.** The Google Health card matches the dark amber/monospace theme via `:root` vars; the client-secret input is `type="password"` with no `value`; Disconnect uses `data-confirm` (global `confirmModal`).
- **TDD.** Failing test first → watch fail → implement → watch pass → commit. Init stores via `_empty()`/`_seeded()`.
- **Tests run with:** `.venv/bin/python -m pytest`.
- **Secrets** (Google client secret + tokens) live only in gitignored `data/integrations.json`; never logged or rendered back.
- **Google OAuth:** authorize `https://accounts.google.com/o/oauth2/v2/auth`, token `https://oauth2.googleapis.com/token` (client creds in POST **body**, not HTTP Basic), scope `https://www.googleapis.com/auth/googlehealth.sleep.readonly`, authorize extras `access_type=offline` + `prompt=consent`, redirect URI `http://127.0.0.1:5001/integrations/google/callback`.
- **API:** `GET https://health.googleapis.com/v4/users/me/dataTypes/sleep/dataPoints?pageSize=25&filter=…`; sleep date = `sleep.interval.civil_end_time` (the wake day = journal date).
- **Provider-agnostic (DO NOT change):** `entry["sleep"]`, `set_entry_sleep`, the sleep analytics helpers, the Sleep tab, and the `#sleep-panel` (`integrations-sync.js` drives it by `panelId:"sleep-panel"`, `key:"sleep"`).

## File Structure

- **New** `google_health.py` — Google OAuth wrappers (via `oauth.py`) + `fetch_sleep` + pure `parse_sleep`.
- **New** `tests/test_google_health.py`.
- **Modify** `oauth.py` — body client-auth, `extra` authorize params, refresh-token preservation (`prev`).
- **Modify** `integrations.py` — `_PROVIDERS`: `fitbit`→`google`.
- **Modify** `app.py` — `/integrations/google/*` routes + `_google_sync` + `_google_redirect_uri` + `_integrations_context` (`google_*`); remove `import fitbit`.
- **Modify** `static/integrations-sync.js`, `templates/_integrations_cards.html`, `templates/journal_entry.html` — Fitbit → Google Health.
- **Modify** `README.md`, `CLAUDE.md`, `tests/test_oauth.py`, `tests/test_journal_app.py`.
- **Delete** `fitbit.py`, `tests/test_fitbit.py`.

---

## Task 1: `oauth.py` — body client-auth, authorize extras, refresh-token preservation

**Files:**
- Modify: `oauth.py`
- Test: `tests/test_oauth.py`

**Interfaces:**
- `build_authorize_url(authorize_url, client_id, redirect_uri, state, scope, extra=None)` — `extra` dict merged into the query (after the standard params).
- `exchange_code(token_url, client_id, client_secret, code, redirect_uri, transport=None, now=None, client_auth="basic")`.
- `refresh_tokens(token_url, client_id, client_secret, refresh_token, transport=None, now=None, client_auth="basic", prev=None)`.
- `normalize_token_response(raw, now=None, prev=None)` — if `raw` lacks `refresh_token`, use `prev.get("refresh_token")`.
- `client_auth="body"` → no `Authorization` header; `client_id`/`client_secret` added to the form body. Default `"basic"` keeps existing Fitbit/Spotify behavior.

- [ ] **Step 1: Write the failing tests** (append to `tests/test_oauth.py`)

```python
def test_build_authorize_url_extra_params():
    url = oauth.build_authorize_url(
        "https://accounts.google.com/o/oauth2/v2/auth", "CID", "http://127.0.0.1/cb",
        "st8", "scope.x", extra={"access_type": "offline", "prompt": "consent"})
    q = parse_qs(urlparse(url).query)
    assert q["access_type"] == ["offline"] and q["prompt"] == ["consent"]
    assert q["scope"] == ["scope.x"] and q["state"] == ["st8"]


def test_exchange_code_body_auth_puts_creds_in_body():
    resp = {"access_token": "A", "refresh_token": "R", "scope": "s", "expires_in": 3600}
    sink = []
    def t(method, url, headers, body):
        sink.append((headers, body)); return 200, resp
    tok = oauth.exchange_code("https://x/token", "CID", "SEC", "CODE", "cb",
                              transport=t, now=1000.0, client_auth="body")
    headers, body = sink[0]
    assert "Authorization" not in headers
    assert "client_id=CID" in body and "client_secret=SEC" in body
    assert tok["access_token"] == "A"


def test_refresh_preserves_prev_refresh_token():
    # Google omits refresh_token on refresh; keep the stored one.
    resp = {"access_token": "A2", "scope": "s", "expires_in": 3600}  # no refresh_token
    def t(method, url, headers, body):
        return 200, resp
    tok = oauth.refresh_tokens("https://x/token", "CID", "SEC", "OLDR",
                               transport=t, now=5.0, client_auth="body",
                               prev={"refresh_token": "OLDR"})
    assert tok["access_token"] == "A2"
    assert tok["refresh_token"] == "OLDR"


def test_normalize_keeps_response_refresh_token_over_prev():
    raw = {"access_token": "A", "refresh_token": "NEW", "expires_in": 10}
    tok = oauth.normalize_token_response(raw, now=0.0, prev={"refresh_token": "OLD"})
    assert tok["refresh_token"] == "NEW"
```

- [ ] **Step 2: Run to verify fail**

Run: `.venv/bin/python -m pytest tests/test_oauth.py -k "extra_params or body_auth or preserves_prev or keeps_response" -v`
Expected: FAIL (unexpected keyword `extra`/`client_auth`/`prev`).

- [ ] **Step 3: Implement in `oauth.py`**

Replace `build_authorize_url`, `_post_token`, `exchange_code`, `refresh_tokens`, and `normalize_token_response` with:

```python
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
```

- [ ] **Step 4: Run to verify pass**

Run: `.venv/bin/python -m pytest tests/test_oauth.py -v`
Expected: PASS (existing Basic-auth tests + 4 new).

- [ ] **Step 5: Full suite + commit**

```bash
.venv/bin/python -m pytest -q
git add oauth.py tests/test_oauth.py
git commit -m "feat: oauth.py body client-auth, authorize extras, refresh-token preserve"
```
Expected: full suite green (Spotify still uses the Basic default; Fitbit still present until Task 4).

---

## Task 2: `google_health.py` — OAuth wrappers + fetch + parse

**Files:**
- Create: `google_health.py`, `tests/test_google_health.py`

**Interfaces:**
- Consumes: `oauth.{build_authorize_url, exchange_code, refresh_tokens, token_expired, urllib_transport}`.
- Produces:
  - `build_authorize_url(client_id, redirect_uri, state) -> str`
  - `exchange_code(client_id, client_secret, code, redirect_uri, transport=None, now=None) -> tokens`
  - `refresh_tokens(client_id, client_secret, refresh_token, transport=None, now=None, prev=None) -> tokens`
  - `token_expired(tokens, now=None) -> bool`
  - `fetch_sleep(access_token, date, transport=None) -> json` (401 → `PermissionError`)
  - `parse_sleep(api_json, now=None) -> dict|None` → `{start, end, duration_min, efficiency, score, quality, stages, source:"google", fetched}`

- [ ] **Step 1: Write the failing tests**

```python
import google_health as gh
from urllib.parse import urlparse, parse_qs

STAGES = {"dataPoints": [{
    "sleep": {
        "interval": {"startTime": "2026-06-28T05:14:00Z", "startUtcOffset": "-25200s",
                     "endTime": "2026-06-28T12:58:00Z", "endUtcOffset": "-25200s"},
        "sleepType": "STAGES",
        "sleepStages": [
            {"stageType": "DEEP", "duration": "4260s"},    # 71m
            {"stageType": "LIGHT", "duration": "14400s"},  # 240m
            {"stageType": "REM", "duration": "5400s"},     # 90m
            {"stageType": "AWAKE", "duration": "1800s"}],  # 30m
        "sleepSummary": {"efficiency": 92}}}]}

CLASSIC = {"dataPoints": [{
    "sleep": {
        "interval": {"startTime": "2026-06-28T05:00:00Z", "startUtcOffset": "-25200s",
                     "endTime": "2026-06-28T12:00:00Z", "endUtcOffset": "-25200s"},
        "sleepType": "CLASSIC", "sleepStages": [],
        "sleepSummary": {"efficiency": 88}}}]}


def test_build_authorize_url_scope_and_extras():
    url = gh.build_authorize_url("CID", "http://127.0.0.1:5001/cb", "st8")
    q = parse_qs(urlparse(url).query)
    assert url.startswith("https://accounts.google.com/o/oauth2/v2/auth?")
    assert q["scope"] == ["https://www.googleapis.com/auth/googlehealth.sleep.readonly"]
    assert q["access_type"] == ["offline"] and q["prompt"] == ["consent"]


def test_parse_stages_record():
    s = gh.parse_sleep(STAGES)
    # local clock = UTC minus 7h (offset -25200s): 05:14Z -> 22:14 prev, 12:58Z -> 05:58
    assert s["start"] == "22:14" and s["end"] == "05:58"
    assert s["stages"] == {"deep": 71, "light": 240, "rem": 90, "wake": 30}
    assert s["duration_min"] == 71 + 240 + 90        # non-awake sum = 401
    assert s["efficiency"] == 92 and s["score"] is None and s["quality"] == 92
    assert s["source"] == "google"


def test_parse_classic_has_no_stages():
    s = gh.parse_sleep(CLASSIC)
    assert s["stages"] is None
    assert s["duration_min"] == 7 * 60   # interval fallback: 7h
    assert s["quality"] == 88


def test_parse_no_records_returns_none():
    assert gh.parse_sleep({"dataPoints": []}) is None


def test_parse_efficiency_absent_quality_none():
    data = {"dataPoints": [{"sleep": {
        "interval": {"startTime": "2026-06-28T05:00:00Z", "startUtcOffset": "0s",
                     "endTime": "2026-06-28T11:00:00Z", "endUtcOffset": "0s"},
        "sleepType": "CLASSIC", "sleepStages": [], "sleepSummary": {}}}]}
    s = gh.parse_sleep(data)
    assert s["efficiency"] is None and s["quality"] is None


def test_fetch_sleep_endpoint_filter_and_401():
    import pytest
    sink = []
    def t(method, url, headers, body):
        sink.append((url, headers)); return 200, {"dataPoints": []}
    gh.fetch_sleep("ACCESS", "2026-06-28", transport=t)
    url, headers = sink[0]
    assert url.startswith("https://health.googleapis.com/v4/users/me/dataTypes/sleep/dataPoints?")
    assert "civil_end_time" in url and "2026-06-28" in url
    assert headers["Authorization"] == "Bearer ACCESS"
    def t401(method, url, headers, body):
        return 401, {"error": "x"}
    with pytest.raises(PermissionError):
        gh.fetch_sleep("ACCESS", "2026-06-28", transport=t401)


def test_exchange_code_body_auth():
    resp = {"access_token": "A", "refresh_token": "R", "expires_in": 3600}
    sink = []
    def t(method, url, headers, body):
        sink.append((url, headers, body)); return 200, resp
    tok = gh.exchange_code("CID", "SEC", "CODE", "cb", transport=t, now=1.0)
    url, headers, body = sink[0]
    assert url == "https://oauth2.googleapis.com/token"
    assert "Authorization" not in headers and "client_secret=SEC" in body
    assert tok["access_token"] == "A"
```

- [ ] **Step 2: Run to verify fail**

Run: `.venv/bin/python -m pytest tests/test_google_health.py -v`
Expected: FAIL (`ModuleNotFoundError: No module named 'google_health'`).

- [ ] **Step 3: Implement `google_health.py`**

```python
"""Google Health API sleep client. Zero Flask imports.

OAuth delegated to oauth.py (Google: client creds in the POST body,
access_type=offline + prompt=consent for a refresh token). Network behind the
injectable transport (default oauth.urllib_transport); tests pass a fake.
"""
import urllib.parse
from datetime import datetime, timedelta

import oauth

_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth"
_TOKEN = "https://oauth2.googleapis.com/token"
_API = "https://health.googleapis.com"
_SCOPE = "https://www.googleapis.com/auth/googlehealth.sleep.readonly"
_STAGE_KEYS = {"DEEP": "deep", "LIGHT": "light", "REM": "rem", "AWAKE": "wake"}


def build_authorize_url(client_id, redirect_uri, state):
    return oauth.build_authorize_url(
        _AUTHORIZE, client_id, redirect_uri, state, _SCOPE,
        extra={"access_type": "offline", "prompt": "consent"})


def exchange_code(client_id, client_secret, code, redirect_uri, transport=None, now=None):
    return oauth.exchange_code(_TOKEN, client_id, client_secret, code, redirect_uri,
                               transport=transport, now=now, client_auth="body")


def refresh_tokens(client_id, client_secret, refresh_token, transport=None, now=None, prev=None):
    return oauth.refresh_tokens(_TOKEN, client_id, client_secret, refresh_token,
                                transport=transport, now=now, client_auth="body", prev=prev)


def token_expired(tokens, now=None):
    return oauth.token_expired(tokens, now=now)


def fetch_sleep(access_token, date, transport=None):
    """Sleep data points whose civil end-date is `date` (YYYY-MM-DD)."""
    transport = transport or oauth.urllib_transport
    nxt = (datetime.strptime(date, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
    flt = (f'sleep.interval.civil_end_time >= "{date}" '
           f'AND sleep.interval.civil_end_time < "{nxt}"')
    q = urllib.parse.urlencode({"pageSize": 25, "filter": flt})
    url = f"{_API}/v4/users/me/dataTypes/sleep/dataPoints?{q}"
    status, payload = transport("GET", url, {"Authorization": f"Bearer {access_token}"}, None)
    if status == 401:
        raise PermissionError("Google token expired")
    if status != 200:
        raise RuntimeError(f"Google Health sleep error {status}: {payload}")
    return payload


def _seconds(dur):
    """'4260s' -> 4260 (int seconds)."""
    try:
        return int(float(str(dur).rstrip("s")))
    except (TypeError, ValueError):
        return 0


def _local_clock(iso, offset):
    """RFC3339 UTC time + offset like '-25200s' -> local 'HH:MM'."""
    base = datetime.strptime(iso[:19], "%Y-%m-%dT%H:%M:%S")
    return (base + timedelta(seconds=_seconds(offset))).strftime("%H:%M")


def _main_record(points):
    """Longest sleep payload by interval length, or None."""
    sleeps = [p["sleep"] for p in points if isinstance(p.get("sleep"), dict)]
    if not sleeps:
        return None
    def span(s):
        iv = s.get("interval") or {}
        try:
            a = datetime.strptime(iv["startTime"][:19], "%Y-%m-%dT%H:%M:%S")
            b = datetime.strptime(iv["endTime"][:19], "%Y-%m-%dT%H:%M:%S")
            return (b - a).total_seconds()
        except (KeyError, ValueError):
            return 0
    return max(sleeps, key=span)


def parse_sleep(api_json, now=None):
    rec = _main_record((api_json or {}).get("dataPoints") or [])
    if rec is None:
        return None
    iv = rec.get("interval") or {}
    start = _local_clock(iv["startTime"], iv.get("startUtcOffset", "0s"))
    end = _local_clock(iv["endTime"], iv.get("endUtcOffset", "0s"))

    stages = None
    if rec.get("sleepType") == "STAGES" and rec.get("sleepStages"):
        stages = {"deep": 0, "light": 0, "rem": 0, "wake": 0}
        for st in rec["sleepStages"]:
            key = _STAGE_KEYS.get(st.get("stageType"))
            if key:
                stages[key] += round(_seconds(st.get("duration")) / 60)

    summary = rec.get("sleepSummary") or {}
    if summary.get("totalSleepDuration") or summary.get("duration"):
        duration_min = round(_seconds(summary.get("totalSleepDuration")
                                      or summary.get("duration")) / 60)
    elif stages:
        duration_min = stages["deep"] + stages["light"] + stages["rem"]
    else:
        a = datetime.strptime(iv["startTime"][:19], "%Y-%m-%dT%H:%M:%S")
        b = datetime.strptime(iv["endTime"][:19], "%Y-%m-%dT%H:%M:%S")
        duration_min = round((b - a).total_seconds() / 60)

    efficiency = summary.get("efficiency")
    score = None
    quality = score if score is not None else efficiency
    fetched = (now or datetime.now()).replace(microsecond=0).isoformat()
    return {
        "start": start, "end": end, "duration_min": duration_min,
        "efficiency": efficiency, "score": score, "quality": quality,
        "stages": stages, "source": "google", "fetched": fetched,
    }
```

> The exact `sleepSummary` duration/efficiency field names are confirmed against a live response at integration time; the parser already degrades gracefully (duration from stages then interval; efficiency `None`) — adjust the `summary.get(...)` keys if the live schema differs and add a fixture.

- [ ] **Step 4: Run to verify pass**

Run: `.venv/bin/python -m pytest tests/test_google_health.py -v`
Expected: PASS (7 passed).

- [ ] **Step 5: Commit**

```bash
git add google_health.py tests/test_google_health.py
git commit -m "feat: google_health sleep client (OAuth + fetch + parse)"
```

---

## Task 3: `integrations.py` — provider key `fitbit` → `google`

**Files:**
- Modify: `integrations.py`
- Test: `tests/test_integrations.py`

**Interfaces:** `_PROVIDERS` becomes `("google", "rescuetime", "spotify")`. `_empty()` now seeds a `google` key instead of `fitbit`.

- [ ] **Step 1: Update the failing test first**

In `tests/test_integrations.py`, the test `test_empty_has_three_providers` (or equivalent) asserts the provider set. Change its expected set from `{"fitbit", "rescuetime", "spotify"}` to `{"google", "rescuetime", "spotify"}`. Run it to watch it fail against the current code.

Run: `.venv/bin/python -m pytest tests/test_integrations.py -k "empty_has_three" -v` → FAIL.

- [ ] **Step 2: Implement**

In `integrations.py`, change `_PROVIDERS = ("fitbit", "rescuetime", "spotify")` to `_PROVIDERS = ("google", "rescuetime", "spotify")`.

- [ ] **Step 3: Run to verify pass**

Run: `.venv/bin/python -m pytest tests/test_integrations.py -v`
Expected: PASS (the generic accessors already work for any provider name).

- [ ] **Step 4: Commit**

```bash
git add integrations.py tests/test_integrations.py
git commit -m "feat: integrations provider key fitbit -> google"
```

---

## Task 4: `app.py` — Google routes + sync; remove Fitbit

**Files:**
- Modify: `app.py`, `tests/test_journal_app.py`
- Delete: `fitbit.py`, `tests/test_fitbit.py`

**Interfaces:**
- Consumes: `google_health.{build_authorize_url, exchange_code, refresh_tokens, token_expired, fetch_sleep, parse_sleep}`, `integrations.*`, `journal.{load,save,get_entry_by_date,set_entry_sleep}`.
- Produces: routes `POST /integrations/google/credentials`, `GET /integrations/google/connect`, `GET /integrations/google/callback`, `POST /integrations/google/disconnect`, `POST /integrations/google/sync`; helpers `_google_redirect_uri()`, `_google_sync(days=7, force=False, focus_date=None, now=None)`; `_integrations_context()` exposes `google_connected`/`google_has_creds`/`google_client_id`/`google_last_sync`/`google_redirect_uri`.

**Reference:** these mirror the existing Fitbit routes/sync/context exactly (read the current `fitbit_credentials`/`fitbit_connect`/`fitbit_callback`/`fitbit_disconnect`/`_fitbit_sync`/`_fitbit_redirect_uri` in `app.py`, and the `fitbit_*` keys in `_integrations_context`). Differences from Fitbit:
1. `import google_health` (and remove `import fitbit`).
2. Routes/functions/endpoints use `google_health.*` and `"google"` as the provider name.
3. `google_connect` redirects to `google_health.build_authorize_url(...)` (which already adds offline+consent).
4. `_google_sync` token refresh passes the stored refresh token as `prev` so Google's omitted refresh token is preserved — i.e. when refreshing:
   ```python
   newtok = google_health.refresh_tokens(cid, csecret, tokens["refresh_token"], prev=tokens)
   ```
   (use a non-secret-named local like `csecret = sp.get("client_secret")`).
5. The callback's post-connect backfill calls `_google_sync(days=30)`.
6. The sync JSON envelope key stays `sleep` (the registry uses `key: "sleep"`).

- [ ] **Step 1: Convert the Fitbit route tests to Google (failing)**

In `tests/test_journal_app.py`, rename the Fitbit integration tests to their Google equivalents (hit `/integrations/google/*`, monkeypatch `google_health.*`, use provider `"google"`):
- `test_google_save_credentials_and_connect` (connect 302 → `accounts.google.com/o/oauth2/v2/auth`, `state=` present).
- `test_google_callback_exchanges_code` (monkeypatch `google_health.exchange_code` + `app._google_sync`; asserts connected).
- `test_google_callback_state_mismatch` (302, not connected).
- `test_google_disconnect` (clears tokens).
- `test_google_sync_writes_sleep` (monkeypatch `google_health.fetch_sleep` to return a STAGES dataPoints payload; assert `entry.sleep` written, JSON `sleep` key).
- `test_google_sync_not_connected`.
- `test_google_sync_refreshes_on_401` (OLD token → `PermissionError`, monkeypatch `google_health.refresh_tokens` → NEW; assert retry succeeds and NEW token persisted).
Delete the old `test_*fitbit*` and `*_sync_*`/`*callback*` Fitbit tests. Keep the entry-panel test but rename to `test_entry_shows_connect_google_when_not_connected` asserting `b"Connect Google Health"`.

Run: `.venv/bin/python -m pytest tests/test_journal_app.py -k "google" -v` → FAIL (routes don't exist yet).

- [ ] **Step 2: Implement in `app.py`**

Add `import google_health`; remove `import fitbit`. Replace the five `fitbit_*` routes + `_fitbit_sync` + `_fitbit_redirect_uri` with `google_*` equivalents (mirroring the Fitbit code, applying the 6 differences above). In `_integrations_context()`, replace the `fitbit`-derived keys with the `google_*` keys (provider `"google"`, `redirect_uri=_google_redirect_uri()`).

- [ ] **Step 3: Delete the Fitbit module + tests**

```bash
git rm fitbit.py tests/test_fitbit.py
```

- [ ] **Step 4: Run to verify pass**

Run: `.venv/bin/python -m pytest tests/test_journal_app.py -k "google" -v`, then full `.venv/bin/python -m pytest -q`.
Expected: PASS; no import errors from the removed `fitbit` module.

- [ ] **Step 5: Commit**

```bash
git add app.py tests/test_journal_app.py
git commit -m "feat: Google Health routes + sync; remove Fitbit connector"
```

---

## Task 5: UI — Google Health card, sync registry, entry panel

**Files:**
- Modify: `templates/_integrations_cards.html`, `static/integrations-sync.js`, `templates/journal_entry.html`, `app.py` (`_render_entry` context), `tests/test_journal_app.py`

**Interfaces:** consumes `google_connected`/`google_last_sync` + the entry `sleep` field; the `integrations-sync.js` registry entry for `google`.

- [ ] **Step 1: Failing tests**

In `tests/test_journal_app.py`:
- `test_manage_page_has_google_card`: GET `/journal/sections` → asserts `b"Google Health"` and `b'name="client_id"'` present.
- Confirm `test_entry_shows_connect_google_when_not_connected` (from Task 4) asserts `b"Connect Google Health"` on `/journal`.

Run: `.venv/bin/python -m pytest tests/test_journal_app.py -k "google_card or connect_google" -v` → FAIL.

- [ ] **Step 2: `_integrations_cards.html`** — replace the Fitbit `<section class="integration-card">` (the first card) with a Google Health card (same structure; reuse `.integration-card`/`.integration-status`/`.integration-creds`/`.btn`/`.muted`):

```html
  <section class="integration-card">
    <h2>Google Health <span class="integration-status {{ 'on' if google_connected else 'off' }}">
      {{ 'Connected' if google_connected else 'Not connected' }}</span></h2>
    <p class="muted">Auto-fills nightly sleep (bedtime, wake, duration, quality,
      stages) into your journal. Create a Google Cloud project, enable the Google
      Health API, and make an OAuth client with redirect URL
      <code>{{ google_redirect_uri }}</code> and scope
      <code>googlehealth.sleep.readonly</code> (add yourself as a Test user).</p>

    <form method="post" action="{{ url_for('google_credentials') }}" class="integration-creds">
      <label>Client ID <input name="client_id" value="{{ google_client_id }}"></label>
      <label>Client Secret <input name="client_secret" type="password"></label>
      <button type="submit">Save credentials</button>
    </form>

    {% if google_has_creds and not google_connected %}
      <a class="btn" href="{{ url_for('google_connect') }}">Connect to Google Health</a>
    {% elif google_connected %}
      <p class="muted">Last synced: {{ google_last_sync or 'never' }}</p>
      <button type="button" id="google-sync-now" class="btn">Sync now</button>
      <form method="post" action="{{ url_for('google_disconnect') }}" style="display:inline">
        <button type="submit" class="btn danger"
                data-confirm="Disconnect Google Health and remove stored tokens?">Disconnect</button>
      </form>
    {% endif %}
  </section>
```

- [ ] **Step 3: `static/integrations-sync.js`** — replace the `fitbit` registry entry with:

```javascript
    { name: "google", panelId: "sleep-panel", key: "sleep",
      syncPath: "/integrations/google/sync", render: renderSleep },
```

(`renderSleep` is unchanged. The settings card button is now `#google-sync-now`, matched by the `#${p.name}-sync-now` selector.)

- [ ] **Step 4: `templates/journal_entry.html` `#sleep-panel`** — change `data-connected="{{ '1' if fitbit_connected else '0' }}"` → `google_connected`; `data-last-sync="{{ fitbit_last_sync or '' }}"` → `google_last_sync`; and the not-connected link text "Connect Fitbit to auto-fill sleep →" → "Connect Google Health to auto-fill sleep →".

- [ ] **Step 5: `app.py` `_render_entry`** — pass `google_connected=integrations.is_connected(istore, "google")` and `google_last_sync=integrations.last_sync(istore, "google")` (was `fitbit_*`); `sleep=(entry or {}).get("sleep")` unchanged.

- [ ] **Step 6: Verify + commit**

```bash
node -c static/integrations-sync.js && echo "JS OK"
.venv/bin/python -m pytest tests/test_journal_app.py -q && .venv/bin/python -m pytest -q
git add app.py templates/_integrations_cards.html static/integrations-sync.js templates/journal_entry.html tests/test_journal_app.py
git commit -m "feat: Google Health card + entry panel + sync registry"
```

---

## Task 6: Docs — README + CLAUDE.md

**Files:**
- Modify: `README.md`, `CLAUDE.md`

- [ ] **Step 1: README** — replace the "## Fitbit sleep integration" section with a **## Google Health sleep integration** section: one-time setup (create/select a Google Cloud project; **enable the Google Health API**; create an **OAuth 2.0 Client ID** of type **Web application** with **Authorized redirect URI** `http://127.0.0.1:5001/integrations/google/callback`; on **Data Access** add the scope `https://www.googleapis.com/auth/googlehealth.sleep.readonly`; on **Audience** add your Google account under **Test users**; copy the Client ID + Secret); connect from **journal → Manage → Integrations** (paste into the Google Health card → Save → Connect to Google Health → approve). Day-to-day: auto-sync on journal load + Sync now + the Sleep tab. Note the **testing-mode 7-day token expiry** (reconnect via the same flow when sync stops) and that the legacy Fitbit path has been removed.

- [ ] **Step 2: CLAUDE.md** — update the Integrations docs: `fitbit.py` removed; new `google_health.py` (Google OAuth via `oauth.py` body-auth + `access_type=offline`/`prompt=consent`, `fetch_sleep` against `health.googleapis.com/v4/.../sleep/dataPoints`, defensive `parse_sleep`); `oauth.py` now supports `client_auth="body"`, `extra` authorize params, and refresh-token preservation (`prev`); provider key `google` (in `_PROVIDERS`); the `/integrations/google/*` routes + `_google_sync`; the entry `sleep.source` is now `"google"`. Note the Sleep model/tab/panel are unchanged (provider-agnostic).

- [ ] **Step 3: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs: Google Health sleep integration (README + CLAUDE.md)"
```

---

## Self-Review (completed by plan author)

- **Spec coverage:** oauth.py body-auth/extras/refresh-preserve (T1), google_health.py OAuth+fetch+parse (T2), provider rename (T3), app routes+sync+remove-Fitbit (T4), UI card+registry+panel (T5), docs (T6). The provider-agnostic sleep model/helpers/tab/panel are untouched (verified: only `data-connected`/`data-last-sync` source vars + the connect-link text change).
- **Placeholder scan:** none — pure/backend tasks carry complete code; the one genuine unknown (exact `sleepSummary` field names) is handled by a defensive parser with an explicit confirm-at-impl note, not a placeholder. UI/route tasks give concrete code or explicit "mirror the removed Fitbit code" steps verified by tests + `node -c`.
- **Type consistency:** transport seam `(method,url,headers,body)->(status,json)`; oauth signatures gain `extra`/`client_auth`/`prev`; google_health wrappers; sleep dict shape (`start,end,duration_min,efficiency,score,quality,stages,source,fetched`) identical to the old Fitbit parser so the Sleep tab/panel keep working; `_google_sync(...)->{connected,synced,errors}`; provider key `"google"` — consistent across T1–T6.
