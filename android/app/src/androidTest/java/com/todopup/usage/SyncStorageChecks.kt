package com.todopup.usage

import android.content.Context
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Sync regressions use only the runner's disposable preference namespace. */
internal object SyncStorageChecks {
    fun run(context: Context) {
        val prefs = context.getSharedPreferences("todopup_task_outbox", Context.MODE_PRIVATE)
        prefs.edit().clear().commit()
        val count = 48
        val gate = CountDownLatch(1)
        val done = CountDownLatch(count)
        val errors = java.util.Collections.synchronizedList(mutableListOf<Throwable>())
        repeat(count) { index ->
            Thread {
                try {
                    gate.await()
                    TaskOutbox(context).enqueue(TaskMutation(requestId = "parallel-task-$index",
                        operation = "create", payload = JSONObject().put("id", "task-$index")))
                } catch (error: Throwable) {
                    errors.add(error)
                } finally {
                    done.countDown()
                }
            }.start()
        }
        gate.countDown()
        check(done.await(20, TimeUnit.SECONDS)) { "Concurrent task stores did not complete" }
        check(errors.isEmpty()) { errors.toString() }
        val queued = TaskOutbox(context).pending()
        check(queued.size == count && queued.map { it.requestId }.toSet().size == count) {
            "Concurrent task stores lost changes: ${queued.size} of $count remain"
        }
        prefs.edit().clear().commit()
        prefs.edit().putString("mutations_v1", "broken queue data").commit()
        check(runCatching { TaskOutbox(context).pending() }.isFailure) {
            "Unreadable task changes were silently treated as an empty outbox"
        }
        check(prefs.getString("mutations_corrupt_backup", null) == "broken queue data") {
            "Unreadable task changes need a recovery copy"
        }
        prefs.edit().clear().commit()

        val sent = JournalDraft("2026-09-10", body = "Sent text", requestId = "draft-sent",
            modifiedAt = "2026-09-10T01:00:00Z", baseUpdated = "mac-v1", syncState = SyncState.PENDING)
        JournalSyncStore(context).save(sent)
        val newer = OutboxMobileRepository(context).saveJournalDraft(sent.copy(body = "Newer typing")).draft
        check(newer.requestId != sent.requestId && newer.modifiedAt != sent.modifiedAt) {
            "New draft content reused an in-flight request identity"
        }
        JournalSyncStore(context).markSynced(sent.date, sent.copy(baseUpdated = "mac-v2"), sent)
        check(JournalSyncStore(context).get(sent.date)?.body == newer.body) {
            "A draft acknowledgement replaced newer typing"
        }
        JournalSyncStore(context).remove(sent.date)

        val viewed = sent.copy(syncState = SyncState.SYNCED, baseEditRevision = "same-edit", numbers = mapOf("sleep" to 5.0))
        JournalSyncStore(context).save(viewed)
        check(JournalSyncStore(context).applyRemote(viewed.date, viewed,
            viewed.copy(baseUpdated = "provider-new", modifiedAt = "pull-time", numbers = mapOf("sleep" to 8.0))))
        val imported = JournalSyncStore(context).get(viewed.date)!!
        check(imported.modifiedAt == viewed.modifiedAt && imported.numbers["sleep"] == 8.0) {
            "Provider-only pull invalidated the open editor or lost the imported value"
        }
        JournalSyncStore(context).remove(viewed.date)

        val conflicted = sent.copy(syncState = SyncState.CONFLICT,
            serverVersion = JSONObject().put("body", "Mac words").put("updated", "mac-conflict"))
        val choice = JSONObject().put("expected_updated", conflicted.modifiedAt)
            .put("expected_server_version", JSONObject(conflicted.serverVersion.toString()))
        check(JournalConflictGuard.accepts(conflicted, choice))
        check(JournalConflictGuard.accepts(conflicted, JSONObject())) { "Legacy conflict choices must remain compatible" }
        check(!JournalConflictGuard.accepts(conflicted.copy(modifiedAt = "new local edit"), choice)) { "Stale dialog discarded newer phone typing" }
        check(!JournalConflictGuard.accepts(conflicted.copy(serverVersion = JSONObject().put("body", "New Mac words")
            .put("updated", "mac-conflict")), choice)) { "Stale dialog accepted a newer Mac conflict with the same timestamp" }
        check(!JournalConflictGuard.accepts(conflicted.copy(serverVersion = null, syncState = SyncState.SYNCED), choice)) {
            "A repeated choice resolved an already resolved conflict"
        }

        val cache = MobileCache(context)
        val initial = MobileTask("task-pull", "Initial")
        cache.saveTasks(listOf(initial))
        val expected = cache.tasks()
        TaskOutbox(context).enqueue(TaskMutation(operation = "update", taskId = initial.id,
            payload = JSONObject().put("title", "New phone title")))
        check(!cache.applyRemoteTasks(expected, listOf(initial.copy(title = "Mac title")))) {
            "A task pull replaced a change queued while the request was in flight"
        }
        prefs.edit().clear().commit()
        cache.saveTasks(listOf(initial.copy(title = "Newer cached title")))
        check(!cache.applyRemoteTasks(expected, listOf(initial.copy(title = "Mac title")))) {
            "A stale task response replaced a newer cache revision"
        }
        val fresh = cache.tasks()
        check(cache.applyRemoteTasks(fresh, listOf(initial.copy(title = "Mac title"))))
        check(cache.tasks().single().title == "Mac title")

        val repository = OutboxMobileRepository(context, scheduleTaskSync = {})
        val beforeEdit = MobileTask("task-fields", "Before", notes = "Old notes")
        cache.saveTasks(listOf(beforeEdit.copy(title = "Mac title")))
        repository.saveTask(beforeEdit.copy(notes = "Phone notes"), beforeEdit)
        val edited = TaskOutbox(context).pending().single()
        check(edited.payload.has("notes") && !edited.payload.has("title"))
        check(edited.payload.getJSONObject("base").getString("notes") == "Old notes")
        check(cache.tasks().single().title == "Mac title") { "Editing notes replaced an unrelated Mac title" }
        val mac = beforeEdit.copy(title = "New Mac title", notes = "Mac notes")
        TaskOutbox(context).markConflict(edited.requestId, MobileJson.task(mac), "Review task")
        val phone = cache.tasks().single()
        repository.saveTask(phone.copy(due = "2026-09-11T23:59"), phone)
        check(TaskOutbox(context).retryFailed() == 0) { "An explicit sync retried a conflict without review" }
        check(TaskOutbox(context).sendable().isEmpty()) { "A later edit bypassed an earlier task conflict" }
        val reopened = OutboxMobileRepository(context, scheduleTaskSync = {})
        val review = reopened.taskConflicts().single()
        check(review.local?.notes == "Phone notes" && review.local?.title == "New Mac title")
        check(review.local?.due == "2026-09-11T23:59") { "Conflict review lost a later queued phone edit" }
        reopened.resolveTaskConflict(review.requestId, true)
        val resolved = TaskOutbox(context).pending().single()
        check(!resolved.conflict && resolved.requestId != edited.requestId)
        check(resolved.payload.getJSONObject("base").getString("notes") == "Mac notes")
        check(!resolved.payload.has("title")) { "Keeping phone edits overwrote an unrelated Mac field" }
        check(cache.tasks().single().title == "New Mac title")
        TaskOutbox(context).markConflict(resolved.requestId, MobileJson.task(mac), "Changed again")
        reopened.resolveTaskConflict(resolved.requestId, false)
        check(TaskOutbox(context).pending().isEmpty() && TaskOutbox(context).failed().isEmpty())
        check(cache.tasks().single() == mac) { "Using Mac did not discard the blocked phone edits" }

        for (status in listOf("completed", "expired", "deleted")) {
            prefs.edit().clear().commit()
            val original = MobileTask("status-$status", "Original", recurrence = "daily")
            cache.saveTasks(listOf(original))
            repository.saveTask(original.copy(notes = "Phone draft"), original)
            val pending = TaskOutbox(context).pending().single()
            val remote = original.copy(status = status, done = status == "completed", notes = "Mac notes")
            TaskOutbox(context).markConflict(pending.requestId,
                if (status == "deleted") JSONObject() else MobileJson.task(remote), "Status changed")
            val conflict = OutboxMobileRepository(context, scheduleTaskSync = {}).taskConflicts().single()
            check(conflict.resolution == if (status == "completed") "reopen" else "copy")
            repository.resolveTaskConflict(conflict.requestId, true)
            val resolution = TaskOutbox(context).pending().single()
            val chosen = TaskMutationJson.snapshot(resolution)
            check(chosen.notes == "Phone draft" && !chosen.done && chosen.status == "active")
            if (status == "completed") {
                check(resolution.operation == "update" && chosen.id == original.id)
                check(resolution.payload.getJSONObject("base").getString("status") == "completed")
            } else {
                check(resolution.operation == "create" && chosen.id != original.id && chosen.recurrence == null)
                check(cache.tasks().any { it == remote } == (status == "expired"))
            }
            check(runCatching { repository.resolveTaskConflict(conflict.requestId, true) }.isFailure)
            TaskOutbox(context).markFailed(resolution.requestId, "Temporary validation recovery")
            TaskOutbox(context).retryFailed()
            val retried = TaskOutbox(context).pending().single()
            check(retried.requestId == resolution.requestId && TaskMutationJson.targetId(retried) == chosen.id) {
                "Retrying an explicit conflict copy created a second task identity"
            }
        }
        prefs.edit().clear().commit()
        val raw = MobileTask("normalized-task", "  A task  ", notes = "  First notes  ")
        cache.saveTasks(emptyList())
        repository.saveTask(raw, null)
        val create = TaskOutbox(context).pending().single()
        repository.saveTask(raw.copy(notes = "Later notes"), raw)
        cache.acknowledgeTask(create, raw.copy(title = "A task", notes = "First notes"))
        val next = TaskOutbox(context).pending().single()
        check(next.payload.getJSONObject("base").getString("notes") == "First notes") {
            "Queued edit retained a pre-normalization baseline after creation was acknowledged"
        }
        check(cache.tasks().single().title == "A task" && cache.tasks().single().notes == "Later notes") {
            "Acknowledging normalized task fields replaced later phone edits"
        }
        prefs.edit().clear().commit()
    }
}
