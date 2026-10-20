package com.todopup.usage
import org.junit.Assert.*
import org.junit.Test
class VisitTimelineTest {
    @Test fun visitsRequireTenMinutesAndNeverBridgeMissingSamples() {
        val observations = listOf(0L, 300L, 600L, 1500L, 1560L).map { VisitTimeline.Observation("$it", it, "s", 31.2, 121.5, 10.0, "$it") }
        val places = listOf(VisitTimeline.Place("home", "Home", 31.2, 121.5, 100.0))
        val result = VisitTimeline.aggregate(observations, places)
        assertEquals(1, result.size)
        assertEquals(600L, result[0].duration)
    }
    @Test fun unknownStopsDoNotRequireNamedPlaces() {
        val samples = listOf(0L, 120L, 600L).map { VisitTimeline.Observation("$it", it, "s", 31.2, 121.5, 10.0, "$it") }
        val result = VisitTimeline.aggregate(samples, emptyList())
        assertEquals(1, result.size); assertNull(result.single().place.id)
    }
    @Test fun walkingCannotBecomeAStationaryVisitInsideACity() {
        val samples = (0..10).map { VisitTimeline.Observation("$it", it * 60L, "s", 31.2, 121.5 + it * .001, 10.0, "$it") }
        assertTrue(VisitTimeline.aggregate(samples, listOf(VisitTimeline.Place("sh", "Shanghai", 31.2, 121.5, 50000.0, true))).isEmpty())
    }
    @Test fun badFixAndSessionChangeSplitUnknownStops() {
        val samples = listOf(
            VisitTimeline.Observation("a", 0, "s", 31.2, 121.5, 10.0, "0"),
            VisitTimeline.Observation("b", 150, "s", 31.2, 121.5, 200.0, "150"),
            VisitTimeline.Observation("c", 300, "s", 31.2, 121.5, 10.0, "300"),
            VisitTimeline.Observation("d", 450, "new", 31.2, 121.5, 10.0, "450"))
        assertTrue(VisitTimeline.aggregate(samples, emptyList()).isEmpty())
    }

    @Test fun shortStopsAndInvalidCoordinatesCannotBecomeVisits() {
        val samples = listOf(0L, 300L, 599L).map { VisitTimeline.Observation("$it", it, "s", 31.2, 121.5, 10.0, "$it") }
        assertTrue(VisitTimeline.aggregate(samples, emptyList()).isEmpty())
        assertTrue(VisitTimeline.aggregate(samples + samples.last().copy(time = 600, lat = 91.0), emptyList()).isEmpty())
    }

    @Test fun measuredMovementCannotBecomeAStayInsideAWideSavedPlace() {
        val samples = (0..12).map { VisitTimeline.Observation("$it", it * 60L, "s", 31.2, 121.5, 10.0, "$it", 4.0, .5) }
        val place = listOf(VisitTimeline.Place("park", "Park", 31.2, 121.5, 1000.0))
        assertTrue(VisitTimeline.aggregate(samples, place).isEmpty())
        assertEquals(1, VisitTimeline.aggregate(samples.map { it.copy(speedAccuracy = 10.0) }, place).size)
    }

}
