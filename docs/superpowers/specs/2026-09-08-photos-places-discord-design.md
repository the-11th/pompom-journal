# Photos, places, and Discord journal capture — design and implementation record

Date: 2026-09-08
Status: Implemented and installed on the connected Samsung after editor, map, and Android verification. Remaining live-device limits are recorded below.
Latest decisions incorporated on September 9. The app is now branded Datapom on web, Mac, and Android. The live Discord application `datapom` has been created; Cloudflare hosting, command registration, and live import are still pending.

## Verification checkpoint — September 9

- Full Python suite: 926 passing tests. All static JavaScript syntax checks and
  media/editor/sticker/map Node contracts pass.
- Downloaded and verified the world overview, Shanghai, Beijing, and complete
  nine-county Bay Area. A decoded zoom-12 tile at Fremont includes its place label, roads, and points
  of interest. The four installed packs total 450,032,060 bytes. SHA-256
  checksums computed on the Samsung match the Mac copies.
- USB sync completed without journal conflicts. The existing USB connection
  watcher is running. Real-device storage regressions use disposable test stores.
  Final WorkManager sync succeeded: phone and Mac matched, with nothing left
  unsynced. The phone has zero meaningful pending drafts and zero conflicts;
  all four map receipts remain ready. The QA/test apps and owned phone fixtures
  were removed after review; production remains installed.
- The final Android installation passed build/lint and 49 JVM tests. The APK was
  installed in place on the Samsung. Isolated on-device tests pass for concurrent
  stores, in-flight acknowledgement/rebasing, conflicts, JSON normalization,
  EXIF orientation/time, unchanged originals, and interrupted-preview repair.
  The final installation retained all 36 journal records and the existing media
  and map files; all 18 bundled web assets match the current sources.
  Installed branding checkpoint APK SHA-256: `634b1b35340540f1cf2e30b347616741ca6f10477c0e341bc0fd662c78e65b20`.
- Repeated code reviews fixed in-flight saves, task duplication recovery,
  default-field/key-order sync comparisons, metadata conflict handling,
  HEIC/EXIF preservation, interrupted imports, and map replacement/recovery.
- Resumed visual verification uses ChatGPT's in-app browser and the connected
  Samsung S24 Ultra, with a separate Datapom QA app and synthetic fixtures.
  Browser checks cover narrow layouts without horizontal overflow, map coverage,
  all-history visit totals, place editing, hidden captions, separate location
  display labels, two photos linked to one passage, Discord-style inserts and
  captions, saved drawing/text layers, photo-tag gallery filtering, persistent
  photo reordering, and cancelled photo edits. Text saves while
  its field remains active; leaving content unchanged causes no extra writes.
  The browser chooser input remains attached until selection/cancellation;
  a synthetic photo successfully reached the editor after this fix; editor access
  now lives in the photo preview as described below.
- Earlier Samsung checks cover journal/date alignment,
  seven mood icons, photo and Discord cards, place/photo dialogs with the Samsung
  keyboard, reachable fixed actions, pointer drawing, and nested Android Back
  behavior. The world, Shanghai, Beijing, and Bay Area map packs visibly render
  offline on the phone. This revealed and fixed Android WebView double-handling
  of byte ranges; Android now requests bounded byte slices explicitly.
- Real-device WebView regressions cover exact map response bytes, gzip support,
  invalid byte boundaries, closing only the topmost nested dialog, and keyboard
  activation of linked photos without accidentally editing the paragraph. Native
  cache serialization now preserves managed section metadata. Shared controls
  use amber keyboard focus, and the photo toolbar reveals item/crop actions only
  when relevant to leave more room for drawing.
- The revised editor controls were rechecked in the in-app browser and actual
  Samsung QA app, then bundled into the production installation. The corrected
  linked-text Enter behavior was also visually confirmed on the Samsung.
- Tracking has not been exercised during a real outing. The latest production
  audit finds tracking enabled in visits mode, foreground location and notification
  permissions granted, and background location denied. These current settings
  were preserved during installation; today's tracking log changed while the
  journal outbox and stored media/map files remained unchanged.
  Mirrored pointer strokes do not verify physical S Pen pressure or palm
  rejection. Outline-assisted sticker extraction has automated logic checks;
  the full physical-phone tracing/refinement flow remains a manual acceptance
  check. The Discord receiver has signed-request/inbox tests but is not hosted
  or connected to the newly created live Discord application yet.

