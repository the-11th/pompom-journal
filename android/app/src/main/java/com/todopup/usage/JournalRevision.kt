package com.todopup.usage

import java.time.Instant

internal object JournalRevision {
    fun afterRemotePull(local: JournalDraft, remote: JournalDraft, now: Instant = Instant.now()): String {
        val sameContent = if (local.baseEditRevision != null && remote.baseEditRevision != null)
            local.baseEditRevision == remote.baseEditRevision else MobileSyncPolicy.matchesRemote(local, remote)
        if (sameContent) return local.modifiedAt
        return afterAcknowledgement(local.modifiedAt, true, now)
    }

    fun afterAcknowledgement(previous: String, contentChanged: Boolean, now: Instant = Instant.now()): String {
        if (!contentChanged) return previous
        val before = runCatching { Instant.parse(previous) }.getOrNull()
        return if (before != null && !now.isAfter(before)) before.plusNanos(1).toString() else now.toString()
    }
}
