# RescueTime Integration Implementation Plan (Plan A of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a full RescueTime productivity integration (API-key connect → per-day journal data → Productivity analytics tab), and land the shared groundwork (`oauth.py` extraction, generalized sync JS + entry panel) that the later Spotify plan reuses.

**Architecture:** Pure `rescuetime.py` (daily-summary fetch + parse behind an injectable transport, zero Flask). Extract the generic OAuth2 helpers out of `fitbit.py` into a shared pure `oauth.py` (Fitbit delegates; Spotify will use it next). Generalize `static/fitbit-sync.js` → `static/integrations-sync.js` with a per-provider render registry, and the entry-form panel into one row per connected provider. RescueTime data lands on `entry["rescuetime"]`; a new **Productivity** analytics tab mirrors the **Sleep** tab.

**Tech Stack:** Python 3.12+ stdlib only (Flask + pytest; `urllib` for HTTP), vanilla JS, server-rendered Jinja, JSON file storage.

## Global Constraints

- **No new runtime dependencies.** `requirements.txt` stays `flask==3.1.0` + `pytest==8.3.4`. HTTP via stdlib `urllib`.
- **Pure-logic / thin-HTTP split.** `oauth.py`, `rescuetime.py`, `integrations.py`, and the `journal.py` additions have ZERO Flask imports. Network behind an injectable `transport(method,url,headers,body) -> (status, json)` seam. **No test hits the network** (fake transports).
- **Injectable clock** (`now=None`) in time-sensitive logic.
- **Styling mandatory.** New UI uses `:root` CSS vars (no hardcoded theme colors), themed widgets, `window.confirmModal` for destructive actions. Add a `style.css` rule for any new class.
- **TDD.** Failing test first → watch fail → implement → watch pass → commit. Init stores via `_empty()`/`_seeded()`.
- **Tests run with:** `.venv/bin/python -m pytest` (restart dev server after Python/template edits).
- **Secrets** (the RescueTime credential) live only in gitignored `data/integrations.json`; never logged or rendered back.
- **RescueTime connected** = a non-empty stored key (no OAuth tokens).
- **Date attribution:** each RescueTime daily-summary row's `date` (YYYY-MM-DD) maps straight to the journal day.

## File Structure

- **New** `oauth.py` — generic OAuth2 Authorization-Code helpers (extracted from `fitbit.py`).
- **New** `rescuetime.py` — daily-summary fetch + pure `parse_day`.
- **New** `static/integrations-sync.js` — per-provider sync + panel-row render registry (rename/generalization of `fitbit-sync.js`).
- **New** `tests/test_oauth.py`, `tests/test_rescuetime.py`.
- **Modify** `fitbit.py` — delegate OAuth to `oauth.py` (public signatures unchanged).
- **Modify** `integrations.py` — `set_api_key`, key-aware `is_connected`.
- **Modify** `journal.py` — `rescuetime` entry field + `set_entry_rescuetime` + analytics helpers + payload.
- **Modify** `app.py` — RescueTime routes + `_rescuetime_sync`.
- **Modify** `static/analytics.js` — Productivity tab.
- **Modify** `templates/integrations.html` — RescueTime card.
- **Modify** `templates/journal_entry.html` — provider panel rows + load `integrations-sync.js`.
- **Delete** `static/fitbit-sync.js` (replaced by `integrations-sync.js`).
- **Modify** `static/style.css`, `CLAUDE.md`, and the test files.

---

## Task 1: Extract `oauth.py`; `fitbit.py` delegates

**Files:**
- Create: `oauth.py`, `tests/test_oauth.py`
- Modify: `fitbit.py:6-142` (replace the OAuth internals with delegation)

**Interfaces:**
- Consumes: nothing.
- Produces (in `oauth.py`):
  - `urllib_transport(method, url, headers, body) -> (status:int, json)`
  - `normalize_token_response(raw, now=None) -> dict` (`access_token, refresh_token, scope, expires_at, fetched`)
  - `token_expired(tokens, now=None) -> bool` (60 s skew)
  - `build_authorize_url(authorize_url, client_id, redirect_uri, state, scope) -> str`
  - `exchange_code(token_url, client_id, client_secret, code, redirect_uri, transport=None, now=None) -> dict`
  - `refresh_tokens(token_url, client_id, client_secret, refresh_token, transport=None, now=None) -> dict`
- `fitbit.py` keeps the SAME public signatures (`build_authorize_url(client_id, redirect_uri, state, scope="sleep")`, `exchange_code(client_id, client_secret, code, redirect_uri, transport=None, now=None)`, `refresh_tokens(client_id, client_secret, refresh_token, transport=None, now=None)`, `token_expired`, `normalize_token_response`, `fetch_sleep`, `parse_sleep`) as thin wrappers.

- [ ] **Step 1: Write `tests/test_oauth.py` (failing)**

```python
import oauth
from urllib.parse import urlparse, parse_qs


def _fake(expect_in, response, status=200, sink=None):
    def t(method, url, headers, body):
        if sink is not None:
            sink.append((method, url, headers, body))
        assert expect_in in url
        return status, response
    return t


def test_build_authorize_url():
    url = oauth.build_authorize_url(
        "https://example.com/authorize", "CID", "http://127.0.0.1/cb", "xyz", "sleep")
    q = parse_qs(urlparse(url).query)
    assert url.startswith("https://example.com/authorize?")
    assert q["client_id"] == ["CID"] and q["scope"] == ["sleep"]
    assert q["state"] == ["xyz"] and q["response_type"] == ["code"]
    assert q["redirect_uri"] == ["http://127.0.0.1/cb"]


def test_exchange_code_basic_auth_and_grant():
    resp = {"access_token": "A", "refresh_token": "R", "scope": "sleep", "expires_in": 3600}
    sink = []
    t = _fake("token", resp, sink=sink)
    tok = oauth.exchange_code("https://x/token", "CID", "SEC", "CODE",
                              "http://127.0.0.1/cb", transport=t, now=1000.0)
    assert tok["access_token"] == "A" and tok["expires_at"] == 1000.0 + 3600
    _, _, headers, body = sink[0]
    assert headers["Authorization"].startswith("Basic ")
    assert "grant_type=authorization_code" in body


def test_refresh_tokens():
    resp = {"access_token": "A2", "refresh_token": "R2", "scope": "s", "expires_in": 3600}
    tok = oauth.refresh_tokens("https://x/token", "CID", "SEC", "R",
                               transport=_fake("token", resp), now=5.0)
    assert tok["access_token"] == "A2"


def test_token_expired():
    assert oauth.token_expired({"expires_at": 1000.0}, now=2000.0) is True
    assert oauth.token_expired({"expires_at": 1000.0}, now=900.0) is False


def test_token_error_raises():
    import pytest
    with pytest.raises(RuntimeError):
        oauth.exchange_code("https://x/token", "C", "S", "CODE", "cb",
                            transport=_fake("token", {"error": "bad"}, status=400))
```

