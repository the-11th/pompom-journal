package com.todopup.usage

/** Photo link offsets use Unicode code points, matching the journal wire format. */
internal data class PhotoTextRange(val start: Int, val end: Int)

internal object TaskRewriteLinks {
    private val fresh = Regex("^([ \\t]*(?:-[ \\t]+)?)\\[[ ]?\\]([ \\t]+.+)$")
    private val linked = Regex("^([ \\t]*(?:-[ \\t]+)?)\\[task:([0-9a-f]+)\\]([ \\t]+.+)$")
    private data class Edit(val start: Int, val end: Int, val length: Int)

    /** Return null for changes beyond the known [] -> [task:id] commit rewrite. */
    fun rebase(before: String, after: String, links: List<PhotoTextRange>): List<PhotoTextRange>? {
        val oldLines = before.split('\n'); val newLines = after.split('\n')
        if (oldLines.size != newLines.size) return null
        val edits = mutableListOf<Edit>(); var offset = 0
        for (i in oldLines.indices) {
            val old = oldLines[i]; val new = newLines[i]
            if (old != new) {
                val a = fresh.matchEntire(old) ?: return null
                val b = linked.matchEntire(new) ?: return null
                if (a.groupValues[1] != b.groupValues[1] || a.groupValues[2] != b.groupValues[3]) return null
                val prefix = a.groupValues[1].length
                val markerLength = old.length - prefix - a.groupValues[2].length
                edits.add(Edit(offset + prefix, offset + prefix + markerLength, "[task:${b.groupValues[2]}]".length))
            }
            offset += old.codePointCount(0, old.length) + 1
        }
        var result = links
        for (edit in edits.asReversed()) {
            val delta = edit.length - (edit.end - edit.start)
            result = result.map { link -> when {
                edit.end <= link.start -> PhotoTextRange(link.start + delta, link.end + delta)
                edit.start >= link.end -> link
                else -> PhotoTextRange(minOf(link.start, edit.start), maxOf(edit.start + edit.length, link.end + delta))
            } }
        }
        return result
    }
}
