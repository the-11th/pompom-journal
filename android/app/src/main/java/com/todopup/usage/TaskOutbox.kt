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
    val conflict: Boolean = false,
    val serverVersion: JSONObject? = null,
)

internal data class JournalTagIntent(val sectionId: String, val name: String, val action: String,
    val requestId: String, val acknowledged: Boolean = false, val confirmed: Boolean = false) {
    fun json() = JSONObject().put("section_id", sectionId).put("name", name).put("action", action)
        .put("request_id", requestId).put("acknowledged", acknowledged).put("confirmed", confirmed)
}

class TaskOutbox(private val context: Context) {
    private val prefs = context.getSharedPreferences("todopup_task_outbox", Context.MODE_PRIVATE)

    fun enqueue(mutation: TaskMutation): TaskMutation = synchronized(guard) {
        // The API honors Android's client_id for creates, so later queued edits
        // and deletes safely target the same id even when all were made offline.
        val a = read().put(encode(mutation))
        check(prefs.edit().putString(KEY, a.toString()).commit()) { "Could not save task change" }
        mutation
    }

    fun pending(): List<TaskMutation> = synchronized(guard) { decodeAll().filter { it.permanentError == null } }
    fun failed(): List<TaskMutation> = synchronized(guard) { decodeAll().filter { it.permanentError != null } }
    internal fun all(): List<TaskMutation> = synchronized(guard) { decodeAll() }
    fun blockedTaskIds(): Set<String> = failed().mapNotNull(TaskMutationJson::targetId).toSet()
    fun sendable(): List<TaskMutation> = synchronized(guard) {
        val blocked = blockedTaskIds()
        val blockedTags = failed().filter { it.operation.startsWith("journal_tag") }.map(::tagKey).toSet()
        pending().filter { TaskMutationJson.targetId(it) !in blocked &&
            (!it.operation.startsWith("journal_tag") || tagKey(it) !in blockedTags) }
    }

    fun retryFailed(): Int = synchronized(guard) {
        val all = decodeAll()
        val failed = all.count { it.permanentError != null && !it.conflict }
        if (failed > 0) write(JSONArray().also { out ->
            all.forEach { out.put(TaskMutationJson.encode(if (it.conflict) it else it.copy(permanentError = null))) }
        })
        failed
    }

    fun acknowledge(requestId: String) = synchronized(JournalSyncStore.guard) {
        val accepted = synchronized(guard) {
            decodeAll().filter { it.requestId == requestId && it.operation == "journal_tag" }.map(::journalTag)
        }
        // Journal guard always precedes task guard. Clear acknowledged draft metadata
        // before dropping the durable operation; interruption can only cause a safe retry.
        if (accepted.isNotEmpty()) JournalSyncStore(context).acknowledgeTags(accepted)
        synchronized(guard) {
            val remaining = JSONArray(decodeAll().filterNot { it.requestId == requestId }.map(::encode))
            val intents = journalTagIntents().map { if (it.requestId == requestId) it.copy(acknowledged = true) else it }
            val confirmed = (acknowledgedJournalTags() + accepted).distinct()
            check(prefs.edit().putString(KEY, remaining.toString())
                .putString(KEY_TAG_INTENTS, JSONArray(intents.map { it.json() }).toString())
                .putString(KEY_JOURNAL_TAGS, JournalTagRegistry.encode(confirmed)).commit()) { "Could not save tag acknowledgement" }
        }
    }

    internal fun enqueueJournalTag(tag: JournalTagAddition, deliberate: Boolean = false) = synchronized(guard) {
        val last = journalTagIntents().firstOrNull { it.sectionId == tag.sectionId && it.name == tag.name }
        if (!deliberate && last != null && last.action != "add") return@synchronized
        if (tag !in journalTags(includeAcknowledged = true) || last?.action in setOf("archive", "restore_temporary"))
            enqueueJournalTagIntent(tag, "add")
    }

    internal fun enqueueJournalTagIntent(tag: JournalTagAddition, action: String) = synchronized(guard) {
        require(action in setOf("add", "archive", "restore_temporary"))
        val intents = journalTagIntents()
        val previous = intents.firstOrNull { it.sectionId == tag.sectionId && it.name == tag.name }
        if (previous?.action == action && !previous.confirmed) return@synchronized
        val mutation = TaskMutation(operation = if (action == "add") "journal_tag" else "journal_tag_$action", payload = tag.json())
        val identity = tag.sectionId to tag.name
        // Restore-temporary must follow a pending archive: the archive removes
        // permanence, while restoring only makes the historical name visible.
        val remaining = decodeAll().filterNot { it.operation.startsWith("journal_tag") && tagKey(it) == identity &&
            !(action == "restore_temporary" && it.operation == "journal_tag_archive") } + mutation
        val updated = intents.filterNot { it.sectionId == tag.sectionId && it.name == tag.name } +
            JournalTagIntent(tag.sectionId, tag.name, action, mutation.requestId)
        val acknowledged = acknowledgedJournalTags().filterNot { it.sectionId == tag.sectionId && it.name == tag.name }
        check(prefs.edit().putString(KEY, JSONArray(remaining.map(::encode)).toString())
            .putString(KEY_TAG_INTENTS, JSONArray(updated.map { it.json() }).toString())
            .putString(KEY_JOURNAL_TAGS, JournalTagRegistry.encode(acknowledged)).commit()) { "Could not save journal tag change" }
    }

