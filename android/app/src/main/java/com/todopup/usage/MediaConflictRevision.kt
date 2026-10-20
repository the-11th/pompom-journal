package com.todopup.usage

import org.json.JSONArray
import org.json.JSONObject

internal class MediaConflictChanged(val current: JSONObject?) : IllegalStateException(
    "This item changed again. Review the current copies before choosing.")

internal object MediaConflictRevision {
    fun of(conflict: JSONObject): String = MediaStore.digest(canonical(JSONObject().apply {
        for (field in listOf("kind", "id", "op_id", "local", "current")) put(field, conflict.opt(field) ?: JSONObject.NULL)
    }).toByteArray(Charsets.UTF_8))

    private fun canonical(value: Any?): String = when (value) {
        is JSONObject -> value.keys().asSequence().sorted().joinToString(",", "{", "}") { JSONObject.quote(it) + ":" + canonical(value.get(it)) }
        is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { canonical(value.get(it)) }
        is String -> JSONObject.quote(value)
        is Number -> value.toString().toBigDecimal().stripTrailingZeros().toPlainString()
        null, JSONObject.NULL -> "null"
        else -> value.toString()
    }
}
