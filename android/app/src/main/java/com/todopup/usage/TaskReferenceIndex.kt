package com.todopup.usage

internal data class TaskReference(val title: String, val done: Boolean, val status: String)

/** Mirrors the web journal's read-only linked-task presentation contract. */
internal object TaskReferenceIndex {
    fun build(tasks: List<MobileTask>, body: String): Map<String, TaskReference> {
        val byId = tasks.associateBy { it.id }
        return Regex("\\[task:([0-9a-f]+)]").findAll(body).map { it.groupValues[1] }.distinct().associateWith { id ->
            val task = byId[id]
            when (task?.status) {
                "active" -> TaskReference(task.title, task.done, "active")
                "completed" -> TaskReference(task.title, true, "done")
                "expired" -> TaskReference(task.title, false, "expired")
                else -> TaskReference("", false, "missing")
            }
        }
    }
}
