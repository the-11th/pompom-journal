package com.todopup.usage

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** Runs only against the instrumentation's disposable preferences and files. */
internal object JournalPhotoChecks {
    private val asset = "a".repeat(64)
    private val other = "b".repeat(64)
    private fun payload(caption: String = "New caption", label: String = "Park") = JSONObject()
        .put("asset_id", asset).put("block_id", "photo-one")
        .put("base_caption", "Before").put("base_location_label", "Old place")
        .put("caption", caption).put("location_label", label)
    private fun photo() = JSONObject().put("id", "photo-one").put("type", "photo").put("asset_id", asset)
        .put("caption", "Before").put("location_label", "Old place").put("caption_visible", false)
        .put("location_visible", true).put("location_color", "#123456").put("hidden", true)
        .put("tags", JSONObject().put("people", JSONArray().put("Alex")))
        .put("location", JSONObject().put("lat", 31.2).put("lon", 121.5))
    private fun expect(status: Int, block: () -> Unit) {
        val failure = runCatching(block).exceptionOrNull()
        check(failure is JournalPhotoEditError && failure.status == status) { "Expected photo error $status; got $failure" }
    }

    fun run(context: Context) {
        val text = JSONObject().put("id", "words").put("type", "text").put("text", "Newer typing")
            .put("links", JSONArray().put(JSONObject().put("start", 0).put("end", 5).put("photos", JSONArray().put("photo-one"))))
        val document = JSONArray().put(text).put(photo()).put(JSONObject().put("id", "another").put("type", "photo").put("asset_id", other))
        val current = JournalDraft("2026-09-11", title = "Current title", body = "Newer typing", mood = 6,
            tags = mapOf("people" to listOf("Newest")), numbers = mapOf("sleep" to 8.0),
            newTags = "[{\"section_id\":\"people\",\"name\":\"pending\",\"kind\":\"permanent\"}]",
            baseUpdated = "remote", requestId = "pending", syncState = SyncState.CONFLICT,
            document = document.toString(), audioTranscript = "Kept transcript")
        val updated = JournalPhotoEdits.apply(current, payload())
        check(updated.copy(document = current.document) == current) { "Photo details changed unrelated draft fields" }
        val blocks = JSONArray(updated.document)
        check(blocks.getJSONObject(1).getString("caption") == "New caption") { "Entry photo caption was not saved" }
        check(blocks.getJSONObject(1).getString("location_label") == "Park")
        val original = photo()
        val next = blocks.getJSONObject(1)
        original.remove("caption"); original.remove("location_label")
        val retained = JSONObject(next.toString()).apply { remove("caption"); remove("location_label") }
        check(TaskMutationJson.same(original, retained)) { "Photo details changed coordinates, tags or visibility" }
        check(TaskMutationJson.same(blocks.getJSONObject(0), text)) { "Photo details changed text or its links" }
        check(TaskMutationJson.same(blocks.getJSONObject(2), document.getJSONObject(2))) { "Another photo was changed" }
        check(current.document == document.toString()) { "The submitted snapshot was mutated" }

        val concurrent = JSONArray(current.document).apply { getJSONObject(1).put("location_label", "Newer place") }
        val captionOnly = JournalPhotoEdits.apply(current.copy(document = concurrent.toString()), payload(label = "Old place"))
        check(JSONArray(captionOnly.document).getJSONObject(1).getString("location_label") == "Newer place") {
            "A caption-only edit replaced a concurrent place-name edit"
        }
        expect(409) { JournalPhotoEdits.apply(updated, payload(caption = "Unseen overwrite")) }
        check(JournalPhotoEdits.apply(updated, payload()) == updated) { "A lost-ACK retry must be idempotent" }
        expect(404) { JournalPhotoEdits.apply(current.copy(document = JSONArray().put(text.copyWithoutLinks()).toString()), payload()) }
        expect(404) { JournalPhotoEdits.apply(current, payload().put("block_id", "missing")) }
        expect(400) { JournalPhotoEdits.apply(current, payload().put("caption", JSONObject.NULL)) }
        expect(400) { JournalPhotoEdits.apply(current, payload().put("location_label", "x".repeat(301))) }
        expect(400) { JournalPhotoEdits.apply(current, payload().put("asset_id", "not-a-photo")) }

        val legacyText = JSONObject(text.toString())
        legacyText.getJSONArray("links").getJSONObject(0).put("photos", JSONArray().put(asset))
        val linked = current.copy(document = JSONArray().put(legacyText).toString())
        val linkedPayload = payload().put("block_id", "linked-photo").put("base_caption", "").put("base_location_label", "")
        val linkedUpdated = JournalPhotoEdits.apply(linked, linkedPayload)
        val linkedBlocks = JSONArray(linkedUpdated.document)
        val materialized = linkedBlocks.getJSONObject(1)
        check(materialized.getString("id") == "linked-photo" && materialized.getString("asset_id") == asset)
        check(materialized.getBoolean("hidden")) { "Linked-only detail edits must not insert a visible full photo" }
        check(linkedBlocks.getJSONObject(0).getJSONArray("links").getJSONObject(0).getJSONArray("photos").getString(0) == "linked-photo") {
            "Legacy asset reference was not converted to the materialized photo block identity"
        }
        check(JournalPhotoEdits.apply(linkedUpdated, linkedPayload) == linkedUpdated) { "A retry duplicated the linked photo" }

        val store = JournalSyncStore(context)
        val otherDay = current.copy(date = "2026-09-12")
        store.save(current); store.save(otherDay)
        synchronized(JournalSyncStore.guard) { store.save(JournalPhotoEdits.apply(requireNotNull(store.get(current.date)), payload())) }
        check(store.get(otherDay.date) == otherDay) { "Photo details leaked into another journal date" }
        store.remove(current.date); store.remove(otherDay.date)
    }
    private fun JSONObject.copyWithoutLinks() = JSONObject(toString()).put("links", JSONArray())
}
