package com.todopup.usage

object MobileSyncPolicy {
    fun pullDates(config: MobileJournalConfig, local: List<JournalDraft>): List<String> =
        (config.entryDates + local.filter {
            it.syncState == SyncState.SYNCED && it.date in config.storedEntryDates
        }.map { it.date }).distinct().sorted()

    fun hasMedia(draft: JournalDraft): Boolean = draft.document?.let { Regex("\"type\"\\s*:\"(photo|message)\"").containsMatchIn(it.replace(" ", "")) } == true

    fun hasMeaningfulContent(draft: JournalDraft): Boolean =
        (draft.title.isNotBlank() && draft.title.trim() != draft.date) ||
            draft.body.isNotBlank() || draft.mood != null ||
            draft.tags.values.any(List<String>::isNotEmpty) || draft.numbers.isNotEmpty() ||
            draft.audioTranscript.isNotBlank() ||
            hasMedia(draft)

    // An empty edit to an existing entry must still sync so users can clear it.
    fun shouldUpload(draft: JournalDraft): Boolean =
        hasMeaningfulContent(draft) || !draft.baseUpdated.isNullOrBlank()

    fun shouldUploadOnExplicit(draft: JournalDraft): Boolean =
        draft.syncState in setOf(SyncState.DRAFT, SyncState.PERMANENT_FAILURE) &&
            shouldUpload(draft)

    fun shouldPullRemote(local: JournalDraft?): Boolean =
        local == null || local.syncState == SyncState.SYNCED ||
            (local.syncState == SyncState.DRAFT && !shouldUpload(local))

    fun matchesRemote(local: JournalDraft, remote: JournalDraft): Boolean =
        local.title == remote.title && local.body == remote.body && local.mood == remote.mood &&
            local.tags == remote.tags && local.numbers == remote.numbers &&
            local.audioTranscript == remote.audioTranscript && DocumentJson.same(local.document, remote.document)
}

data class MobileSyncReport(
    var journalUploaded: Int = 0,
    var mediaFiles: Int = 0,
    var mapPacks: Int = 0,
    var journalDownloaded: Int = 0,
    var journalRemoved: Int = 0,
    var phoneChangesUploaded: Int = 0,
    var tasksDownloaded: Int = 0,
    var tasksRemoved: Int = 0,
    var journalConflicts: Int = 0,
    var mediaConflicts: Int = 0,
    var journalRejected: Int = 0,
    var journalDeferred: Int = 0,
    var phoneChangesRejected: Int = 0,
    val errors: MutableList<String> = mutableListOf(),
) {
    fun hasUnresolved(): Boolean = journalConflicts > 0 || mediaConflicts > 0 || journalRejected > 0 ||
        journalDeferred > 0 || phoneChangesRejected > 0 || errors.isNotEmpty()

    fun summary(): String {
        val synced = buildList {
            if (mediaFiles > 0) add("$mediaFiles media ${word(mediaFiles, "file", "files")} synced")
            if (mapPacks > 0) add("$mapPacks offline map ${word(mapPacks, "pack", "packs")} downloaded to phone")
            if (journalUploaded > 0) add("$journalUploaded phone ${word(journalUploaded, "entry", "entries")} → Mac")
            if (journalDownloaded > 0) add("$journalDownloaded Mac ${word(journalDownloaded, "entry", "entries")} → phone")
            if (journalRemoved > 0) add("$journalRemoved deleted Mac ${word(journalRemoved, "entry", "entries")} removed from phone")
            if (phoneChangesUploaded > 0) add("$phoneChangesUploaded phone ${word(phoneChangesUploaded, "change", "changes")} → Mac")
            if (tasksDownloaded > 0) add("$tasksDownloaded Mac ${word(tasksDownloaded, "task", "tasks")} → phone")
            if (tasksRemoved > 0) add("$tasksRemoved deleted Mac ${word(tasksRemoved, "task", "tasks")} removed from phone")
        }
        val notSynced = buildList {
            if (journalConflicts > 0) add("$journalConflicts ${word(journalConflicts, "entry conflict", "entry conflicts")}")
            if (mediaConflicts > 0) add("$mediaConflicts photo or place ${word(mediaConflicts, "change needs", "changes need")} review in Photos & places")
            if (journalRejected > 0) add("$journalRejected rejected phone ${word(journalRejected, "entry", "entries")}")
            if (journalDeferred > 0) add("$journalDeferred unsaved local ${word(journalDeferred, "draft", "drafts")} kept on phone")
            if (phoneChangesRejected > 0) add("$phoneChangesRejected rejected phone ${word(phoneChangesRejected, "change", "changes")}")
            addAll(errors.distinct())
        }
        val completed = if (synced.isEmpty() && hasUnresolved()) "Nothing synced."
            else sentence("Synced: ${synced.takeIf(List<String>::isNotEmpty)?.joinToString("; ") ?: "phone and Mac already matched"}")
        return completed + "\n" + sentence("Not synced: ${notSynced.takeIf(List<String>::isNotEmpty)?.joinToString("; ") ?: "none"}")
    }

    private fun sentence(text: String) = text.trimEnd().let { if (it.lastOrNull() in listOf('.', '!', '?')) it else "$it." }
    private fun word(count: Int, one: String, many: String) = if (count == 1) one else many
}
