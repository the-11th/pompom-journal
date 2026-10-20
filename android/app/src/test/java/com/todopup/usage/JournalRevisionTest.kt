package com.todopup.usage

import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

class JournalRevisionTest {
    private val now = Instant.parse("2026-09-09T12:00:00Z")
    @Test fun acknowledgementWithoutContentChangesDoesNotInvalidateAnOpenEditor() {
        assertEquals("previous", JournalRevision.afterAcknowledgement("previous", false, now))
    }
    @Test fun commandRewriteInvalidatesThePreviousEditorVersionEvenAtTheSameInstant() {
        assertNotEquals(now.toString(), JournalRevision.afterAcknowledgement(now.toString(), true, now))
    }
    @Test fun repeatedSavesAtOneClockTickNeverReuseAnEditorBaseline() {
        var previous = now.toString()
        val seen = mutableSetOf(previous)
        repeat(100) {
            val next = JournalRevision.afterAcknowledgement(previous, true, now)
            assertTrue("Repeated local revision $next", seen.add(next))
            assertTrue(Instant.parse(next).isAfter(Instant.parse(previous)))
            previous = next
        }
    }
    @Test fun clockRollbackCannotRestoreAStaleEditorBaseline() {
        val future = now.plusSeconds(86400).toString()
        val next = JournalRevision.afterAcknowledgement(future, true, now)
        assertTrue(Instant.parse(next).isAfter(Instant.parse(future)))
    }
    @Test fun acknowledgementRebasesOpaqueRevisionWithoutReplacingNewerTyping() {
        val sent = JournalDraft("2026-09-10", body = "Sent", baseUpdated = "before",
            baseEditRevision = "before-edit", requestId = "sent", syncState = SyncState.PENDING)
        val typed = sent.copy(body = "Typed later", requestId = "later")
        val ack = sent.copy(baseUpdated = "accepted", baseEditRevision = "accepted-edit")
        val merged = JournalAcknowledgement.merge(typed, sent, ack, now)
        assertEquals("Typed later", merged.body)
        assertEquals("accepted", merged.baseUpdated)
        assertEquals("accepted-edit", merged.baseEditRevision)
        assertEquals(SyncState.PENDING, merged.syncState)
    }
    @Test fun providerOnlyPullDoesNotInvalidateAnOpenPhoneEditor() {
        val local = JournalDraft("2026-09-10", body = "Words", baseEditRevision = "same-content",
            modifiedAt = "local-open", numbers = mapOf("sleep" to 5.0), syncState = SyncState.SYNCED)
        val imported = local.copy(numbers = mapOf("sleep" to 8.0), baseUpdated = "new-provider-time", modifiedAt = "new-local-time")
        assertEquals("local-open", JournalRevision.afterRemotePull(local, imported, now))
        assertEquals(now.toString(), JournalRevision.afterRemotePull(local,
            imported.copy(body = "Mac changed words", baseEditRevision = "new-content"), now))
    }
    @Test fun changedPullUsesThePhoneRevisionSequenceEvenAfterClockRollback() {
        val previous = now.plusSeconds(86400).toString()
        val local = JournalDraft("2026-09-10", body = "Words", baseEditRevision = "before", modifiedAt = previous)
        val remote = local.copy(body = "Changed", baseEditRevision = "after", modifiedAt = now.minusSeconds(100).toString())
        assertTrue(Instant.parse(JournalRevision.afterRemotePull(local, remote, now)).isAfter(Instant.parse(previous)))
    }
    @Test fun legacyIdenticalPullCanUpgradeRevisionWithoutInvalidatingEditor() {
        val local = JournalDraft("2026-09-10", body = "Words", modifiedAt = "local-open")
        assertEquals("local-open", JournalRevision.afterRemotePull(local,
            local.copy(baseEditRevision = "server-content", modifiedAt = "new-local-time"), now))
    }
}
