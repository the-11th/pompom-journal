package com.todopup.usage

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MobileSyncPolicyTest {
    @Test
    fun `explicit sync promotes meaningful local drafts only`() {
        assertTrue(MobileSyncPolicy.shouldUploadOnExplicit(
            JournalDraft("2026-08-01", body = "Phone entry")))
        assertTrue(MobileSyncPolicy.shouldUploadOnExplicit(
            JournalDraft("2026-08-02", mood = 5)))
        assertFalse(MobileSyncPolicy.shouldUploadOnExplicit(JournalDraft("2026-08-03")))
        assertFalse(MobileSyncPolicy.shouldUploadOnExplicit(
            JournalDraft("2026-08-04", body = "Already queued", syncState = SyncState.PENDING)))
        assertTrue(MobileSyncPolicy.shouldUploadOnExplicit(
            JournalDraft("2026-08-05", body = "Previously rejected", syncState = SyncState.PERMANENT_FAILURE)))
    }

    @Test
    fun `calendar entries exclude empty autosave placeholders`() {
        assertFalse(MobileSyncPolicy.hasMeaningfulContent(JournalDraft("2026-08-01")))
        assertFalse(MobileSyncPolicy.hasMeaningfulContent(
            JournalDraft("2026-08-01", title = " 2026-08-01 ", body = " \n")))
        assertTrue(MobileSyncPolicy.hasMeaningfulContent(JournalDraft("2026-08-02", body = "A day")))
        assertTrue(MobileSyncPolicy.hasMeaningfulContent(JournalDraft("2026-08-03", mood = 4)))
    }

    @Test
    fun `empty new entries never upload but clearing a synced entry does`() {
        val empty = JournalDraft("2026-08-01", title = "2026-08-01")
        assertFalse(MobileSyncPolicy.shouldUpload(empty))
        assertFalse(MobileSyncPolicy.shouldUpload(empty.copy(syncState = SyncState.PENDING)))
        assertFalse(MobileSyncPolicy.shouldUploadOnExplicit(empty))
        assertTrue(MobileSyncPolicy.shouldUpload(empty.copy(baseUpdated = "version")))
        assertTrue(MobileSyncPolicy.shouldUploadOnExplicit(empty.copy(baseUpdated = "version")))
        assertTrue(MobileSyncPolicy.shouldUpload(empty.copy(numbers = mapOf("hours" to 0.0))))
    }

    @Test
    fun `remote entries only replace missing or previously synced copies`() {
        assertTrue(MobileSyncPolicy.shouldPullRemote(null))
        assertTrue(MobileSyncPolicy.shouldPullRemote(
            JournalDraft("2026-08-01", syncState = SyncState.SYNCED)))
        assertTrue(MobileSyncPolicy.shouldPullRemote(JournalDraft("2026-08-02")))
        assertFalse(MobileSyncPolicy.shouldPullRemote(
            JournalDraft("2026-08-03", body = "Local draft")))
        assertFalse(MobileSyncPolicy.shouldPullRemote(
            JournalDraft("2026-08-04", syncState = SyncState.CONFLICT)))
    }

    @Test
    fun `cleared existing draft is an edit and cannot be replaced by a remote pull`() {
        val cleared = JournalDraft("2026-09-10", baseUpdated = "mac-version")
        assertTrue(MobileSyncPolicy.shouldUpload(cleared))
        assertFalse(MobileSyncPolicy.shouldPullRemote(cleared))
    }

    @Test fun `sync revisits cleared entries without downloading every imported placeholder`() {
        val config = MobileJournalConfig(emptyList(), listOf("2026-09-08"),
            storedEntryDates = listOf("2026-09-08", "2026-09-09", "2026-09-10"))
        val local = listOf(JournalDraft("2026-09-09", body = "Earlier content", syncState = SyncState.SYNCED))
        assertEquals(listOf("2026-09-08", "2026-09-09"), MobileSyncPolicy.pullDates(config, local))
    }

    @Test
    fun `identical restored draft matches the existing Mac entry`() {
        val local = JournalDraft(
            "2026-08-01", title = "Same day", body = "Same text", mood = 6,
            tags = mapOf("health" to listOf("walk")), numbers = mapOf("weight" to 150.0),
            audioTranscript = "Same voice text",
        )
        val remote = local.copy(syncState = SyncState.SYNCED, baseUpdated = "server-version")

        assertTrue(MobileSyncPolicy.matchesRemote(local, remote))
        assertFalse(MobileSyncPolicy.matchesRemote(local, remote.copy(body = "Changed on Mac")))
    }

    @Test
    fun `sync report says exactly what moved and what remained`() {
        val report = MobileSyncReport(
            journalUploaded = 30,
            journalDownloaded = 2,
            journalRemoved = 1,
            phoneChangesUploaded = 3,
            tasksDownloaded = 8,
            journalConflicts = 1,
            phoneChangesRejected = 2,
        )

        assertEquals(
            "Synced: 30 phone entries → Mac; 2 Mac entries → phone; " +
                "1 deleted Mac entry removed from phone; 3 phone changes → Mac; " +
                "8 Mac tasks → phone.\nNot synced: 1 entry conflict; 2 rejected phone changes.",
            report.summary(),
        )
        assertTrue(report.hasUnresolved())
    }

    @Test
    fun `empty report confirms both sides already match`() {
        assertEquals(
            "Synced: phone and Mac already matched.\nNot synced: none.",
            MobileSyncReport().summary(),
        )
        assertFalse(MobileSyncReport().hasUnresolved())
    }
    @Test fun `failed pairing never claims the phone matched the Mac`() {
        assertEquals("Nothing synced.\nNot synced: Pairing expired. Run the USB helper again.",
            MobileSyncReport(errors = mutableListOf("Pairing expired. Run the USB helper again.")).summary())
    }
    @Test fun `one transferred file or map uses singular copy`() {
        assertEquals("Synced: 1 media file synced; 1 offline map pack downloaded to phone.\nNot synced: none.",
            MobileSyncReport(mediaFiles = 1, mapPacks = 1).summary())
        assertEquals("Synced: 2 media files synced; 2 offline map packs downloaded to phone.\nNot synced: none.",
            MobileSyncReport(mediaFiles = 2, mapPacks = 2).summary())
    }
    @Test fun `media conflict count reads naturally and remains unresolved`() {
        val one = MobileSyncReport(mediaConflicts = 1)
        assertEquals("Nothing synced.\nNot synced: 1 photo or place change needs review in Photos & places.", one.summary())
        assertTrue(one.hasUnresolved())
        assertEquals("Nothing synced.\nNot synced: 2 photo or place changes need review in Photos & places.",
            MobileSyncReport(mediaConflicts = 2).summary())
    }
    @Test fun `deferred work is not a successful match and errors keep one final punctuation mark`() {
        assertEquals("Nothing synced.\nNot synced: 1 unsaved local draft kept on phone.",
            MobileSyncReport(journalDeferred = 1).summary())
        assertEquals("Synced: 1 phone entry → Mac.\nNot synced: Mac unavailable!",
            MobileSyncReport(journalUploaded = 1, errors = mutableListOf("Mac unavailable!")).summary())
    }
    @Test fun `acknowledgement rebases a newer pending edit without replacing its content`() {
        val sent = JournalDraft("2026-09-08", body = "A", requestId = "sent", baseUpdated = "old")
        val newer = sent.copy(body = "AB", requestId = "new", syncState = SyncState.PENDING)
        val server = sent.copy(baseUpdated = "accepted", syncState = SyncState.SYNCED)
        val result = JournalAcknowledgement.merge(newer, sent, server)
        assertEquals("AB", result.body)
        assertEquals("accepted", result.baseUpdated)
        assertEquals("new", result.requestId)
        assertEquals(SyncState.PENDING, result.syncState)
    }
    @Test fun `acknowledgement preserves typing even when an older client reused its request id`() {
        val sent = JournalDraft("2026-09-10", body = "Saved", requestId = "same-id",
            baseUpdated = "old", syncState = SyncState.PENDING)
        val newer = sent.copy(body = "Saved and still typing", syncState = SyncState.DRAFT)
        val result = JournalAcknowledgement.merge(newer, sent,
            sent.copy(baseUpdated = "accepted", syncState = SyncState.SYNCED))
        assertEquals(newer.body, result.body)
        assertEquals("accepted", result.baseUpdated)
        assertEquals(SyncState.DRAFT, result.syncState)
    }
    @Test fun `stale acknowledgement cannot rebase an unrelated local revision`() {
        val sent = JournalDraft("2026-09-08", body = "A", requestId = "sent", baseUpdated = "old")
        val newer = sent.copy(body = "AB", requestId = "new", baseUpdated = "already-new")
        assertEquals(newer, JournalAcknowledgement.merge(newer, sent, sent.copy(baseUpdated = "accepted")))
    }
    @Test fun `photo and message only entries stay in calendar and upload`() {
        assertTrue(MobileSyncPolicy.hasMeaningfulContent(JournalDraft("2026-09-08", document = "[{\"type\": \"photo\", \"asset_id\": \"x\"}]")))
        assertTrue(MobileSyncPolicy.hasMeaningfulContent(JournalDraft("2026-09-08", document = "[{\"type\": \"message\"}]")))
        assertFalse(MobileSyncPolicy.hasMeaningfulContent(JournalDraft("2026-09-08", document = "[{\"type\": \"text\", \"text\": \"\"}]")))
    }

}