### Datapom naming and Discord setup checkpoint

- Visible web, Android, notification, launcher, documentation, and Mac Dock names
  now use Datapom. Existing Android package, preference, bridge, and deep-link
  identifiers remain stable to preserve data and installed integrations. The Mac
  launcher is `/Applications/Datapom.app`; `Datapom.command` is canonical and
  `TodoPup.command` forwards older shortcuts to it.
- Discord application `datapom` was created after explicit terms approval.
  User Install is enabled with only `applications.commands`; Guild Install is
  disabled. The intended selected-message action is **Add to Datapom**.
- A Cloudflare Workers Free receiver with SQLite Durable Object storage is
  prepared in `deploy/discord-worker`. Ten protocol/storage tests, the real
  workerd concurrency/restart/acknowledgement integration test, and Wrangler's
  deployment dry run pass. No Worker has been deployed yet.
- Command registration verifies the bot token's application and personal owner
  before creating the action. Its terminal prompt hides the token and does not
  save it; verified application/owner IDs can be saved separately. Twenty-three
  setup tests cover validation, sanitized failures, and atomic metadata writes.
- Cloudflare account creation and terms were approved, and the user selected
  their personal Gmail account. Chrome control is currently blocked by the locked
  Mac. Cloudflare deployment,
  Discord command registration and endpoint verification, user-app installation,
  and a user-selected DM capture remain outstanding. No live message import is
  claimed by the local tests.

### Additional review while the Mac is locked

- Restored local drafts now initialize the Writing / dictation text from the
  restored document. Switching editing modes can no longer bring back stale
  server text. Capture-date imports reuse stable block IDs and remember completed
  days, so partial failures and lost save responses can be retried without
  duplicating photos. Switching to the current entry first reconciles uncertain
  saves, and the two import choices cannot run concurrently.
- Save responses preserve live block references held by open caption/photo
  dialogs. Task-marker rewrites preserve newer photo links, including links
  between multiple task commands. The passage picker now has a Remove link
  action that keeps the photo; changed passage text requires reselection.
- Map place matching respects fix accuracy and chooses the nearest equally sized
  matching place. Invalid custom map rows are skipped and numeric coordinates
  normalized before rendering coverage.
- Android source fixes cover final-save completion before WebView cleanup,
  preservation of queued writes, and task acknowledgements that preserve newer
  captions, drawings, and links. An exact-version task-rewrite conflict reason
  prevents a stale command draft from silently recreating completed task imports.
  These changes pass 59 JVM tests and lint. The coordinated gallery/tag/button
  task completed the final debug and QA builds and full StorageInstrumentation
  suite on emulator-5554. All 18 bundled journal assets in both APKs match current
  static sources. The physical phone has not received this latest build.
- ChatGPT's in-app browser remains usable while the Mac is locked. Synthetic
  checks at 390 pixels verified gallery insertion with immediate save, hidden
  captions visible in preview, independent location display labels, saved photo
  text edits, contextual linking and unlinking, and a rendered regional map with
  centered actions and no horizontal overflow or clipped button labels. Text
  autosaved while its paragraph retained focus; its revision stayed unchanged
  over subsequent idle save intervals. The Writing / dictation focus border now
  uses amber.
- All 926 Python tests, 22 JavaScript syntax checks, and 26 non-browser Node
  tests pass. The coordinated task also reports nine passing browser tests
  (four mobile and five photo-flow checks), using the bundled dependency path
  after the default Node environment could not load the UI harnesses. The
  visual evidence above comes from in-app browser control. No new physical
  S Pen, live-GPS interaction, or outing verification is claimed.
- Emulator imports used synthetic GPS/no-GPS photos with limited selected-photo
  permission and media-location access, while full photo-library access was
  denied. Both imported originals retained their SHA-256 hashes; GPS coordinates
  matched the fixture and the no-GPS photo retained a null location. Isolated
  instrumentation files/preferences were cleaned automatically. Gallery fixtures
  remain only in the emulator/QA environment and `/tmp/datapom-photo-simulation`.
- Prepared debug APK SHA-256:
  `d7fefaa25346f2629d316591e26f35e4ac957a3dc9dc3951bd09e31f397c96e0`.
  Emulator-only QA APK SHA-256:
  `fc8123c2aeeba332444f92659a76062b6cdcda3ce6e587a8f7240e5d6dde252b`.

