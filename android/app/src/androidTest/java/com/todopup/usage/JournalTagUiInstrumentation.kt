package com.todopup.usage

import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.graphics.Bitmap
import android.os.Bundle
import android.os.SystemClock
import android.view.MotionEvent
import android.view.inputmethod.EditorInfo
import android.webkit.WebView
import org.json.JSONObject
import java.io.File
import java.time.LocalDate
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Actual WebView IME/hold checks, synthetic unpaired emulator only. */
class JournalTagUiInstrumentation : Instrumentation() {
    private val date = LocalDate.now().toString()
    override fun onCreate(arguments: Bundle?) { super.onCreate(arguments); start() }
    override fun callActivityOnCreate(activity: Activity, state: Bundle?) {
        super.callActivityOnCreate(activity, Bundle(state ?: Bundle()).apply { putString("screen", "JOURNAL"); putString("journal_date", date) })
    }
    override fun onStart() {
        var activity: Activity? = null; var seeded = false; var success = false
        val result = Bundle(); val store = JournalSyncStore(targetContext); val past = LocalDate.parse(date).minusDays(1).toString()
        try {
            check(targetContext.packageName == "com.todopup.usage.qa" && !MobileConfig.isConfigured(targetContext) && android.os.Build.HARDWARE in setOf("ranchu", "goldfish"))
            MobileCache(targetContext).saveConfig(MobileJournalConfig(listOf(JournalSection("people", "People", "tag", "#e0a955", tags = listOf("alex")))))
            seeded = true
            val history = JournalDraft(past, body = "Historical entry", tags = mapOf("people" to listOf("kiwi friend")), mood = 6)
            store.save(history); store.save(JournalDraft(date, body = "Today", tags = mapOf("people" to listOf("alex"))))
            activity = startActivitySync(Intent(targetContext, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK))
            lateinit var web: WebView
            runOnMainSync {
                val media = MainActivity::class.java.getDeclaredField("mediaJournal").apply { isAccessible = true }.get(activity) as MediaJournalView
                web = MediaJournalView::class.java.getDeclaredField("web").apply { isAccessible = true }.get(media) as WebView
            }
            fun js(script: String): String {
                val ready = CountDownLatch(1); var value = ""
                runOnMainSync { web.evaluateJavascript(script) { value = it; ready.countDown() } }
                check(ready.await(5, TimeUnit.SECONDS)); return value
            }
            fun await(message: String, test: () -> Boolean) {
                val end = SystemClock.uptimeMillis() + 8000
                while (!test()) { check(SystemClock.uptimeMillis() < end) { message }; SystemClock.sleep(80) }
            }
            await("Journal form unavailable") { js("Boolean(window.PupJournalEditor && document.querySelector('[name=\"newtag-name:people\"]'))") == "true" }
            fun touch(selector: String, hold: Long = 80) {
                js("document.querySelector(" + JSONObject.quote(selector) + ").scrollIntoView({block:'center'})")
                SystemClock.sleep(150)
                val point = JSONObject(js("(()=>{const r=document.querySelector(" + JSONObject.quote(selector) + ").getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,scale:devicePixelRatio}})()"))
                val offset = IntArray(2); runOnMainSync { web.getLocationOnScreen(offset) }
                val x = offset[0] + point.getDouble("x").toFloat() * point.getDouble("scale").toFloat()
                val y = offset[1] + point.getDouble("y").toFloat() * point.getDouble("scale").toFloat()
                val now = SystemClock.uptimeMillis()
                uiAutomation.injectInputEvent(MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, x, y, 0), true)
                SystemClock.sleep(hold)
                uiAutomation.injectInputEvent(MotionEvent.obtain(now, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x, y, 0), true)
            }
            fun enter(name: String) {
                touch("[name=\"newtag-name:people\"]")
                SystemClock.sleep(300)
                js("(()=>{const f=document.querySelector('[name=\"newtag-name:people\"]');f.focus();f.value=${JSONObject.quote(name)};f.dispatchEvent(new Event('input',{bubbles:true}));})()")
                var connection: android.view.inputmethod.InputConnection? = null
                await("WebView IME connection unavailable") {
                    runOnMainSync { connection = web.onCreateInputConnection(EditorInfo()) }
                    connection != null
                }
                var handled = false
                runOnMainSync { handled = connection!!.performEditorAction(EditorInfo.IME_ACTION_DONE) }
                check(handled) { "IME Done was not handled" }
                await("IME Done did not add and select the journal tag") { js("[...document.querySelectorAll('[name=\"tag:people\"]')].some(i=>i.value===${JSONObject.quote(name)}&&i.checked&&!i.closest('label').hidden)") == "true" }
                await("Accepted tag input was not cleared") { js("document.querySelector('[name=\"newtag-name:people\"]').value") == "\"\"" }
            }
            enter("kiwi friend")
            check(store.get(date)!!.tags.getValue("people").contains("kiwi friend"))
            js("document.activeElement.blur();document.querySelector('[name=\"tag:people\"][value=\"kiwi friend\"]').closest('label').scrollIntoView({block:'center'})")
            runOnMainSync { (targetContext.getSystemService(android.content.Context.INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager).hideSoftInputFromWindow(web.windowToken, 0) }
            SystemClock.sleep(400)
            val bounds = JSONObject(js("(()=>{const r=document.querySelector('[name=\"tag:people\"][value=\"kiwi friend\"]').closest('label').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,scale:devicePixelRatio}})()"))
            val position = IntArray(2); runOnMainSync { web.getLocationOnScreen(position) }
            val x = position[0] + bounds.getDouble("x").toFloat() * bounds.getDouble("scale").toFloat()
            val y = position[1] + bounds.getDouble("y").toFloat() * bounds.getDouble("scale").toFloat()
            val down = SystemClock.uptimeMillis()
            uiAutomation.injectInputEvent(MotionEvent.obtain(down, down, MotionEvent.ACTION_DOWN, x, y, 0), true)
            SystemClock.sleep(1800)
            uiAutomation.injectInputEvent(MotionEvent.obtain(down, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x, y, 0), true)
            await("Long hold did not open tag options") { js("[...document.querySelectorAll('.media-dialog h3')].some(h=>h.textContent==='Tag options')") == "true" }
            check(TaskOutbox(targetContext).pending().isEmpty()) { "Releasing a long hold activated Archive without choosing it" }
            uiAutomation.takeScreenshot()?.let { image -> File(targetContext.cacheDir, "journal-tag-hold.png").outputStream().use { image.compress(Bitmap.CompressFormat.PNG, 100, it) }; image.recycle() }
            js("[...document.querySelectorAll('.media-overlay button')].find(b=>b.textContent==='Archive tag').setAttribute('data-qa-archive','true')")
            touch("[data-qa-archive]")
            await("Archive did not hide the selected tag") { js("document.querySelector('[name=\"tag:people\"][value=\"kiwi friend\"]').closest('label').hidden") == "true" }
            check(js("document.querySelector('[name=\"tag:people\"][value=\"kiwi friend\"]').checked") == "true")
            check(store.get(past) == history) { "Archive modified an old entry" }
            check(TaskOutbox(targetContext).pending().single().operation == "journal_tag_archive")
            enter("kiwi friend")
            check(js("document.querySelector('[name=\"tag:people\"][value=\"kiwi friend\"]').closest('label').classList.contains('temp')") == "true")
            check(TaskOutbox(targetContext).pending().map { it.operation } == listOf("journal_tag_archive", "journal_tag_restore_temporary"))
            js("(()=>{const f=document.querySelector('[name=\"newtag-name:people\"]');f.value='composition';f.dispatchEvent(new Event('input',{bubbles:true}));f.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true}));})()")
            SystemClock.sleep(250)
            check(js("document.querySelector('[name=\"newtag-name:people\"]').value") == "\"composition\"") { "Composition Enter submitted an unfinished tag" }
            success = true; result.putString("stream", "PASS: actual WebView IME Done adds/selects, touch hold archives/hides while preserving history, temporary re-add restores, and IME composition does not submit.\n")
        } catch (error: Throwable) { result.putString("stream", error.stackTraceToString()) }
        finally {
            activity?.let { runOnMainSync { it.finish() } }
            if (seeded) {
                store.remove(date); store.remove(past)
                targetContext.getSharedPreferences("todopup_task_outbox", android.content.Context.MODE_PRIVATE).edit().clear().commit()
            }
        }
        finish(if (success) Activity.RESULT_OK else Activity.RESULT_CANCELED, result)
    }
}
