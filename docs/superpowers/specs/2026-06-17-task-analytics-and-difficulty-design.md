# Task Analytics + Difficulty Rating — Design Spec

**Date:** 2026-06-17
**Status:** Approved for planning
**Author:** Julia Xi (with Claude)

## Summary

Two related additions to the to-do side of Datapom, built in one pass:

1. **Difficulty rating** — when a task is checked done (before Refresh archives
   it), an optional **easy / medium / hard** picker appears below it. The choice
   is saved on the task and is editable later on the Archive page.
2. **Task analytics** — a new **"Tasks" tab** inside the existing
   `/journal/analytics` page that holds *all* task analytics: completion
   throughput, overdue/expiry trends, recurring-task adherence, difficulty
   breakdown, task-tag frequency/trend, and cross-domain charts correlating task
   activity with journal data.

The difficulty data is also an analytics dimension, so it's built first as the
foundation. "Polish" of the tasks UI is folded in opportunistically where this
work touches `active.html` / `archive.html` — not a separate effort.

## Goals

- Capture an optional difficulty per completed task; edit it later on Archive.
- A single "Tasks" analytics tab unifying task metrics with the existing page.
- Cross-domain view: task activity alongside journal numbers and entry days.
- Preserve the pure-logic / HTTP split, the dark theme, and "no new deps".

## Non-Goals

- A separate `/tasks/analytics` page or a separate "Cross-domain" tab (all task
  analytics live in the one new "Tasks" tab).
