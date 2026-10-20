package com.todopup.usage

import android.app.Instrumentation
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Handler
import android.os.Looper
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Real bundled location UI in a detached WebView; every response is a private fixture. */
object LocationUiSmoke {
    fun verify(instrumentation: Instrumentation): String {
        val day = "2026-09-08"
        fun sample(id: String, time: String, lat: Double, lon: Double, speed: Double = 0.0) =
            JSONObject().put("id", id).put("session", "location-ui-qa").put("at", "${day}T$time+08:00")
                .put("lat", lat).put("lon", lon).put("accuracy_m", 5.0).put("speed_mps", speed)
                .put("speed_accuracy_mps", .1).put("mode", "precise")
        val samples = JSONArray()
        for (minute in 0..30 step 5) samples.put(sample("home-$minute", "09:${minute.toString().padStart(2, '0')}:00", 31.23, 121.47))
        samples.put(sample("walk-one", "09:35:00", 31.24, 121.48, 4.8))
        samples.put(sample("walk-two", "09:40:00", 31.25, 121.49, 4.8))
        // The twenty-minute hole must never acquire an interpolated position.
        for (minute in 0..15 step 5) samples.put(sample("cafe-$minute", "10:${minute.toString().padStart(2, '0')}:00", 31.26, 121.50))
        val gps = JSONObject().put("id", "gps-photo").put("filename", "At home")
            .put("captured_at", "${day}T09:10:00+08:00")
            .put("location", JSONObject().put("lat", 31.23).put("lon", 121.47))
        val inferred = JSONObject().put("id", "route-photo").put("filename", "On the walk")
            .put("captured_at", "${day}T09:37:30+08:00").put("location", JSONObject.NULL)
        val state = JSONObject().put("assets", JSONObject().put("gps-photo", gps).put("route-photo", inferred))
            .put("groups", JSONObject()).put("messages", JSONObject()).put("places", JSONObject()
                .put("home", JSONObject().put("id", "home").put("name", "Home").put("lat", 31.23).put("lon", 121.47).put("radius_m", 80)))
        val blocks = JSONArray().put(JSONObject().put("id", "photo-one").put("type", "photo").put("asset_id", "gps-photo").put("caption", "At home"))
            .put(JSONObject().put("id", "photo-two").put("type", "photo").put("asset_id", "route-photo").put("caption", "On the walk"))
        val responses = mapOf(
            "/journal/media/state" to state.toString(),
            "/journal/media/maps" to "{\"packs\":[]}",
            "/journal/media/tracking" to JSONObject().put("samples", samples).toString(),
            "/journal/media/entry/$day" to JSONObject().put("entry", JSONObject().put("date", day).put("document", blocks)).toString()
        )
        val bitmap = Bitmap.createBitmap(12, 12, Bitmap.Config.ARGB_8888)
        bitmap.eraseColor(android.graphics.Color.rgb(224, 169, 85))
        val png = ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
        bitmap.recycle()
        val done = CountDownLatch(1)
        val result = AtomicReference<String>()
        val observation = AtomicReference<String>("No JavaScript response yet")
        val trace = CopyOnWriteArrayList<String>()
        val deadline = System.currentTimeMillis() + 25_000
        lateinit var web: WebView
        lateinit var surface: Bitmap
        instrumentation.runOnMainSync {
            web = WebView(instrumentation.targetContext)
            web.settings.javaScriptEnabled = true
            web.settings.allowFileAccess = false
            web.settings.allowContentAccess = false
            web.settings.useWideViewPort = true
            web.settings.offscreenPreRaster = true
            web.setLayerType(View.LAYER_TYPE_SOFTWARE, null)
            web.webChromeClient = object : WebChromeClient() {
                override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                    trace.add(message.message()); return true
                }
            }
            web.webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                    val uri = request.url
                    trace.add("request ${request.method} $uri")
                    if (uri.scheme != "https" || uri.host != "location.qa.test") return denied()
                    val path = uri.path.orEmpty()
                    if (request.method != "GET") return denied()
                    if (path == "/") return WebResourceResponse("text/html", "UTF-8", HTML.byteInputStream())
                    responses[path]?.let { return WebResourceResponse("application/json", "UTF-8", it.byteInputStream()) }
                    if (path.matches(Regex("/journal/media/file/(gps-photo|route-photo)/(thumb|preview)\\.webp")))
                        return WebResourceResponse("image/png", null, png.inputStream())
                    val asset = path.removePrefix("/static/")
                    if (path.startsWith("/static/") && asset in setOf("style.css", "media-ui.js", "offline-map.js", "location-day.js", "location-day-view.js", "datetime-picker.js", "media-settings.js")) {
                        val mime = if (asset.endsWith(".css")) "text/css" else "application/javascript"
                        return WebResourceResponse(mime, "UTF-8", instrumentation.targetContext.assets.open("journal/$asset"))
                    }
                    trace.add("blocked $path")
                    return denied()
                }
            }
            val density = instrumentation.targetContext.resources.displayMetrics.density
            val width = (393 * density).toInt(); val height = (852 * density).toInt()
            surface = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            val canvas = Canvas(surface)
            web.measure(View.MeasureSpec.makeMeasureSpec(width, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(height, View.MeasureSpec.EXACTLY))
            web.layout(0, 0, width, height)
            web.loadUrl("https://location.qa.test/")
            web.onResume(); web.resumeTimers()
            fun poll() {
                // A detached WebView has no window-driven drawing traversal.
                web.draw(canvas)
                web.evaluateJavascript("({result:window.qaLocationResult||null,stage:window.qaLocationStage||'document-start',ready:document.readyState,hidden:document.hidden,width:innerWidth,height:innerHeight,images:[...document.images].map(i=>({src:i.src,complete:i.complete,width:i.naturalWidth}))})") { value ->
                    observation.set(value ?: "No evaluation result")
                    val state = runCatching { JSONObject(value ?: "null") }.getOrNull()
                    val completed = state?.optJSONObject("result")
                    if (completed != null) { result.set(completed.toString()); done.countDown() }
                    else if (System.currentTimeMillis() < deadline) Handler(Looper.getMainLooper()).postDelayed({ poll() }, 100)
                }
            }
            poll()
        }
        try {
            check(done.await(27, TimeUnit.SECONDS)) { "Location UI WebView timed out: ${observation.get()}; requests=$trace" }
            val value = JSONObject(result.get())
            check(value.optBoolean("ok")) { "Location UI WebView failed: $value; $trace" }
            check(listOf("canvas", "gap", "stop", "photo", "cleanup", "mapFirst", "dailyAnalytics", "photoRange", "photoMap").all(value::optBoolean)) { "Location UI smoke omitted an assertion: $value" }
            return value.toString()
        } finally { instrumentation.runOnMainSync { web.destroy(); surface.recycle() } }
    }

    private fun denied() = WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", emptyMap(), ByteArray(0).inputStream())

    private val HTML = """
        <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
        <link rel="stylesheet" href="/static/style.css">
        <script>window.qaLocationStage='document-start';window.addEventListener('error',event=>{window.qaLocationResult={ok:false,stage:window.qaLocationStage,error:event.message||'Asset failed'};});</script>
        </head><body class="media-mobile"><main id="fixture"></main>
        <script src="/static/media-ui.js"></script><script src="/static/offline-map.js"></script>
        <script src="/static/location-day.js"></script><script src="/static/location-day-view.js"></script>
        <script src="/static/datetime-picker.js"></script><script src="/static/media-settings.js"></script>
        <script>
        (async()=>{
            const assert=(value,message)=>{if(!value)throw Error(message);};
            const stage=name=>{window.qaLocationStage=name;};
            const bounded=(promise,label)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(label+' timed out')),6000);Promise.resolve(promise).then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});
            stage('media-state');
            const M=PupMedia,host=document.getElementById('fixture'),requests=[];
            await bounded(M.refresh(),'Media state');
            const request=M.request;
            M.request=(path,body)=>{requests.push(path);return request(path,body);};
            const interval=window.setInterval,clear=window.clearInterval,intervals=new Set();
            window.setInterval=(...args)=>{const id=interval(...args);intervals.add(id);return id;};
            window.clearInterval=id=>{intervals.delete(id);clear(id);};
            const view=PupLocationDayView.mount(host,'2026-09-08',{showHeading:false,showAnalytics:true});
            try {
                stage('daily-mount');
                await bounded(view.ready,'Daily map mount');
                assert(view.day&&view.map,'The actual daily map did not mount');
                stage('canvas-paint');
                await bounded(view.map.draw(),'Canvas paint');
                const canvas=host.querySelector('canvas');
                assert(canvas&&canvas.width>0&&canvas.height>0,'Detached WebView did not lay out its canvas');
                assert(canvas.getContext('2d').getImageData(0,0,1,1).data[3]>0,'Actual canvas did not paint');
                const mapBox=host.querySelector('.location-day-map').getBoundingClientRect(),replayBox=host.querySelector('.location-day-replay').getBoundingClientRect(),statsBox=host.querySelector('.location-day-stats').getBoundingClientRect();
                assert(host.firstElementChild.classList.contains('location-day-map')&&mapBox.bottom<=replayBox.top&&replayBox.bottom<=statsBox.top,'Map and replay are not above the daily totals');
                assert(host.querySelector('.location-day-movement')?.textContent.includes('Movement this day'),'Daily movement details are absent');
                const hiddenDate=M.element('div','media-mobile-heading');hiddenDate.hidden=true;document.body.append(hiddenDate);
                assert(getComputedStyle(hiddenDate).display==='none','The date header remains visible in views without day context');hiddenDate.remove();
                assert(requests.filter(path=>path.startsWith('tracking')).every(path=>path==='tracking?from=2026-09-08&to=2026-09-08'),'Daily view requested other dates');
                assert(view.day.photos.some(p=>p.asset_id==='route-photo'&&p.source==='route'),'Capture-time photo inference did not reach the UI');
                assert(M.getState().assets['route-photo'].location===null,'UI rewrote original photo GPS');
                stage('replay-gap');
                const slider=host.querySelector('.location-day-slider');
                slider.value='577';slider.dispatchEvent(new Event('input',{bubbles:true}));
                assert(view.map.playback&&host.querySelector('.location-day-clock').textContent==='09:37','Replay did not show a recorded point');
                slider.value='585';slider.dispatchEvent(new Event('input',{bubbles:true}));
                assert(view.map.playback===null&&host.querySelector('.location-day-position').textContent==='No recorded position','Replay drew across the tracking gap');
                stage('stop-detail');
                const stop=[...host.querySelectorAll('.location-day-stop')].find(button=>button.textContent.includes('Home'));
                assert(stop,'The thirty-minute stop is missing');stop.click();await Promise.resolve();
                assert(!view.detail.hidden&&view.detail.textContent.includes('30 min here'),'Stop tap did not reveal duration');
                stage('photo-thumbnail');
                const photos=[...host.querySelectorAll('.location-day-photo')];
                const photo=photos.find(button=>button.querySelector('img').src.includes('/route-photo/'));
                assert(photo,'The inferred photo thumbnail is absent');
                const image=photo.querySelector('img');
                image.loading='eager';
                await bounded(image.decode(),'Photo thumbnail decode');
                assert(image.naturalWidth===12,'Photo thumbnail did not use the fixture response');
                stage('photo-preview');
                photo.click();await Promise.resolve();
                await bounded(new Promise(resolve=>{
                    const loaded=()=>{if(document.querySelector('.media-full-image')?.naturalWidth){observer.disconnect();resolve();}};
                    const observer=new MutationObserver(loaded);observer.observe(document.body,{childList:true,subtree:true});loaded();
                }),'Photo preview load');
                assert(document.querySelector('.media-full-image')?.src.includes('/route-photo/'),'Thumbnail tap did not open the inferred photo');
                assert(M.closeTopDialog(),'Photo preview did not close');
                stage('cleanup');
                const map=view.map,requestCount=requests.length;
                view.destroy();document.dispatchEvent(new Event('journal:saved'));await Promise.resolve();
                assert(view.destroyed&&map.destroyed&&!host.querySelector('canvas')&&intervals.size===0,'Daily map failed to clean up');
                assert(requests.length===requestCount,'Destroyed view still responds to journal saves');
                stage('photos-date-range');
                // Select the mobile layout while keeping the isolated fixture transport.
                window.TodoPupNative={};
                const OriginalMap=TodoPupMap.OfflineMap;let photoMap;
                TodoPupMap.OfflineMap=class extends OriginalMap{constructor(...args){super(...args);photoMap=this;}};
                try {
                    await bounded(M.photos(host,[{date:'2026-09-09',document:[
                        {id:'p1',type:'photo',asset_id:'gps-photo',caption:'At home'},
                        {id:'p2',type:'photo',asset_id:'route-photo',caption:'On the walk'}
                    ]}]),'Photos tab');
                    assert(host.firstElementChild.classList.contains('media-photo-range'),'Date range must come first');
                    const from=host.querySelector('input[aria-label="From"]'),to=host.querySelector('input[aria-label="To"]');
                    assert(from.value==='2026-09-08'&&to.value==='2026-09-08','Range must use capture dates, not entry dates');
                    assert(host.querySelectorAll('.media-gallery-card').length===2&&photoMap.markers.length===1,'Unknown GPS must stay in the gallery');
                    from.value='2026-09-09';from.dispatchEvent(new Event('change',{bubbles:true}));
                    assert(photoMap.markers.length===0&&host.querySelectorAll('.media-gallery-card').length===0,'Range did not filter map and gallery together');
                    assert(!host.querySelector('.media-form-error').hidden,'Reversed dates need a visible correction');
                    from.value='2026-09-08';from.dispatchEvent(new Event('change',{bubbles:true}));
                    await bounded(photoMap.draw(),'Photos map draw');
                    const beforeZoom=photoMap.zoom;
                    host.querySelector('[aria-label="Zoom in"]').click();
                    assert(photoMap.zoom>beforeZoom,'Photo map zoom did not respond');
                    const thumbnail=host.querySelector('.media-gallery-card img');thumbnail.loading='eager';
                    await bounded(thumbnail.decode(),'Photos tab thumbnail');
                    photoMap.options.onPick(null,photoMap.markers[0]);
                    await bounded(new Promise(resolve=>{
                        const loaded=()=>{if(document.querySelector('.media-full-image')?.naturalWidth){observer.disconnect();resolve();}};
                        const observer=new MutationObserver(loaded);observer.observe(document.body,{childList:true,subtree:true});loaded();
                    }),'Map photo preview');
                    assert(document.querySelector('.media-full-image').src.includes('/gps-photo/'),'Map photo pin opened the wrong image');
                    assert(M.closeTopDialog(),'Map photo preview did not close');
                    host._mediaCleanup();assert(photoMap.destroyed,'Photos map leaked after closing');
                } finally {host._mediaCleanup?.();TodoPupMap.OfflineMap=OriginalMap;delete window.TodoPupNative;}
                window.qaLocationResult={ok:true,canvas:true,gap:true,stop:true,photo:true,cleanup:true,mapFirst:true,dailyAnalytics:true,photoRange:true,photoMap:true};
            } finally {view.destroy();window.setInterval=interval;window.clearInterval=clear;}
        })().catch(error=>{window.qaLocationResult={ok:false,stage:window.qaLocationStage,error:String(error),stack:error.stack};});
        </script></body></html>
    """.trimIndent()
}
