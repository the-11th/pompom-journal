package com.todopup.usage

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Narrow seam between presentation and the durable outbox/sync implementation. */
interface MobileRepository {
    fun journal(date: String): JournalSnapshot
    fun saveJournalDraft(draft: JournalDraft): JournalSnapshot
    fun saveJournal(draft: JournalDraft): SaveResult
    fun resolveJournalConflict(date: String, keepPhone: Boolean): SaveResult
    fun addJournalTag(sectionId: String, name: String)
    fun tasks(): List<TaskDraft>
    fun saveTasks(tasks: List<TaskDraft>)
    fun deleteTask(task: TaskDraft)
}

object MobileRepositoryProvider {
    @Volatile var factory: ((Context) -> MobileRepository)? = null
    fun create(context: Context): MobileRepository =
        factory?.invoke(context.applicationContext) ?: OutboxMobileRepository(context.applicationContext)
}

/** Offline-first adapter: commit locally, enqueue, then let WorkManager sync. */
class OutboxMobileRepository(private val context: Context) : MobileRepository {
    private val journals = JournalSyncStore(context)
    private val prefs = context.getSharedPreferences("todopup_mobile_ui", Context.MODE_PRIVATE)

    override fun journal(date: String): JournalSnapshot {
        val draft = journals.get(date) ?: JournalDraft(date)
        return JournalSnapshot(draft, sections(), draft.syncMessage ?: when (draft.syncState) {
            SyncState.DRAFT -> "Saved on this phone"
            SyncState.PENDING -> "Queued for Mac"
            SyncState.SYNCED -> "Synced with Mac"
            SyncState.CONFLICT -> "Needs review · Mac entry changed"
            SyncState.PERMANENT_FAILURE -> "Could not sync · check connection"
        })
    }

    override fun saveJournal(draft: JournalDraft): SaveResult {
        val queued = journals.enqueue(draft.copy(requestId = UUID.randomUUID().toString()))
        MobileSyncScheduler.enqueue(context)
        return SaveResult.Saved(JournalSnapshot(queued, sections(),
            if (MobileConfig.isConfigured(context)) "Queued for Mac" else "Saved on phone · connect Mac to sync"))
    }

    override fun saveJournalDraft(draft: JournalDraft): JournalSnapshot {
        val saved = journals.save(draft.copy(syncState = SyncState.DRAFT,
            syncMessage = null, serverVersion = null))
        return JournalSnapshot(saved, sections(), "Draft saved on this phone")
    }

    override fun resolveJournalConflict(date: String, keepPhone: Boolean): SaveResult {
        val local = journals.get(date) ?: return SaveResult.Failed("Local draft is missing")
        val current = local.serverVersion ?: return SaveResult.Failed("Mac version is unavailable")
        return if (keepPhone) {
            val queued = journals.resolveWith(local, current.optString("updated").takeIf(String::isNotBlank))
            MobileSyncScheduler.enqueue(context, date)
            SaveResult.Saved(JournalSnapshot(queued, sections(), "Phone version queued for Mac"))
        } else runCatching {
            val json = JSONObject(current.toString()).put("date", date)
                .put("request_id", local.requestId).put("sync_state", SyncState.SYNCED.name)
                .put("base_updated", current.optString("updated"))
            val remote = journals.save(MobileJson.parseDraft(json).copy(serverVersion = null, syncMessage = null))
            SaveResult.Saved(JournalSnapshot(remote, sections(), "Using the Mac version"))
        }.getOrElse { SaveResult.Failed("Could not read the Mac version") }
    }

    override fun addJournalTag(sectionId: String, name: String) {
        TaskOutbox(context).enqueue(TaskMutation(operation = "journal_tag", payload = JSONObject()
            .put("section_id", sectionId).put("name", name.trim().lowercase())))
        MobileSyncScheduler.enqueue(context)
    }

    override fun tasks(): List<TaskDraft> {
        val a = runCatching { JSONArray(prefs.getString(KEY_TASKS, "[]")) }.getOrDefault(JSONArray())
        return (0 until a.length()).mapNotNull { a.optJSONObject(it)?.let(MobileJson::task) }
    }

    override fun saveTasks(tasks: List<TaskDraft>) {
        val previous = tasks().associateBy { it.id }
        val array = JSONArray()
        tasks.forEach { task ->
            array.put(taskJson(task))
            val before = previous[task.id]
            if (before == null) TaskOutbox(context).enqueue(TaskMutation(operation = "create", payload = taskJson(task)))
            else if (before != task) TaskOutbox(context).enqueue(TaskMutation(taskId = task.id, operation = "update", payload = taskJson(task)))
        }
        prefs.edit().putString(KEY_TASKS, array.toString()).apply()
        MobileSyncScheduler.enqueue(context)
    }

    override fun deleteTask(task: TaskDraft) {
        val remaining = tasks().filterNot { it.id == task.id }
        val array = JSONArray(); remaining.forEach { array.put(taskJson(it)) }
        prefs.edit().putString(KEY_TASKS, array.toString()).apply()
        TaskOutbox(context).enqueue(TaskMutation(taskId = task.id, operation = "delete", payload = JSONObject()))
        MobileSyncScheduler.enqueue(context)
    }

    private fun sections(): List<JournalSection> {
        val raw = prefs.getString(KEY_SECTIONS, null)
        if (raw != null) return MobileJson.config(JSONObject(raw)).sections
        return listOf("people", "places", "food", "chores", "health", "work").map {
            JournalSection(it, it, "tag", "#e0a955")
        }
    }

    private fun taskJson(t: TaskDraft) = JSONObject().put("id", t.id).put("title", t.title)
        .put("due", t.due ?: JSONObject.NULL).put("done", t.done).put("notes", t.notes)
        .put("tags", JSONArray(t.tags)).put("subtasks", JSONArray().also { a ->
            t.subtasks.forEach { a.put(JSONObject().put("text", it.text).put("done", it.done)) }
        })

    private companion object { const val KEY_TASKS = "tasks_v1"; const val KEY_SECTIONS = "sections_v1" }
}
