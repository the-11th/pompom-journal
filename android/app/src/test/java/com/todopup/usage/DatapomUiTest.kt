package com.todopup.usage

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.ZoneId

class DatapomUiTest {
    @Test
    fun `editing notes preserves the original due time and timezone`() {
        val due = "2026-09-10T14:30:00+08:00"
        assertEquals(due, DatapomUi.taskDueValue("2026-09-10", due))
        assertEquals("2026-09-12T14:30:00+08:00", DatapomUi.taskDueValue("2026-09-12", due))
        assertEquals("2026-09-12T23:59:00", DatapomUi.taskDueValue("2026-09-12", null))
        assertNull(DatapomUi.taskDueValue("", due))
    }

    @Test
    fun `only active task details can be edited while completed tasks can reopen`() {
        assertTrue(DatapomUi.canEditTask("active"))
        assertFalse(DatapomUi.canEditTask("completed"))
        assertFalse(DatapomUi.canEditTask("expired"))
    }

    @Test
    fun `blank task titles have a readable validation error`() {
        assertEquals("Add a task title.", DatapomUi.taskTitleError("  \n "))
        assertNull(DatapomUi.taskTitleError(" Review margins "))
    }

    @Test
    fun `QA deep links stay separate from production pairing`() {
        assertTrue(DatapomUi.acceptsDeepLink("com.todopup.usage.qa", "datapom-qa"))
        assertFalse(DatapomUi.acceptsDeepLink("com.todopup.usage.qa", "datapom"))
        assertTrue(DatapomUi.acceptsDeepLink("com.todopup.usage", "datapom"))
        assertFalse(DatapomUi.acceptsDeepLink("com.todopup.usage", "datapom-qa"))
        assertTrue(DatapomUi.acceptsDeepLink("com.todopup.usage.qa", "todopup-qa"))
        assertFalse(DatapomUi.acceptsDeepLink("com.todopup.usage.qa", "todopup"))
        assertTrue(DatapomUi.acceptsDeepLink("com.todopup.usage", "todopup"))
        assertFalse(DatapomUi.acceptsDeepLink("com.todopup.usage", "todopup-qa"))
        assertFalse(DatapomUi.acceptsDeepLink("com.todopup.usage", "https"))
        assertFalse(DatapomUi.acceptsDeepLink("com.todopup.usage", null))
    }

    @Test
    fun `a paired but unverified connection can be retried`() {
        val status = DatapomUi.connectionStatus(true, "", ZoneId.of("Asia/Shanghai"))
        assertTrue(status.canSync)
        assertEquals("Paired · ready to sync", status.message)
        assertFalse(DatapomUi.connectionStatus(false, "", ZoneId.of("UTC")).canSync)
    }

    @Test
    fun `remembered connection time does not claim a live USB connection`() {
        val status = DatapomUi.connectionStatus(true, "2026-09-09T17:00:00Z", ZoneId.of("Asia/Shanghai"))
        assertEquals("Last connected Sep 10, 01:00", status.message)
        assertTrue(status.canSync)
        assertEquals("Paired · ready to sync", DatapomUi.connectionStatus(true, "invalid", ZoneId.of("UTC")).message)
    }

    @Test
    fun `gallery distinguishes denied access from a granted empty library`() {
        assertEquals("Allow photo access or use Other gallery.",
            DatapomUi.galleryMessage(0, photoAccess = false, locationAccess = false))
        assertEquals("No photos available.",
            DatapomUi.galleryMessage(0, photoAccess = true, locationAccess = false))
        assertNull(DatapomUi.galleryMessage(2, photoAccess = true, locationAccess = true))
        assertEquals("Photo locations are off. Enable them in Photo access.",
            DatapomUi.galleryMessage(2, photoAccess = true, locationAccess = false))
    }

    @Test
    fun `android palette mirrors the web css variables`() {
        assertEquals("#14161a", DatapomUi.BACKGROUND)
        assertEquals("#1c1f26", DatapomUi.PANEL)
        assertEquals("#e6e6e6", DatapomUi.TEXT)
        assertEquals("#8a8f99", DatapomUi.MUTED)
        assertEquals("#2a2e37", DatapomUi.BORDER)
        assertEquals("#e0a955", DatapomUi.ACCENT)
        assertEquals("#e0524d", DatapomUi.DANGER)
    }

    @Test
    fun `record control matches the compact web mic`() {
        assertEquals(26, DatapomUi.RECORD_SIZE_DP)
        assertEquals(10, DatapomUi.RECORD_DOT_DP)
        assertEquals(6, DatapomUi.RECORD_INSET_DP)
    }

    @Test
    fun `sync states distinguish saved configuration from a live connection`() {
        assertEquals("Connection saved · not tested yet",
            DatapomUi.syncMessage(SyncUiState.CONFIGURED))
        assertEquals("Syncing with Mac through USB…",
            DatapomUi.syncMessage(SyncUiState.SYNCING))
        assertEquals("Connected to Mac through USB",
            DatapomUi.syncMessage(SyncUiState.CONNECTED))
        assertEquals("Mac unavailable · retry queued",
            DatapomUi.syncMessage(SyncUiState.RETRYING))
        assertEquals("Token rejected",
            DatapomUi.syncMessage(SyncUiState.FAILED, "Token rejected"))
    }

    @Test
    fun `spacing tokens form one consistent four point layout scale`() {
        assertEquals(4, DatapomUi.SPACE_XS_DP)
        assertEquals(8, DatapomUi.SPACE_SM_DP)
        assertEquals(12, DatapomUi.SPACE_MD_DP)
        assertEquals(18, DatapomUi.SPACE_LG_DP)
        assertEquals(DatapomUi.SPACE_LG_DP, DatapomUi.PAGE_GUTTER_DP)
        assertEquals(DatapomUi.SPACE_SM_DP, DatapomUi.CONTENT_GAP_DP)
        assertEquals(DatapomUi.SPACE_MD_DP, DatapomUi.CARD_PADDING_DP)
        assertEquals(DatapomUi.SPACE_LG_DP, DatapomUi.DIALOG_PADDING_DP)
    }

    @Test
    fun `journal presentation exposes a complete create and edit flow`() {
        val controls = DatapomUi.flowControls(UiFlow.JOURNAL_ENTRY)

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
            DatapomUi.flowControls(UiFlow.TASKS),
        )
    }

    @Test
    fun `future calendar markers retain accessible entry state`() {
        assertEquals("August 6, 2026 · journal entry saved",
            DatapomUi.calendarDayDescription("August 6, 2026", hasEntry = true))
        assertEquals("August 7, 2026",
            DatapomUi.calendarDayDescription("August 7, 2026", hasEntry = false))
    }

    @Test
    fun `flow controls expose readable accessibility labels`() {
        assertEquals("Journal body", DatapomUi.controlDescription(UiControl.JOURNAL_BODY))
        assertEquals("Record voice", DatapomUi.controlDescription(UiControl.JOURNAL_VOICE))
        assertEquals("Create task", DatapomUi.controlDescription(UiControl.TASK_CREATE))
        assertEquals("Delete task", DatapomUi.controlDescription(UiControl.TASK_DELETE))
    }
}
