package com.todopup.usage

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.time.LocalDate

/** One atomic file per day, retained after upload. Receipts belong to a destination and snapshot. */
class UsageArchive(private val root: File) {
    fun save(days: List<DayUsage>) = synchronized(guard) {
        val encoded = days.map { it to UsageJson.encode(it) }
        encoded.forEach { (day, _) -> require(validDate(day.date)) }
        for ((day, value) in encoded) {
            val previous = read(day.date)
            val old = previous?.getJSONObject("usage")?.let(UsageJson::decode)
            // Never replace an already captured day with a later, less complete
            // system query after Android has discarded its detailed events.
            if (old != null && (day.recovered ||
                    (old.detailsAvailable && !day.detailsAvailable))) continue
            if (previous?.getJSONObject("usage")?.toString() == value.toString()) continue
            write(day.date, JSONObject().put("usage", value))
        }
    }

    fun pending(destination: String): List<DayUsage> = synchronized(guard) {
        root.listFiles().orEmpty().filter { it.extension == "json" && validDate(it.nameWithoutExtension) }
            .sortedBy { it.name }.mapNotNull { file ->
                val record = requireNotNull(read(file.nameWithoutExtension))
                val day = UsageJson.decode(record.getJSONObject("usage"))
                val ack = record.optJSONObject("ack")
                day.takeUnless { ack?.optString("destination") == destination &&
                    ack.optString("sha256") == digest(UsageJson.encode(day).toString()) }
            }
    }

    fun acknowledge(sent: List<DayUsage>, destination: String) = synchronized(guard) {
        for (day in sent) {
            val record = read(day.date) ?: continue
            val current = UsageJson.encode(UsageJson.decode(record.getJSONObject("usage"))).toString()
            val snapshot = UsageJson.encode(day).toString()
            if (current != snapshot) continue
            record.put("ack", JSONObject().put("destination", destination).put("sha256", digest(snapshot)))
            write(day.date, record)
        }
    }

    private fun read(date: String): JSONObject? {
        require(validDate(date))
        val file = File(root, "$date.json")
        if (!file.exists()) return null
        // A corrupt file is never treated as an empty archive or overwritten.
        return JSONObject(file.readText()).also {
            require(UsageJson.decode(it.getJSONObject("usage")).date == date) { "Usage archive date mismatch" }
        }
    }

    private fun write(date: String, record: JSONObject) {
        root.mkdirs()
        val file = File(root, "$date.json")
        val temp = File.createTempFile(date, ".tmp", root)
        try {
            FileOutputStream(temp).use { it.write(record.toString().toByteArray()); it.fd.sync() }
            Files.move(temp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } finally { temp.delete() }
    }

    companion object {
        private val guard = Any()
        private fun validDate(date: String) = date.matches(Regex("\\d{4}-\\d{2}-\\d{2}")) &&
            runCatching { LocalDate.parse(date).toString() == date }.getOrDefault(false)
        fun digest(value: String): String = MessageDigest.getInstance("SHA-256")
            .digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
    }
}

internal object UsageJson {
    fun encode(day: DayUsage): JSONObject = JSONObject().put("date", day.date)
        .put("screen_min", day.screenMin).put("unlocks", day.unlocks)
        .put("top_apps", JSONArray(day.topApps.map { app ->
            JSONObject().put("name", app.name).put("label", app.label).put("min", app.min).put("opens", app.opens)
        }))
        .put("first_use", day.firstUse ?: JSONObject.NULL).put("last_use", day.lastUse ?: JSONObject.NULL)
        .put("source", "phone").put("details_available", day.detailsAvailable).put("recovered", day.recovered)

    fun decode(value: JSONObject): DayUsage {
        val apps = value.getJSONArray("top_apps")
        val day = DayUsage(value.getString("date"), value.getInt("screen_min"), value.getInt("unlocks"),
            (0 until apps.length()).map { apps.getJSONObject(it).let { app ->
                AppUsage(app.getString("name"), app.getString("label"), app.getInt("min"), app.getInt("opens"))
            } },
            if (value.isNull("first_use")) null else value.getString("first_use"),
            if (value.isNull("last_use")) null else value.getString("last_use"),
            value.optBoolean("details_available", true), value.optBoolean("recovered", false))
        require(day.screenMin >= 0 && day.unlocks >= 0 && day.topApps.all { it.min >= 0 && it.opens >= 0 })
        return day
    }
}

internal object UsageDelivery {
    fun send(archive: UsageArchive, destination: String, upload: (List<DayUsage>) -> Unit): Int {
        var count = 0
        for (batch in archive.pending(destination).chunked(30)) {
            upload(batch) // Must throw unless every date was acknowledged by the Mac.
            archive.acknowledge(batch, destination)
            count += batch.size
        }
        return count
    }
}
