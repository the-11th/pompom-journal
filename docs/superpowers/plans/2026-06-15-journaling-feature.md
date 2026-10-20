# Journaling Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a daily-journal section to Datapom — per-date entries with configurable tag/numeric sections — alongside the existing to-do app, with an analytics-ready data model.

**Architecture:** A new pure-logic module `journal.py` (zero Flask imports, injectable `now`) mirrors `todo.py`. Journal routes are added to `app.py` using Post/Redirect/Get. Data lives in a separate `data/journal.json` with its own forgiving `load()`/atomic `save()`. Templates share a refactored `base.html` (brand/nav become blocks). `journal.py` imports only `todo.py`'s pure validators/`text_color_for` for a single source of truth.

**Tech Stack:** Python 3.12, Flask, Jinja2, pytest. JSON file storage. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-15-journaling-feature-design.md`

---

## AMENDMENT (post-Task-7): brand-mascot toggle

After Task 7, the navigation was redesigned per user feedback. The code blocks
in Tasks 8–11 below still show the OLD toggle markup; follow this amendment
where they conflict:

- **The brand mascot itself is the toggle** (no separate right-side
  `.puri-toggle` element). Clicking the brand mascot switches Tasks ⇄ Journal,
  with a directional caption ("journal →" on task pages, "todo →" on journal
  pages) stacked beneath it.
- **`base.html` now exposes two blocks instead of `{% block brand %}`:**
  `{% block brand_mascot %}` (the `<img class="mascot" ...>`) and
  `{% block brand_title %}` (the `<span class="site-title">`). The toggle anchor
  and caption live in `base.html` and are shared.
- **Journal templates (Tasks 8, 9, 10) must override `brand_mascot` and
  `brand_title`**, NOT `brand`. Use class `mascot` (the `mascot-puri` class no
  longer exists). Pattern:
  ```html
  {% block brand_mascot %}
    <img class="mascot" src="{{ url_for('static', filename='img/pompompurin.gif') }}"
         width="56" height="56" alt="pompompurin">
  {% endblock %}
  {% block brand_title %}
    <span class="site-title">journal</span>
  {% endblock %}
  ```
- **Task 11 (styling): do NOT add `.puri-toggle` / `.mascot-puri` rules** — they
  were replaced by `.brand-toggle` / `.brand-mascot-stack` / `.brand-switch`,
  already present in `static/style.css`. Skip Task 11 Step 1's pompompurin-toggle
  CSS lines; keep the rest.
- The `static/img/pompompurin.gif` placeholder asset already exists (Task 12
  Step 1 is done).
- **Journal nav (all journal templates):** the middle link is
  `<a href="{{ url_for('journal_search') }}">Search</a>` — NOT "Past entries" /
  `journal_list` (Task 9 was changed to a Search tab). Use this nav in
  `journal_entry.html`, `journal_search.html`, and `journal_sections.html`.

---

## File structure

- **Create `journal.py`** — journal domain logic: persistence, sections, entries, display helpers.
- **Create `tests/test_journal.py`** — unit tests for `journal.py` (fixed `now`, `tmp_path`).
- **Create `tests/test_journal_app.py`** — Flask route tests (temp `JOURNAL_FILE`).
- **Create `templates/journal_entry.html`** — the per-date create/edit form.
- **Create `templates/journal_search.html`** — the Search tab (was `journal_list.html`; see Task 9).
- **Create `templates/journal_sections.html`** — sections management page.
- **Modify `templates/base.html`** — brand/nav become `{% block %}`s; add the Pompompurin toggle.
- **Modify `app.py`** — `JOURNAL_FILE` config, Jinja globals, context processor, journal routes.
- **Modify `static/style.css`** — journal section grid, chips, numeric cards, color preview.
- **Add `static/img/pompompurin.gif`** — supplied by the user; placeholder until then.
- `todo.py` is **not modified**.

Helpers reused from `todo.py` (all pure, Flask-free): `_HEX_COLOR_RE`, `_TAG_NAME_RE`, `text_color_for`.

---

## Task 1: Journal store scaffolding & persistence

**Files:**
- Create: `journal.py`
- Test: `tests/test_journal.py`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_journal.py
"""Tests for the pure journal logic in journal.py.

Fixed `now` for deterministic timestamps; pytest tmp_path for file I/O.
Stores are initialized via journal._empty() unless a test needs seeding.
"""

import json
from datetime import datetime

import pytest

import journal

NOW = datetime(2026, 6, 15, 9, 0, 0)


def test_empty_store_shape():
    assert journal._empty() == {"sections": [], "entries": []}


def test_seeded_has_six_default_tag_sections():
    data = journal._seeded()
    names = [s["name"] for s in data["sections"]]
    assert names == ["people", "places", "food", "chores", "health", "work"]
    assert all(s["type"] == "tag" for s in data["sections"])
    assert all(s["tags"] == [] and s["archived"] is False for s in data["sections"])
    # ids are unique
    assert len({s["id"] for s in data["sections"]}) == 6


def test_save_then_load_round_trips(tmp_path):
    path = str(tmp_path / "journal.json")
    data = journal._empty()
    journal.save(path, data)
    assert journal.load(path) == data


def test_load_missing_file_returns_seeded(tmp_path):
    path = str(tmp_path / "nope.json")
    data = journal.load(path)
    assert [s["name"] for s in data["sections"]][0] == "people"


def test_load_corrupt_backs_up_and_seeds(tmp_path):
    path = tmp_path / "journal.json"
    path.write_text("{ not json", encoding="utf-8")
    data = journal.load(str(path))
    assert (tmp_path / "journal.json.bak").exists()
    assert len(data["sections"]) == 6


def test_load_migrates_missing_fields(tmp_path):
    path = tmp_path / "journal.json"
    path.write_text(json.dumps({
        "sections": [{"id": "x", "name": "people", "type": "tag", "color": "#fff"}],
        "entries": [{"id": "e", "date": "2026-06-15", "title": "t", "body": ""}],
    }), encoding="utf-8")
    data = journal.load(str(path))
    s = data["sections"][0]
    assert s["tags"] == [] and s["unit"] is None and s["archived"] is False
    e = data["entries"][0]
    assert e["tags"] == {} and e["numbers"] == {}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest tests/test_journal.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'journal'`.

- [ ] **Step 3: Create `journal.py` with the store + persistence**

```python
# journal.py
"""Core journal logic.

Pure, testable functions over a plain data dict of the shape:

    {"sections": [...], "entries": [...]}

NO Flask imports -- this is the journal "brain". The only dependency is a
one-way import of todo.py's pure validators and text_color_for, so hex/name
validation and contrast math have a single source of truth.

Dates: entry `date` is a YYYY-MM-DD string; timestamps are ISO 8601. All naive
local time, matching todo.py.
"""

import json
import os
import uuid
from datetime import datetime

from todo import _HEX_COLOR_RE, _TAG_NAME_RE, text_color_for  # noqa: F401

# Default sections seeded on first run: six tag sections with distinct colors.
_DEFAULT_SECTIONS = [
    ("people", "#e0a955"),
    ("places", "#6fa8dc"),
    ("food", "#93c47d"),
    ("chores", "#c27ba0"),
    ("health", "#76a5af"),
    ("work", "#e06666"),
]

DEFAULT_SECTION_COLOR = "#8a8f99"
_MAX_UNIT_LEN = 12


def _empty():
    """A fresh, truly empty store (used by tests)."""
    return {"sections": [], "entries": []}


def _seeded():
    """A fresh store with the six default tag sections."""
    data = _empty()
    for name, color in _DEFAULT_SECTIONS:
        add_section(data, name, "tag", color)
    return data


# --------------------------------------------------------------------------- #
# Persistence
# --------------------------------------------------------------------------- #

def load(path):
    """Read the journal store. Missing file -> a seeded store. Corrupt file ->
    backed up to <path>.bak and a seeded store returned. Missing per-section /
    per-entry fields are defaulted (forgiving, backward-compatible migration).
    """
    try:
        with open(path, "r", encoding="utf-8") as f:
            parsed = json.load(f)
    except FileNotFoundError:
        return _seeded()
    except json.JSONDecodeError:
        _backup(path)
        return _seeded()

    if (
        isinstance(parsed, dict)
        and isinstance(parsed.get("sections"), list)
        and isinstance(parsed.get("entries"), list)
    ):
        for s in parsed["sections"]:
            s.setdefault("tags", [])
            s.setdefault("unit", None)
            s.setdefault("archived", False)
        for e in parsed["entries"]:
            if not isinstance(e.get("tags"), dict):
                e["tags"] = {}
            if not isinstance(e.get("numbers"), dict):
                e["numbers"] = {}
        return parsed
    _backup(path)
    return _seeded()


def _backup(path):
    """Move a bad store aside to <path>.bak (best effort)."""
    try:
        os.replace(path, path + ".bak")
    except OSError:
        pass


def save(path, data):
    """Atomically write `data` as JSON to `path` (temp file + os.replace).
    Creates the containing directory on first run.
    """
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)
```

