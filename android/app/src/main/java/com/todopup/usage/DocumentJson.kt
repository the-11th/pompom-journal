package com.todopup.usage

import org.json.JSONArray
import org.json.JSONObject

/** JSON transport key ordering is not a journal edit. Array order remains significant. */
object DocumentJson {
    /** Merge command acknowledgements into a newer photo/caption edit without reviving [] commands. */
    fun acknowledgeText(local: String, sent: String, server: String): String? = runCatching {
        val current = JSONArray(local); val submitted = JSONArray(sent); val committed = JSONArray(server)
        for (before in submitted.objects().filter { it.optString("type") == "text" }) {
            val id = before.optString("id")
            val after = committed.objects().firstOrNull { it.optString("id") == id && it.optString("type") == "text" }
                ?: return@runCatching null
            if (before.optString("text") == after.optString("text")) continue
            val target = current.objects().firstOrNull { it.optString("id") == id && it.optString("type") == "text" }
                ?: return@runCatching null
            if (target.optString("text") != before.optString("text")) return@runCatching null
            val links = target.optJSONArray("links") ?: JSONArray()
            val rebased = TaskRewriteLinks.rebase(before.optString("text"), after.optString("text"),
                links.objects().map { PhotoTextRange(it.getInt("start"), it.getInt("end")) }) ?: return@runCatching null
            links.objects().zip(rebased).forEach { (link, range) -> link.put("start", range.start).put("end", range.end) }
            target.put("text", after.optString("text")).put("links", links)
        }
        current.toString()
    }.getOrNull()

    fun same(left: String?, right: String?): Boolean {
        if (left == right) return true
        if (left == null || right == null) return false
        return runCatching { equivalent(normalized(left), normalized(right)) }.getOrDefault(false)
    }
    private fun normalized(raw: String): JSONArray = JSONArray(raw).also { blocks ->
        for (block in blocks.objects()) {
            fun default(key: String, value: Any) { if (!block.has(key)) block.put(key, value) }
            when (block.optString("type")) {
                "text" -> { default("text", ""); default("links", JSONArray()) }
                "photo", "message" -> {
                    default("caption", ""); default("caption_visible", true); default("hidden", false)
                    default("tags", JSONObject()); default("location_visible", false); default("location_label", "")
                    default("location_color", JSONObject.NULL); default("width", "full"); default("edited_asset_id", JSONObject.NULL)
                }
            }
        }
    }
    private fun equivalent(left: Any?, right: Any?): Boolean = when {
        left is JSONObject && right is JSONObject -> {
            val keys = left.keys().asSequence().toSet()
            keys == right.keys().asSequence().toSet() && keys.all { equivalent(left.opt(it), right.opt(it)) }
        }
        left is JSONArray && right is JSONArray -> left.length() == right.length() && (0 until left.length()).all { equivalent(left.opt(it), right.opt(it)) }
        left is Number && right is Number -> left.toDouble() == right.toDouble()
        else -> left == right
    }
}
