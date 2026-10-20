package com.todopup.usage

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

class MobileSyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val context = applicationContext
        if (!MobileConfig.isConfigured(context)) return@withContext Result.failure()
        val api = MobileApiClient(MobileConfig.baseUrl(context), MobileConfig.token(context))
        val journals = JournalSyncStore(context)
        val tasks = TaskOutbox(context)
        val cache = MobileCache(context)
        val report = MobileSyncReport()
        val explicit = inputData.getBoolean(MobileSyncScheduler.KEY_EXPLICIT, false)
        var shouldRetry = false
        var retryMessage: String? = null

        var mediaAvailable = true
        try {
            report.mediaFiles = MediaSync(context).exchange()
        } catch (e: Exception) {
            mediaAvailable = false; shouldRetry = true; retryMessage = "Media sync pending: ${e.message}"
        }

        if (explicit) {
            journals.promoteDraftsForExplicitSync()
            tasks.retryFailed()
        }

        for (draft in journals.pending().filter { mediaAvailable || !MobileSyncPolicy.hasMedia(it) }) when (val result = api.putJournal(draft)) {
            is ApiResult.Success -> {
                journals.markSynced(draft.date, result.value, draft)
                report.journalUploaded++
            }
            is ApiResult.Conflict -> {
                val remote = MobileJson.parseDraft(org.json.JSONObject(result.current.toString())
                    .put("date", draft.date).put("request_id", draft.requestId)
                    .put("sync_state", SyncState.SYNCED.name)
                    .put("base_updated", result.current.optString("updated")))
                if (MobileSyncPolicy.matchesRemote(draft, remote)) {
                    journals.markSynced(draft.date, remote, draft)
                } else journals.markConflict(draft.date, draft.requestId,
                    result.current, result.message)
            }
            is ApiResult.PermanentError -> journals.markPermanentFailure(draft.date,
                draft.requestId, result.message)
            is ApiResult.TransientError -> {
                shouldRetry = true
                retryMessage = result.message
            }
        }

        taskLoop@ for (queued in tasks.sendable()) {
            // Earlier acknowledgements may normalize a later edit's baseline.
            val mutation = tasks.sendable().firstOrNull { it.requestId == queued.requestId } ?: continue@taskLoop
            if (TaskMutationJson.targetId(mutation) in tasks.blockedTaskIds()) continue@taskLoop
            val result = api.applyTaskMutation(mutation)
            when (result) {
                is ApiResult.Success -> {
                    if (result.value is MobileTask) cache.acknowledgeTask(mutation, result.value)
                    else tasks.acknowledge(mutation.requestId)
                    report.phoneChangesUploaded++
                }
                is ApiResult.TransientError -> {
                    // Preserve outbox order: a later edit may target a create
                    // that the unreachable server has not accepted yet.
                    shouldRetry = true
                    retryMessage = result.message
                    break@taskLoop
                }
                is ApiResult.PermanentError -> tasks.markFailed(mutation.requestId, result.message)
                is ApiResult.Conflict -> if (TaskMutationJson.targetId(mutation) != null)
                    tasks.markConflict(mutation.requestId, result.current, result.message)
                else tasks.markFailed(mutation.requestId, result.message)
            }
        }

        // Pull server-owned reference data only after outbound task changes have
        // settled, avoiding replacement of optimistic phone state while offline.
        val remoteConfig = when (val config = api.getConfig()) {
            is ApiResult.Success -> {
                cache.saveConfig(config.value)
                MobileConfig.markVerified(context)
                config.value
            }
            is ApiResult.TransientError -> {
                shouldRetry = true
                retryMessage = config.message
                null
            }
            is ApiResult.PermanentError -> {
                report.errors.add(config.message)
                null
            }
            is ApiResult.Conflict -> {
                report.errors.add(config.message)
                null
            }
        }

        if (remoteConfig != null) {
            val requestedDate = inputData.getString(MobileSyncScheduler.KEY_DATE)
            val pullDates = if (explicit) MobileSyncPolicy.pullDates(remoteConfig, journals.all()) else listOfNotNull(requestedDate)
            pullDates.distinct().sorted().forEach { date ->
                val local = journals.get(date)
                if (!MobileSyncPolicy.shouldPullRemote(local)) return@forEach
                when (val remote = api.getJournal(date)) {
                    is ApiResult.Success -> remote.value?.let { entry ->
                        if (local == null || local.baseUpdated != entry.baseUpdated || local.baseEditRevision != entry.baseEditRevision) {
                            if (journals.applyRemote(date, local, entry)) report.journalDownloaded++
                        }
                    }
                    is ApiResult.TransientError -> {
                        shouldRetry = true
                        retryMessage = remote.message
                    }
                    is ApiResult.PermanentError -> report.errors.add("$date: ${remote.message}")
                    is ApiResult.Conflict -> report.errors.add("$date: ${remote.message}")
                }
            }
            if (explicit) {
                val remoteDates = remoteConfig.storedEntryDates.toSet()
                journals.all().filter {
                    it.syncState == SyncState.SYNCED && it.date !in remoteDates
                }.forEach {
                    if (journals.removeSynced(it.date, it.requestId)) report.journalRemoved++
                }
            }
        }

        val expectedTasks = cache.tasks()
        if (tasks.pending().isEmpty() && tasks.failed().isEmpty()) when (val remoteTasks = api.getTasks()) {
            is ApiResult.Success -> {
                if (cache.applyRemoteTasks(expectedTasks, remoteTasks.value)) {
                    val previous = expectedTasks.associateBy(MobileTask::id)
                    val current = remoteTasks.value.associateBy(MobileTask::id)
                    report.tasksDownloaded = current.values.count { previous[it.id] != it }
                    report.tasksRemoved = previous.keys.count { it !in current }
                }
            }
            is ApiResult.TransientError -> {
                shouldRetry = true
                retryMessage = remoteTasks.message
            }
            is ApiResult.PermanentError -> report.errors.add(remoteTasks.message)
            is ApiResult.Conflict -> report.errors.add(remoteTasks.message)
        }

        if (explicit && !shouldRetry) try {
            report.mapPacks = MediaSync(context).maps { message ->
                setProgressAsync(workDataOf(MobileSyncScheduler.KEY_MESSAGE to message))
            }
        } catch (e: Exception) { shouldRetry = true; retryMessage = e.message }

        report.mediaConflicts = MediaStore(context).conflicts().optJSONArray("conflicts")?.length() ?: 0
        val journalStates = journals.all()
        report.journalConflicts = journalStates.count { it.syncState == SyncState.CONFLICT }
        report.journalRejected = journalStates.count { it.syncState == SyncState.PERMANENT_FAILURE }
        report.journalDeferred = if (explicit) journalStates.count {
            it.syncState == SyncState.DRAFT && MobileSyncPolicy.hasMeaningfulContent(it)
        } else 0
        report.phoneChangesRejected = tasks.failed().size
        if (journals.pending().isNotEmpty() || tasks.sendable().isNotEmpty() || MediaStore(context).sendableChanges().isNotEmpty()) {
            shouldRetry = true
            retryMessage = retryMessage ?: "New phone edits are queued for the next sync pass"
        }
        if (shouldRetry) {
            val message = retryMessage ?: "Mac unavailable · retry queued"
            setProgress(workDataOf(MobileSyncScheduler.KEY_MESSAGE to
                "${report.summary()}\nRetry queued: $message"))
            Result.retry()
        } else {
            val output = workDataOf(MobileSyncScheduler.KEY_MESSAGE to report.summary())
            if (report.hasUnresolved()) Result.failure(output) else Result.success(output)
        }
    }
}

