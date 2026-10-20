# Original vs QA: mobile sync and data

The APKs differ substantially in sync behavior. QA contains the reviewed safeguards and the later permanent-tag fix. Both remain local-first clients of the same Mac API.

## Verified builds

| | Original | QA |
|---|---|---|
| Package | `com.todopup.usage` | `com.todopup.usage.qa` |
| Name | Datapom | Datapom QA |
| Version | 3.0 / code 10 | 3.0 / code 10 |
| APK SHA256 | `4b41204ab9e6c965597844952f0171f2e622d6c15c7603b5ce9d777dd988b537` | `802ae3a18d0824f88b6040b9b19f88ae7aa1d9d933f9922159ccb77e4e639975` |
| Matching local build | `/tmp/datapom-original-ui-20260910/android/app/build/outputs/apk/debug/app-debug.apk` | `/Users/juliaxi/projects/todo-journal/android/app/build/outputs/apk/qa/app-qa.apk` |

Both installed APK copies exactly match those build artifacts. Original's three DEX files also match its source-tree build byte for byte. QA DEX contains `JournalTagRegistry`, `JournalConflictGuard`, `JournalStoredDraft`, `TaskEdits`, `MediaSyncResponse`, `MediaMetadataPolicy` and `MediaConflictRevision`; Original has none of these classes. All QA bundled JavaScript matches the reviewed workspace. Workspace `style.css` and `PhotoGalleryDialog.kt` have later changes, so they are excluded from this sync comparison.

## Concrete differences

“Server support” below means the APK sends or consumes a protocol feature whose server implementation is separate.

