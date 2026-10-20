package com.todopup.usage

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** Synthetic media server; the transport never opens a network connection. */
internal object SyncMediaChecks {
    fun run(context: Context) {
        val failures = mutableListOf<String>()
        for ((name, test) in listOf("bounded metadata batches" to ::batches,
                                   "durable conflict reconciliation" to ::conflicts,
                                   "interrupted batch replay" to ::interrupted,
                                   "stale full-state snapshots" to ::staleSnapshots,
                                   "offline metadata validation" to ::metadataValidation,
                                   "coalesced metadata acknowledgement" to ::coalescedAck,
                                   "delayed duplicate metadata acknowledgement" to ::delayedAck,
                                   "native snapshot revision" to ::snapshotRevision,
                                   "reviewed media conflict versions" to ::reviewedConflict,
                                   "malformed metadata acknowledgements" to ::malformedReplies,
                                   "seeded metadata interleavings" to ::interleavings)) {
            val store = MediaStore(context)
            store.root.deleteRecursively()
            try { test(context) } catch (error: Throwable) { failures.add("$name: $error") }
            finally { store.root.deleteRecursively() }
        }
        check(failures.isEmpty()) { failures.joinToString("\n") }
    }

    private fun malformedReplies(context: Context) {
        val corruptions: List<Pair<String, (JSONObject) -> Unit>> = listOf(
            "missing accepted record" to { it.getJSONObject("groups").remove("saved"); Unit },
            "wrong record identity" to { it.getJSONObject("groups").getJSONObject("saved").put("id", "other"); Unit },
            "missing record revision" to { it.getJSONObject("groups").getJSONObject("saved").remove("rev"); Unit },
            "fractional revision" to { it.getJSONObject("groups").getJSONObject("saved").put("rev", 1.5); Unit },
            "missing group name" to { it.getJSONObject("groups").getJSONObject("saved").remove("name"); Unit },
            "non-object collection" to { it.put("groups", JSONArray()); Unit },
            "unexpected accepted identity" to { it.getJSONArray("accepted").put("not-sent"); Unit },
            "non-text accepted identity" to { it.getJSONArray("accepted").put(12); Unit },
            "unaccounted operation" to { it.put("accepted", JSONArray()); Unit },
            "malformed conflict" to { it.put("conflicts", JSONArray().put(JSONObject.NULL)); Unit },
        )
        val accepted = mutableListOf<String>()
        for ((name, corrupt) in corruptions) {
            val store = MediaStore(context); store.root.deleteRecursively()
            store.mutate(JSONArray().put(change("saved")))
            val before = store.state().toString(); val queued = store.outbox().toString()
            val server = FakeServer().apply { transformReply = { reply -> corrupt(reply); reply } }
            if (runCatching { MediaSync(context, "http://127.0.0.1:5001", "synthetic-token", server::connection).exchange() }.isSuccess)
                accepted.add(name)
            else check(store.state().toString() == before && store.outbox().toString() == queued) {
                "Malformed $name changed saved metadata or queued edits"
            }
            store.root.deleteRecursively()
        }
        check(accepted.isEmpty()) { "Invalid successful metadata replies accepted: ${accepted.joinToString()}" }
    }

    private fun reviewedConflict(context: Context) {
        val store = MediaStore(context); val server = FakeServer()
        store.mutate(JSONArray().put(change("review")))
        server.data.getJSONObject("groups").put("review", JSONObject().put("id", "review").put("name", "Mac words").put("rev", 2))
        val sent = store.sendableChanges()
        store.mergeServer(server.apply(JSONArray(sent)), emptyList(), sent)
        val shown = store.conflicts().getJSONArray("conflicts").getJSONObject(0).getString("revision")
        check(shown == MediaStore(context).conflicts().getJSONArray("conflicts").getJSONObject(0).getString("revision"))
        store.mutate(JSONArray().put(change("review", 1, "New phone words")))
        var before = store.state().toString(); var queued = store.outbox().toString()
        check(runCatching { store.resolveConflict("review", "remote", "groups", shown) }.isFailure) { "Old media dialog discarded new phone edits" }
        check(store.state().toString() == before && store.outbox().toString() == queued)
        val refreshed = store.conflicts().getJSONArray("conflicts").getJSONObject(0).getString("revision")
        server.data.getJSONObject("groups").getJSONObject("review").put("name", "New Mac words").put("rev", 3)
        val newSent = store.outbox().objects()
        store.mergeServer(server.apply(JSONArray(newSent)), emptyList(), newSent)
        before = store.state().toString(); queued = store.outbox().toString()
        check(runCatching { store.resolveConflict("review", "local", "groups", refreshed) }.isFailure) { "Old media dialog overwrote unseen Mac edits" }
        check(store.state().toString() == before && store.outbox().toString() == queued)
        val current = store.conflicts().getJSONArray("conflicts").getJSONObject(0).getString("revision")
        store.resolveConflict("review", "remote", "groups", current)
        check(store.state().getJSONObject("groups").getJSONObject("review").getString("name") == "New Mac words")
        check(store.outbox().length() == 0)
        check(runCatching { store.resolveConflict("review", "local", "groups", current) }.isFailure)
    }

