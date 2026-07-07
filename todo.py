"""Core to-do logic.

Pure, testable functions that operate on a plain data dict of the shape:

    {"active": [...], "archive": [...], "expired": [...]}

There are NO Flask imports here on purpose -- this module is the brain and
can be unit-tested without spinning up a web server.

Date assumption: all dates are naive local time (no timezone info). We use
datetime.now() as the reference clock, and ISO 8601 strings for storage.
"""

import json
import os
import re
import uuid
from datetime import datetime, timedelta


def _empty():
    """A fresh, empty store."""
    # "tags" is the tag registry: a dict mapping tag name -> hex color.
    return {"active": [], "archive": [], "expired": [], "tags": {}}


# Neutral grey used for any tag that somehow isn't in the registry.
DEFAULT_TAG_COLOR = "#8a8f99"

# A valid hex color: #rgb or #rrggbb (case-insensitive).
_HEX_COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")

# Allowlist for tag names (after they've been stripped + lowercased). Only
# lowercase letters, digits, spaces, underscores and hyphens are allowed. This
# makes the "tag names can never carry HTML/JS/CSS" invariant explicit instead
# of relying solely on Jinja auto-escaping downstream.
_TAG_NAME_RE = re.compile(r"^[a-z0-9 _-]+$")


# Recurrence values we accept. "every:N" (N a positive int) is handled
# separately since N varies.
_FIXED_RECURRENCES = {"daily", "weekly", "monthly"}


# Allowed task difficulty ratings (set at completion, editable on Archive).
_DIFFICULTIES = {"easy", "medium", "hard"}


def _norm_difficulty(value):
    """Normalize a difficulty to one of _DIFFICULTIES, or None if invalid/empty."""
    v = (value or "").strip().lower()
    return v if v in _DIFFICULTIES else None


def set_difficulty(data, task_id, difficulty):
    """Set or clear a task's difficulty (searches all buckets). A valid value
    (easy/medium/hard) sets it; anything else clears it. Unknown id = no-op."""
    norm = _norm_difficulty(difficulty)
    for bucket in ("archive", "active", "expired"):
        for t in data.get(bucket, []):
            if t.get("id") == task_id:
                if norm:
                    t["difficulty"] = norm
                else:
                    t.pop("difficulty", None)
                return data
    return data


# --------------------------------------------------------------------------- #
# Task notes + subtasks (active bucket only; subtasks addressed by list index)
# --------------------------------------------------------------------------- #

def _active_task(data, task_id):
    """Return the active task with `task_id`, or None. Helper for the
    notes/subtask mutators -- these operate on the active bucket only."""
    for t in data.get("active", []):
        if t.get("id") == task_id:
            return t
    return None


def set_task_notes(data, task_id, text):
    """Set an active task's `notes` to the stripped `text` (may be ""). An empty
    string clears the notes. Unknown id = no-op. Returns `data`."""
    task = _active_task(data, task_id)
    if task is not None:
        task["notes"] = (text or "").strip()
    return data


def add_subtask(data, task_id, text):
    """Append {"text": <stripped>, "done": False} to an active task's subtasks.
    Raises ValueError on empty/whitespace text. Unknown id = no-op. Returns
    `data`."""
    text = (text or "").strip()
    if not text:
        raise ValueError("Subtask text must not be empty")
    task = _active_task(data, task_id)
    if task is not None:
        task.setdefault("subtasks", []).append({"text": text, "done": False})
    return data


def toggle_subtask(data, task_id, index):
    """Flip the `done` flag of the subtask at `index` on an active task.
    Out-of-range index or unknown id = no-op. Returns `data`."""
    task = _active_task(data, task_id)
    if task is not None:
        subs = task.get("subtasks") or []
        if 0 <= index < len(subs):
            subs[index]["done"] = not subs[index].get("done", False)
    return data


def edit_subtask(data, task_id, index, text):
    """Replace the text of the subtask at `index` with the stripped `text`.
    Raises ValueError on empty text. Out-of-range index or unknown id = no-op.
    Returns `data`."""
    text = (text or "").strip()
    if not text:
        raise ValueError("Subtask text must not be empty")
    task = _active_task(data, task_id)
    if task is not None:
        subs = task.get("subtasks") or []
        if 0 <= index < len(subs):
            subs[index]["text"] = text
    return data


