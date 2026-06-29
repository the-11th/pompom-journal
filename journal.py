"""Core journal logic.

Pure, testable functions over a plain data dict of the shape:

    {"sections": [...], "entries": [...]}

NO Flask imports -- this is the journal "brain". The only dependency is a
one-way import of todo.py's pure validation regexes, so hex/name validation
has a single source of truth.

Dates: entry `date` is a YYYY-MM-DD string; timestamps are ISO 8601. All naive
local time, matching todo.py.
"""

import json
import math
import os
import re
import statistics
import uuid
from collections import Counter
from datetime import datetime, timedelta

from todo import _HEX_COLOR_RE, _TAG_NAME_RE

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
_MAX_UNIT_LEN = 12  # keep unit labels short for the section-card layout


def _empty():
    """A fresh, truly empty store (used by tests)."""
    return {"sections": [], "entries": [], "dismissed_suggestions": {}}


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
            s.setdefault("archived_tags", [])
            s.setdefault("unit", None)
            s.setdefault("archived", False)
        for e in parsed["entries"]:
            if not isinstance(e.get("tags"), dict):
                e["tags"] = {}
            if not isinstance(e.get("numbers"), dict):
                e["numbers"] = {}
            e.setdefault("mood", None)
            e.setdefault("sleep", None)
        if not isinstance(parsed.get("dismissed_suggestions"), dict):
            parsed["dismissed_suggestions"] = {}
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


# --------------------------------------------------------------------------- #
# Task 2: Section lookup & display helpers
# --------------------------------------------------------------------------- #

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


# --------------------------------------------------------------------------- #
# Task 3: Section CRUD with validation
# --------------------------------------------------------------------------- #

# Expects an already-normalized (stripped, lowercased) name.
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
        "archived_tags": [],
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


# --------------------------------------------------------------------------- #
# Task 4: Permanent tags on sections
# --------------------------------------------------------------------------- #

def add_section_tag(data, section_id, tag):
    """Add a permanent tag to a tag-section (normalized, validated, unique).
    If the tag was previously archived, it is unarchived instead of duplicated.
    Raises on a bad name or a numeric section. Unknown id = no-op."""
    tag = _normalize_name(tag)
    if not _valid_name(tag):
        raise ValueError(f"Invalid tag name: {tag!r}")
    s = section_by_id(data, section_id)
    if s is None:
        return data
    if s.get("type") != "tag":
        raise ValueError("Cannot add tags to a numeric section")
    archived = s.setdefault("archived_tags", [])
    if tag in archived:
        archived.remove(tag)
    if tag not in s.setdefault("tags", []):
        s["tags"].append(tag)
    return data


def remove_section_tag(data, section_id, tag):
    """Move a permanent tag to the archived list (entries keep it).
    Unknown id/tag = safe no-op."""
    tag = _normalize_name(tag)
    s = section_by_id(data, section_id)
    if s is not None and isinstance(s.get("tags"), list):
        if tag in s["tags"]:
            s["tags"].remove(tag)
            archived = s.setdefault("archived_tags", [])
            if tag not in archived:
                archived.append(tag)
    return data


def _tag_used_on_entries(data, section_id, tag):
    """True if `tag` (normalized) appears on any entry under `section_id`."""
    tag = _normalize_name(tag)
    for e in data.get("entries", []):
        for raw in (e.get("tags") or {}).get(section_id, []) or []:
            if _normalize_name(raw) == tag:
                return True
    return False


def demote_section_tag(data, section_id, tag):
    """Demote a permanent tag (the Temporary drop-zone target).

    Removes the tag from the section's master `tags` list. If the tag is still
    used on at least one entry it is left un-archived, so `temporary_tags`
    naturally re-derives it (entry-only => temporary). If no entry uses it, it
    falls back to the normal archive behavior (`remove_section_tag`). Unknown
    id/tag = safe no-op.
    """
    tag = _normalize_name(tag)
    s = section_by_id(data, section_id)
    if s is None or not isinstance(s.get("tags"), list) or tag not in s["tags"]:
        return data
    if _tag_used_on_entries(data, section_id, tag):
        s["tags"].remove(tag)  # entry use makes it temporary again
    else:
        remove_section_tag(data, section_id, tag)  # unused -> archive
    return data


def archive_temporary_tag(data, section_id, tag):
    """Archive a temporary (entry-only) tag so it stops being derived as one.

    Adds the normalized name to the section's `archived_tags` list (which
    `temporary_tags` already excludes). Idempotent. A temporary tag is not in the
    master `tags` list, so `remove_section_tag` would be a no-op for it — hence
    this dedicated helper. No-op for an unknown id or a non-tag section.
    """
    tag = _normalize_name(tag)
    s = section_by_id(data, section_id)
    if s is None or s.get("type") != "tag":
        return data
    archived = s.setdefault("archived_tags", [])
    if tag and tag not in archived:
        archived.append(tag)
    return data


def archived_sections(data):
    """Sections that have been archived (soft-deleted), in stored order."""
    return [s for s in data.get("sections", []) if s.get("archived")]


def restore_section(data, section_id):
    """Un-archive a section. Raises ValueError if an active section already
    has the same name. Unknown id = no-op."""
    s = section_by_id(data, section_id)
    if s is None:
        return data
    for active in active_sections(data):
        if active["name"] == s["name"] and active["id"] != section_id:
            raise ValueError(f"An active section named {s['name']!r} already exists")
    s["archived"] = False
    return data


def restore_section_tag(data, section_id, tag):
    """Move a tag from archived_tags back to tags. Unknown id/tag = no-op."""
    tag = _normalize_name(tag)
    s = section_by_id(data, section_id)
    if s is None:
        return data
    archived = s.setdefault("archived_tags", [])
    if tag in archived:
        archived.remove(tag)
        if tag not in s.setdefault("tags", []):
            s["tags"].append(tag)
    return data


def temporary_tags(data):
    """Tags that appear on entries but are not in a section's master list.

    Returns {section_id: [names]} for every section that has at least one such
    tag. A "temporary" tag is one applied to an entry under a section but absent
    from that section's permanent (`tags`) and archived (`archived_tags`) lists.
    Names are matched case-insensitively (entry tags are already normalized on
    upsert), deduped, and sorted alphabetically. Sections with no temporary tags
    are omitted. Pure/deterministic — no clock needed.
    """
    out = {}
    for s in data.get("sections", []):
        sid = s.get("id")
        registered = {
            _normalize_name(n)
            for n in (s.get("tags") or []) + (s.get("archived_tags") or [])
        }
        names = set()
        for e in data.get("entries", []):
            for raw in (e.get("tags") or {}).get(sid, []) or []:
                n = _normalize_name(raw)
                if n and n not in registered:
                    names.add(n)
        if names:
            out[sid] = sorted(names)
    return out


