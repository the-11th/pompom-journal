# Original app upgrade — 11 September 2026

Installed the selected upgrade in place on the connected Samsung phone. The Mac backend was restarted with the matching reviewed code. The original font, native navigation, calendar/gallery layout, compact record control, equal record margins, and centered gallery selection indicator were preserved.

## Delivered

- Journal tag chips update immediately, submitted inputs clear, and temporary-to-permanent promotion updates the existing choice. Numeric validation retains drafts. Journal save/conflict handling protects newer typing and intentional clears.
- Task forms retain due times and failed edits, expose Clear, and support explicit Phone/Mac conflict choices. Journal task references use cached task state and open the corresponding native task.
- Grouped photo-edit tools, contextual controls, sticker states, and protected saves. Photos includes linked photos and representative details; the displayed date identifies the entry owning those details.
- Compact inline caption and location-name editing changes only the opened entry. Photo coordinates and other dates remain intact. A location is displayed once, without the `locations:` or `near` prefixes. Holding a location opens a map preview.
- Equal Photos-filter spacing; photo tag group names have sufficient width to avoid word wrapping. “Also tag entries” is inside Manage tags and saves with that dialog.
- Maps zoom to level 22 using cached-tile overzoom. Overlapping photo markers open a photo strip. Day scrubbing follows the dot at the current zoom. Refresh preserves framing, replay, selection, and local retry controls.
- Sync validates acknowledgements and transfers, preserves concurrent edits, works over USB without an Android internet connection, and resumes interrupted downloads safely.
- The Mac watcher recognizes USB file-transfer mode changes on the same cable, starts the persistent Datapom backend if needed, and initiates sync automatically.

## Validation

- Full Python suite: **1,259 passed**.
- Full JavaScript/browser suite: **396 passed**.
- Staged Android JVM suite: **104 passed**.
- Isolated Android storage/transport/interleaving checks and selected task UI instrumentation passed.
- Actual Android WebView photo edit → Entry → further save passed. Photo-only acknowledgements remain clean; unfinished inline edits are protected from other photo editors.
- Regression checks cover delayed viewers after navigation, multiple open captions, repeated assets, entry ownership, repeated saves, coordinate preservation, and failed-save retention.
- All 29 static JavaScript files passed syntax checks; shell syntax and `git diff --check` passed.
- Visually inspected compact photo fields, task validation/conflicts, narrow and enlarged-text map layouts, and the running Mac settings/Manage tags flow.

## Deployment and live sync

Original package: `com.todopup.usage`, version 3.0/code 10. Installed APK SHA-256:

`4fe6d5d24e32d2a765649c4ff327b6b0fe0d5c7b5772c094132da56b3f973490`

The installed APK matches the final artifact and original signing certificate. All 15 bundled journal text assets match the staged source. The installed QA package retains its previous SHA-256, `802ae3a18d0824f88b6040b9b19f88ae7aa1d9d933f9922159ccb77e4e639975`.

For the live cold-start test, the old backend was stopped and the existing USB watcher restarted. Switching the physical phone from charging to `mtp,adb` automatically started the new backend and triggered sync without tapping Sync. The worker reported **14 media files synced, 16 Mac entries downloaded, and 2 phone changes uploaded**. Usage push also returned HTTP 200. The watcher and persistent backend remain active.

**One September 10 journal conflict remains for the user's Phone/Mac choice.** The queued phone version predates deployment; its title, body, and document differ from the Mac version. The sync preserved both versions and did not choose one automatically. Tasks and media have no remaining queued changes or conflicts. Blank legacy local drafts remain local.

The physical phone's screen was off during the final sync; the on-device UI interaction evidence comes from the disposable emulator using the same packaged assets. That emulator was cleared and stopped after testing.

## Reproduction and evidence

Final APK, exact selected Original source archive, manifests, and validation logs are retained under `data/mobile-builds/2026-09-11-original-upgrade/`. Private pre-deployment metadata backups are under `data/backups/2026-09-11-original-upgrade/`.

The repository contains the broader QA/native review work, so reconstruct this exact Original build from `original-source.tar.gz`; do not replace its native UI wholesale with the QA source. Shared new features and the photo-details bridge/helper are also present in the repository. No Git push was performed as part of this installation.
