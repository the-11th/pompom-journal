package com.todopup.usage

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

/**
 * Single setup/status screen. UI is built programmatically (no layout XML) to
 * keep the app tiny. Handles the todopup://config deep link and enqueues the
 * periodic push worker on launch.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var endpointField: EditText
    private lateinit var tokenField: EditText
    private lateinit var statusLine: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildUi())

        // Apply an inbound config deep link (todopup://config?url=..&token=..).
        handleConfigDeepLink(intent)

        endpointField.setText(Config.getEndpoint(this))
        tokenField.setText(Config.getToken(this))
        refreshStatus()

        // Ensure the daily push is scheduled (idempotent: KEEP).
        schedulePeriodic()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleConfigDeepLink(intent)
        endpointField.setText(Config.getEndpoint(this))
        tokenField.setText(Config.getToken(this))
    }

    override fun onResume() {
        super.onResume()
        refreshStatus()
    }

    // ---- UI ------------------------------------------------------------- //

    private fun buildUi(): LinearLayout {
        val pad = (16 * resources.displayMetrics.density).toInt()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
            layoutParams = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT)
        }

        root.addView(label("Endpoint URL"))
        endpointField = EditText(this).apply {
            hint = "http://host:5001/integrations/phone/ingest"
            inputType = InputType.TYPE_TEXT_VARIATION_URI
        }
        root.addView(endpointField)

        root.addView(label("Token"))
        tokenField = EditText(this).apply {
            hint = "paste the generated token"
            inputType = InputType.TYPE_CLASS_TEXT
        }
        root.addView(tokenField)

        root.addView(button("Save config") { saveConfig() })
        root.addView(button("Grant Usage access") {
            startActivity(Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS))
        })
        root.addView(button("Exclude from battery optimization") {
            requestIgnoreBatteryOptimizations()
        })
        root.addView(button("Send test now") { sendTestNow() })

        statusLine = TextView(this).apply {
            val t = (12 * resources.displayMetrics.density).toInt()
            setPadding(0, t, 0, 0)
        }
        root.addView(statusLine)
        return root
    }

    private fun label(text: String) = TextView(this).apply {
        this.text = text
        val t = (10 * resources.displayMetrics.density).toInt()
        setPadding(0, t, 0, 0)
    }

    private fun button(text: String, onClick: () -> Unit) = Button(this).apply {
        this.text = text
        setOnClickListener { onClick() }
    }

    // ---- actions -------------------------------------------------------- //

    private fun saveConfig() {
        Config.save(this, endpointField.text.toString(), tokenField.text.toString())
        toast("Saved.")
        schedulePeriodic()
    }

    private fun sendTestNow() {
        saveConfig()
        if (!Config.isConfigured(this)) {
            toast("Set endpoint + token first.")
            return
        }
        val req = OneTimeWorkRequestBuilder<UsagePushWorker>()
            .setConstraints(networkConstraints())
            .build()
        WorkManager.getInstance(this).enqueue(req)
        toast("Test push enqueued.")
    }

    private fun schedulePeriodic() {
        val work = PeriodicWorkRequestBuilder<UsagePushWorker>(1, TimeUnit.DAYS)
            .setConstraints(networkConstraints())
            .build()
        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            "daily-usage-push", ExistingPeriodicWorkPolicy.KEEP, work)
    }

    private fun networkConstraints() = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .build()

    @Suppress("BatteryLife")
    private fun requestIgnoreBatteryOptimizations() {
        try {
            val intent = Intent(
                Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                Uri.parse("package:$packageName"))
            startActivity(intent)
        } catch (_: Exception) {
            // Fallback: open the general battery-optimization settings list.
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }
    }

    private fun handleConfigDeepLink(intent: Intent?) {
        val data: Uri = intent?.data ?: return
        if (data.scheme != "todopup" || data.host != "config") return
        val url = data.getQueryParameter("url")
        val token = data.getQueryParameter("token")
        if (!url.isNullOrBlank() && !token.isNullOrBlank()) {
            Config.save(this, url, token)
            toast("Config applied from QR.")
        }
    }

    private fun refreshStatus() {
        val last = Config.getLastPush(this)
        val suffix = if (last.isBlank()) "" else "\nLast push: $last"
        statusLine.text = Config.getStatus(this) + suffix
    }

    private fun toast(msg: String) =
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()
}