def delete_subtask(data, task_id, index):
    """Remove the subtask at `index` from an active task. Out-of-range index or
    unknown id = no-op. Returns `data`."""
    task = _active_task(data, task_id)
    if task is not None:
        subs = task.get("subtasks") or []
        if 0 <= index < len(subs):
            del subs[index]
    return data


def reorder_subtask(data, task_id, from_index, to_index):
    """Move the subtask at `from_index` to `to_index` on an active task, shifting
    the others. Out-of-range index (either), unknown id, or from==to = no-op.
    Returns `data`."""
    task = _active_task(data, task_id)
    if task is not None:
        subs = task.get("subtasks") or []
        if (0 <= from_index < len(subs) and 0 <= to_index < len(subs)
                and from_index != to_index):
            sub = subs.pop(from_index)
            subs.insert(to_index, sub)
    return data


def _valid_recurrence(recurrence):
    """True if `recurrence` is a recognized recurrence value (or None)."""
    if recurrence is None:
        return True
    if recurrence in _FIXED_RECURRENCES:
        return True
    # Custom interval: "every:N" with N a positive integer.
    if isinstance(recurrence, str) and recurrence.startswith("every:"):
        try:
            return int(recurrence.split(":", 1)[1]) > 0
        except ValueError:
            return False
    return False


# --------------------------------------------------------------------------- #
# Tags
# --------------------------------------------------------------------------- #

def _normalize_tags(tags):
    """Normalize a list of tag names: strip whitespace, lowercase, drop
    blanks, and de-duplicate while preserving first-seen order.
    """
    out = []
    for raw in tags or []:
        # Tolerate a hand-edited JSON file that put non-strings in the list
        # (e.g. "tags": [1, null]) -- just skip anything that isn't a string.
        if not isinstance(raw, str):
            continue
        name = raw.strip().lower()
        if name and name not in out:
            out.append(name)
    return out


def set_tag_color(data, name, color):
    """Create or update a tag's color in the registry.

    The tag name is normalized for consistency: stripped of surrounding
    whitespace and lowercased (so "Work", "work " and "WORK" are one tag). It
    must then match the allowlist `^[a-z0-9 _-]+$` -- this rejects HTML/JS/CSS
    metacharacters (<, >, ;, {, quotes, &, ...) so a tag name can never carry
    an injection payload, independent of template escaping.
    `color` must be a valid hex string -- #rgb or #rrggbb. Raises ValueError
    on an empty/disallowed name or an invalid color. Returns `data`.
    """
    name = (name or "").strip().lower()
    if not name:
        raise ValueError("Tag name must not be empty")
    if not _TAG_NAME_RE.match(name):
        raise ValueError(f"Invalid tag name: {name!r}")
    if not isinstance(color, str) or not _HEX_COLOR_RE.match(color):
        raise ValueError(f"Invalid hex color: {color!r}")
    data.setdefault("tags", {})[name] = color
    return data


def tag_color(data, name):
    """Return the registered hex color for `name`, or a neutral grey default
    if the tag isn't in the registry.
    """
    name = (name or "").strip().lower()
    return data.get("tags", {}).get(name, DEFAULT_TAG_COLOR)


def delete_tag(data, name):
    """Remove a tag everywhere it appears.

    The name is normalized (stripped + lowercased, same as elsewhere). The tag
    is removed from the `data["tags"]` registry AND from the `tags` list of
    every task across the `active`, `archive` and `expired` lists. A name that
    isn't registered is a safe no-op. Returns `data`.
    """
    name = (name or "").strip().lower()
    # Drop it from the registry (pop with a default = no KeyError if absent).
    data.get("tags", {}).pop(name, None)
    # Scrub it from every task's own tag list, in all three buckets.
    for bucket in ("active", "archive", "expired"):
        for task in data.get(bucket, []):
            tags = task.get("tags")
            if isinstance(tags, list) and name in tags:
                task["tags"] = [t for t in tags if t != name]
    return data