### Latest UI refinement checks

- Photo editing moved into the photo preview. The permanent toolbar actions for
  photo editing and linking text were removed. Selecting a nonempty passage
  reveals a contextual Link photo action, with keyboard-accessible selection
  retention and a disabled confirmation until at least one photo is chosen.
- Removed the Journal heading, restored a plain calendar/date trigger, and
  centered amber actions with the native app's existing button treatment.
  Narrow web tag controls now wrap without horizontal overflow at 390 pixels.
- Android uses Entry / Photos / Places above the journal. Photos & places
  settings opens inside Connect; the Connect bottom tab remains highlighted,
  and Android Back returns to Connect after closing any open dialogs.
- Both map views support fresh current location with an accuracy circle and
  Star here. Silent lookup requires existing permission; an explicit request can
  ask for access. Stale fixes are cleared, and one-shot lookup does not enable
  continuous tracking. Starred places persist through migrations and USB sync.
- Opening Android restores an already-enabled tracking service after an update
  or force-stop when foreground permission is present. It respects explicit
  disablement and the existing outing-detail pause, and does not grant permissions.
- In-app browser checks cover contextual linking with Tab/Return, preview-only
  editing, centered preview/place dialog actions, starred-place persistence,
  and journal/settings layouts with no horizontal overflow at 390 pixels.
- Actual Samsung QA checks cover the revised navigation and plain date, preview
  actions, dedicated Connect settings, map rendering and denied-permission
  state without a surprise permission prompt. On-device WebView regressions
  cover contextual linking, empty confirmation, preview focus after nested
  details, star migration/outbox, and current-location denial without tracking.
  The updated Android unit suite has 49 passing tests, including fresh-position
  and permission policy checks; build and lint pass.
- The final Samsung storage/WebView instrumentation passed with the enabled-only
  tracking-resume regression. Final USB WorkManager sync succeeded with no
  meaningful unsynced entries or conflicts (16 synced entries and 20 empty
  drafts); all four map receipts remain ready (450,032,060 bytes). Read-only
  device status confirmed the preserved tracking setting resumed a foreground
  service and recorded a five-second-old fix with reported 100 m accuracy.
  This verifies collection resumed, not the separate current-location UI flow.
- A later USB reconnection left the native screen mirror returning
  `noWindowsAvailable` despite screenshots remaining readable. Bounded recovery
  did not restore UI actions, so the live My location → Star here interaction
  remains unverified on actual GPS. This is a UI-control limitation, not evidence
  of a location timeout. Denied-permission and fresh/stale location policy
  regressions, map layout, and starred-place persistence are verified separately.

## Goal

Make journaling quick enough to become a daily habit. Photos, places, and selected
messages belong in the same writing flow on web and Android. Automatic organization
must reduce work without silently changing an arrangement or an intentional label.

## Confirmed user decisions

- Inline photos mixed with text, movable with small margins. Captions may be visible
  beneath a photo or hidden until the photo is clicked/tapped.
- Optional colored location display on photos. Editing the display label is separate
  from correcting the actual location. Both operations must be available.
- Initially sort photos by capture time. Offer import into the current entry or
  distribute into entries by capture date. Preserve manual arrangement afterward.
- Selected text may reference several photos. Each attachment may be inline or
  tap-to-reveal, with a larger viewer when opened.
- Photo-tag groups include people, meals, foods, and locations and can be extended.
  People sync with ordinary journal tags. New photo groups have a setting controlling
  whether they also participate in normal entry tags.
- Add photo analytics using these groups and tags.
- Pull location metadata from imported photos and allow places to be added on a map.
- Phone location tracking records ordinary visits and automatically starts detailed
  outing collection. Five-minute dwell threshold; all observations retained indefinitely.
  Explicit pause controls remain available. Outing notifications offer resuming detail.
- Settings must let the user add/nickname common cities and places and choose each
  place's radius. Estimate time spent at places.
- Map, timeline, and location editing on both web and Android.
- Phone editor supports Samsung S Pen drawing. The user supplies sticker images;
  tracing a subject should assist extraction, with precise manual refinement.
- Discord imports come from personal DMs. Inserts should resemble Discord messages
  while fitting Datapom, with independent comments/captions like photos.
