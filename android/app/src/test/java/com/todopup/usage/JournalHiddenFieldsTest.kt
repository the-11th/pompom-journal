package com.todopup.usage

import org.junit.Assert.assertEquals
import org.junit.Test

class JournalHiddenFieldsTest {
    @Test fun `conflict choice preserves fields hidden from the current form`() {
        val sections = listOf(JournalSection("people", "People", "tag", "#e0a955"),
            JournalSection("weight", "Weight", "numeric", "#e0a955"),
            JournalSection("sleep", "Sleep", "numeric", "#e0a955", managed = "google"))
        val local = JournalDraft("2026-09-10", body = "Before", tags = mapOf("people" to listOf("alex"), "archived" to listOf("kept")),
            numbers = mapOf("weight" to 70.0, "sleep" to 8.0, "archived-number" to 3.0), audioTranscript = "Remembered voice")
        val submitted = JournalDraft(local.date, body = "Chosen phone words", numbers = mapOf("weight" to 71.0, "sleep" to 0.0))
        val merged = JournalHiddenFields.restore(submitted, local, sections, hasTranscript = false)
        assertEquals("Chosen phone words", merged.body)
        assertEquals(mapOf("archived" to listOf("kept")), merged.tags)
        assertEquals(mapOf("weight" to 71.0, "sleep" to 8.0, "archived-number" to 3.0), merged.numbers)
        assertEquals("Remembered voice", merged.audioTranscript)
        assertEquals("", JournalHiddenFields.restore(submitted, local, sections, hasTranscript = true).audioTranscript)
        assertEquals(submitted, JournalHiddenFields.restore(submitted, null, sections, hasTranscript = false))
    }
}