    internal fun journalTagIntents(): List<JournalTagIntent> = synchronized(guard) {
        val raw = prefs.getString(KEY_TAG_INTENTS, "[]") ?: "[]"
        try {
            val values = JSONArray(raw)
            (0 until values.length()).map { index ->
                val value = values.getJSONObject(index)
                val action = value.getString("action").also { require(it in setOf("add", "archive", "restore_temporary")) }
                for (key in listOf("acknowledged", "confirmed")) require(value.opt(key) is Boolean)
                JournalTagIntent(value.getString("section_id").also { require(it.isNotBlank()) },
                    JournalTagRegistry.normalizeName(value.getString("name")), action,
                    value.getString("request_id").also { require(it.isNotBlank()) }, value.getBoolean("acknowledged"), value.getBoolean("confirmed"))
            }
        } catch (error: Exception) {
            prefs.edit().putString("journal_tag_intents_corrupt_backup", raw).commit()
            throw IllegalStateException("Saved journal tag changes need recovery. A backup has been kept on this phone.", error)
        }
    }

    private fun tagKey(mutation: TaskMutation) = mutation.payload.getString("section_id") to
        JournalTagRegistry.normalizeName(mutation.payload.getString("name"))

    internal fun journalTags(includeAcknowledged: Boolean = false): List<JournalTagAddition> = synchronized(guard) {
        (decodeAll().filter { it.operation == "journal_tag" }.map(::journalTag) +
            if (includeAcknowledged) acknowledgedJournalTags() else emptyList()).distinct()
    }

    /** Keep the optimistic registry until a downloaded config confirms it. */
    internal fun confirmJournalTags(sections: List<JournalSection>) = synchronized(guard) {
        val remaining = acknowledgedJournalTags().filter { tag ->
            sections.any { it.id == tag.sectionId && tag.name !in it.tags }
        }
        val intents = journalTagIntents().map { intent ->
            val section = sections.firstOrNull { it.id == intent.sectionId }
            val matched = section == null || when (intent.action) {
                "archive" -> section.archiveStateKnown && intent.name in section.archivedTags && intent.name !in section.tags
                "add" -> intent.name in section.tags && intent.name !in section.archivedTags
                else -> section.archiveStateKnown && intent.name !in section.archivedTags
            }
            if (intent.acknowledged && matched) intent.copy(confirmed = true) else intent
        }
        check(prefs.edit().putString(KEY_JOURNAL_TAGS, JournalTagRegistry.encode(remaining))
            .putString(KEY_TAG_INTENTS, JSONArray(intents.map { it.json() }).toString()).commit()) { "Could not save tag registry" }
    }

    private fun journalTag(mutation: TaskMutation) = JournalTagAddition(mutation.payload.getString("section_id"),
        JournalTagRegistry.normalizeName(mutation.payload.getString("name")))

    private fun acknowledgedJournalTags(): List<JournalTagAddition> {
        val raw = prefs.getString(KEY_JOURNAL_TAGS, "[]") ?: "[]"
        return try { JournalTagRegistry.parse(raw) } catch (error: Exception) {
            prefs.edit().putString("journal_tags_corrupt_backup", raw).commit()
            throw IllegalStateException("Saved journal tags need recovery. A backup has been kept on this phone.", error)
        }
    }

    internal fun acknowledgeTask(sent: TaskMutation, server: MobileTask) = synchronized(guard) {
        val all = decodeAll()
        if (all.none { it.requestId == sent.requestId }) return@synchronized
        val proposed = MobileJson.task(TaskMutationJson.snapshot(sent))
        val accepted = MobileJson.task(server)
        val fields = TaskMutationJson.fields(sent) + if (sent.operation == "create" || sent.payload.has("done")) listOf("status") else emptyList()
        write(JSONArray().also { out -> all.filterNot { it.requestId == sent.requestId }.forEach { next ->
            val payload = JSONObject(next.payload.toString())
            if (TaskMutationJson.targetId(next) == server.id) payload.optJSONObject("base")?.let { base ->
                fields.filter { base.has(it) && TaskMutationJson.same(base.opt(it), proposed.opt(it)) }
                    .forEach { base.put(it, accepted.get(it)) }
            }
            out.put(encode(next.copy(payload = payload)))
        } })
    }

    fun markFailed(requestId: String, message: String) = synchronized(guard) { write(JSONArray().also { out ->
        decodeAll().forEach { out.put(encode(if (it.requestId == requestId) it.copy(permanentError = message) else it)) }
    }) }

    fun markConflict(requestId: String, current: JSONObject, message: String) = synchronized(guard) {
        write(JSONArray().also { out -> decodeAll().forEach {
            out.put(encode(if (it.requestId == requestId) it.copy(permanentError = message,
                conflict = true, serverVersion = current) else it))
        } })
    }

