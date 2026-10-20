package com.todopup.usage

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** Resumable USB-only transfers. A map becomes visible only after checksum validation. */
class MediaSync(private val context: Context,
                baseUrl: String = MobileConfig.baseUrl(context),
                private val token: String = MobileConfig.token(context),
                private val openConnection: (URL) -> HttpURLConnection = { it.openConnection() as HttpURLConnection }) {
    companion object { val activeMaps: MutableSet<String> = java.util.concurrent.ConcurrentHashMap.newKeySet() }
    private val store = MediaStore(context)
    private val base = MobileEndpoint.requireAllowed(baseUrl).trimEnd('/')
    private fun connection(path: String) = openConnection(URL(base + path)).apply {
        connectTimeout = 15_000; readTimeout = 60_000; instanceFollowRedirects = false
        setRequestProperty("Authorization", "Bearer $token")
    }
    private fun json(path: String, payload: JSONObject? = null, photo: File? = null): JSONObject {
        val conn = connection("/api/mobile/media/" + path)
        try {
            if (payload != null || photo != null) {
                conn.requestMethod = "POST"; conn.doOutput = true
                if (photo != null) { conn.setFixedLengthStreamingMode(photo.length()); conn.setRequestProperty("Content-Type", "application/octet-stream"); conn.outputStream.use { out -> photo.inputStream().use { it.copyTo(out) } } }
                else { conn.setRequestProperty("Content-Type", "application/json"); conn.outputStream.use { it.write(payload.toString().toByteArray()) } }
            }
            if (conn.responseCode !in 200..299) throw IOException("Media sync: HTTP ${conn.responseCode}")
            return JSONObject(conn.inputStream.bufferedReader().use { it.readText() })
        } finally { conn.disconnect() }
    }
    fun exchange(): Int {
        var transferred = 0
        var remote = MediaSyncResponse.state(json("state"))
        for ((id, _) in store.state().getJSONObject("assets").entries()) if (!remote.getJSONObject("assets").has(id)) {
            val file = File(store.root, "media/$id/original")
            if (file.isFile) { json("upload", photo = file); transferred++ }
        }
        val batches = store.sendableChanges().chunked(500).ifEmpty { listOf(emptyList()) }
        for (sent in batches) {
            val result = MediaSyncResponse.state(json("state", JSONObject().put("changes", JSONArray(sent))), sent)
            val accepted = result.getJSONArray("accepted").let { a -> (0 until a.length()).map { a.getString(it) } }
            store.mergeServer(result, accepted, sent)
            remote = result
        }
        for ((id, _) in remote.getJSONObject("assets").entries()) {
            require(id.matches(Regex("[a-f0-9]{64}"))) { "Invalid media identity" }
            for (variant in listOf("original", "preview.webp", "thumb.webp")) {
                val file = File(store.root, "media/$id/$variant")
                if (!file.isFile) { download("file/$id/$variant", file, if (variant == "original") id else null); transferred++ }
            }
        }
        // Indefinite history is exchanged one day at a time, never loaded as a
        // single growing JSON array. Samples are immutable and acknowledged by id.
        store.archiveTracking()
        val days = store.trackingDays()
        for (day in days) {
            val receipt = File(store.root, "tracking_receipts/$day.json")
            val synced = MediaStore.read(receipt)
            val pending = store.samples(day, day).filter { !synced.has(it.getString("id")) }
            for (chunk in pending.chunked(2000)) {
                val response = json("tracking", JSONObject().put("samples", JSONArray(chunk)))
                val ids = MediaSyncResponse.trackingAck(response, chunk)
                for (id in ids) synced.put(id, true)
                MediaStore.write(receipt, synced)
            }
        }
        val hashesFile = File(store.root, "tracking_remote_days.json"); val hashes = MediaStore.read(hashesFile)
        val manifest = MediaSyncResponse.trackingManifest(json("tracking?manifest=1"))
        for (day in manifest) {
            val date = day.getString("date"); require(date.matches(Regex("\\d{4}-\\d{2}-\\d{2}")))
            val hash = day.getString("sha256")
            if (hashes.optString(date) == hash) continue
            val tracking = MediaSyncResponse.tracking(json("tracking?from=$date&to=$date"), day)
            store.addSamples(tracking)
            val receipt = File(store.root, "tracking_receipts/$date.json"); val synced = MediaStore.read(receipt)
            for (sample in tracking) synced.put(sample.getString("id"), true)
            MediaStore.write(receipt, synced); hashes.put(date, hash); MediaStore.write(hashesFile, hashes)
        }
        return transferred
    }
    fun maps(progress: (String) -> Unit): Int {
        val manifest = MediaSyncResponse.maps(json("maps"))
        val manifestFile = File(store.root, "maps.json")
        fun installed(pack: JSONObject): Boolean {
            val id = pack.getString("id"); val sha = pack.optString("sha256")
            val file = File(store.root, "maps/$id.pmtiles")
            return sha.isNotBlank() && file.isFile && file.length() == pack.optLong("bytes") &&
                MediaStore.read(File(store.root, "maps/$id.receipt.json")).optString("sha256") == sha
        }
        val cached = store.maps().getJSONArray("packs").objects().associateBy { it.getString("id") }
        val visible = JSONObject(manifest.toString())
        val packs = manifest.getJSONArray("packs").objects()
        // Keep each verified old pack available until its replacement is fully
        // received. The remote identity list still controls real removals.
        val available = JSONArray(packs.map { pack ->
            val old = cached[pack.getString("id")]
            if (!installed(pack) && old?.optString("status") == "ready") old else pack
        })
        visible.put("packs", available)
        MediaStore.write(manifestFile, visible)
        var count = 0
        for (pack in packs.filter { it.optString("status") == "ready" }) {
            val id = pack.getString("id"); require(id.matches(Regex("[A-Za-z0-9_-]{1,100}")))
            val file = File(store.root, "maps/$id.pmtiles"); val receipt = File(store.root, "maps/$id.receipt.json")
            val sha = pack.getString("sha256")
            if (installed(pack)) continue
            progress("USB map transfer · ${pack.getString("name")}")
            val partialMeta = File(file.path + ".part.json")
            if (MediaStore.read(partialMeta).optString("sha256") != sha) File(file.path + ".part").delete()
            MediaStore.write(partialMeta, JSONObject().put("sha256", sha))
            activeMaps.add(id)
            try {
                download("maps/file/$id", file, sha, pack.getLong("bytes")) {
                    MediaStore.write(receipt, JSONObject().put("sha256", sha))
                    available.put(packs.indexOf(pack), pack)
                    MediaStore.write(manifestFile, visible)
                }
                count++
            } finally { activeMaps.remove(id) }
        }
        return count
    }
    private fun download(path: String, file: File, sha: String?, manifestBytes: Long? = null,
                         published: (() -> Unit)? = null) {
        file.parentFile?.mkdirs(); val partial = File(file.path + ".part")
        val offset = partial.takeIf(File::isFile)?.length() ?: 0L
        val conn = connection("/api/mobile/media/$path")
        try {
            if (offset > 0) conn.setRequestProperty("Range", "bytes=$offset-")
            val status = conn.responseCode
            if (status !in listOf(200, 206)) { if (status == 416) partial.delete(); throw IOException("File transfer interrupted (HTTP $status)") }
            val append = status == 206 && offset > 0
            val length = conn.contentLengthLong.takeIf { it >= 0 }
            val expectedSize = if (status == 206) {
                val parts = Regex("bytes (\\d+)-(\\d+)/(\\d+)").matchEntire(conn.getHeaderField("Content-Range").orEmpty())
                    ?.groupValues?.drop(1)?.map { it.toLongOrNull() }
                if (parts == null || parts.any { it == null }) throw IOException("Invalid resumed file range")
                val start = parts[0]!!; val end = parts[1]!!; val total = parts[2]!!
                if (start != offset || end < start || total <= end || (length != null && length != end - start + 1))
                    throw IOException("Invalid resumed file range")
                total
            } else length
            java.io.FileOutputStream(partial, append).use { out -> conn.inputStream.use { it.copyTo(out, 256 * 1024) }; out.fd.sync() }
            if (expectedSize != null && partial.length() != expectedSize) throw IOException("File transfer was incomplete; its partial copy is kept for the next USB connection")
            if (manifestBytes != null && partial.length() != manifestBytes) throw IOException("File size did not match the download manifest")
            if (sha != null && MediaStore.digest(partial) != sha) { partial.delete(); throw IOException("File checksum failed; retry will fetch a fresh copy") }
            synchronized(MediaFileResponse.mapGuard) {
                java.nio.file.Files.move(partial.toPath(), file.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING, java.nio.file.StandardCopyOption.ATOMIC_MOVE)
                published?.invoke()
            }
        } finally { conn.disconnect() }
    }
}
