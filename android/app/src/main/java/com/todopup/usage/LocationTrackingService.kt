package com.todopup.usage

import android.Manifest
import android.app.*
import android.content.*
import android.content.pm.PackageManager
import android.location.*
import android.os.*
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.util.UUID

/** Foreground location collection stays on the phone until an authorized USB sync. */
class LocationTrackingService : Service(), LocationListener {
    private lateinit var manager: LocationManager
    private val policy = TrackingSamplePolicy()
    private val session = UUID.randomUUID().toString()
    private val io = java.util.concurrent.Executors.newSingleThreadExecutor()
    override fun onCreate() {
        super.onCreate(); manager = getSystemService(LocationManager::class.java)
        notifications(this)
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "pause") { preferences(this).edit().putBoolean("enabled", false).commit(); stopSelf(); return START_NOT_STICKY }
        if (!preferences(this).getBoolean("enabled", false) || ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) { stopSelf(); return START_NOT_STICKY }
        preferences(this).edit().remove("error").putString("mode", "precise").apply()
        try {
            startForeground(701, notification("Precise tracking · locations save automatically"))
        } catch (error: RuntimeException) {
            preferences(this).edit().putString("error", "Android paused background location · open Datapom to resume").apply()
            stopSelf(); return START_NOT_STICKY
        }
        subscribe()
        io.execute { runCatching { MediaStore(this).archiveTracking() }.onFailure {
            preferences(this).edit().putString("error", "Location history could not be archived: ${it.message}").apply()
        } }
        return START_STICKY
    }
    private fun subscribe() {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) return
        manager.removeUpdates(this)
        var subscribed = false
        for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
            if (manager.allProviders.contains(provider)) runCatching {
                manager.requestLocationUpdates(provider, TrackingSamplePolicy.REQUEST_INTERVAL_MILLIS, 0f, this, Looper.getMainLooper())
                subscribed = true
            }.onFailure {
                preferences(this).edit().putString("error", "Location access was interrupted · open Datapom to resume").apply()
            }
        }
        if (!subscribed || manager.getProviders(true).none { it == LocationManager.GPS_PROVIDER || it == LocationManager.NETWORK_PROVIDER })
            preferences(this).edit().putString("error", "Phone location is switched off · tracking will resume when it is available").apply()
    }
    override fun onLocationChanged(location: Location) {
        val now = SystemClock.elapsedRealtime()
        if (!preferences(this).getBoolean("enabled", false) || !location.hasAccuracy() || location.time <= 0 ||
            location.time > System.currentTimeMillis() + 5_000) return
        val fix = TrackingSamplePolicy.Fix(location.elapsedRealtimeNanos / 1_000_000,
            location.latitude, location.longitude, location.accuracy.toDouble())
        if (policy.accept(fix, now)) record(location)
    }
    private fun record(location: Location) {
        val sample = JSONObject().put("id", UUID.randomUUID().toString()).put("session", session)
            .put("at", Instant.ofEpochMilli(location.time).atZone(ZoneId.systemDefault()).toOffsetDateTime().toString())
            .put("lat", location.latitude).put("lon", location.longitude).put("accuracy_m", location.accuracy)
            .put("mode", "precise").put("source_device", "phone")
        if (location.hasSpeed()) TrackingSamplePolicy.speed(location.speed.toDouble())?.let { sample.put("speed_mps", it) }
        if (location.hasSpeedAccuracy()) TrackingSamplePolicy.speedAccuracy(location.speedAccuracyMetersPerSecond.toDouble())?.let { sample.put("speed_accuracy_mps", it) }
        if (location.hasBearing()) TrackingSamplePolicy.bearing(location.bearing.toDouble())?.let { sample.put("bearing", it) }
        location.provider?.takeIf { it.isNotBlank() }?.let { sample.put("provider", it.take(80)) }
        io.execute { runCatching {
            MediaStore(this).appendTrackingSample(sample)
            val edit = preferences(this).edit().putLong("last_sample_at", location.time)
            if (location.accuracy <= 100) edit.putLong("last_accurate_at", location.time).remove("error")
            edit.apply()
        }.onFailure {
            preferences(this).edit().putString("error", "Location could not be saved: ${it.message}").apply()
        } }
    }
    private fun notification(text: String): Notification {
        val open = PendingIntent.getActivity(this, 701, Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP).putExtra("media_settings", true), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val stop = PendingIntent.getService(this, 701, Intent(this, LocationTrackingService::class.java).setAction("pause"), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, CHANNEL).setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle("Datapom · location").setContentText(text).setContentIntent(open).setOngoing(true)
            .addAction(0, "Pause tracking", stop).setOnlyAlertOnce(true).build()
    }
    override fun onProviderEnabled(provider: String) { preferences(this).edit().remove("error").apply() }
    override fun onProviderDisabled(provider: String) {
        if (manager.getProviders(true).none { it == LocationManager.GPS_PROVIDER || it == LocationManager.NETWORK_PROVIDER })
            preferences(this).edit().putString("error", "Phone location is switched off · tracking will resume when it is available").apply()
    }
    @Deprecated("Legacy Android callback") override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
    override fun onDestroy() { manager.removeUpdates(this); io.shutdown(); super.onDestroy() }
    override fun onBind(intent: Intent?) = null
    companion object {
        const val CHANNEL = "todopup_location"
        const val ALERTS = "todopup_outings"
        fun preferences(context: Context) = context.getSharedPreferences("todopup_tracking", Context.MODE_PRIVATE)
        fun notifications(context: Context) {
            val manager = context.getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(NotificationChannel(CHANNEL, "Location tracking", NotificationManager.IMPORTANCE_LOW))
            manager.createNotificationChannel(NotificationChannel(ALERTS, "Outing reminders", NotificationManager.IMPORTANCE_DEFAULT))
        }
        fun start(context: Context) = ContextCompat.startForegroundService(context, Intent(context, LocationTrackingService::class.java))
        fun resumeIfEnabled(context: Context): Boolean {
            val prefs = preferences(context)
            val choice = if (prefs.contains("enabled")) prefs.getBoolean("enabled", false) else null
            val allowed = ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
            if (!TrackingStartupPolicy.shouldRecord(choice, allowed)) return false
            return runCatching { start(context); true }.getOrElse {
                preferences(context).edit().putString("error", "Android paused background location · open Datapom to resume").apply()
                false
            }
        }
    }
}

class TrackingBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (!LocationTrackingService.preferences(context).getBoolean("enabled", false)) return
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) return
        val background = Build.VERSION.SDK_INT < 29 || ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED
        if (background && LocationTrackingService.resumeIfEnabled(context)) return
        runCatching {
            LocationTrackingService.notifications(context)
            val pending = PendingIntent.getActivity(context, 703, Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP).putExtra("media_settings", true), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            context.getSystemService(NotificationManager::class.java).notify(703, NotificationCompat.Builder(context, LocationTrackingService.ALERTS)
                .setSmallIcon(android.R.drawable.ic_menu_mylocation).setContentTitle("Datapom · resume location")
                .setContentText("Tap to resume tracking after restarting your phone.").setContentIntent(pending).setAutoCancel(true).build())
        }
    }
}
