# Journaling Feature — Design Spec

**Date:** 2026-06-15
**Status:** Approved for planning
**Author:** Julia Xi (with Claude)

## Summary

Extend Datapom from a pure to-do app into a combined **daily journal + to-do**
web app. The journal lets the user write one dated entry per day (title + free
text), tag the day across configurable **sections** (e.g. people, places,
food), and record per-day **numbers** (e.g. sleep, screen time). Sections and
their tags are curated on a dedicated management page. Entries are editable
after submission.

The next project after this is **analytics over both journal entries and
tasks**, so the data model is designed to be analytics-ready from the start
(stable identifiers, typed values, ISO timestamps). Analytics itself is **out
of scope** for this spec — we only guarantee the schema supports it.

## Goals

- Per-day journal entries (one per calendar date), creatable and editable.
- Tagging the day via two-column **sections**, each holding selectable tags.
- **Numeric sections** that capture a single number per day instead of tags.
- A management page (its own nav tab) to add/rename/delete sections, pick
  section colors (with live preview), curate permanent tags, and set units.
- Per-entry **temporary tags** (this entry only) vs **permanent tags** (added
  to the section's master list).
- Navigation between Tasks and Journal via a clickable Pompompurin mascot.
- Local persistence in a dedicated data file, created on first run.
- An analytics-friendly data model.

## Non-Goals

- The analytics/reporting features themselves (next project).
- Multiple entries per day.
- Sharing the journal's tags with the existing task-tag registry.
- Auth, multi-user, sync, or any network features.

## Architecture

Follows the project's existing **strict split between pure logic and the HTTP
layer**.

- **`journal.py`** — new module, **zero Flask imports**, all domain logic over
  plain dicts/lists. Time-sensitive functions accept an injectable `now=None`
  (for `today`, `created`, `updated`), mirroring `todo.py`. This is the
  unit-tested "brain" of the journal.
- **`app.py`** — journal routes added alongside the existing task routes (no
  Flask blueprint; the app is small and this matches the current flat layout).
  All state-changing routes use **Post/Redirect/Get** with `flash()` for
  validation errors. The journal data-file path is
  `app.config["JOURNAL_FILE"]` so tests can point it at a temp file (exactly
  like `DATA_FILE`).
- **Templates** — `base.html` is refactored so the hard-coded brand and nav
  become `{% block brand %}` and `{% block nav %}`. Task templates and journal
  templates then share one shell. New templates: `journal_entry.html` (the
  create/edit form), `journal_list.html` (past entries), and
  `journal_sections.html` (management page). Journal display helpers from
  `journal.py` (e.g. `section_color`, reuse of `text_color_for`) are exposed as
  Jinja globals like the task helpers already are.

### Module boundaries

- `journal.py` knows nothing about HTTP or templates. Its only dependency is a
  one-way import of `todo.py`'s pure helpers (hex/name validation,
  `text_color_for`) — logic depending on logic, never the reverse.
- `app.py` parses requests, calls `journal.py`, saves, and redirects.
- `todo.py` is **unchanged** by this feature.

## Navigation: the Pompompurin toggle

A single clickable **Pompompurin** mascot toggles between the two sections and
appears in the header on both:

