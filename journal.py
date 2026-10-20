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
import hashlib
import math
import os
import re
import statistics
import uuid
import journal_media
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

# API-managed numeric sections: the numeric parts of a Google-Health sleep dict
# are mirrored into hidden-from-the-form numeric sections so they are filterable
# in Search + the Numeric analytics tab. `managed` holds this provider id and
# `metric` the stable key; sections are created lazily (only when a real value
# for that metric syncs). See `sleep_metric_values` / `apply_sleep_metrics`.
_GOOGLE_SLEEP_PROVIDER = "google_sleep"
_SLEEP_METRIC_SECTIONS = [
    {"metric": "sleep_duration", "name": "sleep duration", "unit": "hrs", "color": "#8a7fd6"},
    {"metric": "sleep_quality",  "name": "sleep quality",  "unit": "%",   "color": "#76a5af"},
    {"metric": "deep_sleep",     "name": "deep sleep",     "unit": "min", "color": "#5c6bc0"},
    {"metric": "rem_sleep",      "name": "rem sleep",      "unit": "min", "color": "#9575cd"},
    {"metric": "light_sleep",    "name": "light sleep",    "unit": "min", "color": "#6fa8dc"},
    {"metric": "awake_time",     "name": "awake time",     "unit": "min", "color": "#e0a955"},
]
# stage-dict key -> metric key (Google sleep `stages` uses deep/light/rem/wake)
_SLEEP_STAGE_METRICS = {
    "deep": "deep_sleep", "rem": "rem_sleep",
    "light": "light_sleep", "wake": "awake_time",
}


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
            s.setdefault("managed", None)
            s.setdefault("metric", None)
            if not isinstance(s.get("chart_opts"), dict):
                s["chart_opts"] = {}
            if "cumulative" in s:   # migrate the short-lived single-flag field
                legacy = s.pop("cumulative")
                if s.get("type") == "numeric" and legacy is not None:
                    s["chart_opts"].setdefault("numeric-cumulative", bool(legacy))
        for e in parsed["entries"]:
            if not isinstance(e.get("tags"), dict):
                e["tags"] = {}
            if not isinstance(e.get("numbers"), dict):
                e["numbers"] = {}
            e.setdefault("mood", None)
            e.setdefault("sleep", None)
            e.setdefault("rescuetime", None)
            e.setdefault("music", None)
            e.setdefault("music_history", None)
            e.setdefault("music_live", None)
            e.setdefault("music_legacy", None)
            e.setdefault("usage", None)
            e.setdefault("health", None)
            e.setdefault("audio_transcript", "")
            e.setdefault("document", None)
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
    return bool(name) and bool(_TAG_NAME_RE.fullmatch(name))


# The Manage page's per-section "Configure" popup: which analytics charts (by
# CHARTS registry id in analytics.js) a section can be included/excluded from.
# (id, label) pairs, in the order they should list in the popup. Mirrors the
# panel="numeric" / panel="tags" entries in analytics.js's CHARTS array —
# update both together if a chart is added, renamed, or removed.
NUMERIC_CHART_OPTIONS = [
    ("numeric-stat-cards", "Stat cards"),
    ("numeric-line", "Values over time"),
    ("numeric-cumulative", "Cumulative total"),
    ("numeric-period-delta", "Period-over-period delta"),
    ("numeric-histogram", "Distribution histogram"),
    ("numeric-calendar", "Calendar heatmap"),
    ("numeric-dow", "Average by day of week"),
    ("numeric-scatter", "Correlation scatter"),
    ("numeric-correlation-matrix", "Correlation matrix"),
    ("numeric-streaks", "Above/below-average streaks"),
    ("numeric-coverage", "Coverage"),
]

TAG_CHART_OPTIONS = [
    ("tag-frequency", "Tag frequency"),
    ("tag-trend", "Top-tag trend"),
    ("tag-heatmap", "Per-tag activity heatmap"),
    ("tag-cooccurrence", "Co-occurrence"),
]


def chart_options_for(section_type):
    """The (id, label) chart-option pairs applicable to a section type."""
    return NUMERIC_CHART_OPTIONS if section_type == "numeric" else TAG_CHART_OPTIONS


def section_chart_options(section):
    """The Manage page's per-section chart checklist: [{id, label, enabled}].
    `enabled` reflects `section["chart_opts"]`, defaulting True (shown) for any
    chart id not yet recorded there — e.g. a chart added after the section was
    last configured."""
    opts = section.get("chart_opts") or {}
    return [
        {"id": opt_id, "label": label, "enabled": bool(opts.get(opt_id, True))}
        for opt_id, label in chart_options_for(section.get("type"))
    ]


