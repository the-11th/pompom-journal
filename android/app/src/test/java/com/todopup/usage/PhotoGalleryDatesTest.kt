package com.todopup.usage

import java.time.LocalDate
import java.time.ZoneId
import org.junit.Assert.*
import org.junit.Test

class PhotoGalleryDatesTest {
    private val zone = ZoneId.of("America/Los_Angeles")
    @Test fun selectedDayUsesCaptureTimeAndLocalMidnight() {
        val day = LocalDate.parse("2026-09-24")
        val start = day.atStartOfDay(zone).toInstant().toEpochMilli()
        val end = day.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()
        assertFalse(PhotoGalleryDates.includes(start - 1, day, zone))
        assertTrue(PhotoGalleryDates.includes(start, day, zone))
        assertTrue(PhotoGalleryDates.includes(end - 1, day, zone))
        assertFalse(PhotoGalleryDates.includes(end, day, zone))
        assertFalse(PhotoGalleryDates.includes(null, day, zone))
        assertFalse(PhotoGalleryDates.includes(0, day, zone))
    }
    @Test fun daylightSavingDaysUseCalendarBoundaries() {
        for (date in listOf("2026-03-08", "2026-11-01")) {
            val day = LocalDate.parse(date)
            val end = day.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()
            assertTrue(PhotoGalleryDates.includes(end - 1, day, zone))
            assertFalse(PhotoGalleryDates.includes(end, day, zone))
        }
    }
    @Test fun allPhotosIncludesOtherDaysAndUnknownCaptureDates() {
        for (time in listOf(null, 0L, 1L, 1790290800000L))
            assertTrue(PhotoGalleryDates.includes(time, null, zone))
    }
}
