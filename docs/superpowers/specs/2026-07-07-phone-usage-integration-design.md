# Phone Usage Integration (Samsung / Android) — Design

**Date:** 2026-07-07
**Status:** Draft (brainstorm) — for review before implementation plans
**Scope:** A new **phone-usage** integration with three parts: (A) a small
in-repo **Android app** that reads on-device usage stats and pushes them daily,
(B) an **APK build + distribution** path so the app can be downloaded onto the
phone, and (C) the **Flask ingestion + analytics** side that lands a per-day
`usage` field on the journal and a **Phone usage** analytics tab — mirroring the
shipped Google Health / RescueTime / Spotify integrations.

## Goal

Auto-fill each journal day with **phone screen-time / app-usage** data
(total screen time, unlocks, top apps), with a dedicated analytics tab. Unlike
the cloud integrations, there is **no public REST API** for Samsung/Android
usage stats — the data only exists on-device via `UsageStatsManager`. So this
integration inverts the flow: the **phone pushes** to the app instead of the app
**pulling** from a cloud API. Everything else (per-day structured field, writer,
`load()` default, analytics tab) follows the existing pattern.

## Why this shape (from the research)

- Android exposes usage stats only through **`UsageStatsManager`**
  (`android.app.usage`), gated behind the special `PACKAGE_USAGE_STATS`
  ("Usage access") permission. Digital Wellbeing exposes no external feed;
  Samsung Health is fitness-only. **No cloud/OAuth API exists.**
- Therefore the durable, hands-off (no cable, no Mac dependency, survives
  reboots) option is a **self-contained Android app** that reads stats on-device
  via a daily `WorkManager` job and HTTP-POSTs them to a Flask endpoint.
- This maps onto the **RescueTime API-key model** (a stored shared secret), NOT
  the Google/Spotify OAuth model — so **no `oauth.py` involvement**.

## Architecture

```
[Android phone]                                     [Flask app]
 UsageStatsManager                                   POST /integrations/phone/ingest
   reads yesterday   → WorkManager (daily) → HTTPS →   validate bearer token
   (screen time,        periodic + retries    JSON      → journal.set_entry_usage(date, value)
    unlocks, top apps)   survives reboot                → renders on the day + Phone-usage tab

 First-run config: endpoint URL + bearer token (shown/QR'd by the Manage page)
 Download: GitHub Release APK (reachable from the phone anywhere)
```

## Constraints (from CLAUDE.md, plus Android-specific)

- **Flask side keeps zero new runtime deps.** stdlib only; the ingest route is
  plain JSON. (QR generation — see Distribution — must also avoid a new Python
  dep; render the QR **client-side** in JS, no server library.)
- **Pure-logic / thin-HTTP split.** New `usage.py` domain module has ZERO Flask
  imports; pure parse/aggregate; injectable `now=None`. No test hits a network.
- **TDD** for all Python/pure code: tests first, temp `INTEGRATIONS_FILE` /
  `JOURNAL_FILE`, fixed `now`, `integrations._empty()` / `journal._empty()`.
- **Styling mandatory** — the Manage-page card + analytics tab use `:root` vars,
  themed widgets, `confirmModal`, `enhanceSelect`; no raw/native chrome.
- **Secrets** (the shared ingest token) live only in gitignored
  `data/integrations.json`; never logged or rendered back after first reveal.
- **Server auto-quits with the last tab.** The daily push therefore only lands
  when a browser tab is open (server running). Documented as a known limitation;
  see Open Questions for the always-on option.
- **Android build tooling is NOT a Python dependency.** It lives in `android/`
  and is built by GitHub Actions (or Android Studio), never by the Flask app.
- **The committed/released APK is a binary artifact** — source-of-truth is the
  Kotlin under `android/`; the APK is reproducible from it.

## Decisions (proposed — confirm in review)

1. **Full pipeline**: Android app + APK distribution + per-day journal field +
   analytics tab.
2. **Auth = shared bearer token** (RescueTime-style stored secret), not OAuth.
   Generated on the Manage page, entered into the app once.
3. **Data source = `UsageStatsManager.queryAndAggregateUsageStats` for
   yesterday's full day** (complete, stable — matches how other integrations
   attribute a full day); `queryEvents` for unlock/session counts.
4. **Scheduling = `WorkManager` periodic (1 day)**, network-constrained, unique
   work, `KEEP` policy. Best-effort timing within the interval (fine for a
   nightly roll-up).
5. **Distribution = GitHub Actions build → GitHub Release APK.** The phone
   downloads from GitHub (reachable anywhere, no tunnel needed just to install).
   The Manage page shows the release link + a client-rendered **QR code**.
