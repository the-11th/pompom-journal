package com.todopup.usage

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Journal/task API configuration. Kept separate from the legacy usage-push config. */
object MobileConfig {
    private const val PREFS = "todopup_mobile"
    private const val KEY_BASE_URL = "base_url"
    private const val KEY_DEVICE_NAME = "device_name"
    private const val KEY_TOKEN = "device_token_v1"
    private const val KEY_ALIAS = "todopup_mobile_token"

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun baseUrl(context: Context) = prefs(context).getString(KEY_BASE_URL, "") ?: ""
    fun deviceName(context: Context) = prefs(context).getString(KEY_DEVICE_NAME, "Android phone") ?: "Android phone"
    fun token(context: Context): String = prefs(context).getString(KEY_TOKEN, null)?.let(::decrypt) ?: ""
    fun isConfigured(context: Context) = baseUrl(context).isNotBlank() && token(context).isNotBlank()

    /** [baseUrl] is a private Tailscale Serve origin, e.g. https://mac.tailnet.ts.net. */
    fun save(context: Context, baseUrl: String, token: String, deviceName: String = "Android phone") {
        val normalized = baseUrl.trim().trimEnd('/')
        require(normalized.startsWith("https://")) { "TodoPup mobile sync requires an HTTPS URL" }
        prefs(context).edit()
            .putString(KEY_BASE_URL, normalized)
            .putString(KEY_DEVICE_NAME, deviceName.trim().ifBlank { "Android phone" })
            .putString(KEY_TOKEN, encrypt(token.trim()))
            .apply()
    }

    fun clear(context: Context) = prefs(context).edit().clear().apply()

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .build())
        return generator.generateKey()
    }

    private fun encrypt(value: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val bytes = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(cipher.iv + bytes, Base64.NO_WRAP)
    }

    private fun decrypt(value: String): String = try {
        val all = Base64.decode(value, Base64.NO_WRAP)
        val iv = all.copyOfRange(0, 12)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
        String(cipher.doFinal(all.copyOfRange(12, all.size)), Charsets.UTF_8)
    } catch (_: Exception) { "" }
}
