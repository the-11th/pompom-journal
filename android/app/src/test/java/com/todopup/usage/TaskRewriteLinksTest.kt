package com.todopup.usage

import org.junit.Assert.*
import org.junit.Test

class TaskRewriteLinksTest {
    @Test fun keepsNewPhotoLinkAfterAcknowledgedTaskMarkerAndEmoji() {
        val before = "[] call Alex\n😀 this memory"
        val after = "[task:abcd] call Alex\n😀 this memory"
        val start = before.codePointCount(0, before.indexOf("this"))
        val link = PhotoTextRange(start, start + 11)
        val shifted = TaskRewriteLinks.rebase(before, after, listOf(link))!!
        assertEquals(listOf(PhotoTextRange(start + 9, start + 20)), shifted)
    }

    @Test fun multipleTaskLinesShiftEachLinkOnlyByEarlierMarkers() {
        val before = "[] A\n[] B\nC"
        val after = "[task:aa] A\n[task:bbbb] B\nC"
        assertEquals(listOf(PhotoTextRange(10, 11), PhotoTextRange(24, 25), PhotoTextRange(26, 27)),
            TaskRewriteLinks.rebase(before, after, listOf(PhotoTextRange(3, 4), PhotoTextRange(8, 9), PhotoTextRange(10, 11))))
    }

    @Test fun unsupportedTextChangeRequiresReview() {
        assertNull(TaskRewriteLinks.rebase("[] Call Alex", "[task:aa] Call someone else", emptyList()))
        assertNull(TaskRewriteLinks.rebase("One line", "Two\nlines", emptyList()))
    }

    @Test fun passageThatIncludesTheCommandKeepsItsPhotoAssignment() {
        assertEquals(listOf(PhotoTextRange(0, 18)), TaskRewriteLinks.rebase(
            "[] Call Alex", "[task:aa] Call Alex", listOf(PhotoTextRange(0, 11))))
    }
}