# --------------------------------------------------------------------------- #
# Task 5: Entry lookup & date helpers
# --------------------------------------------------------------------------- #

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


def _valid_mood(value):
    """True if `value` is an int (or int-coercible) in the 1..7 range.

    Rejects floats with a fractional part, bools, and non-numeric strings —
    the mood is a discrete 1..7 scale, so only whole-number values are valid.
    """
    if isinstance(value, bool):
        return False
    try:
        n = int(value)
    except (TypeError, ValueError):
        return False
    # An int-coercible value must equal its int form (e.g. reject 3.5).
    if isinstance(value, float) and not value.is_integer():
        return False
    return 1 <= n <= 7


def get_entry_by_date(data, date):
    """The entry for `date`, or None (date is the unique key)."""
    for e in data.get("entries", []):
        if e.get("date") == date:
            return e
    return None


def entries_sorted(data):
    """Entries newest date first."""
    return sorted(data.get("entries", []), key=lambda e: e.get("date", ""), reverse=True)


# --------------------------------------------------------------------------- #
# Task 6: Entry upsert & delete
# --------------------------------------------------------------------------- #

def upsert_entry(data, date, title, body, tags=None, numbers=None, mood=None, now=None):
    """Create or update the entry for `date` (the unique key).

    `tags` is {section_id: [tag names]} and `numbers` is {section_id: value};
    both are keyed by stable section id. Tag names are normalized/validated and
    deduped; number values are cast to float. Section ids that don't resolve to
    any active section are dropped; ids for archived sections are accepted so
    historical data is preserved. Raises ValueError on an invalid date, empty
    title, or a non-numeric/non-finite number. `created` is set once; `updated`
    on every save.
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
            v = float(value)
        except (TypeError, ValueError):
            raise ValueError(f"Invalid number for section {section_id!r}: {value!r}")
        if not math.isfinite(v):
            raise ValueError(f"Invalid number for section {section_id!r}: {value!r}")
        clean_numbers[section_id] = v

    # Mood is an optional 1..7 scale, independent of the section structures.
    # None/empty -> null; an int-coercible 1..7 -> int; anything else -> raise.
    if mood is None or mood == "":
        clean_mood = None
    elif _valid_mood(mood):
        clean_mood = int(mood)
    else:
        raise ValueError(f"Invalid mood: {mood!r}")

    existing = get_entry_by_date(data, date)
    if existing is not None:
        existing["title"] = title
        existing["body"] = body
        existing["tags"] = clean_tags
        existing["numbers"] = clean_numbers
        existing["mood"] = clean_mood
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
        "mood": clean_mood,
    }
    data.setdefault("entries", []).append(entry)
    return entry


def delete_entry(data, entry_id):
    """Remove an entry by id. Unknown id = no-op."""
    data["entries"] = [e for e in data.get("entries", []) if e.get("id") != entry_id]
    return data


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


# --------------------------------------------------------------------------- #
# Rich entries: @mention tag lookup, extraction, and merge (all pure)
# --------------------------------------------------------------------------- #

# A mention token: '@' at a word boundary (start of string or a non-word char
# before it) followed by one or more name chars. The leading boundary group is
# captured so `a@b.com` does NOT match (the char before '@' is a word char).
_MENTION_RE = re.compile(r"(?:^|(?<=\W))@([A-Za-z0-9_-]+)")


def tag_section_index(data):
    """Build the @mention lookup: {normalized_name: section_id}.

    Construction + precedence:
      1. Seed with permanent (`section.tags`) + archived (`section.archived_tags`)
         tags from every section. A registered name's section always wins, so
         these authoritative "homes" are never overridden by temporary use.
      2. Overlay temporary tags harvested from entries -- any name NOT already
         registered is mapped to the section it was used under. Entries are
         iterated in ASCENDING date order so that, for a purely-temporary name
         used under more than one section, the most-recent entry's section wins.

    Names are normalized (strip + lowercase).
    """
    index = {}
    registered = set()
    for s in data.get("sections", []):
        sid = s.get("id")
        for name in (s.get("tags") or []) + (s.get("archived_tags") or []):
            n = _normalize_name(name)
            if n:
                index[n] = sid
                registered.add(n)

    entries = sorted(data.get("entries", []), key=lambda e: e.get("date", ""))
    for e in entries:
        for sid, names in (e.get("tags") or {}).items():
            for name in names or []:
                n = _normalize_name(name)
                if n and n not in registered:
                    index[n] = sid  # later (more recent) entries overwrite
    return index


def _resolve_mention(token, index):
    """Resolve a mention token to a known tag name in `index`, or None.

    Tries the token as-is (normalized), then with underscores treated as
    spaces — so `@alex_dad` matches a multi-word tag `alex dad`. A literal
    underscore tag wins over the spaced form when both exist.
    """
    direct = _normalize_name(token)
    if direct in index:
        return direct
    spaced = _normalize_name(token.replace("_", " "))
    if spaced in index:
        return spaced
    return None


def extract_mentions(body, index):
    """Find @mentions in `body` that match a known tag.

    Returns {section_id: [names]}. A mention is an '@' at a word boundary
    followed by [A-Za-z0-9_-]+ (so `a@b.com` does not match). Each token is
    resolved to a known tag name (underscores match spaces, so `@alex_dad`
    matches `alex dad`); unknown tokens are dropped. Resolved names are grouped
    by section id and deduped within a section, preserving first-seen order.
    """
    out = {}
    for raw in _MENTION_RE.findall(body or ""):
        n = _resolve_mention(raw, index)
        if n is None:
            continue
        sid = index[n]
        names = out.setdefault(sid, [])
        if n not in names:
            names.append(n)
    return out


def merge_entry_tags(base, mentions):
    """Union two {section_id: [names]} dicts, non-destructively.

    For each section id, concatenate names and dedupe preserving order. Never
    removes anything; does not mutate the inputs.
    """
    out = {sid: list(names) for sid, names in (base or {}).items()}
    for sid, names in (mentions or {}).items():
        merged = out.setdefault(sid, [])
        for n in names or []:
            if n not in merged:
                merged.append(n)
    return out


# --------------------------------------------------------------------------- #
# Calendar helpers
# --------------------------------------------------------------------------- #

def entry_dates(data):
    """Sorted list of YYYY-MM-DD strings that have an entry (for calendar dots)."""
    return sorted(e["date"] for e in data.get("entries", []) if e.get("date"))


# --------------------------------------------------------------------------- #
# Task 9: Search index helpers
# --------------------------------------------------------------------------- #

def search_index(data):
    """Per-entry payload for the client-side search tab (newest date first).

    Each item: id, date, title, body, `tags` (flat sorted unique list of every
    tag string on the entry, across all sections — used by the JS filter),
    `tag_chips` (sorted unique [{name, color}] pairs carrying each tag's own
    section color, for color-coded rendering), and `numbers`
    ({section_id: value}). Designed to be JSON-serialized into the page.
    """
    out = []
    for e in entries_sorted(data):
        tags = set()
        chips = []          # [{name, color}], deduped by name (first wins)
        seen = set()
        for sid, names in (e.get("tags") or {}).items():
            color = section_color(data, sid)
            for n in names or []:
                tags.add(n)
                if n not in seen:
                    seen.add(n)
                    chips.append({"name": n, "color": color})
        chips.sort(key=lambda c: c["name"])
        out.append({
            "id": e["id"],
            "date": e["date"],
            "title": e.get("title", ""),
            "body": e.get("body", ""),
            "tags": sorted(tags),
            "tag_chips": chips,
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


def move_entry(data, entry_id, new_date):
    """Move an entry to `new_date`.

    Raises ValueError if `new_date` is not a valid YYYY-MM-DD, or if another
    entry already occupies `new_date`. If `new_date` equals the entry's current
    date, returns data unchanged (no-op). Unknown `entry_id` is also a no-op.
    """
    if not _valid_date(new_date):
        raise ValueError(f"Invalid date: {new_date!r}")
    entry = next((e for e in data.get("entries", []) if e.get("id") == entry_id), None)
    if entry is None:
        return data
    if entry["date"] == new_date:
        return data
    conflict = get_entry_by_date(data, new_date)
    if conflict is not None:
        raise ValueError(f"An entry already exists for {new_date!r}")
    entry["date"] = new_date
    return data


# --------------------------------------------------------------------------- #
# Analytics: pure aggregation helpers (consumed by /journal/analytics/data)
# --------------------------------------------------------------------------- #

def _filter_entries_by_date(entries, start, end):
    """Entries whose `date` falls in [start, end] inclusive. A None bound is
    unbounded. YYYY-MM-DD strings compare lexically == chronologically."""
    return [
        e for e in entries
        if (start is None or e.get("date", "") >= start)
        and (end is None or e.get("date", "") <= end)
    ]


def describe(values):
    """Summary statistics over a list of numbers (None/NaN-free callers).

    Returns mean/median/mode/stdev/min/max/count. `mode` is None when no value
    repeats (all unique); `stdev` is None for fewer than 2 values; an empty
    input yields all-None with count 0. Sample stdev (n-1), matching JS.
    """
    vals = [float(v) for v in values if v is not None]
    n = len(vals)
    if n == 0:
        return {"mean": None, "median": None, "mode": None,
                "stdev": None, "min": None, "max": None, "count": 0}
    counts = Counter(vals)
    top = max(counts.values())
    mode = None if top == 1 else min(v for v, c in counts.items() if c == top)
    return {
        "mean": statistics.mean(vals),
        "median": statistics.median(vals),
        "mode": mode,
        "stdev": statistics.stdev(vals) if n >= 2 else None,
        "min": min(vals),
        "max": max(vals),
        "count": n,
    }


def _tags_for(entry, section_id):
    """The tag-name list this entry recorded for `section_id` (possibly empty)."""
    return (entry.get("tags") or {}).get(section_id, []) or []


def tag_frequency(entries, section_id, start, end):
    """{tag: count} across date-filtered entries for one section."""
    out = {}
    for e in _filter_entries_by_date(entries, start, end):
        for tag in _tags_for(e, section_id):
            out[tag] = out.get(tag, 0) + 1
    return out


def tag_cooccurrence(entries, section_id, start, end):
    """{tag: {other_tag: count}} of tags appearing together on the same entry,
    within one section. Symmetric; self-pairs excluded."""
    out = {}
    for e in _filter_entries_by_date(entries, start, end):
        tags = sorted(set(_tags_for(e, section_id)))
        for a in tags:
            for b in tags:
                if a == b:
                    continue
                out.setdefault(a, {})
                out[a][b] = out[a].get(b, 0) + 1
    return out


def tag_trend(entries, section_id, tag, start, end):
    """[{week, count}] of a single tag's frequency per ISO week, sorted."""
    weeks = {}
    for e in _filter_entries_by_date(entries, start, end):
        if tag in _tags_for(e, section_id):
            d = datetime.strptime(e["date"], "%Y-%m-%d").date()
            iso = d.isocalendar()
            key = f"{iso[0]}-W{iso[1]:02d}"
            weeks[key] = weeks.get(key, 0) + 1
    return [{"week": k, "count": weeks[k]} for k in sorted(weeks)]


