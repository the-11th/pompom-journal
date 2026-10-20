package com.todopup.usage

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.ZoneId

class TodoPupUiTest {
    @Test
    fun `editing notes preserves the original due time and timezone`() {
        val due = "2026-09-10T14:30:00+08:00"
        assertEquals(due, TodoPupUi.taskDueValue("2026-09-10", due))
        assertEquals("2026-09-12T14:30:00+08:00", TodoPupUi.taskDueValue("2026-09-12", due))
        assertEquals("2026-09-12T23:59:00", TodoPupUi.taskDueValue("2026-09-12", null))
        assertNull(TodoPupUi.taskDueValue("", due))
    }

    @Test
    fun `only active task details can be edited while completed tasks can reopen`() {
        assertTrue(TodoPupUi.canEditTask("active"))
        assertFalse(TodoPupUi.canEditTask("completed"))
        assertFalse(TodoPupUi.canEditTask("expired"))
    }

    @Test
    fun `blank task titles have a readable validation error`() {
        assertEquals("Add a task title.", TodoPupUi.taskTitleError("  \n "))
        assertNull(TodoPupUi.taskTitleError(" Review margins "))
    }

    @Test
    fun `QA deep links stay separate from production pairing`() {
        assertTrue(TodoPupUi.acceptsDeepLink("com.todopup.usage.qa", "todopup-qa"))
        assertFalse(TodoPupUi.acceptsDeepLink("com.todopup.usage.qa", "todopup"))
        assertTrue(TodoPupUi.acceptsDeepLink("com.todopup.usage", "todopup"))
        assertFalse(TodoPupUi.acceptsDeepLink("com.todopup.usage", "todopup-qa"))
    }

    @Test
    fun `a paired but unverified connection can be retried`() {
        val status = TodoPupUi.connectionStatus(true, "", ZoneId.of("Asia/Shanghai"))
        assertTrue(status.canSync)
        assertEquals("Paired · ready to sync", status.message)
        assertFalse(TodoPupUi.connectionStatus(false, "", ZoneId.of("UTC")).canSync)
    }

    @Test
    fun `remembered connection time does not claim a live USB connection`() {
        val status = TodoPupUi.connectionStatus(true, "2026-09-09T17:00:00Z", ZoneId.of("Asia/Shanghai"))
        assertEquals("Last connected Sep 10, 01:00", status.message)
        assertTrue(status.canSync)
        assertEquals("Paired · ready to sync", TodoPupUi.connectionStatus(true, "invalid", ZoneId.of("UTC")).message)
    }

    @Test
    fun `gallery distinguishes denied access from a granted empty library`() {
        assertEquals("Allow photo access or use Other gallery.",
            TodoPupUi.galleryMessage(0, photoAccess = false, locationAccess = false))
        assertEquals("No photos available.",
            TodoPupUi.galleryMessage(0, photoAccess = true, locationAccess = false))
        assertNull(TodoPupUi.galleryMessage(2, photoAccess = true, locationAccess = true))
        assertEquals("Photo locations are off. Enable them in Photo access.",
            TodoPupUi.galleryMessage(2, photoAccess = true, locationAccess = false))
    }

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

    @Test
    fun `sync states distinguish saved configuration from a live connection`() {
        assertEquals("Connection saved · not tested yet",
            TodoPupUi.syncMessage(SyncUiState.CONFIGURED))
        assertEquals("Syncing with Mac through USB…",
            TodoPupUi.syncMessage(SyncUiState.SYNCING))
        assertEquals("Connected to Mac through USB",
            TodoPupUi.syncMessage(SyncUiState.CONNECTED))
        assertEquals("Mac unavailable · retry queued",
            TodoPupUi.syncMessage(SyncUiState.RETRYING))
        assertEquals("Token rejected",
            TodoPupUi.syncMessage(SyncUiState.FAILED, "Token rejected"))
    }

    @Test
    fun `spacing tokens form one consistent four point layout scale`() {
        assertEquals(4, TodoPupUi.SPACE_XS_DP)
        assertEquals(8, TodoPupUi.SPACE_SM_DP)
        assertEquals(12, TodoPupUi.SPACE_MD_DP)
        assertEquals(18, TodoPupUi.SPACE_LG_DP)
        assertEquals(TodoPupUi.SPACE_LG_DP, TodoPupUi.PAGE_GUTTER_DP)
        assertEquals(TodoPupUi.SPACE_SM_DP, TodoPupUi.CONTENT_GAP_DP)
        assertEquals(TodoPupUi.SPACE_MD_DP, TodoPupUi.CARD_PADDING_DP)
        assertEquals(TodoPupUi.SPACE_LG_DP, TodoPupUi.DIALOG_PADDING_DP)
    }

    @Test
    fun `journal presentation exposes a complete create and edit flow`() {
        val controls = TodoPupUi.flowControls(UiFlow.JOURNAL_ENTRY)

        assertEquals(
            listOf(
                UiControl.JOURNAL_DATE,
                UiControl.JOURNAL_TITLE,
                UiControl.JOURNAL_MOOD,
                UiControl.JOURNAL_BODY,
                UiControl.JOURNAL_VOICE,
                UiControl.JOURNAL_TAGS,
                UiControl.JOURNAL_SYNC,
                UiControl.JOURNAL_SAVE,
            ),
            controls,
        )
        assertTrue(controls.indexOf(UiControl.JOURNAL_BODY) < controls.indexOf(UiControl.JOURNAL_SAVE))
    }

    @Test
    fun `task presentation exposes create edit complete and delete controls`() {
        assertEquals(
            listOf(
                UiControl.TASK_QUICK_ADD,
                UiControl.TASK_CREATE,
                UiControl.TASK_COMPLETE,
                UiControl.TASK_EDIT,
                UiControl.TASK_DELETE,
            ),
            TodoPupUi.flowControls(UiFlow.TASKS),
        )
    }

    @Test
    fun `future calendar markers retain accessible entry state`() {
        assertEquals("August 6, 2026 · journal entry saved",
            TodoPupUi.calendarDayDescription("August 6, 2026", hasEntry = true))
        assertEquals("August 7, 2026",
            TodoPupUi.calendarDayDescription("August 7, 2026", hasEntry = false))
    }

    @Test
    fun `flow controls expose readable accessibility labels`() {
        assertEquals("Journal body", TodoPupUi.controlDescription(UiControl.JOURNAL_BODY))
        assertEquals("Record voice", TodoPupUi.controlDescription(UiControl.JOURNAL_VOICE))
        assertEquals("Create task", TodoPupUi.controlDescription(UiControl.TASK_CREATE))
        assertEquals("Delete task", TodoPupUi.controlDescription(UiControl.TASK_DELETE))
    }
}
