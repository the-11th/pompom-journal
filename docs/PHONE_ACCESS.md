# Datapom USB phone sync

Datapom's Android app synchronizes with the Mac only while attached by USB. The
Mac remains authoritative: Android changes are validated by the same Python
domain logic and saved to the existing JSON stores.

## Prerequisites

- The repository virtualenv installed with `pip install -r requirements.txt`.
- Android platform tools (`adb`) installed on the Mac.
- USB debugging enabled and authorized on the unlocked phone.
- USB mode set to **Transferring files / Android Auto**.

The server binds only to `127.0.0.1:5001`. `adb reverse` exposes that loopback
listener only to the attached, authorized Android device; Datapom never opens a
LAN-facing port.

## Sync now

Connect and unlock the phone, then run:

```bash
bash scripts/sync_android_usb.sh
```

The helper:

- starts the localhost-only phone server when necessary;
- creates or reuses revocable journal/task and phone-usage credentials;
- creates `adb reverse tcp:5001 tcp:5001`;
- configures both Android sync clients with loopback endpoints;
- starts a full two-way journal/task/tag sync; and
- uploads every unsynced day from the phone's durable usage archive in batches
  of at most 30, including any retained Android daily history recovered on setup.

The phone saves completed usage days every six hours even while unplugged.
Saved days remain on the phone after upload; failed or partial acknowledgements
leave them queued for the next USB connection. Android may delay background jobs,
so keep Datapom's battery setting unrestricted. The first collection can recover
only daily history Android still retains, not individual days from weekly totals.

The Android app opens its Connect screen and reports `Synced:` and `Not synced:`
details. Blank autosave placeholders are neither uploaded nor shown as calendar
entries. Conflicts and rejected mutations remain on the phone until resolved.

## Automatic sync on connection

Install the per-user watcher once:

```bash
bash scripts/install_usb_sync_agent.sh
```

It checks every five seconds for an authorized phone in **Transferring files /
Android Auto** mode. Connecting in that mode or switching to it on the same
cable starts the Mac service if needed and runs the sync helper automatically.
No in-app tap or Mac window is needed.

Healthy connections trigger once per file-transfer interval. Failed starts
retry with backoff up to one minute; if the Mac service later stops, the watcher
starts it and retries. Switching out of file-transfer mode or disconnecting
prepares the watcher for the next interval. Logs stay in `data/usb-sync*.log`.

## Safe Android updates

Build the APK and run:

```bash
bash scripts/push_android_update.sh
```

Normal updates install in place. If an old APK has a mismatched signature, the
script validates a backup, restores allowlisted preferences individually, and
verifies them byte-for-byte before reporting success. Backups are retained under
`data/phone-backups/`.

## Disable automatic sync

```bash
launchctl bootout gui/$UID/com.todopup.usb-sync
```

The LaunchAgent is `~/Library/LaunchAgents/com.todopup.usb-sync.plist`. Disabling
it does not delete Mac or phone data; manual USB sync continues to work.
The service identifier is retained for compatibility with existing installations.

## Configuration

The persistent server accepts `DATAPOM_LISTEN` (default `127.0.0.1:5001`).
The USB helper accepts `DATAPOM_USB_TOKEN_FILE`, `DATAPOM_SKIP_SERVER_CHECK`,
and `DATAPOM_USAGE_SYNC_WAIT_SECONDS`. Their former `TODOPUP_*` names still work;
the Datapom names take precedence when both are provided.
