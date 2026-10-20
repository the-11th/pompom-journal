package com.todopup.usage

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** Shared cache format consumed by [OutboxMobileRepository]. */
internal class MobileCache(context: Context) {
    private val prefs = context.getSharedPreferences("todopup_mobile_ui", Context.MODE_PRIVATE)
    private val outbox = TaskOutbox(context)

    fun saveConfig(config: MobileJournalConfig) = synchronized(TaskOutbox.guard) {
        val sections = JSONArray().also { array -> config.sections.forEach { section ->
            array.put(JSONObject().put("id", section.id).put("name", section.name)
                .put("type", section.type).put("color", section.color).put("unit", section.unit)
                .put("managed", section.managed ?: JSONObject.NULL)
                .put("tags", JSONArray(section.tags)).apply { if (section.archiveStateKnown) put("archived_tags", JSONArray(section.archivedTags)) }
                .put("mention_tags", JSONArray(section.mentionTags)))
        }}
        check(prefs.edit().putString(KEY_SECTIONS, JSONObject().put("sections", sections)
            .put("entry_dates", JSONArray(config.entryDates))
            .put("stored_entry_dates", JSONArray(config.storedEntryDates))
            .put("empty_edit_revision", config.emptyEditRevision ?: JSONObject.NULL)
            .put("calendar_dates", JSONArray(config.calendarDates)).toString()).commit()) { "Could not save journal sections" }
        outbox.confirmJournalTags(config.sections)
    }

    fun saveTasks(tasks: List<MobileTask>) = synchronized(TaskOutbox.guard) {
        val array = JSONArray().also { out -> tasks.forEach { task ->
            out.put(MobileJson.task(task))
        }}
        check(prefs.edit().putString(KEY_TASKS, array.toString()).commit()) { "Could not save tasks" }
    }

    fun tasks(): List<MobileTask> = synchronized(TaskOutbox.guard) {
        val array = runCatching { JSONArray(prefs.getString(KEY_TASKS, "[]")) }
            .getOrDefault(JSONArray())
        (0 until array.length()).mapNotNull { index ->
            array.optJSONObject(index)?.let(MobileJson::task)
        }
    }

    /** Apply only acknowledged fields that the user has not changed again. */
    fun acknowledgeTask(sent: TaskMutation, server: MobileTask) = synchronized(TaskOutbox.guard) {
        if (outbox.all().none { it.requestId == sent.requestId }) return@synchronized
        val proposed = TaskMutationJson.snapshot(sent)
        val fields = TaskMutationJson.fields(sent)
        saveTasks(tasks().map { current ->
            if (current.id != server.id) current else TaskEdits.overlay(current, server,
                fields - TaskEdits.changedFields(proposed, current).toSet())
        })
        outbox.acknowledgeTask(sent, server)
    }

    /** Check again after the network response: edits may have arrived while it was in flight. */
    fun applyRemoteTasks(expected: List<MobileTask>, remote: List<MobileTask>): Boolean = synchronized(TaskOutbox.guard) {
        if (tasks() != expected || outbox.pending().isNotEmpty() || outbox.failed().isNotEmpty())
            return@synchronized false
        saveTasks(remote)
        true
    }

    private companion object { const val KEY_TASKS = "tasks_v1"; const val KEY_SECTIONS = "sections_v1" }
}
