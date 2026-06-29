# Fitbit Sleep Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-fill nightly Fitbit sleep data (bedtime, wake, duration, quality, stages) into each journal day and add a dedicated Sleep analytics tab.

**Architecture:** A pure `fitbit.py` (OAuth + fetch + parse, network behind an injectable `transport` seam) and a pure `integrations.py` credentials/token store, both with zero Flask imports. `journal.py` gains an `entry["sleep"]` field, a `set_entry_sleep` writer, and sleep analytics helpers. `app.py` adds thin settings/OAuth/sync routes. The browser triggers sync on journal load (throttled) + a "Sync now" button; analytics gets a new Sleep tab via the existing `CHARTS` registry.

**Tech Stack:** Python 3.12+ stdlib only (Flask + pytest; `urllib` for HTTP), vanilla JS, server-rendered Jinja, JSON file storage.

## Global Constraints

- **No new runtime dependencies.** `requirements.txt` stays `flask==3.1.0` + `pytest==8.3.4`. All HTTP/OAuth via stdlib `urllib`.
- **Pure-logic / thin-HTTP split.** `fitbit.py`, `integrations.py`, and all `journal.py` additions have **zero Flask imports**. Network access lives behind a single injectable `transport` callable; **no test may hit the network**.
- **Injectable clock.** Every time-dependent function takes `now=None` and defaults to `datetime.now()` (unit tests pass a fixed value).
- **Styling is mandatory.** Every new UI element uses the dark amber/monospace theme: `:root` CSS vars (never hardcode theme colors), themed inputs/buttons, `window.confirmModal` for destructive actions, `window.enhanceSelect(el)` for any dynamically created `<select>`. No raw native widgets.
- **TDD.** Write the failing test first, watch it fail, implement minimally, watch it pass, commit. Initialize stores with `_empty()`/`_seeded()`, never hand-built dicts.
- **Tests run with:** `.venv/bin/python -m pytest` (restart the dev server after Python/template edits).
- **Secrets** live only in the gitignored `data/integrations.json` (covered by the existing `data/*` rule). Never log them.

## File Structure

- **New** `fitbit.py` — OAuth URL building, token exchange/refresh, sleep fetch, pure `parse_sleep`. Injectable `transport`.
- **New** `integrations.py` — provider credential/token store (`_empty`/`load`/`save` + accessors).
- **New** `templates/integrations.html` — settings page.
- **New** `static/fitbit-sync.js` — journal-page background sync + sleep panel render.
- **New** `tests/test_fitbit.py`, `tests/test_integrations.py`.
- **Modify** `journal.py` — `sleep` field migration, `set_entry_sleep`, sleep analytics helpers, payload.
- **Modify** `app.py` — config, settings/OAuth/sync routes, sync orchestration.
- **Modify** `static/analytics.js` — Sleep tab in `CHARTS`.
- **Modify** `templates/journal_entry.html` — read-only sleep panel.
- **Modify** `templates/base.html` — nav link to `/integrations`; load `fitbit-sync.js` on the entry page.
- **Modify** `static/style.css` — `.sleep-panel*`, `.integration*`, Sleep-tab styles.
- **Modify** `CLAUDE.md` — document the integration.
- **Modify** `tests/test_journal.py`, `tests/test_journal_app.py`.

---

## Task 1: `integrations.py` store

**Files:**
- Create: `integrations.py`
- Test: `tests/test_integrations.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `_empty() -> dict`; `load(path) -> dict`; `save(path, data) -> None`; `get_provider(data, name) -> dict`; `set_credentials(data, name, client_id, client_secret) -> dict`; `set_tokens(data, name, tokens) -> dict`; `clear_provider(data, name) -> dict`; `is_connected(data, name) -> bool`; `last_sync(data, name) -> str|None`; `set_last_sync(data, name, when) -> dict`. Providers: `"fitbit"`, `"rescuetime"`, `"spotify"`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_integrations.py
import json
import integrations as I


def test_empty_has_three_providers():
    d = I._empty()
    assert set(d) == {"fitbit", "rescuetime", "spotify"}
    assert d["fitbit"] == {}


def test_load_missing_file_returns_empty(tmp_path):
    d = I.load(str(tmp_path / "nope.json"))
    assert d == I._empty()


def test_save_then_load_roundtrip(tmp_path):
    p = str(tmp_path / "i.json")
    d = I._empty()
    I.set_credentials(d, "fitbit", "CID", "SECRET")
    I.save(p, d)
    assert I.load(p)["fitbit"]["client_id"] == "CID"


def test_corrupt_file_backed_up(tmp_path):
    p = tmp_path / "i.json"
    p.write_text("{not json")
    d = I.load(str(p))
    assert d == I._empty()
    assert (tmp_path / "i.json.bak").exists()


def test_set_tokens_and_is_connected(tmp_path):
    d = I._empty()
    assert I.is_connected(d, "fitbit") is False
    I.set_tokens(d, "fitbit", {"access_token": "A", "refresh_token": "R"})
    assert I.is_connected(d, "fitbit") is True


def test_clear_provider_keeps_key(tmp_path):
    d = I._empty()
    I.set_tokens(d, "fitbit", {"access_token": "A", "refresh_token": "R"})
    I.clear_provider(d, "fitbit")
    assert I.is_connected(d, "fitbit") is False
    assert "fitbit" in d


def test_last_sync_roundtrip():
    d = I._empty()
    assert I.last_sync(d, "fitbit") is None
    I.set_last_sync(d, "fitbit", "2026-06-29T08:00:00")
    assert I.last_sync(d, "fitbit") == "2026-06-29T08:00:00"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest tests/test_integrations.py -v`
Expected: FAIL (`ModuleNotFoundError: No module named 'integrations'`).

- [ ] **Step 3: Implement `integrations.py`**

```python
"""Third-party integration credential/token store. Zero Flask imports.

Same forgiving-load / atomic-save pattern as journal.py and todo.py. Each
top-level key is a provider; values hold credentials + OAuth tokens + sync
bookkeeping. Shaped so rescuetime/spotify slot in with no schema change.
"""
import json
import os
import tempfile

_PROVIDERS = ("fitbit", "rescuetime", "spotify")


def _empty():
    return {name: {} for name in _PROVIDERS}


def load(path):
    """Read the store. Missing file -> empty. Corrupt -> backed up to .bak +
    empty. Missing provider keys defaulted."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            parsed = json.load(f)
    except FileNotFoundError:
        return _empty()
    except json.JSONDecodeError:
        try:
            os.replace(path, path + ".bak")
        except OSError:
            pass
        return _empty()
    if not isinstance(parsed, dict):
        try:
            os.replace(path, path + ".bak")
        except OSError:
            pass
        return _empty()
    for name in _PROVIDERS:
        if not isinstance(parsed.get(name), dict):
            parsed[name] = {}
    return parsed


def save(path, data):
    """Atomic write (temp file + os.replace)."""
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(path)))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def get_provider(data, name):
    return data.setdefault(name, {})


def set_credentials(data, name, client_id, client_secret):
    p = get_provider(data, name)
    p["client_id"] = client_id
    p["client_secret"] = client_secret
    return data


def set_tokens(data, name, tokens):
    get_provider(data, name)["tokens"] = tokens
    return data


def clear_provider(data, name):
    p = get_provider(data, name)
    p.pop("tokens", None)
    p.pop("last_sync", None)
    return data


def is_connected(data, name):
    tokens = get_provider(data, name).get("tokens")
    return bool(tokens and tokens.get("access_token"))


def last_sync(data, name):
    return get_provider(data, name).get("last_sync")


def set_last_sync(data, name, when):
    get_provider(data, name)["last_sync"] = when
    return data
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_integrations.py -v`
Expected: PASS (7 passed).

