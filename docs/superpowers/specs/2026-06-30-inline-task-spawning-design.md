# `[]` Inline Task Spawning — Design

**Date:** 2026-06-30
**Status:** Approved (brainstorming complete)
**Scope:** Spec 2 of a 3-feature sequence (`#numeric` inline capture → **this** →
leading-indicators analytics). The cross-domain bridge: plan to-dos from inside the
journal body. No data-model migration; one new pure date helper in `todo.py`.

## Summary

A journal-body line that starts with `[]` (or `- [ ]`) spawns a real to-do in
`data["active"]` on save:

```
[] call the dentist
- [ ] email the landlord >tomorrow
[] lunch with @alex >friday
```

The spawned line is then **rewritten in place** to a linked token carrying the new
task id, so it never re-spawns and renders as a **live checkbox mirroring the
task's done-state**. It rounds out the inline-grammar family:
**`@` = tag the day · `#` = log a number · `[]` = spawn a task.**

## Locked decisions (from brainstorming)

1. **Marker grammar.** A *fresh* task line matches, at line start (after optional
   leading whitespace and an optional `- `):
   `[]` or `[ ]`, then whitespace, then the title text. Regex (multiline):
   `^[ \t]*(?:-[ \t]+)?\[[ ]?\][ \t]+(.+)$`.
