package com.todopup.usage

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.webkit.*
import android.widget.FrameLayout
import org.json.JSONArray
import org.json.JSONObject
import java.io.*
import java.time.LocalDate
import java.time.Instant
import java.util.UUID

/** A packaged, network-isolated editor. The only JS bridge is attached to our own origin. */
@SuppressLint("SetJavaScriptEnabled")
class MediaJournalView(private val activity: MainActivity, date: String, settingsPage: Boolean = false) : FrameLayout(activity) {
    private val web = WebView(activity)
    private val media = MediaStore(activity)
    private val journals = JournalSyncStore(activity)
    private val repository = OutboxMobileRepository(activity)
    private val io = java.util.concurrent.Executors.newSingleThreadExecutor()
    private var currentDate = date
    private val lifecycle = JournalViewLifecycle()
    private class BridgeError(val payload: JSONObject) : IllegalStateException(payload.optString("message"))
    init {
        setBackgroundColor(android.graphics.Color.parseColor(DatapomUi.BACKGROUND))
        web.setBackgroundColor(android.graphics.Color.parseColor(DatapomUi.BACKGROUND))
        web.settings.javaScriptEnabled = true; web.settings.domStorageEnabled = true
        web.settings.allowFileAccess = false; web.settings.allowContentAccess = false
        web.settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        web.settings.setSupportMultipleWindows(false)
        if (activity.packageName.endsWith(".qa")) web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                android.util.Log.d("DatapomQa", "${message.message()} (${message.sourceId()}:${message.lineNumber()})")
                return true
            }
        }
        web.addJavascriptInterface(Bridge(), "TodoPupNative")
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val u = request.url
                if (u.scheme == "https" && u.host == "todopup.local" && u.path == "/static/mobile-journal.html") {
                    u.getQueryParameter("date")?.let { currentDate = LocalDate.parse(it).toString() }; return false
                }
                if (u.scheme in setOf("https", "http") && u.host != "todopup.local") runCatching { activity.startActivity(Intent(Intent.ACTION_VIEW, u)) }
                return true
            }
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                return runCatching { serve(request) }.getOrElse {
                    if (activity.packageName.endsWith(".qa")) android.util.Log.w("DatapomQa", "Resource unavailable: ${request.url.path}", it)
                    response("text/plain", "Unavailable".byteInputStream(), 404, "Not Found")
                }
            }
        }
        addView(web, LayoutParams(-1, -1))
        web.loadUrl("https://todopup.local/static/mobile-journal.html?date=$date" + if (settingsPage) "&settings=1" else "")
    }
    fun save() { if (!lifecycle.closing && !lifecycle.released) web.evaluateJavascript("window.PupJournalEditor?.save()", null) }
    fun handleBack(result: (Boolean) -> Unit) {
        if (lifecycle.closing || lifecycle.released) { result(false); return }
        runCatching { web.evaluateJavascript("Boolean(window.PupMedia?.closeTopDialog?.())") { result(it == "true") } }
            .onFailure { result(false) }
    }
    fun dictate(value: JSONObject) { if (!lifecycle.closing && !lifecycle.released) web.evaluateJavascript("window.PupDictationCapture ? window.PupDictationCapture($value) : window.PupDictationText?.(${JSONObject.quote(value.optString("text"))})", null) }
    fun close() {
        if (!lifecycle.beginClose()) return
        activity.mediaStopDictation()
        runCatching {
            web.evaluateJavascript("Promise.resolve().then(() => window.PupJournalEditor?.save()).finally(() => TodoPupNative.closed())", null)
        }.onFailure { release() }
    }
    private fun reply(id: String, value: Any? = null, error: JSONObject? = null) {
        activity.runOnUiThread { if (lifecycle.acceptsReplies) web.evaluateJavascript("window.PupMedia.reply(${JSONObject.quote(id)},${value ?: "null"},${error ?: "null"})", null) }
    }
    private fun release() {
        if (!lifecycle.beginRelease()) return
        io.execute {
            activity.runOnUiThread { web.removeJavascriptInterface("TodoPupNative"); web.stopLoading(); web.destroy() }
            io.shutdown()
        }
    }
    private fun enqueue(action: () -> Unit) {
        if (lifecycle.released) return
        try { io.execute { action() } }
        catch (_: java.util.concurrent.RejectedExecutionException) {
            // An external photo picker can return after this editor was closed.
        }
    }
    private fun entry(date: String): JSONObject = synchronized(JournalSyncStore.guard) {
        val snapshot = repository.journal(date)
        MobileJson.draft(snapshot.draft).put("updated", if (journals.get(date) == null) JSONObject.NULL else snapshot.draft.modifiedAt)
    }
    private fun sectionJson(sections: List<JournalSection>) = JSONArray(sections.map { s ->
        JSONObject().put("id", s.id).put("name", s.name).put("type", s.type).put("color", s.color)
            .put("unit", s.unit).put("tags", JSONArray(s.tags)).put("mention_tags", JSONArray(s.mentionTags))
            .put("archived_tags", JSONArray(s.archivedTags))
            .put("managed", s.managed ?: JSONObject.NULL)
    })
    private fun taskIndex(body: String): JSONObject {
        // A damaged task cache must not prevent editing the journal. Its linked
        // records stay unavailable; the Tasks page exposes the recovery issue.
        val tasks = runCatching { repository.tasks() }.getOrDefault(emptyList())
        return JSONObject().apply {
            TaskReferenceIndex.build(tasks, body).forEach { (id, value) ->
                put(id, JSONObject().put("title", value.title).put("done", value.done).put("status", value.status))
            }
        }
    }
    inner class Bridge {
        @JavascriptInterface fun closed() {
            release()
        }
        @JavascriptInterface fun request(raw: String) {
            enqueue {
                val request = runCatching { JSONObject(raw) }.getOrNull() ?: return@enqueue
                val id = request.optString("id")
                try {
                    val path = request.getString("path"); val body = request.optJSONObject("body")
                    when {
                        path == "dialog-state" -> {
                            val open = body?.opt("open")
                            if (open !is Boolean) throw BridgeError(JSONObject().put("status", 400)
                                .put("message", "Dialog state must be true or false"))
                            activity.runOnUiThread {
                                if (!lifecycle.closing && !lifecycle.released)
                                    activity.mediaDialogState(this@MediaJournalView, open)
                                reply(id, JSONObject().put("ok", true))
                            }
                        }
                        path == "pick-photos" -> {
                            val day = body?.optString("date")?.takeIf { it.isNotBlank() }?.let(LocalDate::parse)
                            activity.runOnUiThread { activity.mediaPickPhotos(day) { uris -> enqueue {
                            runCatching { JSONObject().put("assets", JSONArray(uris.map { media.importUri(it) })) }
                                .onSuccess { reply(id, it) }.onFailure { reply(id, error = JSONObject().put("message", it.message)) }
                        } } } }
                        path == "choose-date" -> activity.runOnUiThread { activity.mediaChooseDate(currentDate, repository.entryDates()) { day -> reply(id, JSONObject().put("date", day)) } }
                        path == "dictation" -> activity.runOnUiThread { if (body?.optString("action") == "stop") activity.mediaStopDictation() else activity.mediaStartDictation(::dictate); reply(id, JSONObject().put("ok", true)) }
                        path == "tracking-control" -> activity.runOnUiThread { activity.mediaTracking(body ?: JSONObject()) { result -> reply(id, result) } }
                        path == "current-location" -> activity.runOnUiThread { activity.mediaCurrentLocation(body?.optBoolean("prompt") == true) { result -> reply(id, result) } }
                        path == "open-task" -> {
                            val taskId = requireNotNull(body).getString("id")
                            val task = repository.tasks().firstOrNull { it.id == taskId }
                            if (task == null) throw BridgeError(JSONObject().put("status", 404)
                                .put("message", "This task is no longer available.")
                                .put("task_ref_index", taskIndex("[task:$taskId]")))
                            reply(id, JSONObject().put("ok", true))
                            activity.runOnUiThread { activity.mediaOpenTask(taskId) }
                        }
                        else -> reply(id, handle(path, body))
                    }
                } catch (e: Exception) { reply(id, error = if (e is BridgeError) e.payload else JSONObject().put("message", e.message ?: "Could not save on phone")) }
            }
        }
    }
    private fun handle(rawPath: String, body: JSONObject?): Any {
        val path = rawPath.removePrefix("/journal/media/")
        return when {
            path == "bootstrap" -> {
                val snapshot = repository.journal(currentDate)
                JSONObject().put("entry", entry(currentDate)).put("message", snapshot.message)
                    .put("task_ref_index", taskIndex(snapshot.draft.body))
                    .put("sections", sectionJson(snapshot.sections))
            }
            path == "state" -> if (body == null) media.state() else media.mutate(body.getJSONArray("changes")).also { if (MobileConfig.isConfigured(activity)) MobileSyncScheduler.enqueueChanged(activity, currentDate) }
            path == "maps" -> media.maps()
            path.startsWith("tracking?") || path == "tracking" -> {
                val uri = Uri.parse("https://todopup.local/$path")
                val from = uri.getQueryParameter("from"); val to = uri.getQueryParameter("to")
                if (uri.getQueryParameter("manifest") == "1") {
                    JSONObject().put("days", JSONArray(media.trackingDays().filter { (from.isNullOrBlank() || it >= from) && (to.isNullOrBlank() || it <= to) }
                        .map { JSONObject().put("date", it) }))
                } else {
                    val samples = media.samples(from, to)
                    JSONObject().put("samples", JSONArray(samples)).put("visits", JSONArray(VisitTimeline.visits(samples, media.state().getJSONObject("places").entries().map { it.second })))
                }
            }
            path == "tracking-status" -> {
                val prefs = LocationTrackingService.preferences(activity)
                val enabled = prefs.getBoolean("enabled", false)
                val last = prefs.getLong("last_accurate_at", 0L)
                val saved = prefs.getLong("last_sample_at", 0L)
                val recent = last > 0 && System.currentTimeMillis() - last < 180_000
                val message = prefs.getString("error", null) ?: if (!enabled) "Paused · location stays private on your devices"
                    else if (!recent) "Enabled · waiting for an accurate location fix"
                    else "Auto-saving precise locations on this phone"
                JSONObject().put("enabled", enabled).put("detail_paused", prefs.getBoolean("detail_paused", false))
                    .put("last_observation", if (last > 0) Instant.ofEpochMilli(last).toString() else JSONObject.NULL)
                    .put("last_saved_at", if (saved > 0) Instant.ofEpochMilli(saved).toString() else JSONObject.NULL)
                    .put("message", message)
            }
            path == "save-image" -> JSONObject().put("asset", media.importBytes(android.util.Base64.decode(body!!.getString("png"), android.util.Base64.DEFAULT)))
            path == "entries" -> JSONObject().put("entries", JSONArray(journals.all().map { MobileJson.draft(it) }))
            path == "analytics" -> JSONObject().put("tags", JSONObject().apply {
                for (draft in journals.all()) for (block in JSONArray(draft.document ?: "[]").objects().filter { it.optString("type") == "photo" }) {
                    for (gid in (block.optJSONObject("tags") ?: JSONObject()).keys()) {
                        val counts = optJSONObject(gid) ?: JSONObject().also { put(gid, it) }
                        val names = block.getJSONObject("tags").optJSONArray(gid) ?: continue
                        for (i in 0 until names.length()) { val name = names.getString(i); counts.put(name, counts.optInt(name) + 1) }
                    }
                }
            })
            path.startsWith("entry/") -> {
                val draft = journals.get(LocalDate.parse(path.removePrefix("entry/")).toString())
                JSONObject().put("entry", draft?.let { entry(it.date) } ?: JSONObject.NULL)
                    .put("task_ref_index", taskIndex(draft?.body.orEmpty()))
            }
            path == "journal-tags/archive" -> {
                val payload = body ?: throw BridgeError(JSONObject().put("status", 400).put("message", "Choose a journal tag"))
                if (payload.opt("section_id") !is String || payload.opt("name") !is String)
                    throw BridgeError(JSONObject().put("status", 400).put("message", "Choose a journal tag"))
                synchronized(JournalSyncStore.guard) {
                    try { JournalTagRegistry(activity).archive(payload.getString("section_id"), payload.getString("name"), repository.journal(currentDate).sections) }
                    catch (error: IllegalArgumentException) { throw BridgeError(JSONObject().put("status", 400).put("message", error.message)) }
                    if (MobileConfig.isConfigured(activity)) MobileSyncScheduler.enqueueChanged(activity, currentDate)
                    JSONObject().put("sections", sectionJson(repository.journal(currentDate).sections))
                }
            }
            path == "task-ref-index" -> taskIndex(journals.get(currentDate)?.body.orEmpty())
            path.matches(Regex("journal/\\d{4}-\\d{2}-\\d{2}/photo-details")) -> savePhotoDetails(path.split('/')[1],
                body ?: throw BridgeError(JSONObject().put("status", 400).put("message", "Photo details are required")))
            path.matches(Regex("/journal/\\d{4}-\\d{2}-\\d{2}/(autosave|commit)")) -> saveEntry(path, requireNotNull(body))
            path == "discord/status" -> JSONObject().put("connected", media.state().getJSONObject("messages").length() > 0)
            path == "media-conflicts" -> media.conflicts()
            path == "media-conflicts/resolve" -> try {
                media.resolveConflict(body!!.getString("id"), body.getString("choice"), body.optString("kind").takeIf(String::isNotBlank),
                    if (body.isNull("expected_revision")) null else body.getString("expected_revision"))
                    .also { if (MobileConfig.isConfigured(activity)) MobileSyncScheduler.enqueueChanged(activity, currentDate) }
            } catch (error: MediaConflictChanged) {
                throw BridgeError(JSONObject().put("status", 409).put("message", error.message).put("current", error.current ?: JSONObject.NULL))
            }
            path == "journal-conflicts" -> JSONObject().put("conflicts", JSONArray(journals.all().filter { it.syncState == SyncState.CONFLICT }.map {
                JSONObject().put("date", it.date).put("local", MobileJson.draft(it)).put("remote", it.serverVersion).put("message", it.syncMessage)
            }))
            path == "journal-conflicts/resolve" -> resolveEntry(requireNotNull(body))
            path == "suggest-title" -> JSONObject().put("title", VoiceCommands.suggestTitle(body?.optString("text").orEmpty()))
            else -> throw IllegalArgumentException("Unavailable offline: $path")
        }
    }
    private fun savePhotoDetails(day: String, payload: JSONObject): JSONObject = synchronized(JournalSyncStore.guard) {
        val date = runCatching { LocalDate.parse(day).toString() }.getOrElse {
            throw BridgeError(JSONObject().put("status", 400).put("message", "Choose a valid journal date"))
        }
        val current = journals.get(date) ?: throw BridgeError(JSONObject().put("status", 404)
            .put("message", "This entry is no longer available"))
        val edited = try { JournalPhotoEdits.apply(current, payload) } catch (error: JournalPhotoEditError) {
            throw BridgeError(JSONObject().put("status", error.status).put("message", error.message)
                .put("current", MobileJson.draft(current).put("updated", current.modifiedAt)))
        }
        if (edited.document == current.document) return@synchronized JSONObject()
            .put("entry", MobileJson.draft(current).put("updated", current.modifiedAt))
        // This is a patch of the latest stored document, not a whole-form save:
        // preserve newer prose, fields and pending tag metadata exactly.
        val saved = journals.save(edited.copy(autosave = true, requestId = UUID.randomUUID().toString(),
            modifiedAt = JournalRevision.afterAcknowledgement(current.modifiedAt, true),
            syncState = if (current.syncState == SyncState.CONFLICT) SyncState.CONFLICT else SyncState.PENDING))
        if (MobileConfig.isConfigured(activity)) MobileSyncScheduler.enqueueChanged(activity, date)
        JSONObject().put("entry", MobileJson.draft(saved).put("updated", saved.modifiedAt))
    }
    private fun resolveEntry(body: JSONObject): JSONObject = synchronized(JournalSyncStore.guard) {
        val date = LocalDate.parse(body.getString("date")).toString(); val local = journals.get(date) ?: throw IllegalStateException("Entry is unavailable")
        if (!JournalConflictGuard.accepts(local, body)) throw BridgeError(JSONObject().put("status", 409)
            .put("message", "Entry changed again. Review the current copies before choosing.").put("current", entry(date)))
        val choice = body.getString("choice"); require(choice in setOf("local", "remote"))
        if (choice == "local") body.optJSONObject("draft")?.let { payload ->
            val updated = JournalHiddenFields.restore(MobileJson.parseDraft(JSONObject(payload.toString()).put("date", date)),
                local, repository.journal(date).sections, payload.has("audio_transcript"))
            journals.saveEdited(updated.copy(baseUpdated = local.baseUpdated, baseEditRevision = local.baseEditRevision, modifiedAt = local.modifiedAt, requestId = local.requestId,
                syncState = local.syncState, serverVersion = local.serverVersion, syncMessage = local.syncMessage), repository.journal(date).sections)
        }
        if (local.serverVersion != null) {
            val result = repository.resolveJournalConflict(date, choice == "local")
            if (result is SaveResult.Failed) throw IllegalStateException(result.message)
        } else if (choice == "local") journals.resolveWith(journals.get(date)!!, local.baseUpdated)
        val current = entry(date)
        JSONObject().put("entry", current).put("task_ref_index", taskIndex(current.optString("body")))
            .put("sections", sectionJson(repository.journal(date).sections))
    }
    private fun saveEntry(path: String, payload: JSONObject): JSONObject = synchronized(JournalSyncStore.guard) {
        val date = LocalDate.parse(path.split('/')[2]).toString(); val old = journals.get(date)
        val taskRewrite = journals.isTaskRewriteVersion(date, payload.optString("base_updated"))
        if (old != null && payload.optString("base_updated") != old.modifiedAt) {
            val error = JSONObject().put("status", 409).put("message", "Entry changed on this phone. Review the current copy before saving.").put("current", entry(date))
            if (taskRewrite) error.put("reason", "task-rewrite")
            throw BridgeError(error)
        }
        val snapshot = repository.journal(date)
        val sections = snapshot.sections
        var draft = MobileJson.parseDraft(JSONObject(payload.toString()).put("date", date)
            .put("base_updated", old?.baseUpdated ?: JSONObject.NULL)
            .put("base_edit_revision", snapshot.draft.baseEditRevision ?: JSONObject.NULL).put("autosave", !path.endsWith("/commit")))
        val tags = draft.tags.toMutableMap()
        VoiceCommands.inlineTagMap(draft.body, sections).forEach { (id, names) -> tags[id] = ((tags[id] ?: emptyList()) + names).distinct() }
        val groups = media.state().getJSONObject("groups")
        val blocks = payload.optJSONArray("document") ?: JSONArray()
        for (block in blocks.objects().filter { it.optString("type") == "photo" }) {
            for ((groupId, names) in (block.optJSONObject("tags") ?: JSONObject()).keys().asSequence().map { it to block.getJSONObject("tags").optJSONArray(it) }) {
                val group = groups.optJSONObject(groupId) ?: continue
                if (!group.optBoolean("share_entry")) continue
                val section = sections.firstOrNull { it.type == "tag" && it.name.equals(group.optString("name"), ignoreCase = true) } ?: continue
                val values = JournalTagRegistry.sharedNames(names)
                tags[section.id] = ((tags[section.id] ?: emptyList()) + values).distinct()
            }
        }
        val numbers = draft.numbers.toMutableMap()
        for (section in sections.filter { it.type == "numeric" && it.managed == null }) {
            VoiceCommands.inlineNumber(draft.body, section.name)?.let {
                if (!numbers.containsKey(section.id)) numbers[section.id] = it
            }
        }
        draft = JournalHiddenFields.restore(draft.copy(tags = tags, numbers = numbers), old, sections, payload.has("audio_transcript"))
        draft = JournalTagRegistry(activity).prepare(draft, old, sections)
        if (old == null && !MobileSyncPolicy.hasMeaningfulContent(draft)) return@synchronized JSONObject().put("entry", JSONObject.NULL)
        val saved = journals.save(draft.copy(baseUpdated = old?.baseUpdated, requestId = UUID.randomUUID().toString(), modifiedAt = JournalRevision.afterAcknowledgement(old?.modifiedAt ?: draft.modifiedAt, true),
            syncState = if (old?.syncState == SyncState.CONFLICT) SyncState.CONFLICT else SyncState.PENDING,
            serverVersion = old?.serverVersion, syncMessage = old?.syncMessage))
        if (saved.syncState == SyncState.CONFLICT) {
            val error = JSONObject().put("status", 409).put("message", "Draft kept on this phone. Review the Mac changes before syncing.")
                .put("current", saved.serverVersion).put("local", MobileJson.draft(saved).put("updated", saved.modifiedAt))
            if (taskRewrite) error.put("reason", "task-rewrite")
            throw BridgeError(error)
        }
        if (MobileConfig.isConfigured(activity)) MobileSyncScheduler.enqueueChanged(activity, date)
        JSONObject().put("entry", MobileJson.draft(saved).put("updated", saved.modifiedAt))
            .put("sections", sectionJson(repository.journal(date).sections))
            .put("task_ref_index", taskIndex(saved.body))
    }
    private fun serve(request: WebResourceRequest): WebResourceResponse {
        val uri = request.url
        require(uri.scheme == "https" && uri.host == "todopup.local")
        val path = uri.path ?: ""; require(!path.contains("..") && !path.contains('\\'))
        if (path.startsWith("/static/")) {
            val name = path.removePrefix("/static/")
            val mime = when (name.substringAfterLast('.')) { "html" -> "text/html"; "js" -> "application/javascript"; "css" -> "text/css"; "gif" -> "image/gif"; else -> "application/octet-stream" }
            return response(mime, activity.assets.open("journal/$name"))
        }
        val file = when {
            path.matches(Regex("/journal/media/maps/file/[A-Za-z0-9_-]+")) -> File(media.root, "maps/${path.substringAfterLast('/')}.pmtiles")
            path.matches(Regex("/journal/media/file/[a-f0-9]{64}/(original|preview.webp|thumb.webp)")) -> File(media.root, "media/" + path.removePrefix("/journal/media/file/"))
            else -> throw FileNotFoundException()
        }
        val mime = if (path.endsWith("webp")) "image/webp" else "application/octet-stream"
        if (uri.getQueryParameter("offset") != null || uri.getQueryParameter("length") != null) {
            require(path.startsWith("/journal/media/maps/file/"))
            val offset = uri.getQueryParameter("offset")?.toLongOrNull() ?: throw IllegalArgumentException("Invalid map offset")
            val length = uri.getQueryParameter("length")?.toIntOrNull() ?: throw IllegalArgumentException("Invalid map length")
            return MediaFileResponse.map(file, uri.getQueryParameter("v"), offset = offset, length = length)
        }
        val range = request.requestHeaders.entries.find { it.key.equals("range", true) }?.value
        if (path.startsWith("/journal/media/maps/file/")) return MediaFileResponse.map(file, uri.getQueryParameter("v"), range)
        return MediaFileResponse.create(file, mime, range)
    }
    private fun response(mime: String, stream: InputStream, code: Int = 200, reason: String = "OK") = WebResourceResponse(mime, "UTF-8", code, reason, mapOf("Cache-Control" to "no-store"), stream)
}