- [ ] **Step 5: Commit**

```bash
git add integrations.py tests/test_integrations.py
git commit -m "feat: integrations credential/token store"
```

---

## Task 2: `fitbit.py` — pure `parse_sleep` + token normalization

**Files:**
- Create: `fitbit.py`
- Test: `tests/test_fitbit.py`

**Interfaces:**
- Consumes: nothing.
- Produces: `parse_sleep(api_json) -> dict|None` returning `{start, end, duration_min, efficiency, score, quality, stages, source, fetched}` (see spec model); `stages` is `None` for classic sleep; `quality = score if score is not None else efficiency`; `start`/`end` are `"HH:MM"` local clock strings. `normalize_token_response(raw, now=None) -> dict` with `access_token, refresh_token, scope, expires_at` (epoch float), `fetched` (ISO). `token_expired(tokens, now=None) -> bool` (60 s skew).

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_fitbit.py
import time
import fitbit

STAGED = {
    "sleep": [{
        "isMainSleep": True,
        "dateOfSleep": "2026-06-29",
        "startTime": "2026-06-28T23:14:00.000",
        "endTime": "2026-06-29T06:58:00.000",
        "minutesAsleep": 431,
        "efficiency": 92,
        "type": "stages",
        "levels": {"summary": {
            "deep": {"minutes": 71}, "light": {"minutes": 240},
            "rem": {"minutes": 90}, "wake": {"minutes": 30}}},
    }],
}

CLASSIC = {
    "sleep": [{
        "isMainSleep": True, "dateOfSleep": "2026-06-29",
        "startTime": "2026-06-28T23:00:00.000",
        "endTime": "2026-06-29T06:00:00.000",
        "minutesAsleep": 400, "efficiency": 88, "type": "classic",
        "levels": {"summary": {
            "asleep": {"minutes": 400}, "restless": {"minutes": 20},
            "awake": {"minutes": 10}}},
    }],
}


def test_parse_staged_sleep():
    s = fitbit.parse_sleep(STAGED)
    assert s["start"] == "23:14" and s["end"] == "06:58"
    assert s["duration_min"] == 431 and s["efficiency"] == 92
    assert s["stages"] == {"deep": 71, "light": 240, "rem": 90, "wake": 30}
    assert s["score"] is None and s["quality"] == 92
    assert s["source"] == "fitbit"


def test_parse_classic_has_no_stages():
    s = fitbit.parse_sleep(CLASSIC)
    assert s["stages"] is None and s["quality"] == 88


def test_parse_prefers_main_sleep():
    data = {"sleep": [
        {"isMainSleep": False, "startTime": "2026-06-29T13:00:00.000",
         "endTime": "2026-06-29T13:30:00.000", "minutesAsleep": 30,
         "efficiency": 50, "type": "classic", "levels": {"summary": {}}},
        STAGED["sleep"][0],
    ]}
    assert fitbit.parse_sleep(data)["duration_min"] == 431


def test_parse_no_records_returns_none():
    assert fitbit.parse_sleep({"sleep": []}) is None


def test_parse_uses_score_when_present():
    data = {"sleep": [dict(STAGED["sleep"][0])], "sleepScore": 84}
    s = fitbit.parse_sleep(data)
    assert s["score"] == 84 and s["quality"] == 84


def test_normalize_token_response_sets_expiry():
    raw = {"access_token": "A", "refresh_token": "R",
           "scope": "sleep", "expires_in": 28800}
    t = fitbit.normalize_token_response(raw, now=1000.0)
    assert t["access_token"] == "A" and t["expires_at"] == 1000.0 + 28800


def test_token_expired():
    t = {"expires_at": 1000.0}
    assert fitbit.token_expired(t, now=2000.0) is True
    assert fitbit.token_expired(t, now=900.0) is False
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest tests/test_fitbit.py -v`
Expected: FAIL (`ModuleNotFoundError: No module named 'fitbit'`).

- [ ] **Step 3: Implement the pure parsing in `fitbit.py`** (transport/OAuth added in Task 3)

```python
"""Fitbit Web API client. Zero Flask imports.

Network access is isolated behind an injectable `transport` callable (added in
the next task); the parsing helpers here are pure so no test hits the network.
"""
import time
from datetime import datetime


def _clock(iso):
    """'2026-06-28T23:14:00.000' -> '23:14' (local clock, no tz math)."""
    return datetime.strptime(iso[:19], "%Y-%m-%dT%H:%M:%S").strftime("%H:%M")


def _main_record(records):
    """The isMainSleep record, else the longest by minutesAsleep, else None."""
    if not records:
        return None
    for r in records:
        if r.get("isMainSleep"):
            return r
    return max(records, key=lambda r: r.get("minutesAsleep", 0))


def _stages(rec):
    """{deep,light,rem,wake} minutes for a 'stages' record, else None."""
    if rec.get("type") != "stages":
        return None
    summary = (rec.get("levels") or {}).get("summary") or {}
    out = {}
    for key in ("deep", "light", "rem", "wake"):
        out[key] = int((summary.get(key) or {}).get("minutes", 0))
    return out


def parse_sleep(api_json, now=None):
    """Fitbit sleep-by-date JSON -> our sleep dict, or None when no record.

    Selects the main sleep record; naps ignored. quality = score if the API
    exposes one (rare), else efficiency. `stages` is None for classic sleep.
    """
    rec = _main_record((api_json or {}).get("sleep") or [])
    if rec is None:
        return None
    efficiency = rec.get("efficiency")
    score = api_json.get("sleepScore")
    quality = score if score is not None else efficiency
    fetched = (now or datetime.now()).replace(microsecond=0).isoformat()
    return {
        "start": _clock(rec["startTime"]),
        "end": _clock(rec["endTime"]),
        "duration_min": int(rec.get("minutesAsleep", 0)),
        "efficiency": efficiency,
        "score": score,
        "quality": quality,
        "stages": _stages(rec),
        "source": "fitbit",
        "fetched": fetched,
    }


def normalize_token_response(raw, now=None):
    """Fitbit token JSON -> our tokens dict with an absolute `expires_at`."""
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_fitbit.py -v`
Expected: PASS (7 passed).

- [ ] **Step 5: Commit**

```bash
git add fitbit.py tests/test_fitbit.py
git commit -m "feat: fitbit sleep parsing + token helpers"
```

---

## Task 3: `fitbit.py` — OAuth URLs + token exchange/refresh + fetch (injectable transport)

**Files:**
- Modify: `fitbit.py`
- Test: `tests/test_fitbit.py`

**Interfaces:**
- Consumes: `normalize_token_response`.
- Produces:
  - `build_authorize_url(client_id, redirect_uri, state, scope="sleep") -> str`
  - `exchange_code(client_id, client_secret, code, redirect_uri, transport=None, now=None) -> dict` (tokens)
  - `refresh_tokens(client_id, client_secret, refresh_token, transport=None, now=None) -> dict` (tokens)
  - `fetch_sleep(access_token, date, transport=None) -> dict` (raw JSON)
  - `_urllib_transport(method, url, headers, body) -> (status:int, json:dict)` — the default real transport.
- The `transport` signature is `transport(method, url, headers, body) -> (status, parsed_json)`. Tests pass a fake.

- [ ] **Step 1: Write the failing tests**

```python
# append to tests/test_fitbit.py
import json as _json
from urllib.parse import urlparse, parse_qs


