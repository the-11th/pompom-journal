package com.todopup.usage

data class CurrentMapLocation(
    val latitude: Double,
    val longitude: Double,
    val accuracyMeters: Double,
    val observedAtMillis: Long,
    val elapsedNanos: Long,
)

/** Freshness is checked against both clocks; approximate locations keep their uncertainty. */
object CurrentLocationPolicy {
    const val MAX_AGE_MILLIS = 30_000L
    const val TIMEOUT_MILLIS = 12_000L
    fun isFresh(fix: CurrentMapLocation, nowMillis: Long, elapsedNanos: Long): Boolean =
        fix.latitude.isFinite() && fix.latitude in -90.0..90.0 &&
            fix.longitude.isFinite() && fix.longitude in -180.0..180.0 &&
            fix.accuracyMeters.isFinite() && fix.accuracyMeters >= 0 &&
            fix.elapsedNanos > 0 && fix.elapsedNanos <= elapsedNanos &&
            elapsedNanos - fix.elapsedNanos <= MAX_AGE_MILLIS * 1_000_000 &&
            fix.observedAtMillis in (nowMillis - MAX_AGE_MILLIS)..(nowMillis + 5_000)
}
