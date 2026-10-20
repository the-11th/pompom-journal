package com.todopup.usage

import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneId

/** Pure mirror of todo.time_remaining and static/task-countdown.js. */
object TaskCountdown {
    data class Badge(val text: String, val overdue: Boolean)

    fun remaining(due: String?, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): Badge {
        if (due.isNullOrBlank()) return Badge("", false)
        val whenDue = runCatching { OffsetDateTime.parse(due).toInstant() }.getOrNull()
            ?: runCatching { LocalDateTime.parse(due).atZone(zone).toInstant() }.getOrNull()
            ?: runCatching { LocalDate.parse(due).atStartOfDay(zone).toInstant() }.getOrNull()
            ?: return Badge("", false)
        val delta = Duration.between(now, whenDue)
        if (delta.isNegative || delta.isZero) {
            val past = delta.negated().seconds
            return Badge(when {
                past >= 86400 -> "overdue by ${past / 86400} day(s)"
                past >= 3600 -> "overdue by ${past / 3600} hour(s)"
                else -> "overdue"
            }, true)
        }
        return Badge(when {
            delta.seconds >= 172800 -> "${delta.seconds / 86400} day(s) left"
            delta.seconds >= 3600 -> "${delta.seconds / 3600} hour(s) left"
            else -> "due soon"
        }, false)
    }
}