- [ ] **Step 2: Run to verify it fails**

Run: `.venv/bin/python -m pytest tests/test_oauth.py -v`
Expected: FAIL (`ModuleNotFoundError: No module named 'oauth'`).

- [ ] **Step 3: Create `oauth.py`**

```python
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


def normalize_token_response(raw, now=None):
    """Provider token JSON -> our tokens dict with an absolute `expires_at`."""
    t = now if now is not None else time.time()
    return {
        "access_token": raw.get("access_token"),
        "refresh_token": raw.get("refresh_token"),
        "scope": raw.get("scope"),
        "expires_at": t + float(raw.get("expires_in", 0)),
        "fetched": datetime.now().replace(microsecond=0).isoformat(),
    }


def token_expired(tokens, now=None):
    """True when the access token is at/within 60 s of expiry."""
    t = now if now is not None else time.time()
    return t >= float((tokens or {}).get("expires_at", 0)) - 60


def build_authorize_url(authorize_url, client_id, redirect_uri, state, scope):
    q = urllib.parse.urlencode({
        "client_id": client_id,
        "response_type": "code",
        "scope": scope,
        "redirect_uri": redirect_uri,
        "state": state,
    })
    return f"{authorize_url}?{q}"


def _basic_auth(client_id, client_secret):
    raw = f"{client_id}:{client_secret}".encode("utf-8")
    return "Basic " + base64.b64encode(raw).decode("ascii")


def _post_token(token_url, client_id, client_secret, form, transport, now):
    transport = transport or urllib_transport
    headers = {
        "Authorization": _basic_auth(client_id, client_secret),
        "Content-Type": "application/x-www-form-urlencoded",
    }
    status, payload = transport("POST", token_url, headers, urllib.parse.urlencode(form))
    if status != 200:
        raise RuntimeError(f"OAuth token error {status}: {payload}")
    return normalize_token_response(payload, now=now)


def exchange_code(token_url, client_id, client_secret, code, redirect_uri,
                  transport=None, now=None):
    return _post_token(token_url, client_id, client_secret, {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
    }, transport, now)


def refresh_tokens(token_url, client_id, client_secret, refresh_token,
                   transport=None, now=None):
    return _post_token(token_url, client_id, client_secret, {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
    }, transport, now)
```

- [ ] **Step 4: Refactor `fitbit.py` to delegate** (replace lines 6-142; keep `parse_sleep`/`fetch_sleep`/`_clock`/`_main_record`/`_stages` intact)

Replace the imports + OAuth section so `fitbit.py` reads:

```python
"""Fitbit Web API client. Zero Flask imports.

OAuth is delegated to oauth.py; only the sleep-specific fetch/parse live here.
Network is behind oauth.urllib_transport (tests pass a fake transport).
"""
from datetime import datetime

import oauth

_AUTHORIZE = "https://www.fitbit.com/oauth2/authorize"
_TOKEN = "https://api.fitbit.com/oauth2/token"
_API = "https://api.fitbit.com"


def build_authorize_url(client_id, redirect_uri, state, scope="sleep"):
    return oauth.build_authorize_url(_AUTHORIZE, client_id, redirect_uri, state, scope)


def exchange_code(client_id, client_secret, code, redirect_uri, transport=None, now=None):
    return oauth.exchange_code(_TOKEN, client_id, client_secret, code, redirect_uri,
                               transport=transport, now=now)


def refresh_tokens(client_id, client_secret, refresh_token, transport=None, now=None):
    return oauth.refresh_tokens(_TOKEN, client_id, client_secret, refresh_token,
                                transport=transport, now=now)


def normalize_token_response(raw, now=None):
    return oauth.normalize_token_response(raw, now=now)


def token_expired(tokens, now=None):
    return oauth.token_expired(tokens, now=now)
```

Keep `_clock`, `_main_record`, `_stages`, `parse_sleep` exactly as-is. Update `fetch_sleep` to use the shared transport default:

```python
def fetch_sleep(access_token, date, transport=None):
    """Fetch raw sleep data from the Fitbit API for the given date (YYYY-MM-DD)."""
    transport = transport or oauth.urllib_transport
    url = f"{_API}/1.2/user/-/sleep/date/{date}.json"
    headers = {"Authorization": f"Bearer {access_token}"}
    status, payload = transport("GET", url, headers, None)
    if status == 401:
        raise PermissionError("Fitbit token expired")
    if status != 200:
        raise RuntimeError(f"Fitbit sleep error {status}: {payload}")
    return payload
```

(Remove the now-unused `base64`/`json`/`time`/`urllib` imports and the moved helpers `_urllib_transport`/`_basic_auth`/`_post_token` from `fitbit.py`.)

- [ ] **Step 5: Run oauth + fitbit tests**

Run: `.venv/bin/python -m pytest tests/test_oauth.py tests/test_fitbit.py -v`
Expected: PASS (test_oauth: 5 passed; test_fitbit: all existing still pass unchanged).

- [ ] **Step 6: Full suite + commit**

```bash
.venv/bin/python -m pytest -q
git add oauth.py fitbit.py tests/test_oauth.py
git commit -m "refactor: extract shared oauth.py; fitbit delegates"
```
Expected: full suite green (no regression).

---

## Task 2: `integrations.py` — API-key support

**Files:**
- Modify: `integrations.py` (`set_api_key`, update `is_connected`)
- Test: `tests/test_integrations.py`

**Interfaces:**
- Consumes: existing `get_provider`.
- Produces: `set_api_key(data, name, key) -> data` (sets `provider["api_key"]`); `is_connected(data, name)` returns True when the provider has either a token `access_token` OR a non-empty `api_key`.

- [ ] **Step 1: Write failing tests**

