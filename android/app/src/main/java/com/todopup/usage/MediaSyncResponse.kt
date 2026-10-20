package com.todopup.usage

import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.time.LocalDate
import java.time.OffsetDateTime

/** Validate complete responses before they can acknowledge durable local work. */
internal object MediaSyncResponse {
    private val identity = Regex("[A-Za-z0-9_-]{1,100}")
    private val kinds = listOf("assets", "groups", "places", "messages")

    fun state(value: JSONObject, sent: List<JSONObject>? = null): JSONObject = checked {
        for (kind in kinds) {
            val collection = value.getJSONObject(kind)
            for (id in collection.keys()) record(kind, id, collection.getJSONObject(id))
        }
        if (sent != null) {
            val operations = sent.associateBy { it.getString("op_id") }
            val accepted = strings(value.getJSONArray("accepted"))
            require(accepted.distinct().size == accepted.size && accepted.all { it in operations })
            for (op in accepted) {
                val change = operations.getValue(op)
                require(value.getJSONObject(change.getString("kind")).has(change.getString("id")))
            }
            val conflicts = objects(value.getJSONArray("conflicts"))
            val rejected = conflicts.map { conflict ->
                val op = conflict.getString("op_id")
                val change = operations[op] ?: throw IllegalArgumentException("Unknown rejected operation")
                val kind = change.getString("kind"); val id = change.getString("id")
                require(conflict.opt("kind") == kind && conflict.opt("id") == id && conflict.has("current"))
                if (!conflict.isNull("current")) record(kind, id, conflict.getJSONObject("current"))
                op
            }
            require(rejected.distinct().size == rejected.size && rejected.none { it in accepted })
            require((accepted + rejected).toSet() == operations.keys)
        }
        value
    }

    fun trackingManifest(value: JSONObject): List<JSONObject> = checked {
        val days = objects(value.getJSONArray("days"))
        val dates = days.map { day ->
            val date = day.getString("date")
            require(LocalDate.parse(date).toString() == date)
            require(day.opt("sha256") is String && day.getString("sha256").matches(Regex("[a-f0-9]{64}")))
            require(revision(day.opt("bytes")))
            if (day.has("count")) require(revision(day.opt("count")))
            date
        }
        require(dates.distinct().size == dates.size)
        days
    }

    fun tracking(value: JSONObject, day: JSONObject): List<JSONObject> = checked {
        val rows = objects(value.getJSONArray("samples"))
        if (day.has("count")) require(rows.size.toLong() == day.getLong("count"))
        val ids = rows.map { row ->
            val id = row.getString("id")
            require(row.opt("id") is String && id.matches(identity))
            val at = row.getString("at")
            require(row.opt("at") is String && at.take(10) == day.getString("date"))
            OffsetDateTime.parse(at)
            require(number(row.opt("lat")) in -90.0..90.0 && number(row.opt("lon")) in -180.0..180.0)
            require(number(row.opt("accuracy_m")) >= 0)
            if (row.has("session")) require(row.opt("session") is String)
            if (row.has("mode")) require(row.opt("mode") in setOf("precise", "detailed", "visits"))
            if (row.has("source_device")) require(row.opt("source_device") in setOf("phone", "laptop"))
            for (field in listOf("speed_mps", "speed_accuracy_mps", "bearing")) if (!row.isNull(field)) {
                val metric = number(row.opt(field))
                require(when (field) {
                    "speed_mps" -> TrackingSamplePolicy.speed(metric) != null
                    "speed_accuracy_mps" -> TrackingSamplePolicy.speedAccuracy(metric) != null
                    else -> TrackingSamplePolicy.bearing(metric) != null
                })
            }
            id
        }
        require(ids.distinct().size == ids.size)
        rows
    }

    fun trackingAck(value: JSONObject, sent: List<JSONObject>): List<String> = checked {
        val accepted = strings(value.getJSONArray("accepted"))
        val expected = sent.map { it.getString("id") }.toSet()
        require(value.opt("ok") == true && accepted.distinct().size == accepted.size && accepted.toSet() == expected)
        accepted
    }

    fun maps(value: JSONObject): JSONObject = checked {
        val packs = objects(value.getJSONArray("packs"))
        val ids = packs.map { pack ->
            val id = pack.opt("id")
            require(id is String && id.matches(identity))
            require(pack.opt("name") is String && pack.getString("name").isNotBlank())
            require(pack.opt("status") is String && pack.getString("status").isNotBlank())
            if (!pack.isNull("bytes")) require(revision(pack.opt("bytes")))
            if (pack.getString("status") == "ready") {
                require(revision(pack.opt("bytes")) && pack.getLong("bytes") > 0)
                require(pack.opt("sha256") is String && pack.getString("sha256").matches(Regex("[a-f0-9]{64}")))
            }
            if (pack.has("bounds")) {
                val bounds = pack.getJSONArray("bounds")
                require(bounds.length() == 4)
                val west = number(bounds.get(0)); val south = number(bounds.get(1))
                val east = number(bounds.get(2)); val north = number(bounds.get(3))
                require(west in -180.0..180.0 && east in -180.0..180.0 && south in -90.0..90.0 && north in -90.0..90.0)
                require(west < east && south < north)
            }
            id
        }
        require(ids.distinct().size == ids.size)
        value
    }

    private fun number(value: Any?): Double {
        val number = (value as? Number)?.toDouble() ?: throw IllegalArgumentException("Expected a number")
        require(number.isFinite())
        return number
    }

    private fun record(kind: String, id: String, value: JSONObject) {
        require(id.matches(identity) && value.opt("id") == id && revision(value.opt("rev")))
        MediaMetadataPolicy.apply(kind, value, JSONObject())
        if (kind == "groups" && value.has("tags")) strings(value.getJSONArray("tags"))
        if (kind == "assets" && !value.isNull("location"))
            MediaMetadataPolicy.apply(kind, null, JSONObject().put("location", value.getJSONObject("location")))
    }

    internal fun revision(value: Any?) = (value as? Number)?.toDouble()?.let {
        it.isFinite() && it >= 0 && it % 1.0 == 0.0
    } == true
    internal fun objects(value: JSONArray) = (0 until value.length()).map { value.getJSONObject(it) }
    internal fun strings(value: JSONArray) = (0 until value.length()).map {
        value.get(it) as? String ?: throw IllegalArgumentException("Expected text")
    }
    private fun <T> checked(read: () -> T): T = try { read() } catch (error: Exception) {
        throw IOException("Media response incomplete; saved edits will retry", error)
    }
}