- Changing the existing journal analytics tabs (Tags tab stays journal-only).
- Requiring a difficulty to be chosen (it is always optional).
- Difficulty on the add/edit forms (it's set at completion, edited on Archive).

## Architecture

Mirrors the existing analytics design exactly. Today `GET /journal/analytics/data`
returns **raw** journal data and `static/analytics.js` does all aggregation and
date-range filtering **in the browser**, rendering through the `CHARTS` registry
+ shared SVG utilities.

- **`todo.py`** — pure, testable, injectable-`now` aggregation helpers for the
  non-trivial task math (recurring adherence, completed-vs-due lateness,
  difficulty rollups), plus `set_difficulty` and an extended `refresh`. These are
  the unit-tested source of truth for the logic (mirrors the journal helpers).
- **`app.py`** — the analytics data route loads the task store too and merges a
  **`tasks` block of raw task records** into the payload. Difficulty
  capture/edit routes follow Post/Redirect/Get + `flash`.
- **`static/analytics.js`** — new chart descriptors (panel `"tasks"`) that
  aggregate the raw task records client-side (same pattern as the journal
  charts) and reuse the existing SVG helpers, calendar component, and the shared
  date-range filter. Simple counts are done in JS; the trickier logic is also
  covered by the `todo.py` helpers.
- **No new dependencies.**

## Data model

A task gains an **optional** `difficulty` field, value in
`{"easy", "medium", "hard"}`; absent/`None` = unrated. It is stamped when a task
is completed (so it lives on archived tasks) and editable on Archive. Because it
is optional and always read with `.get(...)`, **no `load()` migration is
required** — older stores simply have unrated tasks.

Spawned next occurrences of a recurring task do **not** inherit difficulty (each
occurrence is rated on its own completion).

### Analytics payload — `tasks` block

The data route merges into the existing payload:

```jsonc
"tasks": {
  "active":  [ { "id","title","created","due","recurrence","tags" } ],
  "archive": [ { "id","title","created","completed","due","recurrence","tags","difficulty" } ],
  "expired": [ { "id","title","created","expired_at","due","recurrence","tags" } ],
  "tags":    { "<name>": "<hex color>" },          // task tag registry (for coloring)
  "date_range": { "min": "YYYY-MM-DD", "max": "YYYY-MM-DD" }  // spans completed/expired/created
}
```

JS aggregates this client-side and applies the shared date filter, just like the
journal `entries`.

## Feature 1 — Difficulty rating

### Active list (reveal-on-check)
- Each task row's circular checkbox (`.task-check`), when checked, reveals a
  **segmented control** below the task — reusing the existing `.kind-toggle`
  segmented-radio style (not a `<select>`). Options: Easy / Medium / Hard,
  radios named `difficulty:<task_id>`, **no default selected** (optional).
- Toggled purely client-side (a small inline script keyed off each
  `.task-check`'s `change`): checked → show its picker; unchecked → hide and
  clear it. The pickers sit inside the existing Refresh `<form>`, so they submit
  with it.

### Save on completion
- `refresh()` route reads `difficulty:<id>` for each completed id and passes a
  `{id: value}` map to `todo.refresh(data, completed_ids, difficulties=None,
  now=None)`. As each completed task is archived, a valid difficulty is stamped
  onto the archived copy; missing/invalid values leave it unrated.

### Edit later on Archive
- Archive rows show the difficulty as a small chip (or "unrated"), with an inline
  control to change it → `POST /archive/<task_id>/difficulty` (form field
  `difficulty`) → `todo.set_difficulty(data, task_id, value)` → save → redirect
  back to Archive (PRG). An empty value clears the rating.

### Validation
- `_DIFFICULTIES = {"easy", "medium", "hard"}`. `set_difficulty` and the refresh
  capture accept only these (case-normalized) or empty (= unrated/clear);
  anything else is ignored. No difficulty string ever flows into a `style`
  attribute, but it is still allowlisted for cleanliness.

## Feature 2 — Task analytics (the "Tasks" tab)

A new tab `"tasks"` in `analytics.js`'s tab list and `CHARTS` descriptors with
`panel: "tasks"`. All charts honor the shared date-range filter and read colors
from CSS vars + the task tag registry. Charts:

- **Completion throughput** — tasks completed per day/week over the range
  (bucketed line/bar), from `archive[].completed`.
- **Overdue & expiry trends** — completed-late rate (`completed` > `due`) and
  expired tasks per period (`expired[].expired_at`).
- **Recurring adherence** — for recurring tasks, completed occurrences vs. missed
  (expired) occurrences — a hit-rate, overall and/or over time.
- **Difficulty breakdown** — distribution of easy/medium/hard among completed
  tasks, and difficulty mix over time. Unrated excluded from the mix (counted
  separately if useful).
- **Task tags** — task-tag frequency and over-time trend (reusing the journal
  tag chart shapes), colored from the task tag registry.
- **Cross-domain (tasks × journal)** — tasks-completed-per-day vs. a chosen
  journal numeric section (scatter + correlation, reusing the numeric scatter
  chart), and a **calendar heatmap overlaying** task-completion days with
  journal-entry days (reuse the analytics month-grid calendar; distinguish
  entry-days vs. task-completion-days, e.g. two-tone / dot).

Empty/edge states reuse the existing "No data in this range." pattern.

## Polish (folded in, light)

While touching `active.html` (difficulty reveal) and `archive.html` (difficulty
chip + editor), tidy rough edges encountered — spacing, the reveal transition,
archive-row alignment. No unrelated refactors. Any specific task-UI gripes the
user raises get rolled into this pass.

## Error handling

- Difficulty routes use PRG + `flash` on bad input; an unknown task id is a safe
  no-op (mirrors existing task routes).
- Analytics data route tolerates empty/missing task store (empty lists), and the
  charts render the empty state.

## Testing (TDD)

- **`tests/test_todo.py`** (or new `tests/test_task_analytics.py`): unit tests
  with fixed `now` / `tmp_path` for `set_difficulty` (valid/invalid/clear),
  `refresh` stamping difficulty onto archived tasks (and ignoring invalid /
  not carrying to spawned occurrences), and the aggregation helpers
  (throughput, completed-late, expiry counts, recurring adherence, difficulty
  rollups). Initialize stores via `todo._empty()`.
- **`tests/test_app.py`**: route tests — Refresh captures `difficulty:<id>`;
  `POST /archive/<id>/difficulty` sets/clears and redirects; the analytics data
  endpoint includes a well-formed `tasks` block.
- Existing suites stay green.

## Build order

1. Difficulty data + logic (`refresh` difficulties, `set_difficulty`) + tests.
2. Active-list reveal-on-check picker; Archive chip + editor + route.
3. Task aggregation helpers in `todo.py` + the `tasks` payload merge + tests.
4. `analytics.js`: the "Tasks" tab + chart descriptors (throughput, overdue/
   expiry, adherence, difficulty, task tags, cross-domain) + styles.
5. Light polish pass on the touched task views.

## Follow-ups / out of scope

- Difficulty-weighted productivity scoring, goal-setting, or notifications.
- Exporting analytics; any server-side aggregation refactor of the existing
  journal charts.
