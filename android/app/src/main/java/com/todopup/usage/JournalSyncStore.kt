package com.todopup.usage

import android.content.Context
import org.json.JSONObject

/**
 * Durable local journal store and outbox. A save is committed before network work
 * is scheduled, so closing the app or losing connectivity cannot discard text.
 */
class JournalSyncStore(context: Context) {
    private val prefs = context.getSharedPreferences("todopup_journal_outbox", Context.MODE_PRIVATE)

    @Synchronized
    fun all(): List<JournalDraft> {
        val root = read()
        return root.keys().asSequence().mapNotNull { key ->
            root.optJSONObject(key)?.let { runCatching { MobileJson.parseDraft(it) }.getOrNull() }
        }.sortedByDescending { it.date }.toList()
    }

    @Synchronized
    fun get(date: String): JournalDraft? =
        read().optJSONObject(date)?.let { runCatching { MobileJson.parseDraft(it) }.getOrNull() }

    /** Save-only is used while typing. [enqueue] changes the same durable copy to PENDING. */
    @Synchronized
    fun save(draft: JournalDraft): JournalDraft {
        val root = read().put(draft.date, MobileJson.draft(draft))
        check(prefs.edit().putString(KEY_DRAFTS, root.toString()).commit()) { "Could not save draft" }
        return draft
    }

    @Synchronized
    fun enqueue(draft: JournalDraft): JournalDraft = save(draft.copy(
        syncState = SyncState.PENDING, syncMessage = null, serverVersion = null))

    @Synchronized
    fun pending(): List<JournalDraft> = all().filter { it.syncState == SyncState.PENDING }

    @Synchronized
    fun markSynced(date: String, server: JournalDraft): JournalDraft {
        val local = get(date) ?: server
        // The server acknowledgement applies only to this request. If the user
        // edited again while it was in flight, retain the newer local pending copy.
        if (local.requestId != server.requestId) return local
        return save(server.copy(syncState = SyncState.SYNCED, syncMessage = null, serverVersion = null))
    }

    @Synchronized
    fun markConflict(date: String, requestId: String, current: JSONObject, message: String): JournalDraft? {
        val local = get(date) ?: return null
        if (local.requestId != requestId) return local
        return save(local.copy(syncState = SyncState.CONFLICT, syncMessage = message, serverVersion = current))
    }

    @Synchronized
    fun markPermanentFailure(date: String, requestId: String, message: String): JournalDraft? {
        val local = get(date) ?: return null
        if (local.requestId != requestId) return local
        return save(local.copy(syncState = SyncState.PERMANENT_FAILURE, syncMessage = message))
    }

    /** User explicitly resolves a conflict; this creates a fresh idempotency key. */
    fun resolveWith(local: JournalDraft, serverUpdated: String?): JournalDraft = enqueue(local.copy(
        requestId = java.util.UUID.randomUUID().toString(), baseUpdated = serverUpdated,
        syncState = SyncState.PENDING, syncMessage = null, serverVersion = null))

    private fun read(): JSONObject = runCatching {
        JSONObject(prefs.getString(KEY_DRAFTS, "{}") ?: "{}")
    }.getOrDefault(JSONObject())

    private companion object { const val KEY_DRAFTS = "drafts_v1" }
}
