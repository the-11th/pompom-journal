# Project guide (CLAUDE.md / AGENTS.md)

This is the single source of truth for AI coding agents working in this repo.
**`AGENTS.md` is a symlink to this file**, so Claude Code (reads `CLAUDE.md`) and
Codex (reads `AGENTS.md`) get the exact same guidance — keep everything here
tool-agnostic and edit only this one file. These instructions override default
behavior; follow them exactly.

## Read first: goals, design & expectations

### What this app is (and its goals)
A local-first, single-user **daily journal + to-do** web app ("TodoPup"):
server-rendered Flask with JSON file storage (no database), run locally via a
macOS dock app. Its two domains — **tasks** and **journal** — share one
analytics-ready data model feeding a rich `/journal/analytics` dashboard.
Third-party integrations (Google Health sleep, RescueTime productivity, Spotify
music, Android phone usage) auto-fill structured fields on journal entries.

The north star: **one pleasant, fast, private place to log your day, track tasks,
and see cross-domain patterns** (mood ↔ sleep ↔ productivity ↔ music ↔ tags).
It's an actively evolving work in progress — bias toward polish and fit with the
existing whole, never one-off hacks. Before adding anything, ask: *"does this
match what's already here, and serve that north star?"*

### UI expectations — consistency is a feature (non-negotiable)
Every new UI MUST match the existing **dark amber / monospace theme**. No
native/unstyled browser chrome ever. Concretely:
- Use the `:root` CSS variables; never hardcode theme colors — `--panel`,
  `--text`, `--muted`, `--border`, `--accent` (#e0a955 amber), `--danger`
  (#e0524d red).
- Route every `<select>` through the themed custom dropdown; for selects created
  dynamically after load, call `window.enhanceSelect(el)` — never ship a raw
  native `<select>`.
- **Reuse existing patterns rather than inventing new ones**: `.kind-toggle`
  segmented radios, themed inputs/date pickers, the global
  `window.confirmModal(msg, label)` (auto-wired to any `button[data-confirm]`),
  the `.suggest-popup*` / `.tag-pop*` popover shells, `.cal-*` calendars,
  `.section-filter` chips, `.analytics-panel*` chart boxes, `.sleep-stage-legend`
  chart legends. Match the surrounding code's naming, spacing, and idioms.
- Add a matching `style.css` rule for any new class; audit new elements for native
  fallbacks (raw selects, range sliders, checkboxes, scrollbars, focus rings)
  before shipping. Global polish (`color-scheme: dark`, themed scrollbars,
  `::selection`, `::placeholder`, `accent-color`) is already in place — inherit it.
- **No third-party JS/CSS libraries.** Everything is vanilla — charts are
  hand-rolled SVG in `analytics.js`; drag-and-drop is native HTML5. Keep it so.

### Engineering conventions (non-negotiable)
- **Strict pure-logic / HTTP split.** Domain logic lives in the pure modules
  (`todo.py`, `journal.py`, `oauth.py`, `google_health.py`, `rescuetime.py`,
  `spotify.py`, `usage.py`, `integrations.py`) with **zero Flask imports**, plain
  dict/list in and out. `app.py` is a thin HTTP layer only (parse → call domain →
  render/redirect). Put new logic in the pure modules, not `app.py`.
- **Test-first (TDD).** Add/adjust tests before implementation; the full `pytest`
  suite must stay green. Unit tests use a fixed `now` + pytest `tmp_path`; route
  tests use Flask `test_client()` with temp data files. Initialize stores with
  `todo._empty()` / `journal._empty()`. Preserve the injectable `now=None`
  parameter on any time-sensitive function.
- **Post/Redirect/Get** for every state-changing route, with `flash()` for
  validation errors; background JSON endpoints re-render in place.
- **Forgiving `load()` + atomic `save()`** for every JSON store — when you add a
  top-level key or per-entry field, extend both `load()` and `_empty()` to default
  it (backward-compatible migration).
- **Analytics come in pairs**: a pure helper in `journal.py`/`todo.py` computes
  the numbers; a JS mirror in `analytics.js` renders them via the `CHARTS`
  registry + `U.*` SVG utilities. Keep the Python helper and its JS mirror in
  lockstep.

### How to verify before declaring done
1. `pytest` — full suite green; new behavior has new tests.
2. `node -c static/<file>.js` after editing any JS file (catches syntax errors).
3. Run it and click the affected flow: `flask --app app run --port 5001` →
   `http://127.0.0.1:5001/`. For analytics/UI changes, **eyeball it in the
   browser** — the SVG charts and layout aren't covered by unit tests.

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
- **`oauth.py`** — generic OAuth2 Authorization-Code-Grant helpers (zero Flask).
  Shared by all OAuth providers (Google Health, Spotify) without duplication.
  Functions: `build_authorize_url(authorize_url, ..., extra=None)` (`extra` dict
  merged into the authorize query — Google passes `{"access_type":"offline",
  "prompt":"consent"}`), `exchange_code(token_url, ..., client_auth="basic")`,
  `refresh_tokens(token_url, ..., client_auth="basic", prev=None)` (when
  `client_auth="body"` credentials go in the POST body instead of HTTP Basic;
  `prev` preserves the stored refresh token when the provider omits it on
  refresh), `token_expired(tokens, now=None)`,
  `normalize_token_response(raw, now=None, prev=None)` (falls back to `prev`'s
  `refresh_token` when the response omits one), `urllib_transport`. Google Health
  and Spotify both delegate all OAuth calls to it (thin wrappers, same public
  signatures).
- **`google_health.py`** — Google Health sleep client (zero Flask). OAuth
  delegated to `oauth.py` with `client_auth="body"` and authorize extras
  `{"access_type":"offline","prompt":"consent"}`. Only sleep-specific
  `fetch_sleep` / `parse_sleep` live here. See the Integrations section below.
- **`rescuetime.py`** — RescueTime API client (zero Flask, API-key auth). Network
  behind an injectable `transport` (default `oauth.urllib_transport`); tests pass
  a fake. See the Integrations section below.
- **`spotify.py`** — Spotify Web API client (zero Flask, OAuth via `oauth.py`).
  Same injectable-transport pattern. See the Integrations section below.
- **`usage.py`** — phone-usage (Android) parse/aggregate (zero Flask, no network,
  no OAuth). Unlike the pull-based clients the phone *pushes* usage stats;
  `parse_push` normalizes an inbound push (a single day dict OR a list of days)
  into per-day `usage` dicts, plus RescueTime-style aggregation helpers. See the
  Integrations section below.
- **`integrations.py`** — third-party credential/token store, zero Flask imports.
  Same forgiving-load/atomic-save pattern as `journal.py`/`todo.py`. See the
  Integrations section below.
- **`app.py`** — thin HTTP layer only: parse request, call domain module, render
  template, redirect. All state-changing routes use **Post/Redirect/Get** and
  `flash()` for validation errors. Config keys `DATA_FILE`, `JOURNAL_FILE`, and
  `INTEGRATIONS_FILE` let tests point at temp files. Also owns the auto-quit
  watchdog (see below).
- **`start_server.py`** — double-fork daemon launcher used by `TodoPup.command`
  and the Automator dock app. Starts Flask detached from the calling process so
  macOS Shortcuts/Automator exits immediately rather than waiting for Flask.

### Data files

- **`data/tasks.json`** — task store: `active`, `archive`, `expired` (lists of
  tasks), `tags` (name → hex color registry).
- **`data/journal.json`** — journal store: `sections` (list), `entries` (list),
  `dismissed_suggestions` (`{word: "YYYY-MM-DD"}` — when each Manage-page tag
  suggestion was dismissed; words are suppressed for a 30-day cooldown). Each
  entry also has a `sleep` field (structured dict or null), a `rescuetime` field
  (structured dict or null), and a `music` field (structured dict or null), all
  defaulted to `None` by `load()`.
- **`data/integrations.json`** — third-party credential/token store (gitignored
  via the existing `data/*` rule). Top-level keys: `google` (OAuth tokens +
  credentials), `rescuetime` (api_key + last_sync), `spotify` (OAuth tokens +
  credentials + `taste` snapshot + `plays_buffer`), `phone` (shared ingest
  `token` + `last_sync`). `rescuetime.api_key` is
  populated by `integrations.set_api_key`; Spotify tokens by
  `integrations.set_tokens` and taste/buffer by `set_taste`/`set_plays_buffer`;
  the phone ingest token by `integrations.set_token`/`get_token`.

All three stores use forgiving `load()` (missing keys defaulted, corrupt files
backed up to `.bak`) and atomic `save()` (temp file + `os.replace`). Extend
`load()` and `_empty()` whenever you add a new top-level key or field — including
new entry fields like `sleep` and `rescuetime` (both handled via
`e.setdefault(field, None)` in `journal.load()`).

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
  `…/<i>/toggle`, `…/<i>`, `…/<i>/delete`, `…/subtasks/reorder`) and re-render in
  place (`static/task-details.js`). Pure helpers: `set_task_notes`, `add_subtask`,
  `toggle_subtask`, `edit_subtask`, `delete_subtask`, `reorder_subtask`. Subtasks
  can be **drag-reordered** within a task via a per-row grip handle
  (`.subtask-drag`, native HTML5 drag-and-drop, no libraries — mirrors the
  `journal-sections.js` idioms; drop-target row highlighted via `.drop-target`).
  Dragging uses only the handle so it never disturbs the checkbox/edit/delete
  handlers; the handle POSTs `{"from": i, "to": j}` to
  `POST /task/<id>/subtasks/reorder` (`reorder_subtask` pops `from` and inserts at
  `to`; out-of-range/from==to/unknown-id = no-op) and re-renders from the returned
  list. Reordering is **active-list only** — disabled on the read-only Archive
  dropdown. Subtasks are independent of parent completion; a recurring task's next
  occurrence copies notes + subtask text with all checks reset. Read-only on the
  Archive page.

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
`mood` (integer 1–7, or null), `sleep` (structured dict or null — see the
Integrations section for the full model; defaults to null via `load()`),
`rescuetime` (structured dict or null — see Integrations; defaults to null),
`music` (structured dict or null — see Integrations; defaults to null via `load()`),
`usage` (phone-usage structured dict or null — see Integrations; defaults to null
via `load()`).

### Section model

Sections are user-configurable categories that appear on every entry form.
Fields: `id` (uuid4 hex), `name`, `type` (`"tag"` or `"numeric"`), `color` (hex),
`tags` (permanent tag list), `archived_tags` (removed-but-recoverable tags),
`unit` (label for numeric sections, e.g. `"hrs"`), `archived` (soft-delete bool),
`managed` (provider id string | null) and `metric` (stable metric key | null).
A **managed** section is API-fed (created lazily by an integration, e.g. Google
Health sleep): it is **hidden from the entry form's editable numeric inputs**
(`rejectattr('managed')` in `journal_entry.html`) and **skipped by the
`journal_save` reconcile loop** (so its API-written value in `existing["numbers"]`
survives an entry save that carries no `num:` field for it) and by
`numeric_section_index` (so inline `#name value` capture never writes to it), but
it still appears in Search sliders + the Numeric analytics tab (both read
`active_sections`, which includes non-archived managed sections). `load()`
defaults both fields to `None`; `add_section(..., managed=None, metric=None)`.
The Manage page shows a small amber `.pill-auto` "auto" pill on managed sections.

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
| `GET /journal/suggestions/<word>` | JSON: active tag sections + windowed occurrences (for the Manage-page apply popup) |
| `POST /journal/suggestions/<word>/apply` | Apply a suggested tag (`section_id`, `kind`, repeated/`,`-joined `dates`) → `{ok}` |
| `POST /journal/suggestions/<word>/dismiss` | Dismiss a suggestion for the 30-day cooldown → `{ok}` |
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
  The manage page also has a **Suggestions** jump-to section (`#sec-suggest`,
  in the `Tags · Numbers · Suggestions · Add` jump nav, placed between Numbers
  and Add). It hosts the (moved-from-analytics) tag-suggestions feature:
  suggested tags (frequent untagged body words) render as `.suggest-chip-v2`
  chips (word + `Nd` day-count hint + × dismiss) and dormant-people rows
  ("Haven't tagged X in N days") below. The `journal_sections` route computes
  `suggestions = tag_suggestions(data, limit=8)` + `dormant = dormant_tags(data)`
  and the template embeds them as `<script type="application/json"
  id="suggest-data">` (Jinja `tojson`); `static/tag-suggest.js` reads that blob
  and renders into `#suggest-root`. × dismisses (POST
  `/journal/suggestions/<word>/dismiss`); clicking a chip body opens the themed
  apply popup (GET `/journal/suggestions/<word>` → permanent/temporary
  `.kind-toggle`, section `<select>`, day-checklist with highlighted snippets,
  Confirm → POST `/journal/suggestions/<word>/apply`; Cancel/×/outside/Escape
  close; Confirm disabled when no days checked). After a successful **apply OR
  dismiss** the page reloads (PRG-style) so the manage page reflects the change.
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
- **Inline `#numeric` capture**: `#weight 175` in the body fills a matching
  **active numeric section** (underscores→spaces, last-write-wins; unknown names
  ignored). Index `numeric_section_index`; parse `extract_numbers`; `journal_save`
  merges via `base_numbers.setdefault(sid, val)` (explicit `num:` field wins, body
  fills gaps); client highlights + reflects the value into the section field on
  blur (`numeric-index` blob; `.numeric-highlight`).
- **Inline `[]` task spawning**: a `[] title >due @tag` line spawns a real to-do
  on save (`data["active"]`). Helpers `extract_task_lines`/`linked_task_ids`/
  `rewrite_task_lines` (journal.py) + `todo.parse_due_token` (ISO/`today`/
  `tomorrow`/weekday/`+Nd|w|m` → 23:59 local). `journal_save` spawns tasks,
  rewrites each `[]` marker to `[task:<id>]` (**idempotent** — linked lines never
  re-spawn), inheriting the line's `>due` + `@mention` tags; renders as a live
  checkbox mirroring the task's done-state via the `task-ref-index` blob
  (`.task-check*`). Inline-grammar mnemonic: **`@` tag · `#` number · `[]` task**.
- **Mood** (`journal-mood.js`): an optional **1–7** mood per entry, picked from
  seven Pompompurin GIFs (`static/img/N-pompom.gif`) on the "What happened today"
  line, right-justified. Single-select, click again to deselect; the chosen GIF
  stays full opacity, the others dim. Stored as `mood` on the entry.

### Journal templates

`journal_entry.html` (entry form with calendar, tag chips, numeric inputs, action
row — includes a `sleep-panel`, `rescuetime-panel`, and `spotify-panel` row when
the respective provider is connected), `journal_search.html` (live search),
`journal_sections.html` (section management — its bottom `#sec-integrations`
section includes `_integrations_cards.html`), `journal_sections_archive.html`
(archived sections & tags), `_integrations_cards.html` (partial: Google Health
OAuth card, RescueTime API-key card, and Spotify OAuth card, each with connect/
disconnect, last-synced, "Sync now"; rendered on the Manage page via
`_integrations_context()`).

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
  color-coded `@mentions`, `#numeric` highlights, and `[]`/`[task:id]` checkboxes)
  plus live blur reflection — mention→chip, `#numeric`→field, task→checkbox.