def test_build_authorize_url():
    url = fitbit.build_authorize_url("CID", "http://127.0.0.1:5001/cb", "xyz")
    q = parse_qs(urlparse(url).query)
    assert url.startswith("https://www.fitbit.com/oauth2/authorize")
    assert q["client_id"] == ["CID"] and q["scope"] == ["sleep"]
    assert q["state"] == ["xyz"] and q["response_type"] == ["code"]
    assert q["redirect_uri"] == ["http://127.0.0.1:5001/cb"]


def _fake_transport(expect_url_contains, response, status=200, sink=None):
    def t(method, url, headers, body):
        if sink is not None:
            sink.append((method, url, headers, body))
        assert expect_url_contains in url
        return status, response
    return t


def test_exchange_code_returns_tokens():
    resp = {"access_token": "A", "refresh_token": "R",
            "scope": "sleep", "expires_in": 28800}
    sink = []
    t = _fake_transport("oauth2/token", resp, sink=sink)
    tokens = fitbit.exchange_code("CID", "SEC", "CODE",
                                  "http://127.0.0.1:5001/cb", transport=t, now=1000.0)
    assert tokens["access_token"] == "A" and tokens["expires_at"] == 1000.0 + 28800
    # HTTP Basic auth header present
    _, _, headers, body = sink[0]
    assert headers["Authorization"].startswith("Basic ")
    assert "grant_type=authorization_code" in body


def test_refresh_tokens():
    resp = {"access_token": "A2", "refresh_token": "R2",
            "scope": "sleep", "expires_in": 28800}
    t = _fake_transport("oauth2/token", resp)
    tokens = fitbit.refresh_tokens("CID", "SEC", "R", transport=t, now=5.0)
    assert tokens["access_token"] == "A2" and tokens["refresh_token"] == "R2"


def test_fetch_sleep_calls_dated_endpoint():
    sink = []
    t = _fake_transport("/sleep/date/2026-06-29.json", STAGED, sink=sink)
    raw = fitbit.fetch_sleep("ACCESS", "2026-06-29", transport=t)
    assert raw == STAGED
    _, url, headers, _ = sink[0]
    assert headers["Authorization"] == "Bearer ACCESS"
    assert url.endswith("/1.2/user/-/sleep/date/2026-06-29.json")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest tests/test_fitbit.py -k "authorize or exchange or refresh or fetch_sleep" -v`
Expected: FAIL (`AttributeError: module 'fitbit' has no attribute 'build_authorize_url'`).

- [ ] **Step 3: Implement OAuth/transport in `fitbit.py`** (add imports + functions)

```python
# add near the top of fitbit.py
import base64
import json
import urllib.parse
import urllib.request

_AUTHORIZE = "https://www.fitbit.com/oauth2/authorize"
_TOKEN = "https://api.fitbit.com/oauth2/token"
_API = "https://api.fitbit.com"


def build_authorize_url(client_id, redirect_uri, state, scope="sleep"):
    q = urllib.parse.urlencode({
        "client_id": client_id,
        "response_type": "code",
        "scope": scope,
        "redirect_uri": redirect_uri,
        "state": state,
    })
    return f"{_AUTHORIZE}?{q}"


def _urllib_transport(method, url, headers, body):
    data = body.encode("utf-8") if isinstance(body, str) else body
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.status, json.loads(resp.read().decode("utf-8"))


def _basic_auth(client_id, client_secret):
    raw = f"{client_id}:{client_secret}".encode("utf-8")
    return "Basic " + base64.b64encode(raw).decode("ascii")


def _post_token(client_id, client_secret, form, transport, now):
    transport = transport or _urllib_transport
    headers = {
        "Authorization": _basic_auth(client_id, client_secret),
        "Content-Type": "application/x-www-form-urlencoded",
    }
    body = urllib.parse.urlencode(form)
    status, payload = transport("POST", _TOKEN, headers, body)
    if status != 200:
        raise RuntimeError(f"Fitbit token error {status}: {payload}")
    return normalize_token_response(payload, now=now)


def exchange_code(client_id, client_secret, code, redirect_uri,
                  transport=None, now=None):
    return _post_token(client_id, client_secret, {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
    }, transport, now)


def refresh_tokens(client_id, client_secret, refresh_token,
                   transport=None, now=None):
    return _post_token(client_id, client_secret, {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
    }, transport, now)


def fetch_sleep(access_token, date, transport=None):
    transport = transport or _urllib_transport
    url = f"{_API}/1.2/user/-/sleep/date/{date}.json"
    headers = {"Authorization": f"Bearer {access_token}"}
    status, payload = transport("GET", url, headers, None)
    if status == 401:
        raise PermissionError("Fitbit token expired")
    if status != 200:
        raise RuntimeError(f"Fitbit sleep error {status}: {payload}")
    return payload
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_fitbit.py -v`
Expected: PASS (all fitbit tests).

- [ ] **Step 5: Commit**

```bash
git add fitbit.py tests/test_fitbit.py
git commit -m "feat: fitbit OAuth + sleep fetch with injectable transport"
```

---

## Task 4: `journal.py` — `sleep` field migration + `set_entry_sleep`

**Files:**
- Modify: `journal.py` (`load()` ~line 80-89; near `delete_entry` ~line 510)
- Test: `tests/test_journal.py`

**Interfaces:**
- Consumes: `get_entry_by_date`, `upsert_entry` (existing).
- Produces: `set_entry_sleep(data, date, sleep, now=None) -> dict` (the entry). Creates the entry if absent (title defaults to date), sets `entry["sleep"]`, bumps `updated`. `sleep=None` clears it. `load()` defaults every entry's `sleep` to `None`.

- [ ] **Step 1: Write the failing tests**

```python
# add to tests/test_journal.py
def test_set_entry_sleep_creates_entry():
    data = journal._seeded()
    s = {"start": "23:00", "end": "06:00", "duration_min": 420,
         "efficiency": 90, "score": None, "quality": 90,
         "stages": None, "source": "fitbit", "fetched": "x"}
    journal.set_entry_sleep(data, "2026-06-29", s)
    e = journal.get_entry_by_date(data, "2026-06-29")
    assert e is not None and e["sleep"]["duration_min"] == 420


def test_set_entry_sleep_updates_existing():
    data = journal._seeded()
    journal.upsert_entry(data, "2026-06-29", "Day", "body")
    journal.set_entry_sleep(data, "2026-06-29", {"duration_min": 400})
    journal.set_entry_sleep(data, "2026-06-29", {"duration_min": 999})
    assert journal.get_entry_by_date(data, "2026-06-29")["sleep"]["duration_min"] == 999
    # only one entry for the date
    assert sum(e["date"] == "2026-06-29" for e in data["entries"]) == 1


def test_set_entry_sleep_none_clears():
    data = journal._seeded()
    journal.set_entry_sleep(data, "2026-06-29", {"duration_min": 400})
    journal.set_entry_sleep(data, "2026-06-29", None)
    assert journal.get_entry_by_date(data, "2026-06-29")["sleep"] is None


def test_load_defaults_sleep(tmp_path):
    p = tmp_path / "j.json"
    data = journal._seeded()
    journal.upsert_entry(data, "2026-06-29", "Day", "b")
    journal.save(str(p), data)
    loaded = journal.load(str(p))
    assert loaded["entries"][0]["sleep"] is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest tests/test_journal.py -k "sleep" -v`
Expected: FAIL (`AttributeError: module 'journal' has no attribute 'set_entry_sleep'`).

- [ ] **Step 3: Implement**

In `load()`, alongside `e.setdefault("mood", None)` (around line 88), add:

```python
            e.setdefault("sleep", None)
