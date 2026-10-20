package com.todopup.usage

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** Permanent-tag regressions run only in the instrumentation's isolated storage. */
internal object JournalTagChecks {
    fun run(context: Context) {
        val cache = MobileCache(context)
        val sections = listOf(JournalSection("people", "people", "tag", "#e0a955", tags = listOf("alex")))
        cache.saveConfig(MobileJournalConfig(sections))
        val store = JournalSyncStore(context)
        val permanent = JSONObject().put("section_id", "people").put("name", "qa friend").put("kind", "permanent")
        val temporary = JSONObject().put("section_id", "people").put("name", "qa visitor").put("kind", "temporary")
        val first = JournalDraft("2026-10-01", tags = mapOf("people" to listOf("qa friend", "qa visitor")),
            newTags = JSONArray().put(permanent).put(temporary).toString(), autosave = false,
            syncState = SyncState.PENDING)
        store.save(first)
        val anotherDay = OutboxMobileRepository(context, scheduleTaskSync = {}).journal("2026-10-02")
        check(anotherDay.sections.single().tags == listOf("alex", "qa friend")) {
            "A committed permanent tag must remain available on another day offline"
        }
        check(anotherDay.draft.tags.isEmpty()) { "Permanent choices must not select themselves on other days" }
        check("qa visitor" !in anotherDay.sections.single().tags) { "Temporary tags must remain entry-only" }
        val queued = TaskOutbox(context).pending().single()
        check(queued.operation == "journal_tag" && queued.payload.getString("name") == "qa friend")
        val later = store.saveEdited(first.copy(body = "[] unfinished task", newTags = "[]", autosave = true,
            requestId = "later-save"), anotherDay.sections)
        check(later.autosave) { "A permanent tag must not convert later typing into a task-spawning commit" }
        check(JournalTagRegistry.parse(later.newTags) == listOf(JournalTagAddition("people", "qa friend"))) {
            "A clean save discarded the pending permanent addition"
        }
        check(later.tags["people"] == listOf("qa friend", "qa visitor"))
        check(OutboxMobileRepository(context).journal("2026-10-02").sections.single().tags.contains("qa friend"))
        check(TaskOutbox(context).pending().single().requestId == queued.requestId) { "Reopening duplicated the durable tag operation" }

        val typing = store.saveEdited(later.copy(requestId = "newer-typing", body = "[] unfinished task text",
            newTags = JSONArray().put(JSONObject().put("section_id", "people").put("name", " NEXT FRIEND ")
                .put("kind", "permanent")).toString()), anotherDay.sections)
        check("next friend" in typing.tags.getValue("people")) { "New tag selections must normalize like the server" }
        check("next friend" !in OutboxMobileRepository(context).journal("2026-10-02").sections.single().tags) {
            "Autosaving an unfinished tag field must not create a permanent choice"
        }
        store.markSynced(first.date, later.copy(newTags = "[]", baseUpdated = "mac-ack"), later)
        check(JournalTagRegistry.parse(store.get(first.date)!!.newTags).map { it.name }.toSet() == setOf("qa friend", "next friend")) {
            "An older journal acknowledgement discarded committed or newer tag typing"
        }
        check(store.get(first.date)!!.body == typing.body)
        TaskOutbox(context).acknowledge(queued.requestId)
        check(TaskOutbox(context).pending().isEmpty())
        check(JournalTagRegistry.parse(store.get(first.date)!!.newTags).map { it.name } == listOf("next friend"))
        check("qa friend" in OutboxMobileRepository(context).journal("2026-10-02").sections.single().tags) {
            "A tag vanished between acknowledgement and section-config refresh"
        }
        cache.saveConfig(MobileJournalConfig(sections))
        check("qa friend" in OutboxMobileRepository(context).journal("2026-10-02").sections.single().tags) {
            "An older section snapshot erased an acknowledged local tag"
        }
        cache.saveConfig(MobileJournalConfig(listOf(sections.single().copy(tags = listOf("alex", "qa friend")))))
        cache.saveConfig(MobileJournalConfig(sections))
        check("qa friend" !in OutboxMobileRepository(context).journal("2026-10-02").sections.single().tags) {
            "A confirmed local overlay prevented a later Mac archive from taking effect"
        }
        check(TaskOutbox(context).pending().isEmpty()) { "An old saved draft requeued an acknowledged tag" }

        val normalized = store.saveEdited(JournalDraft("2026-10-03", autosave = false,
            newTags = JSONArray().put(JSONObject().put("section_id", "people").put("name", "  NEXT FRIEND  ")
                .put("kind", "permanent")).toString()), sections)
        check(normalized.tags == mapOf("people" to listOf("next friend")))
        val second = TaskOutbox(context).pending().single()
        store.saveEdited(normalized.copy(newTags = "[]", tags = emptyMap(), body = "", autosave = true), sections)
        check(TaskOutbox(context).pending().single().requestId == second.requestId) {
            "Clearing an entry must not discard its separately committed permanent tag"
        }
        check("next friend" in OutboxMobileRepository(context).journal("2026-10-04").sections.single().tags)
        TaskOutbox(context).markFailed(second.requestId, "Mac unavailable")
        check(TaskOutbox(context).retryFailed() == 1)
        check(TaskOutbox(context).pending().single().requestId == second.requestId) { "Retry changed the tag operation identity" }

        store.remove("2026-10-01"); store.remove("2026-10-03")
        TaskOutbox(context).acknowledge(second.requestId)

        val stillPending = store.saveEdited(first.copy(date = "2026-10-05", newTags = JSONArray().put(permanent).toString()), sections)
        val pendingTag = TaskOutbox(context).pending().single()
        TaskOutbox(context).acknowledge(pendingTag.requestId)
        check(store.get(stillPending.date)!!.syncState == SyncState.PENDING && store.get(stillPending.date)!!.newTags == "[]")
        cache.saveConfig(MobileJournalConfig(listOf(sections.single().copy(tags = listOf("alex", "qa friend")))))
        cache.saveConfig(MobileJournalConfig(sections))
        repeat(3) { check("qa friend" !in OutboxMobileRepository(context).journal("2026-10-06").sections.single().tags) }
        check(TaskOutbox(context).pending().isEmpty()) { "Legacy recovery resurrected a Mac-archived tag from an unsynced explicit draft" }

        val invalid = first.copy(date = "2026-10-07", tags = mapOf("people" to listOf("not/allowed")))
        check(runCatching { store.saveEdited(invalid, sections) }.isFailure)
        check(TaskOutbox(context).pending().isEmpty() && store.get(invalid.date) == null) {
            "Validation failure partially persisted a global tag request"
        }
        store.remove(stillPending.date)
        context.getSharedPreferences("todopup_mobile_ui", Context.MODE_PRIVATE).edit().clear().commit()
        context.getSharedPreferences("todopup_task_outbox", Context.MODE_PRIVATE).edit().clear().commit()
    }
}
