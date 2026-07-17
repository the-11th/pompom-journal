package com.todopup.usage

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** Shared cache format consumed by [OutboxMobileRepository]. */
internal class MobileCache(context: Context) {
    private val prefs = context.getSharedPreferences("todopup_mobile_ui", Context.MODE_PRIVATE)

    fun saveConfig(config: MobileJournalConfig) {
        val sections = JSONArray().also { array -> config.sections.forEach { section ->
            array.put(JSONObject().put("id", section.id).put("name", section.name)
                .put("type", section.type).put("color", section.color).put("unit", section.unit)
                .put("tags", JSONArray(section.tags))
                .put("mention_tags", JSONArray(section.mentionTags)))
        }}
        prefs.edit().putString(KEY_SECTIONS, JSONObject().put("sections", sections).toString()).apply()
    }

    fun saveTasks(tasks: List<MobileTask>) {
        val array = JSONArray().also { out -> tasks.forEach { task ->
            out.put(JSONObject().put("id", task.id).put("title", task.title)
                .put("due", task.due ?: JSONObject.NULL).put("tags", JSONArray(task.tags))
                .put("notes", task.notes).put("done", task.done)
                .put("subtasks", JSONArray().also { subs -> task.subtasks.forEach {
                    subs.put(JSONObject().put("text", it.text).put("done", it.done))
                }}))
        }}
        prefs.edit().putString(KEY_TASKS, array.toString()).apply()
    }

    private companion object { const val KEY_TASKS = "tasks_v1"; const val KEY_SECTIONS = "sections_v1" }
}
