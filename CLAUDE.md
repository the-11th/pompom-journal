# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Setup (any machine with Python 3.12+; no extra tools needed)
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Run the app (http://127.0.0.1:5001/)
flask --app app run --port 5001

# Tests
pytest                                   # full suite
pytest tests/test_todo.py                # core-logic tests only
pytest tests/test_app.py                 # Flask route tests only
pytest tests/test_journal.py             # journal logic tests only
pytest tests/test_journal_app.py         # journal route tests only
pytest -k time_remaining                 # single test by name substring
```

macOS dock app: click **TodoPup** in the dock (Automator app at `/Applications/TodoPup.app`). The server starts as a background daemon and auto-quits ~2 s after the last browser tab is closed (it stays alive while any tab is open, even backgrounded). See `SETUP.md` for first-time installation.

## Architecture

A server-rendered Flask web app with JSON file storage (no database). The central
design rule is a **strict split between pure logic and the HTTP layer**:

- **`todo.py`** — all task domain logic, zero Flask imports. Every function takes
  and returns plain dicts/lists. Time-sensitive functions accept an injectable
  `now=None` parameter for deterministic testing.
- **`journal.py`** — all journal domain logic, zero Flask imports. Same pattern as
  `todo.py`. Imports only `todo.py`'s pure validators (`_HEX_COLOR_RE`,
  `_TAG_NAME_RE`) so hex/name validation has a single source of truth.
- **`app.py`** — thin HTTP layer only: parse request, call domain module, render
  template, redirect. All state-changing routes use **Post/Redirect/Get** and
  `flash()` for validation errors. Config keys `DATA_FILE` and `JOURNAL_FILE` let
  tests point at temp files. Also owns the auto-quit watchdog (see below).
- **`start_server.py`** — double-fork daemon launcher used by `TodoPup.command`
  and the Automator dock app. Starts Flask detached from the calling process so
  macOS Shortcuts/Automator exits immediately rather than waiting for Flask.

### Data files

- **`data/tasks.json`** — task store: `active`, `archive`, `expired` (lists of
  tasks), `tags` (name → hex color registry).
- **`data/journal.json`** — journal store: `sections` (list), `entries` (list).

Both use forgiving `load()` (missing keys defaulted, corrupt files backed up to
`.bak`) and atomic `save()` (temp file + `os.replace`). Extend `load()` and
`_empty()` whenever you add a new top-level key or field.

- **`data/server.log`** — Flask stdout/stderr when launched via the dock app.

---

## Todo app features

### Task model

`id` (uuid4 hex), `title`, `due` (ISO 8601 or null), `created`, `recurrence`,
`tags` (list of names), `notes` (plain-text description, default `""`),
`subtasks` (list of `{text, done}`), `difficulty` (`easy`/`medium`/`hard`, or
unset). Archived tasks add `completed`; expired add `expired_at`.

### Core behaviors

- **Recurring tasks** (`recurrence`: `daily`/`weekly`/`monthly`/`every:N`):
  `refresh()` archives checked tasks (spawning the next occurrence if recurring),
  moves missed recurring occurrences to `expired` and spawns the next future one,
  leaves non-recurring overdue tasks in `active`, then re-sorts.
- **Tags**: titles are highlighted in the first tag's color (translucent,
  text-only via `color-mix`); extra tags render as chips. Colors are user-picked
  hex; tag names are normalized (strip+lowercase) and allowlisted
  (`^[a-z0-9 _-]+$`) — names flow into `style` attributes so keep that
  validation. Filtering (`?tags=a,b`) is multi-select OR semantics on active and
  archive pages; unknown/stale tags are dropped silently.
- **Archive**: completed tasks move here. Accessible via `/archive`.
- **Difficulty**: optional `easy`/`medium`/`hard` rating (`set_difficulty`). A
  reveal-on-check picker appears under a task when it's checked done on the
  active list (square circular-style radios, click again to deselect); editable
  afterward on the Archive page.
- **Notes + subtasks**: each task has an optional plain-text `notes` description
  and a flat `subtasks` checklist. Both are edited inline via a dropdown that
  expands when the task **title** is clicked; a collapsed task with either shows
  a grey "…" hint plus an `n/m` progress count. Edits save in the background via
  small JSON endpoints (`POST /task/<id>/notes`, `/task/<id>/subtasks`,
  `…/<i>/toggle`, `…/<i>`, `…/<i>/delete`) and re-render in place
  (`static/task-details.js`). Pure helpers: `set_task_notes`, `add_subtask`,
  `toggle_subtask`, `edit_subtask`, `delete_subtask`. Subtasks are independent of
  parent completion; a recurring task's next occurrence copies notes + subtask
  text with all checks reset. Read-only on the Archive page.

### Todo templates

`base.html` (layout, nav, shared JS, flash area, global `confirmModal`),
`active.html`, `archive.html`, `edit.html`, `tags.html`, `_macros.html` (shared
`toggle_url` filter-chip macro).

---

## Journal app features

### Entry model

One entry per calendar date (date is the unique key). Fields: `id` (uuid4 hex),
`date` (YYYY-MM-DD), `title`, `body`, `created`, `updated`,
`tags` (`{section_id: [tag names]}`), `numbers` (`{section_id: float}`),
`mood` (integer 1–7, or null).

### Section model

Sections are user-configurable categories that appear on every entry form.
Fields: `id` (uuid4 hex), `name`, `type` (`"tag"` or `"numeric"`), `color` (hex),
`tags` (permanent tag list), `archived_tags` (removed-but-recoverable tags),
`unit` (label for numeric sections, e.g. `"hrs"`), `archived` (soft-delete bool).

Six default tag sections are seeded on first run: people, places, food, chores,
health, work.

### Journal routes

| Route | Purpose |
|---|---|
| `GET /journal` | Today's entry form |
| `GET /journal/<date>` | Entry form for a specific date |
| `POST /journal/save` | Create or update an entry |
| `POST /journal/entry/<id>/move` | Move an entry to a different date |
| `POST /journal/entry/<id>/delete` | Delete an entry |
| `GET /journal/search` | Live search tab (text + tags + numeric range) |
| `GET /journal/sections` | Manage sections & tags |
| `POST /journal/sections/add` | Add a new section |
| `POST /journal/sections/<id>/edit` | Rename, recolor, or update unit |
| `POST /journal/sections/<id>/delete` | Soft-archive a section |
| `POST /journal/sections/<id>/restore` | Un-archive a section |
| `POST /journal/sections/<id>/tags` | Add a permanent tag |
| `POST /journal/sections/<id>/tags/<tag>/delete` | Archive a permanent tag |
| `POST /journal/sections/<id>/tags/<tag>/restore` | Restore an archived tag |
| `POST /journal/sections/<id>/tags/<tag>/promote` | Promote a temporary (entry-only) tag to permanent |
| `POST /journal/sections/<id>/tags/<tag>/demote` | Demote a permanent tag (re-derives as temporary if still on entries, else archives) |
| `POST /journal/sections/<id>/tags/<tag>/archive-temp` | Archive a temporary (entry-only) tag so it stops being derived as temporary |
| `GET /journal/sections/archive` | View archived sections and tags |

### Key journal behaviors

- **One entry per date**: `upsert_entry` creates or updates; date is the key.
- **Permanent vs temporary tags**: tags added via the entry form can be marked
  permanent (added to the section's master list) or temporary (on the entry only).
  Temporary tags render as dashed chips on the edit form.
- **Archived data preservation**: editing an entry never drops data for sections
  that were archived after the entry was written (merged in `journal_save`).
- **Archived tags**: removing a tag from the master list moves it to
  `archived_tags` (not deleted). Re-adding it via the normal form or the archive
  restore route moves it back. Tags are case-insensitive throughout.
- **Calendar widget**: custom dark calendar (`journal.js`) on the entry form shows
  entry dots, supports date navigation, draft-loss protection, and move-to-date
  mode. No third-party libraries.
- **Live search** (`journal-search.js`): entries embedded as JSON; filters in the
  browser. Text filter: whole-word AND across body+title. Tag filter: OR across
  selected tags. Numeric filter: per-section range sliders (bounds auto-derived
  from recorded values). All three combine with AND.
- **Section management**: add tag or numeric sections, rename, recolor, set unit
  label, soft-delete (archive). Archive link is right-justified on the manage page
  title row — not in the nav; the archive page has the inverse right-justified
  "← Manage" back link (`.archive-link.back-link`). Each **tag** section's tags
  live in two drag-and-drop zones (`journal-sections.js`, native HTML5 DnD, no
  libraries): an upper **Permanent** zone (the section's master `tags`) and a
  lower **Temporary** zone (tags used on entries but not in the master/archived
  lists, derived by `temporary_tags`, dashed/italic chips). Dragging a chip
  between zones auto-updates tag state and reloads (PRG): **temp→perm** POSTs
  `/tags/<tag>/promote` (`add_section_tag`); **perm→temp** POSTs
  `/tags/<tag>/demote` (`demote_section_tag` — removes from the master list and,
  if the tag is still used on entries, leaves it un-archived so it re-derives as
  temporary; otherwise archives it). In-chip buttons (no-drag fallback): permanent
  chips have × (the existing archive remove); temporary chips have × that
  **archives** the tag (`/tags/<tag>/archive-temp` → `archive_temporary_tag`, adds
  it to `archived_tags` so it stops being derived). Promotion of a temp tag is
  drag-only (drag it up into the Permanent zone) — there is no promote button.
- **Rich entry body** (`journal-richtext.js`): the body is a `<textarea>` while
  focused and renders formatted text in place on **blur** (click-to-edit). Discord-
  style inline markup: `**bold**`, `*italic*`, `__underline__`, `~~strike~~`
  (nesting of different markers; HTML-escaped first). No third-party libraries.
- **Inline @mention tagging**: an `@name` in the body that matches an existing tag
  (permanent, archived, or a temporary tag used before) is highlighted in that
  tag's section color and added to the day's tags on save (additive, non-
  destructive union with the chips). Underscores match multi-word tags
  (`@alex_dad` → `alex dad`); the rendered highlight drops the `@`. Lookup index
  via `tag_section_index`; parsing via `extract_mentions`; mentions reflect live
  in the chip area on blur (ticking existing chips / injecting temporary ones).
- **Mood** (`journal-mood.js`): an optional **1–7** mood per entry, picked from
  seven Pompompurin GIFs (`static/img/N-pompom.gif`) on the "What happened today"
  line, right-justified. Single-select, click again to deselect; the chosen GIF
  stays full opacity, the others dim. Stored as `mood` on the entry.

### Journal templates

`journal_entry.html` (entry form with calendar, tag chips, numeric inputs, action
row), `journal_search.html` (live search), `journal_sections.html` (section
management), `journal_sections_archive.html` (archived sections & tags).

### Static JS / CSS notes

- **`journal.js`**: calendar widget + move-entry + delete-entry + draft
  protection. Uses `window.confirmModal` (defined globally in `base.html`).
- **`journal-search.js`**: client-side search/filter logic. Search-result tags
  are color-coded by their section (`tag_chips` in `search_index`). On init it
  also marks each result `.entry-tag-chip` as a `.tag-pop-trigger`
  (`data-tagpop`) so clicking a result tag opens the unified tag popover. The
  filter-dropdown checkboxes keep their own `data-tag` attribute, untouched.
- **`tag-popup.js`** (loaded app-wide via `base.html`): the unified, origin-
  marked tag popover. A single delegated `document` click listener on the
  dedicated `data-tagpop="<name>"` attribute (class `.tag-pop-trigger`) — NOT
  bare `[data-tag]`, to avoid the search filter collision. Fetches
  `/tag/<name>/overview`, renders an anchored popover that flips near viewport
  edges, closes on ×/outside-click/Escape, and **Expand →** navigates to
  `/journal/analytics#tag=<name>`. Self-contained mini SVG sparkline; no
  dependency on `analytics.js`. Origin marks: ☑ for a task occurrence, a
  section-colored ● dot for a journal one.
- **`journal-richtext.js`**: click-to-edit body rendering (inline formatting +
  color-coded `@mentions`) and live mention→chip reflection.
- **`journal-mood.js`**: the 7-GIF mood picker (select/deselect, dims the rest).
- **`journal-sections.js`**: drag-and-drop tag reassignment on the manage page
  (native HTML5 DnD). Drop a chip in the Permanent/Temporary zone to promote/
  demote; submits a POST form (PRG reload). Progressive enhancement over the
  in-chip ↑/× button fallbacks. Drop-target highlights via `.tag-zone.drag-over`.
- **`style.css`**: shared dark amber/monospace theme. CSS variables in `:root`:
  `--panel`, `--text`, `--muted`, `--border`, `--accent` (#e0a955 amber),
  `--danger` (#e0524d red). All `<select>` elements use a custom SVG caret
  (`appearance: none`) matching the dark theme. The permanent/temporary tag kind
  picker is a `.kind-toggle` segmented radio control (not a `<select>`).
- **`confirmModal`** is a global Promise-based dark modal defined in `base.html`'s
  inline script. Any `button[data-confirm="message"]` is auto-wired to it.
  Available as `window.confirmModal(message, confirmLabel)` from any page script.

---

## Tag pages / backlinks

Tags are first-class entities: clicking a tag chip opens a lightweight,
**unified** popover summarizing that tag across **both** domains (tasks +
journal), and **Expand →** deep-links to the **Tags** tab on the
analytics page (pre-searched). The feature **unifies by name** (one `work` page merges both
namespaces) but **marks each occurrence's origin**: ☑ for a task, a section-
colored ● dot for a journal entry.

### Route

`GET /tag/<name>/overview` — a thin HTTP layer mirroring `journal_analytics_data`
(read-only JSON, no PRG). Each domain computes its own side; the route merges:

```
jsonify({
   "name":    name.lower(),
   "task":    todo.tag_overview(todo.load(data_file()), name, from, to),
   "journal": journal.tag_overview(journal.load(journal_file()), name, from, to),
})
```

Reads optional `?from=&to=` inclusive date bounds and passes them through. The
popup omits the range; the deep Tag tab sends its current range. An unknown tag
returns 200 with an empty-ish payload (zero counts, empty lists).

### Pure helpers (zero cross-import; each domain owns its side)

- **`journal.tag_overview(data, name, start=None, end=None)`** — scans every
  entry's `{section_id: [names]}`, case-insensitively. Returns `sections`
  (`[{id, name, color}]`), `entries`/`first`/`last`, `avg_mood`,
  `baseline_mood` (mean mood over all in-range entries), `uplift`
  (`avg_mood − baseline_mood`; all mood aggregations ignore null moods),
  `mood_series`, `dow` (7 counts Mon–Sun), `cooccurring`
  (`[{name, section_id, count}]`), and `timeline`
  (`[{date, snippet, sections, mood}]`, newest first).
- **`todo.tag_overview(data, name, start=None, end=None)`** — scans
  `active`/`archive`/`expired`, case-insensitively, filtering on each task's
  representative date (completed → expired_at → created). Returns `exists`
  (in the `data["tags"]` registry) + `color`, `active`/`completed`/`expired`
  counts, `first`/`last`, `lead_time_days` (mean `due − completed` in days over
  completed tasks that had a due date — **positive = finished early**, null when
  none), `cooccurring` (`[{name, count}]`), and `timeline`
  (`[{date, title, status, due, completed}]`, newest first).

### Entry points (where the popover triggers; v1)

- **Archive page (`archive.html`)** — every task tag renders as a named
  `.tag-pop-trigger` chip beside the title (the first-tag title highlight stays
  as a color cue). Does not disturb the title-toggle details dropdown.
- **Journal search (`journal_search.html`)** — result `.entry-tag-chip` chips
  become triggers (marked in `journal-search.js`). Filter checkboxes untouched.

Deferred: active task list, analytics chart labels, sections manage page.

### Analytics restructure (the deep view)

The `/journal/analytics` page gained a top-right **`Journal | Task` lens toggle**
(`.analytics-lens`, in the new `.analytics-tabrow`). **Overview** always renders
**outside** the toggle (its content is unchanged here — a deferred follow-up will
upgrade it). The lens swaps the deeper tabs:

| Lens | Tabs |
|---|---|
| Shared (always) | **Overview** · **Tags** |
| **Journal** | Mood · Consistency · Numeric · Coverage |
| **Task** | Throughput · Timeliness · Adherence · Difficulty |

The old single **"Tasks"** tab was **refactored** into the Task-lens sub-tabs
(no chart lost): `task-throughput`/`task-entry-calendar` → Throughput;
`task-overdue`/`task-numeric-scatter` → Timeliness; `task-adherence` →
Adherence; `task-difficulty` → Difficulty. The separate **"Task tags"** tab is
**gone**: its `task-tag-frequency` chart was merged into the cross-domain
**Tags** tab. Because tags are unified by name across domains, **Tags** is
`lens: ["journal", "task"]` (shown in both lenses, like the **Tag** detail tab)
and carries every tag chart in order — the journal tag analytics (frequency,
trend, per-tag heatmap, co-occurrence) first, then the task-tag analytics
(`task-tag-frequency`). It has no tab-level `needs`: the journal charts always
render, and the task-tag chart shows its normal `U.empty(...)` state when there
are no tasks. `PANELS` entries carry an optional `lens: [...]`; a tab with no
lens is shared, and the **Tags** tab lists both lenses. The **Tags** tab has a
bespoke `renderTagsTab()` (outside the `CHARTS` loop): a search box on top, and
below it **the all-tags overview by default** (the aggregate `panel: "tags"`
charts) which a **per-tag detail replaces once a tag is searched** (cleared
search returns to the overview). The search box has a custom **live-preview
dropdown** scoped to the active lens — the **Journal** lens lists only journal
(section) tags, the **Task** lens only task-registry tags; matches update as you
type, each origin-marked (☑ task / ● journal), with arrow-key + click select,
and the preview **commits and hides on Enter**. Per-tag detail is an async fetch
of `/tag/<name>/overview` (cached per name+range), rendered **lens-aware**
(journal half vs task half), reusing the `U.*` SVG utilities and the
mood-over-time chart pattern. On load it reads `#tag=<name>` from the URL hash to
open the Tags tab pre-searched; it refetches on tag change and date-range change.

### Files

New: `static/tag-popup.js`. Modified: `journal.py`, `todo.py`, `app.py`,
`static/analytics.js`, `static/journal-search.js`, `templates/base.html`,
`templates/archive.html`, `templates/journal_analytics.html`, `static/style.css`
(`.tag-pop*`, origin marks `.origin-task`/`.origin-dot`, `.analytics-lens*`,
Tag-detail `.deep-*`/`.callout*`/`.cooc-*`).

---

## Testing convention

Tests are written first (TDD). Unit tests use a fixed `now` and pytest's
`tmp_path` for file I/O; route tests use Flask's `test_client()` with a temp
data file. Initialize stores with `todo._empty()` / `journal._empty()` rather
than hand-built dicts. Preserve the injectable `now` pattern in any new
time-sensitive logic.

---

## Auto-quit (dock app mode)

When Flask is started with `AUTO_QUIT=1` (set by `start_server.py`), a
background watchdog thread in `app.py` keeps the server alive while at least one
browser tab is open and shuts it down promptly after the last tab closes. It
tracks open tabs by id rather than a single global timer:

- Each tab generates a unique id and registers via `GET /heartbeat?tab=<id>`.
- The heartbeat runs inside a **Web Worker** (inline Blob worker in `base.html`),
  not a main-thread `setInterval`, because a worker's timer is *not* subject to
  the ~1/min throttle browsers impose on hidden tabs. This means a tab that is
  open **but backgrounded** keeps the server alive.
- On `pagehide`, each tab fires `navigator.sendBeacon('/quit?tab=<id>')`. When
  the last tab deregisters, the watchdog quits after a short grace window
  (`_QUIT_GRACE`, 2 s) via `os.kill(os.getpid(), SIGTERM)`.
- The grace window exists because this is a server-rendered app: `pagehide` also
  fires on ordinary page-to-page navigation, and the next page re-registers
  within the window, cancelling the shutdown. A real tab close never
  re-registers, so the server quits ~2 s later.
- A crashed/force-quit browser never sends a beacon; its heartbeat goes stale
  and the tab is evicted after `_STALE_AFTER` (60 s) as a fallback.

The watchdog only arms once a tab has registered, so the server never auto-quits
before any browser tab has loaded. The decision logic is factored into pure,
clock-injectable helpers (`_register_tab`, `_unregister_tab`, `_should_quit`,
`_reset_watchdog`) so it is unit-tested without real threads/timers. Tests don't
set `AUTO_QUIT=1` so the watchdog thread never starts.

### Related files

- `start_server.py` — double-fork daemon; sets `AUTO_QUIT=1` before `execv`
- `TodoPup.command` — calls `start_server.py`, polls until ready, opens browser
- `docs/automator/document.wflow` — Automator app embedded script (same logic)
- `docs/automator/install.sh` — installs `/Applications/TodoPup.app` from repo
- `SETUP.md` — full setup instructions for a new machine

---

## Roadmap / next steps

The app is a combined **daily journal + to-do** with an analytics-ready data
model (numeric sections stored as floats, entries keyed by stable section ids,
sections soft-deleted for historical continuity).

### Data analytics page — DONE (journal data)

The `/journal/analytics` page is **implemented and shipped** for journal data.
Most analytics functionality is complete; only minor UI polish remains.

What exists today:

- **Routes**: `GET /journal/analytics` (page shell) and
  `GET /journal/analytics/data` (`jsonify(journal.analytics_payload(data))`).
- **Pure aggregation helpers** in `journal.py` (all testable, injectable date
  bounds): `analytics_payload`, `describe`, `tag_frequency`, `tag_cooccurrence`,
  `tag_trend`, `tag_streak`, `entry_streak`, `numeric_series`, `dow_averages`,
  `word_counts`, `entry_gaps`, `creation_hours`, `date_density`,
  `section_coverage`, plus `_filter_entries_by_date`. **Expanded numeric helpers**
  (all ignore entries lacking the value, degrade gracefully on too few points):
  `numeric_stats` ({count, mean, median, stdev, min, max, latest}),
  `numeric_histogram` ([{lo, hi, count}] buckets, all-equal → single bucket),
  `numeric_regression` ({slope, intercept, n} least-squares vs day-index),
  `numeric_by_date` ([{date, value}]), `numeric_correlation_matrix`
  ({pairs:[{a,b,r,n}]} pairwise Pearson, one per pair, n≥2),
  `numeric_period_delta` ({current_mean, previous_mean, delta, pct} vs the
  preceding equal-length window), `numeric_streaks` ({longest_above,
  longest_below, current} vs the range mean; current is signed),
  `numeric_cumulative` ([{date, total}] running sum), `numeric_coverage`
  ({logged, total_entries, pct}); plus internal `_numeric_values`/`_pearson`.
  **Mood helpers** (all
  ignore null moods): `mood_series`, `mood_dow_averages`, `mood_distribution`,
  `mood_by_date`, `mood_numeric_pairs` (same-day mood↔numeric pairs for
  correlation), and `_entry_mood` (the defensive 1..7-or-None reader).
  `analytics_payload` now carries each entry's `mood` (int 1–7 or null).
- **`static/analytics.js`** — vanilla SVG charts via a `CHARTS` registry
  (add a chart = append one descriptor). Tabs: Overview, **Mood** (gated on any
  recorded mood via `hasMood`), Consistency (entry calendar, words/entry, gaps,
  time-of-day), the cross-domain **Tags** tab (journal frequency, trend, per-tag
  heatmap, co-occurrence, then task-tag frequency — shown in both lenses),
  the expanded **Numeric** tab (see below), Coverage, plus
  a **`Journal | Task` lens toggle** that swaps the deeper tabs (the old single
  "Tasks" tab is now the Task-lens sub-tabs Throughput/Timeliness/Adherence/
  Difficulty; the former separate "Task tags" tab is folded into the shared Tags
  tab) and a shared **Tag** detail tab — see the "Tag pages / backlinks" section
  above. Shared date-range filter; refetches on load and on
  window focus (10s debounce). Colors read from CSS vars + section hex.
  - **Mood tab**: mood-over-time (fixed 1–7 axis + 7-day rolling avg overlay),
    average mood by day of week, mood distribution histogram, and mood-vs-numeric
    scatter (one small-multiple per numeric section, with a Pearson `r`).
  - **Numeric tab** (gated on `hasNumeric`) is a rich multi-chart tab reading
    top-to-bottom — overview → trends → shape → relationships → streaks/coverage:
    per-section **stat cards** (mean/median/std/min/max/latest/count); **values
    over time** with a 7-pt rolling avg overlay AND a dashed least-squares trend
    line + rising/falling slope annotation; **cumulative total** line; **period
    delta** stat cards (this date-range window vs the immediately preceding equal
    window, ▲/▼ per section); **distribution histogram**; **calendar heatmap**
    (per section, days shaded dark→section-color by value, via
    `buildValueMonthGrid`); average-by-day-of-week bars; pairwise **correlation
    matrix** (tinted by sign/magnitude, accent=+ / danger=−, shown when ≥2
    numeric sections); **above/below-average streaks** callout; **coverage** bars
    (how often each number is logged); and the two-section correlation scatter.
    JS mirrors the `numeric_*` pure helpers (`linearRegression`, `pearson`,
    `isoShift`, `buildValueMonthGrid` are the new JS-side mirrors).
  - **Section scope filter** (Numeric & Tags tabs): a row of toggle chips
    (`renderSectionFilter` → `.section-filter`) picks which sections show — all
    active by default, click to narrow, "All" resets. Charts read the (filtered)
    `sections` argument, so a single narrowed list scopes every chart at once:
    the **Numeric** tab filters numeric sections (`_secSel.numeric`); the
    **Tags** tab's aggregate view filters tag sections (`_secSel.tag`; the
    non-section task-tag chart always shows). State lives in `_secSel`
    (`null` = all).
  - **Overview tab** is an at-a-glance dashboard: prominent **stat cards**
    (entries this period, current/longest streak, avg mood + a tiny mood
    sparkline, tasks completed, latest value per numeric section) and an
    auto-generated **Insights** list (`buildInsights`: weekend-vs-weekday mood,
    best good-mood stretch, streak milestone, strongest mood↔numeric
    correlation), plus a compact secondary stats row. Styles: `.stat-cards` /
    `.stat-card*`, `.stat-spark`, `.insights*` in `style.css`.
- **`templates/journal_analytics.html`** + analytics styles in `style.css`
  (`.analytics-*`, `.chart-svg`/`.chart-svg-fixed`). Tests in
  `tests/test_journal_analytics.py` and route tests in `test_journal_app.py`.

**Remaining: minor UI changes** — small layout/styling polish only.

### Mood analytics — DONE

The per-entry mood (1–7) is surfaced on the analytics page via the `CHARTS`
registry. A dedicated **Mood** tab (gated on `hasMood`) carries mood over time
(rolling avg overlay), average mood by day of week, mood distribution, and
mood-vs-numeric correlation; the **Overview** tab gained an average-mood stat
card with a sparkline plus auto-insights that reference mood. Pure helpers live
in `journal.py` (`mood_series`, `mood_dow_averages`, `mood_distribution`,
`mood_by_date`, `mood_numeric_pairs`); see the analytics description above.

### Task data in analytics — DONE

The `/journal/analytics` page now has a **Tasks** tab combining to-do data with
journal data: completion throughput over time, overdue/expiry trends, recurring-
task adherence, difficulty breakdown, and task tags — plus cross-domain charts
(tasks-vs-numeric scatter, entry/completion calendar). Pure task-side aggregation
helpers live in `todo.py` (e.g. `completion_throughput`, `difficulty_breakdown`);
the analytics route merges a task payload into the data feed. Built on the same
`CHARTS` registry + SVG utilities in `analytics.js`; no new dependencies.

### Shipped quality-of-life features

Each was spec'd first under `docs/superpowers/specs/` (brainstorm → spec →
subagent implementation, TDD). See the feature sections above for detail:

- **Task notes + subtasks** (inline dropdown on the active list).
- **Rich journal entries** — Discord-style inline formatting + `@mention` tagging.
- **Mood quick-pick** — optional 1–7 per-entry mood via 7 Pompompurin GIFs.

### Future features

Planned additions, in priority order (specs to be written first, as above):

- **Today dashboard** — a combined landing view: tasks due today (with subtask
  progress), today's journal entry + mood, and streak/stat tidbits. Cross-domain;
  reuses `entry_streak`, `today_iso`, and due-date filtering. Likely a new
  `/today` route linked from both navs (purely additive).
- **Command palette (⌘K)** — app-wide fuzzy jump to any page/action, quick-add a
  task, jump to a date.
