package com.todopup.usage

/** Calendar markers are independent of location history and syncable metrics. */
object JournalCalendarEntries {
    fun hasContent(draft: JournalDraft): Boolean =
        (draft.title.isNotBlank() && draft.title.trim() != draft.date) ||
            draft.body.isNotBlank() || draft.audioTranscript.isNotBlank() ||
            draft.tags.values.any { names -> names.any(String::isNotBlank) } ||
            MobileSyncPolicy.hasMedia(draft)

    fun dates(cached: Collection<String>, local: List<JournalDraft>): Set<String> =
        cached.toMutableSet().apply {
            for (draft in local) {
                if (hasContent(draft)) add(draft.date) else remove(draft.date)
            }
        }
}
