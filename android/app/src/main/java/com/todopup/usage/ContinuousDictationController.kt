package com.todopup.usage

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import java.util.Locale

class ContinuousTranscript {
    private val segments = mutableListOf<String>()
    private var partial = ""

    fun updatePartial(value: String) {
        partial = value.trim()
    }

    fun commit(value: String) {
        val clean = value.trim()
        partial = ""
        if (clean.isNotBlank() && segments.lastOrNull() != clean) segments += clean
    }

    fun commitPartial() {
        commit(partial)
    }

    fun value(): String = (segments + partial.takeIf(String::isNotBlank).orEmpty())
        .filter(String::isNotBlank).joinToString(" ")
}

class ContinuousDictationController(
    context: Context,
    private val onText: (String) -> Unit,
    private val onState: (String) -> Unit,
    private val onComplete: (String) -> Unit,
    private val onFailure: (String) -> Unit,
) : RecognitionListener {
    private val handler = Handler(Looper.getMainLooper())
    private val recognizer = if (android.os.Build.VERSION.SDK_INT >= 31 && SpeechRecognizer.isOnDeviceRecognitionAvailable(context.applicationContext))
        SpeechRecognizer.createOnDeviceSpeechRecognizer(context.applicationContext)
    else SpeechRecognizer.createSpeechRecognizer(context.applicationContext)
    private val transcript = ContinuousTranscript()
    private var stopping = false
    private var finished = false
    private var destroyed = false

    private val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault())
        putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
        putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
        putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 3)
        putExtra(RecognizerIntent.EXTRA_PROMPT, "Tell Datapom about your day")
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 10_000L)
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 3_500L)
        putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 2_500L)
    }

    init {
        recognizer.setRecognitionListener(this)
    }

    fun start() {
        if (destroyed || finished) return
        stopping = false
        listen()
    }

    fun stop() {
        if (destroyed || finished || stopping) return
        stopping = true
        onState("Finishing transcript…")
        recognizer.stopListening()
        handler.postDelayed({ finish() }, 1_500L)
    }

    fun cancel() {
        if (destroyed) return
        finished = true
        destroyed = true
        handler.removeCallbacksAndMessages(null)
        recognizer.cancel()
        recognizer.destroy()
    }

    private fun listen() {
        if (destroyed || stopping || finished) return
        onState("Listening · pause whenever you need")
        runCatching { recognizer.startListening(intent) }
            .onFailure { fail("Speech recognition could not start") }
    }

    private fun restart(delay: Long = 250L) {
        if (!destroyed && !stopping && !finished) handler.postDelayed(::listen, delay)
    }

    private fun finish() {
        if (finished || destroyed) return
        transcript.commitPartial()
        finished = true
        destroyed = true
        handler.removeCallbacksAndMessages(null)
        recognizer.destroy()
        onComplete(transcript.value())
    }

    private fun fail(message: String) {
        if (destroyed || finished) return
        onFailure(message)
        cancel()
    }

    override fun onReadyForSpeech(params: Bundle?) = onState("Listening · keep talking")
    override fun onBeginningOfSpeech() = onState("Listening…")
    override fun onRmsChanged(rmsdB: Float) = Unit
    override fun onBufferReceived(buffer: ByteArray?) = Unit
    override fun onEndOfSpeech() = onState(if (stopping) "Finishing transcript…" else "Listening · continuing…")

    override fun onError(error: Int) {
        if (stopping) {
            finish()
            return
        }
        when (error) {
            SpeechRecognizer.ERROR_NO_MATCH,
            SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> restart()
            SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> restart(700L)
            SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> fail("Microphone permission is required")
            SpeechRecognizer.ERROR_NETWORK,
            SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> fail("Speech recognition network is unavailable")
            else -> restart(500L)
        }
    }

    override fun onResults(results: Bundle?) {
        best(results)?.let(transcript::commit)
        onText(transcript.value())
        if (stopping) finish() else restart()
    }

    override fun onPartialResults(partialResults: Bundle?) {
        best(partialResults)?.let(transcript::updatePartial)
        onText(transcript.value())
    }

    override fun onEvent(eventType: Int, params: Bundle?) = Unit

    private fun best(bundle: Bundle?): String? = bundle
        ?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
        ?.firstOrNull()
        ?.takeIf(String::isNotBlank)
}