def filter_by_tags(tasks, selected_tags):
    """Return tasks that have AT LEAST ONE of `selected_tags` (OR / union
    semantics). If `selected_tags` is empty, all tasks are returned unchanged.
    A task with no tags is excluded whenever a filter is active.
    """
    selected = set(_normalize_tags(selected_tags))
    if not selected:
        return tasks
    return [t for t in tasks if selected & set(t.get("tags") or [])]


def _srgb_to_linear(channel):
    """Gamma-expand one sRGB channel (0..1) to linear light, per WCAG."""
    return channel / 12.92 if channel <= 0.03928 else ((channel + 0.055) / 1.055) ** 2.4


def text_color_for(bg_hex):
    """Return "#000000" or "#ffffff" -- whichever stays readable on the given
    background color -- using WCAG relative luminance.

    Accepts #rgb or #rrggbb. We gamma-expand the sRGB channels to linear light
    first (a plain weighted average of the raw channels overstates how bright a
    color looks), then compare the relative luminance against ~0.179 -- the
    crossover where black vs white text give equal WCAG contrast. Brighter than
    that gets black text; darker gets white.
    """
    h = bg_hex.lstrip("#")
    if len(h) == 3:                      # expand #rgb -> #rrggbb
        h = "".join(c * 2 for c in h)
    r, g, b = (_srgb_to_linear(int(h[i:i + 2], 16) / 255) for i in (0, 2, 4))
    luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
    return "#000000" if luminance > 0.179 else "#ffffff"


# --------------------------------------------------------------------------- #
# Persistence
# --------------------------------------------------------------------------- #

def load(path):
    """Read the JSON store from `path`.

    If the file is missing or malformed we don't crash: a corrupt file is
    backed up to `<path>.bak` and we return a fresh empty store.
    """
    try:
        with open(path, "r", encoding="utf-8") as f:
            parsed = json.load(f)
    except FileNotFoundError:
        return _empty()
    except json.JSONDecodeError:
        # Preserve the bad data for inspection, then start clean.
        _backup(path)
        return _empty()

    # Valid JSON, but is it the shape we expect? It must be a dict with both
    # "active" and "archive" keys, each holding a list. Anything else is
    # treated like a corrupt file: back it up and start clean.
    if (
        isinstance(parsed, dict)
        and isinstance(parsed.get("active"), list)
        and isinstance(parsed.get("archive"), list)
    ):
        # Backward compatibility: older stores have no "expired" list. A
        # missing (or non-list) "expired" is NOT corruption -- we just
        # default it to [] and migrate gracefully.
        if not isinstance(parsed.get("expired"), list):
            parsed["expired"] = []
        # Same for the tag registry: a store predating tags has no "tags"
        # key (or a wrong type). Default it to {} -- NOT corruption.
        if not isinstance(parsed.get("tags"), dict):
            parsed["tags"] = {}
        # And any task missing its own "tags" list gets an empty list.
        for bucket in ("active", "archive", "expired"):
            for task in parsed[bucket]:
                if not isinstance(task.get("tags"), list):
                    task["tags"] = []
        return parsed
    _backup(path)
    return _empty()


def _backup(path):
    """Move a bad store aside to `<path>.bak` (best effort)."""
    try:
        os.replace(path, path + ".bak")
    except OSError:
        pass


def save(path, data):
    """Atomically write `data` as JSON to `path`.

    We write to a temp file first and then os.replace() it into place so a
    crash mid-write can never leave a half-written (corrupt) file.
    """
    directory = os.path.dirname(path) or "."
    os.makedirs(directory, exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)


# --------------------------------------------------------------------------- #
# Date helpers
# --------------------------------------------------------------------------- #

def _parse(due):
    """Parse an ISO date string into a datetime, or None if empty/invalid."""
    if not due:
        return None
    try:
        return datetime.fromisoformat(due)
    except ValueError:
        return None