    private fun delayedAck(context: Context) {
        val store = MediaStore(context); val server = FakeServer()
        store.mutate(JSONArray().put(change("delayed")))
        val firstSent = store.sendableChanges()
        val first = server.apply(JSONArray(firstSent))
        val savedFirst = first.toString()
        store.mergeServer(first, listOf(firstSent.single().getString("op_id")), firstSent)
        store.mutate(JSONArray().put(change("delayed", 1, "Newer acknowledged edit").put("op_id", "second-edit")))
        val secondSent = store.sendableChanges()
        val second = server.apply(JSONArray(secondSent))
        check(second.getJSONObject("groups").getJSONObject("delayed").getString("name") == "Newer acknowledged edit")
        store.mergeServer(second, listOf(secondSent.single().getString("op_id")), secondSent)
        store.mergeServer(JSONObject(savedFirst), listOf(firstSent.single().getString("op_id")), firstSent)
        check(store.state().getJSONObject("groups").getJSONObject("delayed").getString("name") == "Newer acknowledged edit") {
            "A delayed duplicate ACK replaced a newer settled edit"
        }
    }

    private fun coalescedAck(context: Context) {
        val store = MediaStore(context)
        val server = FakeServer()
        store.mutate(JSONArray().put(change("coalesced")))
        store.mutate(JSONArray().put(change("coalesced", 1, "Second offline edit")))
        val sent = store.sendableChanges()
        val result = server.apply(JSONArray(sent))
        store.mergeServer(result, listOf(sent.single().getString("op_id")), sent)
        check(store.state().getJSONObject("groups").getJSONObject("coalesced").getInt("rev") == 1) {
            "Acknowledged coalesced edit kept its optimistic phone revision instead of server revision"
        }
        store.mutate(JSONArray().put(change("coalesced", 1, "After sync")))
        val next = server.apply(JSONArray(store.sendableChanges()))
        check(next.getJSONArray("conflicts").length() == 0) { "Next edit conflicted with the phone's own acknowledged edit" }
    }

    private fun snapshotRevision(context: Context) {
        val store = MediaStore(context)
        val initial = store.state().optLong("local_revision")
        store.mutate(JSONArray().put(change("clock")))
        val first = MediaStore(context).state().optLong("local_revision")
        check(first > initial) { "Offline edit did not advance the persisted native snapshot revision" }
        val sent = store.sendableChanges()
        val server = FakeServer(); val result = server.apply(JSONArray(sent))
        store.mergeServer(result, listOf(sent.single().getString("op_id")), sent)
        val ack = MediaStore(context).state().optLong("local_revision")
        check(ack > first) { "ACK did not advance native snapshot revision" }
        store.mergeServer(JSONObject(server.data.toString()), emptyList())
        check(MediaStore(context).state().optLong("local_revision") > ack) { "Remote pull did not advance native snapshot revision" }
    }

