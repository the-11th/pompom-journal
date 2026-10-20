package com.todopup.usage

import org.json.JSONObject

/** A conflict choice applies only to the phone and Mac copies actually reviewed. */
internal object JournalConflictGuard {
    fun accepts(local: JournalDraft, choice: JSONObject): Boolean =
        (!choice.has("expected_updated") || choice.opt("expected_updated") == local.modifiedAt) &&
            (!choice.has("expected_server_version") ||
                TaskMutationJson.same(choice.opt("expected_server_version"), local.serverVersion ?: JSONObject.NULL))
}
