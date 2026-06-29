# Smarter tag suggestions (v2) — design spec

**Date:** 2026-06-29
**Status:** Approved, ready for implementation
**Area:** journal analytics Overview → Suggestions

## Summary

Upgrade the Overview "Suggestions" area from a passive frequent-word list into a
smart, actionable workflow:

1. **Smarter filtering** — a bigger stopword list (so "everything"/"something"/
   etc. never suggest) + only suggest words used on **≥3 distinct days** within
   the **last 30 days** of entries.
2. **Dismiss** — each suggestion has an ×; dismissing suppresses it for **30
   days** (persisted in `journal.json`).
3. **Click → popup** — pick **permanent vs temporary**, the **section**, and the
   **days** (with text snippets of where the word appears) to apply the tag to.
4. **Confirm** applies the tag and removes the suggestion.

No new dependencies. Pure logic in `journal.py` (TDD); thin routes in `app.py`;
vanilla-JS popup in the analytics page.

## Filtering & windowing

- **Window:** suggestions are computed over entries dated within the last
  `window_days=30` relative to `now` (today) — independent of the analytics
  date-range filter.
- **Threshold:** a word qualifies only if it appears on **≥3 distinct days** in
  the window (`min_days=3`).
- **Stopwords:** expand `_STOPWORDS` to a comprehensive English list (function
  words + common-but-meaningless words: "everything", "something", "anything",
  "nothing", "really", "going", "want", "need", "just", "like", "today",
  "actually", "maybe", "still", "even", "much", "many", "lot", "thing(s)",
  "feel", "felt", etc.). Keep `_MIN_WORD_LEN`.
- **Known tags excluded** (existing behavior): a word that already matches any
  section's `tags ∪ archived_tags` (case-insensitive) is not suggested.
- **Dismissed excluded:** words dismissed within the last 30 days are skipped.

## Persistence (journal.json)

New top-level key **`dismissed_suggestions`**: `{ word: "YYYY-MM-DD" }` (the date
it was dismissed). `_empty()` seeds `{}`; `load()` defaults it when missing (per
the forgiving-load convention). A word is suppressed while
`days_since(dismissed_date) < 30`; on/after 30 days it may resurface.

## Pure helpers (journal.py, TDD)

- **`_STOPWORDS`** — expanded set (see above).
- **`tag_suggestions(data, now=None, window_days=30, min_days=3, limit=None)`** →
  `[{word, count, days}]` where `days` = distinct-day count in the window.
  Pipeline: window-filter entries → tokenize bodies → drop stopwords/short
  tokens → drop known tags → keep words with `days >= min_days` → drop words in
  `dismissed_suggestions` still within the 30-day cooldown → sort by `days` desc
  then `count` desc then word → cap to `limit`. (Replaces the current
  all-time/no-threshold behavior. `word_frequency` stays as the lower-level
  primitive; `tag_suggestions` adds the day-tracking + filters.)
- **`suggestion_occurrences(data, word, now=None, window_days=30, snippet_radius=40)`**
  → `[{date, snippet}]`, one per entry (in the window, newest first) whose body
  contains `word` as a whole word (case-insensitive). `snippet` = the body text
  around the first match (± `snippet_radius` chars, trimmed to word boundaries,
  with leading/trailing "…" when truncated). The matched word is wrapped in a
  marker (e.g. `**word**` or returned with match offsets) so the client can
  highlight it. Defensive on missing/empty bodies.
- **`dismiss_suggestion(data, word, now=None)`** — sets
  `data["dismissed_suggestions"][word.lower()] = today`. Idempotent.
- **`apply_tag_suggestion(data, word, section_id, dates, permanent, now=None)`** —
  applies tag `word` to the given `dates`:
  - `permanent=True`: add `word` to the section's master list via the existing
    `add_section_tag(data, section_id, word)`, **and** tag each date's entry.
  - `permanent=False` (temporary): tag each date's entry only (no master-list
    change) → it derives as a temporary tag.
  - For each date: get-or-create that day's entry and add `word` to
    `entry["tags"][section_id]` (dedup, case-insensitive). Reuse existing
    entry/tag plumbing (`get_entry_by_date`/`upsert_entry`/`merge_entry_tags`)
    rather than hand-rolling. Unknown section id → no-op/raise consistent with
    siblings. Validates `word` via the existing tag-name validator.

