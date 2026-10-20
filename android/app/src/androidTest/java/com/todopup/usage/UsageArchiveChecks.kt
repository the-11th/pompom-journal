package com.todopup.usage

import android.content.Context
import androidx.work.NetworkType
import java.io.File
import java.io.IOException
import java.time.LocalDate
import java.util.concurrent.TimeUnit

internal object UsageArchiveChecks {
    fun run(context: Context) {
        val root = File(context.filesDir, "usage-test")
        val archive = UsageArchive(root)
        val days = (0 until 65).map {
            DayUsage(LocalDate.parse("2026-07-01").plusDays(it.toLong()).toString(),
                30 + it, 2, listOf(AppUsage("sample", "Sample", 30 + it, 3)), "09:00", "21:00")
        }
        archive.save(days)
        check(UsageArchive(root).pending("mac").size == 65) { "Offline history must survive reopening" }
        var calls = 0
        check(runCatching {
            UsageDelivery.send(archive, "mac") { batch ->
                calls++
                check(batch.size <= 30)
                if (calls == 2) throw IOException("USB unplugged")
            }
        }.isFailure)
        check(archive.pending("mac").size == 35) { "Only acknowledged batches may leave the queue" }
        val uploaded = mutableListOf<String>()
        UsageDelivery.send(archive, "mac") { uploaded.addAll(it.map(DayUsage::date)) }
        check(uploaded == days.drop(30).map(DayUsage::date))
        check(archive.pending("mac").isEmpty())
        check(archive.pending("other-mac").size == 65) { "New destinations need the retained archive" }
        archive.save(days)
        check(archive.pending("mac").isEmpty()) { "Identical collection must not queue old days again" }
        val sent = days.last()
        val revised = sent.copy(screenMin = 125)
        archive.save(listOf(revised))
        archive.acknowledge(listOf(sent), "mac")
        check(archive.pending("mac") == listOf(revised)) { "An old ACK must not discard a newer snapshot" }
        archive.save(listOf(revised.copy(screenMin = 0, detailsAvailable = false)))
        check(archive.pending("mac") == listOf(revised)) { "Expired detail must not replace saved usage" }
        File(root, "${days.first().date}.json").writeText("{broken")
        check(runCatching { archive.save(listOf(days.first())) }.isFailure)
        check(File(root, "${days.first().date}.json").readText() == "{broken") { "Corruption must remain recoverable" }
        val work = UsageCollectionWorker.periodicRequest().workSpec
        check(work.constraints.requiredNetworkType == NetworkType.NOT_REQUIRED)
        check(!work.constraints.requiresCharging())
        check(work.intervalDuration <= TimeUnit.HOURS.toMillis(12)) { "Collection must run while unplugged" }
    }
}
