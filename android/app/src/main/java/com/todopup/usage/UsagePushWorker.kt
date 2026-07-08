package com.todopup.usage

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter

/**
 * Reads the last 3 full days via [UsageReader] and POSTs them as a JSON array to
 * the configured endpoint with `Authorization: Bearer <token>`. Uses
 * HttpURLConnection (no OkHttp dependency). 2xx → success; anything else → retry
 * (WorkManager backs off and re-runs). Writes a status line for the setup screen.
 */
class UsagePushWorker(appContext: Context, params: WorkerParameters) :
    CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val ctx = applicationContext
        val endpoint = Config.getEndpoint(ctx)
        val token = Config.getToken(ctx)
        if (endpoint.isBlank() || token.isBlank()) {
            Config.setStatus(ctx, "Not configured — set endpoint + token.")
            return@withContext Result.failure()
        }

        try {
            val days = UsageReader(ctx).readLastDays(3)
            val body = serialize(days).toString()
            val code = post(endpoint, token, body)
            if (code in 200..299) {
                Config.setStatus(ctx, "Last push OK ($code) — ${days.size} days.",
                    LocalDateTime.now().format(DateTimeFormatter.ISO_LOCAL_DATE_TIME))
                Result.success()
            } else {
                Config.setStatus(ctx, "Push failed: HTTP $code (will retry).")
                Result.retry()
            }
        } catch (ex: Exception) {
            Config.setStatus(ctx, "Push error: ${ex.message} (will retry).")
            Result.retry()
        }
    }

    /** Build the JSON array matching Plan 1's `parse_push` contract exactly. */
    private fun serialize(days: List<DayUsage>): JSONArray {
        val arr = JSONArray()
        for (d in days) {
            val apps = JSONArray()
            for (a in d.topApps) {
                apps.put(JSONObject()
                    .put("name", a.name)
                    .put("label", a.label)
                    .put("min", a.min)
                    .put("opens", a.opens))
            }
            val o = JSONObject()
                .put("date", d.date)
                .put("screen_min", d.screenMin)
                .put("unlocks", d.unlocks)
                .put("top_apps", apps)
                .put("source", "phone")
            // first_use / last_use are optional; only emit when present.
            if (d.firstUse != null) o.put("first_use", d.firstUse)
            if (d.lastUse != null) o.put("last_use", d.lastUse)
            arr.put(o)
        }
        return arr
    }

    private fun post(endpoint: String, token: String, body: String): Int {
        val conn = URL(endpoint).openConnection() as HttpURLConnection
        return try {
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.connectTimeout = 15000
            conn.readTimeout = 15000
            conn.setRequestProperty("Content-Type", "application/json")
            conn.setRequestProperty("Authorization", "Bearer $token")
            OutputStreamWriter(conn.outputStream, Charsets.UTF_8).use { it.write(body) }
            conn.responseCode
        } finally {
            conn.disconnect()
        }
    }
}