```

Add after `delete_entry` (around line 514):

```python
def set_entry_sleep(data, date, sleep, now=None):
    """Set (or clear, with sleep=None) the auto-filled sleep dict for `date`.

    Reuses the one-entry-per-date rule: updates the existing entry or creates a
    minimal one (title = the date) so sleep can land before the user writes
    anything. Bumps `updated`.
    """
    if not _valid_date(date):
        raise ValueError(f"Invalid date: {date!r}")
    now = now or datetime.now()
    entry = get_entry_by_date(data, date)
    if entry is None:
        entry = upsert_entry(data, date, date, "", now=now)
    entry["sleep"] = sleep
    entry["updated"] = now.isoformat()
    return entry
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_journal.py -k "sleep" -v`
Expected: PASS (4 passed).

- [ ] **Step 5: Commit**

```bash
git add journal.py tests/test_journal.py
git commit -m "feat: journal sleep field + set_entry_sleep"
```

---

## Task 5: `journal.py` — sleep analytics helpers + payload

**Files:**
- Modify: `journal.py` (add helpers near `mood_series` ~line 1047; extend `analytics_payload` ~line 1565)
- Test: `tests/test_journal.py`

**Interfaces:**
- Consumes: `_filter_entries_by_date`, `_DOW_NAMES` (existing).
- Produces (all ignore entries lacking `sleep`; `start`/`end` None bounds = unbounded):
  - `_entry_sleep(entry) -> dict|None`
  - `sleep_series(entries, start=None, end=None) -> [{date, hours}]` sorted by date.
  - `sleep_quality_series(entries, start=None, end=None) -> [{date, quality}]`.
  - `sleep_stage_averages(entries, start=None, end=None) -> {deep, light, rem, wake}` mean minutes over staged nights (each None when no staged night).
  - `sleep_dow_averages(entries, start=None, end=None) -> {weekday_name: mean hours | None}` Mon..Sun.
  - `bedtime_series(entries, start=None, end=None) -> [{date, bed_min, wake_min}]` minutes-from-midnight; bedtimes at/after 12:00 are stored as negative (clock minus 1440) so a band around midnight is continuous.
  - `sleep_coverage(entries, start=None, end=None) -> {nights, span_days, pct}`.
  - `sleep_mood_pairs(entries, start=None, end=None) -> [{hours, mood}]` same-day, both present.
  - `sleep_stats(entries, start=None, end=None) -> {avg_hours, avg_quality, avg_bedtime, avg_waketime, nights}` (averages None when no data; `avg_bedtime`/`avg_waketime` are `"HH:MM"`).
  - `analytics_payload` entries gain `"sleep": _entry_sleep(e)`.

- [ ] **Step 1: Write the failing tests**

```python
# add to tests/test_journal.py
def _entry_with_sleep(date, dur_min, quality, start="23:00", end="06:00",
                      stages=None):
    return {"date": date, "tags": {}, "numbers": {}, "body": "", "mood": None,
            "sleep": {"start": start, "end": end, "duration_min": dur_min,
                      "efficiency": quality, "score": None, "quality": quality,
                      "stages": stages, "source": "fitbit", "fetched": "x"}}


def test_sleep_series_sorted_and_hours():
    entries = [_entry_with_sleep("2026-06-29", 420, 90),
               _entry_with_sleep("2026-06-28", 480, 80),
               {"date": "2026-06-27", "tags": {}, "numbers": {}, "mood": None,
                "body": "", "sleep": None}]
    out = journal.sleep_series(entries)
    assert [d["date"] for d in out] == ["2026-06-28", "2026-06-29"]
    assert out[0]["hours"] == 8.0


def test_sleep_stage_averages():
    entries = [_entry_with_sleep("2026-06-29", 420, 90,
                stages={"deep": 60, "light": 200, "rem": 100, "wake": 30}),
               _entry_with_sleep("2026-06-28", 480, 80,
                stages={"deep": 80, "light": 220, "rem": 120, "wake": 20})]
    avg = journal.sleep_stage_averages(entries)
    assert avg["deep"] == 70 and avg["rem"] == 110


def test_bedtime_series_wraps_pre_midnight_negative():
    out = journal.bedtime_series([_entry_with_sleep("2026-06-29", 420, 90,
                                  start="23:00", end="06:00")])
    assert out[0]["bed_min"] == 23 * 60 - 1440  # = -60
    assert out[0]["wake_min"] == 6 * 60


def test_sleep_mood_pairs_requires_both():
    e1 = _entry_with_sleep("2026-06-29", 420, 90); e1["mood"] = 5
    e2 = _entry_with_sleep("2026-06-28", 480, 80)  # no mood
    assert journal.sleep_mood_pairs([e1, e2]) == [{"hours": 7.0, "mood": 5}]


def test_sleep_coverage():
    entries = [_entry_with_sleep("2026-06-29", 420, 90),
               _entry_with_sleep("2026-06-27", 480, 80)]
    cov = journal.sleep_coverage(entries, "2026-06-25", "2026-06-29")
    assert cov["nights"] == 2 and cov["span_days"] == 5


def test_sleep_stats_empty():
    s = journal.sleep_stats([])
    assert s["nights"] == 0 and s["avg_hours"] is None


def test_payload_carries_sleep():
    data = journal._seeded()
    journal.set_entry_sleep(data, "2026-06-29", {"duration_min": 420,
        "start": "23:00", "end": "06:00", "quality": 90, "efficiency": 90,
        "score": None, "stages": None, "source": "fitbit", "fetched": "x"})
    p = journal.analytics_payload(data)
    assert p["entries"][0]["sleep"]["duration_min"] == 420
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest tests/test_journal.py -k "sleep_series or stage_averages or bedtime or mood_pairs or coverage or sleep_stats or payload_carries" -v`
Expected: FAIL (`AttributeError: ... 'sleep_series'`).

- [ ] **Step 3: Implement the helpers** (insert before `mood_series`, ~line 1047)

```python
def _entry_sleep(entry):
    """The entry's sleep dict if it has a usable duration, else None."""
    s = entry.get("sleep")
    if isinstance(s, dict) and s.get("duration_min"):
        return s
    return None


def _clock_to_min(hhmm):
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def sleep_series(entries, start=None, end=None):
    out = []
    for e in _filter_entries_by_date(entries, start, end):
        s = _entry_sleep(e)
        if s:
            out.append({"date": e["date"], "hours": round(s["duration_min"] / 60, 2)})
    out.sort(key=lambda d: d["date"])
    return out


def sleep_quality_series(entries, start=None, end=None):
    out = []
    for e in _filter_entries_by_date(entries, start, end):
        s = _entry_sleep(e)
        if s and s.get("quality") is not None:
            out.append({"date": e["date"], "quality": s["quality"]})
    out.sort(key=lambda d: d["date"])
    return out


def sleep_stage_averages(entries, start=None, end=None):
    buckets = {k: [] for k in ("deep", "light", "rem", "wake")}
    for e in _filter_entries_by_date(entries, start, end):
        s = _entry_sleep(e)
        if s and s.get("stages"):
            for k in buckets:
                buckets[k].append(s["stages"].get(k, 0))
    return {k: (sum(v) / len(v) if v else None) for k, v in buckets.items()}


def sleep_dow_averages(entries, start=None, end=None):
    buckets = {i: [] for i in range(7)}
    for e in _filter_entries_by_date(entries, start, end):
        s = _entry_sleep(e)
        if s:
            d = datetime.strptime(e["date"], "%Y-%m-%d").date()
            buckets[d.weekday()].append(s["duration_min"] / 60)
    return {_DOW_NAMES[i]: (sum(v) / len(v) if v else None)
            for i, v in buckets.items()}