```python
# add to tests/test_integrations.py
def test_set_api_key_and_is_connected():
    d = I._empty()
    assert I.is_connected(d, "rescuetime") is False
    I.set_api_key(d, "rescuetime", "KEY123")
    assert I.get_provider(d, "rescuetime")["api_key"] == "KEY123"
    assert I.is_connected(d, "rescuetime") is True


def test_clear_provider_removes_key():
    d = I._empty()
    I.set_api_key(d, "rescuetime", "KEY123")
    I.clear_provider(d, "rescuetime")
    assert I.is_connected(d, "rescuetime") is False
    assert "api_key" not in I.get_provider(d, "rescuetime")
```

- [ ] **Step 2: Run to verify fail**

Run: `.venv/bin/python -m pytest tests/test_integrations.py -k "api_key or removes_key" -v`
Expected: FAIL (`AttributeError: ... set_api_key`).

- [ ] **Step 3: Implement in `integrations.py`**

Add the accessor:

```python
def set_api_key(data, name, key):
    get_provider(data, name)["api_key"] = key
    return data
```

Update `is_connected` to:

```python
def is_connected(data, name):
    p = get_provider(data, name)
    tokens = p.get("tokens")
    if tokens and tokens.get("access_token"):
        return True
    return bool(p.get("api_key"))
```

Update `clear_provider` to also drop the stored key:

```python
def clear_provider(data, name):
    p = get_provider(data, name)
    p.pop("tokens", None)
    p.pop("last_sync", None)
    p.pop("oauth_state", None)
    p.pop("api_key", None)
    return data
```

- [ ] **Step 4: Run to verify pass**

