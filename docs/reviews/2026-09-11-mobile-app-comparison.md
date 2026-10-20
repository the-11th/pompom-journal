# Original and QA mobile apps

Compared September 10–11, 2026, against both APKs installed on the Samsung phone.

**QA contains the broader UI and reliability review. Original contains the latest small record button, equal record-button margins and centered gallery selection circles. Neither installed build contains every change.**

The original font and compact tag-entry spacing are already present in both.

## Installed builds

| | Original | QA |
|---|---|---|
| App | Datapom | Datapom QA |
| Package | `com.todopup.usage` | `com.todopup.usage.qa` |
| Version shown | 3.0, code 10 | 3.0, code 10 |
| Last updated on phone | September 10, 23:54:58 | September 10, 11:16:21 |
| SHA-256 | `4b41204ab9e6c965597844952f0171f2e622d6c15c7603b5ce9d777dd988b537` | `802ae3a18d0824f88b6040b9b19f88ae7aa1d9d933f9922159ccb77e4e639975` |

The same version number hides substantial differences. Original matches the narrowly patched original-source build; QA matches the earlier reviewed/tag-fix APK. Current workspace source contains later changes that are absent from installed QA, so source alone is insufficient for this comparison.

## Typography, margins and entry controls

| Area | Original | QA |
|---|---|---|
| Journal font | Restored Courier/monospace stack; 16px CSS text | Same stack and size; the larger replacement font has been removed |
| Colors | Existing dark background and amber accent | Same core palette |
| Record button | 26px circle; 8px inner dot | 36px circle; 10px inner dot |
| Record margins | 6px top and right | About 3.6px top, 6px right |
| Space reserved beside paragraph text | 40px | 48px |
| New-tag row | One section label, New tag field, adjacent permanent/temporary controls | Same widths and spacing at 360px and 393px |
| Numeric section label | Repeats the section name above its name/unit label | One name/unit label |
| Shared dialogs | Earlier heading, padding and footer treatment | 18px outer gutters, 12px inner padding, consistent headings and footer targets; whole-dialog scrolling in short windows |
| Native compact buttons | 36dp targets | 44dp targets and press feedback |
| Native typography | Earlier mixed manual/platform dialog styling | Explicit monospace title/message/button styling; main native input and task-title sizes are unchanged |
| Colors and dropdowns | Earlier platform color picker and simpler themed dropdowns | Themed swatches/hex picker; improved dropdown naming, keyboard selection and focus return |
| Photo date/time picker | Earlier click-oriented calendar and silent time conversion/clamping | Named day buttons, keyboard movement, explicit time validation and viewport-aware placement |

Measured using the exact extracted assets with identical synthetic entries. Reading and editing states were checked at 360px and 393px. No page overflow occurred in those entry views. Both retain 24px editing and 27.2px reading line heights.

| Original: synthetic entry | QA: same synthetic entry |
|---|---|
| ![Original entry](/Users/juliaxi/projects/todo-journal/docs/reviews/2026-09-11-app-comparison/original-entry.png) | ![QA entry](/Users/juliaxi/projects/todo-journal/docs/reviews/2026-09-11-app-comparison/qa-entry.png) |

## Tags, journal saves and task links

Both support permanent and temporary tags. The spacing port to Original did **not** include QA's tag logic changes.

| Flow | Original | QA |
|---|---|---|
| Save a newly typed tag | Older rendering; the saved chip does not immediately appear in the compared flow | Shows the selected chip and clears the submitted input |
| Promote a temporary tag | Existing chip can retain its temporary appearance until refresh | Updates the existing chip without duplication |
| Permanent choices on other dates | Older cache/outbox path | Independent permanent-tag registry and queue retain choices offline and across restart/retry |
| Temporary tags | Entry-specific intent | Entry-specific; not offered indiscriminately on other days |
| Save reply arrives while typing | Older reconciliation | Preserves newer typing while reflecting acknowledged tags |
| Journal task references | No working native task-opening bridge in this build | Shows cached task state, saves before opening the native task, and reports missing tasks in place |
| Journal conflict review | Earlier conflict handling | Compares changed fields, updates stale comparisons, guards choices with revisions and preserves newer phone input |
| Incomplete numeric input/navigation | Earlier save/navigation behavior | Themed validation and draft recovery; navigation waits for a safe save |

Fresh browser checks against both extracted bundles confirmed the saved-chip, promotion and native task-link differences. All four targeted QA regression checks passed in QA; Original did not meet those newer expectations. These checks use a synthetic native bridge: they establish UI behavior, not a live Mac sync result.

## Tasks and native navigation

| Area | Original | QA |
|---|---|---|
| Empty task title/save error | Earlier dismiss/no-op behavior | Form remains open with a specific error and entered values |
| Editing a task's notes | Can reconstruct its due time as 23:59 | Preserves the existing due timestamp; changing the day preserves its time |
| Clear due date | Long press | Visible, named clear button |
| Completed/expired details | Some editing controls remain despite server restrictions | Detail editing limited to active tasks; completed tasks can still be reopened |
| Task conflicts | No dedicated native review section | Phone/Mac comparison and explicit keep/use/reopen/copy choices |
| Large text | Earlier fixed rows | Actions wrap or move below titles; scrollable forms and readable labels |
| Calendar | 52dp cells, full month name, text entry marker | 44dp cells, abbreviated large-text month label, geometric entry marker and short-window scrolling |
| Bottom tabs | Symbol-prefixed labels | Short Journal / Tasks / Connect labels |
| Relaunch/modal navigation | Can navigate to Connect on relaunch; native tabs remain usable over shared dialogs | Keeps current screen; shared dialogs block native tab changes until closed |
| Dictation review | Earlier fixed control rows | Scrollable review with tag names and actions arranged for narrow screens |