def bedtime_series(entries, start=None, end=None):
    out = []
    for e in _filter_entries_by_date(entries, start, end):
        s = _entry_sleep(e)
        if not s:
            continue
        bed = _clock_to_min(s["start"])
        if bed >= 12 * 60:           # evening bedtime -> negative (pre-midnight)
            bed -= 1440
        out.append({"date": e["date"], "bed_min": bed,
                    "wake_min": _clock_to_min(s["end"])})
    out.sort(key=lambda d: d["date"])
    return out


def sleep_coverage(entries, start=None, end=None):
    rows = _filter_entries_by_date(entries, start, end)
    nights = sum(1 for e in rows if _entry_sleep(e))
    dates = sorted(e["date"] for e in rows if e.get("date"))
    if start and end:
        span = (datetime.strptime(end, "%Y-%m-%d")
                - datetime.strptime(start, "%Y-%m-%d")).days + 1
    elif dates:
        span = (datetime.strptime(dates[-1], "%Y-%m-%d")
                - datetime.strptime(dates[0], "%Y-%m-%d")).days + 1
    else:
        span = 0
    pct = round(100 * nights / span, 1) if span else 0
    return {"nights": nights, "span_days": span, "pct": pct}


def sleep_mood_pairs(entries, start=None, end=None):
    out = []
    for e in _filter_entries_by_date(entries, start, end):
        s = _entry_sleep(e)
        m = _entry_mood(e)
        if s and m is not None:
            out.append({"hours": round(s["duration_min"] / 60, 2), "mood": m})
    return out


def _min_to_clock(total):
    total = int(round(total)) % 1440
    return f"{total // 60:02d}:{total % 60:02d}"


def sleep_stats(entries, start=None, end=None):
    rows = [_entry_sleep(e) for e in _filter_entries_by_date(entries, start, end)]
    rows = [s for s in rows if s]
    if not rows:
        return {"avg_hours": None, "avg_quality": None, "avg_bedtime": None,
                "avg_waketime": None, "nights": 0}
    hours = [s["duration_min"] / 60 for s in rows]
    quals = [s["quality"] for s in rows if s.get("quality") is not None]
    beds = []
    for s in rows:
        b = _clock_to_min(s["start"])
        beds.append(b - 1440 if b >= 12 * 60 else b)
    wakes = [_clock_to_min(s["end"]) for s in rows]
    return {
        "avg_hours": round(sum(hours) / len(hours), 2),
        "avg_quality": round(sum(quals) / len(quals), 1) if quals else None,
        "avg_bedtime": _min_to_clock(sum(beds) / len(beds)),
        "avg_waketime": _min_to_clock(sum(wakes) / len(wakes)),
        "nights": len(rows),
    }
```

In `analytics_payload`, add `"sleep": _entry_sleep(e),` to the per-entry dict (alongside `"mood": _entry_mood(e),`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_journal.py -k "sleep or payload_carries" -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add journal.py tests/test_journal.py
git commit -m "feat: journal sleep analytics helpers + payload"
```

---

## Task 6: `app.py` — config + settings page + credentials/connect/callback/disconnect routes

**Files:**
- Modify: `app.py` (config block ~line 28-44; add routes; add `import integrations, fitbit`)
- Create: `templates/integrations.html`
- Modify: `templates/base.html` (nav link)
- Test: `tests/test_journal_app.py` (route tests)

**Interfaces:**
- Consumes: `integrations.*`, `fitbit.build_authorize_url`, `fitbit.exchange_code`.
- Produces routes: `GET /integrations`, `POST /integrations/fitbit/credentials`, `GET /integrations/fitbit/connect`, `GET /integrations/fitbit/callback`, `POST /integrations/fitbit/disconnect`. Helper `integrations_file()`; helper `_fitbit_redirect_uri()` from `url_for(..., _external=True)`.

- [ ] **Step 1: Write the failing tests**

```python
# add to tests/test_journal_app.py — assumes the existing `client` fixture
# that sets DATA_FILE/JOURNAL_FILE to temp files. Extend it (or add a sibling
# fixture) to also set app.config["INTEGRATIONS_FILE"] to a temp file.
import integrations as I


def test_integrations_page_renders(client):
    r = client.get("/integrations")
    assert r.status_code == 200
    assert b"Fitbit" in r.data


def test_save_credentials_then_connect_redirects_to_fitbit(client, app):
    client.post("/integrations/fitbit/credentials",
                data={"client_id": "CID", "client_secret": "SEC"})
    d = I.load(app.config["INTEGRATIONS_FILE"])
    assert d["fitbit"]["client_id"] == "CID"
    r = client.get("/integrations/fitbit/connect")
    assert r.status_code == 302
    assert "www.fitbit.com/oauth2/authorize" in r.headers["Location"]
    assert "state=" in r.headers["Location"]


def test_callback_exchanges_code(client, app, monkeypatch):
    client.post("/integrations/fitbit/credentials",
                data={"client_id": "CID", "client_secret": "SEC"})
    # capture the state the connect route stored
    client.get("/integrations/fitbit/connect")
    d = I.load(app.config["INTEGRATIONS_FILE"])
    state = d["fitbit"]["oauth_state"]
    monkeypatch.setattr("fitbit.exchange_code",
        lambda *a, **k: {"access_token": "A", "refresh_token": "R",
                         "scope": "sleep", "expires_at": 9e9})
    # avoid network on the post-connect backfill
    monkeypatch.setattr("app._fitbit_sync", lambda *a, **k: {"synced": [], "errors": []})
    r = client.get(f"/integrations/fitbit/callback?code=CODE&state={state}")
    assert r.status_code == 302
    assert I.is_connected(I.load(app.config["INTEGRATIONS_FILE"]), "fitbit")


def test_disconnect_clears_tokens(client, app):
    d = I.load(app.config["INTEGRATIONS_FILE"])
    I.set_tokens(d, "fitbit", {"access_token": "A", "refresh_token": "R"})
    I.save(app.config["INTEGRATIONS_FILE"], d)
    client.post("/integrations/fitbit/disconnect")
    assert not I.is_connected(I.load(app.config["INTEGRATIONS_FILE"]), "fitbit")
```

> If the existing fixtures don't expose `app`, add a fixture that yields the Flask `app` with a temp `INTEGRATIONS_FILE`, mirroring how `DATA_FILE`/`JOURNAL_FILE` are set.

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest tests/test_journal_app.py -k "integrations or credentials or callback or disconnect" -v`
Expected: FAIL (404 / missing route).

- [ ] **Step 3: Implement config + routes in `app.py`**

Add to imports: `import secrets`, `import integrations`, `import fitbit`.

In the config block (after `JOURNAL_FILE`):

```python
app.config["INTEGRATIONS_FILE"] = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "data", "integrations.json")


def integrations_file():
    return app.config["INTEGRATIONS_FILE"]
```

Add routes (place near the other journal routes):

```python
def _fitbit_redirect_uri():
    return url_for("fitbit_callback", _external=True)


@app.route("/integrations")
def integrations_page():
    data = integrations.load(integrations_file())
    fb = integrations.get_provider(data, "fitbit")
    return render_template(
        "integrations.html",
        connected=integrations.is_connected(data, "fitbit"),
        has_creds=bool(fb.get("client_id") and fb.get("client_secret")),
        client_id=fb.get("client_id", ""),
        last_sync=integrations.last_sync(data, "fitbit"),
        redirect_uri=_fitbit_redirect_uri(),
    )


