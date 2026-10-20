package com.todopup.usage

/** Monotonic sampling gate. Network uncertainty never delays a better GPS fix. */
class TrackingSamplePolicy {
    data class Fix(val elapsedMillis: Long, val latitude: Double, val longitude: Double, val accuracy: Double)
    private var lastGoodAt: Long? = null
    private var lastGoodFixAt: Long? = null
    private var lastAccuracy = Double.POSITIVE_INFINITY
    private var lastPoorAt: Long? = null

    fun accept(fix: Fix, now: Long): Boolean {
        if (fix.elapsedMillis <= 0 || now - fix.elapsedMillis !in 0L..120_000L ||
            !fix.latitude.isFinite() || fix.latitude !in -90.0..90.0 ||
            !fix.longitude.isFinite() || fix.longitude !in -180.0..180.0 ||
            !fix.accuracy.isFinite() || fix.accuracy < 0) return false
        if (lastGoodFixAt?.let { fix.elapsedMillis <= it } == true) return false
        if (fix.accuracy > 100) {
            if (lastGoodAt?.let { now - it < 90_000 } == true ||
                lastPoorAt?.let { now - it < 60_000 } == true) return false
            lastPoorAt = now
            return true
        }
        if (lastGoodAt?.let { now - it < MIN_RECORD_INTERVAL_MILLIS } == true && fix.accuracy >= lastAccuracy / 2) return false
        lastGoodAt = now; lastGoodFixAt = fix.elapsedMillis; lastAccuracy = fix.accuracy
        return true
    }

    companion object {
        const val REQUEST_INTERVAL_MILLIS = 5_000L
        private const val MIN_RECORD_INTERVAL_MILLIS = 4_000L
        fun speed(value: Double): Double? = value.takeIf { it.isFinite() && it in 0.0..400.0 }
        fun speedAccuracy(value: Double): Double? = value.takeIf { it.isFinite() && it >= 0 }
        fun bearing(value: Double): Double? = value.takeIf { it.isFinite() && it >= 0 && it < 360 }
    }
}
