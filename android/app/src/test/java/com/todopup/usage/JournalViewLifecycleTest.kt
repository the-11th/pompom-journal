package com.todopup.usage

import org.junit.Assert.*
import org.junit.Test

class JournalViewLifecycleTest {
    @Test fun finalSaveReceivesItsReplyBeforeReleasingTheView() {
        val view = JournalViewLifecycle()
        assertTrue(view.beginClose())
        var saveResolved = false
        if (view.acceptsReplies) saveResolved = true
        assertTrue("A dirty save must resolve while navigation is closing the view", saveResolved)
        assertFalse(view.released)
        assertTrue(view.beginRelease())
        assertFalse(view.acceptsReplies)
    }

    @Test fun repeatedCloseAndLateCallbacksCannotReleaseTwice() {
        val view = JournalViewLifecycle()
        assertTrue(view.beginClose())
        assertFalse(view.beginClose())
        assertTrue(view.beginRelease())
        assertFalse(view.beginRelease())
        assertFalse(view.beginClose())
        assertFalse(view.acceptsReplies)
    }

    @Test fun onlyOneThreadClaimsCleanup() {
        val view = JournalViewLifecycle()
        val claimed = java.util.concurrent.atomic.AtomicInteger()
        val threads = List(20) { Thread { if (view.beginRelease()) claimed.incrementAndGet() } }
        threads.forEach(Thread::start); threads.forEach(Thread::join)
        assertEquals(1, claimed.get())
    }
}
