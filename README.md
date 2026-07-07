# todo·pup

A server-rendered **daily journal + to-do** web app built with Flask, with a
dark-mode "typewriter" aesthetic. Everything is stored in local JSON files (no
database, no cloud) — your data stays on your machine.

- **To-do** — three task views: **Active** (current tasks, overdue first, with a
  live time-remaining badge), **Archive** (completed, with completion date), and
  **Expired** (missed occurrences of recurring tasks). Tick tasks done and hit
  **Refresh** to archive them.
- **Journal** — one entry per day with a mood, tags, and numeric sections, an
  inline "power input" body, and a rich analytics page.
- **Integrations** (optional) — sleep, productivity, music, and phone screen-time
  auto-fill your journal days.

## Features

**To-do**

- Add, **edit** (name + date), complete, and delete tasks
- Optional due date with a live "time remaining" badge (overdue shown in red)
- **Recurring tasks** — daily, weekly, monthly, or every N days. A missed
  occurrence moves to **Expired** and the next occurrence is created automatically.
- Per-task **notes** and a **drag-reorderable subtask** checklist; optional
  difficulty rating

**Journal**

- One entry per calendar day with an optional **1–7 mood**, user-defined **tag**
  and **numeric** sections
- **Power-input body** — inline `@mentions`, `#numbers`, `[]` tasks, rich-text,
  and **voice dictation** (see [Journal power input](#journal-power-input))
- **Analytics** page: mood, sleep, productivity, music, leading indicators, tags,
  numeric trends, coverage, and a cross-domain overview
- **Tag backlinks** unify a tag across both tasks and journal entries

**Integrations** (optional, all local) — Google Health sleep, RescueTime
productivity, Spotify listening, and Android phone screen-time each auto-fill the
matching journal day and add a dedicated analytics tab. See
[Integrations](#integrations).

All data persists locally in `data/` (gitignored, auto-created); no database.

## Tech stack

- Python 3.12+ (developed on 3.13), Flask + Jinja2 templates
- JSON file storage via the standard-library `json` module
- Dates handled with the standard-library `datetime` module
- Frontend is vanilla JS + CSS (no build step, no frontend framework)

### Date assumption

All dates are treated as **naive local time** (no timezone information is
stored or applied). The reference clock is `datetime.now()`.

## Project layout

```
todo-cli/
├── app.py              # Flask routes (thin HTTP layer only)
├── todo.py             # to-do domain logic (no Flask imports, unit-tested)
├── journal.py          # journal domain logic (no Flask imports, unit-tested)
├── oauth.py            # shared OAuth2 helpers (Google Health, Spotify)
├── google_health.py / rescuetime.py / spotify.py / usage.py   # integration clients
├── integrations.py     # third-party credential/token store
├── data/               # local JSON storage (gitignored, auto-created)
├── templates/          # Jinja templates (base, active, journal, analytics, …)
├── static/             # style.css, vanilla JS, images
├── android/            # phone-usage companion app (Kotlin) — see Integrations
├── tests/              # pytest suite
├── docs/               # specs, Automator dock-app files
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

Then open http://127.0.0.1:5001/ in your browser. Your data is saved to `data/`
(created automatically on first use, kept out of version control).

### macOS: launch from an icon

Double-click **`TodoPup.command`** in Finder to start the app and open your
browser automatically. Close the Terminal window (or press `Ctrl+C`) to stop.
(First time: right-click → Open → Open to get past the unidentified-developer
warning.)

### macOS: Automator dock app (TodoPup.app)

A proper macOS app that lives in `/Applications` and can be pinned to your
Dock — no Terminal window. It starts the server in the background, opens your
browser, and auto-quits ~2 seconds after you close the last tab.

The app icon is the Pompompurin & Muffin GIF from `docs/automator/icon.gif`.

#### One-time install

**Step 1 — Complete the standard setup** (virtual environment + dependencies)
if you haven't already:

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

**Step 2 — Run the install script** from the repo root:

```bash
bash docs/automator/install.sh
```

This creates `/Applications/TodoPup.app` and copies the Automator workflow into
it. It's safe to re-run (updates an existing app in place).

**Step 3 — Bypass Gatekeeper on first launch.** macOS will block an app it
hasn't verified. Right-click `TodoPup` in `/Applications` (or Finder), choose
**Open**, then click **Open** in the dialog. You only need to do this once.

**Step 4 — Add to your Dock** (optional). Drag `TodoPup.app` from
`/Applications` into your Dock, or launch it once and right-click its Dock
icon → **Options → Keep in Dock**.

#### Setting the icon

After installing, set the Pompompurin icon:

1. Open **Finder** → navigate to `/Applications`
2. Right-click `TodoPup` → **Get Info**
3. Open `docs/automator/icon.gif` in **Preview**
4. Press **⌘A** then **⌘C** to copy the image
5. Click the small icon in the top-left of the Get Info window to select it
6. Press **⌘V** to paste — the icon updates immediately

#### Manual setup (Automator UI, if the script doesn't work)

1. Open **Automator** → **New Document** → choose **Application**
2. Search the action library for **Run Shell Script** and drag it in
3. Set **Shell** to `/bin/bash`; set **Pass input** to `stdin`
4. Paste the script from `docs/automator/document.wflow` (the
   `COMMAND_STRING` value) into the action, replacing the placeholder — update
   the `cd` path at the top to your repo location
5. **File → Save** → save as **TodoPup** to `/Applications/`

#### Updating after script changes

Re-run the install script to push a new workflow into the existing app:

```bash
bash docs/automator/install.sh
```

To export changes you've made directly in Automator back to the repo:

```bash
cp /Applications/TodoPup.app/Contents/document.wflow docs/automator/document.wflow
git add docs/automator/document.wflow
git commit -m "Update Automator workflow"
```

## Journal power input

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
  the field directly, the field wins. *Example:* `weighed in at #weight 175 today`
  logs `175` to your `weight` section.

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
  the rendered text again to edit it (clicking places the cursor where you click).

- **Voice dictation.** Click the record button in the top-right corner of the
  body box and talk. Words appear at the cursor as you speak (click anywhere in
  the text to move where new words land), highlighted until you press the ✓
  button in the bottom-right to commit them. Speak these shortcuts to insert
  symbols and punctuation:

  | Say | You get |
  |---|---|
  | "at symbol" *word* | `@word` (glued to the next word — feeds `@mention` tagging) |
  | "hashtag" *word* | `#word` (feeds `#numeric` capture) |
  | "checkbox" *or* "open close bracket" | `[]` (feeds `[]` task spawning) |
  | "new line" | line break |
  | "period" / "comma" | `.` / `,` |
  | "question mark" / "exclamation mark" | `?` / `!` |
  | "dot dot dot" | `...` |
  | "parenthesis" … "parenthesis" | `(` then `)` — alternates open/close |

  Because these produce real `@`/`#`/`[]` text, dictation feeds straight into the
  inline grammar above. Requires Google Chrome (uses the Web Speech API); you'll
  be asked for microphone access the first time.

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

**Keyboard shortcuts:** **⌘K** jumps to journal search, **⌘J** to today's entry.

## Integrations

Optional data providers that auto-fill each journal day and add a dedicated
analytics tab. You connect each one once from **journal → Manage → Integrations**
(the section at the bottom of the Manage page). All credentials/tokens/keys live
only in `data/integrations.json`, which is **gitignored** — nothing leaves your
machine except the direct calls each provider requires. Secrets are never
displayed back in the page or written to logs; each card has a **Disconnect**
button to clear its stored data.

### Google Health sleep

Connect a Google Health account once and each night's sleep (bedtime, wake time,
duration, quality, and stages) auto-fills onto the matching journal day, with a
dedicated **Sleep** tab in analytics. (The legacy Fitbit Web API has been removed
— it turns down September 2026 — so Google Health is now the sole sleep source.)

#### One-time setup

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

#### Connect

In **Manage → Integrations**, paste the Client ID and Client Secret into the
**Google Health** card, click **Save credentials**, then **Connect Google
Health**, and approve the permissions on Google's consent screen. On connect, the
last **30 days** of sleep are backfilled automatically.

#### Day-to-day

- Opening the journal auto-syncs the last 7 days of sleep in the background
  (throttled to once an hour); last night's sleep lands on today's entry.
- The **Sync now** button on the Integrations page forces an immediate refresh.
- The **Sleep** analytics tab (under the *Journal* lens) appears once any sleep
  data exists — duration and quality trends, bedtime/wake consistency, sleep
  stages, a sleep-vs-mood comparison, and coverage.

> **Testing-mode token expiry:** The `googlehealth.sleep.readonly` scope is
> Restricted, so until a Google security review the app runs in Testing mode,
> where OAuth refresh tokens **expire after ~7 days**. When sync stops working,
> just reconnect via **Connect Google Health** (your saved credentials stay in
> place). Passing Google's security review grants non-expiring tokens (out of
> scope for personal use).

### RescueTime productivity

Connect a RescueTime account once and each day's productivity (productivity
pulse, productive/distracting/neutral time, and top categories) auto-fills onto
the matching journal day, with a dedicated **Productivity** tab in analytics.
RescueTime uses a simple **personal API key** — no OAuth redirect.

