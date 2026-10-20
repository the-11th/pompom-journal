package com.todopup.usage

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/** Android daily intervals can drift a little either side of local midnight. */
object UsageHistoryPolicy {
    fun day(start: Long, zone: ZoneId): LocalDate =
        Instant.ofEpochMilli(start).atZone(zone).plusHours(12).toLocalDate()

    fun completedDay(start: Long, now: Instant, zone: ZoneId): LocalDate? {
        val date = day(start, zone)
        val end = Instant.ofEpochMilli(start).atZone(zone).plusDays(1).toInstant()
        return date.takeIf { it < now.atZone(zone).toLocalDate() && !end.isAfter(now) }
    }
}
