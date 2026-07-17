package com.todopup.usage

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
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
        var shouldRetry = false

        for (draft in journals.pending()) when (val result = api.putJournal(draft)) {
            is ApiResult.Success -> journals.markSynced(draft.date, result.value)
            is ApiResult.Conflict -> journals.markConflict(draft.date, draft.requestId,
                result.current, result.message)
            is ApiResult.PermanentError -> journals.markPermanentFailure(draft.date,
                draft.requestId, result.message)
            is ApiResult.TransientError -> shouldRetry = true
        }

        taskLoop@ for (mutation in tasks.pending()) {
            val result = when (mutation.operation) {
                "create" -> api.createTask(mutation.requestId, mutation.payload.optString("id").takeIf(String::isNotBlank),
                    mutation.payload.optString("title"),
                    mutation.payload.optString("due").takeIf(String::isNotBlank),
                    (0 until (mutation.payload.optJSONArray("tags")?.length() ?: 0)).map {
                        mutation.payload.optJSONArray("tags")!!.optString(it)
                    }, mutation.payload.optString("notes"))
                "update" -> api.updateTask(requireNotNull(mutation.taskId), mutation.requestId, mutation.payload)
                "delete" -> api.deleteTask(requireNotNull(mutation.taskId), mutation.requestId)
                "journal_tag" -> api.addJournalTag(mutation.requestId,
                    mutation.payload.getString("section_id"), mutation.payload.getString("name"))
                "task_tag" -> api.addTaskTag(mutation.requestId,
                    mutation.payload.getString("name"), mutation.payload.optString("color", "#e0a955"))
                else -> ApiResult.PermanentError(0, "Unknown task operation")
            }
            when (result) {
                is ApiResult.Success -> tasks.acknowledge(mutation.requestId)
                is ApiResult.TransientError -> {
                    // Preserve outbox order: a later edit may target a create
                    // that the unreachable server has not accepted yet.
                    shouldRetry = true
                    break@taskLoop
                }
                is ApiResult.PermanentError -> tasks.markFailed(mutation.requestId, result.message)
                is ApiResult.Conflict -> tasks.markFailed(mutation.requestId, result.message)
            }
        }

        // Pull server-owned reference data only after outbound task changes have
        // settled, avoiding replacement of optimistic phone state while offline.
        when (val config = api.getConfig()) {
            is ApiResult.Success -> cache.saveConfig(config.value)
            is ApiResult.TransientError -> shouldRetry = true
            else -> Unit
        }
        if (tasks.pending().isEmpty() && tasks.failed().isEmpty()) when (val remoteTasks = api.getTasks()) {
            is ApiResult.Success -> cache.saveTasks(remoteTasks.value)
            is ApiResult.TransientError -> shouldRetry = true
            else -> Unit
        }

        inputData.getString(MobileSyncScheduler.KEY_DATE)?.let { date ->
            val local = journals.get(date)
            if (local == null || local.syncState == SyncState.SYNCED) {
                when (val remote = api.getJournal(date)) {
                    is ApiResult.Success -> remote.value?.let(journals::save)
                    is ApiResult.TransientError -> shouldRetry = true
                    else -> Unit
                }
            }
        }
        if (shouldRetry) Result.retry() else Result.success()
    }
}

object MobileSyncScheduler {
    private const val UNIQUE_WORK = "todopup-mobile-outbox"

    fun enqueue(context: Context, journalDate: String? = null) {
        val builder = OneTimeWorkRequestBuilder<MobileSyncWorker>()
            .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 15, TimeUnit.SECONDS)
        if (journalDate != null) builder.setInputData(workDataOf(KEY_DATE to journalDate))
        val request = builder.build()
        WorkManager.getInstance(context).enqueueUniqueWork(UNIQUE_WORK,
            ExistingWorkPolicy.APPEND_OR_REPLACE, request)
    }

    internal const val KEY_DATE = "journal_date"
}