Run: `.venv/bin/python -m pytest tests/test_integrations.py -v`
Expected: PASS (existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add integrations.py tests/test_integrations.py
git commit -m "feat: integrations API-key support (RescueTime)"
```

---

## Task 3: `rescuetime.py` — fetch + parse

**Files:**
- Create: `rescuetime.py`, `tests/test_rescuetime.py`

**Interfaces:**
- Consumes: `oauth.urllib_transport` (as default transport).
- Produces: `fetch_daily_summary(api_key, transport=None) -> list`; `parse_day(row, now=None) -> dict` returning `{date, pulse, productive_min, distracting_min, neutral_min, total_min, top_categories:[{name,min}], source:"rescuetime", fetched}`.

The RescueTime `daily_summary_feed` returns one object per recent day with fields including `date` (YYYY-MM-DD), `productivity_pulse` (0–100), `total_hours`, `all_productive_hours`, `all_distracting_hours`, `neutral_hours`, and per-category hours like `software_development_hours`, `communication_and_scheduling_hours`, `business_hours`, `entertainment_hours`, `social_networking_hours`, `news_hours`, `design_and_composition_hours`, `utilities_hours`, `reference_and_learning_hours`, `shopping_hours`, `uncategorized_hours`.

- [ ] **Step 1: Write failing tests**

```python
import rescuetime

ROW = {
    "date": "2026-06-28",
    "productivity_pulse": 72,
    "total_hours": 5.05,
    "all_productive_hours": 3.57,
    "all_distracting_hours": 0.63,
    "neutral_hours": 0.85,
    "software_development_hours": 2.37,
    "communication_and_scheduling_hours": 1.10,
    "entertainment_hours": 0.40,
    "social_networking_hours": 0.23,
    "business_hours": 0.20,
}


def test_parse_day_core_fields():
    d = rescuetime.parse_day(ROW)
    assert d["date"] == "2026-06-28"
    assert d["pulse"] == 72
    assert d["productive_min"] == round(3.57 * 60)    # 214
    assert d["distracting_min"] == round(0.63 * 60)   # 38
    assert d["neutral_min"] == round(0.85 * 60)       # 51
    assert d["total_min"] == round(5.05 * 60)         # 303
    assert d["source"] == "rescuetime"


def test_parse_day_top_categories_sorted():
    cats = rescuetime.parse_day(ROW)["top_categories"]
    # sorted by minutes desc; software dev (142) first, then communication (66)
    assert cats[0]["name"] == "Software Development" and cats[0]["min"] == round(2.37 * 60)
    assert cats[1]["name"] == "Communication And Scheduling"
    assert len(cats) <= 5


def test_parse_day_missing_fields_default_zero():
    d = rescuetime.parse_day({"date": "2026-06-28", "productivity_pulse": 50})
    assert d["productive_min"] == 0 and d["total_min"] == 0 and d["top_categories"] == []


def test_fetch_daily_summary_calls_feed():
    sink = []
    def t(method, url, headers, body):
        sink.append(url)
        return 200, [ROW]
    out = rescuetime.fetch_daily_summary("KEY123", transport=t)
    assert out == [ROW]
    assert "daily_summary_feed" in sink[0] and "key=KEY123" in sink[0]
```

- [ ] **Step 2: Run to verify fail**

Run: `.venv/bin/python -m pytest tests/test_rescuetime.py -v`
Expected: FAIL (`ModuleNotFoundError: No module named 'rescuetime'`).

- [ ] **Step 3: Implement `rescuetime.py`**

```python
"""RescueTime Analytic Data API client. Zero Flask imports.

Auth is a personal API key (no OAuth). Network is behind an injectable
transport (default oauth.urllib_transport); tests pass a fake.
"""
import urllib.parse
from datetime import datetime

import oauth

_FEED = "https://www.rescuetime.com/api/1/daily_summary_feed"

# Feed field (sans the trailing "_hours") -> display name for top categories.
_CATEGORY_FIELDS = {
    "software_development": "Software Development",
    "communication_and_scheduling": "Communication And Scheduling",
    "business": "Business",
    "design_and_composition": "Design And Composition",
    "reference_and_learning": "Reference And Learning",
    "social_networking": "Social Networking",
    "entertainment": "Entertainment",
    "news": "News",
    "shopping": "Shopping",
    "utilities": "Utilities",
    "uncategorized": "Uncategorized",
}


def fetch_daily_summary(api_key, transport=None):
    """Recent daily summaries (≈ last two weeks), newest first."""
    transport = transport or oauth.urllib_transport
    q = urllib.parse.urlencode({"key": api_key, "format": "json"})
    url = f"{_FEED}?{q}"
    status, payload = transport("GET", url, {}, None)
    if status != 200:
        raise RuntimeError(f"RescueTime error {status}: {payload}")
    return payload


def _min(row, field):
    return round(float(row.get(field, 0) or 0) * 60)


def parse_day(row, now=None):
    """One daily_summary_feed row -> our per-day rescuetime dict."""
    cats = []
    for field, name in _CATEGORY_FIELDS.items():
        minutes = _min(row, field + "_hours")
        if minutes > 0:
            cats.append({"name": name, "min": minutes})
    cats.sort(key=lambda c: c["min"], reverse=True)
    fetched = (now or datetime.now()).replace(microsecond=0).isoformat()
    return {
        "date": row.get("date"),
        "pulse": row.get("productivity_pulse"),
        "productive_min": _min(row, "all_productive_hours"),
        "distracting_min": _min(row, "all_distracting_hours"),
        "neutral_min": _min(row, "neutral_hours"),
        "total_min": _min(row, "total_hours"),
        "top_categories": cats[:5],
        "source": "rescuetime",
        "fetched": fetched,
    }
```

- [ ] **Step 4: Run to verify pass**

Run: `.venv/bin/python -m pytest tests/test_rescuetime.py -v`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add rescuetime.py tests/test_rescuetime.py
git commit -m "feat: rescuetime daily-summary fetch + parse"
```

---

## Task 4: `journal.py` — rescuetime field, writer, analytics helpers, payload

**Files:**
- Modify: `journal.py` (`load()` per-entry migration; writer near `set_entry_sleep`; helpers near the sleep helpers; `analytics_payload`)
- Test: `tests/test_journal.py`

**Interfaces:**
- Consumes: `get_entry_by_date`, `upsert_entry`, `_valid_date`, `_filter_entries_by_date`, `_DOW_NAMES`, `_entry_mood`.
- Produces:
  - `set_entry_rescuetime(data, date, value, now=None) -> entry` (get-or-create like `set_entry_sleep`; `value=None` clears).
  - `load()` defaults each entry's `rescuetime` to `None`.
  - `_entry_rescuetime(entry) -> dict|None` (usable when it has a dict with a non-None `pulse` OR a truthy `total_min`).
  - `rescuetime_pulse_series(entries, start=None, end=None) -> [{date, pulse}]` sorted.
  - `rescuetime_time_series(entries, start=None, end=None) -> [{date, productive_min, distracting_min, neutral_min}]` sorted.
  - `rescuetime_category_totals(entries, start=None, end=None) -> [{name, min}]` aggregated over range, sorted desc, top 8.
  - `rescuetime_dow_averages(entries, start=None, end=None) -> {weekday: mean productive_min | None}`.
  - `productivity_mood_pairs(entries, start=None, end=None) -> [{pulse, mood}]` same-day, both present.
  - `rescuetime_stats(entries, start=None, end=None) -> {avg_pulse, avg_productive_min, days}` (None avgs on empty).
  - `analytics_payload` entries gain `"rescuetime": _entry_rescuetime(e)`.

- [ ] **Step 1: Write failing tests**

```python
# add to tests/test_journal.py
def _entry_rt(date, pulse, prod, distr=20, neut=10, cats=None):
    return {"date": date, "tags": {}, "numbers": {}, "body": "", "mood": None,
            "sleep": None,
            "rescuetime": {"date": date, "pulse": pulse, "productive_min": prod,
                           "distracting_min": distr, "neutral_min": neut,
                           "total_min": prod + distr + neut,
                           "top_categories": cats or [], "source": "rescuetime",
                           "fetched": "x"}}


def test_set_entry_rescuetime_create_update_clear():
    data = journal._seeded()
    journal.set_entry_rescuetime(data, "2026-06-28", {"pulse": 70, "total_min": 100})
    assert journal.get_entry_by_date(data, "2026-06-28")["rescuetime"]["pulse"] == 70
    journal.set_entry_rescuetime(data, "2026-06-28", {"pulse": 90, "total_min": 120})
    assert journal.get_entry_by_date(data, "2026-06-28")["rescuetime"]["pulse"] == 90
    assert sum(e["date"] == "2026-06-28" for e in data["entries"]) == 1
    journal.set_entry_rescuetime(data, "2026-06-28", None)
    assert journal.get_entry_by_date(data, "2026-06-28")["rescuetime"] is None


def test_rescuetime_pulse_series_sorted():
    entries = [_entry_rt("2026-06-29", 80, 200), _entry_rt("2026-06-28", 60, 100)]
    assert journal.rescuetime_pulse_series(entries) == [
        {"date": "2026-06-28", "pulse": 60}, {"date": "2026-06-29", "pulse": 80}]


def test_rescuetime_category_totals_aggregated():
    e1 = _entry_rt("2026-06-28", 70, 100, cats=[{"name": "Software Development", "min": 90}])
    e2 = _entry_rt("2026-06-29", 80, 120, cats=[{"name": "Software Development", "min": 60},
                                                {"name": "News", "min": 30}])
    totals = journal.rescuetime_category_totals([e1, e2])
    assert totals[0] == {"name": "Software Development", "min": 150}
    assert {"name": "News", "min": 30} in totals


def test_productivity_mood_pairs_requires_both():
    e1 = _entry_rt("2026-06-28", 70, 100); e1["mood"] = 5
    e2 = _entry_rt("2026-06-29", 80, 120)  # no mood
    assert journal.productivity_mood_pairs([e1, e2]) == [{"pulse": 70, "mood": 5}]


def test_rescuetime_stats_empty():
    s = journal.rescuetime_stats([])
    assert s["days"] == 0 and s["avg_pulse"] is None


def test_load_defaults_rescuetime(tmp_path):
    p = tmp_path / "j.json"
    data = journal._seeded()
    journal.upsert_entry(data, "2026-06-28", "Day", "b")
    journal.save(str(p), data)
    assert journal.load(str(p))["entries"][0]["rescuetime"] is None


def test_payload_carries_rescuetime():
    data = journal._seeded()
    journal.set_entry_rescuetime(data, "2026-06-28", {"pulse": 70, "total_min": 100})
    p = journal.analytics_payload(data)
    assert p["entries"][0]["rescuetime"]["pulse"] == 70
```

- [ ] **Step 2: Run to verify fail**

Run: `.venv/bin/python -m pytest tests/test_journal.py -k "rescuetime or productivity_mood or payload_carries_rescuetime" -v`
Expected: FAIL (`AttributeError: ... set_entry_rescuetime`).

- [ ] **Step 3: Implement**

In `load()`, beside `e.setdefault("sleep", None)`, add:

```python
            e.setdefault("rescuetime", None)
```

After `set_entry_sleep`, add:

```python
def set_entry_rescuetime(data, date, value, now=None):
    """Set (or clear, with value=None) the auto-filled RescueTime dict for `date`.

    Same get-or-create rule as set_entry_sleep."""
    if not _valid_date(date):
        raise ValueError(f"Invalid date: {date!r}")
    now = now or datetime.now()
    entry = get_entry_by_date(data, date)
    if entry is None:
        entry = upsert_entry(data, date, date, "", now=now)
    entry["rescuetime"] = value
    entry["updated"] = now.isoformat()
    return entry
```

Add the helpers near the sleep helpers:

```python
def _entry_rescuetime(entry):
    r = entry.get("rescuetime")
    if isinstance(r, dict) and (r.get("pulse") is not None or r.get("total_min")):
        return r
    return None


def rescuetime_pulse_series(entries, start=None, end=None):
    out = []
    for e in _filter_entries_by_date(entries, start, end):
        r = _entry_rescuetime(e)
        if r and r.get("pulse") is not None:
            out.append({"date": e["date"], "pulse": r["pulse"]})
    out.sort(key=lambda d: d["date"])
    return out


def rescuetime_time_series(entries, start=None, end=None):
    out = []
    for e in _filter_entries_by_date(entries, start, end):
        r = _entry_rescuetime(e)
        if r:
            out.append({"date": e["date"],
                        "productive_min": r.get("productive_min", 0),
                        "distracting_min": r.get("distracting_min", 0),
                        "neutral_min": r.get("neutral_min", 0)})
    out.sort(key=lambda d: d["date"])
    return out


def rescuetime_category_totals(entries, start=None, end=None):
    totals = {}
    for e in _filter_entries_by_date(entries, start, end):
        r = _entry_rescuetime(e)
        if not r:
            continue
        for c in r.get("top_categories") or []:
            totals[c["name"]] = totals.get(c["name"], 0) + c.get("min", 0)
    rows = [{"name": k, "min": v} for k, v in totals.items()]
    rows.sort(key=lambda c: c["min"], reverse=True)
    return rows[:8]


def rescuetime_dow_averages(entries, start=None, end=None):
    buckets = {i: [] for i in range(7)}
    for e in _filter_entries_by_date(entries, start, end):
        r = _entry_rescuetime(e)
        if r:
            d = datetime.strptime(e["date"], "%Y-%m-%d").date()
            buckets[d.weekday()].append(r.get("productive_min", 0))
    return {_DOW_NAMES[i]: (sum(v) / len(v) if v else None) for i, v in buckets.items()}


def productivity_mood_pairs(entries, start=None, end=None):
    out = []
    for e in _filter_entries_by_date(entries, start, end):
        r = _entry_rescuetime(e)
        m = _entry_mood(e)
        if r and r.get("pulse") is not None and m is not None:
            out.append({"pulse": r["pulse"], "mood": m})
    return out


def rescuetime_stats(entries, start=None, end=None):
    rows = [_entry_rescuetime(e) for e in _filter_entries_by_date(entries, start, end)]
    rows = [r for r in rows if r]
    if not rows:
        return {"avg_pulse": None, "avg_productive_min": None, "days": 0}
    pulses = [r["pulse"] for r in rows if r.get("pulse") is not None]
    prod = [r.get("productive_min", 0) for r in rows]
    return {
        "avg_pulse": round(sum(pulses) / len(pulses), 1) if pulses else None,
        "avg_productive_min": round(sum(prod) / len(prod)),
        "days": len(rows),
    }
```

In `analytics_payload`, add `"rescuetime": _entry_rescuetime(e),` to the per-entry dict (beside `"sleep"`).

- [ ] **Step 4: Run to verify pass**

Run: `.venv/bin/python -m pytest tests/test_journal.py -k "rescuetime or productivity_mood or payload_carries_rescuetime" -v`
Expected: PASS.

- [ ] **Step 5: Full journal suite + commit**

```bash
.venv/bin/python -m pytest tests/test_journal.py tests/test_journal_analytics.py -q
git add journal.py tests/test_journal.py
git commit -m "feat: journal rescuetime field + analytics helpers + payload"
```

> Note: `tests/test_journal_analytics.py::test_analytics_payload_shape` asserts the per-entry key set. Add `"rescuetime"` to that expected set in the same commit (it currently lists `date, tags, numbers, body, created, mood, sleep`).

---

## Task 5: `app.py` — RescueTime routes + sync

**Files:**
- Modify: `app.py`
- Test: `tests/test_journal_app.py`

**Interfaces:**
- Consumes: `integrations.{load,save,get_provider,set_api_key,is_connected,clear_provider,set_last_sync}`, `rescuetime.{fetch_daily_summary,parse_day}`, `journal.{load,save,get_entry_by_date,set_entry_rescuetime}`.
- Produces routes: `POST /integrations/rescuetime/key`, `POST /integrations/rescuetime/disconnect`, `POST /integrations/rescuetime/sync`. Helper `_rescuetime_sync(force=False, focus_date=None, now=None) -> {connected, synced, errors}`.

- [ ] **Step 1: Write failing tests**

```python
# add to tests/test_journal_app.py
def test_rescuetime_save_key(client, app):
    client.post("/integrations/rescuetime/key", data={"api_key": "KEY123"})
    d = I.load(app.config["INTEGRATIONS_FILE"])
    assert d["rescuetime"]["api_key"] == "KEY123"
    assert I.is_connected(d, "rescuetime")


def test_rescuetime_sync_writes_entries(client, app, monkeypatch):
    d = I.load(app.config["INTEGRATIONS_FILE"])
    I.set_api_key(d, "rescuetime", "KEY123")
    I.save(app.config["INTEGRATIONS_FILE"], d)
    monkeypatch.setattr("rescuetime.fetch_daily_summary",
        lambda key, transport=None: [
            {"date": "2026-06-28", "productivity_pulse": 70,
             "all_productive_hours": 2.0, "total_hours": 3.0}])
    r = client.post("/integrations/rescuetime/sync?date=2026-06-28")
    body = r.get_json()
    assert body["ok"] and body["connected"]
    assert "2026-06-28" in body["synced"]
    import journal
    jdata = journal.load(app.config["JOURNAL_FILE"])
    assert journal.get_entry_by_date(jdata, "2026-06-28")["rescuetime"]["pulse"] == 70


def test_rescuetime_sync_not_connected(client, app):
    body = client.post("/integrations/rescuetime/sync").get_json()
    assert body["ok"] and body["connected"] is False


def test_rescuetime_disconnect(client, app):
    d = I.load(app.config["INTEGRATIONS_FILE"])
    I.set_api_key(d, "rescuetime", "KEY123")
    I.save(app.config["INTEGRATIONS_FILE"], d)
    client.post("/integrations/rescuetime/disconnect")
    assert not I.is_connected(I.load(app.config["INTEGRATIONS_FILE"]), "rescuetime")
```

- [ ] **Step 2: Run to verify fail**

Run: `.venv/bin/python -m pytest tests/test_journal_app.py -k "rescuetime" -v`
Expected: FAIL (404 / missing route).

- [ ] **Step 3: Implement in `app.py`**

Add `import rescuetime` near the other integration imports. Add routes (near the Fitbit routes):

```python
@app.route("/integrations/rescuetime/key", methods=["POST"])
def rescuetime_key():
    data = integrations.load(integrations_file())
    integrations.set_api_key(data, "rescuetime", request.form.get("api_key", "").strip())
    integrations.save(integrations_file(), data)
    flash("RescueTime API key saved.")
    return redirect(url_for("integrations_page"))


@app.route("/integrations/rescuetime/disconnect", methods=["POST"])
def rescuetime_disconnect():
    data = integrations.load(integrations_file())
    integrations.clear_provider(data, "rescuetime")
    integrations.save(integrations_file(), data)
    flash("RescueTime disconnected.")
    return redirect(url_for("integrations_page"))


def _rescuetime_sync(force=False, focus_date=None, now=None):
    istore = integrations.load(integrations_file())
    if not integrations.is_connected(istore, "rescuetime"):
        return {"connected": False, "synced": [], "errors": []}
    key = integrations.get_provider(istore, "rescuetime").get("api_key")
    jdata = journal.load(journal_file())
    synced, errors = [], []
    try:
        rows = rescuetime.fetch_daily_summary(key)
    except Exception as exc:  # noqa: BLE001
        return {"connected": True, "synced": [], "errors": [str(exc)]}
    for row in rows:
        try:
            day = rescuetime.parse_day(row, now=now)
            date = day.get("date")
            if not date:
                continue
            existing = journal.get_entry_by_date(jdata, date)
            if not force and existing is not None and existing.get("rescuetime"):
                continue
            journal.set_entry_rescuetime(jdata, date, day)
            synced.append(date)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{row.get('date')}: {exc}")
    journal.save(journal_file(), jdata)
    integrations.set_last_sync(istore, "rescuetime",
                               (now or datetime.now()).replace(microsecond=0).isoformat())
    integrations.save(integrations_file(), istore)
    return {"connected": True, "synced": synced, "errors": errors}


@app.route("/integrations/rescuetime/sync", methods=["POST"])
def rescuetime_sync_route():
    focus = request.args.get("date")
    result = _rescuetime_sync(focus_date=focus)
    data = {}
    if focus and result["connected"]:
        entry = journal.get_entry_by_date(journal.load(journal_file()), focus)
        data = {focus: (entry or {}).get("rescuetime")}
    return jsonify({"ok": True, **result, "data": data})
```

- [ ] **Step 4: Run to verify pass**

Run: `.venv/bin/python -m pytest tests/test_journal_app.py -k "rescuetime" -v`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add app.py tests/test_journal_app.py
git commit -m "feat: RescueTime key/disconnect/sync routes"
```

---

## Task 6: Generalize sync JS → `integrations-sync.js` (Fitbit preserved)

**Files:**
- Create: `static/integrations-sync.js`
- Delete: `static/fitbit-sync.js`
- Modify: `templates/journal_entry.html` (script src), `templates/integrations.html` (script src)

**Interfaces:**
- Consumes: the existing sync endpoints (`/integrations/fitbit/sync`, `/integrations/rescuetime/sync`) returning `{..., sleep|data: {<date>: value}}`.
- Produces: a per-provider registry-driven script. Each provider entry: `{ name, panelId, key, syncPath, render(panelEl, value) }`. The script, for each provider whose panel reports connected, throttles (1h) via the panel's `data-last-sync` attr and POSTs the sync path with `&date=<date>`, then calls `render`. On the settings page it wires `#<provider>-sync-now` buttons.

**Reference:** read the current `static/fitbit-sync.js` — this task generalizes its exact logic. **Fitbit behavior must be unchanged** (the existing `test_entry_shows_*` and sync route tests are the safety net).

- [ ] **Step 1: Create `static/integrations-sync.js`**

```javascript
// Per-provider integration sync. On the journal entry page each connected
// provider auto-syncs (throttled 1h) and re-renders its panel row in place;
// on the settings page the "#<provider>-sync-now" buttons force a sync.
(function () {
  function span(cls, text) {
    const el = document.createElement("span");
    el.className = cls;
    el.textContent = text;
    return el;
  }

  // ---- per-provider render functions (panel row) ----
  function renderSleep(panel, s) {
    if (!s) return;
    const dur = `${Math.floor(s.duration_min / 60)}h ${s.duration_min % 60}m`;
    const label = s.score != null ? "Quality" : "Quality (efficiency)";
    panel.replaceChildren(
      span("sleep-icon", "🛌"),
      span("sleep-times", `${s.start} → ${s.end}`),
      span("sleep-dur", dur),
      span("sleep-qual", `${label} ${s.quality}`));
  }
  function renderRescuetime(panel, r) {
    if (!r) return;
    panel.replaceChildren(
      span("rt-icon", "⏱"),
      span("rt-pulse", `Pulse ${r.pulse}`),
      span("rt-prod", `${Math.round(r.productive_min / 60 * 10) / 10}h productive`));
  }

  const PROVIDERS = [
    { name: "fitbit", panelId: "sleep-panel", key: "sleep",
      syncPath: "/integrations/fitbit/sync", render: renderSleep },
    { name: "rescuetime", panelId: "rescuetime-panel", key: "data",
      syncPath: "/integrations/rescuetime/sync", render: renderRescuetime },
  ];

  function sync(p, panel) {
    const date = panel ? panel.dataset.date : null;
    let url = `${p.syncPath}?days=7`;
    if (date) url += `&date=${date}`;
    return fetch(url, { method: "POST" })
      .then((r) => r.json())
      .then((body) => {
        const bag = body[p.key];
        if (date && bag && bag[date]) p.render(panel, bag[date]);
      })
      .catch(() => {});
  }

  PROVIDERS.forEach((p) => {
    const panel = document.getElementById(p.panelId);
    if (panel && panel.dataset.connected === "1") {
      const last = panel.dataset.lastSync;
      const stale = !last || (Date.now() - Date.parse(last)) > 3600 * 1000;
      if (stale) sync(p, panel);
    }
    // "Sync now" button on the settings page (and optional entry button).
    document.querySelectorAll(`#${p.name}-sync-now`).forEach((b) =>
      b.addEventListener("click", () => sync(p, panel).then(() => location.reload())));
  });
})();
```

- [ ] **Step 2: Repoint the templates**

In `templates/journal_entry.html` and `templates/integrations.html`, change the script src from `fitbit-sync.js` to `integrations-sync.js`. (The integrations page button id stays `fitbit-sync-now`; the loop's `#${p.name}-sync-now` matches it for `fitbit`.)