def add_section(data, name, type_, color, unit=None, managed=None, metric=None):
    """Create a section. Validates name (allowlist), type, and hex color.
    Names must be unique among non-archived sections. Returns the new section.

    `managed` (a provider id string, e.g. `_GOOGLE_SLEEP_PROVIDER`) and `metric`
    (a stable metric key) mark an API-fed section: hidden from the entry form's
    editable inputs but still present in Search + Numeric analytics. Both default
    to None for ordinary user-created sections.

    A fresh section's `chart_opts` starts empty (every chart shown by default —
    see `section_chart_options`); adjust it after creation via the Manage page's
    Configure popup / `set_section_chart_opts`.
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
        "managed": managed or None,
        "metric": metric or None,
        "chart_opts": {},
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


def set_section_chart_opts(data, section_id, enabled_ids):
    """Set which analytics charts include this section, from the Manage page's
    Configure popup. `enabled_ids` is an iterable of chart ids to mark enabled;
    every other id in that section type's option list (`chart_options_for`) is
    marked disabled. Unknown id = no-op."""
    s = section_by_id(data, section_id)
    if s is None:
        return data
    enabled = set(enabled_ids or [])
    s["chart_opts"] = {
        opt_id: (opt_id in enabled) for opt_id, _ in chart_options_for(s.get("type"))
    }
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


def mutate_mobile_tag(data, section_id, name, action="add"):
    """Apply a validated registry intent without changing any entry selections.

    Add restores a permanent choice; archive works for permanent and temporary
    names. A temporary restore only removes the archive marker, leaving the
    entry that selected the tag as its source. HTTP request receipts handle
    replay ordering around later, explicitly different intentions.
    """
    if action not in ("add", "archive", "restore_temporary"):
        raise ValueError("Choose add, archive or restore_temporary")
    if not isinstance(name, str):
        raise ValueError("A tag name is required")
    tag = _normalize_name(name)
    if not _valid_name(tag) or len(tag) > 200:
        raise ValueError("Use a tag name of at most 200 letters, numbers, spaces, dots, dashes or underscores")
    if not isinstance(section_id, str) or not section_id:
        raise ValueError("Choose an active tag section")
    section = section_by_id(data, section_id)
    if section is None or section.get("archived") or section.get("type") != "tag":
        raise ValueError("Choose an active tag section")
    if action == "add":
        add_section_tag(data, section_id, tag)
    elif action == "archive":
        remove_section_tag(data, section_id, tag)
        archive_temporary_tag(data, section_id, tag)
    else:
        archived = section.setdefault("archived_tags", [])
        if tag in archived:
            archived.remove(tag)
    result = {"name": tag, "section_id": section_id, "color": section["color"]}
    if action != "add":
        result["archived"] = action == "archive"
    return result


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
        return datetime.strptime(date_str, "%Y-%m-%d").date().isoformat() == date_str
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


def suggest_entry_title(body, limit=60):
    """Return a short deterministic title suggestion for journal prose.

    This is deliberately conservative and local: use the first meaningful
    sentence/line, remove Datapom's inline control syntax and rich-text markers,
    then truncate at a word boundary.  The helper only proposes text; callers
    must never replace a non-empty user title with it.
    """
    text = str(body or "").strip()
    if not text:
        return ""
    first = next((line.strip() for line in text.splitlines() if line.strip()), "")
    first = re.split(r"(?<=[.!?])\s+", first, maxsplit=1)[0]
    first = re.sub(r"^(?:-\s*)?\[\s*\]\s*", "", first)
    first = re.sub(r"\s+>(?:today|tomorrow|[a-z]+|\+\d+[dwm]|\d{4}-\d{2}-\d{2})\b",
                   "", first, flags=re.IGNORECASE)
    first = re.sub(r"\[task:[0-9a-f]+\]\s*", "", first, flags=re.IGNORECASE)
    first = re.sub(r"(?:\*\*|__|~~|\*)", "", first)
    first = _MENTION_RE.sub(lambda m: m.group(1).replace("_", " "), first)
    first = _NUMERIC_RE.sub(lambda m: f"{m.group(1).replace('_', ' ')} {m.group(2)}", first)
    first = re.sub(r"\s+", " ", first).strip(" \t.,:;!?-–—")
    if not first:
        return ""
    if len(first) > limit:
        clipped = first[:limit + 1]
        first = clipped[:clipped.rfind(" ")] if " " in clipped else clipped[:limit]
    return first[:1].upper() + first[1:]


def entries_sorted(data):
    """Entries newest date first."""
    return sorted(data.get("entries", []), key=lambda e: e.get("date", ""), reverse=True)


# --------------------------------------------------------------------------- #
# Task 6: Entry upsert & delete
# --------------------------------------------------------------------------- #

def upsert_entry(data, date, title, body, tags=None, numbers=None, mood=None,
                 now=None, audio_transcript=None, document=None):
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
    if document is not None:
        document = journal_media.validate_document(document)
        body = journal_media.document_body(document)
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
        if document is None and existing.get("document") is not None:
            document = journal_media.replace_document_body(existing["document"], body)
        existing["title"] = title
        existing["body"] = body
        existing["tags"] = clean_tags
        existing["numbers"] = clean_numbers
        existing["mood"] = clean_mood
        if document is not None:
            existing["document"] = document
        if audio_transcript is not None:
            existing["audio_transcript"] = str(audio_transcript)
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
        "audio_transcript": str(audio_transcript or ""),
        "document": document,
        "music_history": None,
        "music_live": None,
        "music_legacy": None,
    }
    data.setdefault("entries", []).append(entry)
    return entry


class EntryConflictError(ValueError):
    """A mobile edit was based on an older version of the entry."""

    def __init__(self, current):
        super().__init__("Entry changed since it was loaded")
        self.current = current


def edit_revision(data, entry):
    """Opaque revision of user-editable content, independent of provider refreshes.

    Missing dates and provider-only placeholders share an empty revision.
    Archived user fields remain part of the revision so historical edits cannot
    be overwritten by a stale form. This projection is never persisted.
    """
    entry = entry or {}
    managed = {s['id'] for s in data.get('sections', []) if s.get('managed')}
    content = {key: entry.get(key) or '' for key in ('title', 'body', 'audio_transcript')}
    if content['title'] == entry.get('date'):
        content['title'] = ''
    content['mood'] = entry.get('mood')
    content['document'] = entry.get('document') or None
    for key in ('tags', 'numbers'):
        content[key] = {sid: value for sid, value in (entry.get(key) or {}).items()
                        if sid not in managed}
    return hashlib.sha256(json.dumps(content, sort_keys=True, separators=(',', ':'),
                                     ensure_ascii=False).encode()).hexdigest()


def entry_view(data, entry):
    """A response copy with its edit revision; keep the stored object untouched."""
    if entry is None:
        return None
    visible = {key: value for key, value in entry.items() if key not in {"music_history", "music_live", "music_legacy"}}
    return {**visible, 'edit_revision': edit_revision(data, entry)}


def _check_entry_base(data, existing, base_updated, base_edit_revision=None):
    if base_edit_revision is not None:
        if not isinstance(base_edit_revision, str) or not re.fullmatch(r'[0-9a-f]{64}', base_edit_revision):
            raise ValueError('Invalid entry edit revision')
        if base_edit_revision != edit_revision(data, existing):
            raise EntryConflictError(existing)
    elif (existing is not None and base_updated != existing.get('updated')) or (existing is None and base_updated is not None):
        raise EntryConflictError(existing)


def upsert_mobile_entry(data, date, title, body, tags=None, numbers=None,
                        mood=None, audio_transcript=None, base_updated=None,
                        now=None, document=None, base_edit_revision=None):
    """Validate and apply a versioned mobile entry edit.

    Explicit tag/number maps are the starting point. Inline ``@mention`` tags
    are added, while inline ``#numeric`` values fill only missing explicit
    numbers, matching the browser save semantics. A supplied editable revision
    must match current user content. Legacy requests use the overall timestamp.
    """
    existing = get_entry_by_date(data, date)
    _check_entry_base(data, existing, base_updated, base_edit_revision)

    if document is not None:
        document = journal_media.validate_document(document)
        body = journal_media.document_body(document)
    title = (title or "").strip() or suggest_entry_title(body) or date
    merged_tags = dict(tags or {})
    mentions = extract_mentions(body or "", tag_section_index(data))
    merged_tags = merge_entry_tags(merged_tags, mentions)
    merged_numbers = dict(numbers or {})
    for section_id, value in extract_numbers(
            body or "", numeric_section_index(data)).items():
        merged_numbers.setdefault(section_id, value)
    return upsert_entry(
        data, date, title, body, tags=merged_tags, numbers=merged_numbers,
        mood=mood, now=now, audio_transcript=audio_transcript, document=document)


def reconcile_photo_groups(data, media_data):
    """Create matching journal sections for groups explicitly shared in Settings."""
    existing = {s['name'].lower(): s for s in active_sections(data)}
    for group in media_data.get('groups', {}).values():
        if group.get('archived') or not group.get('share_entry'):
            continue
        name = _normalize_name(group['name'])
        if name in existing:
            if existing[name]['type'] != 'tag':
                raise ValueError('This name already belongs to a numeric section')
            continue
        if not _valid_name(name):
            raise ValueError('Shared entry groups use letters, numbers, spaces, dots, underscores, or dashes')
        existing[name] = add_section(data, name, 'tag', group.get('color') or '#e0a955')
    return data


def autosave_entry(data, date, payload, media_data, now=None):
    """Save a changed draft without committing unfinished inline task commands."""
    import copy
    existing = get_entry_by_date(data, date)
    _check_entry_base(data, existing, payload.get('base_updated'), payload.get('base_edit_revision'))
    document = payload.get("document")
    body = payload.get("body")
    title = payload.get("title")
    body = journal_media._text("" if body is None else body)
    title = journal_media._text("" if title is None else title)
    for key in ("tags", "numbers"):
        if payload.get(key) is not None and not isinstance(payload[key], dict):
            raise ValueError("Invalid " + key)
    if document is not None:
        document = journal_media.validate_document(document)
        body = journal_media.document_body(document)
        for block in document:
            if block["type"] == "photo" and block["asset_id"] not in media_data["assets"]:
                raise ValueError("A photo is still being transferred")
            if block.get("edited_asset_id") and block["edited_asset_id"] not in media_data["assets"]:
                raise ValueError("An edited photo is still being transferred")
            if block["type"] == "message" and block["message_id"] not in media_data["messages"]:
                raise ValueError("A message is still being imported")
    transcript = journal_media._text(payload.get("audio_transcript") or "")
    if existing is None and not (body.strip() or title.strip() or transcript.strip()
                                or payload.get("mood") or payload.get("tags")
                                or payload.get("numbers") or any(b["type"] != "text" for b in (document or []))):
        if not _valid_date(date):
            raise ValueError("Invalid date")
        return None
    manual_tags = payload.get("tags") or {}
    shared = journal_media.shared_tags(document or [], media_data, active_sections(data))
    manual_numbers = dict(payload.get("numbers") or {})
    if existing:
        for section in data.get("sections", []):
            if section.get("archived") or section.get("managed"):
                sid = section["id"]
                if sid in existing.get("tags", {}):
                    manual_tags = {**manual_tags, sid: existing["tags"][sid]}
                if sid in existing.get("numbers", {}):
                    manual_numbers[sid] = existing["numbers"][sid]
    before = copy.deepcopy(existing)
    entry = upsert_mobile_entry(data, date, payload.get("title"), body,
                                tags=merge_entry_tags(manual_tags, shared),
                                numbers=manual_numbers, mood=payload.get("mood"),
                                audio_transcript=payload.get("audio_transcript"),
                                base_updated=payload.get("base_updated"), document=document, now=now,
                                base_edit_revision=payload.get("base_edit_revision"))
    if before and all(before.get(k) == entry.get(k) for k in entry if k != "updated"):
        entry["updated"] = before["updated"]
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


def set_entry_usage(data, date, value, now=None):
    """Set (or clear, with value=None) the auto-filled phone-usage dict for
    `date`. Same get-or-create rule as set_entry_sleep."""
    if not _valid_date(date):
        raise ValueError(f"Invalid date: {date!r}")
    now = now or datetime.now()
    entry = get_entry_by_date(data, date)
    if entry is None:
        entry = upsert_entry(data, date, date, "", now=now)
    entry["usage"] = value
    entry["updated"] = now.isoformat()
    return entry


def set_entry_health(data, date, value, now=None):
    """Set (or clear, with value=None) the auto-filled health dict for `date`.

    Same get-or-create rule as set_entry_sleep."""
    if not _valid_date(date):
        raise ValueError(f"Invalid date: {date!r}")
    now = now or datetime.now()
    entry = get_entry_by_date(data, date)
    if entry is None:
        entry = upsert_entry(data, date, date, "", now=now)
    entry["health"] = value
    entry["updated"] = now.isoformat()
    return entry


def set_entry_music(data, date, value, now=None):
    """Set (or clear, with value=None) the auto-filled Spotify music dict for
    `date`. Same get-or-create rule as set_entry_sleep."""
    if not _valid_date(date):
        raise ValueError(f"Invalid date: {date!r}")
    now = now or datetime.now()
    entry = get_entry_by_date(data, date)
    if entry is None:
        entry = upsert_entry(data, date, date, "", now=now)
    if entry.get("music_history") and (value or {}).get("source") != "history_import":
        entry["music_live"] = value
    else:
        entry["music"] = value
    entry["updated"] = now.isoformat()
    return entry


def set_entry_number(data, date, section_id, value, now=None):
    """Set one numeric section's value on `date`, get-or-creating the entry.

    Mirrors `set_entry_sleep`'s get-or-create rule. `value` is validated the same
    way as `upsert_entry` (finite number, cast to float). **Idempotent**: if the
    stored value already equals the new value, `updated` is left untouched so
    repeated syncs don't churn the timestamp. Used by `apply_sleep_metrics` to
    write the API-managed sleep-metric sections.
    """
    if not _valid_date(date):
        raise ValueError(f"Invalid date: {date!r}")
    try:
        v = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"Invalid number for section {section_id!r}: {value!r}")
    if not math.isfinite(v):
        raise ValueError(f"Invalid number for section {section_id!r}: {value!r}")
    now = now or datetime.now()
    entry = get_entry_by_date(data, date)
    if entry is None:
        entry = upsert_entry(data, date, date, "", now=now)
    nums = entry.get("numbers")
    if not isinstance(nums, dict):
        nums = entry["numbers"] = {}
    if nums.get(section_id) == v:
        return entry  # unchanged -> no timestamp churn
    nums[section_id] = v
    entry["updated"] = now.isoformat()
    return entry


# --------------------------------------------------------------------------- #
# Google-Health sleep -> API-managed numeric sections (all pure)
# --------------------------------------------------------------------------- #

def _is_number(v):
    """True for a finite int/float (bools excluded)."""
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def sleep_metric_values(sleep):
    """Map a parsed sleep dict to {metric: number}, omitting unavailable values.

    - `sleep_duration` (hours, round(duration_min/60, 2)) only when `duration_min`
      is a positive number.
    - `sleep_quality` only when `quality` is a number.
    - each stage metric (deep/rem/light/awake) only when `stages` is a dict and
      that key holds a number (so classic/non-staged nights yield only duration +
      quality).

    A non-dict input yields {}. Pure."""
    if not isinstance(sleep, dict):
        return {}
    out = {}
    dur = sleep.get("duration_min")
    if _is_number(dur) and dur > 0:
        out["sleep_duration"] = round(dur / 60, 2)
    quality = sleep.get("quality")
    if _is_number(quality):
        out["sleep_quality"] = quality
    stages = sleep.get("stages")
    if isinstance(stages, dict):
        for stage_key, metric in _SLEEP_STAGE_METRICS.items():
            v = stages.get(stage_key)
            if _is_number(v):
                out[metric] = v
    return out


def _create_managed_sleep_section(data, spec):
    """Create the managed numeric section for one metric spec, handling a name
    collision with a pre-existing user section by differentiating the name."""
    base = spec["name"]
    for candidate in (base, f"{base} google"):
        try:
            return add_section(data, candidate, "numeric", spec["color"],
                               unit=spec["unit"],
                               managed=_GOOGLE_SLEEP_PROVIDER, metric=spec["metric"])
        except ValueError:
            continue  # name taken by an active section -> try the next candidate
    # Last resort: a short unique suffix so creation never crashes.
    suffix = uuid.uuid4().hex[:4]
    return add_section(data, f"{base} {suffix}", "numeric", spec["color"],
                       unit=spec["unit"],
                       managed=_GOOGLE_SLEEP_PROVIDER, metric=spec["metric"])


def ensure_sleep_sections(data, metrics):
    """Get-or-create the managed numeric section for each metric key.

    Returns {metric: section_id}. Reuses an existing section whose `metric`
    matches AND whose `managed` identifies Google sleep (searching ALL sections, archived
    included, so an archived managed section is reused rather than duplicated).
    Otherwise creates one via `_create_managed_sleep_section`. Idempotent;
    unknown metric keys are skipped. Pure."""
    spec_by_metric = {m["metric"]: m for m in _SLEEP_METRIC_SECTIONS}
    out = {}
    for metric in metrics:
        found = next((s for s in data.get("sections", [])
                      if s.get("metric") == metric and s.get("managed") == _GOOGLE_SLEEP_PROVIDER), None)
        if found is not None:
            out[metric] = found["id"]
            continue
        spec = spec_by_metric.get(metric)
        if spec is None:
            continue
        out[metric] = _create_managed_sleep_section(data, spec)["id"]
    return out


def apply_sleep_metrics(data, date, sleep, now=None):
    """Mirror a parsed sleep dict's numeric parts onto `date` as managed numeric
    sections. Creates sections lazily (only for available metrics), writes each
    value via `set_entry_number`, removes previously imported metrics that are
    unavailable in the refreshed result, and returns the {metric: value} it wrote (an
    empty dict when the sleep dict has no usable numbers). Idempotent. Pure."""
    values = sleep_metric_values(sleep)
    if not values:
        return {}
    entry = get_entry_by_date(data, date)
    if entry is not None:
        available_metrics = {spec['metric'] for spec in _SLEEP_METRIC_SECTIONS}
        for section in data.get('sections', []):
            if (section.get('managed') == _GOOGLE_SLEEP_PROVIDER
                    and section.get('metric') in available_metrics - values.keys()
                    and section['id'] in entry.get('numbers', {})):
                entry['numbers'].pop(section['id'])
                entry['updated'] = (now or datetime.now()).isoformat()
    ids = ensure_sleep_sections(data, values.keys())
    for metric, value in values.items():
        sid = ids.get(metric)
        if sid:
            set_entry_number(data, date, sid, value, now=now)
    return values


# --------------------------------------------------------------------------- #
# Rich entries: @mention tag lookup, extraction, and merge (all pure)
# --------------------------------------------------------------------------- #

# A mention token: '@' at a word boundary (start of string or a non-word char
# before it) followed by one or more name segments. Periods are accepted only
# between segments, so sentence punctuation is not swallowed. The leading
# boundary makes `a@b.com` not match (the char before '@' is a word char).
_MENTION_RE = re.compile(
    r"(?:^|(?<=\W))@([\w-]+(?:\.[\w-]+)*)"
)
_CAPTURE_TOKEN_RE = re.compile(
    r"(^|\W)(@[\w-]+(?:\.[\w-]+)*|#[\w-]+\s+-?\d+(?:\.\d+)?)"
)


def _capture_source(body):
    """Expose paired underline boundaries without changing literal token names.

    Mirrors journal-richtext.js: protect existing @/# tokens first, then
    treat underline delimiters as boundaries for extraction, never as data.
    """
    body = body or ""
    prefix = "\x00journal-token:"
    while prefix in body:
        prefix += ":"
    tokens = []

    def protect(match):
        tokens.append(match.group(2))
        return match.group(1) + prefix + str(len(tokens) - 1) + ";"

    source = _CAPTURE_TOKEN_RE.sub(protect, body)
    source = re.sub(r"__([^\n]+?)__", r" \1 ", source)
    return re.sub(re.escape(prefix) + r"(\d+);", lambda match: tokens[int(match.group(1))], source)


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
    followed by period-separated Unicode word/hyphen segments (so `a@b.com` does
    not match and trailing punctuation is excluded). Each token is
    resolved to a known tag name (underscores match spaces, so `@alex_dad`
    matches `alex dad`); unknown tokens are dropped. Resolved names are grouped
    by section id and deduped within a section, preserving first-seen order.
    """
    out = {}
    for raw in _MENTION_RE.findall(_capture_source(body)):
        n = _resolve_mention(raw, index)
        if n is None:
            continue
        sid = index[n]
        names = out.setdefault(sid, [])
        if n not in names:
            names.append(n)
    return out