- On the **todo** page: shown next to the existing todo-pup brand; clicking it
  goes to the journal (today's entry).
- On the **journal** pages: serves as the journal brand; clicking it returns to
  the tasks page.

Implementation: the toggle target is whichever section the user is **not**
currently on. New asset required: **`static/img/pompompurin.gif`** (the user
will supply it). Until present, a placeholder is wired in so layout/links work.

Journal nav tabs: **New entry · Past entries · Manage sections & tags**.

## Data model — `data/journal.json`

Separate file from `data/tasks.json`, with its own `load()` / `save()` that use
the **same forgiving, backward-compatible migration and atomic-write pattern**
as `todo.py`:

- `save()` writes to a temp file then `os.replace()` (atomic); creates the
  `data/` directory if missing (first-run folder creation).
- `load()` defaults any missing top-level key; treats the file as corrupt
  (backed up to `<path>.bak`, fresh store returned) only if it is not a dict or
  is missing both core keys. When the file does **not exist**, `load()` returns
  a **seeded** store (default sections); `_empty()` returns a truly empty store
  for tests.

### Shape

```jsonc
{
  "sections": [
    {
      "id": "a1b2…",            // uuid4 hex — STABLE, never reused
      "name": "people",         // normalized: strip + lowercase
      "type": "tag",            // "tag" | "numeric"
      "color": "#e0a955",       // hex, validated
      "tags": ["maya", "dad"],  // permanent tags (tag sections only)
      "unit": null,             // e.g. "hrs" (numeric sections only)
      "archived": false         // soft-delete flag
    },
    {
      "id": "c3d4…", "name": "sleep", "type": "numeric",
      "color": "#6fa8dc", "tags": [], "unit": "hrs", "archived": false
    }
  ],
  "entries": [
    {
      "id": "e5f6…",            // uuid4 hex
      "date": "2026-06-15",     // YYYY-MM-DD — UNIQUE across entries
      "title": "A good slow Sunday",
      "body": "…free text…",
      "created": "2026-06-15T09:12:00",   // ISO
      "updated": "2026-06-15T21:40:00",   // ISO
      "tags":    { "a1b2…": ["maya", "dad", "aunt rosa"] },  // section id -> tag strings
      "numbers": { "c3d4…": 8.5 }                            // section id -> number
    }
  ]
}
```

### Why this shape (analytics-readiness)

- **Entries reference sections by stable `id`**, not name. Renaming a section
  keeps its history as one continuous series instead of fragmenting it.
- **Sections are soft-deleted** (`archived: true`), never removed, so every id,
  name, color, and unit stays resolvable forever — old entries and future
  analytics can always be labeled. Archived sections don't appear as options on
  new entries or in the active management list.
- **Numbers are stored as JSON numbers** (not strings) for direct aggregation.
- **All dates/timestamps are ISO**; entry `date` (`YYYY-MM-DD`) joins naturally
  with tasks' ISO datetimes.
- **Tags are normalized string lists** — for a tag, the *string is the
  identity*, so counting occurrences across entries is direct.

### First-run seed

When `data/journal.json` is absent, `load()` returns a store seeded with six
**tag** sections — `people, places, food, chores, health, work` — each with a
distinct default hex color and an empty `tags` list. No numeric sections are
seeded. `_empty()` (used by tests) stays `{"sections": [], "entries": []}`.

## Behaviors

### Entry lifecycle (one per date)

- **New entry / Pompompurin → journal** opens **today's** entry: if an entry
  for today exists it opens pre-filled for editing, otherwise a blank form for
  today. The date field is editable; saving for a date that already has an
  entry **updates** that entry rather than creating a duplicate (date is the
  unique key).
- **Past entries** lists all entries newest-date-first, each linking to its
  edit form, with a delete control.
- **Editing** reuses the same form pre-filled; the submit button reads "Update
  entry". `created` is set once; `updated` is stamped on every save.

### Tags on an entry

- Each non-archived **tag section** renders as a card of selectable chips drawn
  from its permanent `tags`, plus a `+ tag` control.
- `+ tag` opens a small popover: enter a name and choose **permanent** or
  **temporary**.
  - **permanent** → the tag is appended to that section's `tags` registry AND
    selected on the entry.
  - **temporary** → the tag is only stored on the entry, not added to the
    registry.
- **Unified rule:** storage-wise a temporary tag and a later-deleted permanent
  tag are identical — *a tag string on the entry that is not in the section's
  current `tags` list*. Such chips render **dashed** ("not in the master list").
- When editing, every tag stored on the entry renders as selected, even if it
  is no longer in the section's master list (dashed).

### Numeric sections on an entry

- Each non-archived **numeric** section renders as a card with one number input
  and the section's `unit` label.
- Blank = not recorded that day (the section id is omitted from `numbers`).
- Decimal values allowed; value parsed and stored as a JSON number.

### Management page (`Manage sections & tags`)

- Lists non-archived sections with their type (tag / numeric).
- **Add section**: name + type (tag|numeric) + color. Numeric also takes a
  unit. New id assigned.
- **Rename** a section; **delete** (soft) a section.
- **Pick section color** with a **live preview** reusing the existing
  `--tag-bg` + `color-mix` preview JS (the same mechanism the task new-tag form
  uses). A section's color tints its chips.
- For tag sections: add / remove permanent tags. Removing a tag drops it from
  the section's `tags` list only — entries that used it keep it (renders dashed
  thereafter).
