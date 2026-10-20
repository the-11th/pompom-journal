package com.todopup.usage
import org.json.JSONObject
import java.time.OffsetDateTime

/** Conservative stop estimates matching places.visits on the Mac. */
object VisitTimeline {
    data class Observation(val id: String, val time: Long, val session: String, val lat: Double, val lon: Double, val accuracy: Double, val at: String,
        val speed: Double = 0.0, val speedAccuracy: Double = 0.0)
    data class Place(val id: String?, val name: String, val lat: Double, val lon: Double, val radius: Double, val city: Boolean = false, val cityId: String? = null)
    data class Visit(val place: Place, val first: Observation, val last: Observation, val departureBefore: String? = null) { val duration get() = last.time - first.time }
    fun aggregate(samples: List<Observation>, places: List<Place>): List<Visit> {
        val visits = mutableListOf<Visit>(); var first: Observation? = null; var last: Observation? = null; var place: Place? = null
        fun flush(before: String? = null) {
            if (first != null && last != null && last!!.time - first!!.time >= 600)
                visits.add(Visit(place!!, first!!, last!!, before))
            first = null; last = null; place = null
        }
        for (s in samples.sortedBy { it.time }) {
            if (!s.accuracy.isFinite() || s.accuracy !in 0.0..100.0 || !s.lat.isFinite() || s.lat !in -90.0..90.0 || !s.lon.isFinite() || s.lon !in -180.0..180.0) { flush(); continue }
            if (last?.let { s.time - it.time > 600 || s.session != it.session } == true) flush()
            if (s.speed >= .5 && s.speedAccuracy <= maxOf(1.0, s.speed * .5)) { flush(s.at); continue }
            val match = places.filter { !it.city && s.accuracy <= it.radius && OutingPolicy.distance(s.lat, s.lon, it.lat, it.lon) <= it.radius }.minByOrNull { it.radius }
            if (first != null) {
                val stays = if (place!!.id != null) match?.id == place!!.id
                    else match == null && OutingPolicy.distance(first!!.lat, first!!.lon, s.lat, s.lon) <= 100
                if (!stays) flush(s.at)
            }
            if (first == null) {
                first = s
                val city = places.filter { it.city && s.accuracy <= it.radius && OutingPolicy.distance(s.lat, s.lon, it.lat, it.lon) <= it.radius }.minByOrNull { it.radius }
                place = match ?: Place(null, "Unsaved place" + (city?.let { " · ${it.name}" } ?: ""), s.lat, s.lon, 100.0, cityId = city?.id)
            }
            last = s
        }
        flush(); return visits
    }
    fun visits(samples: List<JSONObject>, places: List<JSONObject>): List<JSONObject> {
        val observations = samples.mapNotNull { s -> runCatching { Observation(s.getString("id"), OffsetDateTime.parse(s.getString("at")).toEpochSecond(), s.optString("session"), s.getDouble("lat"), s.getDouble("lon"), s.optDouble("accuracy_m", 1000.0), s.getString("at"),
            s.optDouble("speed_mps", 0.0), s.optDouble("speed_accuracy_mps", 0.0)) }.getOrNull() }
        val saved = places.filter { !it.optBoolean("archived") }.mapNotNull { p -> runCatching { Place(p.getString("id"), p.getString("name"), p.getDouble("lat"), p.getDouble("lon"), p.optDouble("radius_m", 100.0), p.optBoolean("is_city")) }.getOrNull() }
        return aggregate(observations, saved).map { v -> JSONObject().put("id", v.first.id).put("place_id", v.place.id ?: JSONObject.NULL).put("name", v.place.name)
            .put("city_id", v.place.cityId ?: JSONObject.NULL).put("arrival", v.first.at).put("departure_after", v.last.at).put("departure_before", v.departureBefore ?: JSONObject.NULL)
            .put("duration_seconds", v.duration).put("estimated", true).put("lat", v.place.lat).put("lon", v.place.lon) }
    }
}