def tag_streak(entries, section_id, tag):
    """{current, longest, avg} over consecutive-day runs where `tag` appears.
    `current` is the run ending at the latest tagged day; `avg` is the mean run
    length. All zero when the tag never appears."""
    dates = sorted({
        e["date"] for e in entries
        if e.get("date") and tag in _tags_for(e, section_id)
    })
    if not dates:
        return {"current": 0, "longest": 0, "avg": 0}
    parsed = [datetime.strptime(d, "%Y-%m-%d").date() for d in dates]
    runs = []
    run = 1
    for i in range(1, len(parsed)):
        if parsed[i] - parsed[i - 1] == timedelta(days=1):
            run += 1
        else:
            runs.append(run)
            run = 1
    runs.append(run)
    return {"current": runs[-1], "longest": max(runs), "avg": sum(runs) / len(runs)}


_DOW_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]


def numeric_series(entries, section_id, start, end):
    """[{date, value}] of one numeric section's recorded values, sorted by date."""
    out = [
        {"date": e["date"], "value": (e.get("numbers") or {})[section_id]}
        for e in _filter_entries_by_date(entries, start, end)
        if section_id in (e.get("numbers") or {})
    ]
    out.sort(key=lambda d: d["date"])
    return out


def dow_averages(entries, section_id, start, end):
    """{weekday_name: mean value | None} for one numeric section, Mon..Sun."""
    buckets = {i: [] for i in range(7)}
    for e in _filter_entries_by_date(entries, start, end):
        nums = e.get("numbers") or {}
        if section_id in nums:
            d = datetime.strptime(e["date"], "%Y-%m-%d").date()
            buckets[d.weekday()].append(nums[section_id])
    return {
        _DOW_NAMES[i]: (sum(v) / len(v) if v else None)
        for i, v in buckets.items()
    }


# --------------------------------------------------------------------------- #
# Expanded numeric aggregations (numeric_* helpers powering the Numeric tab)
# All ignore entries lacking the value and degrade gracefully on too few points.
# --------------------------------------------------------------------------- #

