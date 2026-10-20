package com.todopup.usage

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.os.Bundle
import org.json.JSONArray
import org.json.JSONObject
import java.lang.reflect.InvocationTargetException

/** Real bridge/store behavior on an unpaired disposable QA emulator only. */
class JournalPhotoBridgeInstrumentation : Instrumentation() {
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }
    override fun callActivityOnCreate(activity: Activity, state: Bundle?) {
        super.callActivityOnCreate(activity, Bundle(state ?: Bundle()).apply { putString("screen", "TASKS") })
    }
    override fun onStart() {
        var activity: Activity? = null
        var editor: MediaJournalView? = null
        val result = Bundle()
        var success = false
        var seeded = false
        val date = "2040-09-11"
        val otherDate = "2040-09-12"
        val store = JournalSyncStore(targetContext)
        try {
            check(targetContext.packageName == "com.todopup.usage.qa" && !MobileConfig.isConfigured(targetContext)) {
                "Photo bridge checks require disposable unpaired QA"
            }
            check(android.os.Build.HARDWARE in setOf("ranchu", "goldfish")) { "Photo bridge checks require a disposable emulator" }
            val asset = "a".repeat(64)
            val block = JSONObject().put("id", "photo-one").put("type", "photo").put("asset_id", asset)
                .put("caption", "Before").put("location_label", "Old place")
            val doc = JSONArray().put(JSONObject().put("id", "words").put("type", "text").put("text", "[] unfinished task\nNewer prose")).put(block)
            val old = JournalDraft(date, title = "Newer title", body = "[] unfinished task\nNewer prose", mood = 6,
                tags = mapOf("people" to listOf("alex")), numbers = mapOf("sleep" to 8.0), audioTranscript = "Newer voice",
                newTags = "[{\"section_id\":\"people\",\"name\":\"pending\",\"kind\":\"permanent\"}]",
                document = doc.toString(), autosave = false, requestId = "before", modifiedAt = "2040-09-11T01:00:00Z",
                baseUpdated = "mac-version", syncState = SyncState.CONFLICT, syncMessage = "Review copies",
                serverVersion = JSONObject().put("body", "Mac prose"))
            val other = old.copy(date = otherDate)
            seeded = true
            store.save(old); store.save(other)
            activity = startActivitySync(Intent(targetContext, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
            runOnMainSync { editor = MediaJournalView(activity as MainActivity, date) }
            val handle = MediaJournalView::class.java.getDeclaredMethod("handle", String::class.java, JSONObject::class.java).apply { isAccessible = true }
            fun request(day: String, payload: JSONObject): JSONObject = try {
                handle.invoke(editor, "journal/$day/photo-details", payload) as JSONObject
            } catch (e: InvocationTargetException) { throw e.targetException }
            val payload = JSONObject().put("asset_id", asset).put("block_id", "photo-one")
                .put("base_caption", "Before").put("base_location_label", "Old place")
                .put("caption", "Entry caption").put("location_label", "Entry place")
            val response = request(date, payload)
            check(response.getJSONObject("entry").getString("date") == date)
            val saved = requireNotNull(store.get(date))
            check(JSONArray(saved.document).getJSONObject(1).getString("caption") == "Entry caption")
            check(saved.body == old.body && saved.title == old.title && saved.mood == old.mood && saved.tags == old.tags &&
                saved.numbers == old.numbers && saved.audioTranscript == old.audioTranscript && saved.newTags == old.newTags) {
                "Entry photo bridge overwrote unrelated/newer fields"
            }
            check(saved.autosave && saved.requestId != old.requestId && java.time.Instant.parse(saved.modifiedAt).isAfter(java.time.Instant.parse(old.modifiedAt))) {
                "Entry photo bridge must queue a fresh autosave without committing unfinished tasks"
            }
            check(saved.syncState == SyncState.CONFLICT && saved.serverVersion.toString() == old.serverVersion.toString())
            check(TaskMutationJson.same(MobileJson.draft(requireNotNull(store.get(otherDate))), MobileJson.draft(other))) { "Photo details changed another date" }
            request(date, payload)
            check(TaskMutationJson.same(MobileJson.draft(requireNotNull(store.get(date))), MobileJson.draft(saved))) { "Retrying an accepted photo edit must not produce another revision" }
            fun expect(status: Int, action: () -> Unit) {
                val error = runCatching(action).exceptionOrNull() ?: error("Expected bridge failure $status")
                val data = error.javaClass.getDeclaredField("payload").apply { isAccessible = true }.get(error) as JSONObject
                check(data.getInt("status") == status) { "Expected $status, got $data" }
            }
            expect(409) { request(date, JSONObject(payload.toString()).put("caption", "Stale overwrite")) }
            check(TaskMutationJson.same(MobileJson.draft(requireNotNull(store.get(date))), MobileJson.draft(saved))) { "Stale photo choice mutated the draft" }
            expect(404) { request("2040-09-13", payload) }
            check(store.get("2040-09-13") == null) { "Unknown date was created by photo details" }
            success = true
            result.putString("stream", "PASS: native entry-photo bridge preserves newer fields, conflict state and other dates; autosave/retry/stale/missing safeguards.\n")
        } catch (error: Throwable) {
            result.putString("stream", error.stackTraceToString())
        } finally {
            runOnMainSync {
                editor?.let { MediaJournalView::class.java.getDeclaredMethod("release").apply { isAccessible = true }.invoke(it) }
                activity?.finish()
            }
            if (seeded) { store.remove(date); store.remove(otherDate) }
        }
        finish(if (success) Activity.RESULT_OK else Activity.RESULT_CANCELED, result)
    }
}
