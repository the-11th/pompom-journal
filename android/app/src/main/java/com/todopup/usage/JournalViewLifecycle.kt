package com.todopup.usage

/** Closing still needs bridge replies until the editor's final save settles. */
internal class JournalViewLifecycle {
    @Volatile var closing = false
        private set
    @Volatile var released = false
        private set
    val acceptsReplies: Boolean get() = !released

    @Synchronized fun beginClose(): Boolean {
        if (closing || released) return false
        closing = true
        return true
    }

    @Synchronized fun beginRelease(): Boolean {
        if (released) return false
        released = true
        return true
    }
}
