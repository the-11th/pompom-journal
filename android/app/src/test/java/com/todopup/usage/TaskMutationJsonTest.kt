package com.todopup.usage

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TaskMutationJsonTest {
    @Test
    fun `json null fields remain nullable`() {
        assertNull(TaskMutationJson.nullableString(true, "null"))
        assertNull(TaskMutationJson.nullableString(false, ""))
    }

    @Test
    fun `real permanent errors remain strings`() {
        assertEquals("Rejected", TaskMutationJson.nullableString(false, "Rejected"))
    }
}