- [ ] **Step 3: Delete the old file + JS syntax check**

```bash
git rm static/fitbit-sync.js
node -c static/integrations-sync.js && echo "JS OK"
```

- [ ] **Step 4: Run the entry/integrations route tests + full suite**

Run: `.venv/bin/python -m pytest tests/test_journal_app.py -q && .venv/bin/python -m pytest -q`
Expected: PASS.

> `test_integrations_page_loads_sync_script` asserts `b"fitbit-sync.js"`; change it to `b"integrations-sync.js"` in this task.

- [ ] **Step 5: Commit**

```bash
git add static/integrations-sync.js templates/journal_entry.html templates/integrations.html tests/test_journal_app.py
git commit -m "refactor: generalize sync JS to integrations-sync.js (per-provider registry)"
```

---

## Task 7: RescueTime UI — settings card + entry panel row

**Files:**
- Modify: `templates/integrations.html` (RescueTime card), `templates/journal_entry.html` (rescuetime panel row), `app.py` (`_render_entry` passes rescuetime context + `integrations_page` passes rescuetime status), `static/style.css` (`.rt-*` row styles)
- Test: `tests/test_journal_app.py`

**Interfaces:**
- Consumes: `integrations.is_connected(istore, "rescuetime")`, `integrations.last_sync`, the entry's `rescuetime` field.
- Produces: the RescueTime card (key form + connected status + Sync now + Disconnect) and the entry-form RescueTime panel row (three states).

