package com.todopup.usage

import org.junit.Assert.*
import org.junit.Test

class OutingPolicyTest {
    @Test fun departureStartsDetailAndFiveMinutesSettlesVisit() {
        val p = OutingPolicy()
        assertEquals("visits", p.update(0, 31.2, 121.5, 10.0).mode)
        assertEquals("detailed", p.update(60_000, 31.2, 121.51, 10.0).mode)
        p.update(120_000, 31.2, 121.51, 10.0)
        assertEquals("visits", p.update(360_000, 31.2, 121.51, 10.0).mode)
    }

    @Test fun PoorAccuracyDoesNotStartAnOuting() {
        val p = OutingPolicy()
        p.update(0, 31.2, 121.5, 10.0)
        assertEquals("visits", p.update(60_000, 32.0, 122.0, 5000.0).mode)
    }
}
