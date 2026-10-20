package com.todopup.usage

import android.content.Context

/**
 * Thin wrapper over SharedPreferences holding the setup config (endpoint URL +
 * bearer token) and the last-push status line. All values are plain strings so
 * the Activity, the Worker, and the deep-link handler share one source of truth.
 */
object Config {
    private const val PREFS = "todopup_usage"
    private const val KEY_ENDPOINT = "endpoint"
    private const val KEY_TOKEN = "token"
    private const val KEY_LAST_STATUS = "last_status"
    private const val KEY_LAST_PUSH = "last_push"
    private const val KEY_COLLECTION_STATUS = "collection_status"

    private fun prefs(ctx: Context) =
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun getEndpoint(ctx: Context): String =
        prefs(ctx).getString(KEY_ENDPOINT, "") ?: ""

    fun getToken(ctx: Context): String =
        prefs(ctx).getString(KEY_TOKEN, "") ?: ""

    fun save(ctx: Context, endpoint: String, token: String) {
        val normalized = MobileEndpoint.requireAllowed(endpoint)
        prefs(ctx).edit()
            .putString(KEY_ENDPOINT, normalized)
            .putString(KEY_TOKEN, token.trim())
            .apply()
    }

    fun isConfigured(ctx: Context): Boolean = getToken(ctx).isNotBlank() &&
        runCatching { MobileEndpoint.requireAllowed(getEndpoint(ctx)) }.isSuccess

    /** Last-push status line shown on the setup screen. */
    fun getStatus(ctx: Context): String =
        prefs(ctx).getString(KEY_LAST_STATUS, "No pushes yet.") ?: "No pushes yet."

    fun getLastPush(ctx: Context): String =
        prefs(ctx).getString(KEY_LAST_PUSH, "") ?: ""

    fun getCollectionStatus(ctx: Context): String =
        prefs(ctx).getString(KEY_COLLECTION_STATUS, "Daily usage collection is starting") ?: ""

    fun setCollectionStatus(ctx: Context, status: String) =
        prefs(ctx).edit().putString(KEY_COLLECTION_STATUS, status).apply()

    fun setStatus(ctx: Context, status: String, lastPushIso: String? = null) {
        val e = prefs(ctx).edit().putString(KEY_LAST_STATUS, status)
        if (lastPushIso != null) e.putString(KEY_LAST_PUSH, lastPushIso)
        e.apply()
    }

    /** Observe only usage feedback; the visible screen owns the listener lifetime. */
    fun observeStatus(ctx: Context, changed: () -> Unit): AutoCloseable {
        val store = prefs(ctx)
        val listener = android.content.SharedPreferences.OnSharedPreferenceChangeListener { _, key ->
            if (key == KEY_LAST_STATUS || key == KEY_LAST_PUSH || key == KEY_COLLECTION_STATUS) changed()
        }
        store.registerOnSharedPreferenceChangeListener(listener)
        return AutoCloseable { store.unregisterOnSharedPreferenceChangeListener(listener) }
    }
}