@app.route("/integrations/fitbit/credentials", methods=["POST"])
def fitbit_credentials():
    data = integrations.load(integrations_file())
    integrations.set_credentials(
        data, "fitbit",
        request.form.get("client_id", "").strip(),
        request.form.get("client_secret", "").strip())
    integrations.save(integrations_file(), data)
    flash("Fitbit credentials saved.")
    return redirect(url_for("integrations_page"))


@app.route("/integrations/fitbit/connect")
def fitbit_connect():
    data = integrations.load(integrations_file())
    fb = integrations.get_provider(data, "fitbit")
    if not (fb.get("client_id") and fb.get("client_secret")):
        flash("Enter your Fitbit Client ID and Secret first.")
        return redirect(url_for("integrations_page"))
    state = secrets.token_urlsafe(16)
    fb["oauth_state"] = state
    integrations.save(integrations_file(), data)
    url = fitbit.build_authorize_url(
        fb["client_id"], _fitbit_redirect_uri(), state)
    return redirect(url)


@app.route("/integrations/fitbit/callback")
def fitbit_callback():
    data = integrations.load(integrations_file())
    fb = integrations.get_provider(data, "fitbit")
    if request.args.get("error"):
        flash(f"Fitbit authorization failed: {request.args.get('error')}")
        return redirect(url_for("integrations_page"))
    if not request.args.get("state") or request.args.get("state") != fb.get("oauth_state"):
        flash("Fitbit authorization state mismatch; please try again.")
        return redirect(url_for("integrations_page"))
    try:
        tokens = fitbit.exchange_code(
            fb["client_id"], fb["client_secret"],
            request.args.get("code"), _fitbit_redirect_uri())
    except Exception as exc:  # noqa: BLE001 - surface as a flash, never 500
        flash(f"Fitbit connection failed: {exc}")
        return redirect(url_for("integrations_page"))
    integrations.set_tokens(data, "fitbit", tokens)
    fb.pop("oauth_state", None)
    integrations.save(integrations_file(), data)
    _fitbit_sync(days=30)  # one-time backfill
    flash("Fitbit connected. Sleep data backfilled.")
    return redirect(url_for("integrations_page"))


@app.route("/integrations/fitbit/disconnect", methods=["POST"])
def fitbit_disconnect():
    data = integrations.load(integrations_file())
    integrations.clear_provider(data, "fitbit")
    integrations.save(integrations_file(), data)
    flash("Fitbit disconnected.")
    return redirect(url_for("integrations_page"))
```

> `_fitbit_sync` is implemented in Task 7. For this task's tests it is monkeypatched, so a forward reference is fine (Python resolves it at call time).

Create `templates/integrations.html` (extends `base.html`; themed). Minimum content the tests need plus a styled UI:

```html
{% extends "base.html" %}
{% block content %}
<div class="integrations-wrap">
  <h1>Integrations</h1>
  <section class="integration-card">
    <h2>Fitbit <span class="integration-status {{ 'on' if connected else 'off' }}">
      {{ 'Connected' if connected else 'Not connected' }}</span></h2>
    <p class="muted">Auto-fills nightly sleep (bedtime, wake, duration, quality,
      stages) into your journal. Register a personal app at
      <code>dev.fitbit.com</code> with redirect URL
      <code>{{ redirect_uri }}</code> and scope <code>sleep</code>.</p>

    <form method="post" action="{{ url_for('fitbit_credentials') }}" class="integration-creds">
      <label>Client ID <input name="client_id" value="{{ client_id }}"></label>
      <label>Client Secret <input name="client_secret" type="password"></label>
      <button type="submit">Save credentials</button>
    </form>

    {% if has_creds and not connected %}
      <a class="btn" href="{{ url_for('fitbit_connect') }}">Connect to Fitbit</a>
    {% elif connected %}
      <p class="muted">Last synced: {{ last_sync or 'never' }}</p>
      <button type="button" id="fitbit-sync-now" class="btn">Sync now</button>
      <form method="post" action="{{ url_for('fitbit_disconnect') }}" style="display:inline">
        <button type="submit" class="btn danger"
                data-confirm="Disconnect Fitbit and remove stored tokens?">Disconnect</button>
      </form>
    {% endif %}
  </section>
</div>
{% endblock %}
```

In `base.html`, add a nav link to `{{ url_for('integrations_page') }}` (label "Integrations"), matching the existing nav markup.

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_journal_app.py -k "integrations or credentials or callback or disconnect" -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app.py templates/integrations.html templates/base.html tests/test_journal_app.py
git commit -m "feat: Fitbit settings page + OAuth connect/callback routes"
```

---

## Task 7: `app.py` — sync orchestration + `/integrations/fitbit/sync`

**Files:**
- Modify: `app.py`
- Test: `tests/test_journal_app.py`

**Interfaces:**
- Consumes: `integrations.*`, `fitbit.fetch_sleep`, `fitbit.parse_sleep`, `fitbit.refresh_tokens`, `fitbit.token_expired`, `journal.set_entry_sleep`, `journal.load`, `journal.save`, `todo.today_iso` (or `journal.today_iso`).
- Produces: `_fitbit_sync(days=7, force=False, focus_date=None, now=None) -> dict` returning `{"connected": bool, "synced": [dates], "errors": [str]}`; route `POST /integrations/fitbit/sync` returning JSON `{ok, connected, synced, errors, sleep:{<focus_date>: sleep|null}}`.

**Sync rules:** target = the last `days` calendar dates ending today. Skip a date that already has `entry.sleep` unless `force`. Refresh tokens first if `token_expired`; on a `PermissionError` (401) from `fetch_sleep`, refresh once and retry that date. Per-date exceptions are caught into `errors` and the loop continues. Persist tokens if refreshed; set `last_sync`.

- [ ] **Step 1: Write the failing tests**

```python
# add to tests/test_journal_app.py
def test_sync_writes_sleep(client, app, monkeypatch):
    d = I.load(app.config["INTEGRATIONS_FILE"])
    I.set_tokens(d, "fitbit", {"access_token": "A", "refresh_token": "R",
                               "expires_at": 9e9})
    I.save(app.config["INTEGRATIONS_FILE"], d)
    monkeypatch.setattr("fitbit.fetch_sleep",
        lambda token, date, transport=None: {"sleep": [{
            "isMainSleep": True, "startTime": f"{date}T23:00:00.000",
            "endTime": f"{date}T06:00:00.000", "minutesAsleep": 420,
            "efficiency": 90, "type": "classic", "levels": {"summary": {}}}]})
    r = client.post("/integrations/fitbit/sync?days=1")
    body = r.get_json()
    assert body["ok"] and body["connected"]
    assert len(body["synced"]) == 1
    # entry got the sleep
    import journal
    jdata = journal.load(app.config["JOURNAL_FILE"])
    assert any(e.get("sleep") for e in jdata["entries"])


def test_sync_not_connected(client, app):
    r = client.post("/integrations/fitbit/sync")
    body = r.get_json()
    assert body["ok"] and body["connected"] is False


def test_sync_refreshes_on_401(client, app, monkeypatch):
    d = I.load(app.config["INTEGRATIONS_FILE"])
    I.set_credentials(d, "fitbit", "CID", "SEC")
    I.set_tokens(d, "fitbit", {"access_token": "OLD", "refresh_token": "R",
                               "expires_at": 9e9})
    I.save(app.config["INTEGRATIONS_FILE"], d)
    calls = {"n": 0}
    def fake_fetch(token, date, transport=None):
        calls["n"] += 1
        if token == "OLD":
            raise PermissionError("401")
        return {"sleep": [{"isMainSleep": True,
            "startTime": f"{date}T23:00:00.000", "endTime": f"{date}T06:00:00.000",
            "minutesAsleep": 420, "efficiency": 90, "type": "classic",
            "levels": {"summary": {}}}]}
    monkeypatch.setattr("fitbit.fetch_sleep", fake_fetch)
    monkeypatch.setattr("fitbit.refresh_tokens",
        lambda *a, **k: {"access_token": "NEW", "refresh_token": "R2",
                         "scope": "sleep", "expires_at": 9e9})
    r = client.post("/integrations/fitbit/sync?days=1")
    assert r.get_json()["synced"]
    assert I.load(app.config["INTEGRATIONS_FILE"])["fitbit"]["tokens"]["access_token"] == "NEW"
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/python -m pytest tests/test_journal_app.py -k "sync" -v`
Expected: FAIL (404 / `_fitbit_sync` undefined).