> Note: `add_section` is defined in Task 3. Tasks are implemented in order, so
> by the time Task 1's `_seeded()` is exercised by later tests `add_section`
> exists. For Task 1's own tests, `_seeded`/`add_section` are added together —
> include the `add_section` code from Task 3 Step 3 now if running Task 1 in
> isolation.

- [ ] **Step 4: Add the minimal `add_section` needed for seeding** (full version + validation tests come in Task 3)

```python
# journal.py — append below save()
def add_section(data, name, type_, color, unit=None):
    section = {
        "id": uuid.uuid4().hex,
        "name": (name or "").strip().lower(),
        "type": type_,
        "color": color,
        "tags": [],
        "unit": ((unit or "").strip()[:_MAX_UNIT_LEN] or None) if type_ == "numeric" else None,
        "archived": False,
    }
    data.setdefault("sections", []).append(section)
    return section
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pytest tests/test_journal.py -q`
Expected: PASS (6 passed).

- [ ] **Step 6: Commit**

```bash
git add journal.py tests/test_journal.py
git commit -m "Add journal store scaffolding, persistence, and seeding"
```

---

## Task 2: Section lookup & display helpers

**Files:**
- Modify: `journal.py`
- Test: `tests/test_journal.py`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_journal.py — append
def test_active_sections_excludes_archived():
    data = journal._empty()
    a = journal.add_section(data, "people", "tag", "#fff")
    b = journal.add_section(data, "work", "tag", "#000")
    b["archived"] = True
    assert journal.active_sections(data) == [a]


def test_section_by_id_finds_archived_too():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    s["archived"] = True
    assert journal.section_by_id(data, s["id"]) is s
    assert journal.section_by_id(data, "missing") is None


def test_section_color_falls_back_to_default():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#abcdef")
    assert journal.section_color(data, s["id"]) == "#abcdef"
    assert journal.section_color(data, "missing") == journal.DEFAULT_SECTION_COLOR


def test_is_registered_tag():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    s["tags"] = ["maya"]
    assert journal.is_registered_tag(data, s["id"], "maya") is True
    assert journal.is_registered_tag(data, s["id"], "MAYA") is True   # normalized
    assert journal.is_registered_tag(data, s["id"], "ghost") is False
```

- [ ] **Step 2: Run to verify they fail**

Run: `pytest tests/test_journal.py -k "section or registered" -q`
Expected: FAIL — `AttributeError: module 'journal' has no attribute 'active_sections'`.

- [ ] **Step 3: Implement the helpers**

```python
# journal.py — append
def _normalize_name(name):
    """Strip + lowercase a single name (sections, tags)."""
    return (name or "").strip().lower()


def active_sections(data):
    """Non-archived sections, in stored order."""
    return [s for s in data.get("sections", []) if not s.get("archived")]


def section_by_id(data, section_id):
    """A section by id (archived ones included), or None."""
    for s in data.get("sections", []):
        if s.get("id") == section_id:
            return s
    return None


def section_color(data, section_id):
    """The section's hex color, or a neutral default if unknown."""
    s = section_by_id(data, section_id)
    return s["color"] if s else DEFAULT_SECTION_COLOR


def is_registered_tag(data, section_id, tag):
    """True if `tag` is in the section's permanent tag list (normalized)."""
    s = section_by_id(data, section_id)
    return bool(s) and _normalize_name(tag) in (s.get("tags") or [])
```

- [ ] **Step 4: Run to verify they pass**

Run: `pytest tests/test_journal.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add journal.py tests/test_journal.py
git commit -m "Add journal section lookup and display helpers"
```

---

## Task 3: Section CRUD with validation

**Files:**
- Modify: `journal.py`
- Test: `tests/test_journal.py`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_journal.py — append
def test_add_section_validates_and_assigns_id():
    data = journal._empty()
    s = journal.add_section(data, "  People ", "tag", "#e0a955")
    assert s["name"] == "people"           # normalized
    assert s["type"] == "tag" and s["archived"] is False
    assert len(s["id"]) == 32              # uuid4 hex
    assert journal.active_sections(data) == [s]


def test_add_numeric_section_keeps_unit():
    data = journal._empty()
    s = journal.add_section(data, "sleep", "numeric", "#6fa8dc", unit="hrs")
    assert s["type"] == "numeric" and s["unit"] == "hrs"


def test_add_section_rejects_bad_name():
    data = journal._empty()
    for bad in ["", "   ", "no<script>", "a;b"]:
        with pytest.raises(ValueError):
            journal.add_section(data, bad, "tag", "#fff")


def test_add_section_rejects_bad_type_and_color():
    data = journal._empty()
    with pytest.raises(ValueError):
        journal.add_section(data, "x", "bogus", "#fff")
    with pytest.raises(ValueError):
        journal.add_section(data, "x", "tag", "not-a-color")


def test_add_section_rejects_duplicate_active_name():
    data = journal._empty()
    journal.add_section(data, "people", "tag", "#fff")
    with pytest.raises(ValueError):
        journal.add_section(data, "PEOPLE", "tag", "#000")


def test_rename_section():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.rename_section(data, s["id"], "friends")
    assert journal.section_by_id(data, s["id"])["name"] == "friends"


def test_rename_rejects_duplicate():
    data = journal._empty()
    journal.add_section(data, "people", "tag", "#fff")
    s2 = journal.add_section(data, "work", "tag", "#000")
    with pytest.raises(ValueError):
        journal.rename_section(data, s2["id"], "people")


def test_set_color_and_unit():
    data = journal._empty()
    s = journal.add_section(data, "sleep", "numeric", "#fff", unit="hrs")
    journal.set_section_color(data, s["id"], "#123456")
    journal.set_section_unit(data, s["id"], "minutes here")  # capped to 12
    s2 = journal.section_by_id(data, s["id"])
    assert s2["color"] == "#123456"
    assert s2["unit"] == "minutes here"[:12]


def test_archive_section_soft_deletes():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.archive_section(data, s["id"])
    assert journal.section_by_id(data, s["id"])["archived"] is True
    assert journal.active_sections(data) == []
```

- [ ] **Step 2: Run to verify they fail**

Run: `pytest tests/test_journal.py -k "section" -q`
Expected: FAIL — `add_section` does not yet validate (raises nothing / wrong behavior); `rename_section` missing.

- [ ] **Step 3: Replace the minimal `add_section` (from Task 1) with the validated version and add the rest**

```python
# journal.py — REPLACE the stub add_section from Task 1 with this:
def _valid_name(name):
    return bool(name) and bool(_TAG_NAME_RE.match(name))


def add_section(data, name, type_, color, unit=None):
    """Create a section. Validates name (allowlist), type, and hex color.
    Names must be unique among non-archived sections. Returns the new section.
    """
    name = _normalize_name(name)
    if not _valid_name(name):
        raise ValueError(f"Invalid section name: {name!r}")
    if type_ not in ("tag", "numeric"):
        raise ValueError(f"Invalid section type: {type_!r}")
    if not isinstance(color, str) or not _HEX_COLOR_RE.match(color):
        raise ValueError(f"Invalid hex color: {color!r}")
    for s in active_sections(data):
        if s["name"] == name:
            raise ValueError(f"Section already exists: {name!r}")
    section = {
        "id": uuid.uuid4().hex,
        "name": name,
        "type": type_,
        "color": color,
        "tags": [],
        "unit": ((unit or "").strip()[:_MAX_UNIT_LEN] or None) if type_ == "numeric" else None,
        "archived": False,
    }
    data.setdefault("sections", []).append(section)
    return section


def rename_section(data, section_id, new_name):
    """Rename a section (unknown id = no-op). New name validated and unique
    among non-archived sections."""
    new_name = _normalize_name(new_name)
    if not _valid_name(new_name):
        raise ValueError(f"Invalid section name: {new_name!r}")
    for s in active_sections(data):
        if s["name"] == new_name and s["id"] != section_id:
            raise ValueError(f"Section already exists: {new_name!r}")
    target = section_by_id(data, section_id)
    if target is not None:
        target["name"] = new_name
    return data


def set_section_color(data, section_id, color):
    """Update a section's color (validated hex). Unknown id = no-op."""
    if not isinstance(color, str) or not _HEX_COLOR_RE.match(color):
        raise ValueError(f"Invalid hex color: {color!r}")
    s = section_by_id(data, section_id)
    if s is not None:
        s["color"] = color
    return data


def set_section_unit(data, section_id, unit):
    """Set a section's unit label (stripped, capped). Unknown id = no-op."""
    s = section_by_id(data, section_id)
    if s is not None:
        s["unit"] = (unit or "").strip()[:_MAX_UNIT_LEN] or None
    return data


def archive_section(data, section_id):
    """Soft-delete a section (kept for history/analytics). Unknown id = no-op."""
    s = section_by_id(data, section_id)
    if s is not None:
        s["archived"] = True
    return data
```

