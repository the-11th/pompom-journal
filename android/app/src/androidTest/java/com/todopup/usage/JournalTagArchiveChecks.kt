package com.todopup.usage

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL

/** Synthetic transport and disposable storage only. */
internal object JournalTagArchiveChecks {
    fun run(context: Context) {
        for (action in listOf("archive", "restore_temporary")) {
            val tag = JSONObject().put("section_id", "people").put("name", "alex").put("archived", action == "archive")
            val connection = Response(JSONObject().put("ok", true).put("tag", tag).toString())
            var path = ""
            val mutation = TaskMutation(requestId = "tag-$action", operation = "journal_tag_$action",
                payload = JSONObject().put("section_id", "people").put("name", "alex"))
            val result = MobileApiClient("http://127.0.0.1:5001", "test") { path = it.path; connection }.applyTaskMutation(mutation)
            check(result is ApiResult.Success<*>) { "Journal tag $action did not use the durable native transport" }
            check(path == "/api/mobile/tags/" + action.replace('_', '-')) { "Tag action must fail closed on an older Mac" }
            val body = JSONObject(connection.output.toString("UTF-8"))
            check(body.getString("request_id") == mutation.requestId && body.getString("section_id") == "people" && body.getString("name") == "alex")
            for (bad in listOf(JSONObject(), JSONObject(tag.toString()).put("archived", action != "archive"),
                JSONObject(tag.toString()).put("archived", "true"), JSONObject(tag.toString()).put("name", "other"),
                JSONObject(tag.toString()).put("section_id", "other"))) {
                val reply = Response(JSONObject().put("ok", true).put("tag", bad).toString())
                val rejected = MobileApiClient("http://127.0.0.1:5001", "test") { reply }.applyTaskMutation(mutation)
                check(rejected is ApiResult.TransientError) { "Malformed tag action ACK discarded its intent: $bad" }
            }
        }
        val base = JournalSection("people", "People", "tag", "#e0a955", tags = listOf("alex"))
        val cache = MobileCache(context); cache.saveConfig(MobileJournalConfig(listOf(base)))
        val journals = JournalSyncStore(context); val queue = TaskOutbox(context)
        fun sections() = OutboxMobileRepository(context, scheduleTaskSync = {}).journal("2041-01-02").sections
        fun archived(name: String) = name in sections().single().archivedTags
        fun commit(name: String, kind: String) = journals.saveEdited(JournalDraft("2041-01-01", body = "Historical text", mood = 5,
            tags = mapOf("people" to listOf(name)), autosave = false, syncState = SyncState.PENDING,
            newTags = JSONArray().put(JSONObject().put("section_id", "people").put("name", name).put("kind", kind)).toString()), sections())
        fun archive(name: String) = JournalTagRegistry(context).archive("people", name, sections())
        val initial = commit("new friend", "permanent")
        val oldAdd = queue.pending().single()
        archive(" NEW FRIEND ")
        check(archived("new friend") && "new friend" !in sections().single().tags) { "Archived tag stayed visible offline" }
        val archivedDraft = requireNotNull(journals.get(initial.date))
        check(archivedDraft.tags == initial.tags && archivedDraft.body == initial.body && archivedDraft.mood == initial.mood) { "Archiving changed journal history" }
        check(archivedDraft.newTags == "[]") { "Archived pending addition could be recommitted later" }
        val firstArchive = queue.pending().single()
        check(firstArchive.operation == "journal_tag_archive" && firstArchive.requestId != oldAdd.requestId)
        archive("new friend")
        check(queue.pending().single().requestId == firstArchive.requestId) { "Repeated archive changed retry identity" }
        queue.acknowledge(oldAdd.requestId)
        journals.markSynced(initial.date, initial.copy(newTags = "[]", baseUpdated = "late-ack"), initial)
        check(archived("new friend") && journals.get(initial.date)!!.newTags == "[]") { "Late add/journal ACK resurrected archived tag" }
        journals.save(initial.copy(date = "2041-01-03"))
        repeat(3) { check(archived("new friend")) }
        check(queue.pending().single().requestId == firstArchive.requestId) { "Legacy draft re-enqueued an archived addition" }
        queue.markFailed(firstArchive.requestId, "Mac unavailable"); check(queue.retryFailed() == 1)
        check(queue.pending().single().requestId == firstArchive.requestId)
        queue.acknowledge(firstArchive.requestId)
        cache.saveConfig(MobileJournalConfig(listOf(base)))
        check(archived("new friend")) { "Stale config cleared the archive before confirmation" }
        val archivedConfig = base.copy(archivedTags = listOf("new friend"), mentionTags = listOf("new friend"))
        cache.saveConfig(MobileJournalConfig(listOf(archivedConfig)))
        cache.saveConfig(MobileJournalConfig(listOf(base.copy(tags = listOf("alex", "new friend")))))
        check(!archived("new friend") && "new friend" in sections().single().tags) { "Confirmed overlay blocked a later Mac restore" }
        check(queue.pending().isEmpty()) { "Legacy draft revived the confirmed tag intent" }
        archive("new friend")
        check(queue.pending().single().requestId != firstArchive.requestId) { "A later explicit archive reused a settled identity" }
        val secondArchive = queue.pending().single()
        val temporary = commit("new friend", "temporary")
        check(!archived("new friend") && "new friend" !in sections().single().tags) { "Temporary restore became a permanent choice" }
        check(temporary.tags.getValue("people") == listOf("new friend"))
        val restore = queue.pending().last()
        check(queue.pending().map { it.operation } == listOf("journal_tag_archive", "journal_tag_restore_temporary"))
        check(restore.operation == "journal_tag_restore_temporary")
        queue.markFailed(secondArchive.requestId, "Update Mac")
        check(queue.sendable().none { it.requestId == restore.requestId }) { "A restore overtook a failed archive" }
        queue.retryFailed()
        check(queue.sendable().map { it.requestId } == listOf(secondArchive.requestId, restore.requestId))
        queue.acknowledge(secondArchive.requestId)
        cache.saveConfig(MobileJournalConfig(listOf(archivedConfig)))
        check(!archived("new friend")) { "Late archive ACK/config hid the explicit temporary restore" }
        queue.acknowledge(restore.requestId)
        cache.saveConfig(MobileJournalConfig(listOf(archivedConfig)))
        check(!archived("new friend")) { "Unconfirmed temporary restore disappeared" }
        val legacyConfig = MobileJson.config(JSONObject().put("sections", JSONArray().put(JSONObject()
            .put("id", "people").put("name", "People").put("type", "tag").put("tags", JSONArray().put("alex")))))
        cache.saveConfig(legacyConfig)
        cache.saveConfig(MobileJournalConfig(listOf(archivedConfig)))
        check(!archived("new friend")) { "A legacy config without archive state incorrectly confirmed the temporary restore" }
        cache.saveConfig(MobileJournalConfig(listOf(base)))
        cache.saveConfig(MobileJournalConfig(listOf(archivedConfig)))
        check(archived("new friend")) { "Confirmed temporary restore blocked a later Mac archive" }
        commit("new friend", "permanent")
        check(!archived("new friend") && "new friend" in sections().single().tags)
        check(queue.pending().single().operation == "journal_tag")
        archive("new friend")
        queue.acknowledge(queue.pending().single().requestId)
        check(journals.get(initial.date)!!.tags.getValue("people") == listOf("new friend"))
        val before = queue.all().map { it.requestId }
        check(runCatching { JournalTagRegistry(context).archive("missing", "alex", sections()) }.isFailure)
        check(runCatching { archive("bad/name") }.isFailure)
        check(queue.all().map { it.requestId } == before) { "Invalid archive partially queued" }
        val decoded = MobileJson.config(JSONObject().put("sections", JSONArray().put(JSONObject()
            .put("id", "people").put("type", "tag").put("archived_tags", JSONArray().put("past")))))
        check(decoded.sections.single().archivedTags == listOf("past"))
        journals.remove("2041-01-01"); journals.remove("2041-01-03")
        context.getSharedPreferences("todopup_mobile_ui", Context.MODE_PRIVATE).edit().clear().commit()
        context.getSharedPreferences("todopup_task_outbox", Context.MODE_PRIVATE).edit().clear().commit()
    }
    private class Response(private val body: String) : HttpURLConnection(URL("http://127.0.0.1:5001/api/mobile/tags")) {
        val output = ByteArrayOutputStream()
        override fun connect() {}
        override fun disconnect() {}
        override fun usingProxy() = false
        override fun getOutputStream() = output
        override fun getResponseCode() = 200
        override fun getInputStream() = ByteArrayInputStream(body.toByteArray())
    }
}
