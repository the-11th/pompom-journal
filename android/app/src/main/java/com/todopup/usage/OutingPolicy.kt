package com.todopup.usage

import kotlin.math.*

/** Pure movement policy. Accuracy noise cannot start an outing or settle a visit. */
class OutingPolicy {
    data class Decision(val mode: String, val departed: Boolean = false)
    private var anchorLat: Double? = null
    private var anchorLon = 0.0
    private var stationarySince = 0L
    private var mode = "visits"
    fun update(now: Long, lat: Double, lon: Double, accuracy: Double): Decision {
        if (!accuracy.isFinite() || accuracy > 100 || accuracy < 0) return Decision(mode)
        if (anchorLat == null) { anchorLat = lat; anchorLon = lon; stationarySince = now; return Decision(mode) }
        val distance = distance(anchorLat!!, anchorLon, lat, lon)
        if (distance > max(100.0, accuracy * 2)) {
            val departed = mode != "detailed"
            anchorLat = lat; anchorLon = lon; stationarySince = now; mode = "detailed"
            return Decision(mode, departed)
        }
        if (now - stationarySince >= 300_000) mode = "visits"
        return Decision(mode)
    }
    companion object {
        fun distance(a: Double, b: Double, c: Double, d: Double): Double {
            val p = Math.toRadians(c - a); val q = Math.toRadians(d - b)
            val h = sin(p / 2).pow(2) + cos(Math.toRadians(a)) * cos(Math.toRadians(c)) * sin(q / 2).pow(2)
            return 6371008.8 * 2 * asin(sqrt(h.coerceIn(0.0, 1.0)))
        }
    }
}
