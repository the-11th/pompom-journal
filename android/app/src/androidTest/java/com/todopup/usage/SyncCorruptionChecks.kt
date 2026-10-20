package com.todopup.usage

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** A malformed item inside valid JSON must not disappear during another save. */
internal object SyncCorruptionChecks {
    fun run(context: Context) {
        val failures = mutableListOf<String>()
        val taskPrefs = context.getSharedPreferences("todopup_task_outbox", Context.MODE_PRIVATE)
        val good = TaskMutation(requestId = "good", operation = "create", payload = JSONObject().put("id", "good-task"))
        val brokenTasks = listOf(JSONObject.NULL, 7, "lost edit",
            JSONObject().put("operation", "create").put("payload", JSONObject()),
            TaskMutationJson.encode(good).put("payload", "lost payload"),
            TaskMutationJson.encode(good).put("operation", 5))
        for ((index, broken) in brokenTasks.withIndex()) {
            val raw = JSONArray().put(TaskMutationJson.encode(good)).put(broken).toString()
            for ((name, action) in listOf<Pair<String, () -> Unit>>(
                "read" to { TaskOutbox(context).pending(); Unit },
                "ack" to { TaskOutbox(context).acknowledge("good") },
                "enqueue" to { TaskOutbox(context).enqueue(good.copy(requestId = "later")); Unit },
            )) {
                taskPrefs.edit().clear().putString("mutations_v1", raw).commit()
                if (runCatching(action).isSuccess || taskPrefs.getString("mutations_v1", null) != raw ||
                    taskPrefs.getString("mutations_corrupt_backup", null) != raw) failures.add("task $index $name")
            }
        }
        taskPrefs.edit().clear().commit()

        val journalPrefs = context.getSharedPreferences("todopup_journal_outbox", Context.MODE_PRIVATE)
        val draft = JournalDraft("2026-09-10", body = "Keep this valid entry")
        val brokenDate = "2026-09-09"
        val brokenJournals = listOf(JSONObject.NULL, 7, "lost entry", JSONObject().put("body", "Missing date"),
            MobileJson.draft(draft), MobileJson.draft(draft.copy(date = brokenDate)).put("body", JSONObject().put("text", "Lost words")),
            MobileJson.draft(draft.copy(date = brokenDate)).put("tags", JSONArray().put("lost tag")))
        for ((index, broken) in brokenJournals.withIndex()) {
            val raw = JSONObject().put(draft.date, MobileJson.draft(draft)).put(brokenDate, broken).toString()
            for ((name, action) in listOf<Pair<String, () -> Unit>>(
                "all" to { JournalSyncStore(context).all(); Unit },
                "get" to { JournalSyncStore(context).get(brokenDate); Unit },
                "save" to { JournalSyncStore(context).save(draft.copy(body = "Later valid edit")); Unit },
                "remove" to { JournalSyncStore(context).remove(draft.date) },
            )) {
                journalPrefs.edit().clear().putString("drafts_v1", raw).commit()
                if (runCatching(action).isSuccess || journalPrefs.getString("drafts_v1", null) != raw ||
                    journalPrefs.getString("drafts_corrupt_backup", null) != raw) failures.add("journal $index $name")
            }
        }
        journalPrefs.edit().clear().commit()
        val legacy = JSONObject().put(draft.date, JSONObject().put("date", draft.date).put("body", "Older entry"))
        journalPrefs.edit().putString("drafts_v1", legacy.toString()).commit()
        val first = JournalSyncStore(context).get(draft.date)!!
        val reopened = JournalSyncStore(context).get(draft.date)!!
        if (first.requestId != reopened.requestId || first.modifiedAt != reopened.modifiedAt || first.body != "Older entry")
            failures.add("legacy draft identity changes on every read")
        journalPrefs.edit().clear().commit()
        val media = MediaStore(context)
        val change = JSONObject().put("kind", "groups").put("id", "good-group").put("op_id", "good-change")
            .put("base_rev", JSONObject.NULL).put("patch", JSONObject().put("name", "Good group"))
        for ((index, broken) in listOf(JSONObject.NULL, 7, "lost change",
            JSONObject(change.toString()).put("patch", "lost fields")).withIndex()) {
            val raw = JSONObject().put("changes", JSONArray().put(change).put(broken)).toString()
            for ((name, action) in listOf<Pair<String, () -> Unit>>(
                "read" to { MediaStore(context).outbox(); Unit },
                "mutate" to { MediaStore(context).mutate(JSONArray().put(JSONObject(change.toString()).put("id", "later"))); Unit },
            )) {
                media.root.deleteRecursively(); media.root.mkdirs()
                val file = java.io.File(media.root, "outbox.json"); file.writeText(raw)
                if (runCatching(action).isSuccess || file.readText() != raw ||
                    java.io.File(file.path + ".bak").takeIf { it.isFile }?.readText() != raw) failures.add("media outbox $index $name")
            }
        }
        for ((index, broken) in listOf(JSONObject.NULL, 7, "lost record", JSONObject().put("name", "No identity")).withIndex()) {
            media.root.deleteRecursively(); media.root.mkdirs()
            val raw = JSONObject().put("groups", JSONObject().put("damaged", broken)).toString()
            val file = java.io.File(media.root, "state.json"); file.writeText(raw)
            if (runCatching { MediaStore(context).state() }.isSuccess || file.readText() != raw ||
                java.io.File(file.path + ".bak").takeIf { it.isFile }?.readText() != raw) failures.add("media state $index")
        }
        media.root.deleteRecursively()
        check(failures.isEmpty()) { "Malformed records were hidden or overwritten: ${failures.joinToString()}" }
    }
}