- **`journal-mood.js`**: the 7-GIF mood picker (select/deselect, dims the rest).
- **`integrations-sync.js`** (loaded on the journal entry page and the journal
  Manage page's `#sec-integrations` section): a self-contained per-provider
  registry (`PROVIDERS` array). Each entry has `{name, panelId, key, syncPath,
  render}`. Three providers: Google Health (`{ name: "google", panelId:
  "sleep-panel", key: "sleep", syncPath: "/integrations/google/sync",
  render: renderSleep }`), RescueTime (`rescuetime-panel` / `renderRescuetime`),
  and Spotify (`spotify-panel` / `renderMusic`; `key: "music"`). For each
  connected provider the entry page auto-syncs in the background on load
  (throttled to once per hour via `data-last-sync` on the panel) and re-renders
  the read-only panel row in place (built via `textContent`; Spotify row shows 🎧
  icon + minutes + tracks + top artist). `#<name>-sync-now` buttons on the
  settings page call the same sync path then `location.reload()`; button wiring
  works even when no panel is present.
- **`journal-sections.js`**: drag-and-drop tag reassignment on the manage page
  (native HTML5 DnD). Drop a chip in the Permanent/Temporary zone to promote/
  demote; submits a POST form (PRG reload). Progressive enhancement over the
  in-chip ↑/× button fallbacks. Drop-target highlights via `.tag-zone.drag-over`.
- **`tag-suggest.js`** (manage page only): the self-contained tag-suggestions
  subsystem (moved off the analytics Overview). Reads the `#suggest-data` JSON
  blob (`{suggestions, dormant}`), renders suggestion chips + dormant rows into
  `#suggest-root`, and drives the apply popup (GET/apply/dismiss against the
  `/journal/suggestions/*` routes). Reuses the existing `.suggest-*`/`.dormant-*`
  styles. Reloads the page after a successful apply/dismiss. No dependency on
  `analytics.js`.
- **`style.css`**: shared dark amber/monospace theme. CSS variables in `:root`:
  `--panel`, `--text`, `--muted`, `--border`, `--accent` (#e0a955 amber),
  `--danger` (#e0524d red). All `<select>` elements use a custom SVG caret
  (`appearance: none`) matching the dark theme. The permanent/temporary tag kind
  picker is a `.kind-toggle` segmented radio control (not a `<select>`). Integrations
  styles: `.integration-card`, `.integration-creds`, `.integration-status.on/.off`.
  Sleep panel styles: `.sleep-panel`, `.sleep-times`, `.sleep-qual`,
  `.sleep-stage-legend` (bedtime/wake consistency legend).
  RescueTime panel styles: `.rt-row`, `.rt-pulse`, `.rt-prod` (reuses the
  `.sleep-stage-legend` pattern; entry panel row shows pulse + productive hours).
  Music/Spotify panel and analytics styles: `.music-row` (entry panel — 🎧 icon,
  minutes, tracks, top artist); `.music-taste-section`/`.music-taste-heading`/
  `.music-taste-grid`/`.music-taste-col`/`.music-taste-col-title`/
  `.music-taste-list` (taste view in Music tab); `.chart-muted` (muted note when
  data is absent, e.g. audio-features unavailable); `.chart-subtitle` (sub-heading
  within a chart block).
- **Styling is mandatory for all new UI.** Every new feature MUST match the dark
  amber/monospace theme — no native/unstyled browser chrome. Concretely: use the
  `:root` CSS variables (never hardcode theme colors); route every `<select>`
  through the themed custom dropdown (`window.enhanceSelect(el)` for ones created
  dynamically after load — never ship a raw native `<select>`); reuse existing
  patterns (`.kind-toggle`, themed inputs/date pickers, `confirmModal`,
  `.tag-pop*`/popover and `.suggest-popup*` modal styles, `.cal-*` calendars) and
  add a matching `style.css` rule for any new class. Global polish is already in
  place — `color-scheme: dark`, themed `::-webkit-scrollbar`, `::selection`,
  `::placeholder`, and `accent-color: var(--accent)` — so inherit it rather than
  re-introducing native widgets. Audit new elements for native fallbacks (raw
  selects, range sliders, checkboxes, scrollbars, focus rings) before shipping.
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

The `/journal/analytics` page uses a **two-tier grouped navigation**: a **primary
category row** (`.analytics-cats`) + a **secondary sub-tab row**
(`.analytics-subtabs`). This replaced the old flat tab bar + `Journal | Task`
lens toggle (which clipped tabs off-screen at `overflow:hidden`). **Overview** is
just the first category (single sub-tab, itself). The categories, in order, with
their sub-tabs:

| Category | Sub-tabs |
|---|---|
| **Overview** | (renders directly — no secondary row) |
| **Health** | Mood · Sleep |
| **Data** | Numeric · Tags |
| **Digital** | Productivity · Music · Phone usage |
| **Tasks** | Throughput · Timeliness · Adherence · Difficulty |
| **Patterns** | Leading · Consistency · Coverage |

`PANELS` are the sub-tab definitions (each `{id, label, needs?}`); `CATEGORIES`
groups them by id. Navigation state: `_category` (active primary) alongside
`_activeTab` (active sub-tab). Behavior (`buildCategories`/`buildSubtabs`/
`switchCategory`/`switchTab`/`goTo`/`reconcileNav`): clicking a category activates
its first sub-tab; the **secondary row shows only when the active category has ≥2
sub-tabs** (Overview, being a single, shows no secondary row). **The nav is a
stable, complete map — every category and sub-tab is always visible regardless of
data** (`tabVisible`/`categoryVisible` always true); a tab with no data yet renders
its charts' graceful empty states (e.g. "No mood recorded in this range", "connect
Spotify and sync…") rather than being hidden. The `needs:` predicates on `PANELS`
still exist but **no longer gate tab visibility** — they feed the Overview cards
and the Leading-tab logic only. `reconcileNav` keeps `_category`/`_activeTab`
mutually consistent after each fetch. The primary row is `flex-wrap: wrap` (never
`overflow:hidden`) so all categories stay reachable.

The old single **"Tasks"** tab was **refactored** into the **Tasks** category's
sub-tabs (no chart lost): `task-throughput`/`task-entry-calendar` → Throughput;
`task-overdue`/`task-numeric-scatter` → Timeliness; `task-adherence` →
Adherence; `task-difficulty` → Difficulty. The separate **"Task tags"** tab is
**gone**: its `task-tag-frequency` chart merged into the cross-domain **Tags**
tab (under **Data**). Because tags are unified by name across domains, **Tags**
carries every tag chart in order — the journal tag analytics (frequency, trend,
per-tag heatmap, co-occurrence) first, then the task-tag analytics
(`task-tag-frequency`); the task-tag chart shows its normal `U.empty(...)` state
when there are no tasks. `renderTagsTab()` (bespoke, outside the `CHARTS` loop):
a search box on top, and below it **the all-tags overview by default** (ALL
aggregate `panel: "tags"` charts) which a **per-tag detail replaces once a tag is
searched** (cleared search returns to the overview). The search box has a custom
**live-preview dropdown** listing **both** journal (section) tags and
task-registry tags, each origin-marked (☑ task / ● journal), with arrow-key +
click select, committing and hiding on Enter. Per-tag detail is an async fetch of
`/tag/<name>/overview` (cached per name+range) that renders **both halves** —
journal detail (`renderTagJournal`) then task detail (`renderTagTask`), each with
its own empty state — reusing the `U.*` SVG utilities. On load it reads
`#tag=<name>` from the URL hash to open **Data → Tags** pre-searched; it refetches
on tag change and date-range change. (The old lens is fully removed — no `_lens`,
`switchLens`, or `.analytics-lens*`; CHARTS entries no longer carry `lens:`.)

### Files

New: `static/tag-popup.js`. Modified: `journal.py`, `todo.py`, `app.py`,
`static/analytics.js`, `static/journal-search.js`, `templates/base.html`,
`templates/archive.html`, `templates/journal_analytics.html`, `static/style.css`
(`.tag-pop*`, origin marks `.origin-task`/`.origin-dot`, category nav
`.analytics-cats`/`.analytics-cat` + sub-tabs `.analytics-subtabs`/
`.analytics-subtab`, Tag-detail `.deep-*`/`.callout*`/`.cooc-*`).

---

## Integrations

Third-party data providers fill structured fields on journal entries automatically.
The integration layer follows the same pure-logic/thin-HTTP split as the rest of
the app: all provider logic lives in dedicated pure modules; `app.py` only routes.

### `oauth.py` — shared OAuth2 helpers (zero Flask)

Shared by all OAuth providers (Google Health, Spotify) without duplication.
Spotify and Google Health both delegate all OAuth operations to it.

- `build_authorize_url(authorize_url, client_id, redirect_uri, state, scope, extra=None)` → redirect URL (Authorization Code flow). `extra` dict is merged into the query (Google passes `{"access_type": "offline", "prompt": "consent"}`).
- `exchange_code(token_url, client_id, client_secret, code, redirect_uri, transport=None, now=None, client_auth="basic")` — exchanges an authorization code for tokens. `client_auth="body"` puts credentials in the POST body instead of HTTP Basic (required by Google).
- `refresh_tokens(token_url, client_id, client_secret, refresh_token, transport=None, now=None, client_auth="basic", prev=None)` — refreshes tokens. Passes `prev` through to `normalize_token_response` so Google's omitted refresh token is preserved.
- `token_expired(tokens, now=None)` → bool. 60-second skew margin against `expires_at`.
- `normalize_token_response(raw, now=None, prev=None)` → `{access_token, refresh_token, scope, expires_at, fetched}`. Falls back to `prev`'s `refresh_token` when the response omits one.
- `urllib_transport(method, url, headers, body)` — default real transport; tests swap in a fake.

### `google_health.py` — Google Health sleep client (zero Flask)

OAuth delegated to `oauth.py` with `client_auth="body"` and authorize extras
`{"access_type":"offline","prompt":"consent"}`. Only Google Health-specific
`fetch_sleep` and `parse_sleep` live here.

- `build_authorize_url(client_id, redirect_uri, state)` → authorize URL. Wraps `oauth.build_authorize_url` with the Google authorize endpoint, `_SCOPE`, and the offline/consent extras.
- `exchange_code(client_id, client_secret, code, redirect_uri, transport=None, now=None)` — thin wrapper around `oauth.exchange_code` with `client_auth="body"`.
- `refresh_tokens(client_id, client_secret, refresh_token, transport=None, now=None, prev=None)` — thin wrapper around `oauth.refresh_tokens` with `client_auth="body"`, `prev` threaded through.
- `token_expired(tokens, now=None)` → `oauth.token_expired`.
- `fetch_sleep(access_token, date, transport=None)` → raw API JSON. `GET https://health.googleapis.com/v4/users/me/dataTypes/sleep/dataPoints?pageSize=25&filter=<civil_end_time filter>`; raises `PermissionError` on 401, `RuntimeError` on other non-200.
- `parse_sleep(api_json, now=None)` → sleep dict or `None`. Pure, defensive. Selects the longest record by interval when multiple data points exist. `start`/`end` are local-clock `"HH:MM"` derived from interval times + UTC offsets. `duration_min` from `sleepSummary` total if present, else sum of non-AWAKE stage seconds, else interval length. `stages` (`{deep, light, rem, wake}` minutes) is `None` when `sleepType == "CLASSIC"`. `efficiency` from `sleepSummary` if present, else `None`; `score` is always `None` (Google Health exposes no sleep score); `quality = score if score is not None else efficiency`. `source: "google"`.

### `rescuetime.py` — RescueTime client (zero Flask, API-key auth)

No OAuth; authentication is a personal API key passed as a query param.
Transport seam: same `transport(method, url, headers, body) -> (status, json)`
injectable callable, defaulting to `oauth.urllib_transport`.

- `fetch_daily_summary(api_key, transport=None)` → raw JSON from the daily-summary feed (≈ last two weeks, newest first).
- `parse_day(row, now=None)` → `{date, pulse, productive_min, distracting_min, neutral_min, total_min, top_categories:[{name,min}], source:"rescuetime", fetched}`. Pure. Hours fields converted to minutes; top_categories capped at 5, sorted by minutes desc.
- `fetch_activities(api_key, date, transport=None)` → raw JSON from the **Analytic Data API** (`anapi/data`, `restrict_kind=activity`, rank perspective, single-day range). This is the **per-website/app breakdown** feed (the daily-summary feed only carries broad category totals).
- `parse_activities(payload, cap=8)` → `[{name, min, category, productivity}]` sorted by minutes desc, capped, 0-min rows dropped. Pure & defensive: tolerates a non-dict payload / short rows, locates columns from `row_headers` (fallback to the documented order `[Rank, Time Spent (seconds), Number of People, Activity, Category, Productivity]`). `productivity` is RescueTime's -2..2 score.

### `integrations.py` — credential/token store (zero Flask)

Same forgiving-load/atomic-save pattern as `journal.py`.

- `_empty()` → `{"google": {}, "rescuetime": {}, "spotify": {}}`.
- `load(path)` / `save(path, data)` — forgiving read (missing → empty; corrupt → `.bak` + empty), atomic write.
- Accessors: `get_provider`, `set_credentials`, `set_tokens`, `set_api_key`
  (stores `api_key` on a provider dict — used by RescueTime), `clear_provider`
  (removes `tokens`, `last_sync`, `oauth_state`, **and** `api_key`), `is_connected`
  (true when an `access_token` OR a non-empty `api_key` exists), `last_sync`,
  `set_last_sync`.

Stored in `data/integrations.json` (covered by the existing `data/*` gitignore).

### Entry `sleep` field

Added by auto-sync; `None` when no Google Health data. `journal.load()` defaults
every entry's `sleep` to `None` (`e.setdefault("sleep", None)`). Read-only on
the form; a re-sync overwrites it.

```json
"sleep": {
  "start": "23:14",
  "end": "06:58",
  "duration_min": 431,
  "efficiency": 92,
  "score": null,
  "quality": 92,
  "stages": {"deep": 71, "light": 240, "rem": 90, "wake": 30},
  "source": "google",
  "fetched": "2026-06-29T08:12:00"
}
```

`score` is always `null` (Google Health exposes no sleep score); `efficiency`
comes from `sleepSummary` when present, else `null`; `quality = efficiency` (or
`null`). `stages` is `null` for classic (non-staged) sleep. **Date attribution:**
Google Health's `civil_end_time` (morning of waking) maps to the journal date —
last night's sleep lands on today's entry.

Writer: `journal.set_entry_sleep(data, date, sleep, now=None)` — get-or-creates
the entry, sets `entry["sleep"]`, bumps `updated`. `sleep=None` clears it.

#### Sleep → API-managed numeric sections

The numeric parts of `entry["sleep"]` are ALSO mirrored into **API-managed
numeric sections** (`managed="google_sleep"`) so they are filterable via the
Search-page range sliders and appear in the Numeric analytics tab — without
cluttering the entry form (managed sections are hidden from the form's editable
inputs; see the Section model). **Six** metrics (each a stable `metric` key →
section `name`/`unit`): `sleep_duration` ("sleep duration", hrs = round(
duration_min/60, 2)), `sleep_quality` ("sleep quality", %, = the `quality`
field), and the four stages `deep_sleep`/`rem_sleep`/`light_sleep`/`awake_time`
("deep/rem/light sleep", "awake time", min, from `stages.deep/rem/light/wake`).
Sections are created **lazily** — only when a real (non-None) value for that
metric syncs; a classic (non-staged) night creates only duration + quality.
Registry: `journal._GOOGLE_SLEEP_PROVIDER` + `journal._SLEEP_METRIC_SECTIONS`
(ordered `{metric, name, unit, color}`) + `_SLEEP_STAGE_METRICS` (stage-key →
metric). Pure helpers (all in `journal.py`, zero Flask):

- `sleep_metric_values(sleep) -> {metric: number}` — maps a parsed sleep dict to
  metric values, omitting unavailable ones (duration only if `duration_min` is a
  positive number; quality only if `quality` is a number; each stage only if
  `stages` is a dict and that key is a number). Non-dict → `{}`.
- `ensure_sleep_sections(data, metrics) -> {metric: section_id}` — get-or-creates
  the managed section per metric (reuses an existing `metric`+`managed` section
  incl. archived; idempotent; on a user name collision differentiates the name
  via `_create_managed_sleep_section` — `"<name> google"`, then a short suffix).
- `set_entry_number(data, date, section_id, value, now=None)` — get-or-create
  entry (mirrors `set_entry_sleep`), validates finite number, writes
  `entry["numbers"][section_id]=float(value)`. **Idempotent**: unchanged value →
  no `updated` bump (avoids timestamp churn on repeated syncs).
- `apply_sleep_metrics(data, date, sleep, now=None) -> {metric: value}` — the
  end-to-end pure orchestrator: `sleep_metric_values` → `ensure_sleep_sections`
  → `set_entry_number` per metric; empty/None sleep → `{}` (no sections created).

`_google_sync` calls `journal.apply_sleep_metrics(jdata, date, sleep)` right
after `set_entry_sleep` for each freshly-synced day, AND **backfills** — right
after `journal.load(...)` it iterates existing entries with a truthy `sleep` and
applies the metrics (the per-date `entry.sleep` guard would otherwise skip
already-synced days); both are idempotent and persisted by the single `save`.

### Entry `rescuetime` field

Added by auto-sync; `None` when no RescueTime data. `journal.load()` defaults
every entry's `rescuetime` to `None` (`e.setdefault("rescuetime", None)`).
Read-only on the form; a re-sync overwrites it.

```json
"rescuetime": {
  "date": "2026-06-28",
  "pulse": 72,
  "productive_min": 312,
  "distracting_min": 45,
  "neutral_min": 90,
  "total_min": 447,
  "top_categories": [{"name": "Software Development", "min": 240}],
  "top_activities": [{"name": "github.com", "min": 120, "category": "General Software Development", "productivity": 2}],
  "source": "rescuetime",
  "fetched": "2026-06-29T08:15:00"
}
```

`top_activities` (per-website/app breakdown, from the Analytic Data API) is
**absent on days synced before the feature shipped**; the sync backfills it on
the next sync (see below). Each activity carries a `category` and a RescueTime
`productivity` score (-2..2).

Writer: `journal.set_entry_rescuetime(data, date, value, now=None)` — same
get-or-create + bump-updated pattern as `set_entry_sleep`. `value=None` clears.

### Integrations routes (in `app.py`)

`app.config["INTEGRATIONS_FILE"]` (default `data/integrations.json`) + `integrations_file()` helper, mirroring `data_file()` / `journal_file()`. The
integrations UI lives as the bottom **Integrations** section
(`#sec-integrations`) of the journal **Manage** page (`journal_sections.html`),
fed by `_integrations_context()`; there is no standalone integrations nav link.

| Route | Method | Purpose |
|---|---|---|
| `GET /integrations` | GET | Redirect to `/journal/sections#sec-integrations` (back-compat; the UI now lives in the Manage page section). |
| `POST /integrations/google/credentials` | POST | Save Client ID/Secret (PRG + flash). |
| `GET /integrations/google/connect` | GET | Generate random `state`, build authorize URL (with `access_type=offline`/`prompt=consent`), redirect to Google. |
| `GET /integrations/google/callback` | GET | Validate `state` + `?error=`, exchange code, store tokens, kick 30-day backfill, redirect to `/integrations`. |
| `POST /integrations/google/disconnect` | POST | Clear Google tokens + state (confirmModal-guarded). |
| `POST /integrations/google/sync` | POST | JSON. `?days=N` (default 7), optional `?date=`. Returns `{ok, connected, synced:[dates], errors:[...], sleep:{<date>: sleep\|null}}`. |
| `POST /integrations/rescuetime/key` | POST | Save the personal API key (PRG + flash). |
| `POST /integrations/rescuetime/disconnect` | POST | Clear the key + last_sync (confirmModal-guarded). |
| `POST /integrations/rescuetime/sync` | POST | JSON. `?days=N` (default 7), optional `?date=`. Returns `{ok, connected, synced:[dates], errors:[...], data:{<date>: rescuetime\|null}}`. |

**Google Health sync internals** (`_google_sync`): if not connected, returns early.
Refreshes tokens (via `google_health.refresh_tokens`, passing stored tokens as
`prev` to preserve Google's omitted refresh token) if expired. For each target
date lacking `entry.sleep`, calls `google_health.fetch_sleep` →
`google_health.parse_sleep` → `journal.set_entry_sleep`. On a 401, calls
`refresh_tokens` once (with `prev`) and retries. Network/parse exceptions are
caught per-day and reported in `errors` without aborting the rest. Sets
`last_sync` on completion. Context helper: `_integrations_context()` exposes
`google_connected`, `google_has_creds`, `google_client_id`, `google_last_sync`,
`google_redirect_uri`.

**RescueTime sync internals** (`_rescuetime_sync`): fetches the full recent feed
once via `rescuetime.fetch_daily_summary`, then iterates rows. For each date it
(a) writes the day's summary via `rescuetime.parse_day` →
`journal.set_entry_rescuetime` when `force` or the day has no `entry.rescuetime`
yet, and (b) fetches the **per-activity (website/app) breakdown** for that date
via `rescuetime.fetch_activities` → `rescuetime.parse_activities` and attaches it
as `rescuetime.top_activities`. Days already synced **before** the breakdown
feature (rescuetime present, no `top_activities`) are **backfilled** — the
breakdown is fetched and merged onto the existing dict without rewriting the
summary. The activity fetch is a **separate Analytic Data API call per day**,
isolated in its own try/except so a failure reports an error but never loses the
day's summary. Per-row errors are isolated and reported in `errors` without
aborting remaining rows. Sets `last_sync` on completion.

### Sleep analytics (`journal.py` + `analytics.js`)

Pure helpers (all injectable date bounds; ignore entries without usable sleep;
degrade gracefully on too few points):

- `sleep_series(entries, start=None, end=None)` → `[{date, hours}]`.
- `sleep_quality_series(entries, ...)` → `[{date, quality}]`.
- `sleep_stage_averages(entries, ...)` → `{deep, light, rem, wake}` mean minutes over staged nights.
- `sleep_dow_averages(entries, ...)` → 7 mean-duration values Mon–Sun.
- `bedtime_series(entries, ...)` → `[{date, bed_min, wake_min}]` in minutes-from-midnight; pre-midnight bedtimes wrap to negative so the consistency band reads naturally.
- `sleep_coverage(entries, ...)` → `{nights, span_days, pct}`.
- `sleep_mood_pairs(entries, ...)` → `[{hours, mood}]` same-day pairs for sleep↔mood correlation (ignores null moods / missing sleep).
- `sleep_stats(entries, ...)` → `{avg_hours, avg_quality, avg_bedtime, avg_waketime, nights}`.
- `_entry_sleep(entry)` — returns the sleep dict if it has a usable `duration_min > 0`, else `None`.

`analytics_payload` carries each entry's `sleep` (structured dict or `null`) so
the client can render without a new endpoint.

**Sleep tab** in `static/analytics.js` (**Health** category, gated on `hasSleep`,
after Mood): stat cards (avg duration, avg quality, avg
bedtime/waketime, nights tracked); duration over time with 7-night rolling avg;
quality over time; bedtime & wake-time consistency; avg duration by day of week;
stage composition stacked bar; sleep↔mood correlation scatter with Pearson `r`;
nights-tracked coverage. Mirrors the Mood tab pattern via `sleepOf(e)` (the
JS-side `_entry_sleep` mirror).

### RescueTime analytics (`journal.py` + `analytics.js`)

Pure helpers (all injectable date bounds; ignore entries without usable rescuetime
data; degrade gracefully on too few points):

- `rescuetime_pulse_series(entries, start=None, end=None)` → `[{date, pulse}]`.
- `rescuetime_time_series(entries, ...)` → `[{date, productive_min, distracting_min, neutral_min}]`.
- `rescuetime_category_totals(entries, ...)` → `[{name, min}]` aggregate across all days.
- `rescuetime_top_activities(entries, ..., cap=8)` → `[{name, min, category, productivity}]` per-website/app aggregate over the range, sorted by minutes desc, capped (category/productivity from first occurrence). Reads `top_activities`; days without it contribute nothing.
- `rescuetime_activity_minutes_series(entries, ..., top_n=6)` → `{activities:[{name}], dates:[...], series:{name:[min-per-date...]}}` (zero-filled, for a multi-line chart), mirroring `usage_app_minutes_series`.
- `rescuetime_dow_averages(entries, ...)` → 7 mean-pulse values Mon–Sun.
- `productivity_mood_pairs(entries, ...)` → `[{pulse, mood}]` same-day pairs for pulse↔mood correlation (ignores null moods).
- `rescuetime_stats(entries, ...)` → `{avg_pulse, avg_productive_min, days}`.
- `_entry_rescuetime(entry)` — returns the rescuetime dict if it has usable data (pulse or total_min present), else `None`.

`analytics_payload` carries each entry's `rescuetime` (structured dict or `null`)
so the client can render without a new endpoint.

**Productivity tab** in `static/analytics.js` (**Digital** category, gated on
`hasRescueTime`, first sub-tab): stat cards (avg pulse,
avg productive hours, days tracked); pulse over time with 7-day rolling avg;
time breakdown stacked bar (productive/distracting/neutral); category totals bar;
**top activities by time** (per-website/app bars, colored by productivity via
`rtProdColor` — accent = productive, danger = distracting, muted = neutral;
mirror of `rescuetime_top_activities` via the `aggRtActivities` JS helper);
**time by activity over time** (multi-line chart of the top-6 activities' daily
minutes with a per-activity color legend reusing `.sleep-stage-legend`, mirror of
`rescuetime_activity_minutes_series`); avg pulse by day of week; pulse↔mood
correlation scatter with Pearson `r`. Mirrors the Sleep tab pattern via
`rescuetimeOf(e)` (the JS-side `_entry_rescuetime` mirror). Panel CSS reuses
`.rt-row` (`.rt-pulse`, `.rt-prod`) from `style.css`. The two activity charts
show a "Re-sync RescueTime to fetch the per-website/app detail" empty state until
the breakdown has synced.

### `spotify.py` — Spotify client (zero Flask, OAuth via `oauth.py`)

OAuth endpoints: authorize `https://accounts.spotify.com/authorize`, token
`https://accounts.spotify.com/api/token` (HTTP Basic auth), scopes
`user-read-recently-played user-top-read`. Redirect URI
`http://127.0.0.1:5001/integrations/spotify/callback`. OAuth helpers delegate to
`oauth.py` (thin wrappers, same `exchange_code`/`refresh_tokens`/`token_expired`
signatures).

- `fetch_recently_played(access_token, transport=None)` → raw API JSON from `GET /v1/me/player/recently-played?limit=50`. Raises `PermissionError` on 401.
- `fetch_top(access_token, kind, time_range, transport=None)` → raw JSON from `GET /v1/me/top/{tracks|artists}?time_range={short|medium|long}_term&limit=20`. Raises `PermissionError` on 401.
- `fetch_audio_features(access_token, ids, transport=None)` → raw JSON or `None`. `GET /v1/audio-features?ids=…`; **returns `None` on 403** (endpoint deprecated for apps created after Nov 2024; not an error). Raises `PermissionError` on 401.
- `parse_recently_played(payload)` → `[{played_at, date, track_id, name, artists:[names], duration_ms}]`. **Pure.**
- `merge_plays(buffer, new_plays, now=None, keep_days=3)` → merged plays dict keyed by date → `{played_at: play}`. **Pure.** De-dupes by `played_at` within each day; prunes dates older than `keep_days` (default 3) relative to `now`. This is the rolling **plays-buffer** that lets re-syncs accumulate a day's plays without double-counting.
- `summarize_day(plays, audio_features=None, now=None)` → `entry["music"]` dict. **Pure.** Aggregates one date's plays list into tracks/minutes/distinct/top_artists + audio-feature means (from `_feature_means`); all feature fields are `None` when `audio_features` is `None` or empty.
- `build_taste(tops, now=None)` → taste dict. **Pure.** Builds top tracks/artists/genres by short/medium/long term from the raw top-items payloads; genres derived from artists' `genres` lists (top-10 by frequency per term).

### Entry `music` field

Added by auto-sync; `None` when no Spotify data. `journal.load()` defaults every
entry's `music` to `None` (`e.setdefault("music", None)`). Read-only on the form;
a re-sync overwrites it.

```json
"music": {
  "tracks": 37,
  "minutes": 142,
  "distinct": 29,
  "top_artists": [{"name": "Phoebe Bridgers", "count": 6}],
  "valence": 0.58,
  "energy": 0.71,
  "danceability": 0.62,
  "tempo": 118.4,
  "source": "spotify",
  "fetched": "2026-06-29T18:05:00"
}
```

Audio-feature fields (`valence`/`energy`/`danceability`/`tempo`) are `null` when
the audio-features endpoint 403s. The **forward-only** model: recently-played caps
at ~50 tracks/~24h, so per-day data is accumulated from the rolling plays-buffer
going forward — no historical backfill.

Writer: `journal.set_entry_music(data, date, value, now=None)` — same
get-or-create + bump-updated pattern as `set_entry_sleep`. `value=None` clears.

### Taste snapshot

Stored in `data/integrations.json` under `spotify.taste`, refreshed on each sync.
Shape: `{tracks: {short_term:[...], medium_term:[...], long_term:[...]}, artists:
{...}, genres: {...}, fetched: "..."}`. Accessed via `integrations.set_taste` /
`integrations.get_taste`. Exposed read-only at `GET /integrations/spotify/taste`.

### `integrations.py` — Spotify accessors

- `set_taste(data, name, taste)` / `get_taste(data, name)` — read/write the taste snapshot.
- `set_plays_buffer(data, name, buffer)` / `get_plays_buffer(data, name)` — read/write the rolling plays-buffer dict.
- `clear_provider` drops `tokens`, `last_sync`, `oauth_state`, `api_key`, `taste`, and `plays_buffer`.

### Spotify routes (in `app.py`)

| Route | Method | Purpose |
|---|---|---|
| `POST /integrations/spotify/credentials` | POST | Save Client ID/Secret (PRG + flash). |
| `GET /integrations/spotify/connect` | GET | Generate random `state`, redirect to Spotify authorize. |
| `GET /integrations/spotify/callback` | GET | Validate `state` + `?error=`, exchange code, store tokens, kick initial taste+sync, redirect to `/integrations`. |
| `POST /integrations/spotify/disconnect` | POST | Clear tokens, taste, and plays-buffer (confirmModal-guarded). |
| `POST /integrations/spotify/sync` | POST | JSON. Optional `?date=`. Returns `{ok, connected, synced:[dates], errors:[...], data:{<date>: music\|null}}`. |
| `GET /integrations/spotify/taste` | GET | Returns the stored taste snapshot JSON (empty object when none). |

**Spotify sync internals** (`_spotify_sync`): if not connected, returns early with
`{connected: false}`. Refreshes tokens if expired. Fetches recently-played →
`parse_recently_played` → `merge_plays` into the plays-buffer (stored back to
integrations store). For each date in the buffer, fetches audio features for that
date's track IDs (`fetch_audio_features`; on 403 uses `None`) → `summarize_day` →
`journal.set_entry_music`. Then refreshes the taste snapshot: `fetch_top` for
tracks and artists across all three terms → `build_taste` → stored. On a 401,
refreshes tokens once and retries. Per-date errors are isolated and reported in
`errors` without aborting remaining dates. Sets `last_sync` on completion.

### Music analytics (`journal.py` + `analytics.js`)

Pure helpers (all injectable date bounds; ignore entries without usable music;
degrade gracefully on too few points):

- `music_minutes_series(entries, start=None, end=None)` → `[{date, minutes}]`.
- `music_tracks_series(entries, ...)` → `[{date, tracks}]`.
- `music_top_artists(entries, ...)` → `[{name, count}]` aggregated over range, sorted desc.
- `music_feature_averages(entries, ...)` → `{valence, energy, danceability, tempo}` means; `None`-safe (skips entries with null features).
- `music_mood_pairs(entries, ...)` → `[{valence, mood}]` same-day pairs (both present).
- `music_stats(entries, ...)` → `{avg_minutes, total_tracks, days}`.
- `_entry_music(entry)` — returns the music dict if it has a usable `tracks` count, else `None`.

`analytics_payload` carries each entry's `music` (structured dict or `null`) so
the client renders without a new per-entry endpoint.

**Music tab** in `static/analytics.js` (**Digital** category, gated on `hasMusic`,
after Productivity): stat cards (avg minutes/day, total
tracks, days tracked); minutes listened over time with 7-day rolling avg; top
artists aggregated over the date range (bar chart); **taste view** — three
terms (4wk/6mo/All-time) each showing top artists, tracks, and genres, fetched
from `/integrations/spotify/taste` and cached in `_tasteCache`; **audio-feature
charts** (valence↔mood scatter with Pearson `r` + feature averages bar) — gated
on `hasFeatures` (any in-range entry with non-null `valence`); when audio features
are unavailable, renders a `.chart-muted` note ("Audio features unavailable for
this Spotify app.") instead. Mirrors the Sleep/Productivity tab pattern via
`musicOf(e)` (the JS-side `_entry_music` mirror). CSS: `.music-row`,
`.music-taste-*`, `.chart-muted`, `.chart-subtitle`.

**Note on audio features:** Spotify deprecated the `/v1/audio-features` endpoint
for apps created after November 2024. All feature fields (`valence`/`energy`/
`danceability`/`tempo`) will be `null` for those apps; all audio-feature charts
and radar views degrade gracefully to the muted-note state.

All three planned integrations (Google Health sleep, RescueTime productivity,
Spotify music) are now shipped.

### Phone usage (Android push — server side shipped; Android app = Plan 2)

Unlike the cloud integrations there is **no REST API** for Android usage stats;
the data lives on-device (`UsageStatsManager`). So this integration **inverts the
flow**: an on-phone app *pushes* daily usage to the Flask app. Auth is a
**shared bearer token** (RescueTime-style stored secret, **not OAuth** — no
`oauth.py` involvement); provider key `phone` in `integrations.json`; entry field
`usage`. **Plan 1 (this) is the Flask ingestion + analytics side only** — the
Android app + APK CI + Manage-page download QR are Plan 2.

- **`usage.py`** (pure, zero Flask): `parse_push(payload, now=None)` accepts a
  single day dict OR a **list** of days (the worker pushes the last 3 days per
  Decision 8) → list of normalized `usage` dicts (defensive: coerce types, clamp
  negatives to 0, cap `top_apps` at 8 sorted by minutes desc, skip days without a
  valid YYYY-MM-DD `date`, `source:"phone"`). Each `top_apps[]` entry carries
  `{name, label, min, opens}` — `opens` is the per-app foreground-launch count
  that day (`_int`-coerced, clamped ≥ 0, **defaults 0** for payloads/old data
  without it). Aggregation helpers (injectable
  bounds, skip entries lacking usable usage): `usage_minutes_series`,
  `usage_unlocks_series`, `usage_top_apps` (rows `{name, label, min, opens}` —
  sums both minutes AND opens per app, sorted by minutes desc, cap 8),
  `usage_app_minutes_series(entries, start=None, end=None, top_n=6)` → per-day
  minutes for the top-`top_n` apps by total minutes, shaped
  `{apps:[{name,label}], dates:[...], series:{name:[min-per-date...]}}`
  (zero-filled, for a stacked/multi-line chart), `usage_dow_averages`,
  `usage_mood_pairs` (screen_min↔mood, ignores null moods),
  `usage_stats` ({avg_screen_min, avg_unlocks, days}), `_entry_usage(entry)`
  (usable-or-None: screen_min or top_apps present).
- **`integrations.py`**: `phone` in `_empty()`/`load()`; `set_token`/`get_token`
  store the shared bearer token; `is_connected` true when a `token` (or
  `api_key`) exists; `clear_provider("phone")` drops `token` + `last_sync`.
- **`journal.py`**: `set_entry_usage(data, date, value, now=None)` (get-or-create,
  `None` clears) mirrors `set_entry_rescuetime`; `load()` defaults every entry's
  `usage` to `None`; `analytics_payload` carries each entry's `usage` (dict/null).

Entry `usage` model:
```json
"usage": {
  "date": "2026-07-06", "screen_min": 312, "unlocks": 87,
  "top_apps": [{"name": "com.instagram.android", "label": "Instagram", "min": 74, "opens": 41}],
  "first_use": "07:42", "last_use": "23:15",
  "source": "phone", "fetched": "2026-07-07T02:05:00"
}
```

Each `top_apps[]` entry carries per-app **`opens`** (foreground launches that
day, int ≥ 0, default 0 — backward-compatible with pre-opens data). The Android
collector (`UsageReader.readDay`) tallies opens per package in the same
`queryEvents` loop that already reads unlocks/first-use, counting
`ACTIVITY_RESUMED`/`MOVE_TO_FOREGROUND` events keyed on `packageName`; apps with
foreground minutes but no resume event get 0. `UsagePushWorker.serialize` emits
`opens` on each app object.

**Phone routes (in `app.py`):**

| Route | Method | Purpose |
|---|---|---|
| `POST /integrations/phone/ingest` | POST | Validate `Authorization: Bearer <token>` (`secrets.compare_digest`; 401 on missing/mismatch), `usage.parse_push(request.get_json())` → `set_entry_usage` per day, set `last_sync`. Returns `{ok, dates:[...]}`. |
| `POST /integrations/phone/token` | POST | Generate/rotate a random token (`secrets.token_urlsafe`); revealed **once** via a `session` one-shot + flash (never re-rendered from storage). PRG. |
| `POST /integrations/phone/disconnect` | POST | Clear token + last_sync (confirmModal-guarded). |

`_integrations_context()` adds `phone_connected`, `phone_last_sync`,
`phone_endpoint` (this request's origin + `/integrations/phone/ingest`), and
`phone_token` (the one-shot reveal via `session.pop("phone_token_once")`). The
Manage-page **Phone usage** card (`_integrations_cards.html`) shows the endpoint,
generate/rotate token, disconnect, last-received, a "Download the app"
placeholder + a marked QR spot (Plan 2). **No "Sync now"** — data is pushed.

**Phone-usage analytics tab** in `static/analytics.js` (**Digital** category,
gated on `hasUsage`, after Music) via `usageOf(e)` (JS mirror of `_entry_usage`):
stat cards (avg screen time/day, avg unlocks, days tracked); screen time over
time with 7-day rolling avg; **top apps by screen time** over range (bars,
annotated with each app's total opens); **top apps by opens** (bars ranked by
launch count, mirror of the opens side of `usage_top_apps`); **screen time by
app over time** (multi-line chart of the top-6 apps' daily minutes, mirror of
`usage_app_minutes_series`, with a per-app color legend reusing
`.sleep-stage-legend`/`--sl-color`); unlocks over time; avg screen
time by day of week; screen-time↔mood scatter with Pearson `r`. The shared
`aggUsageApps(entries)` helper (JS mirror of `usage_top_apps`) sums per-app
minutes + opens for the app charts. Entry page shows
a read-only `.usage-row` panel (📱 + screen time + top app), server-rendered —
**no client auto-sync** (data is pushed). CSS: `.usage-row`, `.phone-endpoint`,
`.phone-token-reveal`, `.phone-qr`.

### Things to look out for (unverified against live APIs)

All three connectors are **unit/route-tested with fake transports only — none
has been exercised against a real account yet.** When testing live, watch for:

- **Google Health `parse_sleep` field names.** `google_health.parse_sleep`
  reads `sleepSummary` duration/efficiency keys **defensively** because Google's
  exact field names aren't in the public docs. On the first real connection,
  confirm the Sleep-tab values are right; if a key differs, adjust the
  `summary.get(...)` keys in `parse_sleep` (it already degrades gracefully:
  duration falls back to summed stage minutes then interval length, efficiency
  to `None`). Add a fixture from the real response.
- **Google testing-mode 7-day token expiry.** The `googlehealth.sleep.readonly`
  scope is Restricted, so until a Google security review the app is in Testing
  mode and the **refresh token expires ~weekly** — sync then fails with
  `invalid_grant` and the user must re-click **Connect Google Health**. Expected,
  documented in the README.
- **`now` parameter type mismatch (latent footgun).** `google_health.parse_sleep`
  treats `now` as a `datetime`; `oauth.normalize_token_response` treats `now` as
  a float epoch. Both are correct for their callers today (the route never passes
  `now` to `parse_sleep`), but don't cross the wires. Add a docstring noting the
  expected type if you touch either.
- **Spotify is forward-only.** Recently-played caps at ~50 tracks / ~24h, so
  per-day music accumulates from connect onward (no backfill); daily totals are
  best-effort. **Audio features** (valence/energy/…) 403 for apps created after
  Nov 2024 → those fields are `null` and the Music tab hides the feature charts.
- **Analytics charts are not browser-verified.** The Sleep / Productivity / Music
  tabs are covered by payload + `node -c` checks and the route layer, but the
  actual SVG rendering hasn't been eyeballed in a browser. Worth a visual pass
  once real data exists.
- **Benign leftover `"fitbit"` strings.** A few test fixtures use
  `"source": "fitbit"` and `test_integrations.py` uses `"fitbit"` as a generic
  provider name — harmless (provider-agnostic), tidy if convenient.

### Next steps

1. **Test the live API integrations** — connect a real Google Health, RescueTime,
   and Spotify account; confirm each connector's data lands correctly on journal
   days (especially the Google `parse_sleep` field-name check above) and that
   reconnect works.
2. **Analyze the existing analytics** — review/verify the analytics tabs and
   charts (Overview, Mood, Sleep, Productivity, Music, Tags, Numeric, the Tasks
   category) with real data: do a browser pass, sanity-check the numbers against the
   pure helpers, and note any rendering or correctness gaps.

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
  **Overview-suggestion helpers** (powering the upgraded Overview): `_STOPWORDS`
  (+ `_MIN_WORD_LEN`) — a **comprehensive** English stopword list (function words
  + common-but-meaningless words like everything/something/really/going/want/
  just/today/feel/thing — so they never suggest); `word_frequency` ([{word,
  count}] over bodies, sorted count desc then word — the low-level primitive).
  **Smarter tag suggestions (v2):** `tag_suggestions(data, now=None,
  window_days=30, min_days=3, limit=None)` → `[{word, count, days}]` — body words
  over the **last 30 days** (relative to `now`/today, independent of the
  analytics date-range filter) that appear on **≥3 distinct days** (`days` =
  distinct-day count), are **not** a known tag (`_known_tag_names`, `tags ∪
  archived_tags`, case-insensitive), and are **not** dismissed within the 30-day
  cooldown; sorted `days` desc → `count` desc → word; capped to `limit`.
  `suggestion_occurrences(data, word, now=None, window_days=30,
  snippet_radius=40)` → `[{date, snippet}]` (newest first) for windowed entries
  whose body contains `word` as a whole word (case-insensitive); the snippet wraps
  the matched word in `**...**` for client highlighting. `dismiss_suggestion(data,
  word, now=None)` records `data["dismissed_suggestions"][word]=today` (idempotent;
  suppressed while <30 days old, then resurfaces). `apply_tag_suggestion(data,
  word, section_id, dates, permanent, now=None)` — validates the tag name, then
  permanent: `add_section_tag` + tags each date's (get-or-created) entry;
  temporary: tags the entries only (derives as a temporary tag); deduped,
  case-insensitive; unknown section behaves like the sibling helpers. Also
  `dormant_tags(data, now=None, section_name="people", threshold_days=21)`
  ([{name, section_id, last_date, days_since}], most-dormant first) and
  `mood_tag_uplift(entries, ..., min_n=2)` ([{name, section_id, avg_mood,
  baseline, uplift, n}], tag-mean − baseline, sorted |uplift| desc).
  `analytics_payload` carries each entry's `mood` (int 1–7 or null). The
  `tag_suggestions` / `dormant_tags` helpers now power the **Manage page**
  Suggestions section (see below), not the analytics Overview — `analytics_payload`
  no longer carries `suggestions`/`dormant`; the `journal_sections` route computes
  them directly.
  **Leading-indicators helpers** (lagged predictor → next-day mood):
  `lagged_correlation`, `lagged_tag_uplift`, `lagged_difficulty_effect`,
  `leading_indicators` (ranked board), `lag_profile`, plus
  `_predictor_by_date`/`_shift_date`/`lagged_pairs`. No new payload fields — the
  **Leading** tab computes client-side from the existing streams (JS mirrors).
- **`static/analytics.js`** — vanilla SVG charts via a `CHARTS` registry
  (add a chart = append one descriptor). Tabs are grouped into **categories**
  (primary row) → **sub-tabs** (secondary row); see "Analytics restructure"
  above for the full model. The tabs: **Overview** (own category); under
  **Health**: **Mood** (gated on any recorded mood via `hasMood`) and **Sleep**
  (gated on `hasSleep` — see Integrations below); under **Data**: **Numeric**
  (gated on `hasNumeric`, see below) and the cross-domain **Tags** tab (journal
  frequency, trend, per-tag heatmap, co-occurrence, then task-tag frequency);
  under **Digital**: **Productivity** (gated on `hasRescueTime`), **Music**
  (gated on `hasMusic`), **Phone usage** (gated on `hasUsage`) — see Integrations
  below; under **Tasks**: Throughput/Timeliness/Adherence/Difficulty (gated on
  `hasTasks`; the old single "Tasks" tab, refactored — the former separate "Task
  tags" tab is folded into the Tags tab); under **Patterns**: **Leading** (gated
  on `hasLeading` = mood + ≥2 predictor streams + a predictor with ≥`min_n`=5
  lagged pairs; lag selector 0–3, ranked indicator board, lagged scatter,
  lag-profile chart), Consistency (entry calendar, words/entry, gaps,
  time-of-day), and Coverage; plus a shared **Tag** detail (the searched-tag view
  inside the Tags tab) — see the "Tag pages / backlinks" section above. Shared
  date-range filter; refetches on load and on window focus (10s debounce).
  Colors read from CSS vars + section hex.
  - **Mood tab**: mood-over-time (fixed 1–7 axis + 7-day rolling avg overlay),
    average mood by day of week, mood distribution histogram, and mood-vs-numeric
    scatter (one small-multiple per numeric section, with a Pearson `r`).
  - **Sleep tab** (Health category, gated on `hasSleep`): see Integrations section.
  - **Productivity tab** (Digital category, gated on `hasRescueTime`): see Integrations section.
  - **Music tab** (Digital category, gated on `hasMusic`): see Integrations section.
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
  - **Overview tab** is an at-a-glance cross-domain dashboard that *talks and
    routes you onward*, reading top→bottom: (a) prominent **hero stat cards
    with deltas** (entries, current/longest streak, avg mood + sparkline, tasks
    completed, words written, latest value per numeric section) — each card
    carries a **▲/▼ delta vs the immediately preceding equal-length window**
    (green up / red down, muted/omitted when flat or no prior data, skipped
    when the range is open-ended; computed in JS from `_data` by shifting
    `[_from,_to]` back one window via `previousWindow`/`annotateDelta`); (b) a
    **combined activity heatmap** (one month grid per spanned month, each day
    tinted by a mood color ramp — `moodRampColor`, danger→accent — plus entry +
    task-done dot marks and a summarizing `title`; built by
    `buildActivityMonthGrid`/`renderActivityHeatmap`); (c) a **drivers board**
    ("What moves my mood") — a ranked one-line list merging **tag uplift** (JS
    `moodTagUplift` mirror of the pure helper), strongest **mood↔numeric**
    Pearson, and **difficulty→mood** (`difficultyMoodEffect`: mean mood on
    hard-task-completed days vs others), each origin-marked (☑ task / ● journal
    section color) and clickable, thin rows dropped (`renderDriversBoard`);
    (d) the auto-generated **Insights** list (`buildInsights`: weekend-vs-
    weekday mood, best good-mood stretch, streak milestone, strongest mood↔
    numeric correlation); and (e) a compact secondary stats row. (The
    tag-suggestions feature — suggested tags + dormant people + apply popup —
    used to live here; it now lives on the **Manage sections** page, see the
    "Section management" Suggestions note above.) **Clickable launchpad**:
    numeric card → **Data → Numeric**
    (`_secSel.numeric=[id]`); mood card → **Health → Mood**; tasks card →
    **Tasks → Throughput**; any driver naming a tag → **Data → Tags**
    pre-searched (set `_tagQuery`, then `goTo("data", "tags")`). Wired via
    `makeClickable` + `goTo`/`gotoNumeric`/`gotoMood`/`gotoThroughput`/`gotoTag`.
    Styles: `.stat-cards`/`.stat-card*`, `.stat-delta.up/.down`, `.stat-spark`,
    `.insights*`, `.ov-section*`, `.ov-clickable`, `.drivers-list`/`.driver-*`,
    `.heat-legend*` in `style.css`.
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

### Third-party integrations — DONE (all three)

All three data-provider integrations are implemented and shipped. Each connects
once via `/integrations` (settings page) and auto-syncs on journal page load
(throttled to once/hour) and on-demand via "Sync now". See the Integrations section
for full detail on routes, data models, and analytics helpers.

- **Google Health sleep**: `entry["sleep"]` (bedtime/wake/duration/quality/stages) → **Sleep** tab (**Health** category, gated on `hasSleep`): duration/quality trends, bedtime consistency, DOW bars, stage composition, sleep↔mood scatter, coverage.
- **RescueTime productivity**: `entry["rescuetime"]` (pulse/minutes by category) → **Productivity** tab (**Digital** category, gated on `hasRescueTime`): pulse trend, time breakdown, category totals, DOW bars, pulse↔mood scatter.
- **Spotify music**: `entry["music"]` (tracks/minutes/distinct/top_artists + audio features) → **Music** tab (**Digital** category, gated on `hasMusic`): minutes trend, top artists, taste view (top tracks/artists/genres by 4wk/6mo/all-time), valence↔mood scatter and feature radar (gated on `hasFeatures`; gracefully absent for apps affected by the audio-features deprecation).

### Phone usage — server side DONE (Plan 1); Android app = Plan 2

The **Flask ingestion + analytics** side of the phone-usage integration is
shipped (Plan 1): `usage.py`, the `phone` provider + shared-token routes
(`/integrations/phone/{ingest,token,disconnect}`), `entry["usage"]` +
`set_entry_usage`, the Manage-page **Phone usage** card, and the **Phone usage**
analytics tab (gated on `hasUsage`). Fully `curl`-testable now. **Plan 2** (not
built): the in-repo Android app (`android/`) that reads `UsageStatsManager` and
pushes daily, its GitHub Actions APK build/Release, and the Manage-page download
QR. See `docs/superpowers/specs/2026-07-07-phone-usage-integration-design.md`.

### Shipped quality-of-life features

Each was spec'd first under `docs/superpowers/specs/` (brainstorm → spec →
subagent implementation, TDD). See the feature sections above for detail:

- **Task notes + subtasks** (inline dropdown on the active list).
- **Rich journal entries** — Discord-style inline formatting + `@mention` tagging.
- **Mood quick-pick** — optional 1–7 per-entry mood via 7 Pompompurin GIFs.
- **Google Health sleep** — auto-filled `entry["sleep"]` + dedicated Sleep analytics tab.
- **RescueTime productivity** — auto-filled `entry["rescuetime"]` + Productivity analytics tab.
- **Spotify music** — auto-filled `entry["music"]` + Music analytics tab (taste view + audio-feature charts with graceful 403 degradation).

All three planned integrations (Google Health, RescueTime, Spotify) are shipped.

### Future features

Planned additions, in priority order (specs to be written first, as above):

- **Today dashboard** — a combined landing view: tasks due today (with subtask
  progress), today's journal entry + mood, and streak/stat tidbits. Cross-domain;
  reuses `entry_streak`, `today_iso`, and due-date filtering. Likely a new
  `/today` route linked from both navs (purely additive).
- **Command palette (⌘K)** — app-wide fuzzy jump to any page/action, quick-add a
  task, jump to a date.