def time_remaining(due, now=None):
    """Return a human-readable badge describing time left until `due`.

    Examples: "", "3 day(s) left", "5 hour(s) left", "due soon",
    "overdue by 2 day(s)", "overdue by 5 hour(s)", "overdue".

    Note: the instant a task passes its due time (delta == 0) it is treated
    as overdue. Within the first hour past due we just say "overdue" -- we
    never print "overdue by 0 hour(s)".
    """
    when = _parse(due)
    if when is None:
        return ""
    now = now or datetime.now()
    delta = when - now
    seconds = delta.total_seconds()

    if seconds <= 0:
        # Overdue: report how far past we are. Mirrors the forward-looking
        # tiers below (days, then hours, then a sub-hour catch-all).
        past = -seconds
        if past >= 86400:
            return f"overdue by {int(past // 86400)} day(s)"
        if past >= 3600:
            return f"overdue by {int(past // 3600)} hour(s)"
        # Less than an hour past (including the 0-second boundary): just say
        # "overdue" -- never "overdue by 0 hour(s)".
        return "overdue"

    if seconds >= 86400:
        return f"{int(seconds // 86400)} day(s) left"
    if seconds >= 3600:
        return f"{int(seconds // 3600)} hour(s) left"
    return "due soon"


def is_overdue(due, now=None):
    """True if `due` is in the past. No due date is never overdue."""
    when = _parse(due)
    if when is None:
        return False
    now = now or datetime.now()
    return when < now


def _add_one_month(when):
    """Return `when` advanced by one calendar month, clamping the day to the
    last valid day of the target month (e.g. Jan 31 -> Feb 28/29).
    """
    month = when.month + 1
    year = when.year
    if month > 12:
        month = 1
        year += 1
    # Clamp the day to the last day of the target month.
    day = min(when.day, _days_in_month(year, month))
    return when.replace(year=year, month=month, day=day)


def _days_in_month(year, month):
    """Number of days in a given month, leap-year aware."""
    if month == 12:
        nxt = datetime(year + 1, 1, 1)
    else:
        nxt = datetime(year, month + 1, 1)
    return (nxt - timedelta(days=1)).day


def next_occurrence(due_iso, recurrence):
    """Return the next due datetime (ISO string) after `due_iso`, advancing
    by one `recurrence` interval.

    daily   -> +1 day
    weekly  -> +7 days
    monthly -> +1 calendar month (day clamped to month end)
    every:N -> +N days

    Returns None if `due_iso` doesn't parse or `recurrence` is not a
    recognized repeating value.
    """
    when = _parse(due_iso)
    if when is None or not recurrence:
        return None

    if recurrence == "daily":
        return (when + timedelta(days=1)).isoformat()
    if recurrence == "weekly":
        return (when + timedelta(days=7)).isoformat()
    if recurrence == "monthly":
        return _add_one_month(when).isoformat()
    if isinstance(recurrence, str) and recurrence.startswith("every:"):
        try:
            n = int(recurrence.split(":", 1)[1])
        except ValueError:
            return None
        if n <= 0:
            return None
        return (when + timedelta(days=n)).isoformat()
    return None


def _default_due(recurrence, now):
    """Default due datetime (ISO) for a recurring task created/edited without an
    explicit due date: one interval out from `now`, at 23:59 local.

    daily   -> same day
    weekly  -> +7 days
    monthly -> +1 calendar month (day clamped to month end)
    every:N -> +N days

    Returns None for a non-repeating/unrecognized recurrence. Assumes
    `recurrence` has already passed `_valid_recurrence`.
    """
    if recurrence == "daily":
        target = now
    elif recurrence == "weekly":
        target = now + timedelta(days=7)
    elif recurrence == "monthly":
        target = _add_one_month(now)
    elif isinstance(recurrence, str) and recurrence.startswith("every:"):
        target = now + timedelta(days=int(recurrence.split(":", 1)[1]))
    else:
        return None
    return target.replace(hour=23, minute=59, second=0, microsecond=0).isoformat()


# Inline `>due` grammar for the journal `[]` task-spawning feature (Spec 2).
# A relative token: +Nd (days), +Nw (weeks), +Nm (calendar months).
_REL_DUE_RE = re.compile(r"^\+(\d+)([dwm])$")

