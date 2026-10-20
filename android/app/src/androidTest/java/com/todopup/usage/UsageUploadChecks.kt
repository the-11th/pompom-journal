package com.todopup.usage

import androidx.work.NetworkType
import java.io.ByteArrayOutputStream
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL

/** Isolated request checks: no usage access, endpoint, token, or real network calls. */
internal object UsageUploadChecks {
    fun run() {
        check(UsagePushWorker.request().workSpec.constraints.requiredNetworkType == NetworkType.NOT_REQUIRED) {
            "USB usage upload must run without internet connectivity"
        }
        val output = ByteArrayOutputStream()
        val connection = object : HttpURLConnection(URL("http://127.0.0.1:1/qa")) {
            override fun connect() = Unit
            override fun disconnect() = Unit
            override fun usingProxy() = false
            override fun getOutputStream() = output
            override fun getResponseCode(): Int {
                check(!instanceFollowRedirects) { "Usage credentials must stay on the paired USB endpoint" }
                check(requestMethod == "POST")
                check(getRequestProperty("Authorization") == "Bearer synthetic-qa-token")
                return 307
            }
        }
        check(UsagePushWorker.post("http://127.0.0.1:1/qa", "synthetic-qa-token", "[]") { connection } == 307)
        check(output.toString("UTF-8") == "[]")
        val sent = """[{"date":"2026-09-08"},{"date":"2026-09-09"}]"""
        val invalid = listOf(
            "", "<html>Mac unavailable</html>", "{}", """{"ok":false,"dates":["2026-09-08","2026-09-09"]}""",
            """{"ok":true,"dates":["2026-09-08"]}""", """{"ok":true,"dates":"2026-09-08"}""",
            """{"ok":true,"dates":["2026-09-08",9]}""",
        )
        for (body in invalid) {
            val reply = response(200, body)
            check(runCatching { UsagePushWorker.post("http://127.0.0.1:1/qa", "synthetic-qa-token", sent) { reply } }.isFailure) {
                "Malformed or partial usage ACK must remain retryable: $body"
            }
        }
        val valid = response(200, """{"ok":true,"dates":["2026-09-09","2026-09-08"]}""")
        check(UsagePushWorker.post("http://127.0.0.1:1/qa", "synthetic-qa-token", sent) { valid } == 200)
        var reads = 0
        val synthetic = listOf(DayUsage("2026-09-09", 20, 1, emptyList(), null, null))
        check(runCatching {
            UsagePushWorker.collect({ reads++; synthetic }, { "Grant usage access" })
        }.isFailure)
        check(reads == 0) { "Denied usage access must not read or upload empty replacements" }
        var allowed = true
        check(runCatching {
            UsagePushWorker.collect({ reads++; allowed = false; synthetic }, { if (allowed) null else "Access revoked" })
        }.isFailure) { "Access revoked during collection must not upload the result" }
        check(reads == 1)
        check(UsagePushWorker.collect({ synthetic }, { null }) == synthetic)
    }

    private fun response(code: Int, body: String) = object : HttpURLConnection(URL("http://127.0.0.1:1/qa")) {
        override fun connect() = Unit
        override fun disconnect() = Unit
        override fun usingProxy() = false
        override fun getOutputStream() = ByteArrayOutputStream()
        override fun getInputStream() = ByteArrayInputStream(body.toByteArray())
        override fun getResponseCode() = code
    }
}
