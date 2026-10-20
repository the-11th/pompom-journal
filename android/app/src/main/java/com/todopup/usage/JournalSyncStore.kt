package com.todopup.usage

import android.content.Context
import org.json.JSONObject

/**
 * Durable local journal store and outbox. A save is committed before network work
 * is scheduled, so closing the app or losing connectivity cannot discard text.
 */
class JournalSyncStore(context: Context) {
    private val prefs = context.getSharedPreferences("todopup_journal_outbox", Context.MODE_PRIVATE)
    private val tagRegistry = JournalTagRegistry(context)

    fun all(): List<JournalDraft> = synchronized(guard) {
        val root = read()
        root.keys().asSequence().map { key -> MobileJson.parseDraft(root.getJSONObject(key)) }
            .sortedByDescending { it.date }.toList()
    }

    fun get(date: String): JournalDraft? = synchronized(guard) {
        read().optJSONObject(date)?.let(MobileJson::parseDraft)
    }

    /** Save-only is used while typing. [enqueue] changes the same durable copy to PENDING. */
    fun save(draft: JournalDraft): JournalDraft = synchronized(guard) {
        val root = read().put(draft.date, MobileJson.draft(draft))
        check(prefs.edit().putString(KEY_DRAFTS, root.toString()).commit()) { "Could not save draft" }
        draft
    }

    fun saveEdited(draft: JournalDraft, sections: List<JournalSection>): JournalDraft = synchronized(guard) {
        save(tagRegistry.prepare(draft, get(draft.date), sections))
    }

    internal fun acknowledgeTags(accepted: List<JournalTagAddition>) = synchronized(guard) {
        val root = read()
        for (date in root.keys()) {
            val draft = MobileJson.parseDraft(root.getJSONObject(date))
            val additions = JournalTagRegistry.parse(draft.newTags)
            val remaining = additions.filterNot { it in accepted }
            if (remaining.size != additions.size) root.put(date,
                MobileJson.draft(draft.copy(newTags = JournalTagRegistry.encode(remaining))))
        }
        check(prefs.edit().putString(KEY_DRAFTS, root.toString()).commit()) { "Could not acknowledge journal tags" }
    }

    fun enqueue(draft: JournalDraft): JournalDraft = save(draft.copy(
        syncState = if (MobileSyncPolicy.shouldUpload(draft)) SyncState.PENDING else SyncState.DRAFT,
        syncMessage = null, serverVersion = null))

    fun pending(): List<JournalDraft> = all().filter {
        it.syncState == SyncState.PENDING && MobileSyncPolicy.shouldUpload(it)
    }

    fun promoteDraftsForExplicitSync(): Int = synchronized(guard) {
        val drafts = all().filter(MobileSyncPolicy::shouldUploadOnExplicit)
        drafts.forEach { draft ->
            enqueue(draft.copy(requestId = java.util.UUID.randomUUID().toString()))
        }
        drafts.size
    }

    fun remove(date: String) = synchronized(guard) {
        val root = read()
        root.remove(date)
        check(prefs.edit().putString(KEY_DRAFTS, root.toString()).commit()) {
            "Could not remove local entry"
        }
    }

    fun markSynced(date: String, server: JournalDraft, sent: JournalDraft): JournalDraft = synchronized(guard) {
        val local = get(date) ?: return@synchronized server
        val merged = tagRegistry.preserve(JournalAcknowledgement.merge(local, sent, server), local)
        val rewritten = readTaskRewrites()
        val applies = local.requestId == sent.requestId || (local.baseUpdated == sent.baseUpdated && local.syncState != SyncState.CONFLICT)
        if (applies && server.body != sent.body && TaskRewriteLinks.rebase(sent.body, server.body, emptyList()) != null) {
            val versions = rewritten.optJSONObject(date) ?: JSONObject()
            versions.put(local.modifiedAt, true); rewritten.put(date, versions)
        }
        check(prefs.edit().putString(KEY_DRAFTS, read().put(date, MobileJson.draft(merged)).toString())
            .putString(KEY_TASK_REWRITES, rewritten.toString()).commit()) { "Could not save journal acknowledgement" }
        merged
    }

