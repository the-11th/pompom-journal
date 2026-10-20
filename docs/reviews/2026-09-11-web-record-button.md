# Website record button — 2026-09-11

Removed the Writing / dictation toolbar switch. Each journal paragraph now has a circular 26px record button inside its text box, with equal 6px top and right insets, matching mobile geometry.

The button opens a compact themed dictation dialog for that paragraph and caret. Use text applies reviewed text and tags while retaining other paragraphs, photos, messages and photo links. Cancel preserves the document; closed dialogs ignore late speech callbacks. If the target paragraph changes, confirmation retains the draft and rejects the stale update. Unsupported browsers show an explained disabled record button.

## Validation

- Full Python suite: 1,318 passed.
- Full JavaScript/browser suite: 422 passed before final cancel-control and narrow-layout fixes; all 8 affected checks passed after those fixes.
- Changed JavaScript syntax and git diff whitespace checks passed.
- Browser interaction and visual review used isolated Flask data and simulated speech, with no microphone service or production mutations. Desktop, 390px and 320px layouts checked. Final narrow dialogs have no horizontal overflow, a circular mic, one Cancel and visible Use text.
- All four assets served by the running website on port 5001 match final source bytes. Refresh the website to load them.
- Evidence and source snapshots: `data/web-builds/2026-09-11-record-button/`.

## Automatic USB sync

The existing macOS launch agent is installed and running. Its watcher checks every five seconds for USB file-transfer mode, starts the Datapom backend when needed, establishes the USB tunnel, and triggers phone usage and full sync without an app tap. Recent logs record successful sync starts. The final device check returned no ADB devices, so a fresh connection could not be tested during this change. No mobile APK or sync settings changed for this website update.