def _numeric_values(entries, section_id, start, end):
    """Date-sorted [(date, value)] pairs for one numeric section, value present."""
    pairs = [
        (e["date"], (e.get("numbers") or {})[section_id])
        for e in _filter_entries_by_date(entries, start, end)
        if section_id in (e.get("numbers") or {})
    ]
    pairs.sort(key=lambda p: p[0])
    return pairs


def numeric_stats(entries, section_id, start, end):
    """{count, mean, median, stdev, min, max, latest} for one numeric section.

    `latest` is the value on the most recent dated entry that recorded it.
    Entries lacking the value are ignored; an empty range yields all-None with
    count 0. Sample stdev (n-1), matching `describe`/the JS."""
    pairs = _numeric_values(entries, section_id, start, end)
    vals = [v for _, v in pairs]
    d = describe(vals)
    return {
        "count": d["count"],
        "mean": d["mean"],
        "median": d["median"],
        "stdev": d["stdev"],
        "min": d["min"],
        "max": d["max"],
        "latest": pairs[-1][1] if pairs else None,
    }


def numeric_histogram(entries, section_id, bins, start, end):
    """[{lo, hi, count}] buckets spanning min..max for one numeric section.

    All-equal values collapse to a single bucket (lo == hi); fewer than one
    value yields []. The last bucket is closed on the right so the max value
    lands in it."""
    vals = [v for _, v in _numeric_values(entries, section_id, start, end)]
    if not vals:
        return []
    lo, hi = min(vals), max(vals)
    if hi == lo:
        return [{"lo": lo, "hi": hi, "count": len(vals)}]
    n = max(int(bins), 1)
    width = (hi - lo) / n
    out = [{"lo": lo + i * width, "hi": lo + (i + 1) * width, "count": 0}
           for i in range(n)]
    for v in vals:
        idx = int((v - lo) / width)
        if idx >= n:
            idx = n - 1  # the max value belongs in the last bucket
        out[idx]["count"] += 1
    return out


def numeric_regression(entries, section_id, start, end):
    """{slope, intercept, n} least-squares fit of value vs day-index.

    Day-index is days since the first dated value in range, so `slope` is in
    units/day and `intercept` is the fitted value at the first day. Returns
    None-ish slope/intercept when n < 2 or x has zero variance."""
    pairs = _numeric_values(entries, section_id, start, end)
    n = len(pairs)
    if n < 2:
        return {"slope": None, "intercept": None, "n": n}
    base = datetime.strptime(pairs[0][0], "%Y-%m-%d").date()
    xs = [(datetime.strptime(d, "%Y-%m-%d").date() - base).days for d, _ in pairs]
    ys = [v for _, v in pairs]
    mx = sum(xs) / n
    my = sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    if sxx == 0:
        return {"slope": None, "intercept": None, "n": n}
    sxy = sum((xs[i] - mx) * (ys[i] - my) for i in range(n))
    slope = sxy / sxx
    intercept = my - slope * mx
    return {"slope": slope, "intercept": intercept, "n": n}


def numeric_by_date(entries, section_id, start, end):
    """[{date, value}] date-sorted for one numeric section (for the heatmap)."""
    return [{"date": d, "value": v}
            for d, v in _numeric_values(entries, section_id, start, end)]


def numeric_correlation_matrix(entries, section_ids, start, end):
    """{pairs: [{a, b, r, n}]} pairwise Pearson r over same-day value pairs.

    Each unordered pair appears once; self-pairs are skipped. A pair is included
    only when at least two same-day overlaps exist and both have non-zero
    variance (else Pearson is undefined and the pair is dropped)."""
    scoped = _filter_entries_by_date(entries, start, end)
    ids = list(section_ids)
    pairs = []
    for i in range(len(ids)):
        for j in range(i + 1, len(ids)):
            a, b = ids[i], ids[j]
            xs, ys = [], []
            for e in scoped:
                nums = e.get("numbers") or {}
                if a in nums and b in nums:
                    xs.append(nums[a])
                    ys.append(nums[b])
            r = _pearson(xs, ys)
            if r is not None:
                pairs.append({"a": a, "b": b, "r": r, "n": len(xs)})
    return {"pairs": pairs}


def _pearson(xs, ys):
    """Pearson correlation coefficient, or None (n < 2 or zero variance)."""
    n = len(xs)
    if n < 2:
        return None
    mx = sum(xs) / n
    my = sum(ys) / n
    sxy = sum((xs[i] - mx) * (ys[i] - my) for i in range(n))
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    if sxx == 0 or syy == 0:
        return None
    return sxy / math.sqrt(sxx * syy)


def numeric_period_delta(entries, section_id, start, end):
    """{current_mean, previous_mean, delta, pct} for one numeric section.

    Compares the [start, end] window against the immediately preceding window of
    equal length (derived from the bounds). `pct` is delta as a percent of the
    previous mean. All None when bounds are missing or a window has no data;
    `pct` is None when the previous mean is 0."""
    none = {"current_mean": None, "previous_mean": None, "delta": None, "pct": None}
    if not start or not end:
        return none
    s = datetime.strptime(start, "%Y-%m-%d").date()
    e = datetime.strptime(end, "%Y-%m-%d").date()
    length = (e - s).days
    prev_end = s - timedelta(days=1)
    prev_start = prev_end - timedelta(days=length)

    def mean_in(a, b):
        vals = [v for _, v in _numeric_values(entries, section_id,
                                              a.isoformat(), b.isoformat())]
        return sum(vals) / len(vals) if vals else None

    cur = mean_in(s, e)
    prev = mean_in(prev_start, prev_end)
    if cur is None and prev is None:
        return none
    delta = (cur - prev) if (cur is not None and prev is not None) else None
    pct = (delta / prev * 100) if (delta is not None and prev) else None
    return {"current_mean": cur, "previous_mean": prev, "delta": delta, "pct": pct}


def numeric_streaks(entries, section_id, start, end):
    """{longest_above, longest_below, current} runs vs the range mean.

    "Above" means value >= mean over consecutive dated entries. `current` is the
    signed length of the run ending at the most recent value: positive for an
    above-mean run, negative for a below-mean run, 0 when there are no values."""
    pairs = _numeric_values(entries, section_id, start, end)
    vals = [v for _, v in pairs]
    if not vals:
        return {"longest_above": 0, "longest_below": 0, "current": 0}
    mean = sum(vals) / len(vals)
    flags = [v >= mean for v in vals]  # True = above (or at) mean
    longest_above = longest_below = run_len = 0
    for i, above in enumerate(flags):
        if i and flags[i] == flags[i - 1]:
            run_len += 1
        else:
            run_len = 1
        if above:
            longest_above = max(longest_above, run_len)
        else:
            longest_below = max(longest_below, run_len)
    # Current run length, signed by direction.
    cur_len = 1
    for i in range(len(flags) - 1, 0, -1):
        if flags[i] == flags[i - 1]:
            cur_len += 1
        else:
            break
    current = cur_len if flags[-1] else -cur_len
    return {"longest_above": longest_above, "longest_below": longest_below,
            "current": current}


