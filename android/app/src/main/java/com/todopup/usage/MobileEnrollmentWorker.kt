package com.todopup.usage

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL

/** Exchanges a one-use QR pairing code for the revocable per-device bearer token. */
class MobileEnrollmentWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val baseUrl = inputData.getString(KEY_BASE_URL)?.trim()?.trimEnd('/') ?: return@withContext Result.failure()
        val enrollment = inputData.getString(KEY_ENROLLMENT) ?: return@withContext Result.failure()
        val deviceName = inputData.getString(KEY_DEVICE_NAME) ?: "Android phone"
        if (runCatching { URI(baseUrl).scheme }.getOrNull() != "https") return@withContext Result.failure()
        try {
            val conn = URL("$baseUrl/api/mobile/enroll").openConnection() as HttpURLConnection
            conn.requestMethod = "POST"; conn.doOutput = true
            conn.connectTimeout = 15_000; conn.readTimeout = 20_000
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8")
            val payload = JSONObject().put("enrollment_token", enrollment).put("device_name", deviceName)
            conn.outputStream.bufferedWriter(Charsets.UTF_8).use { it.write(payload.toString()) }
            val status = conn.responseCode
            val stream = if (status in 200..299) conn.inputStream else conn.errorStream
            val body = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            conn.disconnect()
            if (status in 200..299) {
                val token = JSONObject(body).optString("token")
                if (token.isBlank()) return@withContext Result.failure()
                MobileConfig.save(applicationContext, baseUrl, token, deviceName)
                MobileSyncScheduler.enqueue(applicationContext)
                Result.success()
            } else if (status == 408 || status == 425 || status == 429 || status >= 500) Result.retry()
            else Result.failure()
        } catch (_: java.io.IOException) { Result.retry() }
        catch (_: Exception) { Result.failure() }
    }

    companion object {
        const val KEY_BASE_URL = "base_url"
        const val KEY_ENROLLMENT = "enrollment_token"
        const val KEY_DEVICE_NAME = "device_name"

        fun enqueue(context: Context, baseUrl: String, enrollmentToken: String, deviceName: String = "Android phone") {
            val data = Data.Builder().putString(KEY_BASE_URL, baseUrl)
                .putString(KEY_ENROLLMENT, enrollmentToken).putString(KEY_DEVICE_NAME, deviceName).build()
            WorkManager.getInstance(context).enqueue(OneTimeWorkRequestBuilder<MobileEnrollmentWorker>()
                .setInputData(data).build())
        }
    }
}
