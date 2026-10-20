package com.todopup.usage

import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

class TaskCountdownTest {
    private val now = Instant.parse("2026-06-15T12:00:00Z")
    private val zone = ZoneId.of("America/Los_Angeles")

    @Test fun `countdowns match web tiers and switch to hours below two days`() {
        val cases = listOf(
            259200L to "3 day(s) left", 172800L to "2 day(s) left",
            172799L to "47 hour(s) left", 129600L to "36 hour(s) left",
            86400L to "24 hour(s) left", 3600L to "1 hour(s) left",
            3599L to "due soon", 1L to "due soon", 0L to "overdue",
            -1L to "overdue", -3600L to "overdue by 1 hour(s)",
            -86400L to "overdue by 1 day(s)", -172800L to "overdue by 2 day(s)",
        )
        cases.forEach { (seconds, label) ->
            val result = TaskCountdown.remaining(now.plusSeconds(seconds).toString(), now, zone)
            assertEquals(label, result.text)
            assertEquals(seconds <= 0, result.overdue)
        }
    }

    @Test fun `local due values use the device zone while explicit offsets are respected`() {
        assertEquals("36 hour(s) left", TaskCountdown.remaining("2026-06-16T17:00:00", now, zone).text)
        assertEquals("43 hour(s) left", TaskCountdown.remaining("2026-06-17", now, zone).text)
        assertEquals("36 hour(s) left", TaskCountdown.remaining("2026-06-17T08:00:00+08:00", now, zone).text)
    }

    @Test fun `missing or invalid deadlines do not become overdue`() {
        listOf(null, "", "not a date").forEach {
            assertEquals(TaskCountdown.Badge("", false), TaskCountdown.remaining(it, now, zone))
        }
    }

    @Test fun `recomputing from the current clock catches up after suspension`() {
        val due = now.plusSeconds(129600).toString()
        assertEquals("36 hour(s) left", TaskCountdown.remaining(due, now, zone).text)
        assertEquals("24 hour(s) left", TaskCountdown.remaining(due, now.plusSeconds(43200), zone).text)
        assertEquals(TaskCountdown.Badge("overdue", true), TaskCountdown.remaining(due, now.plusSeconds(129600), zone))
    }
}