> `_valid_name` must be defined before `add_section` uses it; place it directly
> above `add_section` as shown. Remove the placeholder `_normalize_name`
> duplication — it already exists from Task 2.

- [ ] **Step 4: Run to verify they pass**

Run: `pytest tests/test_journal.py -q`
Expected: PASS (all journal unit tests so far).

- [ ] **Step 5: Commit**

```bash
git add journal.py tests/test_journal.py
git commit -m "Add validated journal section CRUD (add/rename/color/unit/archive)"
```

---

## Task 4: Permanent tags on sections

**Files:**
- Modify: `journal.py`
- Test: `tests/test_journal.py`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_journal.py — append
def test_add_section_tag_appends_normalized_unique():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.add_section_tag(data, s["id"], " Maya ")
    journal.add_section_tag(data, s["id"], "maya")   # dup ignored
    assert journal.section_by_id(data, s["id"])["tags"] == ["maya"]


def test_add_section_tag_rejects_bad_name_and_numeric_section():
    data = journal._empty()
    tag_s = journal.add_section(data, "people", "tag", "#fff")
    num_s = journal.add_section(data, "sleep", "numeric", "#fff", unit="hrs")
    with pytest.raises(ValueError):
        journal.add_section_tag(data, tag_s["id"], "bad;name")
    with pytest.raises(ValueError):
        journal.add_section_tag(data, num_s["id"], "nope")


def test_remove_section_tag_keeps_entries_unaffected():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.add_section_tag(data, s["id"], "maya")
    journal.remove_section_tag(data, s["id"], "maya")
    assert journal.section_by_id(data, s["id"])["tags"] == []
```

- [ ] **Step 2: Run to verify they fail**

Run: `pytest tests/test_journal.py -k "section_tag" -q`
Expected: FAIL — `add_section_tag` missing.

- [ ] **Step 3: Implement**

```python
# journal.py — append
def add_section_tag(data, section_id, tag):
    """Add a permanent tag to a tag-section (normalized, validated, unique).
    Raises on a bad name or a numeric section. Unknown id = no-op."""
    tag = _normalize_name(tag)
    if not _valid_name(tag):
        raise ValueError(f"Invalid tag name: {tag!r}")
    s = section_by_id(data, section_id)
    if s is None:
        return data
    if s.get("type") != "tag":
        raise ValueError("Cannot add tags to a numeric section")
    if tag not in s.setdefault("tags", []):
        s["tags"].append(tag)
    return data


def remove_section_tag(data, section_id, tag):
    """Remove a permanent tag from a section's master list (entries keep it).
    Unknown id/tag = safe no-op."""
    tag = _normalize_name(tag)
    s = section_by_id(data, section_id)
    if s is not None and isinstance(s.get("tags"), list):
        s["tags"] = [t for t in s["tags"] if t != tag]
    return data
```

- [ ] **Step 4: Run to verify they pass**

Run: `pytest tests/test_journal.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add journal.py tests/test_journal.py
git commit -m "Add permanent-tag add/remove for journal sections"
```

---

## Task 5: Entry lookup & date helpers

**Files:**
- Modify: `journal.py`
- Test: `tests/test_journal.py`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_journal.py — append
def test_today_iso_uses_injected_now():
    assert journal.today_iso(now=NOW) == "2026-06-15"


def test_valid_date():
    assert journal._valid_date("2026-06-15") is True
    assert journal._valid_date("2026-13-99") is False
    assert journal._valid_date("nope") is False
    assert journal._valid_date(None) is False


def test_get_entry_by_date_and_sorted():
    data = journal._empty()
    journal.upsert_entry(data, "2026-06-13", "older", "", now=NOW)
    journal.upsert_entry(data, "2026-06-15", "newer", "", now=NOW)
    assert journal.get_entry_by_date(data, "2026-06-15")["title"] == "newer"
    assert journal.get_entry_by_date(data, "2026-06-01") is None
    dates = [e["date"] for e in journal.entries_sorted(data)]
    assert dates == ["2026-06-15", "2026-06-13"]   # newest first
```

- [ ] **Step 2: Run to verify they fail**

Run: `pytest tests/test_journal.py -k "today_iso or valid_date or by_date" -q`
Expected: FAIL — `today_iso` missing (and `upsert_entry`, implemented in Task 6).

> This test references `upsert_entry` (Task 6). Implement Task 5 and Task 6
> together if running tasks in isolation, or temporarily build entries inline.
> The recommended subagent flow implements tasks in order, so Task 6 follows
> immediately.

- [ ] **Step 3: Implement the helpers**

```python
# journal.py — append
def today_iso(now=None):
    """Today's date as a YYYY-MM-DD string."""
    now = now or datetime.now()
    return now.date().isoformat()


def _valid_date(date_str):
    """True if `date_str` is a YYYY-MM-DD calendar date."""
    if not isinstance(date_str, str):
        return False
    try:
        datetime.strptime(date_str, "%Y-%m-%d")
        return True
    except ValueError:
        return False


def get_entry_by_date(data, date):
    """The entry for `date`, or None (date is the unique key)."""
    for e in data.get("entries", []):
        if e.get("date") == date:
            return e
    return None


def entries_sorted(data):
    """Entries newest date first."""
    return sorted(data.get("entries", []), key=lambda e: e.get("date", ""), reverse=True)
```

- [ ] **Step 4: Run to verify they pass** (after Task 6 lands `upsert_entry`)

Run: `pytest tests/test_journal.py -q`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add journal.py tests/test_journal.py
git commit -m "Add journal entry lookup and date helpers"
```

---

## Task 6: Entry upsert & delete

**Files:**
- Modify: `journal.py`
- Test: `tests/test_journal.py`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_journal.py — append
def test_upsert_creates_then_updates_same_date():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    e1 = journal.upsert_entry(data, "2026-06-15", "Day one", "body",
                              tags={s["id"]: ["maya"]}, now=NOW)
    assert e1["created"] == NOW.isoformat()
    assert e1["tags"] == {s["id"]: ["maya"]}
    # same date -> updates, does not duplicate
    later = datetime(2026, 6, 15, 21, 0, 0)
    e2 = journal.upsert_entry(data, "2026-06-15", "Edited", "new body", now=later)
    assert len(data["entries"]) == 1
    assert e2["id"] == e1["id"]
    assert e2["created"] == NOW.isoformat()       # preserved
    assert e2["updated"] == later.isoformat()     # bumped
    assert e2["title"] == "Edited"


def test_upsert_validates_date_and_title():
    data = journal._empty()
    with pytest.raises(ValueError):
        journal.upsert_entry(data, "bad-date", "t", "", now=NOW)
    with pytest.raises(ValueError):
        journal.upsert_entry(data, "2026-06-15", "   ", "", now=NOW)


def test_upsert_cleans_tags_and_numbers():
    data = journal._empty()
    tag_s = journal.add_section(data, "people", "tag", "#fff")
    num_s = journal.add_section(data, "sleep", "numeric", "#fff", unit="hrs")
    e = journal.upsert_entry(
        data, "2026-06-15", "t", "",
        tags={tag_s["id"]: [" Maya ", "maya", "dad"], "ghost-section": ["x"]},
        numbers={num_s["id"]: "8.5", "ghost-section": "3"},
        now=NOW,
    )
    assert e["tags"] == {tag_s["id"]: ["maya", "dad"]}   # normalized, deduped, ghost dropped
    assert e["numbers"] == {num_s["id"]: 8.5}            # cast to float, ghost dropped


def test_upsert_rejects_non_numeric_value():
    data = journal._empty()
    num_s = journal.add_section(data, "sleep", "numeric", "#fff", unit="hrs")
    with pytest.raises(ValueError):
        journal.upsert_entry(data, "2026-06-15", "t", "",
                             numbers={num_s["id"]: "eight"}, now=NOW)


def test_delete_entry():
    data = journal._empty()
    e = journal.upsert_entry(data, "2026-06-15", "t", "", now=NOW)
    journal.delete_entry(data, e["id"])
    assert data["entries"] == []
```

- [ ] **Step 2: Run to verify they fail**

Run: `pytest tests/test_journal.py -k "upsert or delete_entry" -q`
Expected: FAIL — `upsert_entry` missing.

- [ ] **Step 3: Implement**

