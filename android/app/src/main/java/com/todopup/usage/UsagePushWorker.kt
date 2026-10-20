package com.todopup.usage

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import androidx.work.OneTimeWorkRequestBuilder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import androidx.work.ExistingWorkPolicy
import androidx.work.WorkManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter

/** Uploads the durable daily archive in acknowledged batches over the USB loopback endpoint. */
class UsagePushWorker(appContext: Context, params: WorkerParameters) :
    CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) { uploadGuard.withLock {
        val ctx = applicationContext
        // Capture before checking pairing/network, so an unplugged phone still saves its days.
        val collectionError = runCatching { UsageCollectionWorker.capture(ctx) }.exceptionOrNull()
        val endpoint = Config.getEndpoint(ctx)
        val token = Config.getToken(ctx)
        if (endpoint.isBlank() || token.isBlank()) {
            Config.setStatus(ctx, "Usage saved on this phone · connect USB to pair uploads")
            return@withLock Result.failure()
        }
        try {
            MobileEndpoint.requireAllowed(endpoint)
            val archive = UsageCollectionWorker.archive(ctx)
            val destination = UsageArchive.digest(endpoint + "\n" + token)
            val count = UsageDelivery.send(archive, destination) { batch ->
                val body = JSONArray(batch.map(UsageJson::encode)).toString()
                val code = post(endpoint, token, body)
                if (code !in 200..299) throw IOException("HTTP $code")
            }
            val feedback = if (count == 0) "All saved usage days are synced" else "Last push OK — $count saved days"
            Config.setStatus(ctx, feedback + (collectionError?.let { "\nCollection pending: ${it.message}" } ?: ""),
                if (count > 0) LocalDateTime.now().format(DateTimeFormatter.ISO_LOCAL_DATE_TIME) else null)
            if (collectionError == null) Result.success() else Result.retry()
        } catch (ex: Exception) {
            Config.setStatus(ctx, "Usage saved on this phone · upload pending: ${ex.message}")
            Result.retry()
        }
    } }

    companion object {
        private val uploadGuard = Mutex()
        fun enqueue(context: Context) {
            WorkManager.getInstance(context).enqueueUniqueWork("todopup-usage-upload", ExistingWorkPolicy.REPLACE, request())
        }
        // The paired endpoint is USB loopback; an internet network may be absent.
        internal fun request() = OneTimeWorkRequestBuilder<UsagePushWorker>().build()

        internal fun collect(read: () -> List<DayUsage>, accessProblem: () -> String?): List<DayUsage> {
            accessProblem()?.let { throw SecurityException(it) }
            val days = read()
            // Permission can be revoked while the platform queries run. Empty
            // permission-denied results must never replace previously saved days.
            accessProblem()?.let { throw SecurityException(it) }
            return days
        }

        internal fun post(endpoint: String, token: String, body: String,
            open: (String) -> HttpURLConnection = { URL(it).openConnection() as HttpURLConnection }): Int {
            val conn = open(endpoint)
            return try {
                conn.instanceFollowRedirects = false
                conn.requestMethod = "POST"
                conn.doOutput = true
                conn.connectTimeout = 15000
                conn.readTimeout = 15000
                conn.setRequestProperty("Content-Type", "application/json")
                conn.setRequestProperty("Authorization", "Bearer $token")
                OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { it.write(body) }
                val code = conn.responseCode
                if (code in 200..299) {
                    try {
                        val acknowledgement = JSONObject(conn.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() })
                        val expected = JSONArray(body).let { sent ->
                            (0 until sent.length()).map { sent.getJSONObject(it).getString("date") }.toSet()
                        }
                        val dates = acknowledgement.getJSONArray("dates")
                        val received = (0 until dates.length()).map { index ->
                            dates.get(index) as? String ?: throw IOException("Invalid usage date acknowledgement")
                        }.toSet()
                        if (acknowledgement.opt("ok") != true || expected.isEmpty() || received != expected) {
                            throw IOException("Usage acknowledgement did not confirm every day")
                        }
                    } catch (error: Exception) {
                        throw IOException("Usage acknowledgement incomplete; retry queued", error)
                    }
                }
                code
            } finally {
                conn.disconnect()
            }
        }
    }
}
