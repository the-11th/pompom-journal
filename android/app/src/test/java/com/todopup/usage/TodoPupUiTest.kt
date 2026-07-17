package com.todopup.usage

import org.junit.Assert.assertEquals
import org.junit.Test

class TodoPupUiTest {
    @Test
    fun `android palette mirrors the web css variables`() {
        assertEquals("#14161a", TodoPupUi.BACKGROUND)
        assertEquals("#1c1f26", TodoPupUi.PANEL)
        assertEquals("#e6e6e6", TodoPupUi.TEXT)
        assertEquals("#8a8f99", TodoPupUi.MUTED)
        assertEquals("#2a2e37", TodoPupUi.BORDER)
        assertEquals("#e0a955", TodoPupUi.ACCENT)
        assertEquals("#e0524d", TodoPupUi.DANGER)
    }

    @Test
    fun `record control matches the compact web mic`() {
        assertEquals(26, TodoPupUi.RECORD_SIZE_DP)
        assertEquals(10, TodoPupUi.RECORD_DOT_DP)
        assertEquals(6, TodoPupUi.RECORD_INSET_DP)
    }
}