def numeric_cumulative(entries, section_id, start, end):
    """[{date, total}] running sum of one numeric section's date-sorted values."""
    out = []
    total = 0.0
    for d, v in _numeric_values(entries, section_id, start, end):
        total += v
        out.append({"date": d, "total": total})
    return out


def numeric_coverage(entries, section_id, start, end):
    """{logged, total_entries, pct} — how often the number is recorded in range."""
    scoped = _filter_entries_by_date(entries, start, end)
    total = len(scoped)
    logged = sum(1 for e in scoped if section_id in (e.get("numbers") or {}))
    pct = (logged / total * 100) if total else 0
    return {"logged": logged, "total_entries": total, "pct": pct}


# --------------------------------------------------------------------------- #
# Mood aggregations (mood is an int 1..7 or null; nulls are always ignored)
# --------------------------------------------------------------------------- #

def _entry_mood(entry):
    """The entry's recorded mood as an int in 1..7, or None.

    Defensive: anything that isn't a valid 1..7 mood (including an absent or
    null field) reads as None so callers can simply skip it."""
    m = entry.get("mood")
    return int(m) if _valid_mood(m) else None


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


def mood_series(entries, start, end):
    """[{date, mood}] of recorded moods, date-filtered and sorted by date.
    Entries with no mood are omitted."""
    out = []
    for e in _filter_entries_by_date(entries, start, end):
        m = _entry_mood(e)
        if m is not None:
            out.append({"date": e["date"], "mood": m})
    out.sort(key=lambda d: d["date"])
    return out


def mood_dow_averages(entries, start, end):
    """{weekday_name: mean mood | None} over recorded moods, Mon..Sun."""
    buckets = {i: [] for i in range(7)}
    for e in _filter_entries_by_date(entries, start, end):
        m = _entry_mood(e)
        if m is not None:
            d = datetime.strptime(e["date"], "%Y-%m-%d").date()
            buckets[d.weekday()].append(m)
    return {
        _DOW_NAMES[i]: (sum(v) / len(v) if v else None)
        for i, v in buckets.items()
    }


def mood_distribution(entries, start, end):
    """{1..7: count} histogram of recorded mood values (nulls ignored)."""
    out = {n: 0 for n in range(1, 8)}
    for e in _filter_entries_by_date(entries, start, end):
        m = _entry_mood(e)
        if m is not None:
            out[m] += 1
    return out


def mood_by_date(entries, start, end):
    """{date: mood} for every date-filtered entry that recorded a mood."""
    return {
        e["date"]: _entry_mood(e)
        for e in _filter_entries_by_date(entries, start, end)
        if _entry_mood(e) is not None
    }


def mood_numeric_pairs(entries, section_id, start, end):
    """[{date, value, mood}] for days that have BOTH a mood and a value for one
    numeric section, date-sorted. Powers mood-vs-numeric correlation."""
    out = []
    for e in _filter_entries_by_date(entries, start, end):
        m = _entry_mood(e)
        nums = e.get("numbers") or {}
        if m is not None and section_id in nums:
            out.append({"date": e["date"], "value": nums[section_id], "mood": m})
    out.sort(key=lambda d: d["date"])
    return out


def word_counts(entries, start, end):
    """[{date, count}] of body word counts (whitespace split), sorted by date."""
    out = [
        {"date": e["date"], "count": len((e.get("body") or "").split())}
        for e in _filter_entries_by_date(entries, start, end)
    ]
    out.sort(key=lambda d: d["date"])
    return out


def entry_gaps(entries, start, end):
    """[{gap_days, after_date}] day-gaps between consecutive entry dates."""
    dates = sorted({
        e["date"] for e in _filter_entries_by_date(entries, start, end)
        if e.get("date")
    })
    parsed = [datetime.strptime(d, "%Y-%m-%d").date() for d in dates]
    return [
        {"gap_days": (parsed[i] - parsed[i - 1]).days, "after_date": dates[i]}
        for i in range(1, len(parsed))
    ]


def creation_hours(entries, start, end):
    """{0..23: count} histogram of entry `created` timestamps' hour."""
    out = {h: 0 for h in range(24)}
    for e in _filter_entries_by_date(entries, start, end):
        created = e.get("created")
        if not created:
            continue
        try:
            out[datetime.fromisoformat(created).hour] += 1
        except ValueError:
            continue
    return out


def date_density(entries, start, end):
    """{date: 1} for every day that has an entry (calendar heatmap presence)."""
    return {
        e["date"]: 1
        for e in _filter_entries_by_date(entries, start, end)
        if e.get("date")
    }


def entry_streak(entries):
    """{current, longest, last_date} over consecutive calendar days with an
    entry. `current` is the run ending at the most recent entry date."""
    dates = sorted({e["date"] for e in entries if e.get("date")})
    if not dates:
        return {"current": 0, "longest": 0, "last_date": None}
    parsed = [datetime.strptime(d, "%Y-%m-%d").date() for d in dates]
    longest = run = 1
    for i in range(1, len(parsed)):
        run = run + 1 if parsed[i] - parsed[i - 1] == timedelta(days=1) else 1
        longest = max(longest, run)
    current = 1
    for i in range(len(parsed) - 1, 0, -1):
        if parsed[i] - parsed[i - 1] == timedelta(days=1):
            current += 1
        else:
            break
    return {"current": current, "longest": longest, "last_date": dates[-1]}


def section_coverage(entries, active_section_ids, start, end):
    """[{date, covered:[section_id]}] per entry (date-sorted). A section counts
    as covered when the entry has a non-empty tag list or a number for it."""
    ids = list(active_section_ids)
    out = []
    for e in sorted(_filter_entries_by_date(entries, start, end),
                    key=lambda x: x.get("date", "")):
        tags = e.get("tags") or {}
        nums = e.get("numbers") or {}
        covered = [sid for sid in ids if tags.get(sid) or sid in nums]
        out.append({"date": e["date"], "covered": covered})
    return out


# --------------------------------------------------------------------------- #
# Overview suggestions: word frequency, tag suggestions, dormant tags, uplift.
# All pure; range-relevant helpers take injectable start/end bounds. Mood
# aggregations ignore null moods and degrade gracefully on thin data.
# --------------------------------------------------------------------------- #

