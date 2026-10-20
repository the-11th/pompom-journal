package com.todopup.usage

import android.app.Activity
import android.app.Instrumentation
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Android textZoom changes glyphs differently from desktop CSS font-size. */
internal object NativeWebLayoutChecks {
    fun run(instrumentation: Instrumentation, activity: Activity) {
        val css = instrumentation.targetContext.assets.open("journal/style.css").bufferedReader().use { it.readText() }
        for (zoom in listOf(130, 200)) {
            val ready = CountDownLatch(1)
            var metrics: String? = null
            lateinit var web: WebView
            try {
                instrumentation.runOnMainSync {
                    web = WebView(activity).apply {
                        settings.javaScriptEnabled = true
                        settings.textZoom = zoom
                        webViewClient = object : WebViewClient() {
                            override fun onPageFinished(view: WebView, url: String) {
                                evaluateJavascript("""
                                    (() => {
                                      const scale=document.querySelector('.map-scale'), range=document.createRange();
                                      range.selectNodeContents(scale);
                                      const box=scale.getBoundingClientRect(), text=range.getBoundingClientRect();
                                      const barHeight=parseFloat(getComputedStyle(scale,'::after').height);
                                      return {textBottom:text.bottom,barTop:box.bottom-barHeight,
                                        scaleBottom:box.bottom,noteTop:document.querySelector('.map-note').getBoundingClientRect().top};
                                    })()
                                """.trimIndent()) { value -> metrics = value; ready.countDown() }
                            }
                        }
                    }
                    activity.setContentView(web)
                    web.loadDataWithBaseURL("https://todopup.local/", """
                        <!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
                        <style>$css</style><body class="media-mobile"><main>
                        <div class="offline-map"><canvas></canvas><div class="map-scale" style="width:63px">500 m</div>
                        <div class="map-note">Offline · regional detail</div>
                        <div class="map-credit">© OpenStreetMap contributors · Protomaps</div></div></main></body>
                    """.trimIndent(), "text/html", "UTF-8", null)
                }
                check(ready.await(5, TimeUnit.SECONDS)) { "Mobile map layout did not load" }
                val result = JSONObject(requireNotNull(metrics))
                check(result.getDouble("textBottom") <= result.getDouble("barTop") + 0.5) {
                    "Map scale text crosses its bar at $zoom% Android text: $result"
                }
                check(result.getDouble("scaleBottom") <= result.getDouble("noteTop") + 0.5) {
                    "Map scale crosses the status note at $zoom% Android text: $result"
                }
            } finally {
                instrumentation.runOnMainSync { web.destroy() }
            }
        }
    }
}