The recording engine, voice parsing, task notes/subtasks and primary journal/task destinations already exist in both builds. QA does not introduce native recurrence or difficulty editing here.

## Photos, places and maps

| Area | Original | QA |
|---|---|---|
| Native gallery selection circle | New geometric dot, centered independently of font | Older text bullet; prior runtime check measured it 2.5 physical pixels low |
| Native gallery frame | Fixed three-column layout and opening-time bounds | Adaptive columns, larger actions and rotation-aware bounds |
| Photo permission messaging | Earlier generic empty state and repeated permission path | Distinguishes denied access, an empty library and optional photo-location access |
| Photo editor | Existing editing, crop, drawings and stickers | Groups tools by task; shows relevant fields; improves footer, validation and keyboard/large-text behavior |
| Photo cards/previews | Earlier layout/error handling | Top-aligned responsive cards, clearer selected filters and unavailable-image placeholders |
| Photos view contents | Direct photo blocks only; earlier encountered caption/date for reused photos | Includes text-linked-only photos and uses the latest referencing date/caption |
| Photo-tag entry | Earlier labeled field | Compact New tag field; clearer validation and retry handling |
| Photo details and shared dialogs | Earlier save/focus behavior | Retains input on failure, prevents duplicate/busy actions and restores focus after changes |
| Photo time changes | Independent saves with a failure toast | Visible saving/saved state and Retry time; unresolved time prevents final details Save |
| Daily maps | Existing routes, replay and device filters | Keeps map/framing/replay/stop state through refresh; separates scale, status and credit from the map viewport |
| Places/settings | Earlier forms and loading paths | Local retries and retained forms; other settings remain usable when one section fails |
| Interrupted map updates | Earlier replacement path | Preserves verified files; rejects stale versions and retries the manifest |

Photos, photo tags, captions, passage links, editing/stickers, saved places, daily replay, tracking controls and map-download status are shared features. Most QA changes improve existing flows.

Some changed bundled code is not a mobile feature: the full location analytics dashboard has no mobile entry point; the JavaScript photo picker yields to Android's native picker; the gallery refresh helper has no caller in the extracted mobile assets. Those changes are excluded from claims about what mobile users can reach. Gallery previews remain read-only in both; editable photo actions are available through the journal.

## Data, sync and phone settings

The packages have independent local storage, pending changes, credentials and Android permissions. They do not directly share a phone-local journal. Matching content depends on each app's backend configuration and successful synchronization.

**Current connection configuration:** Original has a saved mobile endpoint at `http://127.0.0.1:5001`, a credential record and a historical verified marker. Its separate phone-usage endpoint is also configured. QA has neither mobile nor usage configuration. QA is therefore currently unpaired, not a live second copy of the original journal. Original's historical verification does not establish current connection health; no sync was triggered for this comparison.

If QA is later paired to the same Mac store, its edits will reach the same server journal. The QA package name isolates phone storage; it does not create a separate server dataset.

QA adds more complete acknowledgement/conflict protection for tasks, journal drafts, permanent tags and media; better retention on damaged reads and interrupted updates; and USB-friendly retries. These improvements do not establish that a live sync is currently healthy. Server reconciliation and provider changes are separate from the APK and require the appropriate running backend.

On the active phone profile, Original has microphone, photo, precise/background location and notification permissions. QA currently has none of those granted. Permissions and app code are separate differences; QA cannot fully exercise those capabilities until access is allowed. This comparison did not change permissions.

## Evidence and limits

- Fresh APK pulls, hashes, installed versions/timestamps, active-profile permissions and minimal connection configuration inspection. Credential values were not disclosed.
- Exact shared assets compared; material native behavior checked against APK bytecode/resources and the matching source.
- Synthetic entry screenshots and geometry at two widths, in reading and editing states.
- Four targeted behavior checks per bundle; earlier native, storage and full-suite review records used as supporting evidence, not presented as newly rerun tests.
- No production journal/photo data was inspected or changed, and neither app was updated during this comparison. No new microphone recording, background tracking run or production end-to-end sync was performed.

Detailed comparisons: [native UI](/Users/juliaxi/projects/todo-journal/docs/reviews/2026-09-11-app-comparison/native-comparison.md), [photos/maps](/Users/juliaxi/projects/todo-journal/docs/reviews/2026-09-11-app-comparison/media-comparison.md), [sync](/Users/juliaxi/projects/todo-journal/docs/reviews/2026-09-11-app-comparison/sync-comparison.md). Raw APK comparison evidence is under `/tmp/datapom-app-comparison/`; the entry measurements and screenshots are saved beside this report.
