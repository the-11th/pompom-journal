package com.todopup.usage

/** Read-only provider and archived fields survive forms that do not render them. */
internal object JournalHiddenFields {
    fun restore(submitted: JournalDraft, previous: JournalDraft?, sections: List<JournalSection>, hasTranscript: Boolean): JournalDraft {
        if (previous == null) return submitted
        return submitted.copy(
            tags = submitted.tags + previous.tags.filterKeys { id -> sections.none { it.id == id } },
            numbers = submitted.numbers + previous.numbers.filterKeys { id -> sections.none { it.id == id && it.managed == null } },
            audioTranscript = if (hasTranscript) submitted.audioTranscript else previous.audioTranscript,
        )
    }
}
