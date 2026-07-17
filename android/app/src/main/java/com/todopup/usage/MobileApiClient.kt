package com.todopup.usage

import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.net.URLEncoder

sealed class ApiResult<out T> {
    data class Success<T>(val value: T, val status: Int) : ApiResult<T>()
    data class Conflict(val current: JSONObject, val message: String) : ApiResult<Nothing>()
    data class PermanentError(val status: Int, val message: String) : ApiResult<Nothing>()
    data class TransientError(val status: Int?, val message: String) : ApiResult<Nothing>()
}

/** HTTPS client; private routing is supplied by the installed Tailscale app. */
class MobileApiClient(private val baseUrl: String, private val token: String) {
    init {
        require(URI(baseUrl).scheme == "https") { "Mobile API URL must use HTTPS" }
    }

    fun getConfig(): ApiResult<MobileJournalConfig> = request("GET", "/api/mobile/config") {
        MobileJson.config(it)
    }

    fun getJournal(date: String): ApiResult<JournalDraft?> = request("GET", "/api/mobile/journal/${part(date)}") {
        val entry = it.optJSONObject("entry") ?: return@request null
        MobileJson.parseDraft(entry.put("sync_state", SyncState.SYNCED.name)
            .put("base_updated", entry.optString("updated")))
    }

    fun putJournal(draft: JournalDraft): ApiResult<JournalDraft> {
        val payload = MobileJson.draft(draft).apply {
            remove("modified_at"); remove("sync_state"); remove("sync_message"); remove("server_version")
        }
        return request("PUT", "/api/mobile/journal/${part(draft.date)}", payload) { root ->
            val entry = root.optJSONObject("entry") ?: root
            MobileJson.parseDraft(entry
                .put("request_id", draft.requestId)
                .put("sync_state", SyncState.SYNCED.name)
                .put("base_updated", entry.optString("updated")))
        }
    }

    fun getTasks(): ApiResult<List<MobileTask>> = request("GET", "/api/mobile/tasks") {
        val array = it.optJSONArray("tasks") ?: JSONArray()
        (0 until array.length()).mapNotNull { i -> array.optJSONObject(i)?.let(MobileJson::task) }
    }

    fun createTask(requestId: String, clientId: String?, title: String, due: String?, tags: List<String>, notes: String): ApiResult<MobileTask> =
        request("POST", "/api/mobile/tasks", JSONObject()
            .put("request_id", requestId).put("client_id", clientId ?: JSONObject.NULL).put("title", title)
            .put("due", due ?: JSONObject.NULL).put("tags", JSONArray(tags)).put("notes", notes)) {
            MobileJson.task(it.optJSONObject("task") ?: it)
        }

    fun updateTask(id: String, requestId: String, changes: JSONObject): ApiResult<MobileTask> =
        request("PATCH", "/api/mobile/tasks/${part(id)}", JSONObject(changes.toString()).put("request_id", requestId)) {
            MobileJson.task(it.optJSONObject("task") ?: it)
        }

    fun deleteTask(id: String, requestId: String): ApiResult<Unit> =
        request("DELETE", "/api/mobile/tasks/${part(id)}", JSONObject().put("request_id", requestId)) { Unit }

    fun addJournalTag(requestId: String, sectionId: String, name: String): ApiResult<Unit> =
        request("POST", "/api/mobile/tags", JSONObject().put("request_id", requestId)
            .put("section_id", sectionId).put("name", name)) { Unit }

    fun addTaskTag(requestId: String, name: String, color: String): ApiResult<Unit> =
        request("POST", "/api/mobile/tags", JSONObject().put("request_id", requestId)
            .put("domain", "task").put("name", name).put("color", color)) { Unit }

    private fun <T> request(method: String, path: String, body: JSONObject? = null,
                            parse: (JSONObject) -> T): ApiResult<T> {
        val conn = URL(baseUrl.trimEnd('/') + path).openConnection() as HttpURLConnection
        return try {
            conn.requestMethod = method
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
            val stream = if (status in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            val json = text.takeIf(String::isNotBlank)?.let { JSONObject(it) } ?: JSONObject()
            when {
                status in 200..299 -> ApiResult.Success(parse(json), status)
                status == 409 -> ApiResult.Conflict(json.optJSONObject("current")
                    ?: json.optJSONObject("entry") ?: JSONObject(), message(json, "Entry changed on the Mac"))
                status == 408 || status == 425 || status == 429 || status >= 500 ->
                    ApiResult.TransientError(status, message(json, "Temporary server error (HTTP $status)"))
                else -> ApiResult.PermanentError(status, message(json, "Request rejected (HTTP $status)"))
            }
        } catch (ex: IOException) {
            ApiResult.TransientError(null, ex.message ?: "Network unavailable")
        } catch (ex: Exception) {
            ApiResult.PermanentError(0, ex.message ?: "Invalid server response")
        } finally {
            conn.disconnect()
        }
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
