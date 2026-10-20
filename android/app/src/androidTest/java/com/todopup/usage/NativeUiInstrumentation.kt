package com.todopup.usage

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.os.Bundle
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import java.util.concurrent.CopyOnWriteArrayList

/** Real native interactions against an in-memory repository, on an unpaired QA app only. */
class NativeUiInstrumentation : Instrumentation() {
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }

    override fun callActivityOnCreate(activity: Activity, savedInstanceState: Bundle?) {
        // Task editing uses only the fake repository; the final dialog check reads the QA journal.
        val state = if (activity is MainActivity) Bundle(savedInstanceState ?: Bundle()).apply {
            putString("screen", "TASKS")
        } else savedInstanceState
        super.callActivityOnCreate(activity, state)
    }

    override fun onStart() {
        val result = Bundle()
        val previousFactory = MobileRepositoryProvider.factory
        val previousUsageStatus = Config.getStatus(targetContext)
        val previousUsagePush = Config.getLastPush(targetContext)
        var activity: Activity? = null
        var gallery: PhotoGalleryDialog? = null
        var successful = false
        try {
            check(targetContext.packageName == "com.todopup.usage.qa") { "Native interaction checks require the QA app" }
            check(!MobileConfig.isConfigured(targetContext)) { "Native interaction checks require an unpaired QA app" }
            UsageUploadChecks.run()
            val repository = FakeRepository()
            MobileRepositoryProvider.factory = { repository }
            activity = startActivitySync(Intent(targetContext, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
            waitForIdleSync()
            click("Tasks")
            check(requireNode("Tasks").className == "android.widget.Button") { "Native navigation must expose button semantics" }
            runOnMainSync { callActivityOnNewIntent(activity, Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)) }
            requireNode("New task title")
            click("Connect")
            requireNode("Photos & places settings")
            assertTextFits("Photos & places settings")
            runOnMainSync { Config.setStatus(targetContext, "QA usage status updated", "") }
            requireNode("QA usage status updated")
            click("Tasks")
            runOnMainSync { Config.setStatus(targetContext, "QA usage status while away", "") }
            click("Connect")
            requireNode("QA usage status while away")
            runOnMainSync {
                MainActivity::class.java.getMethod("mediaOpenTask", String::class.java).invoke(activity, "expired")
            }
            val openedTask = requireNode("Expired example")
            check(openedTask.isVisibleToUser && openedTask.isFocused) { "A journal task link must reveal and focus its native card" }
            click("Tasks")
            var navigationFailure: Throwable? = null
            runOnMainSync { navigationFailure = runCatching {
                fun inspect(view: android.view.View) {
                    if (view is android.widget.TextView && view.text.toString() in listOf("Journal", "Tasks", "Connect", "Edit")) {
                        val layout = requireNotNull(view.layout)
                        check((0 until layout.lineCount).all { layout.getEllipsisCount(it) == 0 }) {
                            "Native action label is clipped: ${view.text}"
                        }
                    }
                    if (view is android.widget.EditText && view.contentDescription == "New task title") {
                        check(view.height - view.compoundPaddingTop - view.compoundPaddingBottom >= view.paint.fontSpacing.toInt()) {
                            "New task input clips enlarged text vertically"
                        }
                    }
                    if (view is android.view.ViewGroup) for (index in 0 until view.childCount) inspect(view.getChildAt(index))
                }
                inspect(activity.findViewById(android.R.id.content))
            }.exceptionOrNull() }
            navigationFailure?.let { throw it }
            check(find("Edit task: Completed example") == null && find("Edit task: Expired example") == null)
            click("Expand completed tasks · 1")
            check(!requireNode("Subtask Completed subtask").isEnabled)
            check(!requireNode("Subtask Expired subtask").isEnabled)

            click("Edit task: Review spacing")
            requireNode("Edit task")
            setText("Original notes", "Updated notes")
            setText("Review spacing", "")
            click("Save")
            requireNode("Add a task title.")
            check(repository.saved.isEmpty()) { "Blank task title was saved" }
            requireNode("Updated notes")
            capture("native-task-validation")
            setText("Task title", "Review margins")
            click("Save")
            await { repository.saved.size == 1 }
            val edited = repository.saved.last()
            check(edited.first.title == "Review margins" && edited.first.notes == "Updated notes")
            check(edited.first.due == "2026-09-10T14:30:00+08:00") { "Editing notes changed the due time" }
            check(edited.second?.title == "Review spacing") { "Task edit did not carry its displayed baseline" }

            click("Complete Review margins")
            await { repository.saved.size == 2 }
            check(repository.saved.last().first.done)
            click("Review margins completed")
            await { repository.saved.size == 3 }
            check(!repository.saved.last().first.done)

            setText("New task title", "Synthetic task")
            click("Create task")
            click("Task due date")
            check(requireNode(java.time.LocalDate.now().withDayOfMonth(15).toString()).className == "android.widget.Button") {
                "Calendar dates must expose button semantics"
            }
            capture("native-calendar")
            if (android.os.Build.VERSION.SDK_INT >= 29) {
                var calendarFailure: Throwable? = null
                runOnMainSync { calendarFailure = runCatching {
                    val month = java.time.LocalDate.now().format(java.time.format.DateTimeFormatter.ofPattern("MMMM yyyy", java.util.Locale.getDefault()))
                    var found = false
                    fun inspect(view: android.view.View) {
                        if (view is android.widget.TextView && (view.text.toString() == month || view.contentDescription == month)) {
                            found = true
                            check(view.layout.height <= view.height - view.compoundPaddingTop - view.compoundPaddingBottom) {
                                "Calendar month and year are clipped"
                            }
                        }
                        if (view is android.view.ViewGroup) for (index in 0 until view.childCount) inspect(view.getChildAt(index))
                    }
                    android.view.inspector.WindowInspector.getGlobalWindowViews().forEach(::inspect)
                    check(found) { "Calendar month label is missing" }
                }.exceptionOrNull() }
                calendarFailure?.let { throw it }
            }
            click(java.time.LocalDate.now().withDayOfMonth(15).toString())
            click("Clear task due date")
            click("Add task")
            await { repository.saved.size == 4 }
            check(repository.saved.last().first.due == null && repository.saved.last().second == null)

            repository.failNextSave = true
            click("Edit task: Synthetic task")
            setText("Synthetic task", "Retained draft")
            click("Save")
            requireNode("Could not save")
            click("Done")
            requireNode("Retained draft")
            click("Save")
            await { repository.saved.size == 5 }
            check(repository.saved.last().first.title == "Retained draft")

            val local = repository.tasks().first { it.id == "active" }.copy(title = "Phone title")
            val remote = local.copy(title = "Mac title")
            repository.conflicts.add(TaskConflict("conflict-apply", "update", local, remote,
                listOf("title"), "Title changed on Mac"))
            click("Tasks")
            click("Review task conflict: Phone title")
            requireNode("Phone title"); requireNode("Mac title")
            capture("native-task-conflict")
            click("Cancel")
            check(repository.resolutions.isEmpty()) { "Cancel resolved a task conflict" }
            click("Review task conflict: Phone title")
            click("Keep phone edits")
            await { repository.resolutions.size == 1 }
            check(repository.resolutions.last() == ("conflict-apply" to true))

            repository.conflicts.add(TaskConflict("conflict-copy", "update", local, null,
                listOf("title"), "Task deleted on Mac", "copy"))
            click("Tasks")
            click("Review task conflict: Phone title")
            requireNode("Save phone copy as new task")
            capture("native-task-copy")
            click("Use Mac")
            await { repository.resolutions.size == 2 }
            check(repository.resolutions.last() == ("conflict-copy" to false))

            repository.conflicts.add(TaskConflict("conflict-reopen", "update", local,
                remote.copy(done = true, status = "completed"), listOf("title", "done"), "Task completed on Mac", "reopen"))
            click("Tasks")
            click("Review task conflict: Phone title")
            requireNode("Reopen with phone edits")
            capture("native-task-reopen")
            click("Cancel")
            check(repository.resolutions.size == 2)
            val voiceTags = mutableMapOf<String, MutableList<String>>()
            var voiceAccepted = false
            lateinit var voiceBody: android.widget.EditText
            runOnMainSync {
                voiceBody = android.widget.EditText(activity).apply { setText("Before "); setSelection(length()) }
                val review = MainActivity::class.java.declaredMethods.single { it.name == "reviewDictation" }
                review.isAccessible = true
                review.invoke(activity, "A quiet walk, tag sunrise stretch.",
                    listOf(JournalSection("people", "people", "tag", "#e0a955")), voiceTags, voiceBody,
                    { voiceAccepted = true })
            }
            requireNode("Review dictation")
            requireNode("sunrise stretch")
            capture("native-dictation-review")
            assertTextFits("Keep words")
            click("Choose section for sunrise stretch")
            click("people")
            click("Keep words")
            click("Accept")
            check(voiceAccepted && voiceTags.isEmpty())
            check(voiceBody.text.toString().contains("tag sunrise stretch"))
            runOnMainSync {
                gallery = PhotoGalleryDialog(activity, {}, {}, {}).also { it.show() }
            }
            requireNode("Photo gallery"); requireNode("Cancel")
            check(requireNode("Cancel").className == "android.widget.Button") { "Gallery actions must expose button semantics" }
            capture("native-gallery-portrait")
            runOnMainSync {
                activity.requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
            }
            await { targetContext.resources.displayMetrics.widthPixels > targetContext.resources.displayMetrics.heightPixels }
            SystemClock.sleep(500) // Android's rotation animation outlasts the accessibility layout update.
            capture("native-gallery-landscape")
            requireNode("Photo gallery")
            val cancel = requireNode("Cancel")
            val bounds = android.graphics.Rect().also { cancel.getBoundsInScreen(it) }
            check(cancel.isVisibleToUser && bounds.height() > 0 && bounds.top >= 0 &&
                bounds.bottom <= targetContext.resources.displayMetrics.heightPixels) {
                "Gallery Cancel is offscreen after rotation: $bounds"
            }
            click("Cancel")
            click("Journal")
            await { javascript(activity, "Boolean(window.PupJournalEditor)") == "true" }
            javascript(activity, "window.qaDialog=PupMedia.dialog('QA parent draft')")
            await { !requireNode("Tasks").isEnabled }
            val dialogEditor = MainActivity::class.java.getDeclaredField("mediaJournal").apply { isAccessible = true }.get(activity)
            for (host in listOf("config", "usage", "sync")) {
                runOnMainSync { MainActivity::class.java.getDeclaredMethod("onNewIntent", android.content.Intent::class.java).apply { isAccessible = true }
                    .invoke(activity, android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse("todopup-qa://$host"))) }
                check(MainActivity::class.java.getDeclaredField("mediaJournal").apply { isAccessible = true }.get(activity) === dialogEditor) {
                    "A USB $host intent must preserve the open journal dialog"
                }
            }
            javascript(activity, "window.qaChild=PupMedia.dialog('QA nested edit');qaChild.setBusy(true)")
            sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK)
            check(javascript(activity, "document.querySelectorAll('.media-overlay').length") == "2")
            check(!requireNode("Tasks").isEnabled) { "A pending dialog save must keep native navigation disabled" }
            javascript(activity, "qaChild.setBusy(false)")
            sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK)
            await { javascript(activity, "document.querySelectorAll('.media-overlay').length") == "1" }
            check(!requireNode("Tasks").isEnabled) { "Closing a child must not unlock native navigation" }
            javascript(activity, "window.qaInvalid=[];for(const body of [null,{open:'true'},[]])PupMedia.request('dialog-state',body).then(()=>qaInvalid.push(200)).catch(e=>qaInvalid.push(e.status))")
            await { javascript(activity, "qaInvalid.length") == "3" }
            check(javascript(activity, "qaInvalid.every(status=>status===400)") == "true") { "Dialog state rejects malformed bridge payloads" }
            check(!requireNode("Tasks").isEnabled)
            sendKeyDownUpSync(android.view.KeyEvent.KEYCODE_BACK)
            await { requireNode("Tasks").isEnabled }
            check(javascript(activity, "document.querySelectorAll('.media-overlay').length") == "0")
            val staleEditor = MainActivity::class.java.getDeclaredField("mediaJournal").apply { isAccessible = true }.get(activity) as MediaJournalView
            runOnMainSync { MainActivity::class.java.getDeclaredMethod("onNewIntent", android.content.Intent::class.java).apply { isAccessible = true }
                .invoke(activity, android.content.Intent(android.content.Intent.ACTION_VIEW, android.net.Uri.parse("todopup-qa://sync"))) }
            requireNode("USB CONNECTION")
            click("Tasks")
            runOnMainSync { (activity as MainActivity).mediaDialogState(staleEditor, true) }
            check(requireNode("Tasks").isEnabled) { "A detached journal must not change native navigation" }
            NativeWebLayoutChecks.run(this, activity)
            successful = true
            result.putString("stream", "Native QA interactions passed: launcher retention, task validation, due preservation/clear, completion/reopen, failed-save recovery, conflict decisions, dictation review, and gallery rotation.\n")
        } catch (error: Throwable) {
            runCatching { uiAutomation.takeScreenshot()?.let { bitmap ->
                java.io.File(targetContext.cacheDir, "native-ui-failure.png").outputStream().use {
                    bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
                }
            } }
            result.putString("stream", error.stackTraceToString())
        } finally {
            runOnMainSync {
                gallery?.dismiss()
                activity?.requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
            }
            activity?.let { opened -> runOnMainSync { opened.finish() } }
            MobileRepositoryProvider.factory = previousFactory
            Config.setStatus(targetContext, previousUsageStatus, previousUsagePush)
        }
        finish(if (successful) Activity.RESULT_OK else Activity.RESULT_CANCELED, result)
    }

    private fun assertTextFits(value: String) {
        var failure: Throwable? = null
        runOnMainSync { failure = runCatching {
            var found = false
            fun inspect(view: android.view.View) {
                if (view is android.widget.TextView && (view.text.toString() == value || view.contentDescription == value)) {
                    found = true
                    val layout = requireNotNull(view.layout)
                    val available = view.width - view.compoundPaddingLeft - view.compoundPaddingRight
                    check((0 until layout.lineCount).all { layout.getEllipsisCount(it) == 0 && layout.getLineWidth(it) <= available + 1 }) {
                        "Action text exceeds its visible width: $value"
                    }
                    check(layout.height <= view.height - view.compoundPaddingTop - view.compoundPaddingBottom + 1) {
                        "Action text exceeds its visible height: $value"
                    }
                }
                if (view is android.view.ViewGroup) for (index in 0 until view.childCount) inspect(view.getChildAt(index))
            }
            android.view.inspector.WindowInspector.getGlobalWindowViews().forEach(::inspect)
            check(found) { "Missing native label: $value" }
        }.exceptionOrNull() }
        failure?.let { throw it }
    }

    private fun javascript(activity: Activity, script: String): String {
        val done = java.util.concurrent.CountDownLatch(1)
        var value = ""
        runOnMainSync {
            val field = MainActivity::class.java.getDeclaredField("mediaJournal").apply { isAccessible = true }
            val editor = field.get(activity) as MediaJournalView
            val web = MediaJournalView::class.java.getDeclaredField("web").apply { isAccessible = true }.get(editor) as android.webkit.WebView
            web.evaluateJavascript(script) { value = it; done.countDown() }
        }
        check(done.await(5, java.util.concurrent.TimeUnit.SECONDS)) { "QA WebView callback timed out" }
        return value
    }

    private fun find(value: String, editableOnly: Boolean = false, clickableOnly: Boolean = false): AccessibilityNodeInfo? {
        fun search(node: AccessibilityNodeInfo?, descriptionOnly: Boolean): AccessibilityNodeInfo? {
            if (node == null) return null
            if ((!editableOnly || node.isEditable) && (!clickableOnly || node.isClickable) &&
                (node.contentDescription?.toString() == value ||
                    !descriptionOnly && (node.text?.toString() == value || node.text?.lines()?.contains(value) == true))) return node
            for (index in 0 until node.childCount) search(node.getChild(index), descriptionOnly)?.let { return it }
            return null
        }
        // A screen heading may share its text with a navigation button.
        return search(uiAutomation.rootInActiveWindow, true) ?: search(uiAutomation.rootInActiveWindow, false)
    }

    private fun capture(name: String) {
        runCatching { uiAutomation.waitForIdle(150, 2000) }
        SystemClock.sleep(300) // Allow the new dialog surface to reach the screenshot compositor.
        uiAutomation.takeScreenshot()?.let { bitmap ->
            java.io.File(targetContext.cacheDir, "$name.png").outputStream().use {
                bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
            }
        }
    }

    private fun requireNode(value: String, editableOnly: Boolean = false, clickableOnly: Boolean = false): AccessibilityNodeInfo {
        var found: AccessibilityNodeInfo? = null
        await { find(value, editableOnly, clickableOnly).also { found = it } != null }
        return requireNotNull(found) { "Missing native control: $value" }
    }

    private fun click(value: String) {
        check(requireNode(value, clickableOnly = true).performAction(AccessibilityNodeInfo.ACTION_CLICK)) { "Cannot click $value" }
        runCatching { uiAutomation.waitForIdle(150, 2000) }
    }

    private fun setText(value: String, replacement: String) {
        val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, replacement) }
        check(requireNode(value, editableOnly = true).performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) { "Cannot edit $value" }
        runCatching { uiAutomation.waitForIdle(150, 2000) }
    }

    private fun await(condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + 5000
        while (!condition()) {
            check(SystemClock.uptimeMillis() < deadline) { "Native interaction timed out" }
            SystemClock.sleep(50)
        }
    }

    private class FakeRepository : MobileRepository {
        val saved = CopyOnWriteArrayList<Pair<TaskDraft, TaskDraft?>>()
        val resolutions = CopyOnWriteArrayList<Pair<String, Boolean>>()
        val conflicts = CopyOnWriteArrayList<TaskConflict>()
        @Volatile var failNextSave = false
        private val records = CopyOnWriteArrayList(listOf(
            TaskDraft("active", "Review spacing", due = "2026-09-10T14:30:00+08:00", notes = "Original notes"),
            TaskDraft("completed", "Completed example", done = true, status = "completed", subtasks = listOf(SubtaskDraft("Completed subtask", true))),
            TaskDraft("expired", "Expired example", status = "expired", subtasks = listOf(SubtaskDraft("Expired subtask", false))),
        ))
        override fun tasks(): List<TaskDraft> = records.toList()
        override fun saveTask(task: TaskDraft, before: TaskDraft?) {
            if (failNextSave) { failNextSave = false; error("Synthetic save failure") }
            saved.add(task to before); records.removeAll { it.id == task.id }; records.add(task)
        }
        override fun saveTasks(tasks: List<TaskDraft>) = error("UI must save only the changed task")
        override fun deleteTask(task: TaskDraft) { records.removeAll { it.id == task.id } }
        override fun taskConflicts(): List<TaskConflict> = conflicts.toList()
        override fun resolveTaskConflict(requestId: String, keepPhone: Boolean) {
            resolutions.add(requestId to keepPhone); conflicts.removeAll { it.requestId == requestId }
        }
        override fun journal(date: String) = JournalSnapshot(JournalDraft(date))
        override fun entryDates(): Set<String> = emptySet()
        override fun saveJournalDraft(draft: JournalDraft) = JournalSnapshot(draft)
        override fun saveJournal(draft: JournalDraft): SaveResult = SaveResult.Saved(JournalSnapshot(draft))
        override fun resolveJournalConflict(date: String, keepPhone: Boolean): SaveResult = SaveResult.Failed("No journal conflict")
        override fun addJournalTag(sectionId: String, name: String) = Unit
    }
}
