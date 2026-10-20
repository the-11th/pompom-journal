package com.todopup.usage

import android.app.Instrumentation
import android.os.Bundle
import java.io.File
import java.util.concurrent.atomic.AtomicReference

/** Checks synthetic gallery cells only; never opens MediaStore or reads app data. */
class GallerySelectionInstrumentation : Instrumentation() {
    override fun onCreate(arguments: Bundle?) {
        super.onCreate(arguments)
        start()
    }

    override fun onStart() {
        val result = AtomicReference<Result<Unit>>()
        val capture = File(targetContext.cacheDir, "gallery-selection-check.png")
        runOnMainSync { result.set(runCatching { GallerySelectionChecks.run(targetContext, capture) }) }
        val output = Bundle()
        result.get().fold(
            onSuccess = {
                output.putString("stream", "PASS: gallery selection at font scales 1.0 and 2.0; capture ${capture.absolutePath}\n")
                finish(0, output)
            },
            onFailure = {
                output.putString("stream", "FAIL: ${it.stackTraceToString()}\n")
                finish(1, output)
            }
        )
    }
}
