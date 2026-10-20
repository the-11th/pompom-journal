package com.todopup.usage

import org.junit.Assert.*
import org.junit.Test

class TrackingStartupPolicyTest {
    @Test fun `permission alone does not enable location recording`() {
        assertFalse(TrackingStartupPolicy.shouldRecord(null, true))
    }
    @Test fun `a paused recorder stays paused across app launches`() {
        assertFalse(TrackingStartupPolicy.shouldRecord(false, true))
    }
    @Test fun `enabled recording resumes only with location permission`() {
        assertTrue(TrackingStartupPolicy.shouldRecord(true, true))
        for (choice in listOf(null, true, false)) assertFalse(TrackingStartupPolicy.shouldRecord(choice, false))
    }
}
