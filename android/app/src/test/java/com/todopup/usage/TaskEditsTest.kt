package com.todopup.usage

import org.junit.Assert.*
import org.junit.Test

class TaskEditsTest {
    @Test fun `notes edit includes only notes and preserves unrelated Mac title`() {
        val before = MobileTask("task", "Before", notes = "Old notes")
        val phone = before.copy(notes = "Phone notes")
        val fields = TaskEdits.changedFields(before, phone)
        assertEquals(listOf("notes"), fields)
        val merged = TaskEdits.overlay(before.copy(title = "Mac title"), phone, fields)
        assertEquals("Mac title", merged.title)
        assertEquals("Phone notes", merged.notes)
    }

    @Test fun `completion updates status while notes leave it unchanged`() {
        val before = MobileTask("task", "Before")
        val completed = before.copy(done = true, status = "completed")
        assertEquals(listOf("done"), TaskEdits.changedFields(before, completed))
        assertEquals("completed", TaskEdits.overlay(before, completed, listOf("done")).status)
        assertEquals("completed", TaskEdits.overlay(completed, before.copy(notes = "Edit"), listOf("notes")).status)
    }

    @Test fun `cleared due date is an explicit changed field`() {
        val before = MobileTask("task", "Before", due = "2026-09-10T11:15")
        val phone = before.copy(due = null)
        assertEquals(listOf("due"), TaskEdits.changedFields(before, phone))
        assertNull(TaskEdits.overlay(before, phone, listOf("due")).due)
    }
}
