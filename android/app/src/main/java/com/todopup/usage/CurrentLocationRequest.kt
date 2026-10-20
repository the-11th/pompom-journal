package com.todopup.usage

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.time.Instant

/** A foreground map lookup, bounded to 12 seconds. It neither stores samples nor starts tracking. */
class CurrentLocationRequest(private val context: Context) : LocationListener {
    private val manager = context.getSystemService(LocationManager::class.java)
    private val handler = Handler(Looper.getMainLooper())
    private val waiting = mutableListOf<(JSONObject) -> Unit>()
    private val timeout = Runnable { finish(unavailable("timeout", "A fresh location was not available. Try again outdoors or near a window.")) }

    @SuppressLint("MissingPermission") // Both foreground permissions are checked immediately below.
    fun request(callback: (JSONObject) -> Unit) {
        check(Looper.myLooper() == Looper.getMainLooper())
        if (!hasPermission(context)) { callback(permissionRequired()); return }
        waiting.add(callback)
        if (waiting.size > 1) return
        val providers = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
            .filter { runCatching { manager.isProviderEnabled(it) }.getOrDefault(false) }
        if (providers.isEmpty()) { finish(unavailable("unavailable", "Phone location is switched off or no location provider is available.")); return }
        val cached = providers.mapNotNull { runCatching { manager.getLastKnownLocation(it) }.getOrNull() }
            .filter(::isFresh).minByOrNull { it.accuracy }
        if (cached != null) { finish(position(cached)); return }
        handler.postDelayed(timeout, CurrentLocationPolicy.TIMEOUT_MILLIS)
        val subscriptions = providers.count { provider ->
            runCatching { manager.requestLocationUpdates(provider, 0L, 0f, this, Looper.getMainLooper()) }.isSuccess
        }
        if (subscriptions == 0) finish(unavailable("unavailable", "The phone could not request a location. Check location access in Android settings."))
    }

    fun cancel() { if (waiting.isNotEmpty()) finish(unavailable("unavailable", "Location lookup stopped because the map was closed.")) }

    override fun onLocationChanged(location: Location) { if (waiting.isNotEmpty() && isFresh(location)) finish(position(location)) }
    override fun onProviderDisabled(provider: String) {
        if (listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER).none { runCatching { manager.isProviderEnabled(it) }.getOrDefault(false) })
            finish(unavailable("unavailable", "Phone location is switched off."))
    }
    override fun onProviderEnabled(provider: String) {}
    @Deprecated("Legacy Android callback") override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}

    private fun isFresh(location: Location): Boolean = location.hasAccuracy() && CurrentLocationPolicy.isFresh(
        CurrentMapLocation(location.latitude, location.longitude, location.accuracy.toDouble(), location.time, location.elapsedRealtimeNanos),
        System.currentTimeMillis(), SystemClock.elapsedRealtimeNanos())

    private fun position(location: Location) = JSONObject().put("status", "ok").put("location", JSONObject()
        .put("lat", location.latitude).put("lon", location.longitude).put("accuracy_m", location.accuracy.toDouble())
        .put("observed_at", Instant.ofEpochMilli(location.time).toString()))

    private fun finish(result: JSONObject) {
        handler.removeCallbacks(timeout)
        runCatching { manager.removeUpdates(this) }
        val callbacks = waiting.toList(); waiting.clear()
        callbacks.forEach { it(result) }
    }

    companion object {
        fun hasPermission(context: Context) = listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
            .any { ContextCompat.checkSelfPermission(context, it) == PackageManager.PERMISSION_GRANTED }
        fun permissionRequired() = unavailable("permission_required", "Allow location access to show your position on this map.")
        fun unavailable(status: String, message: String) = JSONObject().put("status", status).put("message", message)
    }
}