# Common English stopwords stripped before counting body word frequency. Plus a
# minimum token length (very short tokens are never meaningful suggestions).
_STOPWORDS = {
    # Articles / determiners / conjunctions / prepositions
    "the", "and", "a", "an", "to", "of", "in", "on", "at", "for", "with",
    "is", "it", "this", "that", "these", "those", "as", "by", "be", "been",
    "was", "were", "are", "am", "or", "but", "if", "so", "then", "than",
    "from", "into", "out", "up", "down", "over", "under", "off", "onto",
    "through", "between", "during", "without", "within", "upon", "per",
    "and", "nor", "yet", "and", "both", "either", "neither", "such",
    # Pronouns / possessives
    "i", "im", "ive", "id", "ill", "you", "youre", "youve", "youll",
    "he", "hes", "she", "shes", "they", "theyre", "them", "we", "were",
    "weve", "us", "my", "me", "mine", "your", "yours", "his", "her", "hers",
    "its", "our", "ours", "their", "theirs", "myself", "yourself", "himself",
    "herself", "itself", "ourselves", "themselves", "whom", "whose",
    # Auxiliary / modal / common verbs
    "do", "did", "does", "doing", "done", "have", "has", "had", "having",
    "will", "would", "wont", "can", "cant", "cannot", "could", "couldnt",
    "should", "shouldnt", "shall", "may", "might", "must", "mustnt",
    "being", "isnt", "arent", "wasnt", "werent", "hasnt", "havent", "hadnt",
    "didnt", "doesnt", "dont",
    # Negation / quantifiers / intensifiers
    "not", "no", "yes", "all", "any", "some", "more", "most", "much", "many",
    "lot", "lots", "few", "less", "least", "very", "just", "quite", "rather",
    "pretty", "almost", "enough", "only", "own", "same", "other", "another",
    "each", "every", "none", "every",
    # Common-but-meaningless words called out in the spec
    "everything", "something", "anything", "nothing", "everyone", "someone",
    "anyone", "everybody", "somebody", "anybody", "nobody", "really",
    "going", "want", "wanted", "wants", "need", "needed", "needs", "like",
    "liked", "likes", "today", "actually", "maybe", "still", "even", "thing",
    "things", "feel", "felt", "feeling", "feels", "kind", "sort", "stuff",
    "way", "ways", "bit", "guess", "though", "anyway", "anymore",
    "basically", "literally", "honestly", "totally", "definitely", "probably",
    "perhaps", "seem", "seems", "seemed", "look", "looks", "looked",
    "make", "makes", "made", "making", "take", "takes", "took", "taken",
    "come", "comes", "came", "coming", "say", "says", "said", "saying",
    "think", "thinks", "thought", "thinking", "know", "knows", "knew",
    "knowing", "see", "sees", "saw", "seen", "let", "lets", "put", "use",
    "used", "uses", "tell", "told", "give", "gave", "given",
    # Time / quantity fillers
    "got", "get", "gets", "getting", "go", "goes", "gone", "went", "day",
    "days", "week", "weeks", "time", "times", "year", "years", "hour",
    "hours", "minute", "minutes", "also", "around", "soon", "later", "early",
    "again", "ago", "always", "never", "often", "sometimes", "usually",
    "about", "after", "before",
    # Question / relative words
    "there", "here", "what", "whats", "when", "where", "which", "who", "how",
    "why", "because", "while", "until", "since", "whether",
    # Misc connectives / fillers
    "too", "now", "one", "two", "three", "first", "next", "last", "well",
    "okay", "yeah", "oh", "hey", "etc", "via", "amongst",
    "however", "therefore", "thus", "hence", "else", "ever",
}
_MIN_WORD_LEN = 3
_WORD_RE = re.compile(r"[a-z0-9]+")


def word_frequency(entries, start=None, end=None, limit=None):
    """[{word, count}] over entry bodies, sorted by count desc then word.

    Tokens are lowercased alphanumeric runs; `_STOPWORDS` and tokens shorter
    than `_MIN_WORD_LEN` are excluded. `limit` caps the result length."""
    counts = Counter()
    for e in _filter_entries_by_date(entries, start, end):
        for tok in _WORD_RE.findall((e.get("body") or "").lower()):
            if len(tok) >= _MIN_WORD_LEN and tok not in _STOPWORDS:
                counts[tok] += 1
    ordered = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    if limit is not None:
        ordered = ordered[:limit]
    return [{"word": w, "count": c} for w, c in ordered]


def _known_tag_names(data):
    """Set of every registered tag name (tags ∪ archived_tags), normalized."""
    known = set()
    for s in data.get("sections", []):
        for name in (s.get("tags") or []) + (s.get("archived_tags") or []):
            n = _normalize_name(name)
            if n:
                known.add(n)
    return known


def _suggestion_window_bounds(now, window_days):
    """The inclusive [start, end] YYYY-MM-DD window of the last `window_days`
    days relative to `now` (today). `start` is `window_days - 1` days before
    today, so today + the preceding `window_days - 1` days are in range."""
    now = now or datetime.now()
    today = now.date()
    start = today - timedelta(days=window_days - 1)
    return start.isoformat(), today.isoformat()


def _word_days(entries, start, end):
    """{word: set(dates)} — distinct entry-dates each non-stopword body token
    appears on, over date-filtered entries. The day-tracking primitive behind
    the ≥min_days suggestion threshold."""
    days = {}
    for e in _filter_entries_by_date(entries, start, end):
        date = e.get("date")
        if not date:
            continue
        seen = set()
        for tok in _WORD_RE.findall((e.get("body") or "").lower()):
            if len(tok) >= _MIN_WORD_LEN and tok not in _STOPWORDS:
                seen.add(tok)
        for tok in seen:
            days.setdefault(tok, set()).add(date)
    return days


def _dismissed_within(data, now, cooldown_days=30):
    """Set of normalized words dismissed within the last `cooldown_days`
    (relative to `now`). Words dismissed on/after the cooldown resurface."""
    now = now or datetime.now()
    today = now.date()
    out = set()
    for word, when in (data.get("dismissed_suggestions") or {}).items():
        if not _valid_date(when):
            continue
        days_since = (today - datetime.strptime(when, "%Y-%m-%d").date()).days
        if 0 <= days_since < cooldown_days:
            out.add(_normalize_name(word))
    return out


