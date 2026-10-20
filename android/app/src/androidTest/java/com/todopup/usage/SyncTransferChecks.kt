package com.todopup.usage

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL

/** Binary transfer faults over disposable files; no map provider or network is used. */
internal object SyncTransferChecks {
    private enum class Fault { NONE, TRUNCATE, INTERRUPT, WRONG_RANGE, IGNORE_RANGE, CORRUPT }

    fun run(context: Context) {
        val failures = mutableListOf<String>()
        val scenarios = listOf(
            "truncated response" to listOf(Fault.TRUNCATE, Fault.NONE),
            "cable interruption" to listOf(Fault.INTERRUPT, Fault.NONE),
            "wrong resumed range" to listOf(Fault.TRUNCATE, Fault.WRONG_RANGE, Fault.NONE),
            "server ignores range" to listOf(Fault.TRUNCATE, Fault.IGNORE_RANGE),
            "checksum failure" to listOf(Fault.CORRUPT, Fault.NONE),
        )
        for ((name, faults) in scenarios) {
            val store = MediaStore(context); store.root.deleteRecursively()
            try {
                val server = Server(faults)
                val sync = { MediaSync(context, "http://127.0.0.1:5001", "synthetic-token", server::connection) }
                repeat(faults.size - 1) {
                    check(runCatching { sync().maps {} }.isFailure)
                    check(MediaStore(context).maps().getJSONArray("packs").getJSONObject(0).getString("status") == "not_downloaded")
                    check(!File(store.root, "maps/map.receipt.json").exists())
                }
                check(sync().maps {} == 1)
                check(File(store.root, "maps/map.pmtiles").readBytes().contentEquals(server.bytes))
                check(MediaStore(context).maps().getJSONArray("packs").getJSONObject(0).getString("status") == "ready")
                if (faults.first() != Fault.CORRUPT) check(server.ranges.drop(1).all { it?.startsWith("bytes=") == true })
                else check(server.ranges.all { it == null })
                check(sync().maps {} == 0) { "An acknowledged map downloaded again" }
            } catch (error: Throwable) { failures.add("$name: $error") }
            finally { store.root.deleteRecursively() }
        }
        val store = MediaStore(context); store.root.deleteRecursively()
        try {
            val wrongSize = Server(listOf(Fault.NONE)).apply { declaredBytes += 10 }
            check(runCatching { MediaSync(context, "http://127.0.0.1:5001", "synthetic-token", wrongSize::connection).maps {} }.isFailure) {
                "A map with a mismatched manifest size was reported as transferred"
            }
            check(!File(store.root, "maps/map.receipt.json").exists())
        } catch (error: Throwable) { failures.add("manifest size: $error") }
        finally { store.root.deleteRecursively() }
        for (fault in listOf("partial", "missing range", "wrong start", "wrong end")) {
            store.root.deleteRecursively()
            try {
                val server = PreviewServer(fault)
                val exchange = { MediaSync(context, "http://127.0.0.1:5001", "synthetic-token", server::connection).exchange() }
                check(runCatching { exchange() }.isFailure) { "A $fault preview response was published as complete" }
                val preview = File(store.root, "media/${server.id}/preview.webp")
                check(!preview.isFile)
                server.fault = null
                exchange()
                check(preview.readBytes().contentEquals(server.preview))
            } catch (error: Throwable) { failures.add("preview $fault: $error") }
            finally { store.root.deleteRecursively() }
        }
        val pack = JSONObject().put("id", "map").put("name", "Synthetic map").put("status", "ready")
            .put("bytes", 131073).put("sha256", "a".repeat(64))
        val malformed = listOf(
            "non-object row" to JSONObject().put("packs", JSONArray().put(JSONObject.NULL)),
            "missing list" to JSONObject(),
            "unsafe identity" to JSONObject().put("packs", JSONArray().put(JSONObject(pack.toString()).put("id", "../map"))),
            "non-text name" to JSONObject().put("packs", JSONArray().put(JSONObject(pack.toString()).put("name", 5))),
            "non-number bytes" to JSONObject().put("packs", JSONArray().put(JSONObject(pack.toString()).put("bytes", "131073"))),
            "invalid checksum" to JSONObject().put("packs", JSONArray().put(JSONObject(pack.toString()).put("sha256", "bad"))),
            "duplicate packs" to JSONObject().put("packs", JSONArray().put(pack).put(pack)),
        )
        for ((name, manifest) in malformed) {
            store.root.deleteRecursively()
            try {
                val cached = File(store.root, "maps.json")
                MediaStore.write(cached, JSONObject().put("packs", JSONArray()))
                val before = cached.readBytes()
                val server = Server(listOf(Fault.NONE)).apply { overrideManifest = manifest }
                check(runCatching { MediaSync(context, "http://127.0.0.1:5001", "synthetic-token", server::connection).maps {} }.isFailure)
                check(cached.readBytes().contentEquals(before)) { "Malformed $name replaced the last usable map manifest" }
            } catch (error: Throwable) { failures.add("map manifest $name: $error") }
            finally { store.root.deleteRecursively() }
        }
        for (fault in listOf(Fault.TRUNCATE, Fault.INTERRUPT, Fault.CORRUPT)) {
            store.root.deleteRecursively()
            try {
                val original = Server(listOf(Fault.NONE))
                MediaSync(context, "http://127.0.0.1:5001", "synthetic-token", original::connection).maps {}
                val originalHash = MediaStore.digest(original.bytes)
                val replacement = Server(listOf(fault, Fault.NONE)).apply { bytes[0] = (bytes[0].toInt() xor 127).toByte() }
                val replace = { MediaSync(context, "http://127.0.0.1:5001", "synthetic-token", replacement::connection).maps {} }
                check(runCatching { replace() }.isFailure)
                val retained = MediaStore(context).maps().getJSONArray("packs").getJSONObject(0)
                check(retained.getString("status") == "ready" && retained.getString("sha256") == originalHash) {
                    "A $fault replacement hid the previous offline map before new bytes were complete"
                }
                check(File(store.root, "maps/map.pmtiles").readBytes().contentEquals(original.bytes))
                check(replace() == 1)
                check(MediaStore(context).maps().getJSONArray("packs").getJSONObject(0).getString("sha256") == MediaStore.digest(replacement.bytes))
                check(File(store.root, "maps/map.pmtiles").readBytes().contentEquals(replacement.bytes))
                replacement.overrideManifest = JSONObject().put("packs", JSONArray())
                check(replace() == 0)
                check(MediaStore(context).maps().getJSONArray("packs").length() == 0) { "A real remote removal kept the map listed" }
            } catch (error: Throwable) { failures.add("map replacement $fault: $error") }
            finally { store.root.deleteRecursively() }
        }
        store.root.deleteRecursively()
        try {
            fun manifest(server: Server) = JSONObject().put("packs", JSONArray(listOf("map", "other").map { id ->
                JSONObject().put("id", id).put("name", id).put("status", "ready")
                    .put("bytes", server.bytes.size).put("sha256", MediaStore.digest(server.bytes))
            }))
            val original = Server(listOf(Fault.NONE, Fault.NONE)).apply { overrideManifest = manifest(this) }
            MediaSync(context, "http://127.0.0.1:5001", "synthetic-token", original::connection).maps {}
            val replacement = Server(listOf(Fault.NONE, Fault.INTERRUPT, Fault.NONE)).apply {
                bytes[0] = (bytes[0].toInt() xor 127).toByte()
                overrideManifest = manifest(this)
            }
            val replace = { MediaSync(context, "http://127.0.0.1:5001", "synthetic-token", replacement::connection).maps {} }
            check(runCatching { replace() }.isFailure)
            val available = MediaStore(context).maps().getJSONArray("packs").objects().associateBy { it.getString("id") }
            check(available.values.all { it.getString("status") == "ready" })
            check(available.getValue("map").getString("sha256") == MediaStore.digest(replacement.bytes))
            check(available.getValue("other").getString("sha256") == MediaStore.digest(original.bytes))
            check(replace() == 1) { "The completed first pack downloaded again after the second pack failed" }
        } catch (error: Throwable) { failures.add("partial multi-pack replacement: $error") }
        finally { store.root.deleteRecursively() }
        try {
            val file = File(store.root, "maps/versions.pmtiles").apply { parentFile!!.mkdirs(); writeBytes(byteArrayOf(1, 2, 3, 4)) }
            val originalHash = MediaStore.digest(file)
            val receipt = File(file.parentFile, "versions.receipt.json")
            MediaStore.write(receipt, JSONObject().put("sha256", originalHash))
            val opened = MediaFileResponse.map(file, originalHash, offset = 0, length = 4)
            check(opened.statusCode == 200)
            val next = File(file.path + ".next").apply { writeBytes(byteArrayOf(5, 6, 7, 8)) }
            val nextHash = MediaStore.digest(next)
            synchronized(MediaFileResponse.mapGuard) {
                java.nio.file.Files.move(next.toPath(), file.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING,
                    java.nio.file.StandardCopyOption.ATOMIC_MOVE)
                MediaStore.write(receipt, JSONObject().put("sha256", nextHash))
            }
            check(opened.data.use { it.readBytes() }.contentEquals(byteArrayOf(1, 2, 3, 4))) { "An already-open range switched to the replacement archive" }
            val stale = MediaFileResponse.map(file, originalHash, offset = 0, length = 4)
            check(stale.statusCode == 409 && stale.responseHeaders["X-Datapom-Error"] == "map_version_changed")
            for (version in listOf(null, "", nextHash)) {
                val current = MediaFileResponse.map(file, version, offset = 0, length = 4)
                check(current.statusCode == 200 && current.data.use { it.readBytes() }.contentEquals(byteArrayOf(5, 6, 7, 8)))
            }
        } catch (error: Throwable) { failures.add("map range version guard: $error") }
        finally { store.root.deleteRecursively() }
        check(failures.isEmpty()) { failures.joinToString("\n") }
    }

