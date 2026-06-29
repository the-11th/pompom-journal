# Analytics Overview upgrade — design spec

**Date:** 2026-06-28
**Status:** Approved, ready for implementation
**Feature family:** combined journal + to-do, cross-domain analytics

## Summary

Upgrade the analytics **Overview** tab from a static readout into a richer
cross-domain dashboard that *talks and routes you onward*. Overview stays the
shared tab outside the `Journal | Task` lens toggle. Five additions:

1. **Delta cards** — every hero stat card gains a ▲/▼ vs the previous equal window.
2. **Combined activity heatmap** — one calendar blending journal + tasks + mood.
3. **Drivers board** — a ranked "what moves my mood" list (tag uplift + numeric
   correlation + difficulty→mood).
4. **Suggestions** — frequent meaningful words / tag suggestions, plus a
   dormant-people nudge ("haven't tagged Alex in 24 days").
5. **Clickable launchpad** — cards, drivers, and suggestions link into the
   relevant deep tab.

No new dependencies. Hand-rolled SVG + vanilla JS. Pure logic stays in
`journal.py` (TDD); JS stays presentational, consistent with the existing
Overview which computes client-side from the fetched `_data`.

## Layout (top → bottom)

The dashboard reads as *where am I now → how am I trending → what drives me →
what to act on*:

1. **Hero stat cards** (existing, now with deltas): entries, current streak,
   avg mood + sparkline, tasks completed, latest value per numeric section.
2. **Combined activity heatmap**.
3. **Drivers board**.
4. **Insights** (existing `buildInsights` auto-insights — kept).
5. **Suggestions** (frequent words / tag suggestions + dormant people).
6. **Compact secondary stats** (existing — kept).

## Components

### 1. Delta cards

Each hero card shows a **▲/▼ delta vs the previous equal-length window** — the
window of the same length immediately preceding the active date range (e.g. this
30 days vs the prior 30). Metrics: entries count, avg mood, tasks completed,
words written. Green ▲ for up, red ▼ for down, muted/omitted when flat or when
the previous window has no data.

Computed in **JS** from the full `_data.entries` / `_data.tasks` by shifting the
active `[_from, _to]` range back one window length — range-aware with no
refetch, matching how the Overview already computes everything client-side. When
the range is open-ended (no `_from`/`_to`), skip deltas gracefully.

### 2. Combined activity heatmap

A month-grid calendar (reusing the existing `buildMonthGrid` / month-grid
pattern used by the consistency and numeric-value calendars) where each day
blends **both domains**:

- **Tint** = that day's mood color (mood 1–7 mapped onto a low→high ramp; neutral
  when no mood logged).
- **Intensity / mark** = activity volume: whether a journal entry exists + the
  number of tasks completed that day.
- Day cell `title` (hover) summarizes the mix (mood, entry yes/no, tasks done).

Pure JS over `_data.entries` + `_data.tasks`. Honors the active date range (one
grid per spanned calendar month, like the other calendars).

### 3. Drivers board

A ranked, one-line-per-driver list of what correlates with mood, newest-signal
first by |effect|:

- **Tag uplift** — average mood on days a tag appears vs the overall baseline
  (e.g. "exercise **+0.8**"). Backed by the pure helper `mood_tag_uplift`
  (below); JS mirrors it for range-aware rendering, like `pearson`/`rollingAvg`.
- **Numeric correlation** — strongest mood↔numeric-section Pearson r (e.g.
  "sleep **r=+0.5**"). Reuses existing JS `pearson` over filtered entries.
- **Difficulty → mood** — average mood on days a `hard` task was completed vs
  other days (cross-domain; computed in JS from `_data.entries` + `_data.tasks`).

Each row is **origin-marked** (☑ task-side / ● journal section color) and
**clickable** (→ relevant deep tab; see Launchpad). Rows with too little data
(below a small `min_n`) are dropped. Range-aware.

### 4. Suggestions area

Two blocks, both **as-of-now / all-time** (not range-dependent), so they are
computed **server-side in `analytics_payload`** and rendered directly — no
refetch on range change:

- **Frequent words / tag suggestions** — the top recurring meaningful words in
  entry bodies, with a built-in stopword list (`_STOPWORDS`) stripping common
  words ("the", "that", "this", "and", …) and very short tokens. Words that
  recur but are **not already a tag** (in any section's `tags`/`archived_tags`,
  case-insensitive) are flagged as **suggested tags**. Helpers `word_frequency`
  + `tag_suggestions`.
- **Dormant people** — tags in the **people** section (section whose name is
  "people", case-insensitive) that were used before but **not in the last 21
  days**, surfaced as "haven't tagged **Alex** in 24 days." Helper
  `dormant_tags(data, now=None, section_name="people", threshold_days=21)`.

### 5. Clickable launchpad