- Use Discord’s official user-installed “Add to Datapom” message action and a private
  HTTPS inbox. Private links alone cannot grant message access; imported source links
  remain tappable. New imports require internet; saved inserts remain offline.
- Keep all originals and edits on both Mac and phone. Transfer photos over USB along
  with the existing journal/task sync.
- Save immediately after adding a photo; save changed text every 10 seconds without
  repeatedly saving unchanged content.
- Think through both platforms before code. Preserve the existing dark amber,
  monospace theme and Pompompurin assets.

## Confirmed map decision

Use offline PMTiles vector maps, rendered with Datapom’s own canvas/MVT reader.
No online tile service, geocoder, web JS library, or CSS library. The world overview
covers zooms 0–5. Initial regional detail covers Shanghai, Beijing, and all nine Bay
Area counties, including Fremont. Settings previews coverage and download sizes;
additional vacation regions can be selected and downloaded on the Mac. Originals,
edits, maps, and tracking history sync to Android through authenticated USB loopback.
A downloaded pack becomes available after checksum validation; an interrupted transfer
retains its partial file for resumption. Attribution stays visible in the map.

## Implementation structure

- `journal_media.py`: content-addressed image originals and derivatives, metadata
  revisions, grouped photo tags, validated ordered documents, text-link rebasing,
  and photo analytics. `journal_commands.py` separates explicit task commitment
  from autosave and deduplicates task creation after interrupted saves.
- `places.py`: immutable raw location observations, conservative visit derivation,
  named place matching, and gaps. `map_packs.py`: catalog, coverage, pack validation,
  download jobs, checksums, and size estimates.
- `media_routes.py`: thin web/mobile HTTP adapters. App-private stores live alongside
  the configured journal store, allowing isolated route tests and previews.
- Shared vanilla editor/map/settings scripts are bundled as Android assets.
  Android intercepts requests to a private local WebView origin and serves files
  directly, including PMTiles range reads. External pages cannot access the bridge.
- Native stores keep media files and tracking samples outside journal preferences;
  versioned journal documents remain compatible with older text-only entries.
  Foreground location collection uses visible notifications and Android permissions.
- `discord_journal.py` and `discord_receiver.py`: signed selected-message receiver,
  single-user checks, durable private inbox, and acknowledgement only after Mac save.
  Deployment and account setup are described in `docs/DISCORD_INBOX.md`.

The earlier proposal sections below record design rationale. Where they mention
choices as pending, the confirmed decisions above take precedence.

## Existing implementation constraints

- Web body is a textarea with a formatted blur view. Richtext, mentions, numbers,
  dictation highlights, and linked tasks currently use that plain-text body.
- Web convenience code saves browser-local drafts; it does not yet autosave entries
  to the Mac. The explicit save route can spawn tasks and currently validates titles.
- Android journals are JSON drafts in preferences with durable mutation IDs and
  revision conflict detection. There is no attachment storage/transfer model yet.
- USB sync uses authenticated loopback endpoints. Mac is authoritative, with offline
  phone edits queued until connection. This transport choice stays in place.
- Android update recovery currently backs up preferences only. Media files, masks,
  annotations, and location logs will need inclusion before the update path is safe
  for the new feature.
- Follow CLAUDE.md: pure domain helpers, thin Flask routes, atomic stores with
  forgiving migration, tests first, full pytest, JS syntax checks, browser QA, and
  actual Android flow verification. No third-party web JS/CSS libraries.
- There are extensive pre-existing working changes. Preserve them; do not roll back
  or incorporate unrelated behavior changes into this feature.

## Proposed editor behavior (to refine in paired web/phone designs)

- A single ordered document containing text, photos, and message inserts. Blocks
  and text-to-photo references have stable IDs; references must survive nearby edits
  and reordering rather than relying only on absolute character offsets.
- Keep current inline formatting, mention/number capture, linked tasks, and dictation
  working. Legacy entries render without a destructive conversion.
- On web, add photos through a themed button, drag/drop, and clipboard where supported.
  On Android, use selected photo import and an appropriate share target. Copy selected
  bytes into durable app storage before showing them as safely added.
- Caption visibility is a per-insert preference. The photo viewer exposes caption,
  tags, capture time, location, and edit actions. Tapping linked text opens its photos.
- Provide keyboard and touch move controls alongside drag handles. Phone reordering
  must coexist with scrolling, selection, and S Pen input.