6. **Daily push reachability = authorized USB only.** The Mac helper creates an
   ADB reverse loopback tunnel and triggers the upload on connection.
7. **Entry field = `usage`** (domain-named like `sleep`/`music`, not provider-
   named); **provider key = `phone`** in `integrations.json`.
8. **Backfill last 3 days per push (resolves Open Question 1).** The worker sends
   an array of the last **3 full days** each run, and `parse_push` accepts a list
   → `set_entry_usage` per day (idempotent overwrite). This makes a missed night
   self-heal on the next successful push and tolerates the auto-quit server
   (the day lands the next time a browser tab is open and the phone retries).
   Server stays auto-quit (no daemon); no change to that model.

---

## Part A — the Android app (`android/`)

Small: one Activity (setup/status), one Worker, a read/serialize helper.

### Repo layout
```
android/
  settings.gradle.kts
  build.gradle.kts
  gradle/ (wrapper)
  app/
    build.gradle.kts
    src/main/AndroidManifest.xml
    src/main/java/.../MainActivity.kt      # setup screen: endpoint+token, Usage-access button, status
    src/main/java/.../UsagePushWorker.kt    # WorkManager worker: read → POST
    src/main/java/.../UsageReader.kt         # UsageStatsManager → data class (unit-testable)
    src/main/java/.../Config.kt              # SharedPreferences: endpoint URL + token
  README.md                                  # build + sideload instructions
```

### Permissions (`AndroidManifest.xml`)
- `PACKAGE_USAGE_STATS` (special "Usage access") — the app deep-links to
  `Settings.ACTION_USAGE_ACCESS_SETTINGS`; granted once, not a runtime prompt.
- `INTERNET` (normal).
- `POST_NOTIFICATIONS` (Android 13+) only if a status notification is shown.
- Prompt `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` — see Samsung gotcha.

### Reading the data (`UsageReader`)
- `queryAndAggregateUsageStats(startOfYesterdayLocal, endOfYesterdayLocal)` →
  `Map<pkg, UsageStats>`; `getTotalTimeInForeground()` per app (ms → min),
  `getLastTimeUsed()`. Sum for `screen_min`; top-N by minutes for `top_apps`.
- `queryEvents(...)` iterate `KEYGUARD_HIDDEN` / `ACTIVITY_RESUMED` to count
  `unlocks` and derive `first_use` / `last_use` (local `HH:MM`).
- Map package name → human label via `PackageManager` where available; keep the
  package name as a fallback (`{name: pkg, label: "Instagram", min: 74}`).
- **Attribute to yesterday's local date** so the number is complete.

### Scheduling (`WorkManager`)
```kotlin
val work = PeriodicWorkRequestBuilder<UsagePushWorker>(1, TimeUnit.DAYS)
  .setConstraints(Constraints.Builder()
    .setRequiredNetworkType(NetworkType.CONNECTED).build())
  .build()
WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
  "daily-usage-push", ExistingPeriodicWorkPolicy.KEEP, work)
```
Persists across reboots; retries on failure (`Result.retry()`). For a roughly
fixed hour, use a one-time worker that reschedules itself.

### The worker (`UsagePushWorker`)
Reads yesterday via `UsageReader`, serializes the JSON body (see Data model),
POSTs to the configured endpoint with `Authorization: Bearer <token>` using
`HttpURLConnection` (no OkHttp dep needed). `Result.success()` / `Result.retry()`.

### Config (`MainActivity` + `Config`)
- Text fields: **endpoint URL** + **token** (persisted in `SharedPreferences`).
- Buttons: "Grant Usage access" (deep-link), "Send test now" (one-time
  `OneTimeWorkRequest`), "Exclude from battery optimization".
- Status line: last successful push time + last error.
- **Fast setup:** scanning the Manage-page QR (a `todopup://config?url=…&token=…`
  deep link) pre-fills endpoint + token. (Optional nicety; manual entry works.)

### Samsung gotcha (must document in `android/README.md`)
Samsung Device Care ("put unused apps to sleep") kills background workers.
Exclude the app from battery optimization or the daily push silently stops after
a few days. This is the #1 reason a WorkManager job "works then quits" on Samsung.

---

## Part B — APK build + distribution

**Build (GitHub Actions, `.github/workflows/android.yml`):** on push affecting
`android/**` (and manual dispatch), set up JDK + Android SDK, run
`./gradlew assembleDebug` (a debug APK is fine for personal sideloading — no
signing ceremony), and upload the APK as a **GitHub Release asset** (tag like
`phone-app-vN`) and a workflow artifact.

**Download onto the phone:** the phone opens the **GitHub Release** APK URL and
installs it (allow "install unknown apps" once). GitHub distribution remains
independent from the USB sync transport.