- [ ] **Step 1: Write failing route tests**

```python
# add to tests/test_journal_app.py
def test_integrations_page_has_rescuetime_card(client):
    r = client.get("/integrations")
    assert b"RescueTime" in r.data
    assert b'name="api_key"' in r.data


def test_entry_shows_rescuetime_connect_when_not_connected(client):
    r = client.get("/journal")
    assert b"Connect RescueTime" in r.data
```

- [ ] **Step 2: Run to verify fail**

Run: `.venv/bin/python -m pytest tests/test_journal_app.py -k "rescuetime_card or rescuetime_connect" -v`
Expected: FAIL.

- [ ] **Step 3: Extend `app.py` context**

Update `integrations_page` to also pass RescueTime status:

```python
        rescuetime_connected=integrations.is_connected(data, "rescuetime"),
        rescuetime_last_sync=integrations.last_sync(data, "rescuetime"),
```

Update `_render_entry` to also pass:

```python
        rescuetime_connected=integrations.is_connected(istore, "rescuetime"),
        rescuetime_last_sync=integrations.last_sync(istore, "rescuetime"),
        rescuetime=(entry or {}).get("rescuetime"),
```

- [ ] **Step 4: Add the RescueTime card to `templates/integrations.html`**

After the Fitbit `</section>`, add a themed card mirroring the Fitbit one (reuse `.integration-card`, `.integration-status`, `.integration-creds`, `.btn`, `.muted`):

