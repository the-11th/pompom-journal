package com.todopup.usage

import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.util.zip.GZIPInputStream

class DailyTrackingFilesTest {
    @get:Rule val folder = TemporaryFolder()
    private val today = "2026-09-09"
    private val body = "{\"fix\":{\"lat\":31.23456789,\"lon\":121.56789123,\"speed_mps\":83.3}}".toByteArray()

    @Test fun `past days archive losslessly while today stays writable without recompression`() {
        val dir = folder.newFolder(); val files = DailyTrackingFiles(dir)
        File(dir, "2026-09-08.json").writeBytes(body)
        files.write(today, body, today)
        assertEquals(listOf("2026-09-08"), files.archiveBefore(today))
        assertFalse(File(dir, "2026-09-08.json").exists())
        assertTrue(File(dir, "$today.json").isFile)
        assertFalse(File(dir, "$today.json.gz").exists())
        val archive = File(dir, "2026-09-08.json.gz")
        assertArrayEquals(body, GZIPInputStream(archive.inputStream()).use { it.readBytes() })
        assertArrayEquals(body, files.read("2026-09-08"))
        assertEquals(listOf("2026-09-08", today), files.days())
        val modified = archive.lastModified()
        assertTrue(files.archiveBefore(today).isEmpty())
        assertEquals(modified, archive.lastModified())
    }

    @Test fun `late synced observations update the compressed day without losing old bytes`() {
        val files = DailyTrackingFiles(folder.newFolder())
        files.write("2026-09-08", body, today)
        val updated = (String(body).dropLast(1) + ",\"late\":{\"lat\":12.0}}").toByteArray()
        files.write("2026-09-08", updated, today)
        assertArrayEquals(updated, files.read("2026-09-08"))
        assertEquals(listOf("2026-09-08"), files.days())
    }

    @Test fun `interrupted archival keeps newer uncompressed data authoritative`() {
        val dir = folder.newFolder(); val files = DailyTrackingFiles(dir)
        files.write("2026-09-08", body, today)
        val latest = "{\"new\":{\"lat\":1}}".toByteArray()
        File(dir, "2026-09-08.json").writeBytes(latest)
        assertArrayEquals(latest, files.read("2026-09-08"))
        assertEquals(listOf("2026-09-08"), files.days())
        files.archiveBefore(today)
        assertArrayEquals(latest, files.read("2026-09-08"))
    }

    @Test fun `date lookup rejects traversal and leaves unrelated files alone`() {
        val dir = folder.newFolder(); val files = DailyTrackingFiles(dir)
        File(dir, "maps.pmtiles").writeBytes(body)
        File(dir, "2026-09-08.json.bak").writeBytes(body)
        assertTrue(files.days().isEmpty())
        assertThrows(IllegalArgumentException::class.java) { files.read("../state") }
        assertThrows(IllegalArgumentException::class.java) { files.write("2026-99-99", body, today) }
        assertTrue(files.read(today).isEmpty())
        assertTrue(File(dir, "maps.pmtiles").isFile)
    }

    @Test fun `live recording appends one durable line without reading or rewriting the day`() {
        val dir = folder.newFolder()
        val files = DailyTrackingFiles(dir, atomicWrite = { _, _ -> error("A live fix rewrote the day") },
            readFile = { error("A live fix loaded the day") })
        val first = "{\"id\":\"first\"}".toByteArray(); val second = "{\"id\":\"second\"}".toByteArray()
        files.append(today, first)
        val before = File(dir, "$today.jsonl").readBytes()
        files.append(today, second)
        assertArrayEquals(before + second + byteArrayOf(10), File(dir, "$today.jsonl").readBytes())
        assertEquals(listOf(today), files.days())
        assertFalse(File(dir, "$today.json").exists())
        assertEquals(listOf(String(first), String(second)), files.logRows(today).map { String(it) })
    }

    @Test fun `a partial last line never hides complete observations and is preserved before repair`() {
        val dir = folder.newFolder(); val files = DailyTrackingFiles(dir)
        val first = "{\"id\":\"first\"}".toByteArray()
        files.append(today, first)
        val partial = "{\"id\":\"interrupted".toByteArray()
        File(dir, "$today.jsonl").appendBytes(partial)
        assertEquals(listOf(String(first)), files.logRows(today).map { String(it) })
        val next = "{\"id\":\"next\"}".toByteArray()
        files.append(today, next)
        assertEquals(listOf(String(first), String(next)), files.logRows(today).map { String(it) })
        val recovered = dir.listFiles()!!.single { it.name.contains(".recovery-") }
        assertArrayEquals(partial, recovered.readBytes())
    }

    @Test fun `rollover discovers log-only days and compaction keeps all records before deleting the log`() {
        val dir = folder.newFolder(); val files = DailyTrackingFiles(dir)
        files.append("2026-09-08", "{\"id\":\"one\"}".toByteArray())
        files.append(today, "{\"id\":\"today\"}".toByteArray())
        assertEquals(listOf("2026-09-08"), files.pendingArchiveDays(today))
        val snapshot = "{\"one\":{\"id\":\"one\"}}".toByteArray()
        files.compact("2026-09-08", snapshot, today)
        assertArrayEquals(snapshot, files.read("2026-09-08"))
        assertTrue(files.logRows("2026-09-08").isEmpty())
        assertTrue(File(dir, "2026-09-08.json.gz").isFile)
        assertFalse(File(dir, "2026-09-08.jsonl").exists())
        assertTrue(File(dir, "$today.jsonl").isFile)
        assertTrue(files.pendingArchiveDays(today).isEmpty())
    }

    @Test fun `an interrupted snapshot cannot delete the append log`() {
        val dir = folder.newFolder(); val files = DailyTrackingFiles(dir)
        files.write("2026-09-08", body, today)
        val appended = "{\"id\":\"late\"}".toByteArray()
        files.append("2026-09-08", appended)
        val failing = DailyTrackingFiles(dir, atomicWrite = { _, _ -> throw java.io.IOException("disk full") })
        assertThrows(java.io.IOException::class.java) { failing.compact("2026-09-08", byteArrayOf(1), today) }
        assertArrayEquals(body, files.read("2026-09-08"))
        assertEquals(listOf(String(appended)), files.logRows("2026-09-08").map { String(it) })
        assertTrue(File(dir, "2026-09-08.jsonl").isFile)
    }

    @Test fun `compaction retains incomplete trailing bytes for recovery`() {
        val dir = folder.newFolder(); val files = DailyTrackingFiles(dir)
        files.append("2026-09-08", "{\"id\":\"one\"}".toByteArray())
        val partial = "{\"unfinished\":".toByteArray()
        File(dir, "2026-09-08.jsonl").appendBytes(partial)
        files.compact("2026-09-08", body, today)
        assertArrayEquals(partial, dir.listFiles()!!.single { it.name.contains(".recovery-") }.readBytes())
        assertFalse(File(dir, "2026-09-08.jsonl").exists())
    }
}
