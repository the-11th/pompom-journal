package com.todopup.usage

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.util.UUID

enum class SyncState { DRAFT, PENDING, SYNCED, CONFLICT, PERMANENT_FAILURE }

data class JournalDraft(
    val date: String,
    val title: String = "",
    val body: String = "",
    val mood: Int? = null,
    val tags: Map<String, List<String>> = emptyMap(),
    val numbers: Map<String, Double> = emptyMap(),
    val audioTranscript: String = "",
    val document: String? = null,
    val autosave: Boolean = false,
    val newTags: String = "[]",
    val requestId: String = UUID.randomUUID().toString(),
    val baseUpdated: String? = null,
    val modifiedAt: String = Instant.now().toString(),
    val syncState: SyncState = SyncState.DRAFT,
    val syncMessage: String? = null,
    val serverVersion: JSONObject? = null,
    val baseEditRevision: String? = null,
)

data class JournalSection(
    val id: String,
    val name: String,
    val type: String,
    val color: String,
    val unit: String = "",
    val tags: List<String> = emptyList(),
    val mentionTags: List<String> = emptyList(),
    val managed: String? = null,
    val archivedTags: List<String> = emptyList(),
    val archiveStateKnown: Boolean = true,
)

data class MobileJournalConfig(
    val sections: List<JournalSection>,
    val entryDates: List<String> = emptyList(),
    val calendarDates: List<String> = entryDates,
    val storedEntryDates: List<String> = entryDates,
    val emptyEditRevision: String? = null,
)

data class MobileTask(
    val id: String,
    val title: String,
    val due: String? = null,
    val tags: List<String> = emptyList(),
    val notes: String = "",
    val done: Boolean = false,
    val status: String = if (done) "completed" else "active",
    val subtasks: List<MobileSubtask> = emptyList(),
    val recurrence: String? = null,
    val difficulty: String? = null,
)

data class TaskConflict(
    val requestId: String,
    val operation: String,
    val local: TaskDraft?,
    val remote: TaskDraft?,
    val fields: List<String>,
    val message: String,
    val resolution: String = "apply",
)

data class MobileSubtask(val text: String, val done: Boolean)

// Presentation aliases keep the Activity vocabulary concise while retaining
// the wire model names used by the sync layer.
typealias TagSection = JournalSection
typealias TaskDraft = MobileTask
typealias SubtaskDraft = MobileSubtask

data class JournalSnapshot(
    val draft: JournalDraft,
    val sections: List<JournalSection> = emptyList(),
    val message: String = "Saved on this phone",
)

sealed class SaveResult {
    data class Saved(
        val snapshot: JournalSnapshot,
        val syncWorkId: java.util.UUID? = null,
    ) : SaveResult()
    data class Conflict(val local: JournalDraft, val remote: JournalDraft) : SaveResult()
    data class Failed(val message: String) : SaveResult()
}

internal object MobileJson {
    fun task(value: MobileTask): JSONObject = JSONObject().put("id", value.id).put("title", value.title)
        .put("due", value.due ?: JSONObject.NULL).put("recurrence", value.recurrence ?: JSONObject.NULL)
        .put("difficulty", value.difficulty ?: JSONObject.NULL).put("done", value.done).put("status", value.status)
        .put("notes", value.notes).put("tags", JSONArray(value.tags)).put("subtasks", JSONArray().also { out ->
            value.subtasks.forEach { out.put(JSONObject().put("text", it.text).put("done", it.done)) }
        })

    fun draft(value: JournalDraft): JSONObject = JSONObject()
        .put("date", value.date)
        .put("title", value.title)
        .put("body", value.body)
        .put("mood", value.mood ?: JSONObject.NULL)
        .put("tags", mapOfLists(value.tags))
        .put("numbers", JSONObject(value.numbers))
        .put("audio_transcript", value.audioTranscript)
        .put("document", value.document?.let { JSONArray(it) } ?: JSONObject.NULL)
        .put("autosave", value.autosave)
        .put("new_tags", JSONArray(value.newTags))
        .put("request_id", value.requestId)
        .put("base_updated", value.baseUpdated ?: JSONObject.NULL)
        .put("base_edit_revision", value.baseEditRevision ?: JSONObject.NULL)
        .put("modified_at", value.modifiedAt)
        .put("sync_state", value.syncState.name)
        .put("sync_message", value.syncMessage ?: JSONObject.NULL)
        .put("server_version", value.serverVersion ?: JSONObject.NULL)