**Discoverability from the app:** the Manage page **Integrations** section gains
a **Phone usage** card with:
- A **"Download the app"** link to the latest release APK + a **QR code** of
  that URL (rendered **client-side** in JS — a tiny self-contained QR routine,
  no server dep, matching the "no new deps" rule), so you can scan it with the
  phone.
- The **endpoint URL** (auto-filled with the Manage-page origin) and a
  **generated token** to copy into the app (or encode in the config QR).

**Alternative if GitHub Actions is undesirable:** commit a prebuilt
`android/dist/phone-usage.apk` and copy it over USB. The Release path remains the
preferred distribution route.

---

## Part C — Flask ingestion (mirrors RescueTime)

### `integrations.py`
- Add `phone` to `_empty()` (`{"phone": {}}`) and `load()` defaults.
- Store the shared token: reuse `set_api_key`/`get_provider` (token stored like
  RescueTime's `api_key`) or add `set_token`/`get_token` for clarity.
- `is_connected("phone")` true when a token exists. `clear_provider("phone")`
  drops the token + `last_sync`.

### `journal.py`
- `set_entry_usage(data, date, value, now=None)` — get-or-create the entry, set
  `entry["usage"]`, bump `updated` (same shape as `set_entry_sleep`). `None` clears.
- `load()` defaults every entry's `usage` to `None` (`e.setdefault("usage", None)`).

### `usage.py` (new, pure, zero Flask)
- `parse_push(payload, now=None)` → normalized `usage` dict (defensive: clamps
  types, caps `top_apps` at ~8, sorts desc). Pure.
- Aggregation helpers (injectable date bounds; skip entries lacking usable usage;
  degrade gracefully): `usage_minutes_series`, `usage_unlocks_series`,
  `usage_top_apps`, `usage_dow_averages`, `usage_mood_pairs` (screen↔mood pairs),
  `usage_stats` ({avg_min, avg_unlocks, days}), `_entry_usage(entry)` (usable-or-None).

### `app.py` routes
| Route | Method | Purpose |
|---|---|---|
| `POST /integrations/phone/ingest` | POST | Validate `Authorization: Bearer <token>`; parse body via `usage.parse_push`; `journal.set_entry_usage`; set `last_sync`. Returns `{ok, date}`. 401 on bad/missing token. |
| `POST /integrations/phone/token` | POST | Generate/rotate the shared token (PRG + flash; revealed once). |
| `POST /integrations/phone/disconnect` | POST | Clear token + last_sync (confirmModal-guarded). |
| `GET /integrations/phone/apk` | GET | (Fallback only) serve a committed APK. |

`_integrations_context()` exposes `phone_connected`, `phone_last_sync`,
`phone_endpoint` (this origin + `/integrations/phone/ingest`), and the latest
release APK URL for the card.

### Data model — `entry["usage"]`
```json
"usage": {
  "date": "2026-07-06",
  "screen_min": 312,
  "unlocks": 87,
  "top_apps": [{"name": "com.instagram.android", "label": "Instagram", "min": 74}],
  "first_use": "07:42",
  "last_use": "23:15",
  "source": "phone",
  "fetched": "2026-07-07T02:05:00"
}
```

---

## Part D — analytics (Phone usage tab)

New tab in `static/analytics.js` (`lens: ["journal"]`, gated on `hasUsage`,
placed after Music), mirroring Sleep/Productivity/Music via `usageOf(e)`:
- Stat cards: avg screen time/day, avg unlocks, days tracked.
- Screen-time over time (7-day rolling avg overlay).
- Top apps over the range (bar chart).
- Unlocks over time.
- Avg screen time by day of week.
- Screen-time ↔ mood scatter with Pearson `r`.

`analytics_payload` carries each entry's `usage` (dict or `null`). CSS: reuse the
`.rt-row`/`.music-row` panel patterns for an entry-page **usage panel** row
(📱 icon + screen-time + top app), added to `integrations-sync.js`'s provider
registry — though note there's **no client auto-sync** (data is pushed by the
phone), so the entry-page panel is read-only display only, and the Manage-page
card has **no "Sync now"** (nothing to pull).

---

## Connecting a Samsung phone — step by step

This is the end-user flow the design must support (and what the README will
document once shipped). Assumes Android 11+ (Wireless-debugging-era; not needed
here but sets the baseline) and the Flask app running.

**Prerequisites**
1. On your computer, open the journal **Manage** page → **Integrations** →
   **Phone usage** card. Click **Generate token** — copy the token and note the
   USB helper script location.
2. Enable USB debugging and authorize this Mac on the unlocked phone.

**Install the app**
3. On the phone, open the **Download the app** link on the Manage-page card
   (or **scan the QR** with the camera). It points to the latest **GitHub
   Release** APK — downloads over the internet from anywhere.