2. **Linking / idempotency = A1 (live linked checkbox).** On spawn, the marker is
   rewritten to `[task:<id>]` (id = the new task's uuid4 hex). A *linked* line
   matches `^[ \t]*(?:-[ \t]+)?\[task:([0-9a-f]+)\][ \t]+(.+)$` and is **never
   re-spawned**. The raw token stays bracket-shaped (still reads as a checkbox in
   the textarea); done-state is **not** stored in the token (read live from a
   task-ref index to avoid staleness).
3. **Metadata = B1 (title + due + tags).**
   - **Due:** an optional `>token` anywhere in the line (parsed only inside `[]`
     lines, so prose `x > y` is unaffected — the `>` must be immediately followed
     by a date token, no space). `parse_due_token` (new, pure, in `todo.py`)
     accepts: ISO `YYYY-MM-DD`; `today`; `tomorrow`; weekday full or 3-letter
     (`monday`/`mon` → the next occurrence on/after today); relative `+Nd` / `+Nw`
     / `+Nm`. Returns ISO at **23:59 local** (matching `_default_due`), or `None`
     on no match. The `>token` is stripped from the task title.
   - **Tags:** the spawned task inherits any `@mentions` resolved on that line
     (via the existing mention index), so a tag like `alex` attaches to **both**
     the journal day and the task — unified by name across domains at zero extra
     cost. `@mentions` are left verbatim in the task title (read fine; renaming is
     a future polish).
4. **One-way v1.** Checking a task off elsewhere reflects into the journal
   checkbox (read mirror). Toggling *from* the journal (bidirectional) and inline
   **recurrence** are out of scope (noted below).

## Data model — unchanged

- Entry `body` stays plain text. It now may contain `[task:<id>]` tokens (written
  by the save route). No new entry fields, no new store key → `journal.load()` /
  `_empty()` unchanged, no migration.
- Tasks are ordinary `add_task` rows in `data["active"]` (tasks.json). No task
  schema change.

## Pure helpers

### `journal.py` (zero Flask; body parsing + rewrite)

```python
_TASK_FRESH_RE  = re.compile(r"^[ \t]*(?:-[ \t]+)?\[[ ]?\][ \t]+(.+)$", re.M)
_TASK_LINKED_RE = re.compile(r"^[ \t]*(?:-[ \t]+)?\[task:([0-9a-f]+)\][ \t]+(.+)$", re.M)
_DUE_TOKEN_RE   = re.compile(r"(?:^|\s)>(\S+)")

def extract_task_lines(body, mention_index, due_parser, now=None):
    """Ordered list of fresh [] task lines to spawn, in document order.
    Returns [{title, due, tags}]:
      - title: line text minus the marker and the >due token, trimmed
      - due:   due_parser(token, now) for the first >token, else None
      - tags:  resolved @mention names on that line (deduped, via mention_index)
    Lines whose title is empty after stripping are skipped. `due_parser` is
    injected (todo.parse_due_token) to keep this helper unit-testable without
    importing task logic for the date grammar."""

def linked_task_ids(body):
    """Set of task ids already linked in the body (for the task-ref index +
    idempotency assertions). Parsed from _TASK_LINKED_RE."""

def rewrite_task_lines(body, task_ids):
    """Replace each fresh [] marker, in document order, with [task:<id>] using
    the matching id from `task_ids` (same order/length as extract_task_lines's
    non-skipped result). Linked lines and skipped (empty-title) lines are left
    untouched. Returns the new body."""
```

`extract_task_lines` and `rewrite_task_lines` walk fresh-marker matches in the
**same order**, so the route can zip extracted lines → created task ids → rewrite.

### `todo.py` (zero Flask; the date grammar)

```python
def parse_due_token(token, now=None):
    """Parse an inline due token to an ISO datetime at 23:59 local, or None.
    Accepts: 'YYYY-MM-DD', 'today', 'tomorrow', weekday names (full/3-letter,
    next occurrence on/after today), '+Nd' / '+Nw' / '+Nm'. Pure; `now`
    injectable. Reuses _add_one_month for +Nm. Unknown -> None (the >token is
    then treated as plain text and left in the title)."""
```

## Route change (`app.py` `journal_save`)

`journal_save` already loads the journal store. It will additionally load the
**tasks** store, spawn tasks, rewrite the body, and save both:

```python
# After body/tag/number handling, before upsert_entry:
nidx_tags = journal.tag_section_index(data)          # already built for mentions
to_spawn = journal.extract_task_lines(body, nidx_tags, todo.parse_due_token)
if to_spawn:
    tdata = todo.load(data_file())
    new_ids = []
    for t in to_spawn:
        todo.add_task(tdata, t["title"], due=t["due"], tags=t["tags"])
        new_ids.append(tdata["active"][-1]["id"])
    todo.save(data_file(), tdata)
    body = journal.rewrite_task_lines(body, new_ids)   # body persisted on entry
# upsert_entry(... body=body ...) as before
```

Notes:
- A per-task `add_task` failure (e.g. empty title — already excluded) is isolated
  so one bad line never aborts the others; its `[]` is left un-rewritten.
- `data_file()` (tasks) and `journal_file()` are independent stores; both are
  saved atomically by their own `save()`.
- The mention union into the day's tags (existing behavior) is unchanged — task
  lines' `@mentions` still tag the day too.

## Task-ref index + rendering

### Route → page
The journal entry route embeds a task-ref index for ids referenced in the body:

```html
<script type="application/json" id="task-ref-index">
  { "<id>": {"done": true|false, "status": "active|done|expired|missing", "title": "..."} }
</script>
```

Built from `journal.linked_task_ids(entry.body)` looked up across tasks.json
`active` (→ not done), `archive` (→ done ✓), `expired` (→ expired), else
`missing`.

### `static/journal-richtext.js`
In the same click-to-edit render pass that handles formatting + mentions:
- **Linked line** (`[task:<id>] label`): render a themed checkbox span
  (`☑`/`☐` driven by the index `done`) + the `label` rendered with the normal
  inline-formatting/mention pipeline. `status:"expired"` → strikethrough/muted;
  `status:"missing"` → muted unchecked. The checkbox is a click target that
  **links** to the task (active list, or archive when done). Not a native
  `<input>` — a styled span, per the theming mandate.
- **Fresh line** (`[] label`, pre-save): render a plain unchecked themed checkbox
  + label, so it looks consistent before the save that links it.

CSS (`style.css`): `.task-check`, `.task-check.done`, `.task-check.expired`,
`.task-check.missing` — reuse `--accent`/`--muted`/`--danger`; no native widgets.

## Edge cases

- **Re-save:** linked lines match `_TASK_LINKED_RE`, are excluded by
  `extract_task_lines` → no duplicate. (Core idempotency guarantee.)
- **Empty title** (`[]` alone / only a `>token`): skipped, marker left as-is.
- **Unknown `>token`:** `parse_due_token` returns None; token stays in the title
  as plain text; task gets no due.
- **Manual `[task:bogus]`:** index miss → muted unchecked render; never spawns.
- **Body edited after linking:** label text may diverge from the task title; the
  checkbox still mirrors the task. Renaming the task from the journal is future
  scope.
- **No-JS:** spawning + linking happen server-side, so tasks are still created and
  the body still rewritten; only the live checkbox rendering needs JS (raw
  `[task:id] label` shows as text otherwise — acceptable).
- **Task later deleted:** `missing` status; line renders muted; harmless.

## Testing (TDD)

`tests/test_todo.py`:
- `parse_due_token`: ISO, today, tomorrow, weekday (full/3-letter, incl.
  today-is-that-weekday), `+Nd/+Nw/+Nm`, invalid → None; fixed `now`.

`tests/test_journal.py`:
- `extract_task_lines`: marker variants (`[]`, `[ ]`, `- [ ]`, leading spaces),
  title/due/tag extraction, empty-title skip, linked-line exclusion, document
  order, `>due` stripped from title, `@mention` tags resolved.
- `rewrite_task_lines`: replaces fresh markers in order, leaves linked/skipped
  lines untouched, idempotent on already-linked bodies.
- `linked_task_ids`: parses ids; ignores fresh lines.

`tests/test_journal_app.py`:
- Save body with `[] foo >tomorrow @alex` → active task with correct title, due
  (23:59 next day), tags `["alex"]`; entry body rewritten to `[task:<id>] foo …`;
  day tagged `alex`.
- Re-save the same entry → no duplicate task.
- Task-ref index reflects done/active/expired/missing.

## README cheat-sheet (Task #4, this slice)

Append a `[]` row to the **"Special features / power input"** section started by
Spec 1: the marker, the `>due` tokens, `@mention` tag inheritance, and the live
checkbox behavior, with one example line.

## Out of scope

- Bidirectional toggle (checking the task *from* the journal line).
- Inline **recurrence** (`>every:` etc.) and inline notes/subtasks.
- Renaming the task when the journal label is edited.
- Spawning from task notes or non-journal surfaces.
