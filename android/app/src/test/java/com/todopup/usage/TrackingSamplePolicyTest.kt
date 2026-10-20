package com.todopup.usage

import org.junit.Assert.*
import org.junit.Test

class TrackingSamplePolicyTest {
    private fun fix(at: Long, accuracy: Double = 10.0, latitude: Double = 31.2) =
        TrackingSamplePolicy.Fix(at, latitude, 121.5, accuracy)

    @Test fun `precise fixes continue every five seconds even when stationary`() {
        val policy = TrackingSamplePolicy()
        for (at in 100_000L..1_000_000L step 5_000) assertTrue(policy.accept(fix(at), at))
    }

    @Test fun `coarse fixes and duplicates cannot suppress the next GPS fix`() {
        val policy = TrackingSamplePolicy()
        assertTrue(policy.accept(fix(100_000, 500.0), 100_000))
        assertTrue(policy.accept(fix(100_010), 100_010))
        assertFalse(policy.accept(fix(100_010), 100_010))
        assertFalse(policy.accept(fix(101_000), 101_000))
        assertTrue(policy.accept(fix(105_010), 105_010))
    }

    @Test fun `an improved GPS fix is kept when network arrived in the same window`() {
        val policy = TrackingSamplePolicy()
        assertTrue(policy.accept(fix(100_000, 80.0), 100_000))
        assertTrue(policy.accept(fix(100_200, 8.0), 100_200))
    }

    @Test fun `invalid future stale and reordered fixes do not advance the recording clock`() {
        val policy = TrackingSamplePolicy()
        for (sample in listOf(fix(0), fix(200_001), fix(79_999), fix(200_000, -1.0),
            fix(200_000, Double.NaN), fix(200_000, latitude = 91.0)))
            assertFalse(policy.accept(sample, 200_000))
        assertTrue(policy.accept(fix(200_000), 200_000))
        assertFalse(policy.accept(fix(199_000), 205_000))
        assertTrue(policy.accept(fix(205_000), 205_000))
    }

    @Test fun `sustained uncertainty is recorded without flooding daily history`() {
        val policy = TrackingSamplePolicy()
        assertTrue(policy.accept(fix(100_000), 100_000))
        assertFalse(policy.accept(fix(110_000, 500.0), 110_000))
        assertTrue(policy.accept(fix(190_000, 500.0), 190_000))
        assertFalse(policy.accept(fix(195_000, 500.0), 195_000))
        assertTrue(policy.accept(fix(250_000, 500.0), 250_000))
    }

    @Test fun `speed metadata retains high speed rail and rejects invalid values`() {
        assertEquals(83.3, TrackingSamplePolicy.speed(83.3)!!, .001)
        for (value in listOf(-1.0, Double.NaN, Double.POSITIVE_INFINITY, 401.0))
            assertNull(TrackingSamplePolicy.speed(value))
        assertNull(TrackingSamplePolicy.bearing(360.0))
        assertEquals(359.0, TrackingSamplePolicy.bearing(359.0)!!, .001)
        assertNull(TrackingSamplePolicy.speedAccuracy(-1.0))
    }
}