After apply, `word` is a known tag, so `tag_suggestions` naturally drops it.

## Payload

`analytics_payload(data)` keeps the `suggestions` key but now returns the v2
`tag_suggestions(data, now=today_iso())` output (`[{word, count, days}]`). The
`dormant` key is unchanged.

## Routes (app.py — thin)

- **`GET /journal/suggestions/<word>`** → `jsonify({ word, sections:
  [{id,name,color}] (active tag sections), occurrences: [{date, snippet}] })`.
  Feeds the popup. Unknown/known word still returns 200 with whatever
  occurrences exist (empty lists are fine).
- **`POST /journal/suggestions/<word>/apply`** → form/JSON body: `section_id`,
  `kind` (`permanent`|`temporary`), `dates` (repeated/`,`-joined ISO dates).
  Calls `apply_tag_suggestion`, saves, returns JSON `{ok: true}` (the popup is
  JS-driven on the analytics page; no PRG needed). Validates inputs; flashes/400
  on bad section or empty dates.
- **`POST /journal/suggestions/<word>/dismiss`** → calls `dismiss_suggestion`,
  saves, returns JSON `{ok: true}`.

All three follow the existing thin-HTTP pattern and use `journal_file()`.

## Front-end (analytics.js + style.css)

The Overview Suggestions block (rendered from `_data.suggestions`) becomes
interactive:

- Each suggestion renders as a chip showing the word (and a small `n d`
  day-count hint), with a trailing **×** dismiss button.
  - **×** → `POST /journal/suggestions/<word>/dismiss` → on success remove the
    chip from the DOM (no full refetch needed).
  - **chip body click** → open the **apply popup**.
- **Apply popup** (a dedicated popover/modal built in vanilla JS, themed):
  - Fetches `GET /journal/suggestions/<word>`.
  - **Kind**: a permanent/temporary segmented toggle (reuse the `.kind-toggle`
    style used elsewhere).
  - **Section**: a `<select>` of active tag sections (themed select).
  - **Days**: a checklist — one row per occurrence, `date` + the snippet with the
    matched word highlighted; checked by default. (Select-all implied; user can
    uncheck.)
  - **Confirm** → `POST …/apply` with `section_id`, `kind`, checked `dates` → on
    success, close the popup and remove the suggestion chip. **Cancel**/×/outside-
    click/Escape closes without applying.
  - Disable Confirm when no days are checked.

Styles: reuse `.kind-toggle`, themed `<select>`, `.tag-pop*`/modal patterns,
origin/snippet styling; add only what's needed (`.suggest-popup*`, day-row,
snippet highlight). Match the dark amber/monospace theme.

## Testing (TDD)

`tests/test_journal_analytics.py` / `tests/test_journal.py`:
- `tag_suggestions`: stopword exclusion (incl. "everything"), `min_days=3`
  boundary, 30-day window boundary (entries older than 30 days ignored), known-
  tag exclusion, dismissed-within-30-days exclusion + resurface after 30 days
  (fixed `now`), ordering, `limit`.
- `suggestion_occurrences`: whole-word case-insensitive match, snippet
  truncation + "…", multiple days newest-first, window filtering, empty bodies.
- `dismiss_suggestion`: records today; idempotent.
- `apply_tag_suggestion`: permanent adds to master list + tags days; temporary
  tags days only; dedup; get-or-create entry; multiple dates; bad section.

`tests/test_journal_app.py`: the three routes — `GET …/<word>` shape,
`…/apply` (permanent & temporary) mutates the store, `…/dismiss` records the
dismissal; bad inputs handled.

Use `journal._empty()`, a fixed `now`, and `tmp_path`.

## Files

Modified: `journal.py`, `app.py`, `static/analytics.js`, `static/style.css`,
`CLAUDE.md`, `tests/test_journal_analytics.py`, `tests/test_journal.py`,
`tests/test_journal_app.py`. New: this spec.

## Out of scope

- Suggesting multi-word phrases or @mention-style tags.
- Editing/undoing an applied tag from the popup (use the normal entry/manage UI).
- Changing the dormant-tags block.
