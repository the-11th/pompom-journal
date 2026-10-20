package com.todopup.usage

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/** Unknown capture dates belong only in All photos, never in a guessed day. */
object PhotoGalleryDates {
    fun includes(takenAt: Long?, day: LocalDate?, zone: ZoneId = ZoneId.systemDefault()): Boolean {
        if (day == null) return true
        if (takenAt == null || takenAt <= 0) return false
        return Instant.ofEpochMilli(takenAt).atZone(zone).toLocalDate() == day
    }
}