- [ ] **Step 3: Implement in `app.py`**

```python
from datetime import datetime, timedelta


def _recent_dates(days, now=None):
    today = (now or datetime.now()).date()
    return [(today - timedelta(days=i)).isoformat() for i in range(days)]


def _fitbit_sync(days=7, force=False, focus_date=None, now=None):
    istore = integrations.load(integrations_file())
    if not integrations.is_connected(istore, "fitbit"):
        return {"connected": False, "synced": [], "errors": []}
    fb = integrations.get_provider(istore, "fitbit")
    tokens = fb["tokens"]
    cid, secret = fb.get("client_id"), fb.get("client_secret")

    if fitbit.token_expired(tokens) and tokens.get("refresh_token") and cid:
        try:
            tokens = fitbit.refresh_tokens(cid, secret, tokens["refresh_token"])
            integrations.set_tokens(istore, "fitbit", tokens)
        except Exception:  # noqa: BLE001
            pass

    jdata = journal.load(journal_file())
    synced, errors = [], []
    for date in _recent_dates(days, now=now):
        existing = journal.get_entry_by_date(jdata, date)
        if not force and existing is not None and existing.get("sleep"):
            continue
        try:
            try:
                raw = fitbit.fetch_sleep(tokens["access_token"], date)
            except PermissionError:
                if cid and tokens.get("refresh_token"):
                    tokens = fitbit.refresh_tokens(cid, secret, tokens["refresh_token"])
                    integrations.set_tokens(istore, "fitbit", tokens)
                    raw = fitbit.fetch_sleep(tokens["access_token"], date)
                else:
                    raise
            sleep = fitbit.parse_sleep(raw)
            if sleep:
                journal.set_entry_sleep(jdata, date, sleep)
                synced.append(date)
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{date}: {exc}")

    journal.save(journal_file(), jdata)
    integrations.set_last_sync(istore, "fitbit",
                               (now or datetime.now()).replace(microsecond=0).isoformat())
    integrations.save(integrations_file(), istore)
    return {"connected": True, "synced": synced, "errors": errors}


@app.route("/integrations/fitbit/sync", methods=["POST"])
def fitbit_sync_route():
    days = request.args.get("days", type=int) or 7
    focus = request.args.get("date")
    result = _fitbit_sync(days=days, focus_date=focus)
    sleep = {}
    if focus and result["connected"]:
        entry = journal.get_entry_by_date(journal.load(journal_file()), focus)
        sleep = {focus: (entry or {}).get("sleep")}
    return jsonify({"ok": True, **result, "sleep": sleep})
```

> Ensure `jsonify`, `request`, `timedelta` are imported. If `get_entry_by_date` isn't already imported into `app.py`'s namespace, call it as `journal.get_entry_by_date`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest tests/test_journal_app.py -k "sync" -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app.py tests/test_journal_app.py
git commit -m "feat: Fitbit sleep sync orchestration + endpoint"
```

---

## Task 8: Entry-form sleep panel + `fitbit-sync.js`

**Files:**
- Modify: `templates/journal_entry.html`, `templates/base.html` (load `fitbit-sync.js` on the entry page only)
- Create: `static/fitbit-sync.js`
- Modify: `static/style.css` (`.sleep-panel*`)
- Modify: `app.py` — the journal entry route(s) pass `fitbit_connected` + `fitbit_last_sync` + the current entry's `sleep` to the template.

**Interfaces:**
- Consumes: `POST /integrations/fitbit/sync?days=7&date=<shown>` (Task 7).
- Produces: a read-only sleep panel that renders server-side from `entry.sleep` and is updated in place by the JS after a background sync.

- [ ] **Step 1: Manual-test plan (this task is UI; verify by running the app)**

Because this is rendering/JS, verify with the running app rather than a unit test (route behavior is already covered in Tasks 6–7). After implementing, run the app and confirm: (a) entry page shows "No sleep data" when connected & empty, a "Connect Fitbit" link when not connected, and a populated panel when data exists; (b) "Sync now" updates the panel without a full reload.

- [ ] **Step 2: Pass context from the entry route(s)**

In the `GET /journal` and `GET /journal/<date>` handlers, load the integrations store and the shown entry, then pass to `render_template`:

```python
istore = integrations.load(integrations_file())
render_template("journal_entry.html", ...,
    fitbit_connected=integrations.is_connected(istore, "fitbit"),
    fitbit_last_sync=integrations.last_sync(istore, "fitbit"),
    sleep=(entry or {}).get("sleep"))
