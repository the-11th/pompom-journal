package com.todopup.usage

import org.json.JSONObject
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.OffsetDateTime

/** Reject offline metadata that the Mac cannot accept, before writing any batch. */
internal object MediaMetadataPolicy {
    private val allowed = mapOf(
        "assets" to setOf("location", "location_label", "captured_at", "is_sticker", "edit_layers", "source_asset_id"),
        "places" to setOf("name", "lat", "lon", "radius_m", "color", "city", "is_city", "archived", "starred"),
        "groups" to setOf("name", "share_entry", "color", "archived", "tags"),
        "messages" to setOf("caption", "date", "imported", "hidden"),
    )

    fun apply(kind: String, old: JSONObject?, patch: JSONObject): JSONObject {
        require(patch.keys().asSequence().all { it in allowed.getValue(kind) }) { "Unknown or read-only record field" }
        for (field in listOf("is_sticker", "is_city", "archived", "share_entry", "imported", "hidden")) {
            require(!patch.has(field) || patch.opt(field) is Boolean) { "${field.replace('_', ' ')} must be true or false" }
        }
        if (patch.has("caption")) {
            val caption = patch.opt("caption")
            require(caption is String && caption.codePointCount(0, caption.length) <= 100000) { "Caption must be text of at most 100,000 characters" }
        }
        if (patch.has("date")) {
            val date = patch.opt("date")
            require(date is String && runCatching { LocalDate.parse(date).toString() == date }.getOrDefault(false)) { "Choose a valid YYYY-MM-DD date" }
        }
        if (patch.has("captured_at") && !patch.isNull("captured_at")) {
            val value = patch.opt("captured_at")
            require(value is String && validTimestamp(value)) { "Choose a valid photo date and time" }
        }
        val record = old?.let { JSONObject(it.toString()) } ?: JSONObject()
        patch.keys().forEach { record.put(it, patch.get(it)) }
        if (kind in setOf("places", "groups")) {
            val name = record.opt("name")
            require(name is String && name.codePointCount(0, name.length) <= 200 && name.isNotBlank()) { "Enter a name of 1–200 characters" }
        }
        if (kind == "places") {
            val point = coordinate(record)
            record.put("lat", point.getDouble("lat")).put("lon", point.getDouble("lon"))
            val radius = if (record.has("radius_m")) number(record.opt("radius_m")) else 100.0
            require(radius != null && radius.isFinite() && radius in 10.0..500000.0) { "Place radius must be between 10 m and 500 km" }
            record.put("radius_m", radius)
        }
        if (record.has("color") && !record.isNull("color")) {
            require(record.opt("color") is String && record.getString("color").matches(Regex("#[a-fA-F0-9]{6}"))) { "Choose a valid color" }
        }
        if (patch.has("location") && !patch.isNull("location")) {
            val point = patch.optJSONObject("location") ?: throw IllegalArgumentException("Location must contain latitude and longitude")
            record.put("location", coordinate(point))
        }
        if (patch.has("location_label")) {
            val label = patch.opt("location_label")
            require(label is String && label.length <= 300) { "Location label must be at most 300 characters" }
        }
        return record
    }

    private fun validTimestamp(value: String): Boolean {
        val normalized = if (value.length > 10) value.take(10) + "T" + value.drop(11) else value
        return runCatching { OffsetDateTime.parse(normalized) }.isSuccess ||
            runCatching { LocalDateTime.parse(normalized) }.isSuccess ||
            runCatching { LocalDate.parse(normalized) }.isSuccess
    }

    private fun number(value: Any?): Double? = when (value) {
        is Number -> value.toDouble()
        is String -> value.toDoubleOrNull()
        else -> null
    }

    private fun coordinate(value: JSONObject): JSONObject {
        val lat = number(value.opt("lat")); val lon = number(value.opt("lon"))
        require(lat != null && lon != null) { "Location must contain latitude and longitude" }
        require(lat.isFinite() && lon.isFinite() && lat in -90.0..90.0 && lon in -180.0..180.0) { "Location is outside the map" }
        return JSONObject().put("lat", lat).put("lon", lon)
    }
}
