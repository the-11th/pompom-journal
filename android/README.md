# Datapom for Android

An offline-first Android companion for Datapom. It writes journal entries,
captures speech transcripts, selects moods and tags, and manages tasks. Changes
are saved on the phone before being sent through an ADB reverse USB tunnel to the Mac,
which remains the only authoritative Datapom data store.

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
- Tasks matches Journal's compact headings, spacing, flat panels and circle
  controls. Completed tasks sit under a counted dropdown, closed initially;
  reopening a task and following a Journal task link remain available.
- Active task countdowns update every 30 seconds and when returning to the app,
  including offline. Deadlines under two days show hours remaining.
- Keystore-protected device credentials, durable journal/task outboxes,
  idempotent retries, and an explicit phone-versus-Mac conflict choice.
- The same dark amber, monospace Datapom visual language and app/mood assets.
- Optional phone-usage upload described below.

Datapom accepts only the USB helper's loopback endpoint. Remote and LAN origins
are rejected by the Android client.

Journal and task tags accept Chinese and other Unicode letters/numbers, plus spaces, `.`, `_`, and `-`. Journal names support up to 200 Unicode characters; case is normalized on save.

## Install and pair

1. Enable USB debugging and authorize the Mac on the unlocked phone.
2. Install the latest APK.
3. Run `bash scripts/sync_android_usb.sh` from the repository root.
4. Journal/task writes queue locally while disconnected and sync on the next
   USB connection.

The Connect screen's **Sync now** button replaces any delayed retry and tests the
Mac connection immediately. **Save entry** always commits the journal entry to
the phone first, then immediately sends the same durable copy to the Mac when it
is reachable; the status changes to **Synced with Mac** after acknowledgement.

## Updating without losing phone entries

Build the APK, connect the phone over USB with USB debugging enabled, then run:

```bash
bash scripts/push_android_update.sh
```

## Two-way USB sync

Connect and unlock the phone with USB debugging enabled, then run:

```bash
bash scripts/sync_android_usb.sh
```

The helper uses `adb reverse` so the phone reaches the Mac-only server at
`http://127.0.0.1:5001`, protected by its per-device bearer token. It performs
a full two-way journal/task sync and the phone reports what moved and anything
that still needs attention.

The helper targets a physical USB device by default. With several phones
attached, choose one with `ANDROID_SERIAL=<serial> bash scripts/sync_android_usb.sh`.
The watcher passes its selected phone serial explicitly, ignores emulators by
default, and waits for **Transferring files / Android Auto** mode. Switching to
that mode on an already connected phone also triggers sync. Failed starts retry
with backoff up to one minute. A revoked
cached device credential is replaced when the helper runs again.
Credentials are provisioned by a local JSON request to the running server, so
pairing cannot overwrite provider settings saved at the same time. The helper
updates only its private token cache. Restart Datapom after updating the server
if an older process reports that USB setup is unavailable.

To start Datapom on the Mac and sync automatically when file transfer is ready:

```bash
bash scripts/install_usb_sync_agent.sh
```

The updater first copies Datapom's phone-local journal drafts, tasks, task
outbox, and usage settings to a temporary Mac backup. Normal same-signature APKs
install in place and Android retains all app data. If the older GitHub debug APK
has a different signing certificate, the script performs a one-time
backup/uninstall/install/restore migration instead of asking you to erase the
entries. Android removes Keystore keys during that one-time migration, so create
a fresh device token and reconnect afterward; later locally built updates install
in place without that step.

Migration runs only when Android explicitly reports a signature mismatch for
the Datapom package. Storage, cable, downgrade, invalid-APK and other-package
errors stop the update with the installed app retained.
The updater also extracts and checks recovery paths before uninstalling. If a
saved filename cannot be restored by the helper, it retains the installed app
and prints the persistent backup location.

Device access can be revoked independently from the Manage card. Reconnecting
with the USB helper creates a fresh credential when needed.

## Optional phone-usage payload

On USB sync the worker POSTs every pending archived day in JSON **arrays**
of at most **30 days per batch** to your endpoint with header
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

1. Run the USB sync helper once; it configures usage automatically.
2. Tap **Grant usage access** → toggle *Datapom* on under
   *Settings → Special access → Usage access*. (This is the special
   `PACKAGE_USAGE_STATS` permission; it is granted here, not via a runtime prompt.)