```python
# journal.py — append
def upsert_entry(data, date, title, body, tags=None, numbers=None, now=None):
    """Create or update the entry for `date` (the unique key).

    `tags` is {section_id: [tag names]} and `numbers` is {section_id: value};
    both are keyed by stable section id. Tag names are normalized/validated and
    deduped; number values are cast to float. Section ids that don't resolve to
    any section are dropped. Raises ValueError on an invalid date, empty title,
    or a non-numeric number. `created` is set once; `updated` on every save.
    """
    if not _valid_date(date):
        raise ValueError(f"Invalid date: {date!r}")
    title = (title or "").strip()
    if not title:
        raise ValueError("Entry title must not be empty")
    body = body or ""
    now = now or datetime.now()

    clean_tags = {}
    for section_id, names in (tags or {}).items():
        if section_by_id(data, section_id) is None:
            continue
        norm = []
        for raw in names or []:
            n = _normalize_name(raw) if isinstance(raw, str) else ""
            if n and _valid_name(n) and n not in norm:
                norm.append(n)
        if norm:
            clean_tags[section_id] = norm

    clean_numbers = {}
    for section_id, value in (numbers or {}).items():
        if section_by_id(data, section_id) is None:
            continue
        try:
            clean_numbers[section_id] = float(value)
        except (TypeError, ValueError):
            raise ValueError(f"Invalid number for section {section_id!r}: {value!r}")

    existing = get_entry_by_date(data, date)
    if existing is not None:
        existing["title"] = title
        existing["body"] = body
        existing["tags"] = clean_tags
        existing["numbers"] = clean_numbers
        existing["updated"] = now.isoformat()
        return existing

    entry = {
        "id": uuid.uuid4().hex,
        "date": date,
        "title": title,
        "body": body,
        "created": now.isoformat(),
        "updated": now.isoformat(),
        "tags": clean_tags,
        "numbers": clean_numbers,
    }
    data.setdefault("entries", []).append(entry)
    return entry


def delete_entry(data, entry_id):
    """Remove an entry by id. Unknown id = no-op."""
    data["entries"] = [e for e in data.get("entries", []) if e.get("id") != entry_id]
    return data
```

- [ ] **Step 4: Run the full journal unit suite**

Run: `pytest tests/test_journal.py -q`
Expected: PASS (all tasks 1–6).

- [ ] **Step 5: Commit**

```bash
git add journal.py tests/test_journal.py
git commit -m "Add journal entry upsert (one-per-date) and delete"
```

---

## Task 7: Flask wiring — config, nav blocks, Pompompurin toggle

**Files:**
- Modify: `app.py:14-31` (config block) and Jinja-globals block near `app.py:77-81`
- Modify: `templates/base.html`
- Create: `tests/test_journal_app.py`

- [ ] **Step 1: Write the failing test**

```python
# tests/test_journal_app.py
"""Tests for the journal HTTP layer. Uses test_client() and a temp
JOURNAL_FILE so the real data/journal.json is never touched."""

import pytest

import app as app_module
import journal


@pytest.fixture
def client(tmp_path):
    journal_file = tmp_path / "journal.json"
    flask_app = app_module.app
    flask_app.config["TESTING"] = True
    flask_app.config["JOURNAL_FILE"] = str(journal_file)
    # Seeded store (six default sections), mirroring first run.
    journal.save(str(journal_file), journal._seeded())
    with flask_app.test_client() as c:
        yield c


def _journal_path():
    return app_module.app.config["JOURNAL_FILE"]


def test_todo_index_has_pompompurin_link_to_journal(client):
    resp = client.get("/")
    assert resp.status_code == 200
    assert b"pompompurin" in resp.data.lower()
    assert b'href="/journal"' in resp.data
```

- [ ] **Step 2: Run to verify it fails**

Run: `pytest tests/test_journal_app.py -q`
Expected: FAIL — no `pompompurin` / `/journal` link in the rendered page.

- [ ] **Step 3: Add `JOURNAL_FILE` config and a `journal_file()` accessor in `app.py`**

In `app.py`, immediately after the existing `DATA_FILE` config block (around line 26), add:

```python
# Journal store lives alongside tasks; tests override via JOURNAL_FILE.
app.config["JOURNAL_FILE"] = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "data", "journal.json"
)
```

After the existing `data_file()` function add:

```python
def journal_file():
    return app.config["JOURNAL_FILE"]
```

Add the import near the top of `app.py` (next to `import todo`):

```python
import journal
```

After the existing Jinja-globals block (the `tag_color` / `text_color_for` lines), add:

```python
app.jinja_env.globals["section_color"] = journal.section_color
app.jinja_env.globals["is_registered_tag"] = journal.is_registered_tag
```

Add a context processor (place it after the globals block) so templates know
which section they're in for the toggle:

```python
from flask import request  # already imported with the other flask names


@app.context_processor
def inject_section_context():
    endpoint = request.endpoint or ""
    return {"in_journal": endpoint.startswith("journal")}
```

> `request` is already imported in `app.py`'s top `from flask import ...` line —
> do not add a duplicate import; the comment above is just a reminder.

- [ ] **Step 4: Refactor `templates/base.html` to add nav/brand blocks and the toggle**

Replace the `<header>...</header>` block in `templates/base.html` with:

```html
  <header>
    <div class="brand">
      {% block brand %}
      <img class="mascot" src="{{ url_for('static', filename='img/mascot.gif') }}"
           width="56" height="56" alt="Mascot">
      <span class="site-title">todo&middot;pup</span>
      {% endblock %}
    </div>
    <nav>
      {% block nav %}
      <a href="{{ url_for('index') }}">Active</a>
      <a href="{{ url_for('archive') }}">Archive</a>
      <a href="{{ url_for('tags') }}">Manage tags</a>
      {% endblock %}
      <!-- Pompompurin toggles between Tasks and Journal. -->
      <a class="puri-toggle"
         href="{{ url_for('index') if in_journal else url_for('journal_today') }}"
         title="Switch between Tasks and Journal">
        <img class="mascot mascot-puri"
             src="{{ url_for('static', filename='img/pompompurin.gif') }}"
             width="40" height="40" alt="pompompurin — switch to {{ 'Tasks' if in_journal else 'Journal' }}">
      </a>
    </nav>
  </header>
```

- [ ] **Step 5: Add a minimal `journal_today` route so `url_for('journal_today')` resolves**

In `app.py`, add (full body filled in Task 8 — this stub lets Task 7 pass):

```python
@app.route("/journal")
def journal_today():
    data = journal.load(journal_file())
    today = journal.today_iso()
    entry = journal.get_entry_by_date(data, today)
    return render_template(
        "journal_entry.html", data=data, entry=entry, date=today,
        sections=journal.active_sections(data),
    )
```

Create a minimal `templates/journal_entry.html` so the route renders (expanded in Task 8):

```html
{% extends "base.html" %}
{% block brand %}
  <img class="mascot mascot-puri"
       src="{{ url_for('static', filename='img/pompompurin.gif') }}"
       width="56" height="56" alt="pompompurin">
  <span class="site-title">journal</span>
{% endblock %}
{% block nav %}
  <a href="{{ url_for('journal_today') }}">New entry</a>
  <a href="{{ url_for('journal_list') }}">Past entries</a>
  <a href="{{ url_for('journal_sections') }}">Manage sections &amp; tags</a>
{% endblock %}
{% block content %}<p>journal entry for {{ date }}</p>{% endblock %}
```

> This template references `journal_list` and `journal_sections`. Add stub
> routes now so `url_for` resolves; their real bodies come in Tasks 9–10:

```python
@app.route("/journal/entries")
def journal_list():
    data = journal.load(journal_file())
    return render_template("journal_list.html", data=data,
                           entries=journal.entries_sorted(data))


@app.route("/journal/sections")
def journal_sections():
    data = journal.load(journal_file())
    return render_template("journal_sections.html", data=data,
                           sections=journal.active_sections(data))
```

Create matching minimal templates so the stubs render:

```html
<!-- templates/journal_list.html -->
{% extends "journal_entry.html" %}
{% block content %}<p>past entries</p>{% endblock %}
```

```html
<!-- templates/journal_sections.html -->
{% extends "journal_entry.html" %}
{% block content %}<p>manage sections</p>{% endblock %}
```

> These two `{% extends "journal_entry.html" %}` stubs are replaced wholesale in
> Tasks 9 and 10 with standalone templates that extend `base.html` directly.

- [ ] **Step 6: Run to verify it passes, plus the existing suite**

Run: `pytest tests/test_journal_app.py::test_todo_index_has_pompompurin_link_to_journal tests/test_app.py -q`
Expected: PASS (journal link present; existing task routes unaffected).

- [ ] **Step 7: Commit**

