package com.todopup.usage

import android.app.AppOpsManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.UserManager
import androidx.work.CoroutineWorker
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.util.concurrent.TimeUnit

/** Collection is local-only and independent of USB pairing or internet access. */
class UsageCollectionWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        try {
            capture(applicationContext)
            Result.success()
        } catch (error: Exception) {
            Config.setCollectionStatus(applicationContext, "Usage collection pending: ${error.message}")
            Result.retry()
        }
    }

    companion object {
        fun archive(context: Context) = UsageArchive(File(context.filesDir, "usage_archive"))

        fun capture(context: Context): Int {
            val days = UsagePushWorker.collect({ UsageReader(context).readAvailableDays() }, { accessProblem(context) })
            archive(context).save(days)
            Config.setCollectionStatus(context, "Daily usage saved on this phone · ${days.size} available days checked")
            return days.size
        }

        fun periodicRequest() = PeriodicWorkRequestBuilder<UsageCollectionWorker>(6, TimeUnit.HOURS).build()

        fun schedule(context: Context) {
            val manager = WorkManager.getInstance(context)
            manager.enqueueUniquePeriodicWork("todopup-usage-collection", ExistingPeriodicWorkPolicy.KEEP, periodicRequest())
            manager.enqueueUniqueWork("todopup-usage-collect-now", ExistingWorkPolicy.KEEP,
                OneTimeWorkRequestBuilder<UsageCollectionWorker>().build())
        }

        fun accessProblem(context: Context): String? {
            if (!(context.getSystemService(Context.USER_SERVICE) as UserManager).isUserUnlocked)
                return "Unlock the phone to save usage"
            val ops = context.getSystemService(Context.APP_OPS_SERVICE) as AppOpsManager
            @Suppress("DEPRECATION")
            val mode = ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS,
                context.applicationInfo.uid, context.packageName)
            return if (mode == AppOpsManager.MODE_ALLOWED) null else "Grant usage access in Android settings"
        }
    }
}

class UsageBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        UsageCollectionWorker.schedule(context)
    }
}
