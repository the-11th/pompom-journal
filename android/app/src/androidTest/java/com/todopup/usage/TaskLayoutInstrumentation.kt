package com.todopup.usage

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Bundle
import android.view.View
import android.widget.CheckBox
import android.widget.EditText
import android.widget.TextView
import java.io.File

/** Exercise real task controls with disposable records, never the user's outbox. */
class TaskLayoutInstrumentation : Instrumentation() {
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
            val records = mutableListOf(
                TaskDraft("active", "Plan the weekend", notes = "Leave a little room to rest.",
                    tags = listOf("home"), subtasks = listOf(SubtaskDraft("Choose a walk", false))),
                TaskDraft("long", "Review the notes and choose the next small step for the coming week"),
                TaskDraft("done", "Water the plants", done = true, status = "completed"),
                TaskDraft("expired", "Weekly review", status = "expired"),
            )
            val writes = mutableListOf<TaskDraft>()
            MobileRepositoryProvider.factory = { context ->
                object : MobileRepository by OutboxMobileRepository(context) {
                    override fun tasks() = records.toList()
                    override fun taskConflicts() = emptyList<TaskConflict>()
                    override fun saveTask(task: TaskDraft, before: TaskDraft?) {
                        check(before == records.find { it.id == task.id })
                        writes.add(task)
                        records.removeAll { it.id == task.id }; records.add(task)
                    }
                    override fun saveTasks(tasks: List<TaskDraft>) = error("Unexpected bulk write")
                    override fun deleteTask(task: TaskDraft) = error("Unexpected deletion")
                }
            }
            val current = startActivitySync(Intent(targetContext, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
            activity = current
            fun <T : View> view(tag: String): T =
                requireNotNull(current.findViewById<View>(android.R.id.content).findViewWithTag<T>(tag)) { "Missing $tag" }
            fun onMain(block: () -> Unit) {
                var error: Throwable? = null
                runOnMainSync { error = runCatching(block).exceptionOrNull() }
                error?.let { throw it }
                waitForIdleSync()
            }
            fun capture(name: String) = onMain {
                val root = current.window.decorView
                val bitmap = Bitmap.createBitmap(root.width, root.height, Bitmap.Config.ARGB_8888)
                root.draw(Canvas(bitmap))
                File(targetContext.cacheDir, name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                bitmap.recycle()
            }
            waitForIdleSync()
            onMain {
                check(view<View>("task-completed-list").visibility == View.GONE) { "Completed tasks must start collapsed" }
                check(view<TextView>("task-completed-toggle").text.contains("1"))
                check(view<CheckBox>("task-check:active") is TagCheckBox) { "Use the journal's circle control" }
                check(view<CheckBox>("task-check:expired").isEnabled.not())
                val toggle = view<TextView>("task-completed-toggle")
                check((0 until toggle.layout.lineCount).all { toggle.layout.getEllipsisCount(it) == 0 }) {
                    "The completed dropdown label must fit at larger text sizes"
                }
                view<EditText>("task-quick-add").setText("Keep this unfinished idea")
            }
            capture("tasks-collapsed.png")
            onMain {
                view<View>("task-completed-toggle").performClick()
                check(view<View>("task-completed-list").visibility == View.VISIBLE)
                check(view<TextView>("task-completed-toggle").contentDescription.contains("Collapse"))
                check(writes.isEmpty()) { "Opening a dropdown must not mutate tasks" }
                check(view<EditText>("task-quick-add").text.toString() == "Keep this unfinished idea")
            }
            capture("tasks-expanded.png")
            onMain {
                view<CheckBox>("task-check:done").performClick()
                check(writes.last().status == "active" && !writes.last().done)
                view<CheckBox>("task-check:active").performClick()
                check(writes.last().status == "completed" && writes.last().done)
                check(view<View>("task-completed-list").visibility == View.VISIBLE) { "Keep the dropdown open after a task action" }
                view<View>("task-completed-toggle").performClick()
                (current as MainActivity).mediaOpenTask("active")
                check(view<View>("task-completed-list").visibility == View.VISIBLE) { "Journal links must reveal completed tasks" }
                val saved = Bundle()
                callActivityOnSaveInstanceState(current, saved)
                check(saved.getBoolean("tasks_completed_expanded")) { "Keep expansion state across recreation" }
                check(saved.getString("task_quick_add") == "Keep this unfinished idea")
                check(view<EditText>("task-quick-add").text.toString() == "Keep this unfinished idea")
                records.clear()
                current.mediaOpenTask("missing")
                check(view<TextView>("task-completed-toggle").text.contains("0"))
                view<View>("task-completed-toggle").performClick()
                check(view<View>("task-completed-list").visibility == View.GONE)
            }
            capture("tasks-empty.png")
            result.putString("result", "PASS: collapsed history, expand/collapse, completion, reopening, journal links, and retained draft")
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
