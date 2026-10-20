package com.todopup.usage

import org.junit.Assert.*
import org.junit.Test

class JournalCalendarEntriesTest {
    private val empty = JournalDraft("2026-09-10", title = "2026-09-10")
    @Test fun `only text tags and attached content mark an entry`() {
        for (draft in listOf(empty.copy(body="A walk"), empty.copy(title="A day"),
            empty.copy(audioTranscript="A voice note"), empty.copy(tags=mapOf("people" to listOf("alex"))),
            empty.copy(document="[{\"type\":\"photo\",\"asset_id\":\"photo\"}]"),
            empty.copy(document="[{\"type\":\"message\",\"message_id\":\"note\"}]")))
            assertTrue(JournalCalendarEntries.hasContent(draft))
    }
    @Test fun `empty days and metrics do not mark the calendar but still sync`() {
        for (draft in listOf(empty, empty.copy(body=" \n",tags=mapOf("people" to listOf(" "))),
            empty.copy(mood=5),empty.copy(numbers=mapOf("weight" to 70.0)),
            empty.copy(document="[{\"type\":\"text\",\"text\":\"\"}]")))
            assertFalse(JournalCalendarEntries.hasContent(draft))
        assertTrue(MobileSyncPolicy.shouldUpload(empty.copy(mood=5)))
        assertTrue(MobileSyncPolicy.shouldUpload(empty.copy(numbers=mapOf("weight" to 70.0))))
    }
    @Test fun `clearing the last content removes a cached dot while keeping other dates`() {
        val dates=JournalCalendarEntries.dates(listOf("2026-09-08",empty.date),listOf(empty,
            empty.copy(date="2026-09-11",body="New text")))
        assertEquals(setOf("2026-09-08","2026-09-11"),dates)
    }
}