# A numeric token: '#' at a word boundary (like _MENTION_RE) followed by a
# section-name (Unicode word characters/hyphens), whitespace, then a number. `a#b 1` does NOT
# match (the char before '#' is a word char). Mirrors @-mention grammar.
_NUMERIC_RE = re.compile(r"(?:^|(?<=\W))#([\w-]+)\s+(-?\d+(?:\.\d+)?)")


def numeric_section_index(data):
    """Build the #numeric lookup: {normalized_name: section_id}.

    Sibling of tag_section_index, but simpler: a numeric section has only a
    name (no tag list to overlay). Covers ACTIVE numeric sections only. Names
    are normalized (strip + lowercase).
    """
    index = {}
    for s in active_sections(data):
        if s.get("type") != "numeric":
            continue
        if s.get("managed"):
            continue  # API-fed sections aren't user-editable via inline capture
        n = _normalize_name(s.get("name"))
        if n:
            index[n] = s.get("id")
    return index


def extract_numbers(body, index):
    """Find #name value tokens in `body` that match a known numeric section.

    Returns {section_id: float}. A token is a '#' at a word boundary followed
    by Unicode word characters/hyphens, whitespace, and a number (so `a#b 1` does not match).
    Each name is resolved like a mention (as-is, then underscores -> spaces, so
    `#hours_slept` matches `hours slept`; a literal-underscore section wins when
    both exist); unknown names are dropped. The LAST occurrence per section wins
    (a correction reads naturally). Defensive: a value that fails float() is
    skipped.
    """
    out = {}
    for raw, value in _NUMERIC_RE.findall(_capture_source(body)):
        n = _resolve_mention(raw, index)
        if n is None:
            continue
        try:
            out[index[n]] = float(value)   # last write wins
        except (TypeError, ValueError):
            continue
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
# Inline [] task spawning (Spec 2): body parsing + rewrite (all pure)
# --------------------------------------------------------------------------- #

