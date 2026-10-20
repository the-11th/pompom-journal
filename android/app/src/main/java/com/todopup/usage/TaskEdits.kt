package com.todopup.usage

/** Compare the editor's original snapshot, never a cache changed by background sync. */
internal object TaskEdits {
    val fields = listOf("title", "due", "recurrence", "tags", "notes", "subtasks", "difficulty", "done")

    fun changedFields(before: MobileTask, after: MobileTask): List<String> = fields.filter { field ->
        when (field) {
            "title" -> before.title != after.title
            "due" -> before.due != after.due
            "recurrence" -> before.recurrence != after.recurrence
            "tags" -> before.tags != after.tags
            "notes" -> before.notes != after.notes
            "subtasks" -> before.subtasks != after.subtasks
            "difficulty" -> before.difficulty != after.difficulty
            "done" -> before.done != after.done
            else -> false
        }
    }

    fun overlay(current: MobileTask, edited: MobileTask, fields: List<String>): MobileTask = current.copy(
        title = if ("title" in fields) edited.title else current.title,
        due = if ("due" in fields) edited.due else current.due,
        recurrence = if ("recurrence" in fields) edited.recurrence else current.recurrence,
        tags = if ("tags" in fields) edited.tags else current.tags,
        notes = if ("notes" in fields) edited.notes else current.notes,
        subtasks = if ("subtasks" in fields) edited.subtasks else current.subtasks,
        difficulty = if ("difficulty" in fields) edited.difficulty else current.difficulty,
        done = if ("done" in fields) edited.done else current.done,
        status = if ("done" in fields) if (edited.done) "completed" else "active" else current.status,
    )
}