    fun isTaskRewriteVersion(date: String, version: String?): Boolean = synchronized(guard) {
        version != null && readTaskRewrites().optJSONObject(date)?.optBoolean(version) == true
    }

    fun markConflict(date: String, requestId: String, current: JSONObject, message: String): JournalDraft? = synchronized(guard) {
        val local = get(date) ?: return@synchronized null
        if (local.requestId != requestId) return@synchronized local
        save(local.copy(syncState = SyncState.CONFLICT, syncMessage = message, serverVersion = current))
    }

    fun markPermanentFailure(date: String, requestId: String, message: String): JournalDraft? = synchronized(guard) {
        val local = get(date) ?: return@synchronized null
        if (local.requestId != requestId) return@synchronized local
        save(local.copy(syncState = SyncState.PERMANENT_FAILURE, syncMessage = message))
    }

    fun applyRemote(date: String, expected: JournalDraft?, remote: JournalDraft): Boolean = synchronized(guard) {
        val current = get(date)
        if (current?.requestId != expected?.requestId || current?.modifiedAt != expected?.modifiedAt ||
            !MobileSyncPolicy.shouldPullRemote(current)) return@synchronized false
        save(if (current == null) remote else remote.copy(modifiedAt = JournalRevision.afterRemotePull(current, remote))); true
    }
    fun removeSynced(date: String, requestId: String): Boolean = synchronized(guard) {
        val current = get(date) ?: return@synchronized false
        if (current.requestId != requestId || current.syncState != SyncState.SYNCED) return@synchronized false
        remove(date); true
    }

    /** User explicitly resolves a conflict; this creates a fresh idempotency key. */
    fun resolveWith(local: JournalDraft, serverUpdated: String?, serverEditRevision: String? = local.baseEditRevision): JournalDraft = enqueue(local.copy(
        requestId = java.util.UUID.randomUUID().toString(), baseUpdated = serverUpdated,
        baseEditRevision = serverEditRevision,
        syncState = SyncState.PENDING, syncMessage = null, serverVersion = null))

    private fun read(): JSONObject {
        val raw = prefs.getString(KEY_DRAFTS, "{}") ?: "{}"
        return try {
            val root = JSONObject(raw)
            for (date in root.keys()) JournalStoredDraft.validate(date, root.getJSONObject(date))
            var migrated = false
            for (date in root.keys()) {
                val row = root.getJSONObject(date)
                if (!row.has("request_id")) { row.put("request_id", java.util.UUID.randomUUID().toString()); migrated = true }
                if (!row.has("modified_at")) { row.put("modified_at", java.time.Instant.now().toString()); migrated = true }
            }
            if (migrated) check(prefs.edit().putString(KEY_DRAFTS, root.toString()).commit()) { "Could not preserve the upgraded draft identity" }
            root
        } catch (error: Exception) {
            prefs.edit().putString("drafts_corrupt_backup", raw).commit()
            throw IllegalStateException("Saved journal data needs recovery. A backup has been kept on this phone.", error)
        }
    }

    private fun readTaskRewrites(): JSONObject {
        val raw = prefs.getString(KEY_TASK_REWRITES, "{}") ?: "{}"
        return try { JSONObject(raw) } catch (error: Exception) {
            prefs.edit().putString("task_rewrites_corrupt_backup", raw).commit()
            throw IllegalStateException("Saved task-link history needs recovery. A backup has been kept on this phone.", error)
        }
    }

    companion object {
        val guard = Any()
        private const val KEY_DRAFTS = "drafts_v1"
        private const val KEY_TASK_REWRITES = "task_rewrite_versions_v1"
    }
}
