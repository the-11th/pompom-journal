package com.todopup.usage

import android.webkit.WebResourceResponse
import java.io.File
import java.io.InputStream
import java.io.RandomAccessFile

/** File and byte-range responses shared by the local WebView and its runtime tests. */
internal object MediaFileResponse {
    val mapGuard = Any()
    fun map(file: File, version: String?, range: String? = null,
            offset: Long? = null, length: Int? = null): WebResourceResponse = synchronized(mapGuard) {
        val receipt = File(file.parentFile, file.nameWithoutExtension + ".receipt.json")
        if (!version.isNullOrEmpty() && MediaStore.read(receipt).optString("sha256") != version) {
            val body = "{\"ok\":false,\"error\":{\"code\":\"map_version_changed\",\"message\":\"Map archive changed; refresh its manifest\"}}"
            return@synchronized WebResourceResponse("application/json", "UTF-8", 409, "Conflict",
                mapOf("Cache-Control" to "no-store", "X-Datapom-Error" to "map_version_changed"), body.byteInputStream())
        }
        // Open under the publication lock; a returned descriptor keeps reading
        // its original inode even if a later download replaces the pathname.
        if (offset != null || length != null) bytes(file, "application/octet-stream", requireNotNull(offset), requireNotNull(length))
        else create(file, "application/octet-stream", range)
    }
    fun bytes(file: File, mime: String, offset: Long, length: Int): WebResourceResponse {
        require(length in 1..16 * 1024 * 1024 && offset >= 0 && offset <= file.length() - length) {
            "Invalid map byte request"
        }
        return slice(file, mime, offset, offset + length - 1, false)
    }
    fun create(file: File, mime: String, range: String?): WebResourceResponse {
        val headers = mutableMapOf("Cache-Control" to "no-store", "Accept-Ranges" to "bytes")
        if (range == null) {
            headers["Content-Length"] = file.length().toString()
            return WebResourceResponse(mime, "UTF-8", 200, "OK", headers, file.inputStream())
        }
        val match = Regex("bytes=(\\d+)-(\\d*)").matchEntire(range) ?: throw IllegalArgumentException()
        val start = match.groupValues[1].toLong()
        val end = (match.groupValues[2].toLongOrNull() ?: (file.length() - 1)).coerceAtMost(file.length() - 1)
        require(start <= end && start >= 0)
        return slice(file, mime, start, end, true)
    }
    private fun slice(file: File, mime: String, start: Long, end: Long, httpRange: Boolean): WebResourceResponse {
        val headers = mutableMapOf("Cache-Control" to "no-store", "Accept-Ranges" to "bytes")
        val input = RandomAccessFile(file, "r"); input.seek(start); var left = end - start + 1
        val stream = object : InputStream() {
            override fun available(): Int = left.coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
            override fun skip(count: Long): Long {
                val amount = count.coerceIn(0, left); input.seek(input.filePointer + amount); left -= amount
                return amount
            }
            override fun read(): Int { if (left <= 0) return -1; val value = input.read(); if (value >= 0) left-- else left = 0; return value }
            override fun read(b: ByteArray, off: Int, len: Int): Int {
                if (len == 0) return 0
                if (left <= 0) return -1
                val n = input.read(b, off, minOf(len.toLong(), left).toInt())
                if (n > 0) left -= n
                return n
            }
            override fun close() = input.close()
        }
        if (httpRange) headers["Content-Range"] = "bytes $start-$end/${file.length()}"
        headers["Content-Length"] = (end - start + 1).toString()
        return WebResourceResponse(mime, "UTF-8", if (httpRange) 206 else 200, if (httpRange) "Partial Content" else "OK", headers, stream)
    }
}