    private class PreviewServer(var fault: String?) {
        private val original = ByteArray(1024) { it.toByte() }
        val preview = ByteArray(333) { (it * 31).toByte() }
        val id = MediaStore.digest(original)
        fun connection(url: URL) = object : HttpURLConnection(url) {
            private val output = java.io.ByteArrayOutputStream()
            private val isPreview = url.path.endsWith("/preview.webp")
            private val body by lazy {
                when {
                    url.path.endsWith("/state") -> JSONObject().put("assets", JSONObject().put(id, JSONObject().put("id", id).put("rev", 0)))
                        .put("groups", JSONObject()).put("places", JSONObject()).put("messages", JSONObject())
                        .put("accepted", JSONArray()).put("conflicts", JSONArray()).toString().toByteArray()
                    url.path.endsWith("/tracking") -> JSONObject().put("days", JSONArray()).toString().toByteArray()
                    url.path.endsWith("/original") -> original
                    isPreview -> if (fault == null) preview else preview.copyOf(preview.size / 2)
                    else -> ByteArray(10)
                }
            }
            override fun connect() = Unit
            override fun disconnect() = Unit
            override fun usingProxy() = false
            override fun getOutputStream() = output
            override fun getResponseCode() = if (isPreview && fault != null) 206 else 200
            override fun getInputStream() = ByteArrayInputStream(body)
            override fun getContentLengthLong() = body.size.toLong()
            override fun getHeaderField(name: String?): String? {
                if (!name.equals("Content-Range", true) || !isPreview) return null
                return when (fault) {
                    "missing range" -> null
                    "wrong start" -> "bytes 5-${body.size + 4}/${preview.size}"
                    "wrong end" -> "bytes 0-${body.size}/${preview.size}"
                    else -> "bytes 0-${body.size - 1}/${preview.size}"
                }
            }
        }
    }

