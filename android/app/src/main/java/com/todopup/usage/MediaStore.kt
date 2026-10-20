package com.todopup.usage

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.util.AtomicFile
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.security.MessageDigest
import java.time.OffsetDateTime
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.UUID

/** Private, durable media files. Originals are addressed by their SHA-256 digest. */
class MediaStore(private val context: Context) {
    val root = File(context.filesDir, "journal_media").apply { mkdirs() }
    fun state(): JSONObject = synchronized(guard) {
        verified(File(root, "state.json")) { saved ->
            for (kind in listOf("assets", "groups", "places", "messages")) if (saved.has(kind)) {
                val records = saved.getJSONObject(kind)
                for (id in records.keys()) {
                    val record = records.getJSONObject(id)
                    require(record.opt("id") == id)
                    require(!record.has("rev") || isRevision(record.opt("rev")))
                }
            }
            require(!saved.has("local_revision") || isRevision(saved.opt("local_revision")))
        }.apply {
            if (!has("local_revision")) put("local_revision", 0L)
            for (key in listOf("assets", "groups", "places", "messages")) if (!has(key)) put(key, JSONObject())
            val groups = getJSONObject("groups")
            for (name in listOf("people", "meals", "foods", "locations")) if (!groups.has(name))
                groups.put(name, JSONObject().put("id", name).put("name", name).put("share_entry", name == "people").put("rev", 0))
            for ((_, group) in groups.entries()) if (!group.has("tags")) group.put("tags", JSONArray())
            for ((_, place) in getJSONObject("places").entries()) if (!place.has("starred")) place.put("starred", false)
        }
    }
    fun outbox(): JSONArray = synchronized(guard) {
        verified(File(root, "outbox.json")) { saved ->
            if (saved.has("changes")) {
                val changes = saved.getJSONArray("changes")
                for (index in 0 until changes.length()) validateChange(changes.getJSONObject(index))
            }
        }.optJSONArray("changes") ?: JSONArray()
    }
    fun sendableChanges(): List<JSONObject> = synchronized(guard) {
        val blocked = (conflicts().optJSONArray("conflicts") ?: JSONArray()).objects().map(::recordKey).toSet()
        outbox().objects().filter { recordKey(it) !in blocked }
    }
    fun mutate(changes: JSONArray): JSONObject = synchronized(guard) {
        for (index in 0 until changes.length()) validateChange(changes.getJSONObject(index))
        val state = state(); val pending = outbox().objects().toMutableList()
        for (change in changes.objects()) {
            val kind = change.getString("kind"); require(kind in setOf("assets", "groups", "places", "messages"))
            val id = change.getString("id"); require(id.matches(Regex("[A-Za-z0-9_-]{1,100}")))
            val collection = state.getJSONObject(kind); val old = collection.optJSONObject(id)
            val patch = change.getJSONObject("patch")
            require(kind !in setOf("assets", "messages") || old != null) { "Import the file or message before editing it" }
            if (kind == "groups" && patch.has("tags")) {
                val names = patch.getJSONArray("tags")
                patch.put("tags", JSONArray((0 until names.length()).map { index ->
                    val name = names.get(index)
                    require(name is String) { "Tag must be text" }
                    require(name.length <= 100) { "Tag is too long" }
                    name.trim().lowercase(java.util.Locale.ROOT)
                }.filter { it.isNotEmpty() && it.none { c -> c.code < 32 } }.distinct()))
            }
            require(kind != "places" || !patch.has("starred") || patch.opt("starred") is Boolean) { "Starred must be true or false" }
            val next = MediaMetadataPolicy.apply(kind, old, patch)
            val expected = if (change.isNull("base_rev")) null else change.optInt("base_rev")
            require(expected == old?.optInt("rev")) { "This item changed on the phone. Reopen it before editing." }
            val queued = pending.find { it.optString("kind") == kind && it.optString("id") == id }
            if (queued != null) {
                patch.keys().forEach { queued.getJSONObject("patch").put(it, patch.get(it)) }
                queued.put("op_id", UUID.randomUUID().toString())
            } else pending.add(JSONObject(change.toString()))
            next.put("id", id)
            if (kind == "places" && !next.has("starred")) next.put("starred", false)
            if (kind == "groups" && !next.has("tags")) next.put("tags", JSONArray())
            next.put("rev", next.optInt("rev") + 1); collection.put(id, next)
        }
        write(File(root, "outbox.json"), JSONObject().put("changes", JSONArray(pending)))
        writeState(state)
        state
    }
    fun mergeServer(server: JSONObject, accepted: List<String>, sent: List<JSONObject> = emptyList()) = synchronized(guard) {
        val queuedBeforeAck = outbox().objects()
        val pending = queuedBeforeAck.filter { it.optString("op_id") !in accepted }
        val local = state()
        // Records are archived by revision, never removed by a sync snapshot.
        // Preserve newer settled records when overlapping requests finish out
        // of order. Pending records are handled below using their server base.
        val pendingKeys = pending.map(::recordKey).toSet()
        val acknowledgedKeys = queuedBeforeAck.filter { it.optString("op_id") in accepted }.map(::recordKey).toSet()
        for (kind in listOf("assets", "groups", "places", "messages")) {
            val incoming = server.getJSONObject(kind)
            for ((id, record) in local.getJSONObject(kind).entries()) {
                val remote = incoming.optJSONObject(id)
                if ("$kind:$id" !in pendingKeys && "$kind:$id" !in acknowledgedKeys &&
                    (remote == null || record.optLong("rev") > remote.optLong("rev")))
                    incoming.put(id, record)
            }
        }
        for (change in pending) {
            val acknowledged = sent.find { it.optString("op_id") in accepted && it.optString("kind") == change.optString("kind") && it.optString("id") == change.optString("id") }
            if (acknowledged != null && change.opt("base_rev") == acknowledged.opt("base_rev"))
                change.put("base_rev", server.getJSONObject(change.getString("kind")).optJSONObject(change.getString("id"))?.optInt("rev") ?: JSONObject.NULL)
            val collection = server.getJSONObject(change.getString("kind")); val id = change.getString("id")
            val record = JSONObject((local.getJSONObject(change.getString("kind")).optJSONObject(id)
                ?: collection.optJSONObject(id) ?: JSONObject().put("id", id)).toString())
            collection.put(id, record)
        }
        writeState(server)
        write(File(root, "outbox.json"), JSONObject().put("changes", JSONArray(pending)))
        // Resolve responses against the live outbox inside the same lock. A
        // user may already have chosen a version while this response arrived.
        val received = (server.optJSONArray("conflicts") ?: JSONArray()).objects()
        val saved = (read(File(root, "conflicts.json")).optJSONArray("conflicts") ?: JSONArray()).objects()
        val currentConflicts = saved.filter { conflict -> pending.any { recordKey(it) == recordKey(conflict) } }
            .associateBy(::recordKey).toMutableMap()
        for (ack in sent.filter { it.optString("op_id") in accepted }) currentConflicts.remove(recordKey(ack))
        for (conflict in received) {
            val rejected = sent.firstOrNull { it.optString("op_id") == conflict.optString("op_id") }
            val live = pending.firstOrNull { recordKey(it) == recordKey(conflict) } ?: continue
            if (rejected != null && TaskMutationJson.same(live.opt("base_rev"), rejected.opt("base_rev")) ||
                rejected == null && live.optString("op_id") == conflict.optString("op_id")) {
                currentConflicts[recordKey(conflict)] = conflict
            }
        }
        write(File(root, "conflicts.json"), JSONObject().put("conflicts", JSONArray(currentConflicts.values.toList())))
    }