    private fun metadataValidation(context: Context) {
        val store = MediaStore(context)
        fun place() = JSONObject().put("name", "Home").put("lat", 31.2).put("lon", 121.4)
            .put("radius_m", 100).put("color", "#e0a955")
        fun mutation(kind: String, patch: JSONObject, id: String = "new-place", base: Any = JSONObject.NULL) =
            JSONObject().put("kind", kind).put("id", id).put("op_id", "edit-$id")
                .put("base_rev", base).put("patch", patch)
        val invalid = listOf(
            "blank name" to mutation("places", place().put("name", "  ")),
            "long name" to mutation("places", place().put("name", "n".repeat(201))),
            "numeric name" to mutation("places", place().put("name", 12)),
            "zero radius" to mutation("places", place().put("radius_m", 0)),
            "large radius" to mutation("places", place().put("radius_m", 500001)),
            "null radius" to mutation("places", place().put("radius_m", JSONObject.NULL)),
            "invalid radius" to mutation("places", place().put("radius_m", "NaN")),
            "latitude range" to mutation("places", place().put("lat", 90.1)),
            "longitude range" to mutation("places", place().put("lon", -180.1)),
            "missing longitude" to mutation("places", place().apply { remove("lon") }),
            "infinite latitude" to mutation("places", place().put("lat", "Infinity")),
            "invalid color" to mutation("places", place().put("color", "red")),
            "read-only field" to mutation("places", place().put("rev", 999)),
            "blank group" to mutation("groups", JSONObject().put("name", " ")),
            "group color" to mutation("groups", JSONObject().put("name", "Trips").put("color", "#abc")),
            "group tags" to mutation("groups", JSONObject().put("name", "Trips").put("tags", JSONArray().put(12))),
        )
        val accepted = mutableListOf<String>()
        for ((name, change) in invalid) {
            store.root.deleteRecursively()
            if (runCatching { store.mutate(JSONArray().put(change)) }.isSuccess) accepted.add(name)
            else check(MediaStore(context).outbox().length() == 0) { "Invalid $name left a queued change" }
        }
        check(accepted.isEmpty()) { "Invalid offline metadata accepted: ${accepted.joinToString()}" }
        store.root.deleteRecursively()
        store.mutate(JSONArray().put(mutation("places", place().put("lat", -90).put("lon", 180).put("radius_m", 10))))
        store.mutate(JSONArray().put(mutation("places", JSONObject().put("name", "New name"), base = 1)))
        check(store.state().getJSONObject("places").getJSONObject("new-place").getInt("radius_m") == 10)
        check(store.outbox().length() == 1) { "Valid partial edit did not coalesce" }
        val before = store.state().toString(); val pending = store.outbox().toString()
        check(runCatching { store.mutate(JSONArray()
            .put(mutation("groups", JSONObject().put("name", "Valid group"), "valid-group"))
            .put(mutation("places", place().put("radius_m", 0), "bad-place"))) }.isFailure)
        check(store.state().toString() == before && store.outbox().toString() == pending) { "Invalid batch partly changed disk" }
        store.mutate(JSONArray().put(mutation("groups", JSONObject().put("name", "Trips").put("color", JSONObject.NULL)
            .put("tags", JSONArray().put(" Beach ").put("beach").put("\u0001bad").put("")), "trips")))
        check(store.state().getJSONObject("groups").getJSONObject("trips").getJSONArray("tags").toString() == "[\"beach\"]")
        store.mutate(JSONArray().put(mutation("groups", JSONObject().put("name", "😀".repeat(200)), "unicode")))
        check(runCatching { store.mutate(JSONArray().put(mutation("groups", JSONObject().put("name", "😀".repeat(201)), "too-long"))) }.isFailure)

        val invalidFields = listOf(
            Triple("places", "archived", "false"), Triple("places", "is_city", 0),
            Triple("groups", "share_entry", "false"), Triple("groups", "archived", JSONArray()),
            Triple("assets", "is_sticker", "true"), Triple("assets", "captured_at", "not-a-time"),
            Triple("assets", "captured_at", "2026-02-30T12:00:00"),
            Triple("messages", "hidden", "false"), Triple("messages", "imported", 1),
            Triple("messages", "caption", JSONObject().put("body", "text")),
            Triple("messages", "date", "2026-02-30"), Triple("messages", "date", "2026-9-08"),
            Triple("messages", "date", JSONObject.NULL),
        )
        val invalidAccepted = mutableListOf<String>()
        for ((kind, field, bad) in invalidFields) {
            store.root.deleteRecursively()
            val state = store.state()
            state.getJSONObject(kind).put("target", JSONObject().put("id", "target").put("rev", 0)
                .put("name", "Kept").put("lat", 1).put("lon", 2))
            store.root.mkdirs()
            java.io.File(store.root, "state.json").writeText(state.toString())
            val unchanged = store.state().toString()
            val batch = JSONArray().put(mutation("groups", JSONObject().put("name", "Should not be saved"), "valid-first"))
                .put(mutation(kind, JSONObject().put(field, bad), "target", 0))
            if (runCatching { store.mutate(batch) }.isSuccess) invalidAccepted.add("$kind.$field=$bad")
            else check(store.state().toString() == unchanged && store.outbox().length() == 0) { "Malformed metadata partly changed disk" }
        }
        check(invalidAccepted.isEmpty()) { "Invalid metadata fields accepted: ${invalidAccepted.joinToString()}" }
    }