# A *fresh* task line: optional leading whitespace, an optional "- ", then
# `[]` or `[ ]`, whitespace, then the title. Multiline.
_TASK_FRESH_RE = re.compile(r"^[ \t]*(?:-[ \t]+)?\[[ ]?\][ \t]+(.+)$", re.M)
# A *linked* task line: same shape but `[task:<hexid>]` — never re-spawned.
_TASK_LINKED_RE = re.compile(
    r"^[ \t]*(?:-[ \t]+)?\[task:([0-9a-f]+)\][ \t]+(.+)$", re.M)
# An inline `>due` token: `>` (at line start or after whitespace) immediately
# followed by a non-space run, so prose `x > y` is unaffected.
_DUE_TOKEN_RE = re.compile(r"(?:^|\s)>(\S+)")


def extract_task_lines(body, mention_index, due_parser, now=None):
    """Ordered list of fresh `[]` task lines to spawn, in document order.

    Returns ``[{title, due, tags}]``:
      - title: the line text minus the marker and the first `>due` token,
        trimmed. `@mentions` are left verbatim.
      - due:   ``due_parser(token, now)`` for the first `>token` on the line,
        else None. An unparsed token is left in the title.
      - tags:  resolved `@mention` names on that line (deduped, in first-seen
        order), via ``mention_index`` ({normalized_name: section_id}).

    Lines whose title is empty after stripping the marker and `>due` token are
    skipped (so a bare ``[]`` or ``[] >friday`` spawns nothing). ``due_parser``
    is injected (``todo.parse_due_token``) so this stays unit-testable without
    importing the task date grammar. Walks fresh markers in the same order as
    ``rewrite_task_lines`` so the route can zip extracted lines -> new ids.
    """
    out = []
    for m in _TASK_FRESH_RE.finditer(body or ""):
        rest = m.group(1)

        # Pull the first >due token. Parse it for the `due` value; the token is
        # stripped from the title only when it parses (an unrecognized token
        # stays as plain text). For the *skip* decision a line that is ONLY a
        # >token (no real title text) is empty either way and is skipped — this
        # matches rewrite_task_lines, which has no parser.
        due = None
        title = rest
        dm = _DUE_TOKEN_RE.search(rest)
        if dm:
            parsed = due_parser(dm.group(1), now)
            without_token = (rest[:dm.start()] + rest[dm.end():])
            if parsed is not None:
                due = parsed
                title = without_token
            elif without_token.strip() == "":
                # Only a >token, and it didn't parse — nothing to spawn.
                continue
            # Collapse the gap the (possibly) removed token left behind.
            title = re.sub(r"[ \t]{2,}", " ", title)

        title = title.strip()
        if not title:
            continue

        # Resolve @mention tags on the line (mirror extract_mentions).
        tags = []
        for raw in _MENTION_RE.findall(_capture_source(rest)):
            n = _resolve_mention(raw, mention_index)
            if n is not None and n not in tags:
                tags.append(n)

        out.append({"title": title, "due": due, "tags": tags})
    return out


