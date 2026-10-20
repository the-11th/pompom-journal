package com.todopup.usage

import java.time.DayOfWeek
import java.time.LocalDate
import java.time.YearMonth
import java.time.temporal.TemporalAdjusters

data class JournalCalendarDay(
    val date: LocalDate,
    val inMonth: Boolean,
    val selected: Boolean,
    val hasEntry: Boolean,
)

object JournalCalendarModel {
    fun month(
        month: YearMonth,
        selected: LocalDate,
        entryDates: Set<String>,
    ): List<JournalCalendarDay> {
        val first = month.atDay(1).with(TemporalAdjusters.previousOrSame(DayOfWeek.MONDAY))
        return (0L until 42L).map { offset ->
            val date = first.plusDays(offset)
            JournalCalendarDay(
                date = date,
                inMonth = YearMonth.from(date) == month,
                selected = date == selected,
                hasEntry = date.toString() in entryDates,
            )
        }
    }
}
