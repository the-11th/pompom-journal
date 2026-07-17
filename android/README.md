# TodoPup for Android

An offline-first Android companion for TodoPup. It writes journal entries,
captures speech transcripts, selects moods and tags, and manages tasks. Changes
are saved on the phone before being sent over private Tailscale HTTPS to the Mac,
which remains the only authoritative TodoPup data store.

The original phone-usage integration remains included: with optional Android
Usage access, a daily WorkManager job pushes screen time, unlocks, and top apps.

See the full design in
`docs/superpowers/specs/2026-07-07-phone-usage-integration-design.md`.

## Mobile features

- Journal date, title, body, the same seven Pompompurin mood images as the web
  app, section-grouped tags, temporary/permanent tag addition, and Android speech
  recognition with transcript insertion.
- Active and completed tasks, due dates, tags, notes, subtasks, completion,
  editing, and deletion.
- Keystore-protected device credentials, durable journal/task outboxes,
  idempotent retries, and an explicit phone-versus-Mac conflict choice.
- The same dark amber, monospace TodoPup visual language and app/mood assets.
- Optional phone-usage upload described below.

Tailscale is installed separately; TodoPup does not embed or control a VPN. The
app calls the Mac's private `https://…ts.net` URL like any HTTPS origin.

## Install and pair

1. Enable persistent phone access on the Mac as described in
   [`../docs/PHONE_ACCESS.md`](../docs/PHONE_ACCESS.md).
2. Install Tailscale on the Mac and Android phone and sign both into the same
   tailnet.
3. In desktop TodoPup open **Journal → Manage → Integrations → TodoPup mobile**.
4. Install the latest APK, press **Create pairing QR**, and scan the QR with the
   phone. The code works once and expires after ten minutes.
5. Open TodoPup on Android. Journal/task writes will queue locally whenever the
   Mac is asleep or unreachable and retry later.

Device access can be revoked independently from the same Manage card without
changing the phone-usage integration credential.

## Optional phone-usage payload

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

CI builds it automatically on every push under `android/**` and publishes the
backward-compatible release asset name `phone-usage.apk`. The Manage page links
to that latest APK.

## Optional usage-access setup

1. **Configure usage** — either scan the Phone usage config QR (a
   `todopup://config?url=…&token=…` deep link that pre-fills + saves both fields),
   or paste the **endpoint URL** and **token** manually and tap **Save config**.
2. Tap **Grant usage access** → toggle *TodoPup* on under
   *Settings → Special access → Usage access*. (This is the special
   `PACKAGE_USAGE_STATS` permission; it is granted here, not via a runtime prompt.)
3. Exclude TodoPup from battery optimization (see the Samsung note below).
4. Tap **Send usage now** and watch the status line for a success time. Refresh a
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

## Reachability

The endpoint must be reachable from the phone when the worker runs:

- **Home Wi-Fi only:** the LAN IP works while the phone is home.
- **Anywhere (recommended):** run **Tailscale** on both the computer and the
  phone and use the computer's Tailscale hostname in the endpoint URL.

Persistent phone mode keeps the localhost server running after browser tabs
close. If phone mode is not installed, both entry sync and usage pushes queue or
retry until TodoPup is opened on the Mac again.

## Scheduling

A `PeriodicWorkRequest` (`daily-usage-push`, `KEEP` policy, `NetworkType.CONNECTED`)
runs roughly once a day, retries on failure, and survives reboots.
