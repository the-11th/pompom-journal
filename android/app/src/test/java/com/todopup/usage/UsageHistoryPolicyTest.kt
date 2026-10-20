package com.todopup.usage

import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

class UsageHistoryPolicyTest {
    private val zone = ZoneId.of("America/Los_Angeles")
    private fun millis(value: String) = java.time.OffsetDateTime.parse(value).toInstant().toEpochMilli()

    @Test fun `daily buckets near midnight belong to the day they mostly cover`() {
        assertEquals(LocalDate.parse("2026-10-10"), UsageHistoryPolicy.day(
            millis("2026-10-09T23:33:00-07:00"), zone))
        assertEquals(LocalDate.parse("2026-10-16"), UsageHistoryPolicy.day(
            millis("2026-10-16T00:19:00-07:00"), zone))
    }

    @Test fun `only finished retained daily buckets qualify and absent days are not invented`() {
        val now = Instant.parse("2026-10-20T05:00:00Z")
        val starts = listOf("2026-10-10T00:00:00-07:00", "2026-10-18T00:19:00-07:00",
            "2026-10-19T00:19:00-07:00").map(::millis)
        assertEquals(listOf("2026-10-10", "2026-10-18"),
            starts.mapNotNull { UsageHistoryPolicy.completedDay(it, now, zone)?.toString() })
        // At 00:05 an OEM interval beginning at 00:19 yesterday is still open.
        assertNull(UsageHistoryPolicy.completedDay(starts[1],
            Instant.parse("2026-10-19T07:05:00Z"), zone))
    }

    @Test fun `calendar completion handles daylight saving time`() {
        val start = millis("2026-11-01T00:00:00-07:00")
        assertNull(UsageHistoryPolicy.completedDay(start, Instant.parse("2026-11-02T07:30:00Z"), zone))
        assertEquals(LocalDate.parse("2026-11-01"),
            UsageHistoryPolicy.completedDay(start, Instant.parse("2026-11-02T08:01:00Z"), zone))
    }
}