    fun parseDraft(o: JSONObject): JournalDraft = JournalDraft(
        date = o.getString("date"),
        title = o.optString("title"),
        body = o.optString("body"),
        mood = o.optIntOrNull("mood"),
        tags = parseMapOfLists(o.optJSONObject("tags")),
        numbers = parseNumbers(o.optJSONObject("numbers")),
        audioTranscript = o.optString("audio_transcript"),
        document = o.optJSONArray("document")?.toString(),
        autosave = o.optBoolean("autosave", false),
        newTags = (o.optJSONArray("new_tags") ?: JSONArray()).toString(),
        requestId = o.optString("request_id").ifBlank { UUID.randomUUID().toString() },
        baseUpdated = o.optStringOrNull("base_updated"),
        baseEditRevision = o.optStringOrNull(if (o.has("base_edit_revision")) "base_edit_revision" else "edit_revision"),
        modifiedAt = o.optString("modified_at").ifBlank { Instant.now().toString() },
        syncState = runCatching { SyncState.valueOf(o.optString("sync_state")) }
            .getOrDefault(SyncState.DRAFT),
        syncMessage = o.optStringOrNull("sync_message"),
        serverVersion = o.optJSONObject("server_version"),
    )

    fun task(o: JSONObject): MobileTask {
        val subs = o.optJSONArray("subtasks") ?: JSONArray()
        return MobileTask(
            id = o.optString("id"), title = o.optString("title"),
            due = o.optStringOrNull("due"), tags = stringList(o.optJSONArray("tags")),
            notes = o.optString("notes"), done = o.optBoolean("done", false),
            status = o.optString("status").ifBlank {
                if (o.optBoolean("done", false)) "completed" else "active"
            },
            subtasks = (0 until subs.length()).mapNotNull { i ->
                subs.optJSONObject(i)?.let { MobileSubtask(it.optString("text"), it.optBoolean("done")) }
            },
            recurrence = o.optStringOrNull("recurrence"),
            difficulty = o.optStringOrNull("difficulty"),
        )
    }

    fun config(o: JSONObject): MobileJournalConfig {
        val arr = o.optJSONArray("sections") ?: JSONArray()
        return MobileJournalConfig((0 until arr.length()).mapNotNull { i ->
            arr.optJSONObject(i)?.let {
                JournalSection(it.optString("id"), it.optString("name"),
                    it.optString("type"), it.optString("color"), it.optString("unit"),
                    stringList(it.optJSONArray("tags")),
                    stringList(it.optJSONArray("mention_tags")), it.optStringOrNull("managed"),
                    stringList(it.optJSONArray("archived_tags")), it.opt("archived_tags") is JSONArray)
            }
        }, stringList(o.optJSONArray("entry_dates")),
            stringList(o.optJSONArray(if (o.has("calendar_dates")) "calendar_dates" else "entry_dates")),
            stringList(o.optJSONArray(if (o.has("stored_entry_dates")) "stored_entry_dates" else "entry_dates")),
            o.optStringOrNull("empty_edit_revision"))
    }

    private fun mapOfLists(values: Map<String, List<String>>) = JSONObject().also { out ->
        values.forEach { (key, value) -> out.put(key, JSONArray(value)) }
    }

    private fun parseMapOfLists(o: JSONObject?): Map<String, List<String>> =
        if (o == null) emptyMap() else o.keys().asSequence().associateWith { stringList(o.optJSONArray(it)) }

    private fun parseNumbers(o: JSONObject?): Map<String, Double> =
        if (o == null) emptyMap() else o.keys().asSequence().mapNotNull {
            key -> o.optDouble(key).takeUnless(Double::isNaN)?.let { key to it }
        }.toMap()

    private fun stringList(a: JSONArray?): List<String> =
        if (a == null) emptyList() else (0 until a.length()).mapNotNull { a.optString(it).takeIf(String::isNotBlank) }

    private fun JSONObject.optStringOrNull(key: String): String? =
        if (isNull(key)) null else optString(key).takeIf(String::isNotBlank)

    private fun JSONObject.optIntOrNull(key: String): Int? =
        if (isNull(key) || !has(key)) null else optInt(key)
}
