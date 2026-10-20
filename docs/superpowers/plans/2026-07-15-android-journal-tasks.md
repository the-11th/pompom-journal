# Datapom Android Journal + Tasks Implementation Plan

**Date:** 2026-07-15  
**Status:** In progress  
**Goal:** Expand the existing Datapom Usage Android app into a polished private
Datapom companion that creates and edits journal entries and manages tasks over
an authorized USB connection, without introducing a second source of truth.

## Product contract

- The Mac remains authoritative. Android never edits or synchronizes the JSON
  files directly; it calls authenticated Flask endpoints that delegate to the
  existing pure `journal.py` and `todo.py` behavior.
- An ADB reverse tunnel is the only transport. Datapom accepts the Mac loopback
  origin and rejects LAN or remote endpoints.
- Phone writes are local-first. A journal or task mutation is persisted to an
  Android outbox before transmission, survives process death/reboot, and is
  retried by WorkManager when the Mac is reachable.
- Retried requests are idempotent. Every mutation carries a stable UUID.
- Stale edits never silently overwrite newer Mac data. Update requests include
  the revision last seen by the phone; mismatches return HTTP 409 and remain in
  a visible conflict state until the user resolves them.
- The existing phone-usage collection and scheduled upload keep working.

## Experience and visual direction

The Android app should feel like the web app, not like an unrelated settings
utility:

- Dark background/panels, amber accent, muted text, danger red, monospace type.
- Reuse the web app's Datapom/Pompompurin launcher, mascot, integration, and
  seven mood images. Raster files are copied into Android resources rather than
  fetched from the Flask server.
- Bottom navigation: **Journal**, **Tasks**, **Sync**, **Settings**.
- All controls have clear selected, pressed, focused, disabled, pending, error,
  and conflict states; minimum comfortable touch targets; screen-reader labels;
  no unthemed platform widgets.
- The journal screen prioritizes body capture. Date/title sit above a large body
  editor; mood and tags are compact expandable sections; Save is persistent and
  reachable above the keyboard.
- Audio transcription has an explicit idle/recording/review flow. Transcript
  text is inserted into the editable body only after confirmation and can be
  corrected before saving. Audio itself is not uploaded or retained.
- Tags are grouped by the same section names/colors as the web app. Permanent
  tags toggle as chips; a themed add-tag flow supports temporary or permanent
  additions. Managed/archived sections remain server-controlled.
- Tasks expose active items first, with add, complete/uncomplete, edit, due date,
  recurrence, difficulty, tags, notes, and subtasks. Destructive actions require
  a themed confirmation surface.

## Network/API contract

All mobile routes live under `/api/mobile`. JSON errors use
`{"ok": false, "error": {"code": "...", "message": "..."}}`. Device routes
authenticate with `Authorization: Bearer <device token>`.

### USB pairing and device lifecycle

- The Mac USB helper creates a scoped device token and configures it through an
  ADB-triggered app deep link.
- Device records contain id, display name, token digest, scopes, created,
  last_seen, and revoked state. The plaintext token is shown only once.
- Manage UI lists and revokes enrolled devices. Journal access uses a distinct
  provider/credential namespace from phone-usage ingestion.

### Bootstrap

- `GET /api/mobile/config` returns server/app version, current date, active tag
  and numeric sections, permanent tags and colors, supported mood bounds,
  recurrence/difficulty choices, and capability flags.
- A successful authenticated call updates device `last_seen`.

### Journal

- `GET /api/mobile/journal/<date>` returns the entry or `null`, plus its revision.
- `PUT /api/mobile/journal/<date>` accepts `request_id`, `base_updated`, title,
  body, mood, tags keyed by section id, and numbers keyed by section id.
- Server processing mirrors the web save: section validation and normalization,
  preservation of archived/managed data, additive `@mentions`, `#numeric`
  capture, and idempotent `[]` task spawning/rewrite.
- The same request id returns the original success response. A different request
  with a stale `base_updated` returns 409 with the current server entry.
- `POST /api/mobile/sections/<id>/tags` adds a permanent tag through the existing
  pure section helper. Temporary tags are stored only on the submitted entry.

### Tasks

- `GET /api/mobile/tasks` returns active/archive views, tag registry, and revision
  metadata needed by the phone UI.
- `POST /api/mobile/tasks` creates a task with request id, title, due,
  recurrence, tags, notes, subtasks, and difficulty.
- `PATCH /api/mobile/tasks/<id>` edits supported fields with optimistic revision.
- Dedicated mutation routes cover complete/uncomplete, subtask add/edit/toggle/
  delete/reorder, and delete where existing domain semantics require it.
- Route handlers only parse/authenticate/respond. Validation and mutation stay
  in `todo.py`; journal behavior stays in `journal.py`.

## Android architecture

### Presentation

- Keep a single activity with explicit screen/navigation state unless the UI
  becomes materially simpler with fragments.