- For numeric sections: edit the unit.

## Validation & security

Preserves the project's injection-safety invariant (names and colors flow into
`style=` attributes, so they are validated independent of template escaping):

- **Section names and tag names**: stripped, lowercased, and matched against the
  existing allowlist `^[a-z0-9 _-]+$`; empty/disallowed names rejected with a
  flash. Names are unique within their registry (sections by name among
  non-archived; tags within a section).
- **Colors**: validated as `#rgb` / `#rrggbb` hex. `journal.py` reuses
  `todo.py`'s pure, Flask-free helpers by import (`text_color_for` for readable
  chip text, and the hex/name validation regexes) so there is a single source
  of truth; this is the only dependency between the two modules and it points
  the safe direction (logic → logic, no HTTP).
- **Units**: short free text; Jinja-escaped on output and length-capped. Not
  placed into `style`.
- **Dates**: validated as `YYYY-MM-DD`; invalid dates rejected with a flash.
- **Numbers**: parsed as float; non-numeric rejected with a flash; blank
  allowed (omitted).
- All state-changing routes follow Post/Redirect/Get; validation failures save
  nothing and surface a `flash()` message.

## Error handling

- Corrupt `journal.json` → backed up to `.bak`, fresh seeded store returned (no
  crash), mirroring `todo.load()`.
- Unknown entry id / section id on a route → safe no-op or redirect, mirroring
  the task routes' handling of unknown ids.
- A crafted POST cannot create stray registry entries: management routes act
  only on existing/declared sections.

## Tasks-side analytics contract (no code change)

`todo.py` already retains the data analytics will need; this is documented here
so the analytics phase need not reverse-engineer it:

- Each task carries `created`, `due`, `recurrence`, `tags`.
- Archived tasks add `completed` (ISO); expired tasks add `expired_at` (ISO).
- Archived/expired tasks are never pruned.

This supports completion throughput, overdue/expiry rates, and tag breakdowns
over time. **No changes to `todo.py` are made in this feature.**

## Testing

Test-first, mirroring the existing convention:

- **`journal.py` unit tests** — fixed `now`, pytest `tmp_path` for file I/O;
  stores initialized via `journal._empty()`. Cover: seed-on-first-run,
  `load()` migration/back-compat/corruption, add/rename/soft-delete section,
  add/remove permanent tag, create/update entry (one-per-date enforcement),
  permanent-vs-temporary tag handling, dashed (not-in-registry) tag detection,
  numeric parsing/blank, validation rejections, id stability across rename.
- **Route tests** (`tests/test_journal_app.py`) — Flask `test_client()` with a
  temp `app.config["JOURNAL_FILE"]`. Cover: each route's happy path + PRG,
  flash on invalid input, today's-entry create/edit landing, manage-page
  operations, and the nav/toggle links rendering.
- Existing `tests/test_todo.py` and `tests/test_app.py` must continue to pass
  unchanged.

## Open items / follow-ups

- **`static/img/pompompurin.gif`** asset to be supplied by the user; placeholder
  until then.
- Section **display ordering** is creation order (two-column fill); reordering
  is out of scope for now.
- Analytics features are a separate project building on this schema.
