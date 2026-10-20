package com.todopup.usage

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

enum class SyncUiState { CONFIGURED, SYNCING, CONNECTED, RETRYING, FAILED }
enum class UiFlow { JOURNAL_ENTRY, TASKS }
data class ConnectionUi(val message: String, val canSync: Boolean)
enum class UiControl {
    JOURNAL_DATE,
    JOURNAL_TITLE,
    JOURNAL_MOOD,
    JOURNAL_BODY,
    JOURNAL_VOICE,
    JOURNAL_TAGS,
    JOURNAL_SYNC,
    JOURNAL_SAVE,
    TASK_QUICK_ADD,
    TASK_CREATE,
    TASK_COMPLETE,
    TASK_EDIT,
    TASK_DELETE,
}

/** Android mirror of the theme tokens in static/style.css. */
object TodoPupUi {
    const val BACKGROUND = "#14161a"
    const val PANEL = "#1c1f26"
    const val TEXT = "#e6e6e6"
    const val MUTED = "#8a8f99"
    const val BORDER = "#2a2e37"
    const val ACCENT = "#e0a955"
    const val DANGER = "#e0524d"
    const val SUCCESS = "#3fae5a"

    const val SPACE_XS_DP = 4
    const val SPACE_SM_DP = 8
    const val SPACE_MD_DP = 12
    const val SPACE_LG_DP = 18
    const val SPACE_XL_DP = 28
    const val PAGE_GUTTER_DP = SPACE_LG_DP
    const val PAGE_BOTTOM_DP = SPACE_XL_DP
    const val CONTENT_GAP_DP = SPACE_SM_DP
    const val CARD_PADDING_DP = SPACE_MD_DP
    const val DIALOG_PADDING_DP = SPACE_LG_DP
    const val CONTROL_PADDING_DP = SPACE_MD_DP
    const val SECTION_TOP_GAP_DP = SPACE_LG_DP
    const val CONTROL_HEIGHT_DP = 44
    const val COMPACT_CONTROL_HEIGHT_DP = CONTROL_HEIGHT_DP
    const val NAV_HEIGHT_DP = 60
    const val CONTROL_RADIUS_DP = 4
    const val TEXTAREA_RADIUS_DP = 8
    const val RECORD_SIZE_DP = 26
    const val RECORD_DOT_DP = 10
    const val RECORD_INSET_DP = 6

    fun taskDueValue(day: String, previous: String?): String? {
        val date = day.trim().takeIf(String::isNotBlank) ?: return null
        if (date == previous?.take(10)) return previous
        val time = previous?.drop(10)?.takeIf { it.startsWith("T") && it.length > 1 }
            ?: "T23:59:00"
        return date + time
    }

    fun taskTitleError(value: String): String? =
        if (value.isBlank()) "Add a task title." else null

    fun canEditTask(status: String): Boolean = status == "active"

    fun acceptsDeepLink(packageName: String, scheme: String?): Boolean =
        scheme == if (packageName.endsWith(".qa")) "todopup-qa" else "todopup"

    fun connectionStatus(configured: Boolean, verifiedAt: String,
                         zone: ZoneId = ZoneId.systemDefault()): ConnectionUi {
        if (!configured) return ConnectionUi("Not paired", false)
        val connected = runCatching {
            Instant.parse(verifiedAt).atZone(zone).format(DateTimeFormatter.ofPattern("MMM d, HH:mm", Locale.ENGLISH))
        }.getOrNull()
        return ConnectionUi(connected?.let { "Last connected $it" } ?: "Paired · ready to sync", true)
    }

    fun galleryMessage(photoCount: Int, photoAccess: Boolean, locationAccess: Boolean): String? = when {
        !photoAccess -> "Allow photo access or use Other gallery."
        photoCount == 0 -> "No photos available."
        !locationAccess -> "Photo locations are off. Enable them in Photo access."
        else -> null
    }

    fun syncMessage(state: SyncUiState, error: String? = null): String = when (state) {
        SyncUiState.CONFIGURED -> "Connection saved · not tested yet"
        SyncUiState.SYNCING -> "Syncing with Mac through USB…"
        SyncUiState.CONNECTED -> error ?: "Connected to Mac through USB"
        SyncUiState.RETRYING -> error ?: "Mac unavailable · retry queued"
        SyncUiState.FAILED -> error ?: "Could not connect to Mac"
    }

    fun flowControls(flow: UiFlow): List<UiControl> = when (flow) {
        UiFlow.JOURNAL_ENTRY -> listOf(
            UiControl.JOURNAL_DATE,
            UiControl.JOURNAL_TITLE,
            UiControl.JOURNAL_MOOD,
            UiControl.JOURNAL_BODY,
            UiControl.JOURNAL_VOICE,
            UiControl.JOURNAL_TAGS,
            UiControl.JOURNAL_SYNC,
            UiControl.JOURNAL_SAVE,
        )
        UiFlow.TASKS -> listOf(
            UiControl.TASK_QUICK_ADD,
            UiControl.TASK_CREATE,
            UiControl.TASK_COMPLETE,
            UiControl.TASK_EDIT,
            UiControl.TASK_DELETE,
        )
    }

    fun controlDescription(control: UiControl): String = when (control) {
        UiControl.JOURNAL_DATE -> "Journal date"
        UiControl.JOURNAL_TITLE -> "Journal title"
        UiControl.JOURNAL_MOOD -> "Journal mood"
        UiControl.JOURNAL_BODY -> "Journal body"
        UiControl.JOURNAL_VOICE -> "Record voice"
        UiControl.JOURNAL_TAGS -> "Journal tags"
        UiControl.JOURNAL_SYNC -> "Sync entries now"
        UiControl.JOURNAL_SAVE -> "Save entry"
        UiControl.TASK_QUICK_ADD -> "New task title"
        UiControl.TASK_CREATE -> "Create task"
        UiControl.TASK_COMPLETE -> "Complete task"
        UiControl.TASK_EDIT -> "Edit task"
        UiControl.TASK_DELETE -> "Delete task"
    }

    fun calendarDayDescription(day: String, hasEntry: Boolean): String =
        if (hasEntry) "$day · journal entry saved" else day
}
