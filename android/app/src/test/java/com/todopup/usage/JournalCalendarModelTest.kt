package com.todopup.usage

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.YearMonth

class JournalCalendarModelTest {
    @Test fun monthGridStartsMondayAndMarksEntryDates() {
        val days = JournalCalendarModel.month(
            YearMonth.of(2026, 8),
            selected = LocalDate.of(2026, 8, 6),
            entryDates = setOf("2026-08-01", "2026-08-06"),
        )

        assertEquals(42, days.size)
        assertEquals(LocalDate.of(2026, 7, 27), days.first().date)
        assertEquals(LocalDate.of(2026, 9, 6), days.last().date)
        assertTrue(days.single { it.date == LocalDate.of(2026, 8, 1) }.hasEntry)
        assertTrue(days.single { it.date == LocalDate.of(2026, 8, 6) }.selected)
        assertFalse(days.single { it.date == LocalDate.of(2026, 7, 31) }.inMonth)
    }
}