Cards, drivers, and suggestions switch the in-page lens + tab (no full reload):

- numeric stat card → **Numeric** tab (scope filter narrowed to that section via
  the existing `_secSel.numeric`)
- avg-mood card → **Mood** tab
- tasks-completed card → **Task** lens, **Throughput** tab
- a driver/suggestion naming a tag → **Tags** tab pre-searched (reuse the
  existing tag-search commit / `#tag=` mechanism: set `_tagQuery`, switch to the
  Tags tab, render)

Implemented with click handlers that call the existing `switchLens`/`switchTab`
and tag-search entry points. Cards are keyboard-focusable where practical.

## Data layer — new pure helpers in `journal.py` (TDD)

All take plain dicts/lists and injectable `start=None, end=None` bounds where
range-relevant, mirroring existing analytics helpers; all ignore null moods and
degrade gracefully on thin data.

- **`_STOPWORDS`** — a module-level set of common English stopwords (+ a min
  token length) used by word frequency.
- **`word_frequency(entries, start=None, end=None, limit=None)`** →
  `[{word, count}]` over entry bodies, lowercased alphanumeric tokens, excluding
  `_STOPWORDS` and sub-min-length tokens, sorted by count desc then word.
- **`tag_suggestions(data, entries=None, start=None, end=None, limit=None)`** →
  `[{word, count}]`: the `word_frequency` results whose word is **not** already a
  registered/known tag in any section (`tags` ∪ `archived_tags`, case-insensitive).
- **`dormant_tags(data, now=None, section_name="people", threshold_days=21)`** →
  `[{name, section_id, last_date, days_since}]` for tags in the matching
  section(s) that have appeared on some entry but whose most recent appearance is
  `>= threshold_days` before `now`; sorted most-dormant first.
- **`mood_tag_uplift(entries, start=None, end=None, min_n=2)`** →
  `[{name, section_id, avg_mood, baseline, uplift, n}]` per tag (avg mood on days
  the tag appears minus the in-range baseline mean mood), `n >= min_n`, sorted by
  `abs(uplift)` desc.

## Payload extension

`analytics_payload(data)` gains two keys, computed with `today_iso()` (so they
are range-independent and need no refetch):

- `"suggestions"`: `tag_suggestions(data, ...)` output (capped to a small limit).
- `"dormant"`: `dormant_tags(data, now=today)` output.

`entries`/`sections`/`tasks` are unchanged. The JS `applyData` already stores the
whole payload, so the Overview render reads `_data.suggestions` / `_data.dormant`.

## Front-end (`static/analytics.js`)

- The `overview` panel `render` is extended (or split into small render helpers)
  to add, in order: delta-annotated hero cards, the combined activity heatmap,
  the drivers board, (existing insights), the suggestions block, (existing
  secondary stats).
- New JS module helpers (presentational, mirroring the pure helpers where
  range-aware): a `previousWindow(...)` shifter for deltas, a combined
  day-blend grid builder reusing the month-grid utilities, and a `moodTagUplift`
  mirror for the drivers board.
- Click handlers wire the launchpad via existing `switchLens`/`switchTab` and the
  Tags-tab search entry point.

## Styles (`static/style.css`)

Reuse existing `.stat-card*`, `.insights*`, `.analytics-cal`/`.cal-*`,
`.cooc-list`/`.cooc-*`, `.callout*` where possible. Add only what's needed:
delta annotation (`.stat-delta.up/.down`), drivers list, suggestions chips, and
the combined heatmap legend — matching the dark amber/monospace theme and CSS
variables.

## Testing

- `tests/test_journal_analytics.py`: `word_frequency` (stopword + min-length
  filtering, ordering), `tag_suggestions` (frequent-and-untagged only,
  case-insensitive against `tags`+`archived_tags`), `dormant_tags` (fixed `now`,
  threshold boundary, people-section match, ignores never-used tags),
  `mood_tag_uplift` (uplift = tag-mean − baseline, null-mood ignored, `min_n`
  gate, ranking).
- A route/payload test that `analytics_payload` (via the data route) includes
  `suggestions` and `dormant` keys with sane shapes.
- JS stays presentational (no JS harness), consistent with the existing Overview.
- Initialize stores with `journal._empty()`; use a fixed `now` and `tmp_path`.

## Files touched

Modified: `journal.py`, `static/analytics.js`, `static/style.css`, `CLAUDE.md`,
`tests/test_journal_analytics.py` (and a payload assertion in the journal route
tests if cleaner). New: this spec.

## Out of scope

- Numeric goals/targets (a separate future feature).
- Other menu ideas not selected (unified day-stream chart, personal-records
  strip, on-track ring, needs-attention callouts).
- Refetch-on-range-change plumbing — avoided by keeping range-aware pieces in JS
  and the two suggestion blocks range-independent.
