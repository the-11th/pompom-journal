package com.todopup.usage

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Narrow seam between presentation and the durable outbox/sync implementation. */
interface MobileRepository {
    fun journal(date: String): JournalSnapshot
    fun entryDates(): Set<String>
    fun saveJournalDraft(draft: JournalDraft): JournalSnapshot
    fun saveJournal(draft: JournalDraft): SaveResult
    fun resolveJournalConflict(date: String, keepPhone: Boolean): SaveResult
    fun addJournalTag(sectionId: String, name: String)
    fun tasks(): List<TaskDraft>
    fun saveTasks(tasks: List<TaskDraft>)
    fun saveTask(task: TaskDraft, before: TaskDraft?)
    fun deleteTask(task: TaskDraft)
    fun taskConflicts(): List<TaskConflict>
    fun resolveTaskConflict(requestId: String, keepPhone: Boolean)
}

object MobileRepositoryProvider {
    @Volatile var factory: ((Context) -> MobileRepository)? = null
    fun create(context: Context): MobileRepository =
        factory?.invoke(context.applicationContext) ?: OutboxMobileRepository(context.applicationContext)
}

/** Offline-first adapter: commit locally, enqueue, then let WorkManager sync. */
class OutboxMobileRepository(
    private val context: Context,
    private val scheduleTaskSync: () -> Unit = { MobileSyncScheduler.enqueue(context) },
) : MobileRepository {
    private val journals = JournalSyncStore(context)
    private val prefs = context.getSharedPreferences("todopup_mobile_ui", Context.MODE_PRIVATE)

    override fun journal(date: String): JournalSnapshot {
        val draft = journals.get(date) ?: JournalDraft(date, baseEditRevision = cachedConfig().emptyEditRevision)
        return JournalSnapshot(draft, sections(), draft.syncMessage ?: when (draft.syncState) {
            SyncState.DRAFT -> "Saved on this phone"
            SyncState.PENDING -> "Queued for Mac"
            SyncState.SYNCED -> "Synced with Mac"
            SyncState.CONFLICT -> "Needs review · Mac entry changed"
            SyncState.PERMANENT_FAILURE -> "Could not sync · check connection"
        })
    }

    override fun entryDates(): Set<String> =
        JournalCalendarEntries.dates(cachedConfig().calendarDates, journals.all())

    override fun saveJournal(draft: JournalDraft): SaveResult {
        if (!MobileSyncPolicy.shouldUpload(draft)) {
            val saved = saveJournalDraft(draft)
            return SaveResult.Saved(saved.copy(message = "Empty draft · nothing to sync"))
        }
        val queued = journals.enqueue(draft.copy(requestId = UUID.randomUUID().toString()))
        val syncWorkId = if (MobileConfig.isConfigured(context))
            MobileSyncScheduler.syncNow(context, queued.date) else null
        return SaveResult.Saved(JournalSnapshot(queued, sections(),
            if (syncWorkId != null) "Saved on phone · syncing with Mac"
            else "Saved on phone · connect Mac to sync"), syncWorkId)
    }

    override fun saveJournalDraft(draft: JournalDraft): JournalSnapshot = synchronized(JournalSyncStore.guard) {
        val previous = journals.get(draft.date)
        val saved = journals.saveEdited(draft.copy(requestId = UUID.randomUUID().toString(),
            modifiedAt = JournalRevision.afterAcknowledgement(previous?.modifiedAt ?: draft.modifiedAt, true),
            syncState = if (previous?.syncState == SyncState.CONFLICT) SyncState.CONFLICT else SyncState.DRAFT,
            syncMessage = previous?.syncMessage, serverVersion = previous?.serverVersion), sections())
        JournalSnapshot(saved, sections(), "Draft saved on this phone")
    }

    override fun resolveJournalConflict(date: String, keepPhone: Boolean): SaveResult {
        val local = journals.get(date) ?: return SaveResult.Failed("Local draft is missing")
        val current = local.serverVersion ?: return SaveResult.Failed("Mac version is unavailable")
        return if (keepPhone) {
            val queued = journals.resolveWith(local, current.optString("updated").takeIf(String::isNotBlank),
                MobileJson.parseDraft(JSONObject(current.toString()).put("date", date)).baseEditRevision)
            val syncWorkId = MobileSyncScheduler.syncNow(context, date)
            SaveResult.Saved(JournalSnapshot(queued, sections(),
                "Saved on phone · syncing with Mac"), syncWorkId)
        } else runCatching {
            val json = JSONObject(current.toString()).put("date", date)
                .put("request_id", local.requestId).put("sync_state", SyncState.SYNCED.name)
                .put("base_updated", current.optString("updated"))
            val remote = journals.save(MobileJson.parseDraft(json).copy(serverVersion = null, syncMessage = null))
            SaveResult.Saved(JournalSnapshot(remote, sections(), "Using the Mac version"))
        }.getOrElse { SaveResult.Failed("Could not read the Mac version") }
    }

    override fun addJournalTag(sectionId: String, name: String) {
        TaskOutbox(context).enqueueJournalTag(JournalTagAddition(sectionId, JournalTagRegistry.normalizeName(name)), deliberate = true)
        MobileSyncScheduler.enqueue(context)
    }

    override fun tasks(): List<TaskDraft> = synchronized(TaskOutbox.guard) {
        MobileCache(context).tasks()
    }

    override fun saveTasks(tasks: List<TaskDraft>) {
        synchronized(TaskOutbox.guard) {
            val previous = tasks().associateBy { it.id }
            tasks.forEach { saveTask(it, previous[it.id]) }
        }
    }

    override fun saveTask(task: TaskDraft, before: TaskDraft?) {
        val changed = synchronized(TaskOutbox.guard) {
            val mutation = TaskMutationJson.edit(task, before) ?: return@synchronized false
            val current = tasks()
            val latest = current.firstOrNull { it.id == task.id }
            val merged = if (before != null && latest != null)
                TaskEdits.overlay(latest, task, TaskEdits.changedFields(before, task)) else task
            TaskOutbox(context).enqueue(mutation)
            MobileCache(context).saveTasks(current.filterNot { it.id == task.id } + merged)
            true
        }
        if (changed) scheduleTaskSync()
    }

    override fun deleteTask(task: TaskDraft) {
        synchronized(TaskOutbox.guard) {
            TaskOutbox(context).enqueue(TaskMutationJson.deletion(task))
            MobileCache(context).saveTasks(tasks().filterNot { it.id == task.id })
        }
        scheduleTaskSync()
    }

    override fun taskConflicts(): List<TaskConflict> = synchronized(TaskOutbox.guard) {
        val all = TaskOutbox(context).all()
        all.filter { it.conflict }.distinctBy(TaskMutationJson::targetId).map { taskConflict(it, all) }
    }

    private fun taskConflict(failed: TaskMutation, all: List<TaskMutation>): TaskConflict {
        val taskId = requireNotNull(TaskMutationJson.targetId(failed))
        val remote = failed.serverVersion?.takeIf { !it.optString("id").isNullOrBlank() }?.let(MobileJson::task)
        val changes = all.filter { TaskMutationJson.targetId(it) == taskId }
        var local = remote
        for (change in changes) local = when (change.operation) {
            "delete" -> null
            "create" -> TaskMutationJson.snapshot(change)
            "update" -> TaskMutationJson.snapshot(change).let { snapshot ->
                TaskEdits.overlay(local ?: snapshot, snapshot, TaskMutationJson.fields(change))
            }
            else -> local
        }
        val resolution = when {
            local == null -> "apply"
            remote == null || remote.status == "expired" -> "copy"
            remote.status == "completed" -> "reopen"
            else -> "apply"
        }
        if (resolution in setOf("copy", "reopen")) local = local?.copy(done = false,
            status = "active", difficulty = null, recurrence = if (resolution == "copy") null else local.recurrence)
        val fields = if (local != null && remote != null) TaskEdits.changedFields(remote, local)
            else changes.flatMap(TaskMutationJson::fields).distinct()
        return TaskConflict(failed.requestId, changes.last().operation, local, remote, fields,
            failed.permanentError ?: "Review task changes", resolution)
    }

    override fun resolveTaskConflict(requestId: String, keepPhone: Boolean) {
        val queued = synchronized(TaskOutbox.guard) {
            val outbox = TaskOutbox(context)
            val all = outbox.all()
            val failed = all.firstOrNull { it.requestId == requestId && it.conflict }
                ?: throw IllegalStateException("This task conflict is already resolved")
            val taskId = requireNotNull(TaskMutationJson.targetId(failed))
            val review = taskConflict(failed, all)
            var chosen = if (keepPhone) review.local else review.remote
            if (keepPhone && review.resolution == "copy") chosen = chosen?.copy(id = UUID.randomUUID().toString())
            val mutation = if (!keepPhone) null else when {
                chosen == null && review.remote != null -> TaskMutationJson.deletion(review.remote)
                chosen == null -> null
                review.resolution == "copy" -> TaskMutationJson.edit(chosen, null)
                else -> TaskMutationJson.edit(chosen, review.remote)
            }
            outbox.replaceTaskChanges(taskId, mutation)
            val remaining = tasks().filterNot { it.id == taskId }.toMutableList()
            if (keepPhone && review.resolution == "copy") review.remote?.let { remaining.add(it) }
            chosen?.let { remaining.add(it) }
            MobileCache(context).saveTasks(remaining)
            mutation != null
        }
        if (queued) scheduleTaskSync()
    }

    private fun sections(): List<JournalSection> = synchronized(JournalSyncStore.guard) {
        val cached = cachedConfig()
        val sections = cached.sections.ifEmpty { listOf("people", "places", "food", "chores", "health", "work").map {
            JournalSection(it, it, "tag", "#e0a955")
        } }
        JournalTagRegistry(context).project(sections, journals.all())
    }

    private fun cachedConfig(): MobileJournalConfig = prefs.getString(KEY_SECTIONS, null)
        ?.let { runCatching { MobileJson.config(JSONObject(it)) }.getOrNull() }
        ?: MobileJournalConfig(emptyList())

    private companion object { const val KEY_SECTIONS = "sections_v1" }
}
