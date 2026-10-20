package com.todopup.usage

/** A network acknowledgement must never replace text typed after that request. */
object JournalAcknowledgement {
    fun merge(local: JournalDraft, sent: JournalDraft, server: JournalDraft, now: java.time.Instant = java.time.Instant.now()): JournalDraft {
        if (local.requestId == sent.requestId && local.baseUpdated == sent.baseUpdated && local.baseEditRevision == sent.baseEditRevision &&
            MobileSyncPolicy.matchesRemote(local, sent) && local.newTags == sent.newTags &&
            local.autosave == sent.autosave)
            return server.copy(syncState = SyncState.SYNCED, syncMessage = null, serverVersion = null,
                modifiedAt = JournalRevision.afterAcknowledgement(local.modifiedAt,
                    server.body != local.body || !DocumentJson.same(server.document, local.document), now))
        if (local.baseUpdated != sent.baseUpdated || local.baseEditRevision != sent.baseEditRevision || local.syncState == SyncState.CONFLICT) return local
        var document = if (DocumentJson.same(local.document, sent.document)) server.document else local.document
        var unsafeDocument = false
        if (server.body != sent.body && local.document != null && sent.document != null && server.document != null &&
            !DocumentJson.same(local.document, sent.document)) {
            document = DocumentJson.acknowledgeText(local.document, sent.document, server.document)
            unsafeDocument = document == null
        }
        if (server.body != sent.body && (local.body != sent.body || unsafeDocument)) {
            // Explicit Save can replace [] commands with real task references.
            // Preserve a newer edit and require review instead of spawning twice.
            return local.copy(syncState = SyncState.CONFLICT,
                syncMessage = "Saved commands changed while you were editing. Review both versions before syncing.",
                serverVersion = MobileJson.draft(server).put("updated", server.baseUpdated))
        }
        val body = if (local.body == sent.body) server.body else local.body
        return local.copy(baseUpdated = server.baseUpdated, baseEditRevision = server.baseEditRevision, body = body, document = document,
            modifiedAt = JournalRevision.afterAcknowledgement(local.modifiedAt,
                body != local.body || !DocumentJson.same(document, local.document), now))
    }
}