#### One-time setup

1. **Get your API key.** Sign in at
   [rescuetime.com/anapi/manage](https://www.rescuetime.com/anapi/manage) and
   copy your **API key** (create one if you don't have it yet).

2. **Connect from the app.** In **Manage → Integrations**, paste the key into the
   RescueTime card and click **Save key**. That's it.

#### Day-to-day

- Opening the journal auto-syncs (throttled to once an hour). RescueTime's daily
  summary feed covers roughly the **last two weeks**, so recent days backfill
  automatically.
- The **Sync now** button forces an immediate refresh.
- The **Productivity** analytics tab (under the *Journal* lens) appears once any
  RescueTime data exists — pulse over time, productive vs distracting vs neutral
  time, time by category, by-weekday, and a productivity-vs-mood comparison.

### Spotify listening

Connect a Spotify account once and each day's listening (tracks played, minutes,
top artists, and — when available — audio features like valence/energy) auto-fills
onto the matching journal day, with a dedicated **Music** tab in analytics that
also shows your **taste** (top tracks/artists/genres over time).

#### One-time setup

1. **Register a Spotify app.** Sign in at
   [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard),
   create an app, and set:
   - **Redirect URI:** `http://127.0.0.1:5001/integrations/spotify/callback`
   - **API used:** Web API

   After saving, copy the app's **Client ID** and **Client Secret** (Settings).

2. **Connect from the app.** In **Manage → Integrations**, paste the Client ID
   and Client Secret into the Spotify card, click **Save credentials**, then
   **Connect to Spotify**, and approve the `user-read-recently-played` and
   `user-top-read` permissions.

#### Day-to-day

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

### Phone usage (Samsung / Android)

Get your daily **screen time, unlocks, and top apps** onto each journal day, with
a dedicated **Phone usage** analytics tab. Android exposes usage stats only
on-device (there is no cloud API), so this integration works differently from the
others: a small companion app on your phone reads the stats and **pushes** them
to todo·pup once a day. The app source lives in `android/` and is built into a
downloadable APK by GitHub Actions.

#### Install the app

1. In **Manage → Integrations → Phone usage**, click **Generate token** — this
   shows the **endpoint URL**, a **config QR**, and a **download QR**.
2. On the phone, **scan the download QR** (or open
   [the latest release APK](https://github.com/jxi-idme/todo-cli/releases/latest/download/phone-usage.apk)).
   Allow "install unknown apps" for your browser once, then install.

#### Connect your phone (step by step)

1. Open the app → tap **Grant Usage access** → in *Settings → Special access →
   Usage access*, toggle the app **on**.
2. Tap **Exclude from battery optimization** (or *Settings → Apps → the app →
   Battery → Unrestricted*). **Don't skip this** — Samsung's Device Care will
   otherwise sleep the app and the daily push stops after a few days.
3. Back in the app, **scan the config QR** from the Manage page to auto-fill the
   endpoint URL + token (or paste them manually).
4. Tap **Send test now**. Refresh yesterday's/today's journal entry on the
   computer — the **usage** panel should show screen time + top app, and the
   **Phone usage** analytics tab should populate.

#### Day-to-day

- The app pushes **yesterday + the prior 2 days** roughly once a day (best-effort
  within a 24-hour window), retrying on failure and surviving reboots. Nothing to
  plug in.
- If a night is missed, the next successful push **backfills** it (the 3-day
  window self-heals).
- The **Phone usage** analytics tab appears once any usage data exists — screen
  time over time, top apps, unlocks, by-weekday, and a screen-time-vs-mood
  comparison.

> **Reachability:** the phone must reach the Flask app when it pushes. On the same
> home Wi-Fi, the endpoint's LAN IP works; to sync from anywhere, install
> **Tailscale** on both the Mac and the phone and use the Mac's Tailscale hostname
> as the endpoint.
>
> **Server availability:** the server auto-quits shortly after you close the last
> browser tab, so a push only lands while a tab is open — but the 3-day backfill
> means a missed day catches up on the next successful push.

See `android/README.md` for building/sideloading the app yourself.

## Development

### Tests

```bash
pytest                                   # full suite
pytest tests/test_todo.py                # core to-do logic
pytest tests/test_app.py                 # Flask route tests
pytest -k time_remaining                 # single test by name substring
```

Tests are written first (TDD). Pure logic lives in Flask-free modules
(`todo.py`, `journal.py`, integration clients) with an injectable clock; the HTTP
layer in `app.py` stays thin. See `CLAUDE.md` for the full architecture and
conventions.

### Building the phone-usage app

The Android companion app under `android/` is built automatically by
`.github/workflows/android.yml` on pushes touching `android/**`, and published as
a GitHub Release asset (`phone-usage.apk`). To build it locally you'll need the
Android SDK — see `android/README.md`.