- Location display consists of visibility, label, and color. Changing those never
  moves the pin. A separate correction action changes the effective coordinate/place
  and recomputes derived photo location tags while preserving the original metadata.
- Preserve the original image plus editable drawing/sticker layers and a rendered
  preview. Cropping, rotating, drawing, and export do not reset capture time or GPS.
- Sticker maker: select source, trace intended subject, inspect suggested mask, use
  zoom plus keep/erase brushes and undo to refine, then save reusable transparent art.
  Outline-assisted segmentation must be evaluated; a plain lasso is not equivalent
  to automatically finding the subject boundary. Model/service choice remains open.
- Android drawing should distinguish pen drawing from finger navigation and handle
  pressure/palm cancellation when supported by the device.

## Proposed storage, autosave, and sync contract

- Store media as files, not base64 in journal JSON or Android preferences. Use stable
  media IDs, content checksums, original metadata, thumbnail/preview derivatives,
  annotation data, and independently editable captions/tags/placement.
- Separate observed GPS/time, corrected effective location/time, provider place ID,
  user-defined place ID, and display-only aliases. Preserve source and uncertainty.
- Record timezone/offset when available. Do not invent a precise capture time or GPS
  for screenshots or files missing metadata. Let the user correct missing values;
  explain how dates are chosen before a multi-day import.
- An attachment may be reused without duplicating its binary. Analytics must distinguish
  unique photos from uses in entries, and references from independent media records.
- Keep people/group tag identity synchronized. Proposed meaning: a shared group's
  photo tags contribute to the day's effective tags, without deleting manually added
  entry tags when a photo is removed. Registry identity, group sharing settings, and
  derived entry membership need explicit tests.
- Autosave allows untitled text/photo entries. Persist only dirty revisions at most
  10 seconds after changes begin, including during continuous typing, plus immediate
  persistence after photo import and lifecycle flushes. Empty untouched days stay empty.
- Keep local durability and successful Mac transfer as separate states. A failed upload
  must never discard the local photo, caption, text, or new revision.
- Audit autosave side effects: unfinished task lines must not spawn partial tasks or
  duplicate tasks after retries. Distinguish safe autosave from explicit task commitment.
- Serialize updates per entry; acknowledge only the revision actually uploaded. Preserve
  later edits made while a save is in flight. Handle web/phone conflicts explicitly.
- Sync binaries with validated lengths/checksums and atomic completion, then reconcile
  references and structured edits. Interrupted transfers retry without duplicates.
  Test both directions, including web-added photos arriving on the phone.
- Keep originals and edits on both devices after verified transfer. Deletion/recovery
  behavior must not erase shared media merely because one entry reference is removed.
- Version mobile payloads/migrate old records, ensuring older clients cannot silently
  erase fields they do not understand. Extend update backups before storing new media.

## Proposed places and analytics model

- Saved city/place: stable ID, name, aliases, color, coordinate, radius, and optional
  parent city. Settings support map selection and radius preview on both platforms.
- Phone observations: timestamp, coordinate, accuracy, and source; collect locally.
  Derived visit intervals are separate from raw observations and manual corrections.
- Place matching considers distance, accuracy, dwell time, overlapping radii, and
  GPS drift. A city and a venue may be nested; totals should not imply that their
  overlapping time is additive. Adjacent uncertain venues need user correction.
- A photo alone is a point-in-time observation, not evidence of arrival or departure.
  Track estimated visit duration only where observations/manual input support it.
  Do not infer continuous presence through missing data, revoked permission, reboot,
  or a stopped tracker. Show estimated durations and gaps.
- Proposed everyday mode prioritizes place visits and battery; an optional route mode
  samples more frequently. Start/pause controls and retention policy remain to discuss.
- A proposed Photos analytics tab offers a date-filtered gallery, counts over time,
  group/tag filters, and people/food/place breakdowns. Shared tags retain domain origin.
- A proposed Places analytics tab links an accurate basemap to a visit timeline,
  photos, duration totals, and per-place history. Do not draw an invented road route
  between sparse observations. Photo GPS and phone-derived visits remain distinguishable.
- Hand-rolled analytics mirror pure Python calculations. Imported Discord prose should
  not inflate the user's writing word counts or create mention/task commands by accident.

## Discord feasibility and proposed behavior

- Discord user-installed apps can expose message context commands in private channels.
  The selected message is provided in the interaction payload. This is the supported
  basis for an "Add to Datapom" action on a DM; it is not blanket DM history access.
