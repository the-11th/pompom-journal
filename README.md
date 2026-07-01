# todo·pup

A simple server-rendered to-do web app built with Flask, with a dark-mode
"typewriter" aesthetic. Tasks are stored in a single local JSON file (no
database). Three views:

- **Active** — your current tasks, sorted with overdue items first, then by
  soonest due date, with undated tasks last. Each task shows a time-remaining
  badge (overdue tasks are shown in red). Tick the tasks you've finished and
  hit **Refresh** to move them to the archive.
- **Archive** — completed tasks with the date they were completed.
- **Expired** — missed occurrences of recurring tasks (see below).

## Features

- Add, **edit** (name + date), complete, and delete tasks
- Optional due date with a live "time remaining" badge; overdue shown in red
- **Recurring tasks** — daily, weekly, monthly, or every N days. When a
  recurring task's deadline passes uncompleted, the missed occurrence moves to
  the **Expired** section and the next occurrence is created automatically.
- All data persists locally between launches in `data/tasks.json`

## Tech stack

- Python 3.12+ (developed on 3.13), Flask + Jinja2 templates
- JSON file storage via the standard-library `json` module
- Dates handled with the standard-library `datetime` module

### Date assumption

All dates are treated as **naive local time** (no timezone information is
stored or applied). The reference clock is `datetime.now()`.

## Project layout

```
todo-cli/
├── app.py              # Flask routes (thin HTTP layer)
├── todo.py             # Core logic, no Flask imports (fully unit-tested)
├── data/               # local storage (tasks.json is gitignored, auto-created)
├── templates/          # base / active / archive / edit Jinja templates
├── static/             # style.css + mascot image
├── tests/              # pytest test suite
└── TodoPup.command     # double-click launcher (macOS)
```

## Setup

Any machine with Python 3.12+ — no extra tools needed:

```bash
python3 -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

## Run

```bash
flask --app app run --port 5001
```

Then open http://127.0.0.1:5001/ in your browser.

Your tasks are saved to `data/tasks.json`, which is created automatically on
first use and kept out of version control — your task list stays private to
your machine.

### macOS: launch from an icon

Double-click **`TodoPup.command`** in Finder to start the app and open your
browser automatically. Close the Terminal window (or press `Ctrl+C`) to stop.
(First time: right-click → Open → Open to get past the unidentified-developer
warning.)

## Google Health sleep integration

Connect a Google Health account once and each night's sleep (bedtime, wake time,
duration, quality, and stages) auto-fills onto the matching journal day, with a
dedicated **Sleep** tab in analytics. No data is entered by hand. Everything
runs locally — your Google credentials and tokens live only in
`data/integrations.json`, which is gitignored. The legacy Fitbit Web API has
been removed (it turns down September 2026); Google Health is now the sole sleep
source.

### One-time setup

1. **Create a Google Cloud project and enable the Google Health API.** Go to
   [console.cloud.google.com](https://console.cloud.google.com), create or
   select a project, and enable the **Google Health API** for it.

2. **Create an OAuth 2.0 Client ID.** In the project's **APIs & Services →
   Credentials**, create a credential of type **Web application**. Set the
   **Authorized redirect URI** to:
   ```
   http://127.0.0.1:5001/integrations/google/callback
   ```
   After saving, copy the **Client ID** and **Client Secret**.

3. **Add the sleep scope.** On the **Data Access** page, add the scope:
   ```
   https://www.googleapis.com/auth/googlehealth.sleep.readonly
   ```

4. **Add your Google account as a test user.** On the **Audience** page
   (publishing status: **Testing**, user type: **External**), add your own
   Google account under **Test users**.

### Connect

Start todo·pup, open http://127.0.0.1:5001/, go to **journal → Manage →
Integrations** (bottom of the page). Paste the Client ID and Client Secret into
the **Google Health** card, click **Save credentials**, then **Connect Google
Health**. Approve the permissions on Google's consent screen. On connect, the
last **30 days** of sleep are backfilled automatically.

### Day-to-day

- Opening the journal auto-syncs the last 7 days of sleep in the background
  (throttled to once an hour); last night's sleep lands on today's entry.
- The **Sync now** button on the Integrations page forces an immediate refresh.
- The **Sleep** analytics tab (under the *Journal* lens) appears once any sleep
  data exists — duration and quality trends, bedtime/wake consistency, sleep
  stages, a sleep-vs-mood comparison, and coverage.

> **Note on testing-mode token expiry:** The `googlehealth.sleep.readonly` scope
> is Restricted, so until a Google security review the app runs in Testing mode.
> In Testing mode, OAuth refresh tokens **expire after approximately 7 days**. When
> sync stops working, simply reconnect via the same **Connect Google Health** flow
> (your saved credentials stay in place — just click Connect again and approve).
> Passing Google's security review grants non-expiring tokens (out of scope for
> personal use).

The Google Health **Client Secret** is never displayed back in the page or
written to logs. Use **Disconnect** on the Integrations page to remove the
stored tokens.

## RescueTime productivity integration

Connect a RescueTime account once and each day's productivity (productivity
pulse, productive/distracting/neutral time, and top categories) auto-fills onto
the matching journal day, with a dedicated **Productivity** tab in analytics.
RescueTime uses a simple **personal API key** — no OAuth redirect. The key lives
only in `data/integrations.json` (gitignored).

### One-time setup

1. **Get your API key.** Sign in at
   [rescuetime.com/anapi/manage](https://www.rescuetime.com/anapi/manage) and
   copy your **API key** (create one if you don't have it yet).

2. **Connect from the app.** Start todo·pup, open http://127.0.0.1:5001/, go to
   the **journal** → **Manage** → **Integrations** section at the bottom, paste the
   key into the RescueTime card, and click **Save key**. That's it — you're
   connected.

### Day-to-day

- Opening the journal auto-syncs (throttled to once an hour). RescueTime's daily
  summary feed covers roughly the **last two weeks**, so recent days backfill
  automatically.
- The **Sync now** button on the Integrations page forces an immediate refresh.
- The **Productivity** analytics tab (under the *Journal* lens) appears once any
  RescueTime data exists — pulse over time, productive vs distracting vs neutral
  time, time by category, by-weekday, and a productivity-vs-mood comparison.

Use **Disconnect** on the Integrations page to remove the stored key.

## Spotify listening integration

Connect a Spotify account once and each day's listening (tracks played, minutes,
top artists, and — when available — audio features like valence/energy) auto-fills
onto the matching journal day, with a dedicated **Music** tab in analytics that
also shows your **taste** (top tracks/artists/genres over time). Credentials and
tokens live only in `data/integrations.json` (gitignored).

### One-time setup

1. **Register a Spotify app.** Sign in at
   [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard),
   create an app, and set:
   - **Redirect URI:** `http://127.0.0.1:5001/integrations/spotify/callback`
   - **API used:** Web API

   After saving, copy the app's **Client ID** and **Client Secret** (Settings).