```

- [ ] **Step 3: Add the panel to `journal_entry.html`** (near the mood row)

```html
<div class="sleep-panel" id="sleep-panel"
     data-date="{{ date }}"
     data-connected="{{ '1' if fitbit_connected else '0' }}"
     data-last-sync="{{ fitbit_last_sync or '' }}">
  {% if sleep %}
    <span class="sleep-icon">🛌</span>
    <span class="sleep-times">{{ sleep.start }} → {{ sleep.end }}</span>
    <span class="sleep-dur">{{ (sleep.duration_min // 60) }}h {{ (sleep.duration_min % 60) }}m</span>
    <span class="sleep-qual">{{ 'Quality' if sleep.score is not none else 'Quality (efficiency)' }} {{ sleep.quality }}</span>
  {% elif fitbit_connected %}
    <span class="muted">No sleep data for this day</span>
  {% else %}
    <a class="muted" href="{{ url_for('integrations_page') }}">Connect Fitbit to auto-fill sleep →</a>
  {% endif %}
</div>
```

- [ ] **Step 4: Create `static/fitbit-sync.js`**

```javascript
// Background Fitbit sleep sync on the journal entry page.
(function () {
  const panel = document.getElementById("sleep-panel");
  if (!panel) return;
  const connected = panel.dataset.connected === "1";

  function renderSleep(s) {
    if (!s) return;  // leave the server-rendered "No sleep data" line
    const dur = `${Math.floor(s.duration_min / 60)}h ${s.duration_min % 60}m`;
    const label = s.score != null ? "Quality" : "Quality (efficiency)";
    panel.innerHTML =
      `<span class="sleep-icon">🛌</span>` +
      `<span class="sleep-times">${s.start} → ${s.end}</span>` +
      `<span class="sleep-dur">${dur}</span>` +
      `<span class="sleep-qual">${label} ${s.quality}</span>`;
  }

  function sync(days) {
    const date = panel.dataset.date;
    return fetch(`/integrations/fitbit/sync?days=${days}&date=${date}`,
                 { method: "POST" })
      .then((r) => r.json())
      .then((body) => { if (body.sleep && body.sleep[date]) renderSleep(body.sleep[date]); })
      .catch(() => {});
  }

  // Throttle the auto-sync to once an hour using the stored last_sync.
  if (connected) {
    const last = panel.dataset.lastSync;
    const stale = !last || (Date.now() - Date.parse(last)) > 3600 * 1000;
    if (stale) sync(7);
  }

  // "Sync now" buttons (entry page + settings page) force a refresh.
  document.querySelectorAll("#fitbit-sync-now, #fitbit-sync-entry")
    .forEach((b) => b.addEventListener("click", () => sync(7).then(() => {
      if (b.id === "fitbit-sync-now") location.reload();
    })));
})();
```

In `base.html`, load `fitbit-sync.js` (defer) on pages that have the panel/settings page — gate with a Jinja flag the entry & integrations templates set, or load app-wide (it no-ops without `#sleep-panel`/buttons). Loading app-wide is simplest and safe.

- [ ] **Step 5: Add themed styles to `style.css`**

```css
.sleep-panel { display:flex; gap:.6rem; align-items:center; flex-wrap:wrap;
  font-size:.85rem; color:var(--muted); margin:.4rem 0; }
.sleep-panel .sleep-times { color:var(--text); }
.sleep-panel .sleep-qual { color:var(--accent); }
.integration-card { border:1px solid var(--border); border-radius:8px;
  padding:1rem 1.2rem; background:var(--panel); max-width:640px; }
.integration-status.on { color:var(--accent); }
.integration-status.off { color:var(--muted); }
.integration-creds { display:grid; gap:.6rem; margin:.8rem 0; }
.integration-creds label { display:flex; flex-direction:column; gap:.2rem;
  font-size:.85rem; color:var(--muted); }
```

- [ ] **Step 6: Run the app and verify the three panel states + Sync now**

Run: `flask --app app run --port 5001` and exercise `/journal` and `/integrations`. Restart after edits.

- [ ] **Step 7: Run the full suite + commit**

```bash
.venv/bin/python -m pytest
git add app.py templates/journal_entry.html templates/base.html static/fitbit-sync.js static/style.css
git commit -m "feat: entry-form sleep panel + background sync JS"
```

---

## Task 9: Analytics **Sleep** tab

**Files:**
- Modify: `static/analytics.js` (add to `CHARTS` registry + any `hasSleep` gate), `templates/journal_analytics.html` (if tabs are declared there), `static/style.css` (Sleep-tab styles)
- Test: `tests/test_journal_analytics.py` (payload assertion) + manual chart verification

**Interfaces:**
- Consumes: `analytics_payload` entries' `sleep` field (Task 5); existing `U.*` SVG utilities, `CHARTS` descriptor pattern, `_secSel`/lens machinery.
- Produces: a `Sleep` tab with `lens: ["journal"]`, gated on `hasSleep` (any in-range entry has a `sleep` object). Charts: stat cards (avg duration/quality/bedtime/waketime/nights), duration-over-time + 7-night rolling avg, quality-over-time, bedtime/wake consistency band, avg duration by weekday, stage composition, sleep↔mood scatter (Pearson r), nights coverage.

- [ ] **Step 1: Payload regression test**

```python
# tests/test_journal_analytics.py
import journal


def test_payload_includes_sleep_for_sleep_tab():
    data = journal._seeded()
    journal.set_entry_sleep(data, "2026-06-29", {"duration_min": 420,
        "start": "23:00", "end": "06:00", "quality": 90, "efficiency": 90,
        "score": None, "stages": {"deep": 60, "light": 240, "rem": 90, "wake": 30},
        "source": "fitbit", "fetched": "x"})
    p = journal.analytics_payload(data)
    assert p["entries"][0]["sleep"]["stages"]["deep"] == 60
```

Run: `.venv/bin/python -m pytest tests/test_journal_analytics.py -k sleep -v` → PASS (payload already carries sleep from Task 5).

- [ ] **Step 2: Add the Sleep tab to `analytics.js`**

Mirror the **Mood tab** implementation exactly. Concretely:

1. Compute `hasSleep` next to `hasMood`/`hasNumeric`: `const hasSleep = _data.entries.some(e => e.sleep);`
2. Register the tab descriptor in `CHARTS`/`PANELS` with `lens: ["journal"]` and a `needs`/gate referencing `hasSleep` (follow how the Mood tab gates on `hasMood`).
3. Add chart descriptors using the existing SVG helpers. Reuse the mood-over-time line+rolling-avg pattern for **duration over time** (y in hours) and **quality over time**; reuse the DOW-bars pattern for **avg duration by weekday**; reuse the mood-distribution/stacked pattern for **stage composition**; reuse the mood-vs-numeric scatter (with Pearson `r`) for **sleep↔mood**. Derive series in JS from `e.sleep` (e.g. `hours = e.sleep.duration_min/60`), matching the pure helpers in Task 5 so server and client agree.
4. Stat cards: reuse the `.stat-card*` markup used by the Overview/Numeric tabs (avg duration, avg quality, avg bedtime/waketime as `HH:MM`, nights).
5. Bedtime/wake consistency: plot `bed_min` (pre-midnight negative) and `wake_min` per night as two lines/bands using the existing line utility with a custom y-axis formatter that renders minutes→`HH:MM`.

Keep all colors from CSS vars / section hex; no hardcoded theme colors.

- [ ] **Step 3: Styling**

Add any Sleep-tab-specific classes to `style.css` (e.g. a `.sleep-stage-legend`) consistent with the existing chart styles. Reuse `.stat-cards`/`.chart-svg` wherever possible.

- [ ] **Step 4: Run the app + verify charts**

Connect Fitbit (or hand-seed a few `entry.sleep` values into a temp `journal.json`), open `/journal/analytics`, switch to the **Journal** lens, confirm the **Sleep** tab appears only when sleep data exists and every chart renders with the dark theme.

- [ ] **Step 5: Full suite + commit**

```bash
.venv/bin/python -m pytest
git add static/analytics.js templates/journal_analytics.html static/style.css tests/test_journal_analytics.py
git commit -m "feat: analytics Sleep tab (Journal lens)"
```

---

## Task 10: Document the integration in `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add an "Integrations" subsection** documenting: `fitbit.py` (pure, injectable transport), `integrations.py` store + `data/integrations.json` (gitignored), the `entry["sleep"]` model + date attribution, the `/integrations/*` routes + `/integrations/fitbit/sync`, the on-load throttled sync + "Sync now", the sleep analytics helpers + Sleep tab (Journal lens, `hasSleep`), `static/fitbit-sync.js`, and the new styles. Note RescueTime/Spotify are deferred but the store is shaped for them. Update the **Data files** section to list `data/integrations.json`, and extend the "Extend `load()` and `_empty()`" note to mention the entry `sleep` field.

- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: document Fitbit sleep integration in CLAUDE.md"
```

---

## Self-Review (completed by plan author)

- **Spec coverage:** integrations store (T1), parse + OAuth + fetch (T2–T3), entry field + writer (T4), analytics helpers + payload (T5), settings/OAuth routes (T6), sync orchestration incl. 401-refresh + per-day errors (T7), entry panel + throttled on-load sync + Sync now (T8), Sleep tab gated on `hasSleep` under Journal lens (T9), docs + gitignore note (T10). Quality-metric rule (`score` else `efficiency`), date attribution, 30-day backfill / 7-day window, stdlib-only, injectable transport/clock, and mandatory styling all map to tasks.
- **Placeholder scan:** none — every code step shows real code; UI/chart tasks (T8–T9) are explicitly verified by running the app since they're rendering/JS, with route/payload behavior unit-tested in T5–T7.
- **Type consistency:** `transport(method,url,headers,body)->(status,json)`, tokens dict (`access_token/refresh_token/scope/expires_at/fetched`), sleep dict (`start/end/duration_min/efficiency/score/quality/stages/source/fetched`), and `_fitbit_sync(...)->{connected,synced,errors}` are used consistently across T2–T9.
