package com.todopup.usage

import org.json.JSONObject
import org.json.JSONArray
import java.util.UUID

internal class JournalPhotoEditError(val status: Int, message: String) : IllegalArgumentException(message)

/** Entry-scoped details; the bridge supplies the latest draft under the journal lock. */
internal object JournalPhotoEdits {
    fun apply(current: JournalDraft, payload: JSONObject): JournalDraft {
        fun text(key: String, limit: Int): String {
            val value = payload.opt(key) as? String ?: throw JournalPhotoEditError(400, "Photo details must be text")
            if (value.codePointCount(0, value.length) > limit) throw JournalPhotoEditError(400, "Photo details are too long")
            return value
        }
        val asset = text("asset_id", 64)
        if (!asset.matches(Regex("[a-f0-9]{64}"))) throw JournalPhotoEditError(400, "Invalid photo identity")
        val requestedId = if (payload.isNull("block_id")) null else text("block_id", 100).also {
            if (!it.matches(Regex("[A-Za-z0-9_-]{1,100}"))) throw JournalPhotoEditError(400, "Invalid photo block")
        }
        val baseCaption = text("base_caption", 100000)
        val baseLabel = text("base_location_label", 300)
        val caption = text("caption", 100000)
        val label = text("location_label", 300)
        val blocks = try { JSONArray(current.document ?: "[]") } catch (_: Exception) {
            throw JournalPhotoEditError(409, "The saved document needs review before editing this photo")
        }
        val values = (0 until blocks.length()).map { blocks.getJSONObject(it) }
        val matches = values.filter { it.optString("type") == "photo" && it.optString("asset_id") == asset }
        var target = if (requestedId == null) {
            if (matches.size > 1) throw JournalPhotoEditError(400, "Choose the specific photo in this entry")
            matches.firstOrNull()
        } else matches.firstOrNull { it.optString("id") == requestedId }
        if (target == null && matches.isNotEmpty()) throw JournalPhotoEditError(404, "This photo block is no longer in the entry")
        var materialized = false
        if (target == null) {
            // Legacy documents sometimes linked the asset directly. Normal links
            // already point at an existing photo block and never need another one.
            val legacyLinks = values.filter { it.optString("type") == "text" }.flatMap { block ->
                val links = block.optJSONArray("links") ?: JSONArray()
                (0 until links.length()).map { links.getJSONObject(it) }
            }.filter { link ->
                val photos = link.optJSONArray("photos") ?: JSONArray()
                (0 until photos.length()).any { photos.opt(it) == asset }
            }
            if (legacyLinks.isEmpty()) throw JournalPhotoEditError(404, "This photo is no longer in the entry")
            if (baseCaption.isNotEmpty() || baseLabel.isNotEmpty()) throw JournalPhotoEditError(409, "Photo details changed; review them again")
            val id = requestedId ?: UUID.nameUUIDFromBytes((current.date + ":" + asset).toByteArray(Charsets.UTF_8)).toString()
            if (values.any { it.optString("id") == id } || blocks.length() >= 5000)
                throw JournalPhotoEditError(409, "The photo document changed; reopen its details")
            if (caption == baseCaption && label == baseLabel) return current
            target = JSONObject().put("id", id).put("type", "photo").put("asset_id", asset)
                .put("caption", "").put("location_label", "").put("hidden", true)
            blocks.put(target)
            for (link in legacyLinks) {
                val photos = link.getJSONArray("photos")
                for (index in 0 until photos.length()) if (photos.opt(index) == asset) photos.put(index, id)
            }
            materialized = true
        }
        val selected = requireNotNull(target)
        var changed = materialized
        for ((field, base, next) in listOf(Triple("caption", baseCaption, caption), Triple("location_label", baseLabel, label))) {
            if (next == base) continue
            val saved = selected.optString(field, "")
            if (saved != base && saved != next) throw JournalPhotoEditError(409, "Photo details changed; review them again")
            if (saved != next) { selected.put(field, next); changed = true }
        }
        return if (changed) current.copy(document = blocks.toString()) else current
    }
}