3. Exclude Datapom from battery optimization (see the Samsung note below).
4. Tap **Send usage now** and watch the status line for a success time. Refresh a
   recent journal day on the computer — the usage panel + Phone-usage analytics
   tab should populate.

## Samsung battery-optimization gotcha (important)

Samsung's **Device Care** ("put unused apps to sleep") will kill background
`WorkManager` jobs after a few days — this is the #1 reason a daily push "works
then stops" on Samsung. **You must exclude this app from battery optimization**:

- Use the in-app **Exclude from battery optimization** button, **or**
- *Settings → Apps → Datapom Usage → Battery → Unrestricted*, **and**
- On Samsung, also check *Settings → Battery → Background usage limits →
  Never sleeping apps* and add Datapom Usage.

## Reachability

The helper creates `adb reverse tcp:5001 tcp:5001`, so the authorized attached
phone can reach the Mac's localhost-only server. Without the cable, writes stay
queued safely on Android.

## Scheduling

Usage is collected locally every six hours, on opening the app, and after a
restart/update. Collection does not require a cable, pairing, Wi-Fi, or charging.
Completed daily summaries are saved atomically in private `files/usage_archive/`
files and retained indefinitely, including after successful upload. Android can
delay background work; keep Datapom excluded from battery optimization.

USB sync sends **all unsynced saved days**, in batches of at most 30. Each batch
stays pending until the Mac acknowledges every date. Interrupted transfers resume
from the remaining days; an old acknowledgement cannot clear a newer snapshot.
Pairing with a different destination resends the retained archive.

On first collection, the app also recovers whatever DAILY intervals Android
still retains. It never substitutes weekly/monthly totals for missing days.
Android's daily interval boundaries can drift around midnight; intervals are
assigned to the local day containing their midpoint and shown as recovered daily
summaries. Missing event details are marked unavailable rather than plotted as
zero unlocks. Recovery fills missing Mac days without replacing existing usage.
Days already discarded by Android cannot be recovered by this app.

The Mac USB watcher checks authorized phones every five seconds and triggers
journal, task, tag, and usage synchronization once per file-transfer interval.
It starts the Mac service in the background if needed; no in-app tap or Mac
window is required. If that service later stops while USB remains ready, the
watcher starts it and retries sync. Healthy connections do not repeatedly sync.
Manual in-app sync uses the same worker path.

## Photos, places, and offline maps

Open **Connect → Photos & places settings** for photo tags, saved places,
map downloads, and tracking. **＋ Photos** opens **This day**, showing only images
whose capture timestamp falls on the selected journal day in the phone's local
time zone. **All photos** includes every image the app has access to, including
other days and unknown capture dates. Selections stay checked when changing tabs;
**Other gallery** also opens Android's picker for additional providers.

The journal's **Photos** tab starts with From/To calendars and a zoomable offline
map. The inclusive range uses each photo's capture date, or its journal date when
the capture date is unknown. Tap a thumbnail pin to open the photo; overlapping
pins offer all photos at that location. Photos without GPS stay in the gallery
below the map. **All dates** clears the range. Download maps in settings for the
map background.

Android Back closes the top dialog first, then
returns from this settings screen to Connect.

Maps can show a one-time current position separately from tracking. A map load
checks only permissions already granted; **Show my location** may request
foreground location access. Fixes expire after 30 seconds and a lookup stops
after 12 seconds or when the native map screen closes. Approximate access keeps
its reported accuracy. This lookup does not save location history or start tracking.

The journal now uses the same bundled editor, photo tools, theme, and maps as the
Mac app. Its pages and media are served from the app's private files; the editor
cannot load arbitrary remote pages through its native bridge.

- Photos, visible or hidden captions, grouped photo tags, text-to-photo links,
  pen strokes, and personal sticker cutouts work on the phone. Original image
  bytes remain unchanged; edited images are separate assets.
- Changes save locally every ten seconds while editing, and photo insertion
  saves immediately. Local drafts survive disconnection. USB synchronization
  exchanges originals, edited files, metadata, messages, and journal documents.
- Maps are downloaded on the Mac in **Photos & places → Maps**. A full USB sync
  copies the world overview and installed regional packs to the phone. Partial
  downloads resume; a pack becomes available after its SHA-256 checksum passes.
  A failed replacement keeps the previous verified pack available. Open maps
  refresh an outdated archive version once while retaining their position.
