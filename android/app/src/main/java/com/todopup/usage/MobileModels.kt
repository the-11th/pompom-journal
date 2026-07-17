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
    val requestId: String = UUID.randomUUID().toString(),
    val baseUpdated: String? = null,
    val modifiedAt: String = Instant.now().toString(),
    val syncState: SyncState = SyncState.DRAFT,
    val syncMessage: String? = null,
    val serverVersion: JSONObject? = null,
)

data class JournalSection(
    val id: String,
    val name: String,
    val type: String,
    val color: String,
    val unit: String = "",
    val tags: List<String> = emptyList(),
    val mentionTags: List<String> = emptyList(),
)

data class MobileJournalConfig(val sections: List<JournalSection>)

data class MobileTask(
    val id: String,
    val title: String,
    val due: String? = null,
    val tags: List<String> = emptyList(),
    val notes: String = "",
    val done: Boolean = false,
    val subtasks: List<MobileSubtask> = emptyList(),
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
    data class Saved(val snapshot: JournalSnapshot) : SaveResult()
    data class Conflict(val local: JournalDraft, val remote: JournalDraft) : SaveResult()
    data class Failed(val message: String) : SaveResult()
}

internal object MobileJson {
    fun draft(value: JournalDraft): JSONObject = JSONObject()
        .put("date", value.date)
        .put("title", value.title)
        .put("body", value.body)
        .put("mood", value.mood ?: JSONObject.NULL)
        .put("tags", mapOfLists(value.tags))
        .put("numbers", JSONObject(value.numbers))
        .put("audio_transcript", value.audioTranscript)
        .put("request_id", value.requestId)
        .put("base_updated", value.baseUpdated ?: JSONObject.NULL)
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
        requestId = o.optString("request_id").ifBlank { UUID.randomUUID().toString() },
        baseUpdated = o.optStringOrNull("base_updated"),
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
            subtasks = (0 until subs.length()).mapNotNull { i ->
                subs.optJSONObject(i)?.let { MobileSubtask(it.optString("text"), it.optBoolean("done")) }
            },
        )
    }

    fun config(o: JSONObject): MobileJournalConfig {
        val arr = o.optJSONArray("sections") ?: JSONArray()
        return MobileJournalConfig((0 until arr.length()).mapNotNull { i ->
            arr.optJSONObject(i)?.let {
                JournalSection(it.optString("id"), it.optString("name"),
                    it.optString("type"), it.optString("color"), it.optString("unit"),
                    stringList(it.optJSONArray("tags")),
                    stringList(it.optJSONArray("mention_tags")))
            }
        })
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
