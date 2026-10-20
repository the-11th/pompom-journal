package com.todopup.usage

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL

/** Actual Android JSON and storage, with isolated data and synthetic transport. */
internal object UnicodeTagChecks {
    fun run(context: Context) {
        val names = listOf("妈妈", "媽媽", "中文 abc42", "閱讀 2026", "\uD840\uDC00")
        val cache = MobileCache(context); val store = JournalSyncStore(context); val queue = TaskOutbox(context)
        cache.saveConfig(MobileJournalConfig(listOf(JournalSection("people", "人物", "tag", "#e0a955"))))
        fun sections() = OutboxMobileRepository(context, scheduleTaskSync = {}).journal("2042-01-02").sections
        val input = JSONArray(names.map { JSONObject().put("section_id", "people").put("name", it).put("kind", "permanent") })
        val saved = store.saveEdited(JournalDraft("2042-01-01", body = "和 @媽媽 散步", mood = 5, autosave = false,
            syncState = SyncState.PENDING, newTags = input.toString()), sections())
        check(saved.tags.getValue("people") == names)
        check(sections().single().tags == names)
        for (mutation in queue.pending()) {
            val response = Response("{\"ok\":true}")
            val result = MobileApiClient("http://127.0.0.1:5001", "test") { response }.applyTaskMutation(mutation)
            check(result is ApiResult.Success<*>)
            check(JSONObject(response.output.toString("UTF-8")).getString("name") == mutation.payload.getString("name"))
            queue.acknowledge(mutation.requestId)
        }
        cache.saveConfig(MobileJournalConfig(listOf(sections().single())))
        val archived = names[1] + " " + names.last()
        val selected = store.saveEdited(saved.copy(newTags = JSONArray().put(JSONObject().put("section_id", "people").put("name", archived).put("kind", "temporary")).toString()), sections())
        JournalTagRegistry(context).archive("people", archived, sections())
        check(archived in sections().single().archivedTags && store.get(saved.date)!!.tags == selected.tags)
        val archive = queue.pending().single()
        val response = Response(JSONObject().put("ok", true).put("tag", JSONObject().put("name", archived)
            .put("section_id", "people").put("archived", true)).toString())
        check(MobileApiClient("http://127.0.0.1:5001", "test") { response }.applyTaskMutation(archive) is ApiResult.Success<*>)
        check(JSONObject(response.output.toString("UTF-8")).getString("name") == archived)
        val restored = store.saveEdited(selected.copy(newTags = JSONArray().put(JSONObject().put("section_id", "people").put("name", archived).put("kind", "temporary")).toString()), sections())
        check(archived !in sections().single().archivedTags && archived !in sections().single().tags)
        check(archived in restored.tags.getValue("people"))
        check(queue.pending().map { it.operation } == listOf("journal_tag_archive", "journal_tag_restore_temporary"))
        val restoreResponse = Response(JSONObject().put("ok", true).put("tag", JSONObject().put("name", archived)
            .put("section_id", "people").put("archived", false)).toString())
        check(MobileApiClient("http://127.0.0.1:5001", "test") { restoreResponse }.applyTaskMutation(queue.pending().last()) is ApiResult.Success<*>)
        check(JSONObject(restoreResponse.output.toString("UTF-8")).getString("name") == archived)
        val reflected = JournalTagRegistry.sharedNames(JSONArray(names + listOf("<bad>", "bad/name", "中\n文")))
        check(reflected == names) { "Photo-to-entry shared tag reflection dropped Chinese names" }
        val before = queue.all().map { it.requestId }
        check(runCatching { store.saveEdited(restored.copy(newTags = "[]", tags = mapOf("people" to listOf("<中文>"))), sections()) }.isFailure)
        check(queue.all().map { it.requestId } == before && store.get(saved.date) == restored)
        store.remove(saved.date)
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
