package com.todopup.usage

import org.junit.Assert.*
import org.junit.Test

class TaskReferenceIndexTest {
    @Test fun linkedTasksReflectLocalActiveCompletedExpiredAndMissingRecords() {
        val tasks = listOf(
            MobileTask("aa", "Active"), MobileTask("bb", "Complete", done = true),
            MobileTask("cc", "Expired", status = "expired"), MobileTask("ee", "Unlinked"),
        )
        val index = TaskReferenceIndex.build(tasks, "[task:aa] first\n[task:bb] second\n[task:cc] old\n[task:dd] gone")
        assertEquals(setOf("aa", "bb", "cc", "dd"), index.keys)
        assertEquals(TaskReference("Active", false, "active"), index["aa"])
        assertEquals(TaskReference("Complete", true, "done"), index["bb"])
        assertEquals(TaskReference("Expired", false, "expired"), index["cc"])
        assertEquals(TaskReference("", false, "missing"), index["dd"])
    }
    @Test fun localQueuedCompletionAndDuplicateReferencesUseOneCurrentRecord() {
        val task = MobileTask("aa", "Task", done = true, status = "completed")
        val index = TaskReferenceIndex.build(listOf(task), "[task:aa] one\n[task:aa] again\n[] new task")
        assertEquals(1, index.size)
        assertEquals("done", index["aa"]?.status)
    }
    @Test fun emptyDraftAndMalformedTokensDoNotExposeUnrelatedTasks() {
        assertTrue(TaskReferenceIndex.build(listOf(MobileTask("aa", "Private")), "[task:not-hex] broken").isEmpty())
        assertTrue(TaskReferenceIndex.build(listOf(MobileTask("aa", "Private")), "").isEmpty())
    }
}