```html
  <section class="integration-card">
    <h2>RescueTime <span class="integration-status {{ 'on' if rescuetime_connected else 'off' }}">
      {{ 'Connected' if rescuetime_connected else 'Not connected' }}</span></h2>
    <p class="muted">Auto-fills daily productivity (pulse, productive/distracting
      time, top categories) into your journal. Get a key at
      <code>rescuetime.com/anapi/manage</code>.</p>
    <form method="post" action="{{ url_for('rescuetime_key') }}" class="integration-creds">
      <label>API key <input name="api_key" type="password"></label>
      <button type="submit">Save key</button>
    </form>
    {% if rescuetime_connected %}
      <p class="muted">Last synced: {{ rescuetime_last_sync or 'never' }}</p>
      <button type="button" id="rescuetime-sync-now" class="btn">Sync now</button>
      <form method="post" action="{{ url_for('rescuetime_disconnect') }}" style="display:inline">
        <button type="submit" class="btn danger"
                data-confirm="Disconnect RescueTime and remove the stored key?">Disconnect</button>
      </form>
    {% endif %}
  </section>
```

- [ ] **Step 5: Add the RescueTime panel row to `templates/journal_entry.html`**

Beside the `#sleep-panel` div, add a sibling:

```html
  <div class="integ-row rt-row" id="rescuetime-panel"
       data-date="{{ date }}"
       data-connected="{{ '1' if rescuetime_connected else '0' }}"
       data-last-sync="{{ rescuetime_last_sync or '' }}">
    {% if rescuetime %}
      <span class="rt-icon">⏱</span>
      <span class="rt-pulse">Pulse {{ rescuetime.pulse }}</span>
      <span class="rt-prod">{{ (rescuetime.productive_min // 60) }}h {{ (rescuetime.productive_min % 60) }}m productive</span>
    {% elif rescuetime_connected %}
      <span class="muted">No RescueTime data for this day</span>
    {% else %}
      <a class="muted" href="{{ url_for('integrations_page') }}">Connect RescueTime →</a>
    {% endif %}
  </div>
```

- [ ] **Step 6: Add `.rt-*` styles to `static/style.css`** (mirror `.sleep-panel*`, theme vars only)

```css
.rt-row { display:flex; gap:.6rem; align-items:center; flex-wrap:wrap;
  font-size:.85rem; color:var(--muted); margin:.4rem 0; }
.rt-row .rt-pulse { color:var(--text); }
.rt-row .rt-prod { color:var(--accent); }
```