object MobileSyncScheduler {
    private const val UNIQUE_WORK = "todopup-mobile-outbox"

    fun enqueue(context: Context, journalDate: String? = null): java.util.UUID =
        schedule(context, journalDate, ExistingWorkPolicy.APPEND_OR_REPLACE)

    fun enqueueChanged(context: Context, journalDate: String? = null): java.util.UUID =
        schedule(context, journalDate, ExistingWorkPolicy.KEEP)

    fun syncNow(context: Context, journalDate: String? = null): java.util.UUID =
        schedule(context, journalDate, ExistingWorkPolicy.REPLACE, explicit = false)

    fun syncAllNow(context: Context): java.util.UUID =
        schedule(context, null, ExistingWorkPolicy.REPLACE, explicit = true)

    private fun schedule(context: Context, journalDate: String?, policy: ExistingWorkPolicy,
                         explicit: Boolean = false): java.util.UUID {
        val request = request(journalDate, explicit)
        WorkManager.getInstance(context).enqueueUniqueWork(UNIQUE_WORK, policy, request)
        return request.id
    }

    internal fun request(journalDate: String?, explicit: Boolean = false): androidx.work.OneTimeWorkRequest {
        val builder = OneTimeWorkRequestBuilder<MobileSyncWorker>()
            // ADB reverse works without Wi-Fi or cellular. Socket failures keep
            // the durable outbox queued and use the normal retry backoff.
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
        if (journalDate != null) builder.setInputData(workDataOf(KEY_DATE to journalDate))
        if (explicit) builder.setInputData(workDataOf(KEY_EXPLICIT to true))
        return builder.build()
    }

    internal const val KEY_DATE = "journal_date"
    internal const val KEY_EXPLICIT = "explicit_sync"
    internal const val KEY_MESSAGE = "sync_message"
}
