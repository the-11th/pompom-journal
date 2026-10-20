package com.todopup.usage

import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate

/** Missing optional fields migrate; malformed saved values remain recoverable. */
internal object JournalStoredDraft {
    fun validate(date: String, value: JSONObject) {
        require(LocalDate.parse(date).toString() == date && value.opt("date") == date)
        for (field in listOf("title", "body", "audio_transcript")) require(!value.has(field) || value.opt(field) is String)
        for (field in listOf("request_id", "modified_at"))
            require(!value.has(field) || value.opt(field) is String && value.getString(field).isNotBlank())
        for (field in listOf("base_updated", "base_edit_revision", "sync_message"))
            require(value.isNull(field) || value.opt(field) is String)
        require(!value.has("sync_state") || SyncState.entries.any { it.name == value.opt("sync_state") })
        require(value.isNull("server_version") || value.opt("server_version") is JSONObject)
        require(!value.has("autosave") || value.opt("autosave") is Boolean)
        for (field in listOf("document", "new_tags")) require(value.isNull(field) || value.opt(field) is JSONArray)
        if (value.has("tags")) {
            val tags = value.getJSONObject("tags")
            for (key in tags.keys()) {
                val names = tags.getJSONArray(key)
                require((0 until names.length()).all { names.opt(it) is String })
            }
        }
        if (value.has("numbers")) {
            val numbers = value.getJSONObject("numbers")
            for (key in numbers.keys()) require((numbers.opt(key) as? Number)?.toDouble()?.isFinite() == true)
        }
        if (!value.isNull("mood")) {
            val mood = (value.opt("mood") as? Number)?.toDouble()
            require(mood != null && mood in 1.0..7.0 && mood % 1.0 == 0.0)
        }
    }
}
