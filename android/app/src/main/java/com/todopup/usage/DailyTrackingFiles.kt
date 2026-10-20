package com.todopup.usage

import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.time.LocalDate
import java.security.MessageDigest
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream

/** Lossless daily archives. Map packs and photo originals remain shared assets. */
class DailyTrackingFiles(
    private val directory: File,
    private val atomicWrite: (File, ByteArray) -> Unit = ::writeAtomically,
    private val readFile: (File) -> ByteArray = File::readBytes,
) {
    fun days(): List<String> = directory.listFiles().orEmpty().mapNotNull { file ->
        DAY_FILE.matchEntire(file.name)?.groupValues?.get(1)?.takeIf { validDate(it) }
    }.distinct().sorted()

    fun read(day: String): ByteArray {
        require(validDate(day)) { "Invalid tracking date" }
        val plain = File(directory, "$day.json")
        // During an interrupted archive the durable plain file is authoritative.
        if (plain.isFile) return readFile(plain)
        val compressed = File(directory, "$day.json.gz")
        return if (compressed.isFile) GZIPInputStream(readFile(compressed).inputStream()).use { it.readBytes() } else byteArrayOf()
    }

    /** The normal path checks one trailing byte and fsyncs one new record. */
    fun append(day: String, record: ByteArray) {
        require(validDate(day)) { "Invalid tracking date" }
        require(record.isNotEmpty() && record.size <= MAX_RECORD_BYTES && record.none { it == 10.toByte() || it == 13.toByte() }) {
            "A tracking observation must be one bounded JSON line"
        }
        directory.mkdirs()
        val log = File(directory, "$day.jsonl")
        repairTail(log)
        FileOutputStream(log, true).use { output -> output.write(record); output.write(10); output.fd.sync() }
    }

    /** Complete lines survive a crash; an incomplete final line is never parsed. */
    fun logRows(day: String): List<ByteArray> {
        require(validDate(day)) { "Invalid tracking date" }
        val log = File(directory, "$day.jsonl")
        if (!log.isFile) return emptyList()
        val bytes = log.readBytes(); val result = mutableListOf<ByteArray>(); var start = 0
        for (index in bytes.indices) if (bytes[index] == 10.toByte()) {
            if (index > start) result.add(bytes.copyOfRange(start, index))
            start = index + 1
        }
        return result
    }

    /** Callers merge the baseline and log under their store lock before compacting. */
    fun compact(day: String, snapshot: ByteArray, today: String) {
        write(day, snapshot, today)
        val log = File(directory, "$day.jsonl")
        // Preserve a torn final write even when all complete records made the snapshot.
        repairTail(log)
        check(!log.exists() || log.delete()) { "Could not finish consolidating the tracking day" }
    }

    fun pendingArchiveDays(today: String): List<String> {
        require(validDate(today)) { "Invalid tracking date" }
        return directory.listFiles().orEmpty().filter { it.name.endsWith(".json") || it.name.endsWith(".jsonl") }
            .mapNotNull { DAY_FILE.matchEntire(it.name)?.groupValues?.get(1) }
            .filter { validDate(it) && it < today }.distinct().sorted()
    }

    private fun repairTail(log: File) {
        if (!log.isFile || log.length() == 0L) return
        RandomAccessFile(log, "rw").use { file ->
            val length = file.length(); file.seek(length - 1)
            if (file.read() == 10) return
            var position = length; var completeThrough = 0L
            val buffer = ByteArray(8192)
            while (position > 0 && completeThrough == 0L) {
                val count = minOf(position, buffer.size.toLong()).toInt()
                position -= count; file.seek(position); file.readFully(buffer, 0, count)
                for (index in count - 1 downTo 0) if (buffer[index] == 10.toByte()) {
                    completeThrough = position + index + 1; break
                }
            }
            val tailSize = length - completeThrough
            check(tailSize <= Int.MAX_VALUE) { "Interrupted tracking record needs recovery" }
            val tail = ByteArray(tailSize.toInt()); file.seek(completeThrough); file.readFully(tail)
            val hash = MessageDigest.getInstance("SHA-256").digest(tail).joinToString("") { "%02x".format(it) }
            val backup = File(log.path + ".recovery-$hash")
            if (!backup.isFile) atomicWrite(backup, tail)
            file.setLength(completeThrough); file.fd.sync()
        }
    }

    fun write(day: String, bytes: ByteArray, today: String) {
        require(validDate(day) && validDate(today)) { "Invalid tracking date" }
        val plain = File(directory, "$day.json")
        atomicWrite(plain, bytes)
        if (day < today) archive(plain, bytes)
    }

    fun archiveBefore(today: String): List<String> {
        require(validDate(today)) { "Invalid tracking date" }
        return directory.listFiles().orEmpty().filter {
            it.name.endsWith(".json") && validDate(it.nameWithoutExtension) && it.nameWithoutExtension < today
        }.sortedBy { it.name }.map { file -> archive(file, readFile(file)); file.nameWithoutExtension }
    }

    private fun archive(plain: File, bytes: ByteArray) {
        val compressed = ByteArrayOutputStream().apply { GZIPOutputStream(this).use { it.write(bytes) } }.toByteArray()
        atomicWrite(File(plain.path + ".gz"), compressed)
        check(!plain.exists() || plain.delete()) { "Could not finish archiving the tracking day" }
    }

    companion object {
        private val DAY_FILE = Regex("(\\d{4}-\\d{2}-\\d{2})\\.json(?:\\.gz|l)?")
        private const val MAX_RECORD_BYTES = 64 * 1024
        private fun validDate(day: String) = day.matches(Regex("\\d{4}-\\d{2}-\\d{2}")) && runCatching { LocalDate.parse(day) }.isSuccess
        private fun writeAtomically(file: File, bytes: ByteArray) {
            file.parentFile?.mkdirs()
            val temporary = File.createTempFile(file.name, ".tmp", file.parentFile)
            try {
                FileOutputStream(temporary).use { it.write(bytes); it.fd.sync() }
                Files.move(temporary.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            } finally { temporary.delete() }
        }
    }
}
