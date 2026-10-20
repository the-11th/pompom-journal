# Datapom's private Discord inbox

This receiver runs on **Cloudflare Workers Free** with one SQLite Durable Object.
The Discord application is named **datapom**; its message action is
**Add to Datapom**. Only messages explicitly selected by the configured account
enter this queue. The journal, photos, maps, and tracking history stay on the Mac
and Android device.

Cloudflare currently makes SQLite Durable Objects available on Workers Free.
Free-plan operations fail when a quota is exhausted; they do not automatically
switch to paid overages. Keep the account on Workers Free for this deployment.
The Wrangler configuration creates no paid-plan subscription. See
[Cloudflare's current pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).

## Files and verification

- `src/protocol.mjs`: signed-request verification, owner check, strict parsing,
  bearer authentication, and the existing Mac HTTP contract.
- `src/store.mjs`: transactional SQLite queue and expiring replay receipts.
- `src/worker.mjs`: private Durable Object binding, durable-write acknowledgements,
  and receipt-expiry alarms.
- `wrangler.jsonc`: the `datapom-discord-inbox` Worker and SQLite migration.
- `test/inbox.test.mjs`: real Ed25519 signatures and SQLite transaction tests.
- `test/runtime.test.mjs`: local Cloudflare `workerd` integration, concurrent
  captures, and restart persistence. It creates synthetic credentials and removes
  its temporary queue afterward; it never deploys or reads account credentials.

Use Node.js 24 or newer. From this directory:

```sh
npm ci
npm test
npm run check
npm run test:runtime
```

`check` bundles and validates configuration with `wrangler deploy --dry-run`.
It does not upload the Worker. Wrangler and its matching local simulator are
pinned in `package-lock.json`; they are development tools, not code shipped to
the journal browser. If npm requests approval for dependency install scripts,
Wrangler's platform binaries come from `esbuild` and `workerd`.

For manual local HTTP checks, copy `.dev.vars.example` to `.dev.vars`, fill in
test values, and run `npm run dev`. The local server does not accept arbitrary
message JSON: requests to `/interactions` must still carry a real signature from
the matching test private key. The automated runtime test handles this for you.

## Deploy the receiver

1. In the Discord Developer Portal, create the application **datapom**, enable
   **User Install** with the `applications.commands` scope, and copy its public
   key, application ID, and your own Discord user ID.
2. Sign in to the chosen Cloudflare Free account with `npx wrangler login`.
   Confirm that Workers Free is selected. The default receiver name is
   `datapom-discord-inbox`; change only the `name` if your account needs another
   name. Preserve the Durable Object binding, class, migration, and singleton
   identifier on subsequent updates so the pending queue stays attached.
3. Run `npm run deploy`. Until all three settings below exist, the deployed
   Worker fails closed with `503` and cannot accept or expose messages.
4. Enter each value using Wrangler's private prompt:

   ```sh
   npx wrangler secret put DISCORD_PUBLIC_KEY
   npx wrangler secret put DISCORD_USER_ID
   npx wrangler secret put DATAPOM_INBOX_TOKEN
   ```

   The public key must be 64 hexadecimal characters. The user ID must contain
   only decimal digits. Generate the inbox token from at least **32 random
   bytes**, encoded as base64url (43 or more characters) or hexadecimal (64
   characters). It must contain 43–128 letters, digits, `_`, or `-`.
   Store the same receiver token in the Mac's Discord settings. Do not put a
   Discord account token or application bot token in the receiver.
5. Set Discord's Interactions Endpoint URL to the deployed address plus
   `/interactions`. Its signed verification ping must pass before saving the URL.
6. From the repository root, run
   `.venv/bin/python scripts/register_discord_command.py`. Use the application ID
   and the application's bot token at its private prompts. This token is used
   only to register **Add to Datapom**.
7. In Datapom's Discord settings on the Mac, enter the receiver's HTTPS root URL,
   receiver token, and Discord application ID. Install the user app using its
   install link.
8. Select one test DM → Apps → **Add to Datapom**, sync the Mac inbox, and confirm
   the original author/text/time. The cloud queue should then be empty. USB-sync
   the phone and add the captured message to a journal entry there too.

Do not put an interactive Cloudflare Access login in front of `/interactions`:
Discord must reach it directly. Requests are protected by Discord's signature and
the owner allowlist. `/inbox` and `/inbox/ack` require the separate bearer token.
The Worker exposes no journal API, static files, or account credentials.

## Data behavior

The receiver retains at most **1,000 pending messages or 8 MiB of normalized
message JSON**, whichever fills first. A selected message is limited to 64 KiB;
the incoming signed interaction is limited to 1 MiB. These limits keep inbox
responses below the Mac's existing response limit and the runtime's memory budget.
The queue rejects new captures when full and asks you to sync.

The first queued snapshot of a message is immutable. Selecting the same message
again reports that it is already queued, so an older Mac acknowledgement cannot
delete a replacement it never received. The Mac also deduplicates by message ID;
reselecting an edited Discord message does not replace its imported snapshot.

The Mac saves messages durably before sending `/inbox/ack`. Failed acknowledgements
can be retried. Interaction receipts survive acknowledgement for 660 seconds, then
an alarm removes them. This exceeds the complete replay window for an accepted
future-dated signature. Pending message text does not expire before acknowledgement.
Provider backups or point-in-time recovery may retain older storage versions under
[Cloudflare's storage policy](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

Every response uses `Cache-Control: no-store`. Worker request logging is disabled
in the supplied configuration, and code never logs tokens, raw interactions,
message text, or attachments. Unexpected failures return a generic error; the
receiver never claims capture succeeded before its storage write is durable.

Protocol retained for the Mac:

| Request | Success response |
| --- | --- |
| Signed `POST /interactions` ping | `{"type":1}` |
| Signed selected-message action | Discord ephemeral callback, flags `64` |
| Bearer `GET /inbox` | `{"messages":[...]}` |
| Bearer `POST /inbox/ack`, `{"ids":[...]}` | `{"ok":true}` |

The cloud adapter uses documented
[Durable Object RPC](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/),
[SQLite transactions and storage sync](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/),
and [Web Crypto Ed25519](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/).
