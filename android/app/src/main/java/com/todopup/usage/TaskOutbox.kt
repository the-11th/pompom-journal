package com.todopup.usage

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

data class TaskMutation(
    val requestId: String = UUID.randomUUID().toString(),
    val taskId: String? = null,
    val operation: String,
    val payload: JSONObject,
    val permanentError: String? = null,
)

class TaskOutbox(context: Context) {
    private val prefs = context.getSharedPreferences("todopup_task_outbox", Context.MODE_PRIVATE)

    @Synchronized fun enqueue(mutation: TaskMutation): TaskMutation {
        // The API honors Android's client_id for creates, so later queued edits
        // and deletes safely target the same id even when all were made offline.
        val a = read().put(encode(mutation))
        check(prefs.edit().putString(KEY, a.toString()).commit()) { "Could not save task change" }
        return mutation
    }

    @Synchronized fun pending(): List<TaskMutation> = decodeAll().filter { it.permanentError == null }
    @Synchronized fun failed(): List<TaskMutation> = decodeAll().filter { it.permanentError != null }

    @Synchronized fun acknowledge(requestId: String) = write(JSONArray().also { out ->
        decodeAll().filterNot { it.requestId == requestId }.forEach { out.put(encode(it)) }
    })

    @Synchronized fun markFailed(requestId: String, message: String) = write(JSONArray().also { out ->
        decodeAll().forEach { out.put(encode(if (it.requestId == requestId) it.copy(permanentError = message) else it)) }
    })

    private fun decodeAll(): List<TaskMutation> {
        val all = read()
        return (0 until all.length()).mapNotNull { i ->
        all.optJSONObject(i)?.let { o ->
            TaskMutation(o.optString("request_id"), o.optString("task_id").takeIf(String::isNotBlank),
                o.optString("operation"), o.optJSONObject("payload") ?: JSONObject(),
                o.optString("permanent_error").takeIf(String::isNotBlank))
        }}
    }
    private fun encode(m: TaskMutation) = JSONObject().put("request_id", m.requestId)
        .put("task_id", m.taskId ?: JSONObject.NULL).put("operation", m.operation)
        .put("payload", m.payload).put("permanent_error", m.permanentError ?: JSONObject.NULL)
    private fun read() = runCatching { JSONArray(prefs.getString(KEY, "[]")) }.getOrDefault(JSONArray())
    private fun write(a: JSONArray) { check(prefs.edit().putString(KEY, a.toString()).commit()) }
    private companion object { const val KEY = "mutations_v1" }
}