| Flow | Original | QA |
|---|---|---|
| **Save a permanent journal tag** | Saves `new_tags` inside the entry draft. Other days use the last downloaded section registry. Later autosaves can replace the pending addition; the native form does not adopt returned sections after Save. | Explicit Save creates an independent durable `journal_tag` operation, adds the choice to other days offline, and updates the current form. Later typing cannot drop that operation. Uses the existing `/api/mobile/tags` endpoint. |
| Permanent-tag acknowledgement | No separate local registry bridges entry Save, tag upload and config refresh. | Retains the optimistic choice through ACK until downloaded config confirms it. Clears only acknowledged additions; newer typed additions survive. Recovers explicit unsynced additions left by older APKs. |
| **Temporary journal tag** | Stored on the day's entry; no permanent section registration. | Same intended meaning. It does not enter the permanent-tag outbox. A permanent choice appearing on another day is not automatically selected there. Historical mentions/suggestions can still reuse temporary names. |
| Save vs autosave | Both save locally before network transfer; explicit commits allow server commands such as `[]` task creation. | Preserves that distinction. A pending permanent tag does **not** turn later ordinary typing into a task-spawning commit. |
| Journal save during an in-flight upload | Native repository draft edits can retain a request ID; ACK fast path trusts that identity. | New edits receive fresh IDs. ACK adoption checks baseline, content, tag additions and autosave mode, preserving newer typing and task-link rewrites. |
| Clear an existing entry | Empty `DRAFT` can be considered safe to replace with a remote pull. | Recognizes an intentional clear as an uploadable edit and keeps it. |
| Journal revision/conflict | Uses server `updated` timestamps; provider-only changes can cause a false conflict. Local revision can move backward when the device clock does. | Retains optional editable-content hashes separately from local editor timestamps; local revisions advance monotonically. Avoiding provider-only conflicts requires server `edit_revision` support; absent hashes retain timestamp compatibility. |
| Review journal conflict | Existing local/Mac choice is not tied to the exact versions displayed. Local-choice parsing can omit hidden values. | Rejects a stale choice if phone or Mac snapshot changed. Both normal saves and conflict choices preserve omitted archived fields, managed numbers and transcript. |
| Journal pull/deletion | Explicit sync treats `entry_dates` as the complete stored set. | Uses `stored_entry_dates` to distinguish occupied dates from visible calendar dates; avoids removing cached entries merely because they are blank or metric-only. Requires that server field for the distinction; otherwise falls back. |
| **Task edit/delete** | Rewrites a whole task snapshot and sends unversioned deletes. Unseen Mac edits may be overwritten. | Sends changed fields against the captured editor baseline; delete carries a baseline too. Unrelated edits can merge and overlapping changes can conflict **when the server supports baseline checks**. |
| Task conflict/retry | Saves an error; manual retry clears failure and resends. No durable task comparison model. | Stores both versions, blocks later writes for that task, and requires an explicit choice. Completed tasks can reopen; expired/deleted tasks can become a new one-off copy with a stable queued identity. |
| Concurrent task cache/outbox | Task outbox lock is per instance; a remote task read can overwrite an edit made while the request was running. | Shared lock, cache/outbox recheck before adopting a pull, and field-aware ACK rebasing. |
| Damaged pending data | Corrupt task JSON becomes an empty queue; malformed journal rows can be skipped. | Validates pending task/journal/media records, retains recovery bytes and reports the failure. This is not a claim that every read-only cache is strict: task cache loading remains forgiving. |
| **HTTP acknowledgements** | Any 2xx can acknowledge tag/delete operations. Missing task arrays can become empty lists; malformed 409 can resemble a deleted record. Journal/task HTTP redirects are not explicitly disabled. | Requires literal `ok: true`, expected identity/date and structural content. Incomplete successes/conflicts remain retryable. Explicit null deletion conflicts remain supported. Redirects are disabled. |
| **USB without internet** | Journal/task and one-time usage workers require Android `NetworkType.CONNECTED`, which can block ADB reverse while offline. | Those workers can run over USB loopback without Wi-Fi/cellular. Socket failure keeps edits queued with backoff. Newly queued task/media work triggers another pass. |
| Usage upload | HTTP status alone determines success; no before/after permission guard in the worker. | Checks unlock/usage access before and after collection; success must acknowledge every sent date. Redirects are disabled. Requires the server's normal `ok`/`dates` response. |
| Tracking startup | Precise permission plus an unset preference starts recording. | Requires an explicit saved enable; explicit pause remains authoritative. Daily file/visit logic is otherwise shared where source is unchanged. |
| **Photo/place metadata batches** | Sends the full outbox at once; more than 500 changes exceeds the server limit. Conflict file is replaced after each exchange. | Sends batches of at most 500, excludes unresolved conflicts from automatic resend, and preserves conflict state while other batches succeed. |
| Metadata validation and stale replies | Limited local field validation; a delayed whole-state response can replace newer settled metadata. | Validates local batches before writing; merges server revisions safely and uses a separate persisted local snapshot revision. Stale conflict choices are rejected. |
| Photo-tag groups and lost ACK | Both support separate permanent photo-group choices and selected photo tags. Retry generates fresh operation IDs and can conflict with its own completed save. | Identical retries reuse operation IDs; stale state adoption is guarded. Journal section tags and photo-group tags remain distinct registries, even where names are suggested across contexts. |
| Tracking transfer | Trusts accepted IDs and downloaded day structure more loosely. | Validates complete sent-ID ACKs, requested day, unique IDs, coordinates and optional manifest counts before receipts advance. Older manifests without `count` still work. |
| **File/map download** | Already supports partial files, resume, checksums and atomic replacement. Range validation is weaker; map manifest is replaced before all new files arrive. | Validates full Content-Range and manifest byte size. Keeps the verified old map available through failed replacement; publishes each completed pack separately. |
| Map replaced during viewing | Local byte serving ignores requested version. | Local reader validates `?v=` and opens under the publication lock; stale version returns 409 `map_version_changed`. Bundled viewer refreshes its manifest once and preserves framing. The equivalent Mac byte-serving guard is a separate server fix. |
| Linked journal tasks | Local WebView lacks a task index/navigation bridge, so references can look unavailable. | Returns local task index on bootstrap/save and opens the referenced active/archive task. Missing references stay explicitly unavailable. |
| Sync status | Zero transferred items can say “phone and Mac already matched” even when errors occurred. | Reports “Nothing synced” when unresolved errors exist; shows durable conflict counts and clearer retry state. |

## What is shared, and what is separate

