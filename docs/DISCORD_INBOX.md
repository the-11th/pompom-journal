# Your private Discord inbox

Datapom uses Discord's official **message action**. Long-press or right-click a DM
message → Apps → **Add to Datapom**. Only the selected message's text, author,
original timestamp, source link, and attachment filenames are captured. Photos
can be added separately with the journal's photo picker. A copied private message
link alone does not grant access to its text or attachments.

The journal, photos, maps, and location history remain on your devices. A small
HTTPS receiver holds selected messages while your Mac is asleep. After the Mac
has saved them durably, it acknowledges and removes them from the receiver's
queue. Imported copies stay on both devices indefinitely. Installation and fetching
new Discord messages require internet; already imported messages work offline.

## One-time setup

For the free hosted inbox, follow the [Cloudflare Workers setup](../deploy/discord-worker/README.md).
It uses one persistent SQLite Durable Object on Workers Free and does not require
a paid server or exposing the Mac. The receiver is named `datapom-discord-inbox`.

The container-based alternative below is for an existing HTTPS host with a
persistent volume.

1. Create an application named **datapom** in the [Discord Developer Portal](https://discord.com/developers/applications).
   Enable **User Install**, with only the `applications.commands` install scope.
   Record its application ID and public key. Copy your own Discord user ID using
   Discord's Developer Mode. The receiver rejects actions from other accounts.
2. Host the receiver from this repository using the Dockerfile at
   `deploy/discord-inbox/Dockerfile` (repository root is the build context). Use an
   HTTPS host with a persistent volume mounted at `/data`. Do not expose Datapom's
   Mac server to the internet. Set these host secrets:

   - `DISCORD_PUBLIC_KEY`: your application's public key.
   - `DISCORD_USER_ID`: your own Discord user ID.
   - `DATAPOM_INBOX_TOKEN`: a secret generated from at least 32 random bytes,
     encoded as base64url or hexadecimal.

   The container runs `python -m integrations.discord_receiver` from the repository
   root. The receiver listens on port 8080 by default (`PORT` can override it). HTTPS is
   supplied by your hosting provider. A single running instance owns the volume;
   do not scale this file-backed service across multiple instances.
3. Set your Discord application's **Interactions Endpoint URL** to
   `https://YOUR-RECEIVER/interactions`. Discord's signed verification ping should pass.
4. Run `.venv/bin/python scripts/register_discord_command.py` from the repository.
   It prompts privately for your application's bot token; this is not your personal
   Discord account token. The token is used only to register the action.
5. In Datapom on the Mac, open **Manage → Photos & places → Discord inbox**.
   Enter the receiver's HTTPS address, receiver token, and application ID. Save,
   then use the install link to add the action to your Discord account.
6. Try **Add to Datapom** on one message. Use **Sync inbox** on the Mac, connect
   the phone by USB, then choose **＋ Message** in either journal editor. Datapom
   suggests the message's original day and offers the current entry as an override.

## Recovery and privacy

A failed fetch or acknowledgement can be retried without duplicating an insert
or losing the device copy. The cloud queue is capped at 1,000 selected messages;
if it fills, the action asks you to sync before capturing more. Receiver access
uses a separate bearer token. Discord requests must have a valid Ed25519
signature and a recent timestamp. Keep the receiver token out of public links.

The receiver is implemented and tested locally. It is **not hosted or connected
to a Discord account automatically**: those accounts and settings belong to you.

References: [Discord message commands](https://docs.discord.com/developers/interactions/application-commands#message-commands),
[user-installed apps](https://docs.discord.com/developers/tutorials/developing-a-user-installable-app),
[interaction verification](https://docs.discord.com/developers/interactions/receiving-and-responding).