4. Open the downloaded `.apk`. Android will ask to **allow installing unknown
   apps** for your browser/Files app — allow it once, then install.

**Grant permissions (one time)**
5. Open the app. Tap **Grant Usage access** → it deep-links to
   *Settings → Special access → Usage access* → toggle **Datapom Usage** on.
6. Tap **Exclude from battery optimization** (or *Settings → Apps → Datapom
   Usage → Battery → Unrestricted*). **Do not skip this** — Samsung Device Care
   will otherwise sleep the app and the daily push stops after a few days.
7. On Android 13+, allow notifications if prompted (optional status pings).

**Configure + verify**
8. Run `scripts/sync_android_usb.sh`; it configures the endpoint and credentials.
9. Tap **Send test now**. The status line should show a success time. Refresh
   today's (or yesterday's) journal entry on the computer — the **usage** panel
   should show screen time + top app, and the **Phone usage** analytics tab
   should populate.

**Done — it's automatic**
10. Each USB connection pushes **yesterday + the prior 2 days**. If a day is
    missed, the next successful cable sync backfills it (Decision 8).

**Troubleshooting**
- *No data after a day or two:* re-check the battery-optimization exclusion
  (step 6) — the #1 cause on Samsung.
- *Test push fails:* reconnect the unlocked phone, confirm USB debugging
  authorization, and rerun the helper.
- *401:* token mismatch — regenerate on the Manage page and re-paste.

## Testing

- **Pure (`usage.py`)** — TDD: `parse_push` normalization/defensive cases; every
  aggregation helper with fixed `now`, empty/sparse data, mood pairing.
- **Routes (`test_app.py` / `test_journal_app.py`)** — ingest with valid token
  writes the day; missing/bad token → 401; token generate/disconnect PRG;
  `_integrations_context` fields; `usage` defaults to `None` in `load()`.
- **Analytics** — `analytics_payload` carries `usage`; tab gated on `hasUsage`;
  `node -c static/analytics.js`.
- **Android** — manual (no CI device tests). `UsageReader`'s pure parsing can
  have local JVM unit tests if cheap; the WorkManager/permission flow is
  verified by hand on the phone.

## Open questions / risks

1. **RESOLVED (Decision 8).** Auto-quit stays; the worker pushes the **last 3
   days** each run and `parse_push` accepts a list, so a missed night self-heals
   on the next push. No always-on daemon.
2. **Reachability of the daily push.** Resolved with the authorized ADB reverse
   USB tunnel. Download remains separate via the GitHub Release.
3. **APK build environment.** Requires the Android SDK — hence GitHub Actions (or
   a local Android Studio build). The Flask repo itself never builds it.
4. **`top_apps` labels** need `PackageManager`; some system packages won't
   resolve — keep the package name as a fallback label.
5. **QR client-side** — pick a tiny vendored QR routine or draw via a minimal
   algorithm to honor "no new deps"; confirm licensing.

## Effort

- **Flask + `usage.py` + analytics tab + tests:** ~in line with the RescueTime
  plan (a day-ish), fully in-repo and TDD-able.
- **Android app:** ~a day (single Activity + one Worker + read/serialize).
- **GitHub Actions APK workflow:** a few hours.
- Heaviest-thinking parts: the auto-quit/backfill decision (Q1) and the Samsung
  battery-optimization exclusion.

## File manifest

**New:**
- `android/**` (Gradle project: MainActivity, UsagePushWorker, UsageReader, Config, manifest, README)
- `.github/workflows/android.yml` (build → Release APK)
- `usage.py` (pure)
- Phone-usage analytics tab additions in `static/analytics.js`
- Tests: `tests/test_usage.py`, additions to `test_app.py` / `test_journal_app.py`

**Modified:**
- `integrations.py` (`phone` provider), `journal.py` (`set_entry_usage`, `load()` default),
  `app.py` (ingest/token/disconnect/apk routes + `_integrations_context`),
  `templates/_integrations_cards.html` (Phone-usage card + download link/QR),
  `templates/journal_entry.html` (usage panel row), `static/style.css`
  (usage panel + QR), `static/integrations-sync.js` (read-only usage render),
  `CLAUDE.md` + `README.md` (document the integration + app install).

## Suggested implementation plans (spec-first, TDD, like prior features)

1. **Plan 1 — Flask ingestion + analytics** (`usage.py`, provider, routes,
   `set_entry_usage`, Phone-usage tab, tests). Landable and testable with a
   `curl` push before any Android code exists.
2. **Plan 2 — Android app + APK CI + Manage-page download card/QR.** Depends on
   Plan 1's endpoint being live.