def linked_task_ids(body):
    """Set of task ids already linked in the body (`[task:<id>]`). Used for the
    task-ref index and idempotency assertions; ignores fresh `[]` lines."""
    return {m.group(1) for m in _TASK_LINKED_RE.finditer(body or "")}


def rewrite_task_lines(body, task_ids):
    """Replace each fresh `[]` marker, in document order, with `[task:<id>]`
    using the matching id from ``task_ids`` (same order/length as the
    non-skipped result of ``extract_task_lines``). Linked lines and skipped
    (empty-title) lines are left untouched. Returns the new body.

    Skipping logic mirrors ``extract_task_lines``: a fresh line whose title is
    empty after stripping the marker + a leading `>due` token consumes no id.
    """
    ids = list(task_ids or [])
    counter = {"i": 0}

    def repl(m):
        rest = m.group(1)
        # Mirror extract_task_lines' "is this spawnable?" decision: strip a
        # leading >due token only if it parses... but extract used a parser we
        # don't have here. We replicate the *skip* condition instead: a line is
        # skipped iff its title (after removing the FIRST >token, regardless of
        # whether it parsed) is empty. extract only strips the token when it
        # parses, but an empty-after-token title is empty either way, so this
        # matches for the skip decision.
        title = rest
        dm = _DUE_TOKEN_RE.search(rest)
        if dm:
            stripped = (rest[:dm.start()] + rest[dm.end():]).strip()
            if not stripped:
                title = ""
        if not title.strip():
            return m.group(0)  # skipped: leave the marker untouched
        if counter["i"] >= len(ids):
            return m.group(0)  # no id available: leave untouched
        tid = ids[counter["i"]]
        counter["i"] += 1
        if tid is None:
            return m.group(0)  # spawn failed for this line: leave [] untouched
        # Preserve the original marker prefix (leading ws + optional "- ").
        prefix = m.group(0)[:m.start(1) - m.start(0)]
        # Replace the bracket marker within the prefix with [task:<id>].
        prefix = re.sub(r"\[[ ]?\]", "[task:%s]" % tid, prefix, count=1)
        return prefix + rest

    return _TASK_FRESH_RE.sub(repl, body or "")


# --------------------------------------------------------------------------- #
# Calendar helpers
# --------------------------------------------------------------------------- #

def has_calendar_content(entry):
    """A calendar dot means text, tags, or an attached photo/message."""
    if not entry:
        return False
    title = (entry.get("title") or "").strip()
    return (
        bool(title and title != entry.get("date"))
        or any((entry.get(field) or "").strip() for field in ("body", "audio_transcript"))
        or any(name.strip() for names in (entry.get("tags") or {}).values() for name in names)
        or any(block.get("type") in ("photo", "message") for block in entry.get("document") or [])
    )


def calendar_dates(data):
    return sorted({entry["date"] for entry in data.get("entries", [])
                   if entry.get("date") and has_calendar_content(entry)})


def stored_entry_dates(data):
    """Every occupied date, including records without a calendar dot."""
    return sorted({entry["date"] for entry in data.get("entries", []) if entry.get("date")})


def entry_dates(data):
    """Sorted dates with user-recorded content, excluding imported placeholders."""
    managed_ids = {s["id"] for s in data.get("sections", []) if s.get("managed")}
    def has_content(entry):
        # Integration syncs and blank saves can create date-titled placeholders.
        title = (entry.get("title") or "").strip()
        return (
            bool(title and title != entry.get("date"))
            or any((entry.get(field) or "").strip()
                   for field in ("body", "audio_transcript"))
            or entry.get("mood") is not None
            or any(b.get("type") in ("photo", "message") for b in entry.get("document") or [])
            or any(entry.get("tags", {}).values())
            or any(value is not None and sid not in managed_ids
                   for sid, value in entry.get("numbers", {}).items())
        )

    return sorted(e["date"] for e in data.get("entries", [])
                  if e.get("date") and has_content(e))


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
        if not (s.get("start") and s.get("end")):
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
    clock_rows = [s for s in rows if s.get("start") and s.get("end")]
    beds = []
    for s in clock_rows:
        b = _clock_to_min(s["start"])
        beds.append(b - 1440 if b >= 12 * 60 else b)
    wakes = [_clock_to_min(s["end"]) for s in clock_rows]
    return {
        "avg_hours": round(sum(hours) / len(hours), 2),
        "avg_quality": round(sum(quals) / len(quals), 1) if quals else None,
        "avg_bedtime": _min_to_clock(sum(beds) / len(beds)) if beds else None,
        "avg_waketime": _min_to_clock(sum(wakes) / len(wakes)) if wakes else None,
        "nights": len(rows),
    }


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
                        "neutral_min": r.get("neutral_min", 0),
                        "unrated_min": r.get("unrated_min", 0)})
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


def rescuetime_top_activities(entries, start=None, end=None, cap=8):
    """Aggregate per-activity (website/application) minutes across the range.

    Rows are ``{name, min, category, productivity}`` sorted by total minutes
    desc, capped at ``cap``. ``category``/``productivity`` are taken from each
    activity's first occurrence. Reads the ``top_activities`` list added to
    ``entry["rescuetime"]`` by the sync (absent on days synced before the
    website-breakdown feature; those simply contribute nothing).
    """
    totals, meta = {}, {}
    for e in _filter_entries_by_date(entries, start, end):
        r = _entry_rescuetime(e)
        if not r:
            continue
        for a in r.get("top_activities") or []:
            name = a.get("name")
            if not name:
                continue
            totals[name] = totals.get(name, 0) + (a.get("min") or 0)
            if name not in meta:
                meta[name] = {"category": a.get("category"),
                              "productivity": a.get("productivity")}
    rows = [{"name": k, "min": v,
             "category": meta[k]["category"],
             "productivity": meta[k]["productivity"]}
            for k, v in totals.items()]
    rows.sort(key=lambda a: a["min"], reverse=True)
    return rows if cap is None else rows[:max(0, cap)]


def rescuetime_hourly_totals(rows):
    """Reported hourly time, not inferred exact sessions. Mirror rtHourlyTotals in JS."""
    hours = [{"hour": hour, "productive_min": 0, "neutral_min": 0,
              "distracting_min": 0, "unrated_min": 0, "total_min": 0} for hour in range(24)]
    for row in rows:
        hour, minutes = row.get("hour"), row.get("min")
        if type(hour) is not int or not 0 <= hour < 24 or type(minutes) not in (int, float) or not math.isfinite(minutes) or minutes <= 0:
            continue
        score = row.get("productivity")
        field = "unrated_min" if type(score) not in (int, float) or score not in (-2, -1, 0, 1, 2) else "productive_min" if score > 0 else "distracting_min" if score < 0 else "neutral_min"
        hours[hour][field] += minutes
        hours[hour]["total_min"] += minutes
    return hours