- Enable location collection in **Photos & places → Tracking** on the phone.
  Android permission is required. A persistent notification makes collection
  visible, and tracking can be paused at any time. Detailed outing mode starts
  when movement is detected; pausing outing detail keeps ordinary visits active.
  Opening the app resumes previously enabled collection after an update or
  process stop, once foreground location access is available. Explicitly disabled
  tracking stays disabled; a one-time map lookup never enables it.
- Visits require ten minutes of accurate observations. Saved places use their
  configured radius, and unnamed stops use a fixed 100-metre area. City labels
  do not turn an entire outing into one stationary visit. Gaps and unreliable
  fixes are not counted as time spent in a place.
- Location history is retained indefinitely. USB sync exchanges changed days
  separately, so it does not download the entire history on each connection.
- Conflicting phone and Mac edits stay available for review. Photo/place
  conflicts are shown in Settings; journal conflicts can be reviewed in the
  editor before choosing which version to keep.

Dictation keeps the existing continuous capture and tag review. It prefers an
installed on-device speech recognizer; offline language support depends on the
phone's speech services and downloaded language packs.

For regression checks on a connected development phone:

```bash
./gradlew testDebugUnitTest assembleDebug assembleDebugAndroidTest
adb install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb shell am instrument -w com.todopup.usage.test/com.todopup.usage.StorageInstrumentation
```

The storage instrumentation uses a disposable preference namespace and cache
folder. It checks concurrent stores, in-flight edits, conflict preservation,
metadata acknowledgements, EXIF rotation/capture time, and original image bytes.
It also runs a detached WebView against synthetic bytes, nested dialogs, and a
linked photo passage, checking Android's actual binary fetch, modal Back handling,
and keyboard activation without switching a passage into edit mode. It does not edit
real journal entries or grant location permissions.

For interactive checks with disposable photos and entries, build `assembleQa`.
This installs as **Datapom QA** (`com.todopup.usage.qa`) with separate private
storage and no production connection credentials. It uses the same app source
and bundled assets, with a distinct `todopup-qa` deep-link scheme. Keep the
normal Datapom installation in place; remove only the QA app after testing.

The same runtime checks can target QA without updating production:

```bash
./gradlew -PtestBuildType=qa assembleQa assembleQaAndroidTest
adb install -r app/build/outputs/apk/qa/app-qa.apk
adb install -r app/build/outputs/apk/androidTest/qa/app-qa-androidTest.apk
adb shell am instrument -w com.todopup.usage.qa.test/com.todopup.usage.StorageInstrumentation
```

This also verifies permission-safe current-location lookup, starred-place
persistence, and contextual photo linking with keyboard focus.

Native task and dialog interactions have a separate runner. Use an unpaired QA
installation with disposable photos; it refuses production and paired apps.
Tasks use an in-memory repository, and the runner starts directly on Tasks so it
does not open or write journal entries. It checks validation, due dates,
failed-save recovery, explicit conflict choices, and gallery rotation.

```bash
./gradlew -PtestBuildType=qa -PtestRunner=com.todopup.usage.NativeUiInstrumentation assembleQa assembleQaAndroidTest
adb install -r app/build/outputs/apk/qa/app-qa.apk
adb install -r app/build/outputs/apk/androidTest/qa/app-qa-androidTest.apk
adb shell am instrument -w com.todopup.usage.qa.test/com.todopup.usage.NativeUiInstrumentation
```

Run this at the default display settings and with a narrow display/larger text.
Restore display settings after testing. Omitting `testRunner` keeps the default
storage runner; build windows must be serialized because both runners use the
same test APK output path.

For the live task countdown checks, use the same QA commands with
`testRunner=com.todopup.usage.TaskCountdownInstrumentation` and run that
instrumentation class. It verifies the 48-hour boundary, periodic updates,
resume, overdue colors, and preservation of an unfinished task draft.

For task layout and completed-history checks, use
`testRunner=com.todopup.usage.TaskLayoutInstrumentation`. It checks expansion,
completion/reopening, Journal links, and draft preservation against disposable
records. Prefer an emulator (`adb -e`) so QA does not stay on the user's phone.

Native map reads use bounded `offset`/`length` requests. This avoids WebView
applying its own HTTP Range seek to an already-sliced response stream.
