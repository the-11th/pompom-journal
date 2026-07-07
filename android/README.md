# TodoPup Usage — Android phone-usage pusher

A tiny Android app that reads on-device usage stats (screen time, unlocks, top
apps) via `UsageStatsManager` and **pushes** them once a day to the TodoPup Flask
app's ingest endpoint. It mirrors the RescueTime-style shared-token model — there
is no cloud API for Android usage stats, so the phone pushes instead of the
server pulling.

See the full design in
`docs/superpowers/specs/2026-07-07-phone-usage-integration-design.md`.

## What it sends

On each run the worker POSTs a JSON **array** of the last **3 full days** (so a
missed night self-heals on the next push) to your endpoint with header
`Authorization: Bearer <token>`. Each element:

```json
{
  "date": "2026-07-06",
  "screen_min": 312,
  "unlocks": 87,
  "top_apps": [{"name": "com.instagram.android", "label": "Instagram", "min": 74}],
  "first_use": "07:42",
  "last_use": "23:15",
  "source": "phone"
}
```

This matches the Flask side's `usage.parse_push` contract exactly.

## Build

Requires JDK 17 and the Android SDK (Android Studio, or the CI workflow at
`.github/workflows/android.yml`). From this `android/` directory:

```bash
./gradlew assembleDebug
```

The debug APK lands at `app/build/outputs/apk/debug/app-debug.apk`. A
**debug-signed** APK is intentional — no keystore/signing ceremony is needed for
personal sideloading.

CI builds it automatically on every push under `android/**` and publishes it as
`phone-usage.apk` on a GitHub Release, so you normally just download it from the
Manage page (see below) rather than building locally.

## Install (sideload)

1. On your computer open the journal **Manage** page → **Integrations** →
   **Phone usage** card.
2. Scan the **download QR** with the phone (or open the "Download the app" link).
   It points at the latest GitHub Release `phone-usage.apk`, reachable from the
   phone anywhere over the internet.
3. Open the downloaded `.apk`; allow "install unknown apps" for your browser/Files
   app once, then install.

## First-run setup

1. **Configure** — either **scan the config QR** on the Manage page (a
   `todopup://config?url=…&token=…` deep link that pre-fills + saves both fields),
   or paste the **endpoint URL** and **token** manually and tap **Save config**.
2. Tap **Grant Usage access** → toggle *TodoPup Usage* on under
   *Settings → Special access → Usage access*. (This is the special
   `PACKAGE_USAGE_STATS` permission; it is granted here, not via a runtime prompt.)
3. Tap **Exclude from battery optimization** (see the Samsung gotcha below).
4. Tap **Send test now** and watch the status line for a success time. Refresh a
   recent journal day on the computer — the usage panel + Phone-usage analytics
   tab should populate.

## Samsung battery-optimization gotcha (important)

Samsung's **Device Care** ("put unused apps to sleep") will kill background
`WorkManager` jobs after a few days — this is the #1 reason a daily push "works
then stops" on Samsung. **You must exclude this app from battery optimization**:

- Use the in-app **Exclude from battery optimization** button, **or**
- *Settings → Apps → TodoPup Usage → Battery → Unrestricted*, **and**
- On Samsung, also check *Settings → Battery → Background usage limits →
  Never sleeping apps* and add TodoPup Usage.

## Reachability of the daily push

The endpoint must be reachable from the phone when the worker runs:

- **Home Wi-Fi only:** the LAN IP works while the phone is home.
- **Anywhere (recommended):** run **Tailscale** on both the computer and the
  phone and use the computer's Tailscale hostname in the endpoint URL.

Note the Flask server **auto-quits when the last browser tab closes**, so a push
only lands while a tab is open. Missed days self-heal via the 3-day backfill on
the next successful push.

## Scheduling

A `PeriodicWorkRequest` (`daily-usage-push`, `KEEP` policy, `NetworkType.CONNECTED`)
runs roughly once a day, retries on failure, and survives reboots.