    private fun interrupted(context: Context) {
        for (batch in listOf(1, 2)) {
            val store = MediaStore(context)
            store.root.deleteRecursively()
            store.mutate(JSONArray((0..500).map { change("retry-$it") }))
            val server = FakeServer().apply { interruptBatch = batch }
            check(runCatching { MediaSync(context, "http://127.0.0.1:5001", "synthetic-token", server::connection).exchange() }.isFailure)
            check(MediaStore(context).outbox().length() == if (batch == 1) 501 else 1)
            MediaSync(context, "http://127.0.0.1:5001", "synthetic-token", server::connection).exchange()
            check(MediaStore(context).outbox().length() == 0)
            check(server.data.getJSONObject("groups").length() == 501)
            check(server.data.getJSONObject("groups").entries().all { it.second.getInt("rev") == 1 }) {
                "Lost response replay applied metadata twice"
            }
        }
    }

    private fun staleSnapshots(context: Context) {
        val store = MediaStore(context)
        val server = FakeServer()
        val old = JSONObject(server.data.toString())
        server.data.getJSONObject("groups").put("new", JSONObject().put("id", "new").put("name", "Current").put("rev", 3))
        store.mergeServer(JSONObject(server.data.toString()), emptyList())
        store.mergeServer(old, emptyList())
        check(store.state().getJSONObject("groups").optJSONObject("new")?.getInt("rev") == 3) {
            "A response created before another sync removed a newer settled record"
        }
        old.getJSONObject("groups").put("new", JSONObject().put("id", "new").put("name", "Older").put("rev", 1))
        store.mergeServer(old, emptyList())
        check(store.state().getJSONObject("groups").getJSONObject("new").getString("name") == "Current") {
            "A delayed state response replaced a newer record revision"
        }
    }

    private fun interleavings(context: Context) {
        val rng = java.util.Random(20260910)
        repeat(160) { index ->
            val store = MediaStore(context)
            store.root.deleteRecursively()
            val server = FakeServer()
            val id = "scenario-$index"
            server.data.getJSONObject("groups").put(id, JSONObject().put("id", id).put("name", "Original").put("rev", 1))
            store.mergeServer(JSONObject(server.data.toString()), emptyList())
            store.mutate(JSONArray().put(change(id, 1, "Phone first")))
            val sent = store.outbox().objects()
            val newer = rng.nextBoolean()
            if (newer) MediaStore(context).mutate(JSONArray().put(change(id, 2, "Phone later")))
            val conflict = rng.nextBoolean()
            if (conflict) server.data.getJSONObject("groups").getJSONObject(id).put("name", "Mac").put("rev", 2)
            val reply = server.apply(JSONArray(sent))
            store.mergeServer(reply, reply.getJSONArray("accepted").let { a -> (0 until a.length()).map(a::getString) }, sent)
            val keep = !conflict || rng.nextBoolean()
            if (conflict) {
                check(MediaStore(context).sendableChanges().isEmpty())
                MediaStore(context).resolveConflict(id, if (keep) "local" else "remote", "groups")
            }
            val next = MediaStore(context).sendableChanges()
            if (next.isNotEmpty()) {
                val accepted = server.apply(JSONArray(next))
                check(accepted.getJSONArray("conflicts").length() == 0) { "Seed 20260910, scenario $index failed to rebase" }
                // Lose the response after the server commits, then replay it.
                val replay = server.apply(JSONArray(next))
                store.mergeServer(replay, replay.getJSONArray("accepted").let { a -> (0 until a.length()).map(a::getString) }, next)
            }
            check(MediaStore(context).outbox().length() == 0)
            val expected = if (!keep) "Mac" else if (newer) "Phone later" else "Phone first"
            check(MediaStore(context).state().getJSONObject("groups").getJSONObject(id).getString("name") == expected)
            check(server.data.getJSONObject("groups").getJSONObject(id).getString("name") == expected)
        }
    }

    private fun change(id: String, base: Any? = JSONObject.NULL, name: String = id) = JSONObject()
        .put("kind", "groups").put("id", id).put("op_id", "op-$id")
        .put("base_rev", base).put("patch", JSONObject().put("name", name))

