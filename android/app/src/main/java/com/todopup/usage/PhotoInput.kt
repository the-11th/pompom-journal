package com.todopup.usage

import java.io.InputStream

/** Bounded original-byte reads work on Android 8 and stop at the upload limit. */
object PhotoInput {
    fun readOriginal(original: () -> InputStream, fallback: () -> InputStream, limit: Int): ByteArray {
        val stream = try { original() }
        catch (_: SecurityException) { fallback() }
        catch (_: UnsupportedOperationException) { fallback() }
        catch (_: java.io.FileNotFoundException) { fallback() }
        return stream.use { read(it, limit) }
    }
    fun read(input: InputStream, limit: Int): ByteArray {
        require(limit in 0 until Int.MAX_VALUE)
        val chunks = mutableListOf<ByteArray>(); var total = 0
        while (true) {
            val buffer = ByteArray(minOf(8192, limit - total + 1))
            var count = input.read(buffer)
            if (count < 0) break
            if (count == 0) {
                val single = input.read(); if (single < 0) break
                buffer[0] = single.toByte(); count = 1
            }
            total += count
            require(total <= limit) { "Photo is larger than 80 MB" }
            chunks.add(if (count == buffer.size) buffer else buffer.copyOf(count))
        }
        val result = ByteArray(total); var offset = 0
        for (chunk in chunks) { chunk.copyInto(result, offset); offset += chunk.size }
        return result
    }
}
