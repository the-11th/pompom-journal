# Native Android comparison: installed Original and QA

Read-only comparison of the freshly pulled APKs. Original is `4b41204ab9e6c965597844952f0171f2e622d6c15c7603b5ce9d777dd988b537`; QA is `802ae3a18d0824f88b6040b9b19f88ae7aa1d9d933f9922159ccb77e4e639975`.

QA contains the broad native polish from the review. Original retains its earlier native layout plus the recently requested centered gallery dots. Installed QA predates that dot fix. The smaller recording control and new-tag spacing are shared WebView assets; they are outside this native comparison.

## Navigation, common controls and dialogs

| Area | Original | QA |
|---|---|---|
| Bottom tabs | Symbol-prefixed `✎ Journal`, `☑ Tasks`, `⚙ Connect`; 13sp action text. | Short `Journal`, `Tasks`, `Connect` labels; 12sp text and smaller horizontal label padding. Same three destinations, selected amber treatment and 44dp tab controls. |
| Compact actions | 36dp compact action target. | 44dp compact target, matching the existing primary control height. Task edit/delete and subtask controls gain space. |
| Press feedback | Styled action background without the added foreground ripple. | Common native actions add a selectable foreground ripple. |
| Native dialog appearance | Existing dark panel and manually styled title/message; footer and list typography rely more on platform defaults. | Shared alert-dialog theme covers list text, colors and font. Explicit 18sp bold monospace titles, 14sp messages, 13sp bold mixed-case buttons, 44dp minimum footer targets, rounded bordered panel. |
| Dialog spacing/rotation | Platform alert sizing; photo gallery is fixed to 96% screen width and 86% height when opened. | Explicit 18dp outside gutters, system-bar/cutout-aware sizing and resizing while a dialog remains open through rotation. |
| Long dialog contents | Task forms and dictation contents are placed directly in their holders. | Task/confirmation content, dictation and review content are wrapped in scroll views so lower content remains reachable with limited height. |
| Web dialog versus native tabs | Web content has no native tab-lock bridge; native tabs can remain usable while its modal is open. | Web dialog state disables/dims native tabs until the final shared dialog closes. Replies from detached views are ignored. |
| Relaunch/USB navigation | A new intent goes to Connect unless explicitly opening media settings. | Ordinary relaunch keeps the current screen. Recognized connection intents go to Connect, except an open shared dialog is retained while the connection action is handled. |
| Button accessibility | Many custom actions are clickable TextViews or containers with names, but no explicit Android button role. | Common actions, gallery actions, calendar days/arrows and the legacy native record control explicitly expose `android.widget.Button`. |

Native palette values are unchanged: background `#14161a`, panel `#1c1f26`, text `#e6e6e6`, muted `#8a8f99`, border `#2a2e37`, amber `#e0a955`, danger `#e0524d`. This is primarily consistency and layout work, not a different color theme. Main native text fields remain 14sp monospace; task titles remain 15sp.

## Tasks

| Area | Original | QA |
|---|---|---|
| Quick add | `What needs doing?`; input has a fixed 44dp row. | `New task`; field can grow naturally. Empty state is the shorter `No active tasks`. |
| Task form validation | Blank new title silently does nothing after the standard dialog button closes; edit has no local blank-title check. | `Add a task title.` appears in the form, is announced politely, returns focus to the title and keeps the dialog open. Failed saves preserve the form and show a themed error. |
| Due date clearing | Long-press the date field; toast confirms clearing. | Visible × button named `Clear task due date`. |
| Due time on edits | Reconstructs every nonempty date as 23:59, including a task whose date was not changed. | Preserves the complete prior timestamp when the date is unchanged; moving the day preserves its existing time. New dates without a previous time still default to 23:59. |
| Completed/expired task details | Completed tasks retain Edit and editable subtasks; expired Edit is present but disabled. | Edit is shown only for active tasks. Completed/expired subtasks are read-only. The parent completion checkbox can still reopen a completed task; expired parent completion stays disabled. |
| Enlarged task text | Edit/delete stay beside the title in one row. | Above system font scale 1.3, action controls move to their own row, leaving the title more width. |
| Delete | Amber-styled × and positive confirmation action. | Red × and red destructive confirmation action. Same confirmation step. |
| Task conflict presentation | No separate native conflict-review section. | `Needs review` cards open Phone/Mac comparisons, showing title and changed fields. Choices include `Keep phone edits`, `Use Mac`, `Reopen with phone edits`, or saving a phone copy when the Mac task was deleted/expired. Errors remain visible in the review dialog. Sync mechanics are covered separately. |
| Journal task references | No native `open-task` bridge or task-index presentation helper. | Opening a linked task moves to Tasks, focuses and scrolls to its title, including completed/expired lists. Missing tasks return a clear unavailable message. |
| Saved-task read failures | Reads the task cache directly while building the page. | Shows a visible saved-task/read-error message rather than assuming an empty list or failing during page construction. |

Both retain Active, Completed and Expired groups; task title, due date, tags, notes, subtasks, completion and deletion remain available. QA does not add a new native recurrence or difficulty editor in this change.

## Calendar, gallery and permissions