    private fun batches(context: Context) {
        val store = MediaStore(context)
        store.mutate(JSONArray((0..500).map { change("group-$it") }))
        val server = FakeServer()
        val sync = MediaSync(context, "http://127.0.0.1:5001", "synthetic-token", server::connection)
        sync.exchange()
        check(server.batchSizes == listOf(500, 1)) { "Unexpected batch sizes: ${server.batchSizes}" }
        check(server.data.getJSONObject("groups").length() == 501)
        check(MediaStore(context).outbox().length() == 0)
    }

    private fun conflicts(context: Context) {
        val store = MediaStore(context)
        val server = FakeServer()
        store.mutate(JSONArray().put(change("one")))
        val firstSent = store.outbox().objects()
        server.data.getJSONObject("groups").put("one", JSONObject().put("id", "one").put("name", "Mac").put("rev", 2))
        val response = server.apply(JSONArray(firstSent))
        store.mergeServer(response, emptyList(), firstSent)
        check(MediaStore(context).conflicts().getJSONArray("conflicts").length() == 1) { "Conflict was not saved with its pending mutation" }
        store.mutate(JSONArray().put(change("two")))
        val otherSent = store.outbox().objects().filter { it.getString("id") == "two" }
        val other = server.apply(JSONArray(otherSent))
        store.mergeServer(other, listOf("op-two"), otherSent)
        check(store.conflicts().getJSONArray("conflicts").length() == 1) { "Another batch cleared an unresolved conflict" }
        store.resolveConflict("one", "local", "groups")
        store.mergeServer(response, emptyList(), firstSent)
        check(store.conflicts().getJSONArray("conflicts").length() == 0) { "A stale response resurrected an explicitly resolved conflict" }
        val rebased = store.outbox().objects().single()
        check(rebased.getInt("base_rev") == 2 && rebased.getString("op_id") != "op-one")
    }

    internal class FakeServer {
        val data = JSONObject().put("assets", JSONObject()).put("groups", JSONObject())
            .put("places", JSONObject()).put("messages", JSONObject())
        val batchSizes = mutableListOf<Int>()
        var interruptBatch: Int? = null
        var transformReply: ((JSONObject) -> JSONObject)? = null
        private val receipts = mutableSetOf<String>()
        fun apply(changes: JSONArray): JSONObject {
            val accepted = JSONArray(); val conflicts = JSONArray()
            for (change in changes.objects()) {
                val op = change.getString("op_id"); val kind = change.getString("kind"); val id = change.getString("id")
                val collection = data.getJSONObject(kind); val old = collection.optJSONObject(id)
                if (op in receipts) accepted.put(op)
                else if (!TaskMutationJson.same(change.opt("base_rev"), old?.opt("rev") ?: JSONObject.NULL)) {
                    conflicts.put(JSONObject().put("op_id", op).put("kind", kind).put("id", id).put("current", old ?: JSONObject.NULL))
                } else {
                    val record = old ?: JSONObject().put("id", id)
                    val patch = change.getJSONObject("patch")
                    patch.keys().forEach { record.put(it, patch.get(it)) }
                    record.put("rev", (old?.optInt("rev") ?: 0) + 1); collection.put(id, record)
                    receipts.add(op); accepted.put(op)
                }
            }
            return JSONObject(data.toString()).put("accepted", accepted).put("conflicts", conflicts)
        }
        fun connection(url: URL): HttpURLConnection = object : HttpURLConnection(url) {
            val output = ByteArrayOutputStream()
            val reply by lazy {
                when {
                    url.path.endsWith("/state") && output.size() > 0 -> {
                        val changes = JSONObject(output.toString("UTF-8")).getJSONArray("changes")
                        batchSizes.add(changes.length())
                        if (changes.length() > 500) 400 to JSONObject().put("error", "Too many changes") else {
                            val result = apply(changes)
                            200 to (transformReply?.invoke(result) ?: result)
                        }
                    }
                    url.path.endsWith("/state") -> 200 to JSONObject(data.toString())
                    url.path.endsWith("/tracking") -> 200 to JSONObject().put("days", JSONArray())
                    else -> error("Unexpected synthetic request: $url")
                }
            }
            override fun connect() = Unit
            override fun disconnect() = Unit
            override fun usingProxy() = false
            override fun getOutputStream() = output
            override fun getResponseCode() = reply.first
            override fun getInputStream(): java.io.InputStream {
                val response = reply
                if (output.size() > 0 && batchSizes.size == interruptBatch) {
                    interruptBatch = null
                    throw IOException("Synthetic cable disconnect after server commit")
                }
                return ByteArrayInputStream(response.second.toString().toByteArray())
            }
            override fun getErrorStream() = inputStream
        }
    }
}