def rescuetime_activity_minutes_series(entries, start=None, end=None, top_n=6):
    """Per-day minutes for the top-``top_n`` activities (by total minutes).

    Shape (for a stacked/multi-line chart)::

        {"activities": [{"name"}],      # top-N activities, most minutes first
         "dates": ["YYYY-MM-DD", ...],  # sorted dates of usable entries
         "series": {name: [minutes-per-date...]}}  # zero-filled, aligned to dates
    """
    top = rescuetime_top_activities(entries, start, end)[:max(0, top_n)]
    acts = [{"name": a["name"]} for a in top]
    keep = {a["name"] for a in acts}
    by_date = {}
    for e in _filter_entries_by_date(entries, start, end):
        r = _entry_rescuetime(e)
        if not r:
            continue
        day = by_date.setdefault(e.get("date"), {})
        for a in r.get("top_activities") or []:
            name = a.get("name")
            if name in keep:
                day[name] = day.get(name, 0) + (a.get("min") or 0)
    dates = sorted(by_date)
    series = {a["name"]: [by_date[d].get(a["name"], 0) for d in dates] for a in acts}
    return {"activities": acts, "dates": dates, "series": series}


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


_SECRET_KEYS = {
    "access_token", "refresh_token", "client_secret", "api_key", "authorization",
    "password", "token",
}


def _sanitized_dict(value):
    if isinstance(value, dict):
        return {
            k: _sanitized_dict(v)
            for k, v in value.items()
            if str(k).lower() not in _SECRET_KEYS
        }
    if isinstance(value, list):
        return [_sanitized_dict(v) for v in value]
    return value


def _music_plays(m):
    for key in ("plays", "imported_plays", "history", "streaming_history"):
        plays = m.get(key)
        if isinstance(plays, dict):
            return list(plays.values())
        if isinstance(plays, list):
            return plays
    return []


def _music_has_meaningful_data(m):
    for key in ("tracks", "minutes", "distinct"):
        if m.get(key):
            return True
    for key in ("top_artists", "top_tracks", "top_albums", "contexts"):
        if m.get(key):
            return True
    return bool(_music_plays(m))


def _entry_music(entry):
    m = entry.get("music")
    if isinstance(m, dict) and _music_has_meaningful_data(m):
        return _sanitized_dict(m)
    return None


def _music_minutes(m):
    plays = _music_plays(m)
    if m.get("minutes") or not plays:
        return m.get("minutes") or 0
    if plays:
        total_ms = sum(
            _music_play_duration_ms(p) for p in plays if isinstance(p, dict)
        )
        return round(total_ms / 60000)
    return 0


def _music_track_count(m):
    plays = _music_plays(m)
    if m.get("tracks") or not plays:
        return m.get("tracks") or 0
    if plays:
        return len(plays)
    return 0


def _music_distinct_tracks(m):
    plays = _music_plays(m)
    if m.get("distinct") or not plays:
        return m.get("distinct") or 0
    if plays:
        seen = set()
        for p in plays:
            if not isinstance(p, dict):
                continue
            ident = (p.get("track_id") or p.get("id") or p.get("spotify_track_uri")
                     or p.get("name") or p.get("master_metadata_track_name"))
            if ident:
                seen.add(ident)
        return len(seen)
    return 0


def _music_is_imported(m):
    source = str(m.get("source") or "").lower()
    sources = " ".join(str(s).lower() for s in (m.get("sources") or []))
    return bool(m.get("imported") or "import" in source or "import" in sources
                or m.get("imported_plays")
                or m.get("history") or m.get("streaming_history"))


def _music_source(m):
    sources = [str(s) for s in (m.get("sources") or []) if s]
    if sources:
        return " + ".join(sources)
    return m.get("source") or ("imported" if _music_is_imported(m) else "unknown")


def _music_artist_name(row):
    artists = row.get("artists")
    if isinstance(artists, list):
        return ", ".join(a for a in artists if a)
    return (row.get("artist") or row.get("album_artist")
            or row.get("master_metadata_album_artist_name"))


def _music_play_duration_ms(row):
    return row.get("duration_ms") or row.get("ms_played") or 0


def _music_named_totals(entries, key, start=None, end=None, cap=10):
    totals, meta = {}, {}
    for e in _filter_entries_by_date(entries, start, end):
        m = _entry_music(e)
        if not m:
            continue
        rows = m.get(key)
        if not rows and key in {"top_tracks", "top_albums"}:
            rows = _music_plays(m)
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, dict):
                continue
            if key == "top_albums":
                name = (row.get("name") or row.get("album")
                        or row.get("master_metadata_album_album_name"))
            else:
                name = (row.get("name") or row.get("track") or row.get("title")
                        or row.get("master_metadata_track_name"))
            if not name:
                continue
            artist = _music_artist_name(row)
            ident = (name, artist)
            totals[ident] = totals.get(ident, 0) + (row.get("count") or 1)
            if ident not in meta:
                meta[ident] = {"name": name, "artist": artist}
    out = [{"name": v["name"], "artist": v["artist"], "count": totals[k]}
           for k, v in meta.items()]
    out.sort(key=lambda d: d["count"], reverse=True)
    return out[:cap]


def _entry_usage(entry):
    u = entry.get("usage")
    if isinstance(u, dict) and (u.get("screen_min") or u.get("top_apps")):
        return u
    return None


def _entry_health(entry):
    h = entry.get("health")
    if isinstance(h, dict) and (h.get("steps") or h.get("avg_hr") or h.get("heart_rate_samples")):
        return h
    return None


def music_minutes_series(entries, start=None, end=None):
    out = []
    for e in _filter_entries_by_date(entries, start, end):
        m = _entry_music(e)
        if m:
            out.append({"date": e["date"], "minutes": _music_minutes(m)})
    out.sort(key=lambda d: d["date"])
    return out


def music_tracks_series(entries, start=None, end=None):
    out = []
    for e in _filter_entries_by_date(entries, start, end):
        m = _entry_music(e)
        if m:
            out.append({"date": e["date"], "tracks": _music_track_count(m)})
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


def music_top_tracks(entries, start=None, end=None):
    return _music_named_totals(entries, "top_tracks", start, end)


def music_top_albums(entries, start=None, end=None):
    rows = _music_named_totals(entries, "top_albums", start, end)
    return rows


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


def music_mood_minutes_pairs(entries, start=None, end=None):
    out = []
    for e in _filter_entries_by_date(entries, start, end):
        m = _entry_music(e)
        mood = _entry_mood(e)
        if m and mood is not None:
            out.append({"minutes": _music_minutes(m), "mood": mood})
    return out


def music_mood_tracks_pairs(entries, start=None, end=None):
    out = []
    for e in _filter_entries_by_date(entries, start, end):
        m = _entry_music(e)
        mood = _entry_mood(e)
        if m and mood is not None:
            out.append({"tracks": _music_track_count(m), "mood": mood})
    return out


