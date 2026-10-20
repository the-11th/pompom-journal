package com.todopup.usage

import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

sealed class ApiResult<out T> {
    data class Success<T>(val value: T, val status: Int) : ApiResult<T>()
    data class Conflict(val current: JSONObject, val message: String) : ApiResult<Nothing>()
    data class PermanentError(val status: Int, val message: String) : ApiResult<Nothing>()
    data class TransientError(val status: Int?, val message: String) : ApiResult<Nothing>()
}

/** Authenticated client for the ADB reverse loopback transport. */
class MobileApiClient(
    private val baseUrl: String,
    private val token: String,
    private val openConnection: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection },
) {
    init {
        MobileEndpoint.requireAllowed(baseUrl)
    }

    fun getConfig(): ApiResult<MobileJournalConfig> = request("GET", "/api/mobile/config") {
        it.getJSONArray("sections")
        it.getJSONArray("entry_dates")
        MobileJson.config(it)
    }

    fun getJournal(date: String): ApiResult<JournalDraft?> = request("GET", "/api/mobile/journal/${part(date)}") {
        if (!it.has("entry")) throw org.json.JSONException("Missing journal entry")
        if (it.isNull("entry")) return@request null
        readJournal(it.getJSONObject("entry"), date)
    }

    fun putJournal(draft: JournalDraft): ApiResult<JournalDraft> {
        val payload = MobileJson.draft(draft).apply {
            remove("modified_at"); remove("sync_state"); remove("sync_message"); remove("server_version")
        }
        return request("PUT", "/api/mobile/journal/${part(draft.date)}", payload,
            conflict = { readJournal(it, draft.date) }) { root ->
            readJournal(root.getJSONObject("entry"), draft.date).copy(requestId = draft.requestId)
        }
    }

    fun getTasks(): ApiResult<List<MobileTask>> = request("GET", "/api/mobile/tasks") {
        val array = it.getJSONArray("tasks")
        val tasks = (0 until array.length()).map { i -> readTask(array.getJSONObject(i)) }
        if (tasks.map { task -> task.id }.distinct().size != tasks.size) throw org.json.JSONException("Duplicate task identity")
        tasks
    }

    fun createTask(requestId: String, clientId: String?, title: String, due: String?, tags: List<String>,
                   notes: String, subtasks: JSONArray, done: Boolean, recurrence: String? = null,
                   difficulty: String? = null): ApiResult<MobileTask> =
        request("POST", "/api/mobile/tasks", JSONObject()
            .put("request_id", requestId).put("client_id", clientId ?: JSONObject.NULL).put("title", title)
            .put("due", due ?: JSONObject.NULL).put("tags", JSONArray(tags)).put("notes", notes)
            .put("subtasks", subtasks).put("done", done).put("recurrence", recurrence ?: JSONObject.NULL)
            .put("difficulty", difficulty ?: JSONObject.NULL), conflict = { readTask(it, clientId) }) {
            readTask(it.getJSONObject("task"), clientId)
        }

    fun updateTask(id: String, requestId: String, changes: JSONObject): ApiResult<MobileTask> =
        request("PATCH", "/api/mobile/tasks/${part(id)}", JSONObject(changes.toString()).put("request_id", requestId),
            conflict = { readTask(it, id) }) {
            readTask(it.getJSONObject("task"), id)
        }

    fun deleteTask(id: String, requestId: String, base: JSONObject? = null): ApiResult<Unit> =
        request("DELETE", "/api/mobile/tasks/${part(id)}", JSONObject().put("request_id", requestId).apply {
            base?.let { put("base", it) }
        }, conflict = { readTask(it, id) }) { Unit }

    fun applyTaskMutation(mutation: TaskMutation): ApiResult<*> = try {
        when (mutation.operation) {
            "create" -> {
                val task = TaskMutationJson.snapshot(mutation)
                createTask(mutation.requestId, task.id.takeIf(String::isNotBlank), task.title, task.due,
                    task.tags, task.notes, MobileJson.task(task).getJSONArray("subtasks"), task.done,
                    task.recurrence, task.difficulty)
            }
            "update" -> updateTask(requireNotNull(mutation.taskId), mutation.requestId, TaskMutationJson.wire(mutation))
            "delete" -> deleteTask(requireNotNull(mutation.taskId), mutation.requestId, mutation.payload.optJSONObject("base"))
            "journal_tag" -> addJournalTag(mutation.requestId,
                mutation.payload.getString("section_id"), mutation.payload.getString("name"))
            "journal_tag_archive", "journal_tag_restore_temporary" -> journalTagAction(mutation.requestId,
                mutation.payload.getString("section_id"), mutation.payload.getString("name"),
                mutation.operation.removePrefix("journal_tag_"))
            "task_tag" -> addTaskTag(mutation.requestId,
                mutation.payload.getString("name"), mutation.payload.optString("color", "#e0a955"))
            else -> ApiResult.PermanentError(0, "Unknown task operation")
        }
    } catch (error: IOException) {
        ApiResult.TransientError(null, error.message ?: "Mac is unavailable")
    } catch (error: Exception) {
        ApiResult.PermanentError(0, error.message ?: "Saved task change could not be read")
    }

    fun addJournalTag(requestId: String, sectionId: String, name: String): ApiResult<Unit> =
        request("POST", "/api/mobile/tags", JSONObject().put("request_id", requestId)
            .put("section_id", sectionId).put("name", name)) { Unit }

    private fun journalTagAction(requestId: String, sectionId: String, rawName: String, action: String): ApiResult<Unit> {
        val name = JournalTagRegistry.normalizeName(rawName)
        return request("POST", "/api/mobile/tags/" + action.replace('_', '-'), JSONObject().put("request_id", requestId)
            .put("section_id", sectionId).put("name", name)) { result ->
            val tag = result.getJSONObject("tag")
            if (tag.opt("archived") != (action == "archive") || tag.opt("section_id") != sectionId || tag.opt("name") != name)
                throw org.json.JSONException("Incomplete tag action acknowledgement")
            Unit
        }
    }

    fun addTaskTag(requestId: String, name: String, color: String): ApiResult<Unit> =
        request("POST", "/api/mobile/tags", JSONObject().put("request_id", requestId)
            .put("domain", "task").put("name", name).put("color", color)) { Unit }

    private fun <T> request(method: String, path: String, body: JSONObject? = null,
                            conflict: ((JSONObject) -> Unit)? = null,
                            parse: (JSONObject) -> T): ApiResult<T> {
        val conn = try { openConnection(URL(baseUrl.trimEnd('/') + path)) }
            catch (error: IOException) { return ApiResult.TransientError(null, error.message ?: "Network unavailable") }
        var receivedStatus: Int? = null
        return try {
            conn.requestMethod = method
            conn.instanceFollowRedirects = false
            conn.connectTimeout = 15_000
            conn.readTimeout = 20_000
            conn.setRequestProperty("Accept", "application/json")
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.setRequestProperty("X-TodoPup-Client", "android/1")
            if (body != null) {
                conn.doOutput = true
                conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                conn.outputStream.bufferedWriter(Charsets.UTF_8).use { it.write(body.toString()) }
            }
            val status = conn.responseCode
            receivedStatus = status
            val stream = if (status in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            val json = if (status in 200..299) JSONObject(text)
                else runCatching { JSONObject(text) }.getOrDefault(JSONObject())
            when {
                status in 200..299 -> {
                    if (json.opt("ok") != true) throw org.json.JSONException("Missing successful acknowledgement")
                    ApiResult.Success(parse(json), status)
                }
                status == 409 -> {
                    val validate = conflict ?: throw org.json.JSONException("Unexpected conflict response")
                    val field = when {
                        json.has("current") -> "current"
                        json.has("entry") -> "entry" // Earlier journal servers used this field.
                        else -> throw org.json.JSONException("Missing conflict snapshot")
                    }
                    // An explicit null represents a deleted remote record.
                    // Missing, partial or wrongly identified records must never
                    // be presented as a deletion or an actionable comparison.
                    val current = if (json.isNull(field)) JSONObject()
                        else json.getJSONObject(field).also(validate)
                    ApiResult.Conflict(current, message(json, "Entry changed on the Mac"))
                }
                status == 408 || status == 425 || status == 429 || status >= 500 ->
                    ApiResult.TransientError(status, message(json, "Temporary server error (HTTP $status)"))
                else -> ApiResult.PermanentError(status, message(json, "Request rejected (HTTP $status)"))
            }
        } catch (ex: IOException) {
            ApiResult.TransientError(null, ex.message ?: "Network unavailable")
        } catch (ex: org.json.JSONException) {
            ApiResult.TransientError(receivedStatus, "Mac response could not be read · retry queued")
        } catch (ex: Exception) {
            ApiResult.PermanentError(0, ex.message ?: "Invalid server response")
        } finally {
            conn.disconnect()
        }
    }

    private fun readJournal(value: JSONObject, expectedDate: String): JournalDraft {
        fun valid(condition: Boolean) {
            if (!condition) throw org.json.JSONException("Incomplete journal response")
        }
        for (field in listOf("id", "date", "title", "body", "updated")) valid(value.opt(field) is String)
        valid(value.getString("id").isNotBlank() && value.getString("updated").isNotBlank() && value.getString("date") == expectedDate)
        val tags = value.getJSONObject("tags")
        for (key in tags.keys()) {
            val names = tags.getJSONArray(key)
            valid((0 until names.length()).all { names.opt(it) is String })
        }
        val numbers = value.getJSONObject("numbers")
        for (key in numbers.keys()) valid((numbers.opt(key) as? Number)?.toDouble()?.isFinite() == true)
        if (!value.isNull("mood")) {
            val mood = (value.opt("mood") as? Number)?.toDouble()
            valid(mood != null && mood in 1.0..7.0 && mood % 1.0 == 0.0)
        }
        if (!value.isNull("document")) {
            val blocks = value.getJSONArray("document")
            for (index in 0 until blocks.length()) {
                val block = blocks.getJSONObject(index)
                valid(block.opt("id") is String && block.optString("type") in setOf("text", "photo", "message"))
            }
        }
        for (field in listOf("audio_transcript", "edit_revision")) valid(value.isNull(field) || value.opt(field) is String)
        return MobileJson.parseDraft(JSONObject(value.toString()).put("sync_state", SyncState.SYNCED.name)
            .put("base_updated", value.getString("updated")))
    }

    private fun readTask(value: JSONObject, expectedId: String? = null): MobileTask {
        for (field in listOf("id", "title", "notes", "status")) {
            if (value.opt(field) !is String) throw org.json.JSONException("Missing task $field")
        }
        if (value.getString("id").isBlank() || value.getString("title").isBlank() ||
            expectedId != null && value.getString("id") != expectedId) throw org.json.JSONException("Invalid task identity")
        if (value.opt("done") !is Boolean || value.getString("status") !in setOf("active", "completed", "expired") ||
            value.getBoolean("done") != (value.getString("status") == "completed")) throw org.json.JSONException("Invalid task status")
        for (field in listOf("due", "recurrence", "difficulty")) {
            if (!value.isNull(field) && value.opt(field) !is String) throw org.json.JSONException("Invalid task $field")
        }
        val tags = value.getJSONArray("tags")
        if ((0 until tags.length()).any { tags.opt(it) !is String }) throw org.json.JSONException("Invalid task tags")
        val subtasks = value.getJSONArray("subtasks")
        for (index in 0 until subtasks.length()) {
            val subtask = subtasks.getJSONObject(index)
            if (subtask.opt("text") !is String || subtask.opt("done") !is Boolean) throw org.json.JSONException("Invalid subtask")
        }
        return MobileJson.task(value)
    }

    private fun message(json: JSONObject, fallback: String): String {
        val error = json.optJSONObject("error")
        return error?.optString("message")?.takeIf(String::isNotBlank)
            ?: json.optString("error").takeIf(String::isNotBlank)
            ?: json.optString("message").takeIf(String::isNotBlank)
            ?: fallback
    }

    private fun part(value: String): String = URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")
}
