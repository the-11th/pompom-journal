package com.todopup.usage

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.graphics.Bitmap
import android.os.Bundle
import android.os.SystemClock
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.time.LocalDate
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Synthetic image and dates, on an unpaired disposable emulator QA app only. */
class PhotoInlineUiInstrumentation : Instrumentation() {
    private val date = LocalDate.now().toString()
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }
    override fun callActivityOnCreate(activity: Activity, state: Bundle?) {
        super.callActivityOnCreate(activity, Bundle(state ?: Bundle()).apply {
            putString("screen", "JOURNAL"); putString("journal_date", date)
        })
    }
    override fun onStart() {
        var activity: Activity? = null
        val result = Bundle()
        val store = JournalSyncStore(targetContext)
        val otherDate = LocalDate.parse(date).minusDays(1).toString()
        var success = false
        var seeded = false
        try {
            check(targetContext.packageName == "com.todopup.usage.qa" && !MobileConfig.isConfigured(targetContext))
            check(android.os.Build.HARDWARE in setOf("ranchu", "goldfish")) { "Photo UI checks require a disposable emulator" }
            val image = Bitmap.createBitmap(8, 4, Bitmap.Config.ARGB_8888).apply { eraseColor(android.graphics.Color.rgb(90, 115, 130)) }
            val bytes = ByteArrayOutputStream().also { image.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
            image.recycle()
            val media = MediaStore(targetContext)
            val asset = media.importBytes(bytes)
            val id = asset.getString("id")
            val photo = JSONObject().put("id", "inline-photo").put("type", "photo").put("asset_id", id)
                .put("caption", "Before caption").put("location_label", "Old place")
            val doc = JSONArray().put(JSONObject().put("id", "words").put("type", "text").put("text", "A quiet day"))
                .put(photo)
            val draft = JournalDraft(date, title = "Photo day", body = "A quiet day", mood = 4,
                document = doc.toString(), autosave = true, syncState = SyncState.PENDING)
            val other = draft.copy(date = otherDate, title = "Other day")
            seeded = true
            store.save(draft); store.save(other)
            val assetBefore = media.state().getJSONObject("assets").getJSONObject(id)
            activity = startActivitySync(Intent(targetContext, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
            lateinit var web: WebView
            runOnMainSync {
                val editor = MainActivity::class.java.getDeclaredField("mediaJournal").apply { isAccessible = true }.get(activity) as MediaJournalView
                web = MediaJournalView::class.java.getDeclaredField("web").apply { isAccessible = true }.get(editor) as WebView
            }
            fun js(source: String): String {
                val done = CountDownLatch(1); var value = ""
                runOnMainSync { web.evaluateJavascript(source) { value = it; done.countDown() } }
                check(done.await(5, TimeUnit.SECONDS)); return value
            }
            fun await(test: () -> Boolean) {
                val until = SystemClock.uptimeMillis() + 10000
                while (!test()) { check(SystemClock.uptimeMillis() < until) { "Inline photo UI timed out" }; SystemClock.sleep(80) }
            }
            await { js("Boolean(window.PupJournalEditor && [...document.querySelectorAll('.media-mobile-nav button')].every(b=>!b.disabled))") == "true" }
            js("[...document.querySelectorAll('.media-mobile-nav button')].find(b=>b.textContent==='Photos').click()")
            await { js("document.querySelectorAll('.media-gallery-card').length") == "1" }
            js("document.querySelector('.media-gallery-card').click()")
            await { js("Boolean(document.querySelector('.media-full-image')?.complete && document.querySelector('[aria-label=\"Edit caption\"]'))") == "true" }
            js("document.querySelector('[aria-label=\"Edit caption\"]').click(); const box=document.querySelector('.media-photo-inline'); box.querySelector('textarea').value='Entry-only caption'; box.querySelector('textarea').dispatchEvent(new Event('input',{bubbles:true})); box.querySelector('input').value='Entry-only place';box.querySelector('input').dispatchEvent(new Event('input',{bubbles:true}));")
            SystemClock.sleep(300)
            uiAutomation.takeScreenshot()?.let { bitmap -> File(targetContext.cacheDir, "native-inline-photo.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle() }
            js("[...document.querySelectorAll('.media-photo-inline button')].find(b=>b.textContent==='Save').click()")
            await { js("document.querySelector('[aria-label=\"Edit caption\"]')?.textContent") == "\"Entry-only caption\"" }
            val saved = requireNotNull(store.get(date))
            val savedPhoto = JSONArray(saved.document).getJSONObject(1)
            check(savedPhoto.getString("caption") == "Entry-only caption" && savedPhoto.getString("location_label") == "Entry-only place")
            check(store.get(otherDate) == other) { "Inline photo UI changed another date" }
            check(TaskMutationJson.same(assetBefore, media.state().getJSONObject("assets").getJSONObject(id))) { "Inline photo UI changed global asset metadata" }
            js("window.qaPhotoIdleSave=false;PupJournalEditor.save().then(()=>qaPhotoIdleSave=true)")
            await { js("qaPhotoIdleSave") == "true" }
            check(store.get(date)?.requestId == saved.requestId) { "Adopting photo details caused an unnecessary journal save" }
            js("document.querySelector('.media-photo-viewer .media-close').click();[...document.querySelectorAll('.media-mobile-nav button')].find(b=>b.textContent==='Entry').click()")
            await { js("Boolean(!document.querySelector('form').hidden)") == "true" }
            check(js("PupJournalEditor.editor.doc.find(b=>b.type==='photo').caption") == "\"Entry-only caption\"")
            js("const title=document.querySelector('[name=title]');title.value='More journal text';title.dispatchEvent(new Event('input',{bubbles:true}));window.qaPhotoSave=false;PupJournalEditor.save().then(()=>qaPhotoSave=true)")
            await { js("qaPhotoSave") == "true" }
            check(store.get(date)?.title == "More journal text") { "Returning from photo details left a stale editor revision" }
            check(js("document.querySelectorAll('.media-overlay').length") == "0") { "Photo save caused a false journal conflict" }
            check(JSONArray(store.get(date)?.document).getJSONObject(1).getString("caption") == "Entry-only caption")
            js("document.querySelector('.media-document .media-photo').click()")
            await { js("Boolean(document.querySelector('[aria-label=\"Edit caption\"]'))") == "true" }
            fun advancedVisible() = js("[...document.querySelectorAll('.media-photo-viewer button')].filter(b=>['Edit photo','Photo details'].includes(b.textContent)).filter(b=>b.getClientRects().length>0).length")
            check(advancedVisible() == "2")
            js("document.querySelector('[aria-label=\"Edit caption\"]').click()")
            check(advancedVisible() == "0") { "Advanced photo actions can discard unfinished inline details" }
            js("[...document.querySelectorAll('.media-photo-inline button')].find(b=>b.textContent==='Cancel').click()")
            check(advancedVisible() == "2") { "Cancel did not restore advanced photo actions" }
            js("document.querySelector('.media-photo-viewer .media-close').click()")
            success = true
            result.putString("stream", "PASS: actual WebView Photos → inline caption/place save → Entry → further journal save; other date and asset metadata unchanged.\n")
        } catch (error: Throwable) { result.putString("stream", error.stackTraceToString()) }
        finally { activity?.let { runOnMainSync { it.finish() } }; if (seeded) { store.remove(date); store.remove(otherDate) } }
        finish(if (success) Activity.RESULT_OK else Activity.RESULT_CANCELED, result)
    }
}