# Weekday names (full + 3-letter), Monday=0 .. Sunday=6 (matching weekday()).
_WEEKDAYS = {
    "monday": 0, "mon": 0, "tuesday": 1, "tue": 1, "wednesday": 2, "wed": 2,
    "thursday": 3, "thu": 3, "friday": 4, "fri": 4, "saturday": 5, "sat": 5,
    "sunday": 6, "sun": 6,
}


def parse_due_token(token, now=None):
    """Parse an inline due token to an ISO datetime at 23:59 local, or None.

    Accepts: 'YYYY-MM-DD'; 'today'; 'tomorrow'; weekday names (full or
    3-letter, resolving to the next occurrence ON or after today);
    relative '+Nd' / '+Nw' / '+Nm'. Case-insensitive. Pure; `now` injectable.
    Reuses _add_one_month for +Nm. An unrecognized token returns None (the
    caller then leaves the `>token` as plain text in the title).
    """
    if not token:
        return None
    now = now or datetime.now()
    today = now.replace(hour=0, minute=0, second=0, microsecond=0)
    tok = token.strip().lower()

    target = None
    if tok == "today":
        target = today
    elif tok == "tomorrow":
        target = today + timedelta(days=1)
    elif tok in _WEEKDAYS:
        # Next occurrence on/after today (0 days out if today is that weekday).
        delta = (_WEEKDAYS[tok] - today.weekday()) % 7
        target = today + timedelta(days=delta)
    else:
        m = _REL_DUE_RE.match(tok)
        if m:
            n, unit = int(m.group(1)), m.group(2)
            if unit == "d":
                target = today + timedelta(days=n)
            elif unit == "w":
                target = today + timedelta(weeks=n)
            else:  # "m"
                target = today
                for _ in range(n):
                    target = _add_one_month(target)
        else:
            # Fall back to a plain ISO date (e.g. 2026-07-04). Reject anything
            # carrying a time component or otherwise non-date.
            parsed = _parse(tok)
            if parsed is not None and len(tok) == 10:
                target = parsed.replace(
                    hour=0, minute=0, second=0, microsecond=0)

    if target is None:
        return None
    return target.replace(hour=23, minute=59, second=0, microsecond=0).isoformat()


def _advance_until_future(due_iso, recurrence, now):
    """Advance a recurring due date by its interval until it lands strictly
    after `now`. Returns the first future due ISO string.

    Used to spawn the next live occurrence of a recurring task that was
    missed: if several intervals elapsed, we skip past all of them.
    """
    nxt = next_occurrence(due_iso, recurrence)
    # Guard against a malformed recurrence that can't advance.
    if nxt is None:
        return None
    while _parse(nxt) <= now:
        following = next_occurrence(nxt, recurrence)
        if following is None or following == nxt:
            break
        nxt = following
    return nxt


# --------------------------------------------------------------------------- #
# Task operations
# --------------------------------------------------------------------------- #

def add_task(data, title, due=None, recurrence=None, now=None, tags=None):
    """Add a new active task.

    Raises ValueError on an empty/whitespace title, on a non-empty `due`
    string that doesn't parse as an ISO date, or on an unrecognized
    `recurrence`.

    A recurrence given without a due date defaults the due date to one interval
    out from `now` at 23:59 local (daily -> same day, weekly -> +7d,
    monthly -> +1 month, every:N -> +N days). An explicit due is always kept.

    `tags` is an optional list of tag names. They're normalized (stripped,
    lowercased, blanks dropped, de-duplicated preserving order) and stored on
    the task. Tags need not exist in the registry at this level.
    """
    title = (title or "").strip()
    if not title:
        raise ValueError("Task title must not be empty")
    if due and _parse(due) is None:
        raise ValueError(f"Invalid due date: {due!r}")
    if not _valid_recurrence(recurrence):
        raise ValueError(f"Invalid recurrence: {recurrence!r}")
    now = now or datetime.now()
    if recurrence and not due:
        due = _default_due(recurrence, now)
    task = {
        "id": uuid.uuid4().hex,
        "title": title,
        "due": due or None,
        "recurrence": recurrence or None,
        "created": now.isoformat(),
        "tags": _normalize_tags(tags),
        "notes": "",
        "subtasks": [],
    }
    data["active"].append(task)
    return data


