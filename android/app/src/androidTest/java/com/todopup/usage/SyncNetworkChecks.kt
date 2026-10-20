package com.todopup.usage

import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL

/** Synthetic HTTP responses exercise Android JSON semantics without a network or credentials. */
internal object SyncNetworkChecks {
    fun run() {
        val usbWork = MobileSyncScheduler.request("2026-09-10")
        check(usbWork.workSpec.constraints.requiredNetworkType == androidx.work.NetworkType.NOT_REQUIRED) {
            "USB loopback synchronization incorrectly waits for an internet-connected network"
        }
        check(usbWork.workSpec.input.getString(MobileSyncScheduler.KEY_DATE) == "2026-09-10")
        check(MobileSyncScheduler.request(null, true).workSpec.input.getBoolean(MobileSyncScheduler.KEY_EXPLICIT, false))
        val task = MobileTask("task-no-due", "No due date")
        val createConnection = Response(201, JSONObject().put("ok", true).put("task", MobileJson.task(task)).toString())
        val api = MobileApiClient("http://127.0.0.1:5001", "synthetic-token") { createConnection }
        val result = api.applyTaskMutation(TaskMutation(operation = "create", payload = MobileJson.task(task)))
        check(result is ApiResult.Success<*>)
        val body = JSONObject(createConnection.output.toString(Charsets.UTF_8.name()))
        check(body.isNull("due")) { "A task with no due date sent the literal text null" }
        check(body.getString("client_id") == task.id)
        check(!createConnection.instanceFollowRedirects) { "Mobile requests should not follow redirects" }

        val busy = MobileApiClient("http://127.0.0.1:5001", "synthetic-token") {
            Response(503, "<html>Mac is restarting</html>")
        }.getTasks()
        check(busy is ApiResult.TransientError && busy.status == 503) {
            "A temporary HTML server response permanently rejected queued edits"
        }
        val malformed = MobileApiClient("http://127.0.0.1:5001", "synthetic-token") {
            Response(200, "{interrupted JSON")
        }.getTasks()
        check(malformed is ApiResult.TransientError) { "An unreadable response must leave edits queued" }
        for (bodyText in listOf("{}", "{\"tasks\":[null]}", "{\"tasks\":[{}]}", "{\"tasks\":[{\"id\":\"broken\",\"title\":null}]}")) {
            val incomplete = MobileApiClient("http://127.0.0.1:5001", "synthetic-token") {
                Response(200, bodyText)
            }.getTasks()
            check(incomplete is ApiResult.TransientError) { "An incomplete task response was treated as an empty remote list" }
        }
        val incompleteConfig = MobileApiClient("http://127.0.0.1:5001", "synthetic-token") {
            Response(200, "{}")
        }.getConfig()
        check(incompleteConfig is ApiResult.TransientError) { "An incomplete config could erase synced journal dates" }
        val rejected = MobileApiClient("http://127.0.0.1:5001", "synthetic-token") {
            Response(400, "<html>Invalid request</html>")
        }.getTasks()
        check(rejected is ApiResult.PermanentError && rejected.status == 400)

        for (bodyText in listOf("{}", "{\"ok\":true}", "{\"task\":{}}", JSONObject()
            .put("ok", true).put("task", MobileJson.task(task.copy(id = "wrong-task"))).toString())) {
            val invalidAck = MobileApiClient("http://127.0.0.1:5001", "synthetic-token") {
                Response(201, bodyText)
            }.applyTaskMutation(TaskMutation(operation = "create", payload = MobileJson.task(task)))
            check(invalidAck is ApiResult.TransientError) { "Malformed task acknowledgement could discard the queued task: $bodyText" }
        }

        val deletion = TaskMutationJson.deletion(task)
        val deleteConnection = Response(200, "{\"ok\":true}")
        MobileApiClient("http://127.0.0.1:5001", "synthetic-token") { deleteConnection }
            .applyTaskMutation(deletion)
        val deleteBody = JSONObject(deleteConnection.output.toString(Charsets.UTF_8.name()))
        check(deleteBody.getJSONObject("base").getString("title") == task.title) {
            "Task deletion omitted its baseline"
        }
        check(!deleteBody.has("snapshot"))

        val storedDraft = JournalDraft("2026-09-10", body = "Phone text", baseUpdated = "mac-before",
            baseEditRevision = "before-edit-revision")
        val server = MobileJson.draft(storedDraft).apply { remove("base_edit_revision") }.put("id", "journal-id")
            .put("updated", "mac-after").put("edit_revision", "after-edit-revision")
        val journalConnection = Response(200, JSONObject().put("ok", true).put("entry", server).toString())
        val journalResult = MobileApiClient("http://127.0.0.1:5001", "synthetic-token") { journalConnection }
            .putJournal(storedDraft)
        check(journalResult is ApiResult.Success && journalResult.value.baseEditRevision == "after-edit-revision")
        check(JSONObject(journalConnection.output.toString(Charsets.UTF_8.name()))
            .getString("base_edit_revision") == "before-edit-revision")
        check(MobileJson.parseDraft(MobileJson.draft(storedDraft)).baseEditRevision == storedDraft.baseEditRevision)
        val invalidEntries = listOf(
            JSONObject().put("date", storedDraft.date).put("updated", "mac-after"),
            JSONObject(server.toString()).put("date", "2026-09-09"),
            JSONObject(server.toString()).put("body", JSONObject.NULL),
            JSONObject(server.toString()).put("tags", org.json.JSONArray()),
            JSONObject(server.toString()).put("numbers", JSONObject().put("weight", "invalid")),
            JSONObject(server.toString()).put("mood", 2.5),
            JSONObject(server.toString()).put("document", "not a document"),
        )
        val unsafe = mutableListOf<Int>()
        for ((index, entry) in invalidEntries.withIndex()) {
            val bad = MobileApiClient("http://127.0.0.1:5001", "synthetic-token") {
                Response(200, JSONObject().put("ok", true).put("entry", entry).toString())
            }
            if (bad.putJournal(storedDraft) !is ApiResult.TransientError || bad.getJournal(storedDraft.date) !is ApiResult.TransientError) unsafe.add(index)
        }
        check(unsafe.isEmpty()) { "Malformed journal responses could discard or misdate saved edits: $unsafe" }

        val accepted = mutableListOf<String>()
        for (text in listOf("{}", "{\"ok\":false}", "{\"ok\":\"true\"}")) {
            val invalid = MobileApiClient("http://127.0.0.1:5001", "synthetic-token") { Response(200, text) }
            if (invalid.deleteTask(task.id, "delete") !is ApiResult.TransientError) accepted.add("delete $text")
            if (invalid.addTaskTag("tag", "work", "#e0a955") !is ApiResult.TransientError) accepted.add("task tag $text")
            if (invalid.addJournalTag("tag", "people", "alex") !is ApiResult.TransientError) accepted.add("journal tag $text")
        }
        for (text in listOf("<html>Conflict</html>", "{}", "{\"current\":{}}", "{\"current\":[]}", "{\"current\":false}")) {
            val invalid = MobileApiClient("http://127.0.0.1:5001", "synthetic-token") { Response(409, text) }
            if (invalid.putJournal(storedDraft) !is ApiResult.TransientError) accepted.add("journal conflict $text")
            if (invalid.updateTask(task.id, "update", JSONObject()) !is ApiResult.TransientError) accepted.add("task conflict $text")
            if (invalid.deleteTask(task.id, "delete") !is ApiResult.TransientError) accepted.add("deletion conflict $text")
        }
        val wrongDay = JSONObject().put("current", JSONObject(server.toString()).put("date", "2026-09-09"))
        val wrongJournal = MobileApiClient("http://127.0.0.1:5001", "synthetic-token") { Response(409, wrongDay.toString()) }
        if (wrongJournal.putJournal(storedDraft) !is ApiResult.TransientError) accepted.add("wrong journal date")
        val wrongTask = JSONObject().put("current", MobileJson.task(task.copy(id = "another-task")))
        val wrongTaskApi = MobileApiClient("http://127.0.0.1:5001", "synthetic-token") { Response(409, wrongTask.toString()) }
        if (wrongTaskApi.updateTask(task.id, "update", JSONObject()) !is ApiResult.TransientError) accepted.add("wrong task identity")
        check(accepted.isEmpty()) { "Unsafe acknowledgement/conflict responses were accepted (${accepted.size}): $accepted" }

        val deleted = MobileApiClient("http://127.0.0.1:5001", "synthetic-token") { Response(409, "{\"current\":null}") }
        check(deleted.putJournal(storedDraft) is ApiResult.Conflict) { "Explicit remote journal deletion must remain reviewable" }
        check(deleted.updateTask(task.id, "update", JSONObject()) is ApiResult.Conflict) { "Explicit remote task deletion must remain reviewable" }
        for (field in listOf("current", "entry")) {
            val valid = MobileApiClient("http://127.0.0.1:5001", "synthetic-token") {
                Response(409, JSONObject().put(field, server).toString())
            }.putJournal(storedDraft)
            check(valid is ApiResult.Conflict && valid.current.getString("body") == storedDraft.body)
        }
        val taskConflict = MobileApiClient("http://127.0.0.1:5001", "synthetic-token") {
            Response(409, JSONObject().put("current", MobileJson.task(task)).toString())
        }.updateTask(task.id, "update", JSONObject())
        check(taskConflict is ApiResult.Conflict)
    }

    private class Response(private val status: Int, private val body: String) :
        HttpURLConnection(URL("http://127.0.0.1:5001")) {
        val output = ByteArrayOutputStream()
        override fun connect() = Unit
        override fun disconnect() = Unit
        override fun usingProxy() = false
        override fun setRequestMethod(value: String) { method = value }
        override fun getOutputStream() = output
        override fun getResponseCode() = status
        override fun getInputStream() = ByteArrayInputStream(body.toByteArray(Charsets.UTF_8))
        override fun getErrorStream() = inputStream
    }
}