    private fun recordKey(change: JSONObject) = change.optString("kind") + ":" + change.optString("id")
    fun conflicts(): JSONObject = synchronized(guard) {
        val saved = read(File(root, "conflicts.json")); val state = state()
        for (c in (saved.optJSONArray("conflicts") ?: JSONArray()).objects()) {
            c.put("local", state.optJSONObject(c.optString("kind"))?.optJSONObject(c.optString("id")) ?: JSONObject.NULL)
            c.put("revision", MediaConflictRevision.of(c))
        }
        saved
    }
    fun resolveConflict(id: String, choice: String, kind: String? = null, expectedRevision: String? = null): JSONObject = synchronized(guard) {
        require(choice in setOf("local", "remote"))
        val record = conflicts(); val conflicts = (record.optJSONArray("conflicts") ?: JSONArray()).objects()
        val conflict = conflicts.firstOrNull { it.optString("id") == id && (kind == null || it.optString("kind") == kind) }
            ?: if (expectedRevision != null) throw MediaConflictChanged(null) else throw IllegalArgumentException("This conflict is already resolved")
        if (expectedRevision != null && expectedRevision != conflict.getString("revision")) throw MediaConflictChanged(conflict)
        val pending = outbox().objects().toMutableList(); val collection = conflict.getString("kind")
        val current = conflict.optJSONObject("current")
        val relevant = pending.filter { it.optString("kind") == collection && it.optString("id") == id }
        if (choice == "local") relevant.forEach { it.put("op_id", UUID.randomUUID().toString()).put("base_rev", current?.optInt("rev") ?: JSONObject.NULL) }
        else {
            pending.removeAll(relevant.toSet()); val state = state()
            if (current == null) state.getJSONObject(collection).remove(id) else state.getJSONObject(collection).put(id, current)
            writeState(state)
        }
        if (choice == "local") writeState(state())
        write(File(root, "outbox.json"), JSONObject().put("changes", JSONArray(pending)))
        write(File(root, "conflicts.json"), JSONObject().put("conflicts", JSONArray(conflicts.filter { it !== conflict })))
        state()
    }
    fun importUri(uri: Uri): JSONObject {
        val resolver = context.contentResolver
        // Gallery URIs refer to MediaStore originals. Document providers may also expose
        // a media URI; their own stream remains the fallback for non-local photos.
        val original = if (android.os.Build.VERSION.SDK_INT >= 29 &&
            context.checkSelfPermission(android.Manifest.permission.ACCESS_MEDIA_LOCATION) == android.content.pm.PackageManager.PERMISSION_GRANTED) {
            runCatching {
                val mediaUri = if (uri.authority == "media") uri else android.provider.MediaStore.getMediaUri(context, uri)
                mediaUri?.let(android.provider.MediaStore::setRequireOriginal)
            }.getOrNull()
        } else null
        fun open(value: Uri) = resolver.openInputStream(value) ?: throw java.io.FileNotFoundException("Photo is unavailable")
        return importBytes(PhotoInput.readOriginal({ open(original ?: uri) }, { open(uri) }, MAX_IMAGE))
    }
    fun importBytes(bytes: ByteArray): JSONObject = synchronized(guard) {
        require(bytes.size <= MAX_IMAGE)
        val id = digest(bytes)
        val existing = state().getJSONObject("assets").optJSONObject(id)
        val dir = File(root, "media/$id").apply { mkdirs() }
        if (existing != null && listOf("original", "preview.webp", "thumb.webp").all { File(dir, it).isFile }) return@synchronized existing
        atomicBytes(File(dir, "original"), bytes)
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        require(bounds.outWidth > 0 && bounds.outHeight > 0) { "Choose a supported photo" }
        val options = BitmapFactory.Options().apply {
            while (maxOf(bounds.outWidth, bounds.outHeight) / (inSampleSize.coerceAtLeast(1)) > 3200)
                inSampleSize = maxOf(1, inSampleSize) * 2
        }
        var bitmap = requireNotNull(BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)) { "Could not decode photo" }
        val exif = runCatching { ExifInterface(File(dir, "original").path) }.getOrNull()
        val orientation = exif?.getAttributeInt(ExifInterface.TAG_ORIENTATION, 1) ?: 1
        val matrix = Matrix().apply {
            when (orientation) { 2 -> setScale(-1f, 1f); 3 -> setRotate(180f); 4 -> setScale(1f, -1f)
                5 -> { setRotate(90f); postScale(-1f, 1f) }; 6 -> setRotate(90f)
                7 -> { setRotate(270f); postScale(-1f, 1f) }; 8 -> setRotate(270f) }
        }
        if (orientation != 1) bitmap = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
        for ((name, limit) in listOf("preview.webp" to 1600, "thumb.webp" to 320)) {
            val factor = minOf(1.0, limit.toDouble() / maxOf(bitmap.width, bitmap.height))
            val resized = Bitmap.createScaledBitmap(bitmap, maxOf(1, (bitmap.width * factor).toInt()), maxOf(1, (bitmap.height * factor).toInt()), true)
            val buffer = java.io.ByteArrayOutputStream(); resized.compress(Bitmap.CompressFormat.WEBP, 88, buffer)
            atomicBytes(File(dir, name), buffer.toByteArray()); if (resized !== bitmap) resized.recycle()
        }
        bitmap.recycle()
        val gps = FloatArray(2)
        val location = if (exif?.getLatLong(gps) == true) JSONObject().put("lat", gps[0].toDouble()).put("lon", gps[1].toDouble()) else null
        val capture = exif?.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL)?.let {
            runCatching { java.time.LocalDateTime.parse(it, DateTimeFormatter.ofPattern("yyyy:MM:dd HH:mm:ss")).toString() }.getOrNull()
        }
        val asset = JSONObject().put("id", id).put("rev", 0).put("mime", bounds.outMimeType)
            .put("filename", "Phone photo").put("bytes", bytes.size).put("created", OffsetDateTime.now().toString())
            .put("captured_at", capture ?: JSONObject.NULL).put("original_captured_at", capture ?: JSONObject.NULL).put("location", location ?: JSONObject.NULL)
            .put("original_location", location ?: JSONObject.NULL).put("width", if (orientation in 5..8) bounds.outHeight else bounds.outWidth).put("height", if (orientation in 5..8) bounds.outWidth else bounds.outHeight)
            .put("original", "$id/original").put("preview", "$id/preview.webp").put("thumbnail", "$id/thumb.webp")
        val restored = existing ?: asset
        val state = state(); state.getJSONObject("assets").put(id, restored); writeState(state); restored
    }
    private fun trackingFiles() = DailyTrackingFiles(File(root, "tracking"), ::atomicBytes) { file ->
        AtomicFile(file).openRead().use { it.readBytes() }
    }
    fun trackingDays(): List<String> = synchronized(guard) { trackingFiles().days() }
    private fun trackingDay(day: String): JSONObject {
        val bytes = trackingFiles().read(day)
        val saved = if (bytes.isEmpty()) JSONObject() else JSONObject(String(bytes, Charsets.UTF_8))
        for (line in trackingFiles().logRows(day)) {
            val row = JSONObject(String(line, Charsets.UTF_8)); val id = row.getString("id")
            // A snapshot may already contain this line after interrupted compaction.
            if (!saved.has(id)) saved.put(id, row)
        }
        return saved
    }
    fun samples(from: String? = null, to: String? = null): List<JSONObject> = synchronized(guard) {
        val days = if (!from.isNullOrBlank() && from == to) listOf(from) else trackingDays().filter {
            (from.isNullOrBlank() || it >= from) && (to.isNullOrBlank() || it <= to)
        }
        days.flatMap { trackingDay(it).entries().map { pair -> pair.second } }.sortedBy { it.optString("at") }
    }
    fun archiveTracking(today: String = LocalDate.now().toString()) = synchronized(guard) {
        // Recording creates MediaStore instances frequently. Scan old days only once
        // per local date, not once per GPS fix, and retry if archival fails.
        if (archivedThrough[root.path] != today) {
            for (day in trackingFiles().pendingArchiveDays(today)) {
                trackingFiles().compact(day, trackingDay(day).toString().toByteArray(Charsets.UTF_8), today)
            }
            archivedThrough[root.path] = today
        }
    }
    fun appendTrackingSample(sample: JSONObject, today: String = LocalDate.now().toString()) = synchronized(guard) {
        val day = sample.getString("at").take(10)
        require(sample.getString("id").matches(Regex("[A-Za-z0-9_-]{1,100}"))) { "Invalid tracking identity" }
        archiveTracking(today)
        trackingFiles().append(day, sample.toString().toByteArray(Charsets.UTF_8))
        // A delayed fix around midnight may belong to the day just archived.
        if (day < today) trackingFiles().compact(day, trackingDay(day).toString().toByteArray(Charsets.UTF_8), today)
    }
    fun addSamples(samples: List<JSONObject>, today: String = LocalDate.now().toString()) = synchronized(guard) {
        archiveTracking(today)
        for ((day, rows) in samples.groupBy { it.getString("at").take(10) }) {
            require(day.matches(Regex("\\d{4}-\\d{2}-\\d{2}")))
            val saved = trackingDay(day)
            rows.forEach { if (!saved.has(it.getString("id"))) saved.put(it.getString("id"), it) }
            trackingFiles().compact(day, saved.toString().toByteArray(Charsets.UTF_8), today)
        }
    }
    fun maps(): JSONObject {
        val manifest = read(File(root, "maps.json")); val packs = manifest.optJSONArray("packs") ?: JSONArray()
        packs.objects().forEach { p ->
            val file = File(root, "maps/${p.getString("id")}.pmtiles")
            p.put("status", if (file.isFile && file.length() == p.optLong("bytes") && read(File(root, "maps/${p.getString("id")}.receipt.json")).optString("sha256") == p.optString("sha256")) "ready" else "not_downloaded")
            p.put("url", "/journal/media/maps/file/" + p.getString("id"))
            p.put("estimated_bytes", p.optLong("bytes"))
            p.put("downloaded_bytes", File(file.path + ".part").takeIf(File::isFile)?.length() ?: 0L)
            p.put("download_status", if (MediaSync.activeMaps.contains(p.getString("id"))) "downloading" else p.getString("status"))
        }
        return manifest.put("packs", packs)
    }
    private fun writeState(value: JSONObject) {
        val file = File(root, "state.json")
        value.put("local_revision", read(file).optLong("local_revision") + 1)
        write(file, value)
    }
    private fun isRevision(value: Any?): Boolean = (value as? Number)?.toDouble()?.let { it.isFinite() && it >= 0 && it % 1.0 == 0.0 } == true
    private fun validateChange(value: JSONObject) {
        require(value.opt("kind") in setOf("assets", "groups", "places", "messages"))
        for (field in listOf("id", "op_id")) require(value.opt(field) is String && value.getString(field).matches(Regex("[A-Za-z0-9_-]{1,100}")))
        value.getJSONObject("patch")
        require(value.isNull("base_rev") || isRevision(value.opt("base_rev")))
    }
    private fun verified(file: File, validate: (JSONObject) -> Unit): JSONObject {
        val value = read(file)
        try { validate(value) } catch (error: Exception) {
            if (file.exists()) file.copyTo(File(file.path + ".bak"), overwrite = true)
            throw IllegalStateException("Saved media metadata needs recovery. A backup has been kept on this phone.", error)
        }
        return value
    }
    companion object {
        val guard = Any()
        private val archivedThrough = mutableMapOf<String, String>()
        const val MAX_IMAGE = 80 * 1024 * 1024
        fun digest(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        fun digest(file: File): String { val digest = MessageDigest.getInstance("SHA-256"); file.inputStream().use { input -> val b = ByteArray(256 * 1024); while (true) { val n = input.read(b); if (n < 0) break; digest.update(b, 0, n) } }; return digest.digest().joinToString("") { "%02x".format(it) } }
        fun read(file: File): JSONObject = if (!file.exists()) JSONObject() else try { JSONObject(AtomicFile(file).openRead().bufferedReader().use { it.readText() }) } catch (e: Exception) { file.copyTo(File(file.path + ".bak"), overwrite = true); throw IllegalStateException("Saved media metadata needs recovery", e) }
        fun write(file: File, value: JSONObject) = atomicBytes(file, value.toString().toByteArray())
        fun atomicBytes(file: File, bytes: ByteArray) { file.parentFile?.mkdirs(); val atomic = AtomicFile(file); val stream = atomic.startWrite(); try { stream.write(bytes); atomic.finishWrite(stream) } catch (e: Exception) { atomic.failWrite(stream); throw e } }
    }
}
internal fun JSONArray.objects(): List<JSONObject> = (0 until length()).mapNotNull { optJSONObject(it) }
internal fun JSONObject.entries(): List<Pair<String, JSONObject>> = keys().asSequence().mapNotNull { key -> optJSONObject(key)?.let { key to it } }.toList()