def edit_task(data, task_id, title, due=None, recurrence=None, tags=None, now=None):
    """Update an existing active task in place.

    Applies the same validation rules as add_task (non-empty title,
    parseable due, valid recurrence). As in add_task, a recurrence given
    without a due date defaults the due to one interval out at 23:59 local.
    `tags` is normalized the same way as in add_task. Raises ValueError on
    bad input. An unknown id is a safe no-op.
    """
    title = (title or "").strip()
    if not title:
        raise ValueError("Task title must not be empty")
    if due and _parse(due) is None:
        raise ValueError(f"Invalid due date: {due!r}")
    if not _valid_recurrence(recurrence):
        raise ValueError(f"Invalid recurrence: {recurrence!r}")
    if recurrence and not due:
        due = _default_due(recurrence, now or datetime.now())

    for task in data["active"]:
        if task["id"] == task_id:
            task["title"] = title
            task["due"] = due or None
            task["recurrence"] = recurrence or None
            task["tags"] = _normalize_tags(tags)
            break
    return data


def delete_task(data, task_id):
    """Remove a task by id from active, archive, and/or expired.
    Unknown id = no-op.
    """
    data["active"] = [t for t in data["active"] if t["id"] != task_id]
    data["archive"] = [t for t in data["archive"] if t["id"] != task_id]
    if isinstance(data.get("expired"), list):
        data["expired"] = [t for t in data["expired"] if t["id"] != task_id]
    return data


def sort_active(tasks, now=None):
    """Sort active tasks: overdue first (most overdue on top), then soonest
    due, then tasks with NO due date last.
    """
    now = now or datetime.now()

    def key(task):
        when = _parse(task.get("due"))
        if when is None:
            # No due date -> sort to the very end.
            return (2, 0.0)
        delta = (when - now).total_seconds()
        if delta < 0:
            # Overdue: group 0, most overdue (smallest delta) first.
            return (0, delta)
        # Future: group 1, soonest first.
        return (1, delta)

    return sorted(tasks, key=key)


def _spawn_next(task, due_iso, now):
    """Build a fresh active task for the next occurrence of a recurring task.

    New id, the given `due`, same title + recurrence. Returns None if the
    next due can't be computed.
    """
    if not due_iso:
        return None
    # Carry notes + subtask text forward; reset every subtask's done flag to
    # False so the next occurrence starts fresh. Deep-copy the dicts so the
    # spawned task and the archived/expired one never share subtask objects.
    subtasks = [{"text": s.get("text", ""), "done": False}
                for s in (task.get("subtasks") or [])]
    return {
        "id": uuid.uuid4().hex,
        "title": task["title"],
        "due": due_iso,
        "recurrence": task.get("recurrence"),
        "created": now.isoformat(),
        "tags": list(task.get("tags") or []),
        "notes": task.get("notes", ""),
        "subtasks": subtasks,
    }


def refresh(data, completed_ids, difficulties=None, now=None):
    """Process the active list:

    - Checked (completed) tasks -> archived (stamped `completed`). A completed
      recurring task ALSO spawns its next occurrence as a new active task.
    - Recurring tasks that are overdue and were NOT completed -> the missed
      occurrence moves to `expired` (stamped `expired_at`), and the next
      future occurrence is spawned into active.
    - Non-recurring overdue tasks stay in active (they remain at the top as
      normal overdue items).

    Finally the remaining active list is re-sorted.
    """
    now = now or datetime.now()
    completed = set(completed_ids or [])
    difficulties = difficulties or {}
    # Backward compatibility: a store loaded the old way may lack "expired".
    data.setdefault("expired", [])

    still_active = []
    for task in data["active"]:
        recurrence = task.get("recurrence")

        if task["id"] in completed:
            # Completed: archive it, stamping when.
            archived = dict(task)
            archived["completed"] = now.isoformat()
            diff = _norm_difficulty(difficulties.get(task["id"]))
            if diff:
                archived["difficulty"] = diff
            data["archive"].append(archived)
            # Recurring? Spawn the next occurrence too.
            if recurrence and task.get("due"):
                nxt = next_occurrence(task["due"], recurrence)
                spawned = _spawn_next(task, nxt, now)
                if spawned:
                    still_active.append(spawned)
            continue

        # Not completed. Recurring + overdue means we missed this occurrence:
        # file it under expired and spawn the next future one.
        if recurrence and task.get("due") and is_overdue(task["due"], now=now):
            missed = dict(task)
            missed["expired_at"] = now.isoformat()
            data["expired"].append(missed)
            nxt = _advance_until_future(task["due"], recurrence, now)
            spawned = _spawn_next(task, nxt, now)
            if spawned:
                still_active.append(spawned)
            continue

        # Everything else (future tasks, non-recurring overdue) stays active.
        still_active.append(task)

    data["active"] = sort_active(still_active, now=now)
    return data