| Area | Original | QA |
|---|---|---|
| Calendar layout | Dark background inside the panel; 52dp day cells and a text bullet for days with entries. | Consistent panel background, compact 44dp day cells and a geometric 4dp entry dot; calendar body scrolls in short windows. |
| Calendar enlarged text | Full month name at every text size. | Above font scale 1.3, visual month label uses an abbreviation; accessibility name retains the full month and year. |
| Calendar focus/keyboard | Existing named date cells and month arrows. | Adds button roles; explicitly hides the keyboard when opening. Today, Cancel, day selection, adjacent-month days and entry markers remain. |
| Gallery grid | Three columns, 5dp gaps and 114dp cell height. | Auto-fit columns with a 96dp preferred width, 4dp gaps and cell height based on the column setting. Adapts column count with available width. |
| Gallery header | Amber 18sp title; `Choose more photos` and `Other gallery`; 36dp actions. | Text-colored bold 18sp title; `Photo access` and `Other gallery`; minimum 44dp actions. Header/tools switch arrangement in landscape. |
| Gallery frame | Plain panel, 14dp internal padding and percentage-based bounds. | Rounded bordered panel, 18dp internal padding and consistent outside gutters. |
| Selected-photo dot — Original is newer here | Precisely centered geometric circle inside the existing 24dp ring, independent of font size. | Still uses the `●` TextView glyph in its 24dp ring. The earlier isolated runtime regression measured that glyph 2.5px below center at font scale 1.0. The current workspace contains a fix that is **not** in the installed QA APK. |
| Multi-selection | Independent selection, selected-count Add label and disabled Add when nothing is selected. | Same behavior. No new selection limit is introduced by this UI work. |
| Opening gallery without photo-location permission | Requires both image and photo-location access to skip the permission request, even if images are already accessible. | Existing image permission is sufficient to open the gallery; missing photo-location access gets a concise optional-location explanation. |
| Gallery refusal/empty copy | Empty gallery says `No photos available`; missing location directs to `Choose more photos`. | Distinguishes missing image permission (`Allow photo access or use Other gallery`), empty library and disabled photo locations. |
| Background tracking startup | Existing precise permission plus no saved pause can start recording even when no enable choice is stored. | Resumes only a saved explicit enabled choice while permission remains granted. A saved pause remains respected in both. |

The Android permission declarations and system picker fallback are unchanged. Both support the granted/limited image set and a system `Other gallery` picker. Current-location lookup and microphone permission request mechanisms are unchanged. This report did not grant permissions or query the user's image library.

## Dictation and Connect presentation

- Original titles the recording dialog `Continuous dictation`; QA shortens it to `Dictation`. Both retain transcript preview, Cancel, `Stop & review`, reviewed text/tag selection and Accept.
- QA scrolls recording/review contents and stacks a detected tag name above its Section/Ignore/Keep controls. Controls can wrap instead of staying in fixed 132dp/110dp columns. The recording engine and voice parsing files are unchanged.
- Original Connect begins with `Photos & places settings` and three explanatory cards. QA puts connection state/action first, shows two short setup cards only when unpaired, and uses `Photos & places` below the connection controls.
- QA's connection wording distinguishes `Not paired`, `Paired · ready to sync` and `Last connected …`. Its visible action is `Sync now`, changes to a disabled `Syncing…` while running, and is available after configuration without requiring a prior successful verification.
- QA updates the visible usage-upload status while Connect stays open and exposes it as a polite live region. Original reads that status when constructing the screen. Underlying synchronization reliability is outside this report.

## Evidence and limits

Compared native source under `/tmp/datapom-original-ui-20260910/android/app/src/main/` against the reviewed workspace, then checked material claims in the freshly pulled QA/Original `classes3.dex` disassembly. No app, source, preference, permission or user data was changed.

Material APK confirmations:

- QA `TodoPupUi` constants explicitly contain compact height 44, main height 44, page/dialog gutters 18; Original compact height is 36.
- QA DEX contains `NativeDialogTheme`, `NativeAccessibility`, button role string, `dueRow`, `taskTitleError`, `reviewTaskConflict`, `mediaDialogState`, `mediaOpenTask`, `open-task` and `dialog-state`. Its task-card bytecode has the font-scale 1.3 branch and active-edit policy.
- QA resource table contains `Theme.TodoPupUsage.Dialog`; Original source lacks that added theme.
- QA gallery adapter DEX still emits `●`; Original gallery adapter constructs `LayerDrawable` and applies symmetric insets. This is why current workspace source alone would give the wrong installed-QA answer.
- Gallery auto-fit/column-width calls and the different Photo access/Choose more photos labels are present in the respective APKs.
- Derived evidence files: `qa-native-dexdump.txt`, `original-native-dexdump.txt`, `qa-ui-evidence.txt`, `original-ui-evidence.txt`, `main-activity.diff`, `media-journal-view.diff` in this report directory.

This was a read-only code/APK comparison, not a new live interaction run. Visual behavior at a particular screen size is inferred from the installed code and the earlier synthetic review; TalkBack speech output was not tested. OS dialogs can vary by Android version. The unused `legacyJournalScreen` and its native recording button are not the current journal surface; their presence in DEX is not evidence that the user sees them. Shared WebView journal, photo editor, map, color/date popovers, tag persistence and sync differences belong in the other comparison sections.
