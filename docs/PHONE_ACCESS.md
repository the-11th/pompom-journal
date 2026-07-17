# TodoPup phone access

TodoPup's Android app connects directly to the Mac over a private Tailscale
network. The Mac remains the source of truth: entries and tasks received from
Android are validated by the same Python domain logic and saved to the existing
JSON stores.

## Prerequisites

- Tailscale installed and signed in on the Mac and Android phone.
- Both devices in the same tailnet.
- The Mac logged in, awake, online, and connected to Tailscale when immediate
  delivery is expected. Android safely queues writes while it is unavailable.
- The repository virtualenv installed with `pip install -r requirements.txt`.

Do not use Tailscale Funnel and do not bind TodoPup to `0.0.0.0`. Tailscale Serve
proxies private HTTPS to the localhost-only Waitress listener.

## Enable persistent mode

First ask Tailscale Serve for the Mac's private URL:

```bash
tailscale serve --bg 5001
tailscale serve status
```

Then install TodoPup's per-user LaunchAgent, substituting the exact HTTPS URL:

```bash
bash scripts/install_phone_access.sh https://your-mac.your-tailnet.ts.net
```

The installer:

- runs `phone_server.py` through the repo virtualenv at login;
- binds Waitress only to `127.0.0.1:5001`;
- disables the browser-tab auto-quit watchdog in phone mode;
- records the public Tailscale origin as `TODOPUP_PUBLIC_URL` so pairing and
  ingest QR codes never contain localhost; and
- configures persistent background Tailscale Serve.

Logs continue to go to `data/server.log`. Development still uses the normal
`flask --app app run --port 5001` command.

## Install and pair Android

1. Open the private HTTPS URL on the Mac or use the dock app.
2. Go to **Journal → Manage → Integrations → TodoPup mobile**.
3. Download/install the APK on Android.
4. Press **Create pairing QR** and scan it with the phone within ten minutes.
5. Open the Android app. Its Connect screen should report that it is ready.

Pairing exchanges a short-lived, single-use code for a random per-device token.
Only token digests are stored on the Mac; the Android token is encrypted with the
Android Keystore. Each paired device is listed separately and can be revoked.

## Sync behavior

- Journal and task mutations are persisted on Android before network work starts.
- WorkManager retries temporary network/server errors.
- Stable request IDs make retries idempotent.
- An edit based on an older Mac entry becomes a visible conflict; neither copy is
  discarded until the user chooses the phone or Mac version.
- Permanent validation/authentication failures remain visible instead of being
  silently removed from the queue.

## Disable

Disable the private proxy with:

```bash
tailscale serve off
launchctl bootout gui/$UID/com.todopup.phone-server
```

The LaunchAgent file is `~/Library/LaunchAgents/com.todopup.phone-server.plist`.
Removing it disables automatic startup. None of these steps delete TodoPup data.