def music_listening_contexts(entries, start=None, end=None):
    totals = {}
    for e in _filter_entries_by_date(entries, start, end):
        m = _entry_music(e)
        if not m:
            continue
        for c in m.get("contexts") or []:
            if not isinstance(c, dict):
                continue
            name = c.get("name") or c.get("context")
            if not name:
                continue
            row = totals.setdefault(name, {"name": name, "minutes": 0, "count": 0})
            row["minutes"] += c.get("minutes") or 0
            row["count"] += c.get("count") or 1
    out = list(totals.values())
    out.sort(key=lambda d: (d["minutes"], d["count"]), reverse=True)
    return out


def music_source_stats(entries, start=None, end=None):
    rows = [_entry_music(e) for e in _filter_entries_by_date(entries, start, end)]
    rows = [m for m in rows if m]
    sources = {}
    imported_days = 0
    for m in rows:
        source = _music_source(m)
        sources[source] = sources.get(source, 0) + 1
        if _music_is_imported(m):
            imported_days += 1
    return {"days": len(rows), "imported_days": imported_days, "sources": sources}


def music_stats(entries, start=None, end=None):
    rows = [_entry_music(e) for e in _filter_entries_by_date(entries, start, end)]
    rows = [m for m in rows if m]
    if not rows:
        return {"avg_minutes": None, "total_tracks": 0, "days": 0,
                "total_minutes": 0, "avg_tracks": None, "distinct_tracks": 0,
                "imported_days": 0, "sources": {}}
    mins = [_music_minutes(m) for m in rows]
    track_counts = [_music_track_count(m) for m in rows]
    sources = {}
    imported_days = 0
    for m in rows:
        source = _music_source(m)
        sources[source] = sources.get(source, 0) + 1
        if _music_is_imported(m):
            imported_days += 1
    return {"avg_minutes": round(sum(mins) / len(mins)),
            "total_tracks": sum(track_counts),
            "days": len(rows),
            "total_minutes": sum(mins),
            "avg_tracks": round(sum(track_counts) / len(track_counts), 1),
            "distinct_tracks": sum(_music_distinct_tracks(m) for m in rows),
            "imported_days": imported_days,
            "sources": sources}


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
    # Unicode alphanumeric boundaries; underscores remain delimiters, matching
    # the existing word-suggestion tokenizer's ASCII behavior.
    return re.compile(r"(?<![^\W_])" + re.escape(word.lower()) + r"(?![^\W_])",
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


# --------------------------------------------------------------------------- #
# Leading-indicators analytics: lagged cross-domain correlations / uplift.
# "What predicts tomorrow's mood?" — correlate a predictor on day D against the
# target (mood) on day D+lag. All pure, injectable date bounds. Mirrors the
# same-day Overview drivers board, shifted by `lag`. See the Spec-3 design doc.
# --------------------------------------------------------------------------- #

def _shift_date(d, days):
    """A YYYY-MM-DD date string shifted by `days` (may be negative)."""
    return (datetime.strptime(d, "%Y-%m-%d").date()
            + timedelta(days=days)).isoformat()


def _predictor_by_date(entries, predictor, start, end):
    """{date: float} for a continuous predictor over date-filtered entries that
    carry a usable value. `predictor` is a (kind, key) descriptor:

        ("numeric", sid)        -> entry["numbers"][sid]
        ("sleep", "hours")      -> _entry_sleep(e)["duration_min"] / 60
        ("sleep", "quality")    -> _entry_sleep(e)["quality"]
        ("rescuetime", field)   -> _entry_rescuetime(e)[field]   (pulse/productive_min)
        ("music", "minutes")    -> _entry_music(e)["minutes"]
        ("music", "valence")    -> _entry_music(e)["valence"]    (None when 403)

    None/absent values are skipped so callers get only usable days."""
    kind, key = predictor
    out = {}
    for e in _filter_entries_by_date(entries, start, end):
        date = e.get("date")
        if not date:
            continue
        val = None
        if kind == "numeric":
            nums = e.get("numbers") or {}
            if key in nums and nums[key] is not None:
                val = float(nums[key])
        elif kind == "sleep":
            s = _entry_sleep(e)
            if s:
                if key == "hours":
                    val = s["duration_min"] / 60
                elif s.get(key) is not None:
                    val = s[key]
        elif kind == "rescuetime":
            r = _entry_rescuetime(e)
            if r and r.get(key) is not None:
                val = r[key]
        elif kind == "music":
            m = _entry_music(e)
            if m and m.get(key) is not None:
                val = m[key]
        if val is not None:
            out[date] = val
    return out


def lagged_pairs(pred_by_date, target_by_date, lag):
    """[(x, y)] where x = pred_by_date[D] and y = target_by_date[D+lag], for
    every date D present in both after the shift. lag=0 is same-day pairing."""
    out = []
    for d, x in pred_by_date.items():
        y = target_by_date.get(_shift_date(d, lag))
        if y is not None:
            out.append((x, y))
    return out


def _target_by_date(entries, target, start, end):
    """{date: value} for the target stream. Only mood is supported today; the
    signature keeps `target` so a future target (e.g. pulse) slots in."""
    if target == "mood":
        return mood_by_date(entries, start, end)
    # Continuous target descriptors reuse the predictor machinery.
    if isinstance(target, (tuple, list)):
        return _predictor_by_date(entries, tuple(target), start, end)
    return {}


def lagged_correlation(entries, predictor, target="mood", lag=1,
                       start=None, end=None):
    """{r, n} for one continuous predictor at `lag`. `r` is the Pearson r over
    the lagged (predictor[D], target[D+lag]) pairs, or None (n < 2 / zero
    variance); `n` is the pair count."""
    pred = _predictor_by_date(entries, predictor, start, end)
    tgt = _target_by_date(entries, target, start, end)
    pairs = lagged_pairs(pred, tgt, lag)
    xs = [p[0] for p in pairs]
    ys = [p[1] for p in pairs]
    return {"r": _pearson(xs, ys), "n": len(pairs)}


def lagged_tag_uplift(entries, target="mood", lag=1, start=None, end=None,
                      min_n=2):
    """[{name, section_id, after_mean, baseline, uplift, n}] per tag — the mean
    target on days AFTER a tag appears vs the baseline mean over all in-range
    target days. Lagged sibling of `mood_tag_uplift`; sorted by |uplift| desc,
    then name. Only tags with `n >= min_n` after-days are kept."""
    scoped = _filter_entries_by_date(entries, start, end)
    tgt = _target_by_date(entries, target, start, end)
    baseline_vals = list(tgt.values())
    if not baseline_vals:
        return []
    baseline = sum(baseline_vals) / len(baseline_vals)

    by_tag = {}  # (name, section_id) -> [after-values]
    for e in scoped:
        date = e.get("date")
        if not date:
            continue
        after = tgt.get(_shift_date(date, lag))
        if after is None:
            continue
        for sid, names in (e.get("tags") or {}).items():
            for raw in set(_normalize_name(n) for n in names or [] if n):
                by_tag.setdefault((raw, sid), []).append(after)

    out = []
    for (name, sid), vals in by_tag.items():
        if len(vals) < min_n:
            continue
        after_mean = sum(vals) / len(vals)
        out.append({
            "name": name,
            "section_id": sid,
            "after_mean": after_mean,
            "baseline": baseline,
            "uplift": after_mean - baseline,
            "n": len(vals),
        })
    out.sort(key=lambda r: (-abs(r["uplift"]), r["name"]))
    return out


def _hard_task_dates(tasks):
    """Set of YYYY-MM-DD dates on which a `hard` task was completed. `tasks` is
    the merged task payload (or raw store) — reads its `archive` bucket."""
    out = set()
    for t in (tasks or {}).get("archive", []):
        diff = (t.get("difficulty") or "").strip().lower()
        if diff == "hard" and t.get("completed"):
            out.add(t["completed"][:10])
    return out


def lagged_difficulty_effect(entries, tasks, target="mood", lag=1,
                             start=None, end=None, min_n=2):
    """{after_mean, baseline, uplift, n} — the mean target the day AFTER a hard
    task was completed vs the baseline over all in-range target days. Returns
    None when fewer than `min_n` after-days qualify. Task completion dates come
    from the merged task payload (`tasks["archive"]`)."""
    tgt = _target_by_date(entries, target, start, end)
    baseline_vals = list(tgt.values())
    if not baseline_vals:
        return None
    baseline = sum(baseline_vals) / len(baseline_vals)
    hard_dates = _hard_task_dates(tasks)
    after = []
    for d in hard_dates:
        v = tgt.get(_shift_date(d, lag))
        if v is not None:
            after.append(v)
    if len(after) < min_n:
        return None
    after_mean = sum(after) / len(after)
    return {"after_mean": after_mean, "baseline": baseline,
            "uplift": after_mean - baseline, "n": len(after)}


# Human labels + origin kinds for the continuous predictor descriptors.
_CONT_PREDICTOR_LABELS = {
    ("sleep", "hours"): ("Sleep duration", "sleep"),
    ("sleep", "quality"): ("Sleep quality", "sleep"),
    ("rescuetime", "pulse"): ("Productivity pulse", "rescuetime"),
    ("rescuetime", "productive_min"): ("Productive minutes", "rescuetime"),
    ("music", "minutes"): ("Music minutes", "music"),
    ("music", "valence"): ("Music valence", "music"),
}


def _available_continuous_predictors(entries, start, end):
    """[(predictor, label, kind, key)] for every continuous stream that has at
    least one usable value in range. Numeric predictors are derived from the
    section ids that appear in entry `numbers`."""
    out = []
    # Numeric sections (by id) present in range.
    seen_num = set()
    for e in _filter_entries_by_date(entries, start, end):
        for sid, v in (e.get("numbers") or {}).items():
            if v is not None:
                seen_num.add(sid)
    for sid in sorted(seen_num):
        out.append((("numeric", sid), None, "numeric", sid))
    # Fixed continuous streams (sleep/rescuetime/music) when present.
    for pred, (label, kind) in _CONT_PREDICTOR_LABELS.items():
        if _predictor_by_date(entries, pred, start, end):
            out.append((pred, label, kind, pred[1]))
    return out


def leading_indicators(entries, target="mood", lag=1, start=None, end=None,
                       min_n=5, tasks=None):
    """Ranked [{label, kind, key, r|uplift, n, direction}] merging continuous
    (lagged Pearson over every available predictor) and categorical (lagged tag
    uplift + hard-task difficulty effect) leading indicators for `target` at
    `lag`. Rows below `min_n` lagged pairs/after-days are dropped. Sorted by
    normalized effect magnitude desc (|r| for continuous; |uplift|/6 for the
    1..7 mood scale). `kind` is one of numeric/sleep/rescuetime/music/tag/
    difficulty (for the client's origin marks). `direction` is "+"/"-"."""
    rows = []

    # Continuous predictors.
    for pred, label, kind, key in _available_continuous_predictors(
            entries, start, end):
        res = lagged_correlation(entries, pred, target=target, lag=lag,
                                 start=start, end=end)
        if res["r"] is None or res["n"] < min_n:
            continue
        rows.append({
            "label": label if label is not None else key,
            "kind": kind,
            "key": key,
            "r": res["r"],
            "n": res["n"],
            "direction": "+" if res["r"] >= 0 else "-",
            "_mag": abs(res["r"]),
        })

    # Categorical: tag presence.
    for u in lagged_tag_uplift(entries, target=target, lag=lag,
                               start=start, end=end, min_n=min_n):
        rows.append({
            "label": u["name"],
            "kind": "tag",
            "key": u["name"],
            "section_id": u["section_id"],
            "uplift": u["uplift"],
            "n": u["n"],
            "direction": "+" if u["uplift"] >= 0 else "-",
            "_mag": abs(u["uplift"]) / 6.0,
        })

    # Categorical: hard-task difficulty effect.
    de = lagged_difficulty_effect(entries, tasks, target=target, lag=lag,
                                  start=start, end=end, min_n=min_n)
    if de is not None:
        rows.append({
            "label": "Hard task done",
            "kind": "difficulty",
            "key": "hard",
            "uplift": de["uplift"],
            "n": de["n"],
            "direction": "+" if de["uplift"] >= 0 else "-",
            "_mag": abs(de["uplift"]) / 6.0,
        })

    rows.sort(key=lambda r: -r["_mag"])
    for r in rows:
        r.pop("_mag", None)
    return rows


def lag_profile(entries, predictor, target="mood", lags=(0, 1, 2, 3),
                start=None, end=None):
    """[{lag, r, n}] for one predictor across `lags` — powers the lag-profile
    chart. Accepts a continuous predictor descriptor (tuple) OR a categorical
    key: ("tag", name, section_id) or ("difficulty",) — for those the row's
    `r` carries the signed uplift magnitude in place of a correlation."""
    out = []
    is_cont = isinstance(predictor, (tuple, list)) and predictor[0] in (
        "numeric", "sleep", "rescuetime", "music")
    for lag in lags:
        if is_cont:
            res = lagged_correlation(entries, tuple(predictor), target=target,
                                     lag=lag, start=start, end=end)
            out.append({"lag": lag, "r": res["r"], "n": res["n"]})
        elif predictor and predictor[0] == "tag":
            name = _normalize_name(predictor[1])
            match = [u for u in lagged_tag_uplift(
                entries, target=target, lag=lag, start=start, end=end, min_n=1)
                if u["name"] == name]
            if match:
                out.append({"lag": lag, "r": match[0]["uplift"],
                            "n": match[0]["n"]})
            else:
                out.append({"lag": lag, "r": None, "n": 0})
        elif predictor and predictor[0] == "difficulty":
            de = lagged_difficulty_effect(entries, predictor[1] if len(predictor) > 1
                                          else None, target=target, lag=lag,
                                          start=start, end=end, min_n=1)
            out.append({"lag": lag,
                        "r": de["uplift"] if de else None,
                        "n": de["n"] if de else 0})
        else:
            out.append({"lag": lag, "r": None, "n": 0})
    return out


def analytics_date_range(journal_range, task_range, tracking_days=()):
    """Default dashboard bounds include every usable domain, including tracking.

    Empty receipts also represent unreadable days, so they cannot establish a
    recorded date. The client applies any explicit date selection separately.
    """
    dates = [value for bounds in (journal_range, task_range)
             for value in (bounds.get("min"), bounds.get("max"))
             if _valid_date(value)]
    dates.extend(day["date"] for day in tracking_days
                 if type(day.get("count")) is int and day["count"] > 0
                 and _valid_date(day.get("date")))
    return {"min": min(dates) if dates else None, "max": max(dates) if dates else None}


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
            "chart_opts": dict(s.get("chart_opts") or {}),
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
            "document": e.get("document"),
            "mood": _entry_mood(e),
            "sleep": _entry_sleep(e),
            "rescuetime": _entry_rescuetime(e),
            "music": _entry_music(e),
            "usage": _entry_usage(e),
            "health": _entry_health(e),
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
