package com.todopup.usage

import android.app.usage.UsageEvents
import android.app.usage.UsageStatsManager
import android.content.Context
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** One app's foreground time + launch count on a given day. */
data class AppUsage(val name: String, val label: String, val min: Int, val opens: Int = 0)

/**
 * One local day's usage, shaped to match Plan 1's `parse_push` contract exactly:
 * {date, screen_min, unlocks, top_apps:[{name,label,min}], first_use, last_use,
 *  source:"phone"}.
 */
data class DayUsage(
    val date: String,               // YYYY-MM-DD (local)
    val screenMin: Int,
    val unlocks: Int,
    val topApps: List<AppUsage>,
    val firstUse: String?,          // HH:MM local, or null
    val lastUse: String?            // HH:MM local, or null
)

/**
 * Reads on-device usage stats via UsageStatsManager. The Android/system calls
 * live in [readDay]; the date math and aggregation are factored into the pure
 * [Dates] / [Aggregate] objects so they can be unit-tested on a plain JVM.
 */
class UsageReader(private val context: Context) {

    private val usm: UsageStatsManager =
        context.getSystemService(Context.USAGE_STATS_SERVICE) as UsageStatsManager

    /** The last [count] *full* days ending yesterday (per Decision 8: 3). */
    fun readLastDays(count: Int = 3, now: Instant = Instant.now(),
                     zone: ZoneId = ZoneId.systemDefault()): List<DayUsage> =
        Dates.lastFullDays(now, count, zone).map { readDay(it, zone) }

    /** Read a single local day. */
    fun readDay(day: LocalDate, zone: ZoneId = ZoneId.systemDefault()): DayUsage {
        val (start, end) = Dates.dayBounds(day, zone)

        // Foreground time per package.
        val agg = usm.queryAndAggregateUsageStats(start, end)

        // Unlocks + first/last use + per-app opens from the event stream.
        var unlocks = 0
        var firstMs = Long.MAX_VALUE
        var lastMs = Long.MIN_VALUE
        val opensByPkg = HashMap<String, Int>()   // per-package foreground launches
        val events = usm.queryEvents(start, end)
        val e = UsageEvents.Event()
        while (events.hasNextEvent()) {
            events.getNextEvent(e)
            when (e.eventType) {
                UsageEvents.Event.KEYGUARD_HIDDEN -> unlocks++
                UsageEvents.Event.ACTIVITY_RESUMED,
                UsageEvents.Event.MOVE_TO_FOREGROUND -> {
                    if (e.timeStamp < firstMs) firstMs = e.timeStamp
                    if (e.timeStamp > lastMs) lastMs = e.timeStamp
                    e.packageName?.let { pkg ->
                        opensByPkg[pkg] = (opensByPkg[pkg] ?: 0) + 1
                    }
                }
            }
        }

        // Merge foreground minutes with the opens tally (an app with minutes but
        // no resume event -> opens 0).
        val apps = agg.entries.mapNotNull { (pkg, stats) ->
            val minutes = (stats.totalTimeInForeground / 60000L).toInt()
            if (minutes <= 0) null
            else AppUsage(pkg, labelFor(pkg), minutes, opensByPkg[pkg] ?: 0)
        }

        return Aggregate.build(
            date = day.format(DateTimeFormatter.ISO_LOCAL_DATE),
            apps = apps,
            unlocks = unlocks,
            firstUseMs = if (firstMs == Long.MAX_VALUE) null else firstMs,
            lastUseMs = if (lastMs == Long.MIN_VALUE) null else lastMs,
            zone = zone
        )
    }

    private fun labelFor(pkg: String): String = try {
        val pm = context.packageManager
        pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
    } catch (_: Exception) {
        pkg   // fallback: some system packages won't resolve
    }

    /** Pure date helpers — no Android imports, unit-testable. */
    object Dates {
        /** Millis [start, end) covering the given local calendar day. */
        fun dayBounds(day: LocalDate, zone: ZoneId): Pair<Long, Long> {
            val start = day.atStartOfDay(zone).toInstant().toEpochMilli()
            val end = day.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()
            return start to end
        }

        /** The [count] full days ending on the day *before* `now`'s local date. */
        fun lastFullDays(now: Instant, count: Int, zone: ZoneId): List<LocalDate> {
            val today = now.atZone(zone).toLocalDate()
            // Most-recent full day is yesterday; return chronological order.
            return (count downTo 1).map { today.minusDays(it.toLong()) }
        }
    }

    /** Pure aggregation — no Android imports, unit-testable. */
    object Aggregate {
        private val HHMM = DateTimeFormatter.ofPattern("HH:mm")

        fun build(date: String, apps: List<AppUsage>, unlocks: Int,
                  firstUseMs: Long?, lastUseMs: Long?, zone: ZoneId): DayUsage {
            val sorted = apps.sortedByDescending { it.min }
            val screen = sorted.sumOf { it.min }
            return DayUsage(
                date = date,
                screenMin = screen,
                unlocks = unlocks,
                topApps = sorted.take(8),
                firstUse = firstUseMs?.let { hhmm(it, zone) },
                lastUse = lastUseMs?.let { hhmm(it, zone) }
            )
        }

        private fun hhmm(ms: Long, zone: ZoneId): String =
            Instant.ofEpochMilli(ms).atZone(zone).toLocalTime().format(HHMM)
    }
}