    internal fun replaceTaskChanges(taskId: String, replacement: TaskMutation?) = synchronized(guard) {
        write(JSONArray().also { out ->
            decodeAll().filterNot { TaskMutationJson.targetId(it) == taskId }.forEach { out.put(encode(it)) }
            replacement?.let { out.put(encode(it)) }
        })
    }

    private fun decodeAll(): List<TaskMutation> {
        val all = read()
        return (0 until all.length()).map { i -> TaskMutationJson.decode(all.getJSONObject(i)) }
    }
    private fun encode(m: TaskMutation) = TaskMutationJson.encode(m)
    private fun read(): JSONArray {
        val raw = prefs.getString(KEY, "[]") ?: "[]"
        return try { JSONArray(raw).also { values ->
            for (index in 0 until values.length()) {
                val item = values.getJSONObject(index)
                for (field in listOf("request_id", "operation")) require(item.opt(field) is String && item.getString(field).isNotBlank())
                item.getJSONObject("payload")
                for (field in listOf("task_id", "permanent_error")) require(item.isNull(field) || item.opt(field) is String)
                require(!item.has("conflict") || item.opt("conflict") is Boolean)
                require(item.isNull("server_version") || item.opt("server_version") is JSONObject)
            }
        } } catch (error: Exception) {
            prefs.edit().putString("mutations_corrupt_backup", raw).commit()
            throw IllegalStateException("Saved task changes need recovery. A backup has been kept on this phone.", error)
        }
    }
    private fun write(a: JSONArray) { check(prefs.edit().putString(KEY, a.toString()).commit()) }
    companion object {
        internal val guard = Any()
        private const val KEY = "mutations_v1"
        private const val KEY_TAG_INTENTS = "journal_tag_intents_v1"
        private const val KEY_JOURNAL_TAGS = "acknowledged_journal_tags_v1"
    }
}

internal object TaskMutationJson {
    fun decode(value: JSONObject) = TaskMutation(
        value.optString("request_id"), value.nullableString("task_id"),
        value.optString("operation"), value.optJSONObject("payload") ?: JSONObject(),
        value.nullableString("permanent_error"),
        value.optBoolean("conflict", false), value.optJSONObject("server_version"),
    )

    fun encode(value: TaskMutation) = JSONObject().put("request_id", value.requestId)
        .put("task_id", value.taskId ?: JSONObject.NULL).put("operation", value.operation)
        .put("payload", value.payload)
        .put("permanent_error", value.permanentError ?: JSONObject.NULL)
        .put("conflict", value.conflict).put("server_version", value.serverVersion ?: JSONObject.NULL)

    fun targetId(value: TaskMutation): String? = value.taskId ?: value.payload.nullableString("id")

    fun edit(task: MobileTask, before: MobileTask?): TaskMutation? {
        if (before == null) return TaskMutation(operation = "create", payload = MobileJson.task(task))
        val fields = TaskEdits.changedFields(before, task)
        if (fields.isEmpty()) return null
        val previous = MobileJson.task(before)
        val current = MobileJson.task(task)
        val base = JSONObject().put("status", before.status)
        val payload = JSONObject().put("snapshot", current).put("base", base)
        fields.forEach { field -> base.put(field, previous.get(field)); payload.put(field, current.get(field)) }
        return TaskMutation(taskId = task.id, operation = "update", payload = payload)
    }

    fun deletion(task: MobileTask): TaskMutation {
        val snapshot = MobileJson.task(task)
        val base = JSONObject(snapshot.toString()).apply { remove("id") }
        return TaskMutation(taskId = task.id, operation = "delete",
            payload = JSONObject().put("base", base).put("snapshot", snapshot))
    }

    fun snapshot(mutation: TaskMutation): MobileTask = MobileJson.task(
        JSONObject((mutation.payload.optJSONObject("snapshot") ?: mutation.payload).toString())
            .put("id", targetId(mutation)))

    fun fields(mutation: TaskMutation): List<String> = if (mutation.operation in setOf("create", "delete"))
        TaskEdits.fields else TaskEdits.fields.filter(mutation.payload::has)

    fun wire(mutation: TaskMutation): JSONObject = JSONObject(mutation.payload.toString()).apply { remove("snapshot") }

    internal fun same(left: Any?, right: Any?): Boolean = when {
        left is JSONObject && right is JSONObject -> left.keys().asSequence().toSet() == right.keys().asSequence().toSet() &&
            left.keys().asSequence().all { same(left.opt(it), right.opt(it)) }
        left is JSONArray && right is JSONArray -> left.length() == right.length() &&
            (0 until left.length()).all { same(left.opt(it), right.opt(it)) }
        else -> left == right
    }

    private fun JSONObject.nullableString(key: String): String? =
        nullableString(!has(key) || isNull(key), optString(key))

    internal fun nullableString(isNull: Boolean, value: String): String? =
        if (isNull) null else value.takeIf(String::isNotBlank)
}
