package com.todopup.usage

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.EditText
import android.widget.TextView
import java.time.Instant

/** Countdown lifecycle checks against disposable tasks in the unpaired QA app. */
class TaskCountdownInstrumentation : Instrumentation() {
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }

    override fun callActivityOnCreate(activity: Activity, savedInstanceState: Bundle?) {
        super.callActivityOnCreate(activity, Bundle(savedInstanceState ?: Bundle()).apply { putString("screen", "TASKS") })
    }

    override fun onStart() {
        val previousFactory = MobileRepositoryProvider.factory
        var activity: Activity? = null
        val result = Bundle()
        var success = false
        try {
            check(targetContext.packageName == "com.todopup.usage.qa" && !MobileConfig.isConfigured(targetContext))
            val now = Instant.now()
            val records = listOf(
                TaskDraft("hours", "Review tomorrow", due = now.plusSeconds(129660).toString()),
                TaskDraft("boundary", "Two-day boundary", due = now.plusSeconds(172815).toString()),
                TaskDraft("resume", "Resume countdown", due = now.plusSeconds(5).toString()),
                TaskDraft("tick", "Automatic countdown", due = now.plusSeconds(15).toString()),
                TaskDraft("completed", "Completed example", due = now.toString(), done = true, status = "completed"),
            )
            MobileRepositoryProvider.factory = { object : MobileRepository {
                override fun tasks() = records
                override fun saveTask(task: TaskDraft, before: TaskDraft?) = error("Countdown must not save tasks")
                override fun saveTasks(tasks: List<TaskDraft>) = error("Countdown must not save tasks")
                override fun deleteTask(task: TaskDraft) = error("Countdown must not delete tasks")
                override fun taskConflicts() = emptyList<TaskConflict>()
                override fun resolveTaskConflict(requestId: String, keepPhone: Boolean) = Unit
                override fun journal(date: String) = JournalSnapshot(JournalDraft(date))
                override fun entryDates() = emptySet<String>()
                override fun saveJournalDraft(draft: JournalDraft) = error("Countdown must not write journals")
                override fun saveJournal(draft: JournalDraft): SaveResult = error("Countdown must not write journals")
                override fun resolveJournalConflict(date: String, keepPhone: Boolean): SaveResult = error("No conflicts")
                override fun addJournalTag(sectionId: String, name: String) = Unit
            } }
            val current = startActivitySync(Intent(targetContext, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
            activity = current
            fun label(id: String) = current.findViewById<View>(android.R.id.content).findViewWithTag<TextView>("task-due:$id")
            fun checkMain(block: () -> Unit) {
                var error: Throwable? = null
                runOnMainSync { error = runCatching(block).exceptionOrNull() }
                error?.let { throw it }
            }
            lateinit var draft: EditText
            lateinit var tickingLabel: TextView
            checkMain {
                fun findDraft(view: View): EditText? {
                    if (view is EditText && view.contentDescription == "New task title") return view
                    if (view is ViewGroup) for (index in 0 until view.childCount) findDraft(view.getChildAt(index))?.let { return it }
                    return null
                }
                draft = requireNotNull(findDraft(current.findViewById(android.R.id.content)))
                draft.setText("Keep this unfinished task")
                tickingLabel = label("tick")
                check(label("hours").text.endsWith("36 hour(s) left"))
                check(label("boundary").text.endsWith("2 day(s) left"))
                check(label("resume").text.endsWith("due soon"))
                callActivityOnPause(current)
            }
            SystemClock.sleep(5500)
            checkMain {
                callActivityOnResume(current)
                check(label("resume").text.endsWith(" · overdue")) { "Resume did not update the overdue badge" }
                check(label("resume").currentTextColor == Color.parseColor(DatapomUi.DANGER))
                check(tickingLabel.text.endsWith("due soon"))
            }
            // Let the production timer fire while the activity stays on Tasks.
            SystemClock.sleep(31_000)
            checkMain {
                check(label("tick") === tickingLabel) { "Timer replaced the task card" }
                check(tickingLabel.text.endsWith(" · overdue")) { "Visible countdown did not tick" }
                check(tickingLabel.currentTextColor == Color.parseColor(DatapomUi.DANGER))
                check(label("boundary").text.endsWith("47 hour(s) left"))
                check(!label("completed").text.contains("overdue"))
                check(draft.text.toString() == "Keep this unfinished task")
            }
            uiAutomation.takeScreenshot()?.let { bitmap ->
                java.io.File(targetContext.cacheDir, "task-countdown.png").outputStream().use {
                    bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
                }
            }
            result.putString("result", "PASS: hours, automatic tick, resume, overdue color, completed tasks, and preserved draft")
            success = true
        } catch (error: Throwable) {
            result.putString("error", android.util.Log.getStackTraceString(error))
        } finally {
            activity?.let { runOnMainSync { it.finish() } }
            MobileRepositoryProvider.factory = previousFactory
        }
        finish(if (success) Activity.RESULT_OK else Activity.RESULT_CANCELED, result)
    }
}