def tag_suggestions(data, now=None, window_days=30, min_days=3, limit=None):
    """[{word, count, days}] of recurrent body words worth tagging.

    Pipeline (v2): take entries dated within the last `window_days` relative to
    `now` (today) → tokenize bodies (lowercased alnum runs) → drop `_STOPWORDS`
    and tokens shorter than `_MIN_WORD_LEN` → drop words already a known tag
    (case-insensitively in any section's `tags ∪ archived_tags`) → keep words on
    `>= min_days` distinct days → drop words dismissed within the 30-day cooldown
    → sort by `days` desc, then `count` desc, then word → cap to `limit`.

    `days` is the distinct-day count in the window; `count` is the total token
    occurrences. The window is independent of the analytics date-range filter.
    Degrades gracefully on missing bodies/dates."""
    entries = data.get("entries", [])
    start, end = _suggestion_window_bounds(now, window_days)
    known = _known_tag_names(data)
    dismissed = _dismissed_within(data, now)

    day_map = _word_days(entries, start, end)
    counts = Counter()
    for e in _filter_entries_by_date(entries, start, end):
        if not e.get("date"):
            continue
        for tok in _WORD_RE.findall((e.get("body") or "").lower()):
            if len(tok) >= _MIN_WORD_LEN and tok not in _STOPWORDS:
                counts[tok] += 1

    out = []
    for word, dates in day_map.items():
        if word in known or word in dismissed:
            continue
        if len(dates) < min_days:
            continue
        out.append({"word": word, "count": counts[word], "days": len(dates)})
    out.sort(key=lambda s: (-s["days"], -s["count"], s["word"]))
    if limit is not None:
        out = out[:limit]
    return out


_SNIPPET_DEFAULT_RADIUS = 40


def _word_match_re(word):
    """A compiled whole-word, case-insensitive regex for `word` (escaped)."""
    return re.compile(r"(?<![a-z0-9])" + re.escape(word.lower()) + r"(?![a-z0-9])",
                      re.IGNORECASE)


def suggestion_occurrences(data, word, now=None, window_days=30,
                           snippet_radius=_SNIPPET_DEFAULT_RADIUS):
    """[{date, snippet}] (newest first) for windowed entries whose body contains
    `word` as a whole word (case-insensitive).

    One row per matching entry in the last `window_days` window. `snippet` is the
    body text around the FIRST match (± `snippet_radius` chars, trimmed to word
    boundaries, with leading/trailing "…" when truncated) with the matched word
    wrapped in `**...**` so the client can highlight it. Defensive on empty
    bodies — entries with no match are skipped."""
    word = _normalize_name(word)
    if not word:
        return []
    start, end = _suggestion_window_bounds(now, window_days)
    pat = _word_match_re(word)
    rows = []
    for e in _filter_entries_by_date(data.get("entries", []), start, end):
        if not e.get("date"):
            continue
        body = e.get("body") or ""
        m = pat.search(body)
        if not m:
            continue
        rows.append({"date": e["date"],
                     "snippet": _build_snippet(body, m.start(), m.end(),
                                               snippet_radius)})
    rows.sort(key=lambda r: r["date"], reverse=True)
    return rows


def _build_snippet(body, ms, me, radius):
    """A trimmed snippet of `body` around [ms, me) with the match wrapped in
    `**...**`. Trims to word boundaries within ± `radius` chars and adds leading/
    trailing "…" when text was cut off."""
    lo = max(0, ms - radius)
    hi = min(len(body), me + radius)
    # Trim to word boundaries (avoid cutting a word in half) when we trimmed.
    if lo > 0:
        while lo < ms and not body[lo - 1].isspace():
            lo += 1
    if hi < len(body):
        while hi > me and not body[hi].isspace():
            hi -= 1
    before = body[lo:ms]
    matched = body[ms:me]
    after = body[me:hi]
    snippet = before + "**" + matched + "**" + after
    snippet = snippet.strip()
    if lo > 0:
        snippet = "…" + snippet
    if hi < len(body):
        snippet = snippet + "…"
    return snippet


def dismiss_suggestion(data, word, now=None):
    """Record that `word` was dismissed today (suppresses it for the cooldown).
    Stored normalized in `data["dismissed_suggestions"]`. Idempotent."""
    word = _normalize_name(word)
    if not word:
        return data
    data.setdefault("dismissed_suggestions", {})[word] = today_iso(now)
    return data


def apply_tag_suggestion(data, word, section_id, dates, permanent, now=None):
    """Apply tag `word` to the given `dates` under `section_id`.

    `permanent=True`: add `word` to the section's master list via
    `add_section_tag` AND tag each date's entry. `permanent=False`: tag each
    date's entry only (it derives as a temporary tag). For each date, get-or-
    create that day's entry and add `word` to `entry["tags"][section_id]`
    (deduped, case-insensitively). Validates `word` via the tag-name validator
    (raises on a bad name). Unknown section id behaves like the sibling helpers
    (`add_section_tag` no-ops; entry tags for an unknown section are dropped by
    `upsert_entry`, so nothing is tagged). Skips invalid dates. Returns `data`."""
    word = _normalize_name(word)
    if not _valid_name(word):
        raise ValueError(f"Invalid tag name: {word!r}")
    if permanent:
        add_section_tag(data, section_id, word)  # may raise on numeric section
    for date in dates or []:
        if not _valid_date(date):
            continue
        existing = get_entry_by_date(data, date)
        base_tags = dict(existing["tags"]) if existing else {}
        merged = merge_entry_tags(base_tags, {section_id: [word]})
        if existing is not None:
            upsert_entry(data, date, existing.get("title") or "(untitled)",
                         existing.get("body", ""), tags=merged,
                         numbers=dict(existing.get("numbers") or {}),
                         mood=existing.get("mood"), now=now)
        else:
            upsert_entry(data, date, "(untitled)", "", tags=merged,
                         numbers={}, mood=None, now=now)
    return data


def dormant_tags(data, now=None, section_name="people", threshold_days=21):
    """[{name, section_id, last_date, days_since}] for long-unused people tags.

    Scans tags used on entries under section(s) whose name == `section_name`
    (case-insensitive) and whose most recent appearance is `>= threshold_days`
    before `now`. Tags never used on any entry are ignored. Sorted most-dormant
    (largest days_since) first, then by name."""
    now = now or datetime.now()
    today = now.date()
    target = _normalize_name(section_name)
    out = []
    for s in data.get("sections", []):
        if _normalize_name(s.get("name")) != target:
            continue
        sid = s.get("id")
        last = {}  # tag name -> latest YYYY-MM-DD it appeared on
        for e in data.get("entries", []):
            date = e.get("date")
            if not date:
                continue
            for raw in (e.get("tags") or {}).get(sid, []) or []:
                n = _normalize_name(raw)
                if n and (n not in last or date > last[n]):
                    last[n] = date
        for name, last_date in last.items():
            days_since = (today - datetime.strptime(last_date, "%Y-%m-%d").date()).days
            if days_since >= threshold_days:
                out.append({
                    "name": name,
                    "section_id": sid,
                    "last_date": last_date,
                    "days_since": days_since,
                })
    out.sort(key=lambda d: (-d["days_since"], d["name"]))
    return out