```bash
git add app.py templates/base.html templates/journal_entry.html templates/journal_list.html templates/journal_sections.html tests/test_journal_app.py
git commit -m "Wire journal Flask config, nav blocks, and Pompompurin toggle"
```

---

## Task 8: Entry create/edit form & save route

**Files:**
- Modify: `app.py` (`journal_today`, add `journal_entry`, `journal_save`)
- Modify: `templates/journal_entry.html` (full form)
- Test: `tests/test_journal_app.py`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_journal_app.py — append
def _first_tag_section_id():
    data = journal.load(_journal_path())
    return journal.active_sections(data)[0]["id"]   # "people"


def test_journal_today_renders_form(client):
    resp = client.get("/journal")
    assert resp.status_code == 200
    assert b"What happened today" in resp.data
    assert b"people" in resp.data       # seeded section card


def test_save_creates_entry_and_redirects(client):
    sid = _first_tag_section_id()
    resp = client.post("/journal/save", data={
        "date": "2026-06-15", "title": "A good day", "body": "stuff",
        f"tag:{sid}": "maya",
    })
    assert resp.status_code == 302
    data = journal.load(_journal_path())
    e = journal.get_entry_by_date(data, "2026-06-15")
    assert e["title"] == "A good day"
    assert e["tags"][sid] == ["maya"]


def test_save_permanent_new_tag_joins_registry(client):
    sid = _first_tag_section_id()
    client.post("/journal/save", data={
        "date": "2026-06-15", "title": "t", "body": "",
        f"newtag-name:{sid}": "cousin lee", f"newtag-kind:{sid}": "permanent",
    })
    data = journal.load(_journal_path())
    assert "cousin lee" in journal.section_by_id(data, sid)["tags"]
    assert "cousin lee" in journal.get_entry_by_date(data, "2026-06-15")["tags"][sid]


def test_save_temporary_new_tag_stays_off_registry(client):
    sid = _first_tag_section_id()
    client.post("/journal/save", data={
        "date": "2026-06-15", "title": "t", "body": "",
        f"newtag-name:{sid}": "aunt rosa", f"newtag-kind:{sid}": "temporary",
    })
    data = journal.load(_journal_path())
    assert "aunt rosa" not in journal.section_by_id(data, sid)["tags"]
    assert "aunt rosa" in journal.get_entry_by_date(data, "2026-06-15")["tags"][sid]


def test_save_invalid_title_flashes_and_saves_nothing(client):
    resp = client.post("/journal/save", data={"date": "2026-06-15", "title": "  ", "body": ""})
    assert resp.status_code == 302
    data = journal.load(_journal_path())
    assert journal.get_entry_by_date(data, "2026-06-15") is None


def test_edit_existing_date_prefills(client):
    client.post("/journal/save", data={"date": "2026-06-10", "title": "Past", "body": "hi"})
    resp = client.get("/journal/2026-06-10")
    assert resp.status_code == 200
    assert b"Past" in resp.data
    assert b"Update entry" in resp.data
```

- [ ] **Step 2: Run to verify they fail**

Run: `pytest tests/test_journal_app.py -q`
Expected: FAIL — `journal/save` route missing; form not rendered.

- [ ] **Step 3: Add the `journal_entry` GET route and the `journal_save` POST route**

In `app.py`, add a shared render helper and routes:

```python
def _render_entry(data, date):
    return render_template(
        "journal_entry.html", data=data,
        entry=journal.get_entry_by_date(data, date),
        date=date, sections=journal.active_sections(data),
    )


@app.route("/journal/<date>")
def journal_entry(date):
    data = journal.load(journal_file())
    if not journal._valid_date(date):
        return redirect(url_for("journal_today"))
    return _render_entry(data, date)


def _parse_entry_form(form, data):
    """Build {section_id: [tags]} and {section_id: value} from the form, and
    register any 'permanent' new tags. Only active sections are read here."""
    tags, numbers = {}, {}
    for s in journal.active_sections(data):
        sid = s["id"]
        if s["type"] == "tag":
            selected = list(form.getlist(f"tag:{sid}"))
            new_name = (form.get(f"newtag-name:{sid}") or "").strip()
            if new_name:
                if form.get(f"newtag-kind:{sid}") == "permanent":
                    journal.add_section_tag(data, sid, new_name)  # may raise
                selected.append(new_name)
            if selected:
                tags[sid] = selected
        else:
            raw = (form.get(f"num:{sid}") or "").strip()
            if raw != "":
                numbers[sid] = raw
    return tags, numbers


@app.route("/journal/save", methods=["POST"])
def journal_save():
    date = (request.form.get("date") or "").strip()
    title = request.form.get("title", "")
    body = request.form.get("body", "")
    data = journal.load(journal_file())
    # Preserve any data on archived sections (not shown on the form).
    existing = journal.get_entry_by_date(data, date)
    base_tags = dict(existing["tags"]) if existing else {}
    base_numbers = dict(existing["numbers"]) if existing else {}
    try:
        parsed_tags, parsed_numbers = _parse_entry_form(request.form, data)
        for s in journal.active_sections(data):
            sid = s["id"]
            if s["type"] == "tag":
                base_tags.pop(sid, None)
                if sid in parsed_tags:
                    base_tags[sid] = parsed_tags[sid]
            else:
                base_numbers.pop(sid, None)
                if sid in parsed_numbers:
                    base_numbers[sid] = parsed_numbers[sid]
        journal.upsert_entry(data, date, title, body,
                             tags=base_tags, numbers=base_numbers)
        journal.save(journal_file(), data)
    except ValueError:
        flash("Could not save entry: check the date, title, tags, and numbers.")
        return redirect(url_for("journal_entry", date=date) if journal._valid_date(date)
                        else url_for("journal_today"))
    return redirect(url_for("journal_entry", date=date))