- **Separate on the phone:** the package IDs isolate preferences, task/journal outboxes, media files, cached maps, WorkManager jobs, grants and Keystore credentials. Installing QA does not import Original's drafts or pairing automatically. Equal preference names do not make those stores shared.
- **Potentially shared on the Mac:** both call the same `/api/mobile/...` routes. The `.qa` suffix does not create a separate server journal. If paired to the same running Mac store, their edits meet in the same date-keyed entries, tasks, media and permanent-tag registries. Device tokens identify clients and replay receipts, not separate user datasets.
- **Unchanged transport/config foundation:** `MobileConfig.kt` and `MobileEndpoint.kt` are identical. Both restrict sync to the configured USB loopback origin, store the mobile token through Android Keystore, and keep usage-push config separate. Both already have local journals/tasks, original photo preservation, daily tracking archives and offline maps.
- **Not an automatic migration:** this comparison neither paired the apps nor copied any data. Existing same-package formats are largely retained with additional fields, but moving private data between these two installed packages is a separate action.

## Current phone configuration

Read-only checks on Samsung `R5CX526AGPA`, Android user 0:

| Saved setting | Original | QA |
|---|---|---|
| Journal/task endpoint | `http://127.0.0.1:5001` | Absent |
| Mobile token record present | true | false |
| Historical verified marker present | true | false |
| Usage endpoint | `http://127.0.0.1:5001/integrations/phone/ingest` | Absent |
| Usage token present | true | false |
| Historical usage-push marker present | true | false |
| Connection preference files exist | true | false |
| Package read access succeeded | true | true |

**QA is currently unconfigured, not connected to a separate backend.** Original has saved USB-loopback configuration and historical success markers. No network request, credential decryption or token-validity test was made; these flags do not prove current connectivity or successful sync.

The parent review separately confirmed that Original currently has notifications, fine/background location, photos and microphone permissions granted; QA has those permissions denied. That installation-state difference affects what each app can collect or import, independently of its code.

## Server and helper boundary

The APK does not contain Flask, provider clients or Mac shell helpers. These reviewed workspace fixes must **not** be credited to installing QA: provider fetch/reconcile locking, Google/RescueTime refresh policy, Spotify import deduplication/source retention, server journal editable-hash calculation, task baseline enforcement, Discord receiver ACK handling, tracking-manifest caching/default analytics range, stable map-region creation, Mac map publication guards, USB credential provisioning and updater recovery.

Either app can benefit from server-only corrections that do not require new client fields. QA-specific hash/baseline behavior needs matching server support. QA's stricter response validation can keep retrying against an incompatible/partial server response; an installed APK alone does not prove that the running Mac service has been updated.

## Evidence and limits

- APK hashes and asset hashes: [manifest.json](/tmp/datapom-app-comparison/manifest.json). Package/version/permissions verified with Android `aapt dump badging`.
- Native implementation verified against [Original DEX](/tmp/datapom-app-comparison/original-native-dexdump.txt) and [QA DEX](/tmp/datapom-app-comparison/qa-native-dexdump.txt), including tag registry calls, strict ACK text, conflict guards and map-version error code.
- Original Kotlin: [source tree](/tmp/datapom-original-ui-20260910/android/app/src/main/java/com/todopup/usage). QA Kotlin: [source tree](/Users/juliaxi/projects/todo-journal/android/app/src/main/java/com/todopup/usage). Primary comparisons: `JournalTagRegistry`, `JournalSyncStore`, `JournalAcknowledgement`, `MobileRepository`, `TaskOutbox`, `MobileCache`, `MobileApiClient`, `MobileSyncWorker`, `MediaStore`, `MediaSync`, `MediaSyncResponse`, `MediaJournalView`, `UsagePushWorker`.
- Exact APK JavaScript was inspected under `/tmp/datapom-app-comparison/{original,qa}/assets/journal`, especially `media-entry.js`, `mobile-journal.js` and `media-ui.js`.
- Tag regression source documents cross-day offline visibility, temporary isolation, later typing, ACK/config ordering and legacy-draft recovery: [JournalTagChecks.kt](/Users/juliaxi/projects/todo-journal/android/app/src/androidTest/java/com/todopup/usage/JournalTagChecks.kt). Earlier synthetic/device review evidence is in [sync review](/Users/juliaxi/projects/todo-journal/docs/reviews/2026-09-10-sync.md).
- This was a read-only artifact/source comparison plus the narrowly scoped connection-preference check above. No apps were launched or modified; journal/task/media stores and live server/services were not read. Endpoint values were sanitized; token checks returned only presence booleans and never retrieved token values. Prior test results support the reviewed implementation, but this pass did not rerun live synchronization of these two installed packages.