- [ ] **Step 7: Run tests + commit**

```bash
.venv/bin/python -m pytest tests/test_journal_app.py -q && .venv/bin/python -m pytest -q
git add app.py templates/integrations.html templates/journal_entry.html static/style.css tests/test_journal_app.py
git commit -m "feat: RescueTime settings card + entry panel row"
```
Expected: full suite green.

---

## Task 8: Analytics **Productivity** tab

**Files:**
- Modify: `static/analytics.js` (Productivity tab), `static/style.css` (if a new class is needed)
- Test: `tests/test_journal_analytics.py`, `tests/test_journal_app.py`

**Interfaces:**
- Consumes: `analytics_payload` entries' `rescuetime` field; the existing `U.*`/`CHARTS`/`PANELS` machinery and the **Sleep** tab as the template.
- Produces: a `Productivity` tab, `lens: ["journal"]`, gated on `hasRescueTime` (`_data.entries.some(e => e && e.rescuetime)`), with charts derived in JS to match the Python helpers.

- [ ] **Step 1: Payload/route regression tests**

```python
# tests/test_journal_analytics.py
def test_payload_includes_rescuetime():
    import journal
    data = journal._seeded()
    journal.set_entry_rescuetime(data, "2026-06-28",
        {"pulse": 70, "productive_min": 120, "distracting_min": 20,
         "neutral_min": 10, "total_min": 150,
         "top_categories": [{"name": "Software Development", "min": 100}],
         "source": "rescuetime", "fetched": "x"})
    p = journal.analytics_payload(data)
    assert p["entries"][0]["rescuetime"]["pulse"] == 70
```

```python
# tests/test_journal_app.py
def test_analytics_data_entries_carry_rescuetime(client, app):
    import journal
    jdata = journal.load(app.config["JOURNAL_FILE"])
    journal.set_entry_rescuetime(jdata, "2026-06-28",
        {"pulse": 70, "productive_min": 120, "total_min": 150,
         "distracting_min": 20, "neutral_min": 10, "top_categories": [],
         "source": "rescuetime", "fetched": "x"})
    journal.save(app.config["JOURNAL_FILE"], jdata)
    body = client.get("/journal/analytics/data").get_json()
    assert any(e.get("rescuetime") for e in body["entries"])
```

Run: `.venv/bin/python -m pytest tests/test_journal_analytics.py tests/test_journal_app.py -k "rescuetime" -v` → PASS (payload already carries it from Task 4).

- [ ] **Step 2: Add the Productivity tab to `analytics.js`**

Mirror the **Sleep** tab exactly (read the Sleep-tab code first):
1. `const hasRescueTime = _data.entries.some(function (e) { return e && e.rescuetime; });` next to `hasSleep`.
2. Register `{ id: "productivity", label: "Productivity", lens: ["journal"], needs: hasRescueTime }` in `PANELS` (after Sleep).
3. Add chart descriptors (`panel: "productivity"`) reusing `U.*` utilities:
   - **Stat cards**: avg pulse, avg productive time (h/m), days tracked (`statCard` pattern).
   - **Pulse over time** (fixed 0–100 axis) + 7-day rolling average (mirror the sleep duration-over-time chart).
   - **Productive vs distracting vs neutral** stacked bars per day (reuse the stage-composition stacked pattern; derive `productive_min`/`distracting_min`/`neutral_min` from `e.rescuetime`).
   - **Time by category** bars (aggregate `e.rescuetime.top_categories[].min` across the range, sort desc, top 8 — mirrors `rescuetime_category_totals`).
   - **Avg productive minutes by weekday** bars (mirror `sleep_dow_averages`).
   - **Productivity↔mood** scatter with Pearson `r` (pulse vs mood; reuse the sleep↔mood scatter; both present).
   All colors from CSS vars / section hex. Minutes→hours where the sleep tab uses hours.

- [ ] **Step 3: JS syntax + app render check**

```bash
node -c static/analytics.js && echo "JS OK"
```
Then run the app, seed a couple of `entry.rescuetime` values (or connect), open `/journal/analytics`, Journal lens → confirm the **Productivity** tab shows only with data and every chart renders themed.

- [ ] **Step 4: Full suite + commit**

```bash
.venv/bin/python -m pytest -q
git add static/analytics.js static/style.css tests/test_journal_analytics.py tests/test_journal_app.py
git commit -m "feat: analytics Productivity tab (RescueTime)"
```

---

## Task 9: Document RescueTime + shared groundwork in `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update the Integrations section** to document: the `oauth.py` extraction (Fitbit now delegates; shared by future OAuth providers); `rescuetime.py` (API key, daily-summary fetch + `parse_day`, injectable transport); `integrations.py` API-key support (`set_api_key`, key-aware `is_connected`); the `entry["rescuetime"]` model + `set_entry_rescuetime` + `load()` default; the `/integrations/rescuetime/*` routes + `_rescuetime_sync` (backfills the recent feed); the generalized `static/integrations-sync.js` (per-provider registry, replaced `fitbit-sync.js`) + the multi-row entry panel; the RescueTime analytics helpers + **Productivity** tab (`lens: ["journal"]`, `hasRescueTime`); new CSS. Note Spotify is the remaining planned integration (Plan B).

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document RescueTime integration + oauth.py/sync-JS groundwork"
```

---

## Self-Review (completed by plan author)

- **Spec coverage (RescueTime + shared parts):** oauth.py extraction (T1), API-key store (T2), rescuetime.py fetch/parse (T3), journal field+helpers+payload (T4), routes+sync (T5), generalized sync JS (T6), settings card + entry panel row (T7), Productivity tab (T8), docs (T9). Spotify is Plan B.
- **Placeholder scan:** none — pure/backend tasks carry complete code; UI/chart tasks (T6–T8) give concrete code or explicit "mirror the Sleep tab/Fitbit panel" steps with the exact derivations, verified by route/payload tests + `node -c`.
- **Type consistency:** `transport(method,url,headers,body)->(status,json)`; oauth endpoint-first signatures; rescuetime day dict (`date,pulse,productive_min,distracting_min,neutral_min,total_min,top_categories,source,fetched`); `_rescuetime_sync(...)->{connected,synced,errors}`; `set_entry_rescuetime(data,date,value,now=None)` — consistent across T1–T8.