    private class Server(faults: List<Fault>) {
        val bytes = ByteArray(131073) { (it * 31).toByte() }
        var declaredBytes = bytes.size
        var overrideManifest: JSONObject? = null
        val ranges = mutableListOf<String?>()
        private val faults = java.util.ArrayDeque(faults)
        fun connection(url: URL): HttpURLConnection = object : HttpURLConnection(url) {
            private val map = url.path.endsWith("/maps")
            private val response by lazy {
                if (map) Triple(200, (overrideManifest ?: JSONObject().put("packs", JSONArray().put(JSONObject()
                    .put("id", "map").put("name", "Synthetic map").put("status", "ready")
                    .put("bytes", declaredBytes).put("sha256", MediaStore.digest(bytes))))).toString().toByteArray(), Fault.NONE)
                else {
                    val range = getRequestProperty("Range"); ranges.add(range)
                    val fault = faults.pollFirst() ?: Fault.NONE
                    val offset = if (fault == Fault.IGNORE_RANGE) 0 else range?.removePrefix("bytes=")?.removeSuffix("-")?.toInt() ?: 0
                    val body = bytes.copyOfRange(offset, bytes.size)
                    if (fault == Fault.CORRUPT) body[0] = (body[0].toInt() xor 1).toByte()
                    Triple(if (offset > 0) 206 else 200, body, fault)
                }
            }
            override fun connect() = Unit
            override fun disconnect() = Unit
            override fun usingProxy() = false
            override fun getResponseCode() = response.first
            override fun getContentLengthLong() = response.second.size.toLong()
            override fun getHeaderField(name: String?): String? = if (name.equals("Content-Range", true)) {
                val offset = bytes.size - response.second.size + if (response.third == Fault.WRONG_RANGE) 1 else 0
                "bytes $offset-${bytes.size - 1}/${bytes.size}"
            } else null
            override fun getInputStream(): InputStream {
                val (status, body, fault) = response
                if (fault == Fault.TRUNCATE) return ByteArrayInputStream(body.copyOf(body.size / 2))
                if (fault == Fault.INTERRUPT) return object : InputStream() {
                    var position = 0
                    override fun read(): Int {
                        if (position >= body.size / 2) throw IOException("Synthetic cable removed")
                        return body[position++].toInt() and 255
                    }
                    override fun read(out: ByteArray, offset: Int, count: Int): Int {
                        if (position >= body.size / 2) throw IOException("Synthetic cable removed")
                        val length = minOf(count, body.size / 2 - position)
                        body.copyInto(out, offset, position, position + length); position += length
                        return length
                    }
                }
                return ByteArrayInputStream(body)
            }
        }
    }
}
