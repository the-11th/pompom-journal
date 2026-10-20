package com.todopup.usage

import android.content.Context
import org.json.JSONObject

/** Recreate repositories between operations to exercise durable state, not object caches. */
internal object SyncInterleavingChecks {
    fun run(context: Context) {
        val rng = java.util.Random(20260911)
        val prefs = context.getSharedPreferences("todopup_task_outbox", Context.MODE_PRIVATE)
        repeat(200) { index ->
            prefs.edit().clear().commit()
            MobileCache(context).saveTasks(emptyList())
            val original = MobileTask("seeded-$index", "  Original $index  ", notes = "  Original notes  ")
            OutboxMobileRepository(context, scheduleTaskSync = {}).saveTask(original, null)
            var expected = original
            repeat(2 + rng.nextInt(7)) { edit ->
                val before = MobileCache(context).tasks().single()
                expected = when (rng.nextInt(5)) {
                    0 -> before.copy(title = "  Title $edit  ")
                    1 -> before.copy(notes = "  Notes $edit  ")
                    2 -> before.copy(due = if (rng.nextBoolean()) null else "2030-09-${11 + edit}T09:30")
                    3 -> before.copy(tags = listOf("tag-$edit"))
                    else -> before.copy(subtasks = listOf(MobileSubtask("Item $edit", rng.nextBoolean())))
                }
                OutboxMobileRepository(context, scheduleTaskSync = {}).saveTask(expected, before)
            }
            var server: MobileTask? = null
            while (TaskOutbox(context).sendable().isNotEmpty()) {
                val sent = TaskOutbox(context).sendable().first()
                val proposed = TaskMutationJson.snapshot(sent)
                if (server == null) server = proposed else {
                    val current = MobileJson.task(server!!)
                    val base = sent.payload.getJSONObject("base")
                    for (key in base.keys()) check(TaskMutationJson.same(current.opt(key), base.opt(key)) ||
                        sent.payload.has(key) && TaskMutationJson.same(current.opt(key), sent.payload.opt(key))) {
                        "Seed20260911 task$index field$key falsely conflicted after an earlier acknowledgement"
                    }
                    server = TaskEdits.overlay(server!!, proposed, TaskMutationJson.fields(sent))
                }
                server = server!!.copy(title = server!!.title.trim(), notes = server!!.notes.trim())
                // Reopened storage still has the mutation after a lost response.
                check(TaskOutbox(context).pending().first().requestId == sent.requestId)
                MobileCache(context).acknowledgeTask(sent, server!!)
            }
            expected = expected.copy(title = expected.title.trim(), notes = expected.notes.trim())
            check(server == expected) { "Seed20260911 task$index lost a queued field" }
            check(MobileCache(context).tasks().single() == expected) { "Seed20260911 task$index cache diverged" }
        }
        prefs.edit().clear().commit()
        MobileCache(context).saveTasks(emptyList())

        repeat(240) { index ->
            val sent = JournalDraft("2026-09-10", title = "Day", body = "Sent $index",
                requestId = "sent-$index", modifiedAt = "local-before-$index", baseUpdated = "mac-before-$index",
                baseEditRevision = "content-before-$index", syncState = SyncState.PENDING)
            JournalSyncStore(context).save(sent)
            var typed = sent
            repeat(1 + rng.nextInt(5)) { edit ->
                typed = OutboxMobileRepository(context).saveJournalDraft(typed.copy(body = "Typed $index:$edit")).draft
            }
            val remote = sent.copy(baseUpdated = "mac-after-$index", baseEditRevision = "content-after-$index")
            check(!JournalSyncStore(context).applyRemote(sent.date, sent, remote))
            JournalSyncStore(context).markSynced(sent.date, remote, sent)
            val reopened = JournalSyncStore(context).get(sent.date)!!
            check(reopened.body == typed.body && reopened.requestId == typed.requestId)
            check(reopened.baseUpdated == remote.baseUpdated && reopened.baseEditRevision == remote.baseEditRevision)
            check(reopened.syncState == SyncState.DRAFT)
            JournalSyncStore(context).remove(sent.date)
        }
        MobileCache(context).saveConfig(MobileJournalConfig(emptyList(), emptyEditRevision = "empty-server-revision"))
        check(OutboxMobileRepository(context).journal("2026-09-11").draft.baseEditRevision == "empty-server-revision")
    }
}
