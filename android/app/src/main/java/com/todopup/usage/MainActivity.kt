package com.todopup.usage

import android.Manifest
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.Editable
import android.text.InputType
import android.text.Spanned
import android.text.TextWatcher
import android.text.TextPaint
import android.text.TextUtils
import android.text.style.CharacterStyle
import android.text.style.UpdateAppearance
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.widget.*
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.setPadding
import androidx.work.*
import java.time.LocalDate
import java.time.Instant
import java.util.UUID

/** TodoPup's offline-first phone shell: journal, tasks, and private Mac setup. */
class MainActivity : AppCompatActivity() {
    private val bg = Color.parseColor(TodoPupUi.BACKGROUND)
    private val panel = Color.parseColor(TodoPupUi.PANEL)
    private val text = Color.parseColor(TodoPupUi.TEXT)
    private val muted = Color.parseColor(TodoPupUi.MUTED)
    private val border = Color.parseColor(TodoPupUi.BORDER)
    private val accent = Color.parseColor(TodoPupUi.ACCENT)
    private val danger = Color.parseColor(TodoPupUi.DANGER)
    private val green = Color.parseColor(TodoPupUi.SUCCESS)
    private val density by lazy { resources.displayMetrics.density }
    private lateinit var repository: MobileRepository
    private lateinit var content: FrameLayout
    private lateinit var nav: LinearLayout
    private var currentScreen = Screen.JOURNAL
    private var journalDate = LocalDate.now().toString()
    private var completedTasksExpanded = false
    private var taskQuickAdd = ""
    private var mediaJournal: MediaJournalView? = null
    private var mediaDialogOpen = false
    private var photoCallback: ((List<Uri>) -> Unit)? = null
    private var photoGallery: PhotoGalleryDialog? = null
    private var photoGalleryDate: LocalDate? = null
    private var trackingCallback: ((org.json.JSONObject) -> Unit)? = null
    private val currentLocation by lazy { CurrentLocationRequest(this) }
    private val currentLocationCallbacks = mutableListOf<(org.json.JSONObject) -> Unit>()
    private val currentLocationPermissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        val callbacks = currentLocationCallbacks.toList(); currentLocationCallbacks.clear()
        callbacks.forEach { callback ->
            if (CurrentLocationRequest.hasPermission(this)) currentLocation.request(callback)
            else callback(CurrentLocationRequest.permissionRequired())
        }
    }
    private val mediaPhotoPicker = registerForActivityResult(ActivityResultContracts.PickMultipleVisualMedia()) { uris ->
        photoCallback?.invoke(uris); photoCallback = null
    }
    private val galleryPermissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        if (photoGallery?.isShowing == true) photoGallery?.reload() else showPhotoGallery()
    }
    private fun showPhotoGallery() {
        photoGallery = PhotoGalleryDialog(this,
            chooseMore = { galleryPermissions.launch(PhotoGalleryDialog.permissions()) },
            systemPicker = { mediaPhotoPicker.launch(androidx.activity.result.PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
            result = { uris -> photoCallback?.invoke(uris); photoCallback = null; photoGallery = null },
            day = photoGalleryDate).also { it.show() }
    }
    private val trackingPermissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        if (granted) { LocationTrackingService.preferences(this).edit().putBoolean("enabled", true).commit(); LocationTrackingService.start(this) }
        trackingCallback?.invoke(org.json.JSONObject().put("enabled", granted)); trackingCallback = null
    }
    fun mediaPickPhotos(date: LocalDate? = null, callback: (List<Uri>) -> Unit) {
        photoGalleryDate = date
        photoCallback = callback
        if (PhotoGalleryDialog.hasPhotoAccess(this)) showPhotoGallery()
        else galleryPermissions.launch(PhotoGalleryDialog.permissions())
    }
    fun mediaChooseDate(date: String, dates: Set<String>, callback: (String) -> Unit) {
        JournalCalendarDialog(this, LocalDate.parse(date), dates, onSelect = { journalDate = it.toString(); callback(journalDate) }, onCancel = { callback(date) }).show()
    }
    fun mediaStartDictation(callback: (org.json.JSONObject) -> Unit) {
        startDictation { words ->
            val snapshot = repository.journal(journalDate)
            val selected = mutableMapOf<String, MutableList<String>>()
            val staged = input("", "", true)
            journalTranscript = snapshot.draft.audioTranscript
            reviewDictation(words, snapshot.sections, selected, staged) {
                callback(org.json.JSONObject().put("text", staged.text.toString()).put("audio_transcript", journalTranscript)
                    .put("tags", org.json.JSONObject().apply { selected.forEach { (key, values) -> put(key, org.json.JSONArray(values)) } }))
            }
        }
    }
    fun mediaStopDictation() { dictationController?.stop() }
    fun mediaCurrentLocation(prompt: Boolean, callback: (org.json.JSONObject) -> Unit) {
        if (CurrentLocationRequest.hasPermission(this)) { currentLocation.request(callback); return }
        if (!prompt) { callback(CurrentLocationRequest.permissionRequired()); return }
        currentLocationCallbacks.add(callback)
        if (currentLocationCallbacks.size == 1) currentLocationPermissions.launch(arrayOf(
            Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
    }
    private fun cancelCurrentLocation() {
        currentLocation.cancel()
        val callbacks = currentLocationCallbacks.toList(); currentLocationCallbacks.clear()
        callbacks.forEach { it(CurrentLocationRequest.unavailable("unavailable", "Location lookup stopped because the map was closed.")) }
    }
    fun mediaTracking(body: org.json.JSONObject, callback: (org.json.JSONObject) -> Unit) {
        val prefs = LocationTrackingService.preferences(this)
        if (body.has("detail_paused")) { prefs.edit().putBoolean("detail_paused", body.getBoolean("detail_paused")).commit(); callback(org.json.JSONObject().put("ok", true)); return }
        if (body.optBoolean("background")) {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
            callback(org.json.JSONObject().put("ok", true)); return
        }
        if (!body.optBoolean("enabled")) {
            prefs.edit().putBoolean("enabled", false).commit(); stopService(Intent(this, LocationTrackingService::class.java)); callback(org.json.JSONObject().put("enabled", false)); return
        }
        trackingCallback = callback
        val permissions = mutableListOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        if (android.os.Build.VERSION.SDK_INT >= 33) permissions.add(Manifest.permission.POST_NOTIFICATIONS)
        trackingPermissions.launch(permissions.toTypedArray())
    }
    private var journalBody: EditText? = null
    private var journalTranscript = ""
    private var dictationController: ContinuousDictationController? = null
    private var pendingDictation: (() -> Unit)? = null
    private var tagSuggestionPopup: PopupWindow? = null
    private var activeTagSuggestions: List<TagSuggestion> = emptyList()
    private var completingTag = false
    private var pendingUsbSyncWorkId: UUID? = null
    private val taskCountdowns = mutableListOf<Pair<TextView, String>>()
    private val taskCountdownHandler = Handler(Looper.getMainLooper())
    private var countdownsResumed = false
    private val taskCountdownTick = object : Runnable {
        override fun run() {
            if (!countdownsResumed || currentScreen != Screen.TASKS) return
            updateTaskCountdowns()
            if (taskCountdowns.isNotEmpty()) taskCountdownHandler.postDelayed(this, 30_000)
        }
    }

    private enum class Screen { JOURNAL, TASKS, SETTINGS, MEDIA_SETTINGS }

    private val microphonePermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val action = pendingDictation
        pendingDictation = null
        if (granted) action?.invoke() else toast("Microphone permission is required for dictation")
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        repository = MobileRepositoryProvider.create(this)
        journalDate = savedInstanceState?.getString("journal_date") ?: journalDate
        completedTasksExpanded = savedInstanceState?.getBoolean("tasks_completed_expanded") ?: false
        taskQuickAdd = savedInstanceState?.getString("task_quick_add").orEmpty()
        handleConfigDeepLink(intent)
        setContentView(buildShell())
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                fun finishBack() {
                    if (currentScreen == Screen.MEDIA_SETTINGS) { show(Screen.SETTINGS); return }
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                    isEnabled = true
                }
                val editor = mediaJournal
                if (editor == null) finishBack() else editor.handleBack { handled -> if (!handled) finishBack() }
            }
        })
        val initial = if (intent.getBooleanExtra("media_settings", false)) Screen.MEDIA_SETTINGS
            else if (pendingUsbSyncWorkId != null || isConnectionIntent(intent)) Screen.SETTINGS
            else runCatching { Screen.valueOf(savedInstanceState?.getString("screen") ?: "JOURNAL") }.getOrDefault(Screen.JOURNAL)
        intent.removeExtra("media_settings"); show(initial)
        if (MobileConfig.isConfigured(this)) MobileSyncScheduler.enqueue(this)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleConfigDeepLink(intent)
        if (::content.isInitialized) {
            val target = when {
                intent.getBooleanExtra("media_settings", false) -> Screen.MEDIA_SETTINGS
                isConnectionIntent(intent) -> Screen.SETTINGS
                else -> null
            }
            intent.removeExtra("media_settings")
            if (!mediaDialogOpen) target?.let(::show)
        }
    }

    private fun isConnectionIntent(intent: Intent): Boolean = intent.data?.let { data ->
        TodoPupUi.acceptsDeepLink(packageName, data.scheme) && data.host in setOf("config", "sync", "usage")
    } == true

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("journal_date", journalDate); outState.putString("screen", currentScreen.name)
        outState.putBoolean("tasks_completed_expanded", completedTasksExpanded)
        outState.putString("task_quick_add", taskQuickAdd)
        mediaJournal?.save(); super.onSaveInstanceState(outState)
    }

    override fun onPause() {
        countdownsResumed = false
        taskCountdownHandler.removeCallbacks(taskCountdownTick)
        mediaJournal?.save(); super.onPause()
    }

    override fun onResume() {
        super.onResume()
        UsageCollectionWorker.schedule(this)
        countdownsResumed = true
        restartTaskCountdowns()
        photoGallery?.reload()
        runCatching { LocationTrackingService.resumeIfEnabled(this) }.onFailure {
            LocationTrackingService.preferences(this).edit().putString("error", "Tracking could not resume. Reopen Tracking to try again.").apply()
        }
    }

    override fun onStop() { currentLocation.cancel(); super.onStop() }

    override fun onDestroy() {
        taskCountdownHandler.removeCallbacks(taskCountdownTick)
        taskCountdowns.clear()
        cancelCurrentLocation()
        photoGallery?.dismiss()
        mediaJournal?.close()
        tagSuggestionPopup?.dismiss()
        dictationController?.cancel()
        super.onDestroy()
    }

    private fun observeSync(workId: UUID, update: (SyncUiState, String?) -> Unit) {
        val work = WorkManager.getInstance(this).getWorkInfoByIdLiveData(workId)
        work.observe(this) { info ->
            if (info == null) return@observe
            val detail = info.outputData.getString(MobileSyncScheduler.KEY_MESSAGE)
                ?: info.progress.getString(MobileSyncScheduler.KEY_MESSAGE)
            when (info.state) {
                WorkInfo.State.RUNNING, WorkInfo.State.BLOCKED ->
                    update(SyncUiState.SYNCING, null)
                WorkInfo.State.ENQUEUED -> update(
                    if (info.runAttemptCount > 0 || !detail.isNullOrBlank()) SyncUiState.RETRYING
                    else SyncUiState.SYNCING, detail)
                WorkInfo.State.SUCCEEDED -> {
                    update(SyncUiState.CONNECTED, detail)
                    work.removeObservers(this)
                }
                WorkInfo.State.FAILED -> {
                    update(SyncUiState.FAILED, detail)
                    work.removeObservers(this)
                }
                WorkInfo.State.CANCELLED -> {
                    update(SyncUiState.RETRYING, "Sync interrupted · try again")
                    work.removeObservers(this)
                }
            }
        }
    }

    private fun renderSyncStatus(view: TextView, state: SyncUiState, detail: String? = null) {
        view.text = "●  ${TodoPupUi.syncMessage(state, detail)}"
        view.setTextColor(when (state) {
            SyncUiState.CONNECTED -> green
            SyncUiState.FAILED -> danger
            else -> muted
        })
    }

    private fun buildShell(): View {
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(bg) }
        content = FrameLayout(this).apply { setBackgroundColor(bg) }
        root.addView(content, LinearLayout.LayoutParams(-1, 0, 1f))
        nav = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            setPadding(dp(TodoPupUi.SPACE_XS_DP))
            background = box(panel, 0f, border)
        }
        root.addView(nav, LinearLayout.LayoutParams(-1, dp(TodoPupUi.NAV_HEIGHT_DP)))
        return root
    }

    private fun show(screen: Screen) {
        taskCountdownHandler.removeCallbacks(taskCountdownTick)
        taskCountdowns.clear()
        cancelCurrentLocation()
        mediaDialogOpen = false
        currentScreen = screen
        tagSuggestionPopup?.dismiss()
        activeTagSuggestions = emptyList()
        mediaJournal?.close(); mediaJournal = null
        content.removeAllViews()
        journalBody = null
        content.addView(when (screen) {
            Screen.JOURNAL -> journalScreen()
            Screen.TASKS -> tasksScreen()
            Screen.SETTINGS -> settingsScreen()
            Screen.MEDIA_SETTINGS -> MediaJournalView(this, journalDate, true).also { mediaJournal = it }
        }, FrameLayout.LayoutParams(-1, -1))
        renderNav()
        restartTaskCountdowns()
    }

    private fun renderNav() {
        nav.removeAllViews()
        listOf(Screen.JOURNAL to "Journal", Screen.TASKS to "Tasks", Screen.SETTINGS to "Connect")
            .forEach { (screen, title) ->
                val button = action(title, screen == currentScreen || screen == Screen.SETTINGS && currentScreen == Screen.MEDIA_SETTINGS) { show(screen) }
                button.textSize = 12f
                button.setPadding(dp(TodoPupUi.SPACE_XS_DP), 0, dp(TodoPupUi.SPACE_XS_DP), 0)
                nav.addView(button, LinearLayout.LayoutParams(0, dp(TodoPupUi.CONTROL_HEIGHT_DP), 1f).apply {
                    marginStart = dp(TodoPupUi.SPACE_XS_DP)
                    marginEnd = dp(TodoPupUi.SPACE_XS_DP)
                })
            }
    }

    // Journal ------------------------------------------------------------

    private fun journalScreen(): View {
        return MediaJournalView(this, journalDate).also { mediaJournal = it }
    }

    private fun legacyJournalScreen(): View {
        val day = journalDate
        var snapshot = repository.journal(day)
        journalTranscript = snapshot.draft.audioTranscript
        if (MobileConfig.isConfigured(this)) MobileSyncScheduler.enqueue(this, day)
        var mood = snapshot.draft.mood
        val selectedTags = snapshot.draft.tags.mapValues { it.value.toMutableList() }.toMutableMap()
        var persistDraft: () -> Unit = {}
        val column = page("journal", "A quiet place for today")

        val date = input(day, "Date").apply {
            tag = UiControl.JOURNAL_DATE.name
            contentDescription = TodoPupUi.calendarDayDescription(
                day,
                day in repository.entryDates(),
            )
            isFocusable = false; isClickable = true
            setOnClickListener {
                val d = runCatching { LocalDate.parse(text.toString()) }.getOrDefault(LocalDate.now())
                JournalCalendarDialog(this@MainActivity, d, repository.entryDates()) { selected ->
                    journalDate = selected.toString()
                    show(Screen.JOURNAL)
                }.show()
            }
        }
        column.addView(date)
        val titleField = input(snapshot.draft.title, "Title (optional)").apply {
            contentDescription = TodoPupUi.controlDescription(UiControl.JOURNAL_TITLE)
        }
        column.addView(titleField)

        column.addView(sectionTitle("How was your day?"))
        val moodStrip = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            contentDescription = TodoPupUi.controlDescription(UiControl.JOURNAL_MOOD)
        }
        fun drawMoods() {
            moodStrip.removeAllViews()
            (1..7).forEach { n ->
                val res = resources.getIdentifier("mood_$n", "drawable", packageName)
                val image = ImageButton(this).apply {
                    setImageResource(res)
                    scaleType = ImageView.ScaleType.CENTER_INSIDE
                    contentDescription = "Mood $n of 7"
                    background = if (mood == n) box(panel, 12f, accent) else null
                    alpha = if (mood == null || mood == n) 1f else .38f
                    setPadding(dp(TodoPupUi.SPACE_XS_DP))
                    setOnClickListener { mood = if (mood == n) null else n; drawMoods(); persistDraft() }
                }
                moodStrip.addView(image, LinearLayout.LayoutParams(0, dp(58), 1f).apply {
                    if (n < 7) marginEnd = dp(TodoPupUi.SPACE_XS_DP)
                })
            }
        }
        drawMoods(); column.addView(moodStrip)

        val tagsHost = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            contentDescription = TodoPupUi.controlDescription(UiControl.JOURNAL_TAGS)
        }
        var renderTags: () -> Unit = {}
        column.addView(sectionTitle("What happened?"))
        val bodyField = input(snapshot.draft.body, "Write, speak, or use @tags · #numbers · [] tasks", true).apply {
            contentDescription = TodoPupUi.controlDescription(UiControl.JOURNAL_BODY)
            minLines = 8
            gravity = Gravity.TOP
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            setPadding(
                dp(TodoPupUi.CONTROL_PADDING_DP),
                dp(TodoPupUi.CONTROL_PADDING_DP),
                dp(TodoPupUi.COMPACT_CONTROL_HEIGHT_DP),
                dp(TodoPupUi.CONTROL_PADDING_DP),
            )
            layoutParams = FrameLayout.LayoutParams(-1, -2)
        }
        val bodyHost = FrameLayout(this).apply {
            addView(bodyField)
            addView(recordButton {
            startDictation { words ->
                reviewDictation(words, snapshot.sections, selectedTags, bodyField = journalBody) {
                    renderTags(); persistDraft()
                }
            }
            }, FrameLayout.LayoutParams(dp(TodoPupUi.RECORD_SIZE_DP), dp(TodoPupUi.RECORD_SIZE_DP), Gravity.END or Gravity.TOP).apply {
                topMargin = dp(TodoPupUi.RECORD_INSET_DP)
                marginEnd = dp(TodoPupUi.RECORD_INSET_DP)
            })
            layoutParams = LinearLayout.LayoutParams(-1, -2).apply {
                bottomMargin = dp(TodoPupUi.CONTENT_GAP_DP)
            }
        }
        journalBody = bodyField
        column.addView(bodyHost)

        column.addView(sectionTitle("Tags"))
        renderTags = {
            tagsHost.removeAllViews()
            snapshot.sections.filter { it.type == "tag" }.forEach { section ->
                val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
                row.addView(label(section.name, muted, 12f), LinearLayout.LayoutParams(dp(84), -2))
                val selected = selectedTags[section.id].orEmpty()
                row.addView(label(if (selected.isEmpty()) "—" else selected.joinToString(" · "), text, 13f), LinearLayout.LayoutParams(0, -2, 1f))
                row.addView(action("+") { tagDialog(section, selectedTags) { renderTags(); persistDraft() } },
                    LinearLayout.LayoutParams(dp(48), dp(TodoPupUi.COMPACT_CONTROL_HEIGHT_DP)))
                tagsHost.addView(row, LinearLayout.LayoutParams(-1, -2).apply {
                    bottomMargin = dp(TodoPupUi.CONTENT_GAP_DP)
                })
            }
        }
        renderTags(); column.addView(tagsHost)
        val sync = label("●  ${snapshot.message}", when (snapshot.draft.syncState) {
            SyncState.CONFLICT, SyncState.PERMANENT_FAILURE -> danger
            SyncState.SYNCED -> green
            else -> muted
        }, 12f).apply {
            setPadding(0, dp(TodoPupUi.SPACE_MD_DP), 0, dp(TodoPupUi.CONTENT_GAP_DP))
        }
        column.addView(sync)
        if (MobileConfig.isVerified(this)) {
            column.addView(action("Sync entries now") {
                val workId = MobileSyncScheduler.syncAllNow(this)
                observeSync(workId) { state, detail ->
                    if (currentScreen != Screen.JOURNAL || journalDate != day) return@observeSync
                    if (state == SyncUiState.CONNECTED) {
                        snapshot = repository.journal(day)
                        renderSyncStatus(sync, state, detail)
                        detail?.let { messageDialog("Sync complete", it) }
                    } else if (state == SyncUiState.FAILED) {
                        renderSyncStatus(sync, state, detail)
                        detail?.let { messageDialog("Sync needs attention", it) }
                    } else renderSyncStatus(sync, state, detail)
                }
            }.apply {
                contentDescription = TodoPupUi.controlDescription(UiControl.JOURNAL_SYNC)
            }, fullActionParams(TodoPupUi.COMPACT_CONTROL_HEIGHT_DP))
        }
        fun currentDraft() = snapshot.draft.copy(
            date = date.text.toString(), title = titleField.text.toString().trim(),
            body = bodyField.text.toString(), mood = mood,
            tags = selectedTags.mapValues { it.value.toList() },
            audioTranscript = journalTranscript)
        persistDraft = {
            snapshot = repository.saveJournalDraft(currentDraft())
            sync.text = "●  Draft saved on this phone"
            sync.setTextColor(muted)
        }
        val watcher = object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) {
                val editable = s
                if (editable != null && editable === bodyField.editableText) {
                    var tagsChanged = false
                    val mentions = VoiceCommands.inlineMentions(editable.toString(), snapshot.sections)
                    editable.getSpans(0, editable.length, InlineMentionSpan::class.java)
                        .forEach(editable::removeSpan)
                    mentions.forEach { mention ->
                        val color = runCatching { Color.parseColor(mention.color) }.getOrDefault(accent)
                        editable.setSpan(InlineMentionSpan(color, Color.argb(48, Color.red(color), Color.green(color), Color.blue(color))),
                            mention.start, mention.end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                        val names = selectedTags.getOrPut(mention.sectionId) { mutableListOf() }
                        if (names.none { it.equals(mention.name, ignoreCase = true) }) {
                            names.add(mention.name)
                            tagsChanged = true
                        }
                    }
                    if (tagsChanged) renderTags()
                    if (!completingTag) updateTagSuggestions(bodyField, snapshot.sections)
                }
                persistDraft()
            }
        }
        titleField.addTextChangedListener(watcher)
        bodyField.addTextChangedListener(watcher)
        bodyField.onSelectionChangedListener = { _, _ ->
            if (!completingTag) updateTagSuggestions(bodyField, snapshot.sections)
        }
        bodyField.setOnFocusChangeListener { _, focused ->
            if (focused) updateTagSuggestions(bodyField, snapshot.sections)
            else dismissTagSuggestions()
        }
        bodyField.setOnKeyListener { _, keyCode, event ->
            if (keyCode == KeyEvent.KEYCODE_TAB && event.action == KeyEvent.ACTION_DOWN &&
                activeTagSuggestions.isNotEmpty()) {
                applyTagSuggestion(bodyField, activeTagSuggestions.first())
                true
            } else false
        }
        watcher.afterTextChanged(bodyField.editableText)
        if (snapshot.draft.syncState == SyncState.CONFLICT) {
            column.addView(action("Review phone ↔ Mac conflict") {
                val dialog = AlertDialog.Builder(this).setTitle("Choose the entry to keep")
                    .setMessage("Both versions remain safe until you choose. You can keep the phone draft or replace it with the current Mac entry.")
                    .setItems(arrayOf("Keep phone version", "Use Mac version")) { _, which ->
                        when (val result = repository.resolveJournalConflict(day, which == 0)) {
                            is SaveResult.Saved -> { toast(result.snapshot.message); show(Screen.JOURNAL) }
                            is SaveResult.Failed -> toast(result.message)
                            is SaveResult.Conflict -> Unit
                        }
                    }.setNegativeButton("Cancel", null).create()
                styleDialog(dialog)
                dialog.show()
            }, fullActionParams(TodoPupUi.COMPACT_CONTROL_HEIGHT_DP))
        }
        column.addView(action("Save entry", true) {
            var draft = currentDraft()
            if (draft.title.isBlank() && draft.body.isNotBlank()) {
                val proposed = VoiceCommands.suggestTitle(draft.body)
                if (proposed.isNotBlank()) {
                    themedDialog("Suggested title", label("Use “$proposed” for this entry?", text, 14f), "Use title") {
                        titleField.setText(proposed)
                    }
                    return@action
                }
            }
            when (val result = repository.saveJournal(draft)) {
                is SaveResult.Saved -> {
                    snapshot = result.snapshot
                    sync.text = "●  ${snapshot.message}"
                    sync.setTextColor(muted)
                    toast(if (result.syncWorkId == null) "Entry saved on phone" else "Saved on phone · syncing with Mac")
                    result.syncWorkId?.let { workId ->
                        observeSync(workId) { state, detail ->
                            if (currentScreen != Screen.JOURNAL || journalDate != day) return@observeSync
                            if (state == SyncUiState.CONNECTED) {
                                snapshot = repository.journal(day)
                                sync.text = "●  ${snapshot.message}"
                                sync.setTextColor(when (snapshot.draft.syncState) {
                                    SyncState.SYNCED -> green
                                    SyncState.CONFLICT, SyncState.PERMANENT_FAILURE -> danger
                                    else -> muted
                                })
                                if (snapshot.draft.syncState == SyncState.SYNCED)
                                    toast("Saved to phone and Mac")
                            } else renderSyncStatus(sync, state, detail)
                        }
                    }
                }
                is SaveResult.Conflict -> conflictDialog(result)
                is SaveResult.Failed -> { sync.text = "●  ${result.message}"; sync.setTextColor(danger) }
            }
        }.apply {
            contentDescription = TodoPupUi.controlDescription(UiControl.JOURNAL_SAVE)
        }, fullActionParams())
        return scroll(column)
    }

    private fun tagDialog(section: TagSection, selectedTags: MutableMap<String, MutableList<String>>, done: () -> Unit) {
        val holder = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val selected = selectedTags.getOrPut(section.id) { mutableListOf() }
        section.tags.forEach { tag ->
            holder.addView(TagCheckBox(this).apply {
                text = tag
                isChecked = selected.contains(tag)
                setOnCheckedChangeListener { _, yes ->
                    if (yes && tag !in selected) selected.add(tag) else if (!yes) selected.remove(tag)
                }
            }, LinearLayout.LayoutParams(-1, dp(TodoPupUi.COMPACT_CONTROL_HEIGHT_DP)))
        }
        val custom = input("", "Add a new ${section.name} tag")
        holder.addView(custom)
        val permanent = TagCheckBox(this).apply {
            text = "Keep as a permanent tag"; isChecked = true
        }
        holder.addView(permanent)
        themedDialog("${section.name} tags", holder, "Done") {
            custom.text.toString().trim().lowercase().takeIf(String::isNotBlank)?.let {
                if (it !in selected) selected.add(it)
                if (permanent.isChecked) repository.addJournalTag(section.id, it)
            }
            done()
        }
    }

    private fun conflictDialog(conflict: SaveResult.Conflict) {
        themedDialog("Entry changed on the Mac", label("Your phone draft is safe. Review the Mac version before choosing which one to keep.", text, 14f), "Keep phone draft") {
            repository.saveJournal(conflict.local.copy(baseUpdated = conflict.remote.baseUpdated)); show(Screen.JOURNAL)
        }
    }

    private fun reviewDictation(
        words: String,
        sections: List<JournalSection>,
        selectedTags: MutableMap<String, MutableList<String>>,
        bodyField: EditText?,
        accepted: () -> Unit,
    ) {
        val capture = VoiceCommands.parse(words, sections)
        val holder = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(TodoPupUi.DIALOG_PADDING_DP))
        }
        val transcript = input(capture.text, "Dictated text", true)
        holder.addView(transcript)
        if (capture.commands.isNotEmpty()) holder.addView(sectionTitle("Voice tags"))
        val commandHost = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        holder.addView(commandHost)
        var dialog: AlertDialog? = null

        fun renderCommands() {
            commandHost.removeAllViews()
            capture.commands.forEach { command ->
                val row = LinearLayout(this).apply {
                    orientation = LinearLayout.VERTICAL
                    setPadding(0, dp(TodoPupUi.SPACE_XS_DP), 0, dp(TodoPupUi.SPACE_XS_DP))
                }
                row.addView(label(command.name, if (command.status in setOf("new", "suggested")) accent else text, 13f),
                    LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(TodoPupUi.SPACE_SM_DP) })
                val controls = LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    isBaselineAligned = false
                }
                row.addView(controls)
                if (!command.keepAsText && (command.sectionId == null || command.status == "ambiguous")) {
                    controls.addView(action("Section") {
                        val choices = sections.filter { it.type == "tag" }
                        val picker = AlertDialog.Builder(this)
                            .setTitle("Section for ${command.name}")
                            .setItems(choices.map { it.name }.toTypedArray()) { _, index ->
                                command.sectionId = choices[index].id
                                command.status = if (command.source == "detected") "suggested"
                                    else if (command.sectionIds.isEmpty()) "new" else "matched"
                                renderCommands()
                            }.setNegativeButton("Cancel", null).create()
                        styleDialog(picker)
                        picker.show()
                    }.apply { contentDescription = "Choose section for ${command.name}" },
                        LinearLayout.LayoutParams(0, -2, 1f).apply { marginEnd = dp(TodoPupUi.CONTENT_GAP_DP) })
                } else if (!command.keepAsText) {
                    val section = sections.firstOrNull { it.id == command.sectionId }?.name.orEmpty()
                    controls.addView(label(section, muted, 12f), LinearLayout.LayoutParams(0, -2, 1f).apply {
                        marginEnd = dp(TodoPupUi.CONTENT_GAP_DP)
                    })
                }
                val ignoreLabel = if (command.source == "detected") "Ignore tag" else "Keep words"
                controls.addView(action(if (command.keepAsText) "Use as tag" else ignoreLabel) {
                    command.keepAsText = !command.keepAsText
                    renderCommands()
                }.apply { setSingleLine(false); maxLines = 3; ellipsize = null }, LinearLayout.LayoutParams(0, -2, 1f))
                commandHost.addView(row, LinearLayout.LayoutParams(-1, -2).apply {
                    bottomMargin = dp(TodoPupUi.CONTENT_GAP_DP)
                })
            }
            dialog?.let { openDialog ->
                openDialog.getButton(AlertDialog.BUTTON_POSITIVE)?.isEnabled =
                    capture.commands.none { !it.keepAsText && it.sectionId == null }
            }
        }
        renderCommands()
        dialog = AlertDialog.Builder(this).setTitle("Review dictation")
            .setView(ScrollView(this).apply { addView(holder) })
            .setNegativeButton("Cancel", null).setPositiveButton("Accept", null).create()
        val reviewDialog = requireNotNull(dialog)
        reviewDialog.setOnShowListener {
            applyDialogTheme(reviewDialog)
            reviewDialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled =
                capture.commands.none { !it.keepAsText && it.sectionId == null }
            reviewDialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val field = bodyField ?: return@setOnClickListener
                var addition = transcript.text.toString().trim()
                capture.commands.filter { it.keepAsText && it.source == "explicit" }.forEach { command ->
                    addition += (if (addition.isBlank()) "" else " ") + command.original.trim()
                }
                val start = field.selectionStart.coerceAtLeast(0)
                val end = field.selectionEnd.coerceAtLeast(start)
                val joined = VoiceCommands.smartJoin(
                    field.text.substring(0, start), addition, field.text.substring(end))
                field.setText(joined.value)
                field.setSelection(joined.caret)
                capture.commands.filterNot { it.keepAsText }.forEach { command ->
                    val sid = command.sectionId ?: return@forEach
                    val list = selectedTags.getOrPut(sid) { mutableListOf() }
                    if (list.none { it.equals(command.name, ignoreCase = true) }) list.add(command.name)
                }
                journalTranscript = listOf(journalTranscript, words).filter(String::isNotBlank).joinToString(" ")
                accepted()
                reviewDialog.dismiss()
                toast("Dictation added · tags ready")
            }
        }
        reviewDialog.show()
    }

    private fun startDictation(onResult: (String) -> Unit) {
        val begin = { showContinuousDictation(onResult) }
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
            begin()
        } else {
            pendingDictation = begin
            microphonePermission.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    private fun showContinuousDictation(onResult: (String) -> Unit) {
        if (!android.speech.SpeechRecognizer.isRecognitionAvailable(this)) {
            toast("Speech recognition is not available")
            return
        }
        val holder = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(TodoPupUi.DIALOG_PADDING_DP))
        }
        val state = label("Starting microphone…", accent, 12f)
        val preview = input("", "Your transcript will appear here", true).apply {
            minLines = 6
            isFocusable = false
            isCursorVisible = false
        }
        holder.addView(state, LinearLayout.LayoutParams(-1, -2).apply {
            bottomMargin = dp(TodoPupUi.CONTENT_GAP_DP)
        })
        holder.addView(preview)
        val dialog = AlertDialog.Builder(this)
            .setTitle("Dictation")
            .setView(ScrollView(this).apply { addView(holder) })
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Stop & review", null)
            .create()
        styleDialog(dialog)
        var completed = false
        dialog.setOnShowListener {
            applyDialogTheme(dialog)
            dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setOnClickListener {
                dictationController?.cancel()
                dictationController = null
                dialog.dismiss()
            }
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                dialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = false
                dictationController?.stop()
            }
            dictationController = ContinuousDictationController(
                this,
                onText = { preview.setText(it) },
                onState = { state.text = it },
                onComplete = { words ->
                    completed = true
                    dictationController = null
                    dialog.dismiss()
                    if (words.isBlank()) toast("No speech was captured") else onResult(words)
                },
                onFailure = { message ->
                    dictationController = null
                    state.text = message
                    state.setTextColor(danger)
                    dialog.getButton(AlertDialog.BUTTON_POSITIVE)?.isEnabled = false
                },
            ).also { it.start() }
        }
        dialog.setOnCancelListener {
            if (!completed) dictationController?.cancel()
            dictationController = null
        }
        dialog.show()
    }

    private fun updateTagSuggestions(field: CursorAwareEditText, sections: List<JournalSection>) {
        if (!field.hasFocus() || completingTag) {
            dismissTagSuggestions()
            return
        }
        val suggestions = VoiceCommands.tagSuggestions(
            field.text.toString(), field.selectionStart.coerceAtLeast(0), sections)
        if (suggestions.isEmpty()) {
            dismissTagSuggestions()
            return
        }
        activeTagSuggestions = suggestions
        tagSuggestionPopup?.dismiss()
        val list = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(TodoPupUi.SPACE_XS_DP))
            background = box(panel, TodoPupUi.CONTROL_RADIUS_DP.toFloat(), border)
        }
        suggestions.forEach { suggestion ->
            val section = sections.firstOrNull { it.id == suggestion.sectionId }?.name.orEmpty()
            list.addView(label("@${suggestion.name.replace(' ', '_')}   $section", text, 13f).apply {
                setPadding(dp(TodoPupUi.CONTROL_PADDING_DP))
                isClickable = true
                isFocusable = true
                contentDescription = "Complete tag ${suggestion.name}"
                setOnClickListener { applyTagSuggestion(field, suggestion) }
            }, LinearLayout.LayoutParams(-1, dp(TodoPupUi.COMPACT_CONTROL_HEIGHT_DP)))
        }
        tagSuggestionPopup = PopupWindow(
            list,
            field.width.coerceAtLeast(dp(240)),
            ViewGroup.LayoutParams.WRAP_CONTENT,
            false,
        ).apply {
            isOutsideTouchable = true
            elevation = dp(TodoPupUi.SPACE_SM_DP).toFloat()
            showAsDropDown(field, 0, -dp(TodoPupUi.CONTENT_GAP_DP))
        }
    }

    private fun applyTagSuggestion(field: CursorAwareEditText, suggestion: TagSuggestion) {
        val cursor = field.selectionStart.coerceAtLeast(0)
        val completed = VoiceCommands.completeTag(field.text.toString(), cursor, suggestion)
        if (completed.value == field.text.toString()) return
        val mention = completed.value.substring(suggestion.replaceStart, completed.caret)
        completingTag = true
        dismissTagSuggestions()
        field.editableText.replace(suggestion.replaceStart, cursor, mention)
        field.setSelection(completed.caret)
        completingTag = false
    }

    private fun dismissTagSuggestions() {
        activeTagSuggestions = emptyList()
        tagSuggestionPopup?.dismiss()
        tagSuggestionPopup = null
    }

    // Tasks --------------------------------------------------------------

    private fun updateTaskCountdowns() {
        val now = Instant.now()
        taskCountdowns.forEach { (label, due) ->
            val badge = TaskCountdown.remaining(due, now)
            val value = "due ${due.take(10)}" + badge.text.takeIf(String::isNotBlank)?.let { " · $it" }.orEmpty()
            if (label.text.toString() != value) label.text = value
            label.setTextColor(if (badge.overdue) danger else accent)
        }
    }

    private fun restartTaskCountdowns() {
        taskCountdownHandler.removeCallbacks(taskCountdownTick)
        taskCountdownTick.run()
    }

    fun mediaOpenTask(identity: String) {
        show(Screen.TASKS)
        val title = content.findViewWithTag<TextView>("task-title:$identity") ?: return
        val completedList = content.findViewWithTag<View>("task-completed-list")
        if (completedList?.visibility == View.GONE && completedList.findViewWithTag<View>("task-title:$identity") != null) {
            content.findViewWithTag<View>("task-completed-toggle")?.performClick()
        }
        title.post {
            title.requestFocus()
            title.requestRectangleOnScreen(android.graphics.Rect(0, 0, title.width, title.height), false)
            title.sendAccessibilityEvent(android.view.accessibility.AccessibilityEvent.TYPE_VIEW_FOCUSED)
        }
    }

    fun mediaDialogState(source: MediaJournalView, open: Boolean) {
        if (mediaJournal !== source) return
        mediaDialogOpen = open
        for (index in 0 until nav.childCount) nav.getChildAt(index).apply {
            isEnabled = !open
            alpha = if (open) .45f else 1f
        }
    }

    private fun tasksScreen(): View {
        // Match the journal's compact heading, 18dp gutters and 12dp top inset.
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(TodoPupUi.PAGE_GUTTER_DP), dp(TodoPupUi.SPACE_MD_DP),
                dp(TodoPupUi.PAGE_GUTTER_DP), dp(TodoPupUi.PAGE_BOTTOM_DP))
            addView(label("Tasks", accent, 16f).apply {
                gravity = Gravity.CENTER
                setPadding(0, dp(TodoPupUi.SPACE_XS_DP), 0, dp(TodoPupUi.SPACE_MD_DP))
                androidx.core.view.ViewCompat.setAccessibilityHeading(this, true)
            }, LinearLayout.LayoutParams(-1, -2))
        }
        val loaded = runCatching { repository.tasks() }
        if (loaded.isFailure) {
            column.addView(emptyState(loaded.exceptionOrNull()?.message ?: "Could not read saved tasks.").apply { setTextColor(danger) })
            return scroll(column)
        }
        val tasks = loaded.getOrThrow()
        val addRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; isBaselineAligned = false; gravity = Gravity.CENTER_VERTICAL
        }
        column.addView(label("New task", muted, 12f).apply {
            setPadding(0, 0, 0, dp(TodoPupUi.SPACE_XS_DP))
        })
        val newTask = input(taskQuickAdd, "What needs doing?").apply {
            tag = "task-quick-add"
            contentDescription = TodoPupUi.controlDescription(UiControl.TASK_QUICK_ADD)
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) { taskQuickAdd = s.toString() }
                override fun afterTextChanged(s: Editable?) = Unit
            })
        }
        addRow.addView(newTask, LinearLayout.LayoutParams(0, -2, 1f))
        addRow.addView(action("Add") {
            createTaskEditor(newTask.text.toString().trim())
        }.apply {
            contentDescription = TodoPupUi.controlDescription(UiControl.TASK_CREATE)
        }, LinearLayout.LayoutParams(-2, dp(TodoPupUi.CONTROL_HEIGHT_DP)).apply {
            marginStart = dp(TodoPupUi.CONTENT_GAP_DP)
        })
        column.addView(addRow)
        runCatching { repository.taskConflicts() }.onSuccess { conflicts ->
            if (conflicts.isNotEmpty()) column.addView(taskSectionTitle("Needs review · ${conflicts.size}"))
            conflicts.forEach { column.addView(taskConflictCard(it)) }
        }.onFailure { error ->
            column.addView(label(error.message ?: "Could not read saved task changes.", danger, 13f).apply {
                setPadding(0, dp(TodoPupUi.CONTENT_GAP_DP), 0, 0)
            })
        }
        val active = tasks.filter { it.status == "active" }
        column.addView(taskSectionTitle("Active · ${active.size}"))
        if (active.isEmpty()) column.addView(label("No active tasks", muted, 14f).apply {
            setPadding(0, dp(TodoPupUi.CONTENT_GAP_DP), 0, dp(TodoPupUi.CONTENT_GAP_DP))
        })
        active.forEach { task -> column.addView(taskCard(task)) }
        val completed = tasks.filter { it.status == "completed" }
        column.addView(completedTasks(completed))
        val expired = tasks.filter { it.status == "expired" }
        if (expired.isNotEmpty()) {
            column.addView(taskSectionTitle("Expired · ${expired.size}"))
            expired.forEach { task -> column.addView(taskCard(task)) }
        }
        return scroll(column)
    }

    private fun taskSectionTitle(value: String) = label(value, muted, 12f).apply {
        setPadding(0, dp(TodoPupUi.SECTION_TOP_GAP_DP), 0, dp(TodoPupUi.CONTENT_GAP_DP))
        androidx.core.view.ViewCompat.setAccessibilityHeading(this, true)
    }

    private fun completedTasks(tasks: List<TaskDraft>): View {
        val section = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(TodoPupUi.CONTENT_GAP_DP), 0, 0)
            addView(View(this@MainActivity).apply { setBackgroundColor(border) }, LinearLayout.LayoutParams(-1, dp(1)))
        }
        val list = LinearLayout(this).apply {
            tag = "task-completed-list"
            orientation = LinearLayout.VERTICAL
            tasks.forEach { addView(taskCard(it)) }
            if (tasks.isEmpty()) addView(label("No completed tasks yet", muted, 14f).apply {
                setPadding(0, dp(TodoPupUi.CONTENT_GAP_DP), 0, dp(TodoPupUi.CONTENT_GAP_DP))
            })
        }
        val toggle = action("") {}.apply {
            tag = "task-completed-toggle"
            background = null
            gravity = Gravity.CENTER_VERTICAL
            typeface = Typeface.MONOSPACE
            setPadding(0, dp(TodoPupUi.CONTENT_GAP_DP), 0, dp(TodoPupUi.CONTENT_GAP_DP))
        }
        fun render() {
            list.visibility = if (completedTasksExpanded) View.VISIBLE else View.GONE
            toggle.text = "${if (completedTasksExpanded) "▾" else "▸"}  Completed · ${tasks.size}"
            toggle.contentDescription = "${if (completedTasksExpanded) "Collapse" else "Expand"} completed tasks · ${tasks.size}"
            androidx.core.view.ViewCompat.setStateDescription(toggle, if (completedTasksExpanded) "Expanded" else "Collapsed")
        }
        toggle.setOnClickListener { completedTasksExpanded = !completedTasksExpanded; render() }
        section.addView(toggle, LinearLayout.LayoutParams(-1, -2))
        section.addView(list)
        render()
        return section
    }

    private fun taskCard(task: TaskDraft): View {
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(TodoPupUi.CARD_PADDING_DP))
            background = box(panel, TodoPupUi.CONTROL_RADIUS_DP.toFloat(), border)
            layoutParams = LinearLayout.LayoutParams(-1, -2).apply {
                bottomMargin = dp(TodoPupUi.CONTENT_GAP_DP)
            }
        }
        val top = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        val check = TagCheckBox(this).apply {
            tag = "task-check:${task.id}"
            isChecked = task.done; contentDescription = if (task.done) "${task.title} completed" else "Complete ${task.title}"
            isEnabled = task.status != "expired"
            alpha = if (isEnabled) 1f else .45f
            setOnCheckedChangeListener { _, done ->
                runTaskAction { replaceTask(task, task.copy(done = done, status = if (done) "completed" else "active")) }
            }
        }
        top.addView(check, LinearLayout.LayoutParams(dp(TodoPupUi.CONTROL_HEIGHT_DP), dp(TodoPupUi.CONTROL_HEIGHT_DP)))
        top.addView(label(task.title, if (task.done || task.status == "expired") muted else text, 16f).apply {
            tag = "task-title:${task.id}"
            isFocusableInTouchMode = true
            if (task.done) paintFlags = paintFlags or android.graphics.Paint.STRIKE_THRU_TEXT_FLAG
        }, LinearLayout.LayoutParams(0, -2, 1f))
        val actions = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; isBaselineAligned = false; gravity = Gravity.END
        }
        if (TodoPupUi.canEditTask(task.status)) actions.addView(taskAction("Edit") { taskEditor(task) }.apply {
            contentDescription = "${TodoPupUi.controlDescription(UiControl.TASK_EDIT)}: ${task.title}"
            minWidth = dp(58)
        }, LinearLayout.LayoutParams(-2, dp(TodoPupUi.COMPACT_CONTROL_HEIGHT_DP)).apply {
            marginEnd = dp(TodoPupUi.CONTENT_GAP_DP)
        })
        actions.addView(taskAction("×") {
            themedDialog("Delete task?", label("“${task.title}” will be removed from the phone and Mac.", text, 14f), "Delete", destructive = true) {
                repository.deleteTask(task); show(Screen.TASKS)
            }
        }.apply {
            setTextColor(danger)
            contentDescription = "${TodoPupUi.controlDescription(UiControl.TASK_DELETE)}: ${task.title}"
        }, LinearLayout.LayoutParams(dp(TodoPupUi.COMPACT_CONTROL_HEIGHT_DP), dp(TodoPupUi.COMPACT_CONTROL_HEIGHT_DP)))
        card.addView(top)
        if (task.tags.isNotEmpty()) card.addView(label(task.tags.joinToString("  ") { "#$it" }, accent, 12f).apply {
            setPadding(dp(TodoPupUi.CONTROL_HEIGHT_DP), 0, 0, dp(TodoPupUi.SPACE_XS_DP))
        })
        task.due?.takeIf(String::isNotBlank)?.let { due ->
            card.addView(label("due ${due.take(10)}", accent, 12f).apply {
                tag = "task-due:${task.id}"
                setPadding(dp(TodoPupUi.CONTROL_HEIGHT_DP), 0, 0, dp(TodoPupUi.SPACE_XS_DP))
                if (task.status == "active" && !task.done) taskCountdowns.add(this to due)
            })
        }
        if (task.notes.isNotBlank()) card.addView(label(task.notes, muted, 12f).apply {
            setPadding(dp(TodoPupUi.CONTROL_HEIGHT_DP), 0, 0, dp(TodoPupUi.CONTENT_GAP_DP))
        })
        task.subtasks.forEachIndexed { index, sub ->
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(TodoPupUi.COMPACT_CONTROL_HEIGHT_DP), 0, 0, 0)
            }
            row.addView(TagCheckBox(this).apply {
                isChecked = sub.done
                isEnabled = TodoPupUi.canEditTask(task.status)
                alpha = if (isEnabled) 1f else .45f
                contentDescription = "Subtask ${sub.text}"
                setOnCheckedChangeListener { _, yes ->
                    val subs = task.subtasks.toMutableList(); subs[index] = sub.copy(done = yes)
                    runTaskAction { replaceTask(task, task.copy(subtasks = subs)) }
                }
            }, LinearLayout.LayoutParams(dp(TodoPupUi.COMPACT_CONTROL_HEIGHT_DP), dp(TodoPupUi.COMPACT_CONTROL_HEIGHT_DP)))
            row.addView(label(sub.text, if (sub.done) muted else text, 13f), LinearLayout.LayoutParams(0, -2, 1f))
            card.addView(row)
        }
        card.addView(actions, LinearLayout.LayoutParams(-1, -2))
        return card
    }

    private fun taskAction(value: String, click: () -> Unit) = action(value, click = click).apply {
        background = null
        typeface = Typeface.MONOSPACE
    }

    private fun taskEditor(task: TaskDraft) {
        val form = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val title = input(task.title, "Task title"); val notes = input(task.notes, "Notes", true)
        val due = dueInput(task.due)
        val tags = input(task.tags.joinToString(", "), "tags, comma separated")
        val subtask = input("", "Add a subtask")
        val error = taskFormError()
        form.addView(title); form.addView(dueRow(due)); form.addView(notes); form.addView(tags); form.addView(subtask); form.addView(error)
        themedDialog("Edit task", form, "Save", validate = { validateTaskTitle(title, error) }) {
            val subs = task.subtasks.toMutableList()
            subtask.text.toString().trim().takeIf(String::isNotBlank)?.let { subs.add(SubtaskDraft(it, false)) }
            replaceTask(task, task.copy(title = title.text.toString().trim(), due = TodoPupUi.taskDueValue(due.text.toString(), task.due), notes = notes.text.toString(),
                tags = tags.text.toString().split(',').map { it.trim().lowercase() }.filter { it.isNotBlank() }, subtasks = subs))
        }
    }

    private fun createTaskEditor(initialTitle: String) {
        val form = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val title = input(initialTitle, "Task title")
        val due = dueInput(null)
        val notes = input("", "Notes", true)
        val tags = input("", "tags, comma separated")
        val error = taskFormError()
        form.addView(title); form.addView(dueRow(due)); form.addView(notes); form.addView(tags); form.addView(error)
        themedDialog("New task", form, "Add task", validate = { validateTaskTitle(title, error) }) {
            val value = title.text.toString().trim()
            val created = TaskDraft(UUID.randomUUID().toString(), value, due = TodoPupUi.taskDueValue(due.text.toString(), null),
                tags = tags.text.toString().split(',').map { it.trim().lowercase() }.filter(String::isNotBlank),
                notes = notes.text.toString())
            repository.saveTask(created, null); taskQuickAdd = ""; show(Screen.TASKS)
        }
    }

    private fun dueInput(value: String?): EditText = input(value?.take(10).orEmpty(), "Due date (optional)").apply {
        isFocusable = false; isClickable = true; contentDescription = "Task due date"
        setOnClickListener {
            val current = text.toString().takeIf(String::isNotBlank)?.let { runCatching { LocalDate.parse(it) }.getOrNull() }
                ?: LocalDate.now()
            showDatePicker(current) { selected -> setText(selected.toString()) }
        }
    }

    private fun dueRow(field: EditText): View = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(TodoPupUi.CONTENT_GAP_DP) }
        addView(field, LinearLayout.LayoutParams(0, -2, 1f))
        addView(action("×") { field.setText("") }.apply {
            contentDescription = "Clear task due date"
        }, LinearLayout.LayoutParams(dp(TodoPupUi.CONTROL_HEIGHT_DP), dp(TodoPupUi.CONTROL_HEIGHT_DP)).apply {
            marginStart = dp(TodoPupUi.CONTENT_GAP_DP)
        })
    }

    private fun taskFormError() = label("", danger, 13f).apply {
        visibility = View.GONE
        accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
        setPadding(0, 0, 0, dp(TodoPupUi.CONTENT_GAP_DP))
    }

    private fun validateTaskTitle(field: EditText, error: TextView): Boolean {
        val message = TodoPupUi.taskTitleError(field.text.toString())
        error.text = message.orEmpty()
        error.visibility = if (message == null) View.GONE else View.VISIBLE
        if (message != null) field.requestFocus()
        return message == null
    }

    private fun replaceTask(old: TaskDraft, new: TaskDraft) {
        repository.saveTask(new, old); show(Screen.TASKS)
    }

    private fun runTaskAction(change: () -> Unit) {
        runCatching(change).onFailure {
            show(Screen.TASKS)
            messageDialog("Task not saved", it.message ?: "Please try again.")
        }
    }

    private fun taskConflictCard(conflict: TaskConflict): View {
        val task = conflict.local ?: conflict.remote
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(TodoPupUi.CARD_PADDING_DP))
            background = box(panel, TodoPupUi.CONTROL_RADIUS_DP.toFloat(), border)
            layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(TodoPupUi.CONTENT_GAP_DP) }
        }
        row.addView(label(task?.title ?: "Deleted task", text, 14f), LinearLayout.LayoutParams(0, -2, 1f))
        row.addView(action("Review") { reviewTaskConflict(conflict) }.apply {
            contentDescription = "Review task conflict: ${task?.title ?: "Deleted task"}"
            minWidth = dp(78)
        }, LinearLayout.LayoutParams(-2, dp(TodoPupUi.CONTROL_HEIGHT_DP)).apply { marginStart = dp(TodoPupUi.CONTENT_GAP_DP) })
        return row
    }

    private fun reviewTaskConflict(conflict: TaskConflict) {
        val form = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        if (conflict.resolution == "reopen") form.addView(label("The Mac task is completed. Keeping phone edits will reopen it.", muted, 13f))
        if (conflict.resolution == "copy") form.addView(label(
            if (conflict.remote == null) "The Mac task was deleted. Phone edits can be saved as a new task."
            else "The Mac task expired. Phone edits can be saved as a new task.", muted, 13f))
        val fields = (listOf("title") + conflict.fields).map { if (it == "done") "status" else it }.distinct()
        fun version(name: String, task: TaskDraft?) {
            form.addView(sectionTitle(name).apply {
                if (form.childCount == 0) setPadding(0, 0, 0, dp(TodoPupUi.CONTENT_GAP_DP))
            })
            if (task == null) { form.addView(label("Deleted", muted, 14f).apply {
                setPadding(0, 0, 0, dp(TodoPupUi.CONTENT_GAP_DP))
            }); return }
            fields.forEach { key ->
                val value = when (key) {
                    "title" -> task.title
                    "due" -> "Due: ${task.due?.replace('T', ' ') ?: "None"}"
                    "notes" -> "Notes: ${task.notes.ifBlank { "None" }}"
                    "tags" -> "Tags: ${task.tags.joinToString(", ").ifBlank { "None" }}"
                    "subtasks" -> "Subtasks:\n" + task.subtasks.joinToString("\n") { "${if (it.done) "☑" else "☐"} ${it.text}" }.ifBlank { "None" }
                    "done", "status" -> "Status: ${task.status}"
                    "recurrence" -> "Repeat: ${task.recurrence ?: "None"}"
                    "difficulty" -> "Difficulty: ${task.difficulty ?: "None"}"
                    else -> null
                }
                value?.let { form.addView(label(it, text, 14f).apply {
                    setPadding(0, 0, 0, dp(TodoPupUi.CONTENT_GAP_DP))
                }) }
            }
        }
        version("Phone", conflict.local); version("Mac", conflict.remote)
        val error = taskFormError()
        form.addView(error)
        val dialog = AlertDialog.Builder(this).setTitle("Review task changes").setView(dialogContent(form))
            .setNegativeButton("Cancel", null).create()
        fun resolve(keepPhone: Boolean) {
            runCatching { repository.resolveTaskConflict(conflict.requestId, keepPhone) }
                .onSuccess { dialog.dismiss(); show(Screen.TASKS) }
                .onFailure { error.text = it.message ?: "Could not save this choice."; error.visibility = View.VISIBLE }
        }
        val keepLabel = when {
            conflict.local == null -> "Delete Mac task"
            conflict.resolution == "copy" -> "Save phone copy as new task"
            conflict.resolution == "reopen" -> "Reopen with phone edits"
            else -> "Keep phone edits"
        }
        form.addView(action(keepLabel, conflict.local != null) { resolve(true) }.apply {
            if (conflict.local == null) setTextColor(danger)
            setSingleLine(false); maxLines = 3; ellipsize = null
            setPadding(dp(TodoPupUi.SPACE_SM_DP), dp(TodoPupUi.SPACE_SM_DP), dp(TodoPupUi.SPACE_SM_DP), dp(TodoPupUi.SPACE_SM_DP))
        }, fullActionParams().apply { height = ViewGroup.LayoutParams.WRAP_CONTENT })
        form.addView(action("Use Mac") { resolve(false) }, fullActionParams())
        styleDialog(dialog); dialog.show()
    }

    // Setup --------------------------------------------------------------

    private fun settingsScreen(): View {
        val column = page("connect", "Private two-way sync over USB")
        column.addView(sectionTitle("USB connection"))
        val configured = MobileConfig.isConfigured(this)
        val connection = TodoPupUi.connectionStatus(configured, MobileConfig.verifiedAt(this))
        val connectionStatus = label(connection.message, muted, 13f).apply {
            setPadding(0, 0, 0, dp(TodoPupUi.SPACE_MD_DP))
        }
        val syncActionHost = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        lateinit var startExplicitSync: () -> Unit
        fun renderSyncAction(syncing: Boolean = false) {
            syncActionHost.removeAllViews()
            if (connection.canSync) {
                syncActionHost.addView(action(if (syncing) "Syncing…" else "Sync now", true) { startExplicitSync() }.apply {
                    contentDescription = TodoPupUi.controlDescription(UiControl.JOURNAL_SYNC)
                    isEnabled = !syncing
                    alpha = if (syncing) .6f else 1f
                }, fullActionParams())
            }
        }
        fun observeSettingsSync(workId: UUID) {
            observeSync(workId) { state, detail ->
                if (currentScreen != Screen.SETTINGS) return@observeSync
                renderSyncStatus(connectionStatus, state, if (state == SyncUiState.CONNECTED) "Synced with Mac" else detail)
                renderSyncAction(state == SyncUiState.SYNCING)
                if (state == SyncUiState.CONNECTED) {
                    MobileConfig.markVerified(this)
                    detail?.let { messageDialog("Sync complete", it) }
                } else if (state == SyncUiState.FAILED) {
                    detail?.let { messageDialog("Sync needs attention", it) }
                }
            }
        }
        startExplicitSync = {
            renderSyncAction(true)
            if (Config.isConfigured(this)) enqueueUsageNow()
            val workId = MobileSyncScheduler.syncAllNow(this)
            observeSettingsSync(workId)
        }
        column.addView(connectionStatus)
        renderSyncAction()
        column.addView(syncActionHost)
        if (!configured) {
            column.addView(infoCard("①", "Connect USB", "Unlock this phone, connect USB, and allow USB debugging."))
            column.addView(infoCard("②", "Pair on your Mac", "Run the Datapom USB helper. Changes save on your phone while disconnected."))
        }
        pendingUsbSyncWorkId?.let { workId ->
            pendingUsbSyncWorkId = null
            observeSettingsSync(workId)
        }
        column.addView(action("Photos & places") { show(Screen.MEDIA_SETTINGS) }.apply {
            contentDescription = "Photos & places settings"
        }, fullActionParams())
        column.addView(sectionTitle("Phone usage sync"))
        column.addView(label(
            "Usage is saved daily on this phone, even while unplugged. USB sync sends every unsent day.", muted, 12f,
        ).apply { setPadding(0, 0, 0, dp(TodoPupUi.CONTENT_GAP_DP)) })
        column.addView(action("Grant usage access") {
            startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS))
        }, fullActionParams(TodoPupUi.COMPACT_CONTROL_HEIGHT_DP))
        if (Config.isConfigured(this)) column.addView(action("Send usage now") {
            sendTestNow()
        }, fullActionParams(TodoPupUi.COMPACT_CONTROL_HEIGHT_DP))
        column.addView(label("", muted, 12f).apply {
            setPadding(0, dp(TodoPupUi.SPACE_MD_DP), 0, 0)
            accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE
            fun refresh() {
                val last = Config.getLastPush(this@MainActivity)
                text = Config.getCollectionStatus(this@MainActivity) + "\n" +
                    Config.getStatus(this@MainActivity) + if (last.isBlank()) "" else "\nLast push: $last"
            }
            addOnAttachStateChangeListener(object : View.OnAttachStateChangeListener {
                private var observer: AutoCloseable? = null
                override fun onViewAttachedToWindow(view: View) {
                    observer?.close()
                    observer = Config.observeStatus(this@MainActivity) { refresh() }
                    refresh()
                }
                override fun onViewDetachedFromWindow(view: View) {
                    observer?.close()
                    observer = null
                }
            })
        })
        return scroll(column)
    }

    private fun handleConfigDeepLink(intent: Intent?) {
        val data: Uri = intent?.data ?: return
        if (!TodoPupUi.acceptsDeepLink(packageName, data.scheme)) return
        if (data.host == "usage") {
            if (Config.isConfigured(this)) enqueueUsageNow()
            return
        }
        if (data.host == "sync") {
            if (MobileConfig.isConfigured(this)) {
                pendingUsbSyncWorkId = MobileSyncScheduler.syncAllNow(this)
                toast("USB sync started")
            }
            return
        }
        if (data.host != "config") return
        val url = data.getQueryParameter("base_url") ?: data.getQueryParameter("url")
        val token = data.getQueryParameter("token")
        if (!url.isNullOrBlank() && !token.isNullOrBlank()) {
            if (url.trimEnd('/').endsWith("/integrations/phone/ingest")) {
                runCatching { Config.save(this, url, token) }
                    .onSuccess { toast("Phone usage USB sync paired") }
                    .onFailure { toast("Use the Datapom USB helper") }
            } else runCatching { MobileConfig.save(this, url, token) }
                .onSuccess { toast("Datapom paired with your Mac"); MobileSyncScheduler.enqueue(this) }
                .onFailure { toast("Use the Datapom USB helper") }
        }
    }

    private fun sendTestNow() {
        if (!Config.isConfigured(this)) { toast("Connect your Mac first"); return }
        enqueueUsageNow()
        toast("Usage sync queued")
    }

    private fun enqueueUsageNow() {
        Config.setStatus(this, "Usage sync queued")
        UsagePushWorker.enqueue(this)
    }


    // Theme helpers ------------------------------------------------------

    private fun page(title: String, subtitle: String) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(
            dp(TodoPupUi.PAGE_GUTTER_DP),
            dp(TodoPupUi.PAGE_GUTTER_DP),
            dp(TodoPupUi.PAGE_GUTTER_DP),
            dp(TodoPupUi.PAGE_BOTTOM_DP),
        )
        val brand = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        brand.addView(ImageView(this@MainActivity).apply { setImageResource(R.drawable.pompom_icon); contentDescription = "Datapom"; scaleType = ImageView.ScaleType.CENTER_CROP }, LinearLayout.LayoutParams(dp(48), dp(48)))
        val words = LinearLayout(this@MainActivity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(TodoPupUi.SPACE_MD_DP), 0, 0, 0)
        }
        words.addView(label(title, accent, 22f).apply { typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD) })
        words.addView(label(subtitle, muted, 11f))
        brand.addView(words)
        addView(brand, LinearLayout.LayoutParams(-1, -2).apply {
            bottomMargin = dp(TodoPupUi.SPACE_LG_DP)
        })
    }

    private fun scroll(child: View) = ScrollView(this).apply { isFillViewport = true; addView(child, ViewGroup.LayoutParams(-1, -2)) }
    private fun label(value: String, color: Int = text, size: Float = 14f) = TextView(this).apply {
        text = value; setTextColor(color); textSize = size; typeface = Typeface.MONOSPACE; gravity = Gravity.CENTER_VERTICAL
    }
    private fun sectionTitle(value: String) = label(value.uppercase(), accent, 12f).apply {
        typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
        setPadding(0, dp(TodoPupUi.SECTION_TOP_GAP_DP), 0, dp(TodoPupUi.CONTENT_GAP_DP))
    }
    private fun input(value: String, hintText: String, multiline: Boolean = false) = CursorAwareEditText(this).apply {
        setText(value); hint = hintText; setTextColor(this@MainActivity.text); setHintTextColor(muted); textSize = 14f; typeface = Typeface.MONOSPACE
        setPadding(dp(TodoPupUi.CONTROL_PADDING_DP))
        background = box(panel, (if (multiline) TodoPupUi.TEXTAREA_RADIUS_DP else TodoPupUi.CONTROL_RADIUS_DP).toFloat(), border)
        minHeight = dp(TodoPupUi.CONTROL_HEIGHT_DP)
        inputType = InputType.TYPE_CLASS_TEXT or if (multiline)
            InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            else InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
        if (multiline) { gravity = Gravity.TOP; minLines = 3 } else setSingleLine(true)
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply {
            bottomMargin = dp(TodoPupUi.CONTENT_GAP_DP)
        }
    }
    private fun action(value: String, selected: Boolean = false, click: () -> Unit) = TextView(this).apply {
        NativeAccessibility.button(this)
        text = value; setTextColor(if (selected) bg else accent); textSize = 13f; typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
        gravity = Gravity.CENTER
        includeFontPadding = false
        setSingleLine(true)
        ellipsize = TextUtils.TruncateAt.END
        contentDescription = value
        setPadding(dp(TodoPupUi.SPACE_SM_DP), 0, dp(TodoPupUi.SPACE_SM_DP), 0)
        minWidth = dp(TodoPupUi.COMPACT_CONTROL_HEIGHT_DP)
        minHeight = dp(TodoPupUi.COMPACT_CONTROL_HEIGHT_DP)
        isClickable = true
        isFocusable = true
        foreground = selectableItemBackgroundBorderless()
        background = box(if (selected) accent else panel, TodoPupUi.CONTROL_RADIUS_DP.toFloat(), if (selected) accent else border); setOnClickListener { click() }
    }

    private fun recordButton(click: () -> Unit) = FrameLayout(this).apply {
        NativeAccessibility.button(this)
        contentDescription = TodoPupUi.controlDescription(UiControl.JOURNAL_VOICE)
        isClickable = true
        isFocusable = true
        foreground = selectableItemBackgroundBorderless()
        background = oval(panel, border)
        addView(View(this@MainActivity).apply {
            background = oval(muted, muted, 0)
        }, FrameLayout.LayoutParams(dp(TodoPupUi.RECORD_DOT_DP), dp(TodoPupUi.RECORD_DOT_DP), Gravity.CENTER))
        setOnClickListener { click() }
    }
    private fun emptyState(value: String) = label(value, muted, 13f).apply {
        gravity = Gravity.CENTER
        setPadding(dp(TodoPupUi.CARD_PADDING_DP))
        background = box(panel, TodoPupUi.SPACE_MD_DP.toFloat(), border)
    }
    private fun infoCard(mark: String, title: String, body: String): View {
        val row = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(TodoPupUi.CARD_PADDING_DP))
            background = box(panel, TodoPupUi.SPACE_MD_DP.toFloat(), border)
        }
        row.addView(label(mark, accent, 20f), LinearLayout.LayoutParams(dp(48), dp(48)))
        val copy = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        copy.addView(label(title, text, 14f).apply { typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD) })
        copy.addView(label(body, muted, 12f).apply { setPadding(0, dp(TodoPupUi.SPACE_XS_DP), 0, 0) })
        row.addView(copy, LinearLayout.LayoutParams(0, -2, 1f))
        row.layoutParams = LinearLayout.LayoutParams(-1, -2).apply {
            bottomMargin = dp(TodoPupUi.CONTENT_GAP_DP)
        }
        return row
    }
    private fun fullActionParams(
        heightDp: Int = TodoPupUi.CONTROL_HEIGHT_DP,
    ) = LinearLayout.LayoutParams(-1, dp(heightDp)).apply {
        bottomMargin = dp(TodoPupUi.CONTENT_GAP_DP)
    }
    private fun dialogContent(view: View) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setPadding(dp(TodoPupUi.DIALOG_PADDING_DP))
        addView(ScrollView(this@MainActivity).apply { addView(view) }, LinearLayout.LayoutParams(-1, -2))
    }
    private fun showDatePicker(initial: LocalDate, selected: (LocalDate) -> Unit) {
        JournalCalendarDialog(
            context = this,
            initialDate = initial,
            title = "Choose due date",
            onSelect = selected,
        ).show()
    }
    private fun box(fill: Int, radius: Float, stroke: Int) = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE; setColor(fill); setStroke(dp(1), stroke)
        cornerRadius = dp(radius.toInt()).toFloat()
    }
    private fun oval(fill: Int, stroke: Int, strokeWidth: Int = 1) = GradientDrawable().apply {
        shape = GradientDrawable.OVAL
        setColor(fill)
        if (strokeWidth > 0) setStroke(dp(strokeWidth), stroke)
    }
    private fun selectableItemBackgroundBorderless(): android.graphics.drawable.Drawable? {
        val attrs = intArrayOf(android.R.attr.selectableItemBackgroundBorderless)
        val values = obtainStyledAttributes(attrs)
        val drawable = values.getDrawable(0)
        values.recycle()
        return drawable
    }
    private fun themedDialog(title: String, view: View, positive: String,
                             validate: () -> Boolean = { true }, destructive: Boolean = false, onPositive: () -> Unit) {
        val dialog = AlertDialog.Builder(this).setTitle(title).setView(dialogContent(view))
            .setNegativeButton("Cancel", null)
            .setPositiveButton(positive, null)
            .create()
        dialog.setOnShowListener {
            applyDialogTheme(dialog)
            if (destructive) dialog.getButton(AlertDialog.BUTTON_POSITIVE).setTextColor(danger)
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                if (validate()) runCatching(onPositive)
                    .onSuccess { dialog.dismiss() }
                    .onFailure { messageDialog("Could not save", it.message ?: "Please try again.") }
            }
        }
        dialog.show()
    }
    private fun messageDialog(title: String, message: String) {
        val dialog = AlertDialog.Builder(this).setTitle(title).setMessage(message)
            .setPositiveButton("Done", null).create()
        styleDialog(dialog)
        dialog.show()
    }
    private fun styleDialog(dialog: AlertDialog) {
        dialog.setOnShowListener { applyDialogTheme(dialog) }
    }
    private fun applyDialogTheme(dialog: AlertDialog) {
        NativeDialogTheme.apply(dialog)
    }
    private fun dp(value: Int) = (value * density).toInt()
    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
}

private class InlineMentionSpan(
    private val foreground: Int,
    private val background: Int,
) : CharacterStyle(), UpdateAppearance {
    override fun updateDrawState(paint: TextPaint) {
        paint.color = foreground
        paint.bgColor = background
    }
}
