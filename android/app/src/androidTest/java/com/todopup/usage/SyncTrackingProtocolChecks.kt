package com.todopup.usage

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/** Malformed JSON must not become a durable tracking receipt. */
internal object SyncTrackingProtocolChecks {
    private const val DAY = "2026-09-08"
    private fun sample(id: String = "one") = JSONObject().put("id", id).put("at", "${DAY}T12:00:00+08:00")
        .put("lat", 31.2).put("lon", 121.5).put("accuracy_m", 5).put("session", "qa").put("mode", "precise")

    fun run(context: Context) {
        val failures = mutableListOf<String>()
        val badRows = listOf(
            "non-object row" to JSONArray().put(sample()).put(JSONObject.NULL),
            "missing timestamp" to JSONArray().put(sample().apply { remove("at") }),
            "wrong date" to JSONArray().put(sample().put("at", "2026-09-09T12:00:00+08:00")),
            "missing timezone" to JSONArray().put(sample().put("at", "${DAY}T12:00:00")),
            "duplicate identity" to JSONArray().put(sample()).put(sample()),
            "invalid coordinates" to JSONArray().put(sample().put("lat", 91)),
            "invalid accuracy" to JSONArray().put(sample().put("accuracy_m", -1)),
            "partial day" to JSONArray().put(sample()),
        )
        for ((name, rows) in badRows) {
            val store = MediaStore(context); store.root.deleteRecursively()
            val server = Server(rows)
            if (name == "partial day") server.count = 2
            val result = runCatching { sync(context, server).exchange() }
            if (result.isSuccess) failures.add("Accepted $name")
            if (File(store.root, "tracking_remote_days.json").exists()) failures.add("Acknowledged $name")
            if (runCatching { store.samples(DAY, DAY) }.getOrDefault(emptyList()).isNotEmpty())
                failures.add("Invalid $name partly wrote tracking observations")
            store.root.deleteRecursively()
        }
        for (reply in listOf(
            JSONObject().put("ok", false).put("accepted", JSONArray().put("one")),
            JSONObject().put("ok", true).put("accepted", JSONArray()),
            JSONObject().put("ok", true).put("accepted", JSONArray().put("one").put("unrelated")),
            JSONObject().put("ok", true).put("accepted", JSONArray().put(1)),
        )) {
            val store = MediaStore(context); store.root.deleteRecursively()
            store.addSamples(listOf(sample()), DAY)
            val server = Server(JSONArray().put(sample())).apply { uploadReply = reply }
            if (runCatching { sync(context, server).exchange() }.isSuccess) failures.add("Accepted invalid tracking upload ACK: $reply")
            if (File(store.root, "tracking_receipts/$DAY.json").exists()) failures.add("Wrote receipt for invalid upload ACK")
            store.root.deleteRecursively()
        }
        for (legacy in listOf(false, true)) {
            val store = MediaStore(context); store.root.deleteRecursively()
            val server = Server(JSONArray().put(sample())).apply { if (legacy) count = null }
            sync(context, server).exchange()
            check(store.samples(DAY, DAY).single().getString("id") == "one")
            check(MediaStore.read(File(store.root, "tracking_remote_days.json")).getString(DAY) == "a".repeat(64))
            sync(context, server).exchange()
            check(server.dayDownloads == 1) { "Valid ${if (legacy) "legacy" else "counted"} receipt did not skip unchanged day" }
            store.root.deleteRecursively()
        }
        check(failures.isEmpty()) { failures.joinToString("\n") }
    }

    private fun sync(context: Context, server: Server) = MediaSync(context, "http://127.0.0.1:5001", "synthetic-token", server::connection)
    private class Server(private val rows: JSONArray) {
        var count: Int? = rows.length()
        var dayDownloads = 0
        var uploadReply: JSONObject? = null
        fun connection(url: URL) = object : HttpURLConnection(url) {
            private val output = ByteArrayOutputStream()
            private val reply by lazy {
                if (url.path.endsWith("/state")) JSONObject().put("assets", JSONObject()).put("groups", JSONObject())
                    .put("places", JSONObject()).put("messages", JSONObject()).put("accepted", JSONArray()).put("conflicts", JSONArray())
                else if (url.query == "manifest=1") JSONObject().put("days", JSONArray().put(JSONObject()
                    .put("date", DAY).put("bytes", 100).put("sha256", "a".repeat(64)).apply { count?.let { put("count", it) } }))
                else if (output.size() > 0) uploadReply ?: JSONObject().put("ok", true).put("accepted", JSONArray()
                    .apply { JSONObject(output.toString("UTF-8")).getJSONArray("samples").objects().forEach { put(it.getString("id")) } })
                else { dayDownloads++; JSONObject().put("samples", rows) }
            }
            override fun connect() = Unit
            override fun disconnect() = Unit
            override fun usingProxy() = false
            override fun getOutputStream() = output
            override fun getResponseCode() = 200
            override fun getInputStream() = ByteArrayInputStream(reply.toString().toByteArray())
        }
    }
}