- A DM URL identifies a message but does not grant access to its content. A forward
  may carry a snapshot with a different field set, so validate forwarding separately
  rather than promising identical attribution.
- Import stores a snapshot with source IDs, available author/display information,
  original timestamps, content, and selected attachments, with comments kept separate.
  Use source IDs for deduplication; unavailable fields remain explicitly unavailable.
- Proposed insert appearance: compact avatar/name/time header, Discord-like message
  spacing and quote styling, Datapom panels/amber controls, collapsible attachments,
  optional user caption. Imported markup is escaped and safely rendered.
- Discord interactions need an available receiver: either a connected Gateway client
  or a public HTTPS interaction endpoint. A receiver running solely on a sleeping Mac
  cannot provide an always-available capture action. Discuss an optional online inbox
  for selected messages, or local-only availability, before deployment.
- An online inbox would receive selected private message data. It needs explicit user
  choice, owner-only access, signature verification, replay protection, minimal retention,
  and confirmed local receipt before deletion. No service has been configured or deployed.
- No user-account automation, private account token collection, or unofficial Discord
  client modifications are needed for the selected-message design.

## Questions still to resolve

1. Everyday tracking detail: visits/time spent, route fidelity, and acceptable battery use.
2. Tracking start/pause/schedule behavior and tolerable notification experience.
3. How short a stop should count, overlapping-place handling, and raw-history retention.
4. Online map/lookup privacy, offline map needs, service budget, and mainland China coverage.
   Actual common city/place names belong in editable Settings as requested.
5. Discord availability away from a running Mac and whether an online selected-message
   inbox is acceptable; choose date/inbox behavior when importing older messages.
6. On-device sticker extraction feasibility on the connected Samsung, including model
   availability. Prefer local processing; cloud photo processing is not authorized.

## Evidence checked on 2026-09-08

- [Discord user-installed apps](https://docs.discord.com/developers/tutorials/developing-a-user-installable-app)
- [Discord message commands](https://docs.discord.com/developers/interactions/application-commands#message-commands)
- [Discord interaction delivery](https://docs.discord.com/developers/interactions/receiving-and-responding#receiving-an-interaction)
- [Discord message resource and permissions](https://docs.discord.com/developers/resources/message)
- [Android background location and battery](https://developer.android.com/develop/sensors-and-location/location/battery)
- [Android geofencing accuracy and latency](https://developer.android.com/develop/sensors-and-location/location/geofencing)
- [Android location permission and foreground service behavior](https://developer.android.com/develop/sensors-and-location/location/permissions)
- [Android stylus support](https://developer.android.com/develop/ui/views/touch-and-input/stylus-input)
- [ML Kit subject segmentation (beta; evaluate rather than assume trace prompting)](https://developers.google.com/ml-kit/vision/subject-segmentation/android)
- [MapTiler custom styles](https://www.maptiler.com/cloud/customize/)
- [MapTiler pricing](https://www.maptiler.com/cloud/pricing/)
- [MapTiler storage/caching terms](https://www.maptiler.com/terms/cloud/)
- [Geofabrik downloadable OSM data](https://download.geofabrik.de/)
- [OSM public tile policy](https://operations.osmfoundation.org/policies/tiles/)
- [AMap coordinate conversion](https://lbs.amap.com/api/webservice/guide/api/convert)

## Planned validation before release

- Unit and route tests for migrations, attachment metadata, tag-sharing derivation,
  captions, ordering, anchored text, autosave races, task idempotency, place matching,
  duration gaps, source provenance, and analytics mirrors.
- Transport tests for interrupted/duplicate media, concurrent edits, missing bytes,
  old clients, both USB directions, and update recovery including real media files.
- Browser and Android checks for rapid capture, several-day import, no EXIF, Unicode
  selection, dictation, long entries, drag/keyboard/touch reordering, caption toggles,
  sticker refinement, S Pen/palm behavior, and offline save/restart.
- Device tracking trials for stationary drift, nearby places, pauses, screen-off,
  denied permission, battery restrictions, and actual battery/duration accuracy.
- Discord end-to-end selected-DM import with verified attribution/timestamps,
  attachments, duplicate action, receiver unavailability, and private acknowledgement.
- Review paired web/mobile flows and resolve external-service decisions before code;
  then implement in testable stages and update the attached phone without data loss.