# --------------------------------------------------------------------------- #
# Task analytics (pure aggregation; dates are YYYY-MM-DD; bounds inclusive)
# --------------------------------------------------------------------------- #

def _in_range(date10, start, end):
    if not date10:
        return False
    if start and date10 < start:
        return False
    if end and date10 > end:
        return False
    return True


def completion_throughput(archive, start=None, end=None):
    """{date: count} of tasks completed per day within [start, end]."""
    out = {}
    for t in archive:
        c = t.get("completed")
        d = c[:10] if c else None
        if _in_range(d, start, end):
            out[d] = out.get(d, 0) + 1
    return out


def completed_late_count(archive, start=None, end=None):
    """Among completed tasks that had a due date, count late vs on-time."""
    late = on_time = 0
    for t in archive:
        c, due = t.get("completed"), t.get("due")
        if not c or not due:
            continue
        if not _in_range(c[:10], start, end):
            continue
        if c > due:
            late += 1
        else:
            on_time += 1
    return {"late": late, "on_time": on_time}


def expiry_counts(expired, start=None, end=None):
    """{date: count} of tasks that expired (missed) per day."""
    out = {}
    for t in expired:
        e = t.get("expired_at")
        d = e[:10] if e else None
        if _in_range(d, start, end):
            out[d] = out.get(d, 0) + 1
    return out


def recurring_adherence(archive, expired, start=None, end=None):
    """For recurring occurrences only: completed (archived) vs missed (expired)."""
    completed = sum(
        1 for t in archive
        if t.get("recurrence") and _in_range((t.get("completed") or "")[:10], start, end))
    missed = sum(
        1 for t in expired
        if t.get("recurrence") and _in_range((t.get("expired_at") or "")[:10], start, end))
    return {"completed": completed, "missed": missed}


def difficulty_breakdown(archive, start=None, end=None):
    """Counts of easy/medium/hard/unrated among completed tasks in range."""
    out = {"easy": 0, "medium": 0, "hard": 0, "unrated": 0}
    for t in archive:
        c = t.get("completed")
        if not _in_range(c[:10] if c else None, start, end):
            continue
        out[_norm_difficulty(t.get("difficulty")) or "unrated"] += 1
    return out


def task_tag_frequency(tasks, start=None, end=None, date_field="completed"):
    """{tag: count} across `tasks`; if a bound is given, filter by `date_field`."""
    out = {}
    for t in tasks:
        if start or end:
            v = t.get(date_field)
            if not _in_range(v[:10] if v else None, start, end):
                continue
        for tag in t.get("tags") or []:
            out[tag] = out.get(tag, 0) + 1
    return out


def task_payload(data):
    """Raw task records for the analytics 'Tasks' tab (JS aggregates + filters)."""
    def base(t):
        return {"id": t.get("id"), "title": t.get("title", ""),
                "created": t.get("created"), "due": t.get("due"),
                "recurrence": t.get("recurrence"), "tags": list(t.get("tags") or [])}

    active = [base(t) for t in data.get("active", [])]
    archive = []
    for t in data.get("archive", []):
        rec = base(t)
        rec["completed"] = t.get("completed")
        rec["difficulty"] = _norm_difficulty(t.get("difficulty"))
        archive.append(rec)
    expired = []
    for t in data.get("expired", []):
        rec = base(t)
        rec["expired_at"] = t.get("expired_at")
        expired.append(rec)

    dates = []
    for t in data.get("archive", []):
        if t.get("completed"):
            dates.append(t["completed"][:10])
    for t in data.get("expired", []):
        if t.get("expired_at"):
            dates.append(t["expired_at"][:10])
    for bucket in ("active", "archive", "expired"):
        for t in data.get(bucket, []):
            if t.get("created"):
                dates.append(t["created"][:10])
    dates.sort()
    date_range = {"min": dates[0], "max": dates[-1]} if dates else {"min": None, "max": None}
    return {"active": active, "archive": archive, "expired": expired,
            "tags": dict(data.get("tags", {})), "date_range": date_range}