def mood_tag_uplift(entries, start=None, end=None, min_n=2):
    """[{name, section_id, avg_mood, baseline, uplift, n}] per tag.

    `avg_mood` is the mean mood on days the tag appears; `baseline` is the mean
    mood over ALL in-range entries with a mood; `uplift` is their difference.
    Only tags with `n >= min_n` mood-bearing days are kept. Null moods are
    ignored throughout. Sorted by abs(uplift) desc, then name. Each (name,
    section) pair is one row; a tag repeated within one entry counts once."""
    scoped = _filter_entries_by_date(entries, start, end)
    baseline_moods = [m for m in (_entry_mood(e) for e in scoped) if m is not None]
    if not baseline_moods:
        return []
    baseline = sum(baseline_moods) / len(baseline_moods)

    by_tag = {}  # (name, section_id) -> [moods]
    for e in scoped:
        m = _entry_mood(e)
        if m is None:
            continue
        for sid, names in (e.get("tags") or {}).items():
            for raw in set(_normalize_name(n) for n in names or [] if n):
                by_tag.setdefault((raw, sid), []).append(m)

    out = []
    for (name, sid), moods in by_tag.items():
        if len(moods) < min_n:
            continue
        avg = sum(moods) / len(moods)
        out.append({
            "name": name,
            "section_id": sid,
            "avg_mood": avg,
            "baseline": baseline,
            "uplift": avg - baseline,
            "n": len(moods),
        })
    out.sort(key=lambda r: (-abs(r["uplift"]), r["name"]))
    return out


def analytics_payload(data):
    """The full JSON payload for the analytics page.

    `sections` lists active sections only (archived ones are dropped, but their
    historical values stay in `entries` keyed by section id — the JS simply
    never references an unknown id). `date_range` spans all entry dates.
    """
    sections = [
        {
            "id": s["id"],
            "name": s["name"],
            "type": s["type"],
            "color": s["color"],
            "tags": list(s.get("tags") or []),
            "unit": s.get("unit"),
        }
        for s in active_sections(data)
    ]
    entries = [
        {
            "date": e["date"],
            "tags": dict(e.get("tags") or {}),
            "numbers": dict(e.get("numbers") or {}),
            "body": e.get("body", ""),
            "created": e.get("created"),
            "mood": _entry_mood(e),
            "sleep": _entry_sleep(e),
        }
        for e in data.get("entries", [])
    ]
    dates = sorted(e["date"] for e in entries if e.get("date"))
    date_range = ({"min": dates[0], "max": dates[-1]}
                  if dates else {"min": None, "max": None})
    return {
        "sections": sections,
        "entries": entries,
        "date_range": date_range,
    }


# --------------------------------------------------------------------------- #
# Tag pages / backlinks: per-tag overview (journal side; pure)
# --------------------------------------------------------------------------- #

def _entry_has_tag(entry, name):
    """True if `entry` carries the (normalized) tag `name` under any section."""
    for names in (entry.get("tags") or {}).values():
        for raw in names or []:
            if _normalize_name(raw) == name:
                return True
    return False


def tag_overview(data, name, start=None, end=None):
    """Unify everything the journal side knows about one tag `name`.

    Case-insensitive (entry tags are stored normalized). All mood aggregations
    ignore null moods. `start`/`end` are inclusive YYYY-MM-DD bounds (None =
    unbounded), mirroring the analytics helpers. Pure — no clock, no I/O.

    Returns:
      sections      [{id, name, color}] sections where the name appears (in range)
      entries       count of in-range entries carrying the tag
      first, last   earliest / latest such entry date (or None)
      avg_mood      mean mood over tagged entries that have a mood (or None)
      baseline_mood mean mood over ALL in-range entries with a mood (or None)
      uplift        avg_mood - baseline_mood (or None)
      mood_series   [{date, mood}] for tagged entries with a mood, date-sorted
      dow           7 counts Mon..Sun of tagged entries by weekday
      cooccurring   [{name, section_id, count}] other tags on the same entries
      timeline      [{date, snippet, sections, mood}] tagged entries, newest first
    """
    name = _normalize_name(name)
    scoped = _filter_entries_by_date(data.get("entries", []), start, end)
    tagged = [e for e in scoped if _entry_has_tag(e, name)]

    # Sections where the name appears, in stored section order, deduped.
    section_ids = set()
    for e in tagged:
        for sid, names in (e.get("tags") or {}).items():
            if any(_normalize_name(n) == name for n in names or []):
                section_ids.add(sid)
    sections = [
        {"id": s["id"], "name": s["name"], "color": s["color"]}
        for s in data.get("sections", []) if s.get("id") in section_ids
    ]

    dates = sorted(e["date"] for e in tagged if e.get("date"))
    first = dates[0] if dates else None
    last = dates[-1] if dates else None

    tagged_moods = [m for m in (_entry_mood(e) for e in tagged) if m is not None]
    baseline_moods = [m for m in (_entry_mood(e) for e in scoped) if m is not None]
    avg_mood = sum(tagged_moods) / len(tagged_moods) if tagged_moods else None
    baseline_mood = (sum(baseline_moods) / len(baseline_moods)
                     if baseline_moods else None)
    uplift = (avg_mood - baseline_mood
              if avg_mood is not None and baseline_mood is not None else None)

    mood_series = sorted(
        ({"date": e["date"], "mood": _entry_mood(e)} for e in tagged
         if _entry_mood(e) is not None),
        key=lambda d: d["date"])

    dow = [0] * 7
    for e in tagged:
        d = datetime.strptime(e["date"], "%Y-%m-%d").date()
        dow[d.weekday()] += 1

    # Co-occurrence: other tags on the same entries, keyed by (name, section).
    cooc = {}
    for e in tagged:
        for sid, names in (e.get("tags") or {}).items():
            for raw in names or []:
                other = _normalize_name(raw)
                if not other or other == name:
                    continue
                key = (other, sid)
                cooc[key] = cooc.get(key, 0) + 1
    cooccurring = [
        {"name": n, "section_id": sid, "count": c}
        for (n, sid), c in sorted(cooc.items(), key=lambda kv: (-kv[1], kv[0][0]))
    ]

    timeline = [
        {
            "date": e["date"],
            "snippet": (e.get("body") or "").strip()[:80],
            "sections": [sid for sid, names in (e.get("tags") or {}).items()
                         if any(_normalize_name(n) == name for n in names or [])],
            "mood": _entry_mood(e),
        }
        for e in sorted(tagged, key=lambda x: x.get("date", ""), reverse=True)
    ]

    return {
        "sections": sections,
        "entries": len(tagged),
        "first": first,
        "last": last,
        "avg_mood": avg_mood,
        "baseline_mood": baseline_mood,
        "uplift": uplift,
        "mood_series": mood_series,
        "dow": dow,
        "cooccurring": cooccurring,
        "timeline": timeline,
    }