2. **Connect from the app.** Start todo·pup, open http://127.0.0.1:5001/, go to
   the **journal** → **Manage** → **Integrations** section at the bottom, paste the
   Client ID and Client Secret into the Spotify card, click **Save credentials**,
   then **Connect to Spotify**. Approve the `user-read-recently-played` and
   `user-top-read` permissions on Spotify's page.

### Day-to-day

- Opening the journal auto-syncs (throttled to once an hour); the **Sync now**
  button forces an immediate refresh.
- The **Music** analytics tab (under the *Journal* lens) appears once any
  listening data exists — minutes-listened trend, top artists, your taste view,
  and (when audio features are available) a valence-vs-mood comparison and
  audio-feature averages.

> **Forward-only:** Spotify's API has no "history" endpoint — recently-played is
> capped at the last ~50 tracks / ~24 hours — so listening data accumulates from
> the moment you connect onward (no historical backfill), and daily totals are
> best-effort.
>
> **Audio features:** Spotify deprecated the audio-features endpoint for apps
> created after Nov 2024. If your app can't access it, valence/energy/etc. are
> simply omitted and those two charts hide — everything else still works.

The Spotify **Client Secret** is never displayed back in the page or written to
logs. Use **Disconnect** on the Integrations page to remove the stored tokens.

## Test

```bash
pytest
```

## Special features — journal power input

The journal entry body is more than a plain text box. A few inline conventions
let you capture structured data without leaving the keyboard or reaching for a
separate field:

- **`@mention` tagging.** Type `@alex` in your entry — if `alex` is an existing
  tag, it's highlighted in that tag's color and added to the day's tags when you
  save. Underscores match multi-word tags: `@alex_dad` → the `alex dad` tag.
  Mentions are **additive** — they never remove a tag you picked from the chips.
  *Example:* `lunch with @alex, then @gym` tags the day `alex` and `gym`.

- **`#numeric` capture.** Type `#name value` to log a numeric section inline — if
  `name` is an existing numeric section, the value fills that section's field for
  the day (the `#` is dropped on render and the section's unit is appended).
  Underscores match multi-word sections: `#hours_slept 7.5` → the `hours slept`
  section. The value reflects into the field on blur; if you also type a value in
  the field directly, the field wins. The mnemonic: **`@` = who/what (tags), `#`
  = how much (numbers).** *Example:* `weighed in at #weight 175 today` logs `175`
  to your `weight` section.

- **`[]` task spawning.** Start a line with `[]` (or `- [ ]`) to spawn a real
  to-do on your active list when you save. An optional `>due` token sets the due
  date — `>today`, `>tomorrow`, a weekday (`>friday`/`>fri`, next occurrence),
  `>+3d`/`>+2w`/`>+1m`, or an ISO date (`>2026-07-04`) — all due at 23:59. Any
  `@mention` on the line tags the **task** too, so it shows up under that tag
  across both domains. Once saved, the marker becomes a live checkbox that
  mirrors the task's done-state (✓ when completed elsewhere). *Example:*
  `[] lunch with @alex >friday` spawns a task "lunch with @alex" due Friday,
  tagged `alex`.

- **Rich-text formatting (Discord-style).** Wrap text in `**bold**`, `*italic*`,
  `__underline__`, or `~~strikethrough~~`. The body shows the raw markup while
  you're typing and renders the formatted result the moment you click away — click
  the rendered text again to edit it.

- **Mood quick-pick.** Choose a **1–7** mood for the day from the row of
  Pompompurin faces on the "What happened today" line; click the chosen face
  again to clear it. Your mood powers the **Mood** analytics tab and the
  cross-domain "what moves my mood" insights.

- **Leading-indicators analytics.** A **Leading** analytics tab (under the
  *Journal* lens) answers *"what predicts tomorrow's mood?"* — it correlates each
  predictor stream (sleep, productivity, music, journal numbers, tags, and
  hard-task completions) on day *D* against your mood on day *D+lag*, ranks the
  strongest leading indicators, and shows a lag-profile so you can see whether an
  effect is same-day or genuinely predictive. Every row shows `r`/uplift and `n`;
  it reports correlation, not causation.

- **Tag backlinks.** Click any tag chip (on the Archive page or in journal search)
  to open a popover summarizing that tag across **both** tasks and journal entries;
  **Expand →** jumps to the full **Tags** analytics view, pre-searched.

> The inline-grammar mnemonic: **`@` tags the day · `#` logs a number · `[]`
> spawns a task.**
