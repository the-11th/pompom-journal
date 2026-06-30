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

## Fitbit sleep integration

Connect a Fitbit account once and each night's sleep (bedtime, wake time,
duration, and quality) auto-fills onto the matching journal day, with a
dedicated **Sleep** tab in analytics. No data is entered by hand. Everything
runs locally — your Fitbit credentials and tokens live only in
`data/integrations.json`, which is gitignored.

### One-time setup

1. **Register a personal Fitbit app.** Sign in at
   [dev.fitbit.com](https://dev.fitbit.com/apps/new) and create an app with:
   - **OAuth 2.0 Application Type:** `Personal`
   - **Callback URL:** `http://127.0.0.1:5001/integrations/fitbit/callback`
   - **Default Access Type:** `Read-Only`

   After saving, copy the app's **OAuth 2.0 Client ID** and **Client Secret**.

2. **Connect from the app.** Start todo·pup (`flask --app app run --port 5001`),
   open http://127.0.0.1:5001/, go to the **journal** → **Manage**, and scroll to
   the **Integrations** section at the bottom. Paste the Client ID and Client
   Secret into the Fitbit card, click **Save credentials**, then
   **Connect to Fitbit**. Approve the `sleep` permission on Fitbit's page.

3. You're done. On connect, the last **30 days** of sleep are backfilled.

### Day-to-day

- Opening the journal auto-syncs the last 7 days of sleep in the background
  (throttled to once an hour); last night's sleep lands on today's entry.
- The **Sync now** button on the Integrations page forces an immediate refresh.
- The **Sleep** analytics tab (under the *Journal* lens) appears once any sleep
  data exists — duration and quality trends, bedtime/wake consistency, sleep
  stages, a sleep-vs-mood comparison, and coverage.

> **Note on "quality":** Fitbit's public API exposes sleep **efficiency**
> (0–100) and the stage breakdown, but not the in-app Sleep Score for most apps.
> Quality shows efficiency (labeled accordingly), and uses the Score
> automatically if your app does return it.

The Fitbit **Client Secret** is never displayed back in the page or written to
logs. Use **Disconnect** on the Integrations page to remove the stored tokens.

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
