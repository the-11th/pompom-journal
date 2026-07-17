package com.todopup.usage

import android.app.AlertDialog
import android.app.DatePickerDialog
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.speech.RecognizerIntent
import android.text.Editable
import android.text.InputType
import android.text.Spanned
import android.text.TextWatcher
import android.text.TextPaint
import android.text.style.CharacterStyle
import android.text.style.UpdateAppearance
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.*
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.setPadding
import androidx.work.*
import java.time.LocalDate
import java.util.Locale
import java.util.UUID
import java.util.concurrent.TimeUnit

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
    private var journalBody: EditText? = null
    private var journalTranscript = ""
    private var speechHandler: ((String) -> Unit)? = null

    private enum class Screen { JOURNAL, TASKS, SETTINGS }

    private val speech = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val words = result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
        if (!words.isNullOrBlank()) speechHandler?.invoke(words)
        speechHandler = null
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        repository = MobileRepositoryProvider.create(this)
        handleConfigDeepLink(intent)
        setContentView(buildShell())
        show(Screen.JOURNAL)
        schedulePeriodic()
        if (MobileConfig.isConfigured(this)) MobileSyncScheduler.enqueue(this)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleConfigDeepLink(intent)
        if (::content.isInitialized) show(Screen.SETTINGS)
    }

    private fun buildShell(): View {
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(bg) }
        content = FrameLayout(this).apply { setBackgroundColor(bg) }
        root.addView(content, LinearLayout.LayoutParams(-1, 0, 1f))
        nav = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            setPadding(dp(6))
            background = box(panel, 0f, border)
        }
        root.addView(nav, LinearLayout.LayoutParams(-1, dp(68)))
        return root
    }

    private fun show(screen: Screen) {
        currentScreen = screen
        content.removeAllViews()
        journalBody = null
        content.addView(when (screen) {
            Screen.JOURNAL -> journalScreen()
            Screen.TASKS -> tasksScreen()
            Screen.SETTINGS -> settingsScreen()
        }, FrameLayout.LayoutParams(-1, -1))
        renderNav()
    }

    private fun renderNav() {
        nav.removeAllViews()
        listOf(Screen.JOURNAL to "✎  Journal", Screen.TASKS to "☑  Tasks", Screen.SETTINGS to "⚙  Connect")
            .forEach { (screen, title) ->
                nav.addView(action(title, screen == currentScreen) { show(screen) }, LinearLayout.LayoutParams(0, dp(52), 1f).apply {
                    marginStart = dp(3); marginEnd = dp(3)
                })
            }
    }

    // Journal ------------------------------------------------------------

    private fun journalScreen(): View {
        val day = journalDate
        var snapshot = repository.journal(day)
        journalTranscript = snapshot.draft.audioTranscript
        if (MobileConfig.isConfigured(this)) MobileSyncScheduler.enqueue(this, day)
        var mood = snapshot.draft.mood
        val selectedTags = snapshot.draft.tags.mapValues { it.value.toMutableList() }.toMutableMap()
        var persistDraft: () -> Unit = {}
        val column = page("journal", "A quiet place for today")

        val date = input(day, "Date").apply {
            isFocusable = false; isClickable = true
            setOnClickListener {
                val d = runCatching { LocalDate.parse(text.toString()) }.getOrDefault(LocalDate.now())
                DatePickerDialog(this@MainActivity, { _, y, m, dd ->
                    journalDate = LocalDate.of(y, m + 1, dd).toString()
                    show(Screen.JOURNAL)
                }, d.year, d.monthValue - 1, d.dayOfMonth).show()
            }
        }
        column.addView(date)
        val titleField = input(snapshot.draft.title, "Title (optional)")
        column.addView(titleField)

        column.addView(sectionTitle("How was your day?"))
        val moodStrip = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER }
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
                    setPadding(dp(4))
                    setOnClickListener { mood = if (mood == n) null else n; drawMoods(); persistDraft() }
                }
                moodStrip.addView(image, LinearLayout.LayoutParams(0, dp(58), 1f).apply { marginEnd = dp(2) })
            }
        }
        drawMoods(); column.addView(moodStrip)

        val tagsHost = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        var renderTags: () -> Unit = {}
        column.addView(sectionTitle("What happened?"))
        val bodyField = input(snapshot.draft.body, "Write, speak, or use @tags · #numbers · [] tasks", true).apply {
            minLines = 8
            gravity = Gravity.TOP
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
            setPadding(dp(13), dp(13), dp(44), dp(13))
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
            layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(9) }
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
                row.addView(action("+") { tagDialog(section, selectedTags) { renderTags(); persistDraft() } }, LinearLayout.LayoutParams(dp(48), dp(44)))
                tagsHost.addView(row, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(5) })
            }
        }
        renderTags(); column.addView(tagsHost)
        val sync = label("●  ${snapshot.message}", when (snapshot.draft.syncState) {
            SyncState.CONFLICT, SyncState.PERMANENT_FAILURE -> danger
            SyncState.SYNCED -> green
            else -> muted
        }, 12f).apply { setPadding(0, dp(12), 0, dp(8)) }
        column.addView(sync)
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
                }
                persistDraft()
            }
        }
        titleField.addTextChangedListener(watcher)
        bodyField.addTextChangedListener(watcher)
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
                dialog.setOnShowListener { dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setTextColor(muted) }
                dialog.show()
            }, LinearLayout.LayoutParams(-1, dp(48)).apply { bottomMargin = dp(8) })
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
                is SaveResult.Saved -> { snapshot = result.snapshot; sync.text = "●  ${snapshot.message}"; toast("Entry saved") }
                is SaveResult.Conflict -> conflictDialog(result)
                is SaveResult.Failed -> { sync.text = "●  ${result.message}"; sync.setTextColor(danger) }
            }
        }, LinearLayout.LayoutParams(-1, dp(52)))
        return scroll(column)
    }

    private fun tagDialog(section: TagSection, selectedTags: MutableMap<String, MutableList<String>>, done: () -> Unit) {
        val holder = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(18)) }
        val selected = selectedTags.getOrPut(section.id) { mutableListOf() }
        section.tags.forEach { tag ->
            holder.addView(CheckBox(this).apply { text = tag; setTextColor(this@MainActivity.text); isChecked = selected.contains(tag); setOnCheckedChangeListener { _, yes ->
                if (yes && tag !in selected) selected.add(tag) else if (!yes) selected.remove(tag)
            } })
        }
        val custom = input("", "Add a new ${section.name} tag")
        holder.addView(custom)
        val permanent = CheckBox(this).apply {
            text = "Keep as a permanent tag"; setTextColor(this@MainActivity.text); isChecked = true
            buttonTintList = android.content.res.ColorStateList.valueOf(accent)
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
            setPadding(dp(18))
        }
        holder.addView(label("Review the transcript and voice tags before adding them.", muted, 12f))
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
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(0, dp(3), 0, dp(3))
                }
                row.addView(label(command.name, if (command.status == "new") accent else text, 13f),
                    LinearLayout.LayoutParams(0, dp(44), 1f))
                if (!command.keepAsText && (command.sectionId == null || command.status == "ambiguous")) {
                    row.addView(action("choose section") {
                        val choices = sections.filter { it.type == "tag" }
                        val picker = AlertDialog.Builder(this)
                            .setTitle("Section for ${command.name}")
                            .setItems(choices.map { it.name }.toTypedArray()) { _, index ->
                                command.sectionId = choices[index].id
                                command.status = if (command.sectionIds.isEmpty()) "new" else "matched"
                                renderCommands()
                            }.setNegativeButton("Cancel", null).create()
                        picker.setOnShowListener {
                            picker.window?.decorView?.setBackgroundColor(panel)
                            picker.getButton(AlertDialog.BUTTON_NEGATIVE).setTextColor(muted)
                        }
                        picker.show()
                    }, LinearLayout.LayoutParams(dp(132), dp(44)).apply { marginEnd = dp(6) })
                } else if (!command.keepAsText) {
                    val section = sections.firstOrNull { it.id == command.sectionId }?.name.orEmpty()
                    row.addView(label(section, muted, 11f), LinearLayout.LayoutParams(-2, dp(44)).apply { marginEnd = dp(8) })
                }
                row.addView(action(if (command.keepAsText) "use as tag" else "keep words") {
                    command.keepAsText = !command.keepAsText
                    renderCommands()
                }, LinearLayout.LayoutParams(dp(110), dp(44)))
                commandHost.addView(row)
            }
            dialog?.let { openDialog ->
                openDialog.getButton(AlertDialog.BUTTON_POSITIVE)?.isEnabled =
                    capture.commands.none { !it.keepAsText && it.sectionId == null }
            }
        }
        renderCommands()
        dialog = AlertDialog.Builder(this).setTitle("Review dictation").setView(holder)
            .setNegativeButton("Cancel", null).setPositiveButton("Accept", null).create()
        val reviewDialog = requireNotNull(dialog)
        reviewDialog.setOnShowListener {
            reviewDialog.window?.decorView?.setBackgroundColor(panel)
            reviewDialog.getButton(AlertDialog.BUTTON_NEGATIVE).setTextColor(muted)
            reviewDialog.getButton(AlertDialog.BUTTON_POSITIVE).setTextColor(accent)
            reviewDialog.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled =
                capture.commands.none { !it.keepAsText && it.sectionId == null }
            reviewDialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                val field = bodyField ?: return@setOnClickListener
                var addition = transcript.text.toString().trim()
                capture.commands.filter { it.keepAsText }.forEach { command ->
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
        speechHandler = onResult
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault())
            putExtra(RecognizerIntent.EXTRA_PROMPT, "Tell TodoPup about your day")
        }
        runCatching { speech.launch(intent) }.onFailure {
            speechHandler = null
            toast("Speech recognition is not available")
        }
    }

    // Tasks --------------------------------------------------------------

    private fun tasksScreen(): View {
        var tasks = repository.tasks().toMutableList()
        val column = page("tasks", "Small steps count")
        val addRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val newTask = input("", "What needs doing?")
        addRow.addView(newTask, LinearLayout.LayoutParams(0, dp(52), 1f))
        addRow.addView(action("+") {
            val title = newTask.text.toString().trim(); if (title.isEmpty()) return@action
            createTaskEditor(title, tasks)
        }, LinearLayout.LayoutParams(dp(54), dp(52)).apply { marginStart = dp(8) })
        column.addView(addRow)
        val active = tasks.filterNot { it.done }
        column.addView(sectionTitle("Active · ${active.size}"))
        if (active.isEmpty()) column.addView(emptyState("No tasks yet. Add one above!"))
        active.forEach { task -> column.addView(taskCard(task, tasks)) }
        val completed = tasks.filter { it.done }
        if (completed.isNotEmpty()) {
            column.addView(sectionTitle("Completed · ${completed.size}"))
            completed.forEach { task -> column.addView(taskCard(task, tasks)) }
        }
        return scroll(column)
    }

    private fun taskCard(task: TaskDraft, tasks: MutableList<TaskDraft>): View {
        val card = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(12)); background = box(panel, 12f, border) }
        val top = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        val check = CheckBox(this).apply {
            isChecked = task.done; contentDescription = if (task.done) "${task.title} completed" else "Complete ${task.title}"
            isEnabled = !task.done
            buttonTintList = android.content.res.ColorStateList.valueOf(accent)
            setOnCheckedChangeListener { _, done -> replaceTask(tasks, task, task.copy(done = done)) }
        }
        top.addView(check, LinearLayout.LayoutParams(dp(48), dp(48)))
        top.addView(label(task.title, if (task.done) muted else text, 15f).apply {
            if (task.done) paintFlags = paintFlags or android.graphics.Paint.STRIKE_THRU_TEXT_FLAG
        }, LinearLayout.LayoutParams(0, -2, 1f))
        top.addView(action("edit") { taskEditor(task, tasks) }, LinearLayout.LayoutParams(dp(58), dp(44)))
        top.addView(action("×") {
            themedDialog("Delete task?", label("“${task.title}” will be removed from the phone and Mac.", text, 14f), "Delete") {
                repository.deleteTask(task); show(Screen.TASKS)
            }
        }.apply { contentDescription = "Delete ${task.title}" }, LinearLayout.LayoutParams(dp(44), dp(44)))
        card.addView(top)
        if (task.tags.isNotEmpty()) card.addView(label(task.tags.joinToString("  ") { "#$it" }, accent, 12f).apply { setPadding(dp(48), 0, 0, dp(5)) })
        task.due?.takeIf(String::isNotBlank)?.let { due ->
            card.addView(label("due ${due.take(10)}", accent, 12f).apply { setPadding(dp(48), 0, 0, dp(5)) })
        }
        if (task.notes.isNotBlank()) card.addView(label(task.notes, muted, 12f).apply { setPadding(dp(48), 0, 0, dp(7)) })
        task.subtasks.forEachIndexed { index, sub ->
            val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL; setPadding(dp(44), 0, 0, 0) }
            row.addView(CheckBox(this).apply {
                isChecked = sub.done; buttonTintList = android.content.res.ColorStateList.valueOf(accent)
                contentDescription = "Subtask ${sub.text}"
                setOnCheckedChangeListener { _, yes ->
                    val subs = task.subtasks.toMutableList(); subs[index] = sub.copy(done = yes); replaceTask(tasks, task, task.copy(subtasks = subs))
                }
            }, LinearLayout.LayoutParams(dp(44), dp(44)))
            row.addView(label(sub.text, if (sub.done) muted else text, 13f), LinearLayout.LayoutParams(0, -2, 1f))
            card.addView(row)
        }
        return card.apply { (layoutParams as? LinearLayout.LayoutParams)?.bottomMargin = dp(8) }
    }

    private fun taskEditor(task: TaskDraft, tasks: MutableList<TaskDraft>) {
        val form = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(18)) }
        val title = input(task.title, "Task title"); val notes = input(task.notes, "Notes", true)
        val due = dueInput(task.due)
        val tags = input(task.tags.joinToString(", "), "tags, comma separated")
        val subtask = input("", "Add a subtask")
        form.addView(title); form.addView(due); form.addView(notes); form.addView(tags); form.addView(subtask)
        themedDialog("Edit task", form, "Save") {
            val subs = task.subtasks.toMutableList()
            subtask.text.toString().trim().takeIf(String::isNotBlank)?.let { subs.add(SubtaskDraft(it, false)) }
            replaceTask(tasks, task, task.copy(title = title.text.toString().trim(), due = dueValue(due), notes = notes.text.toString(),
                tags = tags.text.toString().split(',').map { it.trim().lowercase() }.filter { it.isNotBlank() }, subtasks = subs))
        }
    }

    private fun createTaskEditor(initialTitle: String, tasks: MutableList<TaskDraft>) {
        val form = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(18)) }
        val title = input(initialTitle, "Task title")
        val due = dueInput(null)
        val notes = input("", "Notes", true)
        val tags = input("", "tags, comma separated")
        form.addView(title); form.addView(due); form.addView(notes); form.addView(tags)
        themedDialog("New task", form, "Add task") {
            val value = title.text.toString().trim()
            if (value.isBlank()) return@themedDialog
            tasks.add(0, TaskDraft(UUID.randomUUID().toString(), value, due = dueValue(due),
                tags = tags.text.toString().split(',').map { it.trim().lowercase() }.filter(String::isNotBlank),
                notes = notes.text.toString()))
            repository.saveTasks(tasks); show(Screen.TASKS)
        }
    }

    private fun dueInput(value: String?): EditText = input(value?.take(10).orEmpty(), "Due date (optional)").apply {
        isFocusable = false; isClickable = true; contentDescription = "Task due date"
        setOnClickListener {
            val current = text.toString().takeIf(String::isNotBlank)?.let { runCatching { LocalDate.parse(it) }.getOrNull() }
                ?: LocalDate.now()
            DatePickerDialog(this@MainActivity, { _, year, month, day ->
                setText(LocalDate.of(year, month + 1, day).toString())
            }, current.year, current.monthValue - 1, current.dayOfMonth).show()
        }
        setOnLongClickListener { setText(""); toast("Due date cleared"); true }
    }

    private fun dueValue(field: EditText): String? = field.text.toString().trim().takeIf(String::isNotBlank)?.let {
        "${it}T23:59:00"
    }

    private fun replaceTask(tasks: MutableList<TaskDraft>, old: TaskDraft, new: TaskDraft) {
        val index = tasks.indexOfFirst { it.id == old.id }; if (index >= 0) tasks[index] = new
        repository.saveTasks(tasks); show(Screen.TASKS)
    }

    // Setup --------------------------------------------------------------

    private fun settingsScreen(): View {
        val column = page("connect", "Private sync through your Tailscale network")
        column.addView(infoCard("①", "Connect Tailscale", "Install Tailscale on this phone and sign in to the same private network as your Mac."))
        column.addView(infoCard("②", "Pair TodoPup", "Scan the QR on Journal → Manage → Integrations, or enter the private Mac URL and device token."))
        column.addView(infoCard("③", "Keep capturing", "Entries and tasks save on your phone first, then sync when your Mac is reachable."))
        column.addView(sectionTitle("Mac connection"))
        val endpoint = input(MobileConfig.baseUrl(this), "https://your-mac.tailnet.ts.net")
        endpoint.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        val token = input(MobileConfig.token(this), "Device token").apply { inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD }
        column.addView(endpoint); column.addView(token)
        column.addView(action("Save connection", true) {
            runCatching { MobileConfig.save(this, endpoint.text.toString(), token.text.toString()) }
                .onSuccess { toast("Connection saved"); show(Screen.SETTINGS) }
                .onFailure { toast(it.message ?: "Use the HTTPS Tailscale address") }
        }, LinearLayout.LayoutParams(-1, dp(52)).apply { topMargin = dp(8) })
        val configured = MobileConfig.isConfigured(this)
        column.addView(label(if (configured) "●  Ready to sync through Tailscale" else "○  Not connected yet", if (configured) green else muted, 13f).apply { setPadding(0, dp(12), 0, dp(12)) })
        column.addView(sectionTitle("Phone usage sync"))
        column.addView(label("Optional · sends Android screen-time totals to your journal.", muted, 12f).apply { setPadding(0, 0, 0, dp(8)) })
        val usageEndpoint = input(Config.getEndpoint(this), "Usage ingest URL from TodoPup")
        val usageToken = input(Config.getToken(this), "Usage ingest token").apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        }
        column.addView(usageEndpoint); column.addView(usageToken)
        column.addView(action("Save usage connection") {
            Config.save(this, usageEndpoint.text.toString(), usageToken.text.toString()); toast("Usage connection saved")
        }, LinearLayout.LayoutParams(-1, dp(48)))
        column.addView(action("Grant usage access") { startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS)) }, LinearLayout.LayoutParams(-1, dp(48)))
        column.addView(action("Send usage now") { sendTestNow() }, LinearLayout.LayoutParams(-1, dp(48)).apply { topMargin = dp(8) })
        val last = Config.getLastPush(this)
        column.addView(label(Config.getStatus(this) + if (last.isBlank()) "" else "\nLast push: $last", muted, 12f).apply { setPadding(0, dp(12), 0, 0) })
        return scroll(column)
    }

    private fun handleConfigDeepLink(intent: Intent?) {
        val data: Uri = intent?.data ?: return
        if (data.scheme != "todopup" || data.host != "config") return
        val url = data.getQueryParameter("base_url") ?: data.getQueryParameter("url")
        val enrollment = data.getQueryParameter("enrollment_token")
        val token = data.getQueryParameter("token")
        if (!url.isNullOrBlank() && !enrollment.isNullOrBlank()) {
            MobileEnrollmentWorker.enqueue(this, url, enrollment)
            toast("Pairing with your Mac…")
        } else if (!url.isNullOrBlank() && !token.isNullOrBlank()) {
            if (url.trimEnd('/').endsWith("/integrations/phone/ingest")) {
                Config.save(this, url, token); toast("Phone usage sync paired")
            } else runCatching { MobileConfig.save(this, url, token) }
                .onSuccess { toast("TodoPup paired with your Mac"); MobileSyncScheduler.enqueue(this) }
                .onFailure { toast("The pairing URL must use Tailscale HTTPS") }
        }
    }

    private fun sendTestNow() {
        if (!Config.isConfigured(this)) { toast("Connect your Mac first"); return }
        WorkManager.getInstance(this).enqueue(OneTimeWorkRequestBuilder<UsagePushWorker>().setConstraints(networkConstraints()).build())
        toast("Usage sync queued")
    }

    private fun schedulePeriodic() {
        val work = PeriodicWorkRequestBuilder<UsagePushWorker>(1, TimeUnit.DAYS).setConstraints(networkConstraints()).build()
        WorkManager.getInstance(this).enqueueUniquePeriodicWork("daily-usage-push", ExistingPeriodicWorkPolicy.KEEP, work)
    }

    private fun networkConstraints() = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    // Theme helpers ------------------------------------------------------

    private fun page(title: String, subtitle: String) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL; setPadding(dp(18), dp(18), dp(18), dp(28))
        val brand = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        brand.addView(ImageView(this@MainActivity).apply { setImageResource(R.drawable.pompom_icon); contentDescription = "TodoPup"; scaleType = ImageView.ScaleType.CENTER_CROP }, LinearLayout.LayoutParams(dp(48), dp(48)))
        val words = LinearLayout(this@MainActivity).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(10), 0, 0, 0) }
        words.addView(label(title, accent, 22f).apply { typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD) })
        words.addView(label(subtitle, muted, 11f))
        brand.addView(words)
        addView(brand, LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(15) })
    }

    private fun scroll(child: View) = ScrollView(this).apply { isFillViewport = true; addView(child, ViewGroup.LayoutParams(-1, -2)) }
    private fun label(value: String, color: Int = text, size: Float = 14f) = TextView(this).apply {
        text = value; setTextColor(color); textSize = size; typeface = Typeface.MONOSPACE; gravity = Gravity.CENTER_VERTICAL
    }
    private fun sectionTitle(value: String) = label(value.uppercase(), accent, 12f).apply { typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD); setPadding(0, dp(18), 0, dp(8)) }
    private fun input(value: String, hintText: String, multiline: Boolean = false) = EditText(this).apply {
        setText(value); hint = hintText; setTextColor(this@MainActivity.text); setHintTextColor(muted); textSize = 14f; typeface = Typeface.MONOSPACE
        setPadding(dp(13)); background = box(panel, (if (multiline) TodoPupUi.TEXTAREA_RADIUS_DP else TodoPupUi.CONTROL_RADIUS_DP).toFloat(), border); minHeight = dp(50)
        if (multiline) { gravity = Gravity.TOP; minLines = 3 }
        layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(9) }
    }
    private fun action(value: String, selected: Boolean = false, click: () -> Unit) = TextView(this).apply {
        text = value; setTextColor(if (selected) bg else accent); textSize = 13f; typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD)
        gravity = Gravity.CENTER; minWidth = dp(44); minHeight = dp(44); isClickable = true; isFocusable = true
        background = box(if (selected) accent else panel, TodoPupUi.CONTROL_RADIUS_DP.toFloat(), if (selected) accent else border); setOnClickListener { click() }
    }

    private fun recordButton(click: () -> Unit) = FrameLayout(this).apply {
        contentDescription = "Record voice"
        isClickable = true
        isFocusable = true
        foreground = selectableItemBackgroundBorderless()
        background = oval(panel, border)
        addView(View(this@MainActivity).apply {
            background = oval(muted, muted, 0)
        }, FrameLayout.LayoutParams(dp(TodoPupUi.RECORD_DOT_DP), dp(TodoPupUi.RECORD_DOT_DP), Gravity.CENTER))
        setOnClickListener { click() }
    }
    private fun emptyState(value: String) = label(value, muted, 13f).apply { gravity = Gravity.CENTER; setPadding(dp(18)); background = box(panel, 12f, border) }
    private fun infoCard(mark: String, title: String, body: String): View {
        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; setPadding(dp(12)); background = box(panel, 12f, border) }
        row.addView(label(mark, accent, 20f), LinearLayout.LayoutParams(dp(42), dp(48)))
        val copy = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        copy.addView(label(title, text, 14f).apply { typeface = Typeface.create(Typeface.MONOSPACE, Typeface.BOLD) })
        copy.addView(label(body, muted, 12f).apply { setPadding(0, dp(3), 0, 0) })
        row.addView(copy, LinearLayout.LayoutParams(0, -2, 1f))
        row.layoutParams = LinearLayout.LayoutParams(-1, -2).apply { bottomMargin = dp(8) }
        return row
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
    private fun themedDialog(title: String, view: View, positive: String, onPositive: () -> Unit) {
        val dialog = AlertDialog.Builder(this).setTitle(title).setView(view).setNegativeButton("Cancel", null).setPositiveButton(positive) { _, _ -> onPositive() }.create()
        dialog.setOnShowListener {
            dialog.window?.decorView?.setBackgroundColor(panel)
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setTextColor(accent); dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setTextColor(muted)
        }; dialog.show()
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