# --------------------------------------------------------------------------- #
# Tag pages / backlinks: per-tag overview (task side; pure)
# --------------------------------------------------------------------------- #

def _task_has_tag(task, name):
    """True if `task` carries the (normalized) tag `name`."""
    return name in (t for t in (task.get("tags") or []))


def _task_date(task):
    """The most representative date for a task occurrence (YYYY-MM-DD):
    completed, else expired_at, else created — whichever is present."""
    for field in ("completed", "expired_at", "created"):
        v = task.get(field)
        if v:
            return v[:10]
    return None


def tag_overview(data, name, start=None, end=None):
    """Unify everything the task side knows about one tag `name`.

    Case-insensitive (task tags are stored normalized). `start`/`end` are
    inclusive YYYY-MM-DD bounds (None = unbounded), filtered on each task's
    representative date (completed/expired_at/created). Pure — no clock, no I/O.

    Returns:
      exists        whether `name` is in the data["tags"] registry
      color         registered hex color (or the neutral default)
      active        count of in-range active tasks carrying the tag
      completed     count of in-range archived (completed) tasks carrying it
      expired       count of in-range expired tasks carrying it
      first, last   earliest / latest occurrence date (or None)
      lead_time_days mean(due - completed) in days over completed tasks that had
                    a due date. POSITIVE means finished early. Null if none.
      cooccurring   [{name, count}] other task tags on the same tasks
      timeline      [{date, title, status, due, completed}], newest first
    """
    name = (name or "").strip().lower()
    registry = data.get("tags", {})

    def scoped(bucket):
        out = []
        for t in data.get(bucket, []):
            if not _task_has_tag(t, name):
                continue
            if start or end:
                if not _in_range(_task_date(t), start, end):
                    continue
            out.append(t)
        return out

    active_tasks = scoped("active")
    completed_tasks = scoped("archive")
    expired_tasks = scoped("expired")
    all_tasks = active_tasks + completed_tasks + expired_tasks

    # Lead time: due - completed, in days, over completed tasks that had a due.
    leads = []
    for t in completed_tasks:
        due, completed = _parse(t.get("due")), _parse(t.get("completed"))
        if due is not None and completed is not None:
            leads.append((due - completed).total_seconds() / 86400.0)
    lead_time_days = sum(leads) / len(leads) if leads else None

    # Co-occurrence: other task tags appearing on the same tasks.
    cooc = {}
    for t in all_tasks:
        for other in t.get("tags") or []:
            if other == name:
                continue
            cooc[other] = cooc.get(other, 0) + 1
    cooccurring = [
        {"name": n, "count": c}
        for n, c in sorted(cooc.items(), key=lambda kv: (-kv[1], kv[0]))
    ]

    def row(t, status):
        return {"date": _task_date(t), "title": t.get("title", ""),
                "status": status, "due": t.get("due"),
                "completed": t.get("completed")}

    rows = ([row(t, "active") for t in active_tasks]
            + [row(t, "completed") for t in completed_tasks]
            + [row(t, "expired") for t in expired_tasks])
    rows.sort(key=lambda r: r["date"] or "", reverse=True)

    dates = sorted(d for d in (_task_date(t) for t in all_tasks) if d)
    first = dates[0] if dates else None
    last = dates[-1] if dates else None

    return {
        "exists": name in registry,
        "color": registry.get(name, DEFAULT_TAG_COLOR),
        "active": len(active_tasks),
        "completed": len(completed_tasks),
        "expired": len(expired_tasks),
        "first": first,
        "last": last,
        "lead_time_days": lead_time_days,
        "cooccurring": cooccurring,
        "timeline": rows,
    }
