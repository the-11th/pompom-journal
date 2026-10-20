package com.todopup.usage

import android.app.Instrumentation
import android.content.Context
import android.content.ContextWrapper
import android.content.SharedPreferences
import android.os.Bundle
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Runs against a disposable namespace on a real Android runtime, never user data. */
class StorageInstrumentation : Instrumentation() {
    private var photoFixtures: String? = null
    private var syncOnly = false
    private var journalTagsOnly = false
    private var gallerySelectionOnly = false
    private var journalTagArchiveOnly = false
    private var unicodeTagsOnly = false
    private var usageOnly = false
    override fun onCreate(arguments: Bundle?) {
        super.onCreate(arguments)
        photoFixtures = arguments?.getString("photo_fixtures")
        syncOnly = arguments?.getString("sync_only") == "true"
        journalTagsOnly = arguments?.getString("journal_tags_only") == "true"
        gallerySelectionOnly = arguments?.getString("gallery_selection_only") == "true"
        journalTagArchiveOnly = arguments?.getString("journal_tag_archive_only") == "true"
        unicodeTagsOnly = arguments?.getString("unicode_tags_only") == "true"
        usageOnly = arguments?.getString("usage_only") == "true"
        start()
    }
    override fun onStart() {
        val namespace = "qa_${UUID.randomUUID().toString().replace("-", "")}_"
        val isolated = object : ContextWrapper(targetContext) {
            override fun getSharedPreferences(name: String, mode: Int): SharedPreferences =
                super.getSharedPreferences(namespace + name, mode)
            override fun getFilesDir(): File = File(super.getCacheDir(), namespace).apply { mkdirs() }
        }
        val results = Bundle()
        try {
            if (usageOnly) {
                UsageUploadChecks.run()
                UsageArchiveChecks.run(isolated)
                results.putString("stream", "PASS: offline usage archive, retries, acknowledgements and scheduling\n")
                finish(0, results); return
            }
            UnicodeTagChecks.run(isolated)
            if (unicodeTagsOnly) {
                results.putString("stream", "PASS: isolated Unicode journal tag checks\n")
                finish(0, results); return
            }
            JournalTagArchiveChecks.run(isolated)
            if (journalTagArchiveOnly) {
                results.putString("stream", "PASS: isolated journal tag archive checks\n")
                finish(0, results); return
            }
            JournalPhotoChecks.run(isolated)
            if (gallerySelectionOnly) {
                val galleryResult = AtomicReference<kotlin.Result<Unit>>()
                runOnMainSync { galleryResult.set(runCatching { GallerySelectionChecks.run(isolated) }) }
                galleryResult.get().getOrThrow()
                results.putString("stream", "PASS: isolated gallery selection checks\n")
                finish(0, results)
                return
            }
            JournalTagChecks.run(isolated)
            if (journalTagsOnly) {
                results.putString("stream", "PASS: isolated journal tag checks\n")
                finish(0, results)
                return
            }
            SyncStorageChecks.run(isolated)
            SyncNetworkChecks.run()
            SyncInterleavingChecks.run(isolated)
            SyncMediaChecks.run(isolated)
            SyncTransferChecks.run(isolated)
            SyncTrackingProtocolChecks.run(isolated)
            SyncCorruptionChecks.run(isolated)
            if (syncOnly) {
                results.putString("stream", "PASS: isolated synchronization storage checks\n")
                finish(0, results)
                return
            }
            val nativeResult = AtomicReference<kotlin.Result<Unit>>()
            runOnMainSync { nativeResult.set(runCatching { NativeUiChecks.run(isolated) }) }
            nativeResult.get().getOrThrow()
            runOnMainSync {
                val alex = TagCheckBox(isolated).apply { text = "alex" }
                val sam = TagCheckBox(isolated).apply { text = "sam" }
                for (choice in listOf(alex, sam)) {
                    val drawable = requireNotNull(choice.buttonDrawable)
                    val circle = drawable.current as android.graphics.drawable.GradientDrawable
                    check(circle.shape == android.graphics.drawable.GradientDrawable.OVAL)
                    check(circle.intrinsicWidth == circle.intrinsicHeight)
                    choice.performClick()
                    check(choice.isChecked && drawable.current !== circle)
                }
                alex.performClick()
                check(!alex.isChecked && sam.isChecked) { "Circular tags must remain independent checkboxes" }
            }
            val gate = CountDownLatch(1); val done = CountDownLatch(24)
            val errors = java.util.Collections.synchronizedList(mutableListOf<Throwable>())
            repeat(24) { index -> Thread {
                try { gate.await(); JournalSyncStore(isolated).save(JournalDraft("2026-08-${(index + 1).toString().padStart(2, '0')}", body = "parallel $index")) }
                catch (e: Throwable) { errors.add(e) } finally { done.countDown() }
            }.start() }
            gate.countDown(); done.await(); check(errors.isEmpty()) { errors.toString() }
            check(JournalSyncStore(isolated).all().size == 24) { "Concurrent store instances lost an entry" }
            val first = JournalDraft("2026-09-08", body = "saved", requestId = "sent", baseUpdated = "v1", syncState = SyncState.PENDING)
            val newer = first.copy(body = "saved plus newer typing", requestId = "new")
            val store = JournalSyncStore(isolated); store.save(newer)
            store.markSynced(first.date, first.copy(baseUpdated = "v2"), first)
            check(store.get(first.date)?.body == newer.body && store.get(first.date)?.baseUpdated == "v2")
            check(!store.applyRemote(first.date, first, first.copy(body = "remote")))
            store.markConflict(first.date, "new", JSONObject().put("updated", "mac2"), "Review")
            check(store.get(first.date)?.syncState == SyncState.CONFLICT)
            val ordered = JournalDraft("2026-09-07", body = "A", modifiedAt = "local-version", requestId = "doc-request",
                document = "[{\"id\":\"a\",\"type\":\"text\",\"text\":\"A\",\"links\":[]}]")
            val reordered = ordered.copy(modifiedAt = "server-version", document = "[{\"links\":[],\"text\":\"A\",\"type\":\"text\",\"id\":\"a\"}]")
            check(MobileSyncPolicy.matchesRemote(ordered, reordered)) { "JSON key order creates a false journal conflict" }
            check(JournalAcknowledgement.merge(ordered, ordered, reordered).modifiedAt == "local-version") { "Unchanged document acknowledgement invalidates the open editor" }
            val commandText = "[] call Alex\n😀 this memory"
            val committedText = "[task:abcd] call Alex\n😀 this memory"
            val commandDoc = JSONArray().put(JSONObject().put("id", "text").put("type", "text").put("text", commandText).put("links", JSONArray()))
                .put(JSONObject().put("id", "photo").put("type", "photo").put("asset_id", "original").put("caption", "Before"))
            val commandSent = JournalDraft("2026-09-06", body = commandText, document = commandDoc.toString(),
                requestId = "commands-sent", baseUpdated = "before-commit", syncState = SyncState.PENDING)
            val editedDoc = JSONArray(commandDoc.toString())
            editedDoc.getJSONObject(1).put("caption", "New caption").put("edited_asset_id", "new-drawing")
            val linkStart = commandText.codePointCount(0, commandText.indexOf("this"))
            editedDoc.getJSONObject(0).put("links", JSONArray().put(JSONObject().put("start", linkStart)
                .put("end", linkStart + 11).put("photos", JSONArray().put("photo"))))
            val commandNewer = commandSent.copy(requestId = "new-photo-edit", document = editedDoc.toString())
            val committedDoc = JSONArray(commandDoc.toString()); committedDoc.getJSONObject(0).put("text", committedText)
            val commandServer = commandSent.copy(body = committedText, document = committedDoc.toString(), baseUpdated = "after-commit")
            val mergedCommand = JournalAcknowledgement.merge(commandNewer, commandSent, commandServer)
            val mergedDoc = JSONArray(mergedCommand.document)
            check(mergedCommand.body == committedText && mergedDoc.getJSONObject(0).getString("text") == committedText) {
                "An acknowledgement left fresh task markers in a newer photo document"
            }
            check(mergedCommand.modifiedAt != commandNewer.modifiedAt) { "A stale open editor can overwrite acknowledged task markers" }
            check(mergedDoc.getJSONObject(1).getString("caption") == "New caption" && mergedDoc.getJSONObject(1).getString("edited_asset_id") == "new-drawing")
            check(mergedDoc.getJSONObject(0).getJSONArray("links").getJSONObject(0).getInt("start") == linkStart + 9) {
                "Task acknowledgement lost a newer photo link or used UTF-16 offsets"
            }
            store.save(commandNewer)
            store.markSynced(commandNewer.date, commandServer, commandSent)
            check(JournalSyncStore(isolated).isTaskRewriteVersion(commandNewer.date, commandNewer.modifiedAt)) {
                "The stale task-command version must remain identifiable after reopening the store"
            }
            check(!JournalSyncStore(isolated).isTaskRewriteVersion(commandNewer.date, "unrelated-version"))
            val alreadyResolved = commandNewer.copy(requestId = "resolved", baseUpdated = "different-base", modifiedAt = "resolved-version")
            store.save(alreadyResolved)
            store.markSynced(alreadyResolved.date, commandServer, commandSent)
            check(!JournalSyncStore(isolated).isTaskRewriteVersion(alreadyResolved.date, alreadyResolved.modifiedAt)) {
                "An ignored older acknowledgement must not label an unrelated version as a task rewrite"
            }
            val barePhoto = "[{\"id\":\"p\",\"type\":\"photo\",\"asset_id\":\"asset\"}]"
            val defaultedPhoto = "[{\"id\":\"p\",\"type\":\"photo\",\"asset_id\":\"asset\",\"caption\":\"\",\"caption_visible\":true,\"hidden\":false,\"tags\":{},\"location_visible\":false,\"location_label\":\"\",\"location_color\":null,\"width\":\"full\",\"edited_asset_id\":null}]"
            check(DocumentJson.same(barePhoto, defaultedPhoto)) { "Default photo fields create a false edit" }
            MobileCache(isolated).saveConfig(MobileJournalConfig(listOf(JournalSection(
                "sleep", "Sleep", "numeric", "#e0a955", managed = "google"
            )), emptyList()))
            val cachedConfig = isolated.getSharedPreferences("todopup_mobile_ui", Context.MODE_PRIVATE)
                .getString("sections_v1", "{}")!!
            check(MobileJson.config(JSONObject(cachedConfig)).sections.single().managed == "google") {
                "Cached provider fields became editable after going offline"
            }
            val deniedLocationContext = object : ContextWrapper(isolated) {
                override fun checkPermission(permission: String, pid: Int, uid: Int): Int =
                    if (permission in setOf(android.Manifest.permission.ACCESS_FINE_LOCATION, android.Manifest.permission.ACCESS_COARSE_LOCATION))
                        android.content.pm.PackageManager.PERMISSION_DENIED else super.checkPermission(permission, pid, uid)
            }
            val currentPosition = AtomicReference<JSONObject>()
            runOnMainSync { CurrentLocationRequest(deniedLocationContext).request { currentPosition.set(it) } }
            check(currentPosition.get()?.optString("status") == "permission_required" && !currentPosition.get().has("location")) {
                "Silent map lookup must report missing permission without requesting or exposing a position"
            }
            check(!LocationTrackingService.preferences(isolated).getBoolean("enabled", false)) { "A map lookup enabled tracking" }
            var serviceStarts = 0
            fun trackingContext(granted: Boolean) = object : ContextWrapper(isolated) {
                override fun checkPermission(permission: String, pid: Int, uid: Int): Int =
                    if (permission == android.Manifest.permission.ACCESS_FINE_LOCATION)
                        if (granted) android.content.pm.PackageManager.PERMISSION_GRANTED else android.content.pm.PackageManager.PERMISSION_DENIED
                    else super.checkPermission(permission, pid, uid)
                override fun startForegroundService(service: android.content.Intent): android.content.ComponentName {
                    serviceStarts++; return android.content.ComponentName(packageName, LocationTrackingService::class.java.name)
                }
            }
            val tracking = LocationTrackingService.preferences(isolated)
            check(!LocationTrackingService.resumeIfEnabled(trackingContext(true)) && serviceStarts == 0)
            tracking.edit().putBoolean("enabled", true).putBoolean("detail_paused", true).commit()
            check(!LocationTrackingService.resumeIfEnabled(trackingContext(false)) && serviceStarts == 0)
            check(LocationTrackingService.resumeIfEnabled(trackingContext(true)) && serviceStarts == 1)
            check(tracking.getBoolean("detail_paused", false)) { "Foreground resume reset the outing-detail pause" }
            tracking.edit().putBoolean("enabled", false).commit()
            check(!LocationTrackingService.resumeIfEnabled(trackingContext(true)) && serviceStarts == 1) { "Foreground resume restarted explicitly disabled tracking" }
            val media = MediaStore(isolated)
            verifyTrackingArchives(media)
            photoFixtures?.let { raw ->
                check(targetContext.packageName.endsWith(".qa")) { "External photo fixtures are QA-only" }
                for (fixture in JSONArray(raw).objects()) {
                    val asset = media.importUri(android.net.Uri.parse(fixture.getString("uri")))
                    check(asset.getString("id") == fixture.getString("sha256")) { "Photo provider redacted or changed the original bytes" }
                    if (fixture.isNull("location")) check(asset.isNull("location")) { "A photo without GPS received a location" }
                    else for (key in listOf("lat", "lon")) check(kotlin.math.abs(asset.getJSONObject("location").getDouble(key) - fixture.getJSONObject("location").getDouble(key)) < .00001) { "Original photo GPS was not imported" }
                }
            }
            check(media.state().getJSONObject("groups").getJSONObject("people").getJSONArray("tags").length() == 0)
            media.mutate(JSONArray().put(JSONObject().put("op_id", "photo-tags").put("kind", "groups").put("id", "people")
                .put("base_rev", 0).put("patch", JSONObject().put("tags", JSONArray(listOf(" Alex ", "alex", "小李"))))))
            check(MediaStore(isolated).state().getJSONObject("groups").getJSONObject("people").getJSONArray("tags").toString() == "[\"alex\",\"小李\"]")
            check(media.outbox().objects().any { it.optString("kind") == "groups" && it.getJSONObject("patch").getJSONArray("tags").length() == 2 })
            val initial = JSONObject().put("op_id", "first").put("kind", "places").put("id", "test")
                .put("base_rev", JSONObject.NULL).put("patch", JSONObject().put("name", "Before").put("lat", 31.2).put("lon", 121.5))
            media.mutate(JSONArray().put(initial))
            val sent = media.outbox().objects()
            media.mutate(JSONArray().put(JSONObject().put("op_id", "second").put("kind", "places").put("id", "test")
                .put("base_rev", 1).put("patch", JSONObject().put("name", "Newer"))))
            val remote = media.state(); remote.getJSONObject("places").put("test", JSONObject().put("id", "test").put("name", "Before").put("rev", 1))
            media.mergeServer(remote, listOf("first"), sent)
            check(media.state().getJSONObject("places").getJSONObject("test").getString("name") == "Newer")
            check(media.outbox().objects().first { it.optString("kind") == "places" }.getInt("base_rev") == 1) { "Newer metadata did not rebase after acknowledgement" }
            val legacyState = File(media.root, "state.json")
            val legacy = JSONObject(legacyState.readText())
            legacy.getJSONObject("places").getJSONObject("test").remove("starred")
            legacyState.writeText(legacy.toString())
            val place = media.state().getJSONObject("places").getJSONObject("test")
            check(place.has("starred") && !place.getBoolean("starred")) { "Old saved places must default to unstarred" }
            media.mutate(JSONArray().put(JSONObject().put("op_id", "star-place").put("kind", "places").put("id", "test")
                .put("base_rev", place.getInt("rev")).put("patch", JSONObject().put("starred", true))))
            check(media.state().getJSONObject("places").getJSONObject("test").getBoolean("starred"))
            check(media.outbox().objects().any { it.optString("kind") == "places" && it.getJSONObject("patch").optBoolean("starred") }) {
                "Starring a place must remain queued for USB sync"
            }
            val bitmap = android.graphics.Bitmap.createBitmap(8, 4, android.graphics.Bitmap.Config.ARGB_8888)
            bitmap.eraseColor(android.graphics.Color.RED)
            val buffer = java.io.ByteArrayOutputStream(); bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, 95, buffer); bitmap.recycle()
            val fixture = File(isolated.filesDir, "exif-fixture.jpg"); fixture.writeBytes(buffer.toByteArray())
            val exif = android.media.ExifInterface(fixture.path)
            exif.setAttribute(android.media.ExifInterface.TAG_ORIENTATION, "6")
            exif.setAttribute(android.media.ExifInterface.TAG_DATETIME_ORIGINAL, "2026:09:08 12:34:56")
            exif.setAttribute(android.media.ExifInterface.TAG_GPS_LATITUDE_REF, "N")
            exif.setAttribute(android.media.ExifInterface.TAG_GPS_LATITUDE, "31/1,12/1,30/1")
            exif.setAttribute(android.media.ExifInterface.TAG_GPS_LONGITUDE_REF, "E")
            exif.setAttribute(android.media.ExifInterface.TAG_GPS_LONGITUDE, "121/1,30/1,15/1")
            exif.saveAttributes()
            val original = fixture.readBytes(); val imported = media.importBytes(original)
            check(kotlin.math.abs(imported.getJSONObject("location").getDouble("lat") - 31.208333) < .00001)
            check(kotlin.math.abs(imported.getJSONObject("location").getDouble("lon") - 121.504167) < .00001)
            check(imported.getJSONObject("original_location").toString() == imported.getJSONObject("location").toString())
            check(imported.getInt("width") == 4 && imported.getInt("height") == 8) { "EXIF rotated size is wrong" }
            check(imported.getString("captured_at").startsWith("2026-09-08T12:34:56"))
            check(File(media.root, "media/${imported.getString("id")}/original").readBytes().contentEquals(original))
            val assetId = imported.getString("id")
            media.mutate(JSONArray().put(JSONObject().put("op_id", "asset-label").put("kind", "assets").put("id", assetId)
                .put("base_rev", 0).put("patch", JSONObject().put("location_label", "Keep my label"))))
            val preview = File(media.root, "media/$assetId/preview.webp"); check(preview.delete())
            val repaired = media.importBytes(original)
            check(preview.isFile) { "Picking an interrupted download did not restore its missing preview" }
            check(repaired.getString("location_label") == "Keep my label") { "Repair lost existing metadata" }
            val webResult = verifyWebViewBytes(isolated)
            val locationUi = LocationUiSmoke.verify(this)
            results.putString("stream", "PASS: 24 concurrent journal stores, newer edit acknowledgement, guarded remote pull, durable conflict, in-flight metadata rebase, EXIF orientation/time, unchanged originals, missing preview recovery, JSON key/default normalization, offline provider-field preservation, starred-place persistence, permission-safe one-time map lookup, enabled-only tracking resume, durable append-only location recording, lossless daily location archives and late sync. WebView: $webResult. Location UI: $locationUi\n")
            finish(0, results)
        } catch (e: Throwable) {
            results.putString("stream", "FAIL: ${e.stackTraceToString()}\n"); finish(1, results)
        } finally {
            isolated.filesDir.deleteRecursively()
            targetContext.deleteSharedPreferences(namespace + "todopup_journal_outbox")
            targetContext.deleteSharedPreferences(namespace + "todopup_mobile_ui")
            targetContext.deleteSharedPreferences(namespace + "todopup_task_outbox")
            targetContext.deleteSharedPreferences(namespace + "todopup_tracking")
        }
    }

    private fun verifyTrackingArchives(media: MediaStore) {
        fun sample(id: String, date: String) = JSONObject().put("id", id).put("session", "qa")
            .put("at", "${date}T12:00:00+08:00").put("lat", 31.23456789).put("lon", 121.56789123)
            .put("accuracy_m", 8.0).put("speed_mps", 83.3).put("speed_accuracy_mps", .5)
            .put("bearing", 45.0).put("provider", "gps").put("mode", "precise")
        val today = "2026-09-09"; val yesterday = "2026-09-08"
        val old = sample("old", yesterday); val current = sample("current", today)
        // Migrate a legacy plain day and keep current-day writes uncompressed.
        MediaStore.write(File(media.root, "tracking/$yesterday.json"), JSONObject().put("old", old))
        media.addSamples(listOf(current), today)
        check(File(media.root, "tracking/$yesterday.json.gz").isFile)
        check(!File(media.root, "tracking/$yesterday.json").exists())
        check(File(media.root, "tracking/$today.json").isFile)
        check(!File(media.root, "tracking/$today.json.gz").exists())
        check(media.trackingDays() == listOf(yesterday, today)) { "Compressed dates disappeared from native manifest" }
        val restored = media.samples(yesterday, yesterday).single()
        check(restored.toString() == old.toString()) { "Daily gzip archive changed recorded precision or metadata" }
        val late = sample("late", yesterday)
        media.addSamples(listOf(late), today)
        check(media.samples(yesterday, yesterday).map { it.getString("id") }.toSet() == setOf("old", "late")) {
            "Late USB samples discarded existing compressed observations"
        }
        media.addSamples(listOf(late), today)
        check(media.samples(yesterday, yesterday).size == 2) { "USB retries duplicated archived samples" }
        check(media.samples(today, today).single().getString("id") == "current") { "Reading an archived day changed today's route" }
        val baseline = File(media.root, "tracking/$today.json").readBytes()
        val recorded = sample("recorded", today)
        media.appendTrackingSample(recorded, today)
        check(File(media.root, "tracking/$today.json").readBytes().contentEquals(baseline)) {
            "A live observation rewrote the current day's snapshot"
        }
        check(File(media.root, "tracking/$today.jsonl").isFile)
        check(media.samples(today, today).map { it.getString("id") }.toSet() == setOf("current", "recorded"))
        val remote = sample("remote", today)
        media.addSamples(listOf(remote), today)
        check(!File(media.root, "tracking/$today.jsonl").exists()) { "USB consolidation left a growing live log behind" }
        check(media.samples(today, today).size == 3)
        // A crash after snapshot persistence but before log deletion only repeats ids.
        val live = File(media.root, "tracking/$today.jsonl")
        live.writeText(recorded.toString() + "\n")
        check(media.samples(today, today).size == 3) { "Interrupted consolidation duplicated a recorded fix" }
        media.addSamples(listOf(JSONObject(current.toString()).put("lat", 0.0)), today)
        check(media.samples(today, today).first { it.getString("id") == "current" }.getDouble("lat") == current.getDouble("lat")) {
            "Sync changed an immutable observation's location"
        }
        val tail = "{\"interrupted\":"
        live.writeText(recorded.toString() + "\n" + tail)
        check(media.samples(today, today).size == 3) { "A partial last write hid complete observations" }
        val tomorrow = "2026-09-10"
        media.appendTrackingSample(sample("tomorrow", tomorrow), tomorrow)
        check(File(media.root, "tracking/$today.json.gz").isFile)
        check(!live.exists() && !File(media.root, "tracking/$today.json").exists())
        check(media.samples(today, today).size == 3)
        check(File(media.root, "tracking").listFiles()!!.any { it.name.contains(".recovery-") && it.readText() == tail }) {
            "Rollover removed interrupted bytes without keeping a recovery copy"
        }
        check(media.trackingDays() == listOf(yesterday, today, tomorrow)) { "A log-only day disappeared from the manifest" }
        check(!File(media.root, "tracking/$tomorrow.json").exists())
        check(media.samples(tomorrow, tomorrow).single().getString("id") == "tomorrow")
    }

    /** A detached WebView exercises fetch without opening a screen or driving the user's UI. */
    private fun verifyWebViewBytes(isolated: Context): String {
        val bytes = File(isolated.filesDir, "range.bin").apply { writeBytes(ByteArray(256) { it.toByte() }) }
        for ((offset, length) in listOf(-1L to 1, 0L to 0, 255L to 2, Long.MAX_VALUE to 1))
            check(runCatching { MediaFileResponse.bytes(bytes, "application/octet-stream", offset, length) }.isFailure) {
                "Invalid native map byte range was accepted"
            }
        val done = CountDownLatch(1); val result = AtomicReference<String>()
        val observedRange = AtomicReference<String>()
        val trace = java.util.concurrent.CopyOnWriteArrayList<String>()
        val deadline = System.currentTimeMillis() + 18_000
        lateinit var web: android.webkit.WebView
        runOnMainSync {
            web = android.webkit.WebView(targetContext)
            web.settings.javaScriptEnabled = true
            web.webChromeClient = object : android.webkit.WebChromeClient() {
                override fun onConsoleMessage(message: android.webkit.ConsoleMessage): Boolean { trace.add(message.message()); return true }
            }
            web.webViewClient = object : android.webkit.WebViewClient() {
                override fun shouldInterceptRequest(view: android.webkit.WebView, request: android.webkit.WebResourceRequest): android.webkit.WebResourceResponse? {
                    if (request.url.scheme == "data") return null
                    trace.add("request ${request.url.path}")
                    if (request.url.path == "/media-ui.js") return android.webkit.WebResourceResponse(
                        "application/javascript", "UTF-8", targetContext.assets.open("journal/media-ui.js"))
                    if (request.url.path?.startsWith("/journal/media/file/") == true) return android.webkit.WebResourceResponse(
                        "image/gif", null, targetContext.assets.open("journal/img/4-pompom.gif"))
                    if (request.url.path != "/qa-bytes") return android.webkit.WebResourceResponse(
                        "text/plain", "UTF-8", 404, "Not Found", emptyMap(), ByteArray(0).inputStream())
                    val range = request.requestHeaders.entries.firstOrNull { it.key.equals("range", true) }?.value
                    observedRange.set(range ?: "missing")
                    return MediaFileResponse.bytes(bytes, "application/octet-stream", request.url.getQueryParameter("offset")!!.toLong(), request.url.getQueryParameter("length")!!.toInt())
                }
            }
            web.loadDataWithBaseURL("https://range.qa.test/", """
                <body><script src="/media-ui.js"></script><script>
                fetch('/qa-bytes?offset=4&length=7').then(async response=>{
                    let bytes=new Uint8Array(await response.arrayBuffer());
                    const value={status:response.status,length:bytes.length,first:bytes[0],last:bytes[6],gzip:typeof DecompressionStream};
                    try {
                        const first=PupMedia.dialog('First'), second=PupMedia.dialog('Second');
                        const one=PupMedia.closeTopDialog(), remains=first.overlay.isConnected&&!second.overlay.isConnected;
                        const two=PupMedia.closeTopDialog(), gone=!first.overlay.isConnected;
                        value.modal={one,remains,two,gone,empty:PupMedia.closeTopDialog()};
                    } catch(error) { value.modal_error=String(error); }
                    try {
                        const picker=PupMedia.photoTagPicker({id:'people',name:'people',tags:['alex']},['sam'],['past friend']);
                        document.body.append(picker.wrap);
                        const visible=[...picker.wrap.querySelectorAll('input[type=checkbox]')].map(input=>input.value);
                        const input=picker.wrap.querySelector('[role=combobox]');
                        input.value='past';input.dispatchEvent(new Event('input'));
                        const suggestion=picker.wrap.querySelector('[role=option]');
                        const suggested=suggestion?.textContent==='past friend';
                        suggestion?.click();
                        value.photoTags={visible,suggested,selected:picker.values(),permanent:picker.group.tags,
                            separateKinds:picker.wrap.querySelectorAll('.media-photo-tag-zone').length};
                        picker.wrap.remove();
                    } catch(error) { value.photoTags_error=String(error); }
                    try {
                        const host=document.createElement('div'); document.body.append(host);
                        const editor=new PupMedia.Editor(host,[
                            {id:'text',type:'text',text:'linked memory',links:[{start:0,end:6,photos:['photo']}]},
                            {id:'photo',type:'photo',asset_id:'a'.repeat(64),hidden:true,caption:'Linked photo'}
                        ],'',()=>{});
                        const paragraph=host.querySelector('textarea'), passage=host.querySelector('.media-text-link');
                        passage.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
                        const stayedRendered=paragraph.hidden;
                        // Synthetic keys do not perform the browser's default button click.
                        passage.click();
                        const preview=document.querySelector('.media-dialog');
                        const previewActions=[...preview.querySelectorAll('button')];
                        const previewEdit=previewActions.some(b=>b.textContent==='Edit photo');
                        const cardEdit=[...host.querySelectorAll('button')].some(b=>b.textContent==='Edit photo');
                        const waitFor=predicate=>new Promise((resolve,reject)=>{let tries=0;const poll=()=>{const found=predicate();if(found)return resolve(found);if(++tries>100)return reject(Error('Expected photo control did not become available'));setTimeout(poll,20);};poll();});
                        const details=previewActions.find(b=>b.textContent==='Photo details');details.focus();details.click();
                        const detailDialog=await waitFor(()=>[...document.querySelectorAll('.media-dialog')].find(d=>d.querySelector('h3')?.textContent==='Photo details'&&[...d.querySelectorAll('button')].some(b=>b.textContent==='Save')));
                        [...detailDialog.querySelectorAll('button')].find(b=>b.textContent==='Save').click();
                        await waitFor(()=>!detailDialog.isConnected);
                        await waitFor(()=>preview.querySelector('.media-full-image'));
                        const nestedFocus=preview.contains(document.activeElement);
                        value.link={stayedRendered,viewer:!!document.querySelector('.media-full-image'),unchanged:editor.doc[0].text==='linked memory',previewEdit,cardEdit,nestedFocus};
                        PupMedia.closeTopDialog();
                        host.querySelector('.media-paragraph-view').click();
                        const selectedParagraph=host.querySelector('textarea');
                        selectedParagraph.setSelectionRange(7,13); selectedParagraph.dispatchEvent(new Event('select'));
                        const contextual=host.querySelector('.media-selection-actions'), linkButton=contextual.querySelector('button');
                        const selectedVisible=!contextual.hidden;
                        linkButton.focus(); document.dispatchEvent(new Event('selectionchange'));
                        const focusVisible=!contextual.hidden;
                        linkButton.click();
                        const chooser=[...document.querySelectorAll('.media-dialog')].find(d=>d.querySelector('h3').textContent==='Photos for this passage');
                        const confirm=chooser&&[...chooser.querySelectorAll('button')].find(b=>b.textContent==='Link photos');
                        const emptyDisabled=!!confirm?.disabled;
                        const check=chooser?.querySelector('input[type=checkbox]');
                        if(check){check.checked=true;check.dispatchEvent(new Event('change'));}
                        value.contextual={selectedVisible,focusVisible,chooser:!!chooser,emptyDisabled,selectionEnabled:!!confirm&&!confirm.disabled};
                        PupMedia.closeTopDialog(); editor.selectionEvents.abort();host.remove();
                    } catch(error) { value.link_error=String(error); }
                    window.qaResult=value;
                }).catch(error=>window.qaResult={error:String(error)});
                </script>
            """.trimIndent(), "text/html", "UTF-8", null)
            web.onResume(); web.resumeTimers()
            fun poll() {
                web.evaluateJavascript("window.qaResult || null") { value ->
                    if (value != null && value != "null") { result.set(value); done.countDown() }
                    else if (System.currentTimeMillis() < deadline) android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({ poll() }, 200)
                }
            }
            poll()
        }
        try {
            check(done.await(20, TimeUnit.SECONDS)) { "Detached WebView byte request timed out: $trace" }
            val value = JSONObject(result.get())
            check(value.optInt("status") == 200 && value.optInt("length") == 7 && value.optInt("first") == 4 && value.optInt("last") == 10 && observedRange.get() == "missing") {
                "WebView byte range failed: $value; native Range=${observedRange.get()}"
            }
            val modal = value.optJSONObject("modal")
            check(modal != null && modal.optBoolean("one") && modal.optBoolean("remains") && modal.optBoolean("two") && modal.optBoolean("gone") && !modal.optBoolean("empty", true)) {
                "Modal Back handling failed: $value; native Range=${observedRange.get()}"
            }
            val link = value.optJSONObject("link")
            val photoTags = value.optJSONObject("photoTags")
            check(photoTags != null && photoTags.optBoolean("suggested") && photoTags.optInt("separateKinds", -1) == 0 &&
                photoTags.getJSONArray("visible").toString() == "[\"alex\",\"sam\"]" &&
                photoTags.getJSONArray("selected").toString() == "[\"sam\",\"past friend\"]" &&
                photoTags.getJSONArray("permanent").toString() == "[\"alex\"]") {
                "Photo tag history must stay in typing suggestions without being promoted: $value"
            }
            check(link != null && link.optBoolean("stayedRendered") && link.optBoolean("viewer") && link.optBoolean("unchanged") &&
                link.optBoolean("previewEdit") && !link.optBoolean("cardEdit", true) && link.optBoolean("nestedFocus")) {
                "Linked-photo Enter changed the paragraph instead of opening its photo: $value"
            }
            val contextual = value.optJSONObject("contextual")
            check(contextual != null && listOf("selectedVisible", "focusVisible", "chooser", "emptyDisabled", "selectionEnabled").all(contextual::optBoolean)) {
                "Contextual photo linking lost its selection or keyboard focus: $value"
            }
            return "$value; native Range=${observedRange.get()}"
        } finally { runOnMainSync { web.destroy() } }
    }
}