```

- [ ] **Step 4: Replace `templates/journal_entry.html` with the full form**

```html
{% extends "base.html" %}
{% block brand %}
  <img class="mascot mascot-puri"
       src="{{ url_for('static', filename='img/pompompurin.gif') }}"
       width="56" height="56" alt="pompompurin">
  <span class="site-title">journal</span>
{% endblock %}
{% block nav %}
  <a href="{{ url_for('journal_today') }}">New entry</a>
  <a href="{{ url_for('journal_list') }}">Past entries</a>
  <a href="{{ url_for('journal_sections') }}">Manage sections &amp; tags</a>
{% endblock %}
{% block content %}
  <form class="journal-form" method="post" action="{{ url_for('journal_save') }}">
    <div class="top-line">
      <input type="text" name="title" placeholder="entry title" required
             value="{{ entry.title if entry else '' }}">
      <input type="date" name="date" value="{{ date }}" required>
    </div>

    <p class="label">What happened today</p>
    <textarea name="body" placeholder="the day's events…">{{ entry.body if entry else '' }}</textarea>

    {% set tag_sections = sections | selectattr('type', 'equalto', 'tag') | list %}
    {% set num_sections = sections | selectattr('type', 'equalto', 'numeric') | list %}

    {% if tag_sections %}
      <p class="label">Tag the day</p>
      <div class="sections">
        {% for s in tag_sections %}
          {% set fg = text_color_for(s.color) %}
          {% set selected = (entry.tags[s.id] if entry and entry.tags.get(s.id) else []) %}
          <div class="section" style="--tag-bg: {{ s.color }}; --tag-fg: {{ fg }};">
            <h3>{{ s.name }}</h3>
            <div class="chips">
              {# Registered (permanent) tags as toggle chips. #}
              {% for tag in s.tags %}
                <label class="chip">
                  <input type="checkbox" name="tag:{{ s.id }}" value="{{ tag }}"
                         {% if tag in selected %}checked{% endif %}> {{ tag }}
                </label>
              {% endfor %}
              {# Tags on the entry that are NOT in the master list (temporary or
                 since-deleted) render as dashed, pre-checked chips. #}
              {% for tag in selected %}
                {% if not is_registered_tag(data, s.id, tag) %}
                  <label class="chip temp">
                    <input type="checkbox" name="tag:{{ s.id }}" value="{{ tag }}" checked> {{ tag }}
                  </label>
                {% endif %}
              {% endfor %}
            </div>
            <div class="newtag">
              <input type="text" name="newtag-name:{{ s.id }}" placeholder="new tag">
              <select name="newtag-kind:{{ s.id }}">
                <option value="permanent">permanent</option>
                <option value="temporary">temporary</option>
              </select>
            </div>
          </div>
        {% endfor %}
      </div>
    {% endif %}

    {% if num_sections %}
      <p class="label">Track numbers</p>
      <div class="sections">
        {% for s in num_sections %}
          {% set val = entry.numbers[s.id] if entry and entry.numbers.get(s.id) is not none else '' %}
          <div class="num-section">
            <h3>{{ s.name }}</h3>
            <div class="num-field">
              <input type="number" step="any" name="num:{{ s.id }}" value="{{ val }}">
              <span class="unit">{{ s.unit or '' }}</span>
            </div>
          </div>
        {% endfor %}
      </div>
    {% endif %}

    <div class="actions">
      <button type="submit" class="save">{{ "Update entry" if entry else "Save entry" }}</button>
    </div>
  </form>
{% endblock %}
```

- [ ] **Step 5: Run to verify they pass**

Run: `pytest tests/test_journal_app.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app.py templates/journal_entry.html tests/test_journal_app.py
git commit -m "Add journal entry form, save route, and permanent/temporary tag handling"
```

---

## Task 9: Search tab (text + tags + numbers)

> **Replaces the original "Past entries" list.** The calendar already handles
> day-to-day navigation, so this tab is a filterable search/data view over all
> entries. **Confirmed decisions:** filtering is **live / client-side** (entries
> shipped as JSON, filtered in JS); multiple selected tags combine with **OR**;
> each numeric section gets a **range (min–max) slider** with bounds
> auto-derived from recorded values; multiple typed words combine with **AND**
> and match **whole words, case-insensitive**, against the entry body; the three
> filter types (text, tags, numbers) combine with **AND**. With no filters
> active, **all entries** show (newest date first). Controls are server-rendered
> from the live section/tag registry, so they auto-update as sections/tags are
> added and reflow responsively. Tag toggles reuse the circular check circles.

**Files:**
- Modify: `journal.py` — add `search_index`, `numeric_bounds`.
- Modify: `app.py` — rename `journal_list` → `journal_search` (route `/journal/search`); add `journal_entry_delete`; pass search context.
- Rename/replace: `templates/journal_list.html` → `templates/journal_search.html`; update the nav label **"Past entries" → "Search"** and the `url_for('journal_list')` link → `url_for('journal_search')` in `journal_entry.html` and `journal_sections.html` too.
- Create: `static/journal-search.js`.
- Modify: `static/style.css` — search panel, tag dropdown, range sliders, result rows.
- Test: `tests/test_journal.py`, `tests/test_journal_app.py`.

- [ ] **Step 1: `journal.py` helpers (test first)**

```python
# tests/test_journal.py — append
def test_search_index_shape_and_order():
    data = journal._empty()
    s = journal.add_section(data, "people", "tag", "#fff")
    journal.upsert_entry(data, "2026-06-13", "old", "ran in the park",
                         tags={s["id"]: ["maya"]}, now=NOW)
    journal.upsert_entry(data, "2026-06-15", "new", "quiet day", now=NOW)
    idx = journal.search_index(data)
    assert [i["date"] for i in idx] == ["2026-06-15", "2026-06-13"]   # newest first
    older = idx[1]
    assert older["title"] == "old" and older["body"] == "ran in the park"
    assert older["tags"] == ["maya"]


def test_numeric_bounds():
    data = journal._empty()
    s = journal.add_section(data, "sleep", "numeric", "#fff", unit="hrs")
    journal.upsert_entry(data, "2026-06-13", "a", "", numbers={s["id"]: "6"}, now=NOW)
    journal.upsert_entry(data, "2026-06-15", "b", "", numbers={s["id"]: "9"}, now=NOW)
    assert journal.numeric_bounds(data)[s["id"]] == [6.0, 9.0]
    s2 = journal.add_section(data, "weight", "numeric", "#fff", unit="lbs")
    assert s2["id"] not in journal.numeric_bounds(data)   # no values -> omitted
```

```python
# journal.py — append
def search_index(data):
    """Per-entry payload for the client-side search tab (newest date first).

    Each item: id, date, title, body, `tags` (flat sorted unique list of every
    tag string on the entry, across all sections), and `numbers`
    ({section_id: value}). Designed to be JSON-serialized into the page.
    """
    out = []
    for e in entries_sorted(data):
        tags = set()
        for names in (e.get("tags") or {}).values():
            for n in names or []:
                tags.add(n)
        out.append({
            "id": e["id"],
            "date": e["date"],
            "title": e.get("title", ""),
            "body": e.get("body", ""),
            "tags": sorted(tags),
            "numbers": dict(e.get("numbers") or {}),
        })
    return out


def numeric_bounds(data):
    """{section_id: [min, max]} over recorded values, for every numeric section
    that has at least one value among entries. Used to size the range sliders;
    sections with no recorded values are omitted."""
    bounds = {}
    for s in data.get("sections", []):
        if s.get("type") != "numeric":
            continue
        vals = [e["numbers"][s["id"]] for e in data.get("entries", [])
                if isinstance(e.get("numbers"), dict) and s["id"] in e["numbers"]]
        if vals:
            bounds[s["id"]] = [min(vals), max(vals)]
    return bounds
```

Run: `.venv/bin/python -m pytest tests/test_journal.py -k "search_index or numeric_bounds" -q` → PASS.

- [ ] **Step 2: `app.py` — search route, delete route, nav (test first)**

```python
# tests/test_journal_app.py — append
def test_search_lists_all_entries_newest_first(client):
    client.post("/journal/save", data={"date": "2026-06-10", "title": "Older", "body": ""})
    client.post("/journal/save", data={"date": "2026-06-14", "title": "Newer", "body": ""})
    resp = client.get("/journal/search")
    assert resp.status_code == 200
    body = resp.data.decode()
    assert body.index("Newer") < body.index("Older")
    assert b"journal-search.js" in resp.data        # live filtering wired
    assert b"entries-data" in resp.data             # entries embedded as JSON


def test_delete_entry_removes_it(client):
    client.post("/journal/save", data={"date": "2026-06-10", "title": "Bye", "body": ""})
    eid = journal.get_entry_by_date(journal.load(_journal_path()), "2026-06-10")["id"]
    resp = client.post(f"/journal/entry/{eid}/delete")
    assert resp.status_code == 302
    assert journal.get_entry_by_date(journal.load(_journal_path()), "2026-06-10") is None
```

Replace the Task-7 `journal_list` stub route with `journal_search`, and add the delete route:

```python
# app.py
@app.route("/journal/search")
def journal_search():
    data = journal.load(journal_file())
    return render_template(
        "journal_search.html", data=data,
        entries=journal.search_index(data),
        tag_sections=[s for s in journal.active_sections(data) if s["type"] == "tag"],
        num_sections=[s for s in journal.active_sections(data) if s["type"] == "numeric"],
        bounds=journal.numeric_bounds(data),
    )


@app.route("/journal/entry/<entry_id>/delete", methods=["POST"])
def journal_entry_delete(entry_id):
    data = journal.load(journal_file())
    journal.delete_entry(data, entry_id)
    journal.save(journal_file(), data)
    flash("Entry deleted.")
    return redirect(url_for("journal_search"))
```

Update the nav in `journal_entry.html` and `journal_sections.html` (and create the same nav in `journal_search.html`): the middle link becomes
`<a href="{{ url_for('journal_search') }}">Search</a>`.

- [ ] **Step 3: `templates/journal_search.html`** (extends `base.html`; brand via `brand_mascot`/`brand_title` per the AMENDMENT)

Structure (fill with real markup):
- Brand/nav blocks (Pompompurin brand; nav: New entry · **Search** · Manage sections & tags).
- A `.search-panel`:
  - Text input: `<input type="text" id="q" placeholder="search words in entries…">`.
  - A **tag dropdown**: a `.tag-dropdown` button ("Tags") that toggles a `.tag-dropdown-panel`. Inside, for each tag section render a small group header (the section name) and its tags as `.chip.tag-toggle` checkbox chips (circular check circles, `data-tag="<name>"`). Selecting any is OR.
  - For each numeric section in `num_sections` that has bounds, a `.num-filter` with the section name + unit and a **dual-range slider** (two `<input type="range">` with `data-section="<id>"`, `data-role="min"|"max"`, `min`/`max`/`value` from `bounds[s.id]`, plus a readout span). Sections without recorded values: show a disabled note or omit.
- A results area: `<p class="result-count"></p>` and `<ul class="entry-list">` of rows — date + title linking to `journal_entry`, the entry's tags as small chips, and any numbers; each row carries `data-*` or is matched against the JSON by id. Include a per-row delete form (like the old list) so entries can still be removed.
- Embed data + script via the scripts block:
  ```html
  {% block scripts %}
    <script type="application/json" id="entries-data">{{ entries | tojson }}</script>
    <script type="application/json" id="bounds-data">{{ bounds | tojson }}</script>
    <script src="{{ url_for('static', filename='journal-search.js') }}" defer></script>
  {% endblock %}
  ```

- [ ] **Step 4: `static/journal-search.js`** (vanilla, no libraries)

Behavior:
- Parse `#entries-data` (list) and `#bounds-data`.
- Read controls: text `#q`; checked tag chips (collect selected `data-tag` values); each numeric section's two range inputs (min/max) keyed by `data-section`.
- **Filter function** (recomputed on every `input`/`change`):
  - **Text:** split `q` on whitespace → words; lowercase. An entry passes if, for **every** word, a whole-word match exists in `entry.body.toLowerCase()` — use `new RegExp('\\\\b' + escapeRegExp(word) + '\\\\b')`. Empty query → passes.
  - **Tags:** selected = set of checked tags. If non-empty, entry passes only if `entry.tags` intersects it (**OR**). Empty → passes.
  - **Numbers:** for each numeric section, read `[lo, hi]` from its sliders. The filter is **active** only if `lo > boundMin || hi < boundMax`. When active, entry passes only if it has a value for that section AND `lo <= value <= hi`. Inactive → passes.
  - An entry shows only if it passes **all** of the above (**AND**).
- Re-render the results list (show/hide rows by id, or rebuild) and update `.result-count` (e.g. "7 entries").
- **Tag dropdown:** toggle open/close on button click; close on outside click / Esc (reuse the calendar's pattern). Keep the chips' circular-check look.
- **Dual-range slider:** clamp so `min <= max` (when one handle crosses the other, push the other); update the readout (`lo–hi unit`); recompute filter.
- Guard: if `#entries-data` missing, bail (not on the search page).

- [ ] **Step 5: `static/style.css`** — dark, on-theme styles for `.search-panel` (panel card, responsive flex/grid that wraps), `.tag-dropdown`/`.tag-dropdown-panel` (panel popover, grouped chips), the range sliders (themed track/handles via `accent-color: var(--accent)` and a sensible dual-range layout), `.num-filter` rows, `.result-count`, and reuse `.entry-list`/`.entry-row`/`.entry-link` from the existing CSS. Must match the dark/amber/monospace theme and resize cleanly.

- [ ] **Step 6: Verify**

Run: `.venv/bin/python -m pytest tests/test_journal.py tests/test_journal_app.py tests/test_app.py -q` → all pass.
Manual: save several entries with varied bodies/tags/numbers; confirm text (whole-word, AND), tag (OR), and range filters narrow results live and combine with AND; confirm controls reflect newly added sections/tags and reflow on resize.

- [ ] **Step 7: Commit**

```bash
git add journal.py app.py templates/ static/journal-search.js static/style.css tests/
git commit -m "Replace past-entries list with a live search tab (text/tags/numbers)"
```

---

## Task 10: Sections management page

**Files:**
- Modify: `app.py` (`journal_sections` already exists; add add/edit/delete/tag routes)
- Replace: `templates/journal_sections.html`
- Test: `tests/test_journal_app.py`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_journal_app.py — append
def test_add_section(client):
    resp = client.post("/journal/sections/add", data={
        "name": "mood", "type": "numeric", "color": "#abcdef", "unit": "1-10"})
    assert resp.status_code == 302
    data = journal.load(_journal_path())
    s = next(s for s in data["sections"] if s["name"] == "mood")
    assert s["type"] == "numeric" and s["unit"] == "1-10"


def test_add_section_bad_color_flashes(client):
    resp = client.post("/journal/sections/add", data={
        "name": "mood", "type": "numeric", "color": "purple"})
    assert resp.status_code == 302
    data = journal.load(_journal_path())
    assert not any(s["name"] == "mood" for s in data["sections"])


def test_edit_section_rename_and_color(client):
    sid = journal.active_sections(journal.load(_journal_path()))[0]["id"]
    client.post(f"/journal/sections/{sid}/edit", data={
        "name": "friends", "color": "#111111"})
    s = journal.section_by_id(journal.load(_journal_path()), sid)
    assert s["name"] == "friends" and s["color"] == "#111111"


def test_delete_section_soft_deletes(client):
    sid = journal.active_sections(journal.load(_journal_path()))[0]["id"]
    client.post(f"/journal/sections/{sid}/delete")
    s = journal.section_by_id(journal.load(_journal_path()), sid)
    assert s["archived"] is True


def test_add_and_remove_permanent_tag(client):
    sid = journal.active_sections(journal.load(_journal_path()))[0]["id"]
    client.post(f"/journal/sections/{sid}/tags", data={"tag": "maya"})
    assert "maya" in journal.section_by_id(journal.load(_journal_path()), sid)["tags"]
    client.post(f"/journal/sections/{sid}/tags/maya/delete")
    assert "maya" not in journal.section_by_id(journal.load(_journal_path()), sid)["tags"]
```

- [ ] **Step 2: Run to verify they fail**

Run: `pytest tests/test_journal_app.py -k "section" -q`
Expected: FAIL — management routes missing.

- [ ] **Step 3: Add the management routes**

```python
# app.py — append
@app.route("/journal/sections/add", methods=["POST"])
def journal_sections_add():
    data = journal.load(journal_file())
    name = request.form.get("name", "")
    type_ = request.form.get("type", "tag")
    color = (request.form.get("color") or "").strip()
    unit = request.form.get("unit", "")
    try:
        journal.add_section(data, name, type_, color, unit=unit)
        journal.save(journal_file(), data)
    except ValueError:
        flash("Could not add section: check the name, type, and color.")
    return redirect(url_for("journal_sections"))


@app.route("/journal/sections/<section_id>/edit", methods=["POST"])
def journal_section_edit(section_id):
    data = journal.load(journal_file())
    try:
        if request.form.get("name") is not None:
            journal.rename_section(data, section_id, request.form.get("name", ""))
        if (request.form.get("color") or "").strip():
            journal.set_section_color(data, section_id, request.form["color"].strip())
        if request.form.get("unit") is not None:
            journal.set_section_unit(data, section_id, request.form.get("unit", ""))
        journal.save(journal_file(), data)
    except ValueError:
        flash("Could not update section: check the name and color.")
    return redirect(url_for("journal_sections"))


@app.route("/journal/sections/<section_id>/delete", methods=["POST"])
def journal_section_delete(section_id):
    data = journal.load(journal_file())
    journal.archive_section(data, section_id)
    journal.save(journal_file(), data)
    flash("Section archived.")
    return redirect(url_for("journal_sections"))


@app.route("/journal/sections/<section_id>/tags", methods=["POST"])
def journal_section_tag_add(section_id):
    data = journal.load(journal_file())
    try:
        journal.add_section_tag(data, section_id, request.form.get("tag", ""))
        journal.save(journal_file(), data)
    except ValueError:
        flash("Could not add tag: check the name.")
    return redirect(url_for("journal_sections"))


@app.route("/journal/sections/<section_id>/tags/<tag>/delete", methods=["POST"])
def journal_section_tag_remove(section_id, tag):
    data = journal.load(journal_file())
    journal.remove_section_tag(data, section_id, tag)
    journal.save(journal_file(), data)
    return redirect(url_for("journal_sections"))
```

- [ ] **Step 4: Replace `templates/journal_sections.html` with the management page**

```html
{% extends "base.html" %}
{% block brand %}
  <img class="mascot mascot-puri"
       src="{{ url_for('static', filename='img/pompompurin.gif') }}"
       width="56" height="56" alt="pompompurin">
  <span class="site-title">journal</span>
{% endblock %}
{% block nav %}
  <a href="{{ url_for('journal_today') }}">New entry</a>
  <a href="{{ url_for('journal_list') }}">Past entries</a>
  <a href="{{ url_for('journal_sections') }}">Manage sections &amp; tags</a>
{% endblock %}
{% block content %}
  <h2>Manage sections &amp; tags</h2>
  <p class="hint">Deleting a tag or section only removes it as a future option;
     existing entries keep their data.</p>

  {% for s in sections %}
    {% set fg = text_color_for(s.color) %}
    <section class="manage-section" style="--tag-bg: {{ s.color }}; --tag-fg: {{ fg }};">
      <form class="manage-head tag-preview-group" method="post"
            action="{{ url_for('journal_section_edit', section_id=s.id) }}">
        <input class="tag-name-input" type="text" name="name" value="{{ s.name }}">
        <input class="tag-color-input" type="color" name="color" value="{{ s.color }}">
        <span class="tag-preview title-highlight" style="--tag-bg: {{ s.color }};">{{ s.name }}</span>
        <span class="pill">{{ s.type }} section</span>
        {% if s.type == "numeric" %}
          <input type="text" name="unit" value="{{ s.unit or '' }}" placeholder="unit" class="unit-input">
        {% endif %}
        <button type="submit">save</button>
      </form>

      {% if s.type == "tag" %}
        <div class="perm-tags">
          {% for tag in s.tags %}
            <span class="perm-chip">{{ tag }}
              <button form="rm-{{ s.id }}-{{ loop.index }}" type="submit" class="x">×</button>
            </span>
            <form id="rm-{{ s.id }}-{{ loop.index }}" method="post"
                  action="{{ url_for('journal_section_tag_remove', section_id=s.id, tag=tag) }}"></form>
          {% endfor %}
        </div>
        <form class="addrow" method="post" action="{{ url_for('journal_section_tag_add', section_id=s.id) }}">
          <input type="text" name="tag" placeholder="add permanent tag…">
          <button type="submit">add</button>
        </form>
      {% endif %}

      <form class="delete-section" method="post"
            action="{{ url_for('journal_section_delete', section_id=s.id) }}">
        <button type="submit" class="delete">delete section</button>
      </form>
    </section>
  {% endfor %}

  <h3>Add a section</h3>
  <form class="addrow tag-preview-group" method="post" action="{{ url_for('journal_sections_add') }}">
    <input class="tag-name-input" type="text" name="name" placeholder="section name" required>
    <select name="type">
      <option value="tag">tag section</option>
      <option value="numeric">numeric section</option>
    </select>
    <input class="tag-color-input" type="color" name="color" value="#e0a955">
    <input type="text" name="unit" placeholder="unit (numeric only)" class="unit-input">
    <span class="tag-preview title-highlight" style="--tag-bg: #e0a955;">preview</span>
    <button type="submit">+ add section</button>
  </form>
{% endblock %}
```

> The `tag-preview-group` / `tag-name-input` / `tag-color-input` / `tag-preview`
> classes reuse the existing live-preview JS already in `base.html` — no new JS
> is needed; the preview updates as you type a name or pick a color.

- [ ] **Step 5: Run to verify they pass**

Run: `pytest tests/test_journal_app.py -q`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app.py templates/journal_sections.html tests/test_journal_app.py
git commit -m "Add journal sections management page (add/rename/color/unit/delete/tags)"
```

---

## Task 11: Journal styling

**Files:**
- Modify: `static/style.css`

This task is visual; verify by eye rather than by unit test.

> **STATUS: already applied during Group C** (commit pulling journal CSS
> forward so the entry form was reviewable). All the CSS below is in
> `static/style.css` except the `.puri-toggle`/`.mascot-puri` rules, which were
> replaced by the `.brand-toggle` styling per the AMENDMENT. When executing,
> skip this task's Step 1 unless something is missing; just verify by eye.

- [ ] **Step 1: Append journal styles to `static/style.css`**

```css
/* ----- pompompurin toggle ----- */
.puri-toggle { margin-left: 1rem; display: inline-flex; vertical-align: middle; }
.mascot-puri { width: 40px; height: 40px; }

/* ----- journal entry form ----- */
.journal-form .top-line { display: flex; gap: 0.6rem; margin: 1.2rem 0 0.7rem; }
.journal-form .top-line input[type="text"] { flex: 1; }
.journal-form textarea {
  width: 100%; min-height: 140px; resize: vertical; margin-bottom: 1.2rem;
  background: var(--panel); color: var(--text); border: 1px solid var(--border);
  border-radius: 8px; padding: 0.55rem 0.7rem; font: inherit;
}
.label {
  font-size: 0.72rem; letter-spacing: 1px; text-transform: uppercase;
  color: var(--muted); margin: 0 0 0.5rem;
}

/* two-column section grid (tag + numeric) */
.sections { display: grid; grid-template-columns: 1fr 1fr; gap: 0.9rem; margin-bottom: 1rem; }
.section, .num-section {
  background: var(--panel); border: 1px solid var(--border);
  border-radius: 12px; padding: 0.8rem 0.9rem;
}
.section h3, .num-section h3 { margin: 0 0 0.6rem; font-size: 0.95rem; color: var(--accent); }
.num-section { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; }
.num-section h3 { margin: 0; }
.num-field { display: flex; align-items: center; gap: 0.4rem; }
.num-field input { width: 90px; text-align: right; }
.unit { color: var(--muted); font-size: 0.8rem; min-width: 42px; }

.section .chips { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.section .chip {
  border: 1px solid var(--border); border-radius: 999px; padding: 0.25rem 0.6rem;
  font-size: 0.82rem; cursor: pointer; user-select: none;
}
.section .chip input { margin-right: 0.25rem; }
.section .chip:has(input:checked) {
  background: color-mix(in srgb, var(--tag-bg) 22%, transparent);
  border-color: var(--tag-bg);
}
.section .chip.temp { border-style: dashed; font-style: italic; color: var(--muted); }
.section .newtag { margin-top: 0.6rem; display: flex; gap: 0.4rem; }
.section .newtag input { flex: 1; }

/* ----- past entries ----- */
.entry-list { list-style: none; padding: 0; }
.entry-row { display: flex; align-items: center; gap: 0.6rem; padding: 0.4rem 0; border-bottom: 1px solid var(--border); }
.entry-link { display: flex; gap: 0.8rem; text-decoration: none; color: var(--text); flex: 1; }
.entry-date { color: var(--accent); }
.entry-title { color: var(--text); }

/* ----- manage sections ----- */
.manage-section { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 0.9rem 1rem; margin-bottom: 0.9rem; }
.manage-head { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.unit-input { width: 130px; }
.pill { font-size: 0.66rem; letter-spacing: 0.5px; text-transform: uppercase; border: 1px solid var(--border); border-radius: 6px; padding: 0.05rem 0.4rem; color: var(--muted); }
.perm-tags { margin: 0.7rem 0; }
.perm-chip { display: inline-flex; align-items: center; gap: 0.4rem; border: 1px solid var(--border); border-radius: 999px; padding: 0.25rem 0.6rem; font-size: 0.82rem; margin: 0.2rem; }
.perm-chip .x { background: none; border: none; color: var(--danger); cursor: pointer; font: inherit; }
.addrow { display: flex; gap: 0.5rem; margin-top: 0.6rem; flex-wrap: wrap; align-items: center; }
.delete-section { margin-top: 0.6rem; }
.hint { color: var(--muted); font-size: 0.8rem; }
```

- [ ] **Step 2: Verify visually**

Run: `flask --app app run --port 5001`
Open `http://127.0.0.1:5001/journal`, the Search page, and the manage page.
Expected: dark amber/monospace styling matching the todo page; two-column section grid; dashed temporary chips; live color preview on the manage page.

- [ ] **Step 3: Commit**

```bash
git add static/style.css
git commit -m "Style the journal pages to match the todo dark theme"
```

---

## Task 12: Pompompurin asset & full-suite verification

**Files:**
- Add: `static/img/pompompurin.gif`

- [ ] **Step 1: Add a placeholder Pompompurin asset**

Until the user supplies the real GIF, copy the existing mascot so links resolve:

```bash
cp static/img/mascot.gif static/img/pompompurin.gif
```

> Replace `static/img/pompompurin.gif` with the real Pompompurin GIF when
> available — no code change needed.

- [ ] **Step 2: Run the full test suite**

Run: `pytest -q`
Expected: PASS — `tests/test_todo.py`, `tests/test_app.py`, `tests/test_journal.py`, `tests/test_journal_app.py` all green.

- [ ] **Step 3: Manual smoke test**

Run: `flask --app app run --port 5001`
- Click Pompompurin on the todo page → lands on `/journal` (today's entry).
- Write a title + body, select/add tags, enter a number, Save → redirected to the entry, values persisted.
- Pompompurin on the journal page → back to the todo page.
- Search tab lists the entry; text/tag/range filters narrow it live (AND); deleting removes it.
- Manage page: add a section (tag + numeric), rename, recolor with live preview, add/remove permanent tags, delete a section (it disappears from the entry form but old entries keep their data).

- [ ] **Step 4: Commit**

```bash
git add static/img/pompompurin.gif
git commit -m "Add placeholder Pompompurin asset; journaling feature complete"
```

---

## Self-review notes

- **Spec coverage:** persistence/seeding (T1), section helpers (T2), section CRUD + validation (T3), permanent tags (T4), entry helpers (T5), upsert one-per-date + delete (T6), Flask wiring + toggle + nav blocks (T7), entry form + permanent/temporary tags + archived-data preservation (T8), search tab — text/tags/numbers + delete (T9), management page + color preview (T10), styling (T11), asset + full verification (T12). Tasks-side analytics contract requires no code (documented in spec).
- **Security invariant:** section/tag names go through `_TAG_NAME_RE`; colors through `_HEX_COLOR_RE`; units are escaped + length-capped, never placed in `style`.
- **Analytics-readiness:** entry maps keyed by stable section id; sections soft-deleted; numbers stored as floats; dates/timestamps ISO.