- Presentation models are independent of raw JSON.
- Journal editor owns a durable draft per date; navigation never discards text.
- Speech recognition uses Android's recognizer contract, handles permission and
  unsupported-device states, and exposes review/accept/cancel.
- Sync badges distinguish `local draft`, `queued`, `sending`, `synced`,
  `retrying`, `conflict`, and `failed validation`.

### Data and synchronization

- `MobileApiClient`: bounded connect/read timeouts, JSON parsing, bearer header,
  typed success/error/conflict results, and HTTPS-by-default validation.
- `MobileConfig`: base URL, device id/token, cached bootstrap schema, last sync.
  Credentials use Android Keystore-backed encryption where supported.
- `OutboxStore`: atomic on-device JSON storage (or Room if justified) containing
  payload, request id, creation time, attempt count, state, and last error.
- `MobileSyncWorker`: FIFO processing, retry only network/5xx/429 failures, stop
  and expose 401 enrollment failures, preserve 409 conflicts, and never discard
  4xx validation failures.
- Manual Sync runs the same worker path. Startup and connectivity changes may
  enqueue work but must not create duplicate unique work.
- Existing `UsagePushWorker` and usage settings remain separate so revoking a
  journal device does not break phone-usage uploads.

## Mac availability and USB

- Configure `adb reverse tcp:5001 tcp:5001`; keep Flask on `127.0.0.1:5001` and
  never expose it on the LAN.
- Add an optional USB watcher at login; it starts the server when needed.
- Replace the Flask development server in always-on mode with a production WSGI
  runner while retaining the current local development command.
- Surface actionable Android errors for: cable disconnected, USB authorization
  missing, server stopped, and token revoked.

## Security and consistency requirements

- Separate scoped device tokens; constant-time verification; store token digests
  rather than plaintext mobile credentials.
- One-time enrollment tokens expire and are invalidated atomically on exchange.
- Validate allowed hosts/proxy assumptions and add appropriate response security
  headers. The backend continues listening on localhost only.
- Browser CSRF and mobile bearer auth are separate mechanisms. Bearer endpoints
  never accept a browser session as authorization.
- Serialize each store's load-modify-save transaction. Multi-store journal saves
  that spawn tasks acquire locks in a fixed order.
- Never include integration credentials, tokens, or provider secrets in bootstrap
  or analytics payloads.

## Test plan

### Python

- Pure tests: device creation/enrollment/expiry/revocation, token verification,
  request-id idempotency, journal payload reconciliation, task payload helpers,
  stale revision detection, and forgiving store migrations.
- Route tests: missing/bad/revoked bearer token; enrollment replay/expiry;
  config shape; journal create/update/retry/conflict; inline grammar; tag add;
  task CRUD/toggle/subtasks; validation codes; last_seen; secret redaction.
- Regression: full existing pytest suite remains green.

### Android

- Unit tests for JSON codecs, endpoint normalization, error classification,
  outbox persistence/order, idempotent enqueue, retry policy, and conflict state.
- Presentation tests for mood selection/deselection, tag chip state, transcript
  accept/cancel, draft restoration, and task mutations where the project tooling
  supports them.
- Build debug APK and preserve GitHub release artifact behavior.

### Manual end-to-end

1. Pair through the Mac USB helper.
2. Create a rich entry with mood, existing/new tags, numeric capture, mention,
   transcript text, and an inline task; confirm desktop parity.
3. Queue an entry with the Mac unavailable, restart the phone app, restore the
   Mac, and verify exactly-once delivery.
4. Edit the same date on both devices and verify a non-destructive conflict.
5. Add/edit/complete a task and subtask on Android; verify desktop immediately.
6. Revoke the device and confirm subsequent mobile calls fail without affecting
   phone-usage pushes.
7. Inspect narrow/large Android screens, keyboard behavior, dark theme, icons,
   TalkBack labels, and every error/empty/loading state.

## Delivery phases

1. **Foundation:** API/device store, enrollment, bootstrap, shared Android API
   client/models/config, setup QR contract.
2. **Journal MVP:** durable drafts/outbox, entry GET/PUT, mood, tag rendering and
   adding, transcript review, retry/conflict UI.
3. **Tasks:** active/archive reads, create/edit/toggle, notes/subtasks, queued
   mutations and conflicts.
4. **Operational mode:** USB watcher, loopback server, readiness and diagnostics.
5. **Hardening and polish:** full regression suite, Android build, device/browser
   inspection, accessibility, security review, and updated README/SETUP/AGENTS.

## Definition of done

- A phone-created entry and task appear on the laptop without manual export.
- Offline or unreachable-Mac writes survive and later deliver exactly once.
- Conflicting edits cannot silently destroy either version.
- All requested journal, mood, tag, transcript, tag-add, and task-management
  flows are usable and visually consistent with Datapom web.
- Existing phone-usage integration still works.
- Full Python tests, Android tests/build, and affected JavaScript syntax checks
  pass; the mobile UI is inspected on an Android-sized viewport/device.
