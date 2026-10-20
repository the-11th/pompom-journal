package com.todopup.usage

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CurrentLocationPolicyTest {
    private val now = 1_800_000_000_000L
    private val elapsed = 600_000_000_000L
    private val fix = CurrentMapLocation(31.23, 121.47, 12.0, now - 2_000, elapsed - 2_000_000_000)

    @Test fun `fresh precise and approximate observations are usable`() {
        assertTrue(CurrentLocationPolicy.isFresh(fix, now, elapsed))
        assertTrue(CurrentLocationPolicy.isFresh(fix.copy(accuracyMeters = 5000.0), now, elapsed))
    }

    @Test fun `old monotonic observations cannot be called current even with a fresh wall clock`() {
        assertFalse(CurrentLocationPolicy.isFresh(fix.copy(elapsedNanos = elapsed - 30_000_000_001), now, elapsed))
        assertTrue(CurrentLocationPolicy.isFresh(fix.copy(elapsedNanos = elapsed - 30_000_000_000), now, elapsed))
    }

    @Test fun `timestamps from another boot or implausible wall clock are rejected`() {
        assertFalse(CurrentLocationPolicy.isFresh(fix.copy(elapsedNanos = 0), now, elapsed))
        assertFalse(CurrentLocationPolicy.isFresh(fix.copy(elapsedNanos = elapsed + 1), now, elapsed))
        assertFalse(CurrentLocationPolicy.isFresh(fix.copy(observedAtMillis = now - 30_001), now, elapsed))
        assertFalse(CurrentLocationPolicy.isFresh(fix.copy(observedAtMillis = now + 5_001), now, elapsed))
    }

    @Test fun `invalid coordinates and uncertainty cannot become a map marker`() {
        for (bad in listOf(fix.copy(latitude = Double.NaN), fix.copy(latitude = 91.0),
            fix.copy(longitude = -181.0), fix.copy(accuracyMeters = Double.POSITIVE_INFINITY),
            fix.copy(accuracyMeters = -1.0)))
            assertFalse(CurrentLocationPolicy.isFresh(bad, now, elapsed))
    }
}
