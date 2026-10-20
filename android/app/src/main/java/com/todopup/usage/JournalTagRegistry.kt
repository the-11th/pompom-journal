package com.todopup.usage

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

internal data class JournalTagAddition(val sectionId: String, val name: String, val kind: String = "permanent") {
    fun json(): JSONObject = JSONObject().put("section_id", sectionId).put("name", name).put("kind", kind)
}

/** Permanent additions use the existing independent tag outbox, never a later text commit. */
internal class JournalTagRegistry(private val context: Context) {
    private val outbox = TaskOutbox(context)

    fun project(sections: List<JournalSection>, drafts: List<JournalDraft>): List<JournalSection> {
        // Recover explicit saves made by older APKs, which stored new_tags only in the draft.
        drafts.filter { !it.autosave && it.syncState != SyncState.SYNCED }.forEach { request(it.newTags, sections) }
        val additions = outbox.journalTags(includeAcknowledged = true)
        val intents = outbox.journalTagIntents().filter { !it.confirmed }
        return sections.map { section ->
            if (section.type != "tag") return@map section
            val tags = (section.tags + additions.filter { it.sectionId == section.id }.map { it.name }).toMutableSet()
            val archived = section.archivedTags.toMutableSet()
            val mentions = (section.mentionTags + tags + archived).toMutableSet()
            for (intent in intents.filter { it.sectionId == section.id }) {
                mentions.add(intent.name)
                when (intent.action) {
                    "archive" -> { tags.remove(intent.name); archived.add(intent.name) }
                    "add" -> { tags.add(intent.name); archived.remove(intent.name) }
                    "restore_temporary" -> { tags.remove(intent.name); archived.remove(intent.name) }
                }
            }
            section.copy(tags = tags.toList(), archivedTags = archived.toList(), mentionTags = mentions.toList())
        }
    }

    fun archive(sectionId: String, rawName: String, sections: List<JournalSection>) = synchronized(JournalSyncStore.guard) {
        val name = normalizeName(rawName)
        val section = sections.firstOrNull { it.id == sectionId && it.type == "tag" }
            ?: throw IllegalArgumentException("Choose an active tag section")
        if (name in section.archivedTags) return@synchronized
        outbox.enqueueJournalTagIntent(JournalTagAddition(sectionId, name), "archive")
        // The tag selection is historical data. Only the old request metadata
        // is retired so a later text commit cannot restore the hidden name.
        JournalSyncStore(context).acknowledgeTags(listOf(JournalTagAddition(sectionId, name), JournalTagAddition(sectionId, name, "temporary")))
    }

    fun request(raw: String, sections: List<JournalSection>, deliberate: Boolean = false) {
        for (tag in parse(raw)) {
            val section = sections.firstOrNull { it.id == tag.sectionId && it.type == "tag" } ?: continue
            if (!deliberate && tag.name in section.archivedTags) continue
            if (tag.kind == "permanent" && (tag.name !in section.tags || tag.name in section.archivedTags))
                outbox.enqueueJournalTag(tag, deliberate)
            if (deliberate && tag.kind == "temporary" && tag.name in section.archivedTags)
                outbox.enqueueJournalTagIntent(tag, "restore_temporary")
        }
    }

    fun prepare(submitted: JournalDraft, previous: JournalDraft?, sections: List<JournalSection>): JournalDraft {
        val additions = parse(submitted.newTags)
        require(additions.all { tag -> sections.any { it.id == tag.sectionId && it.type == "tag" } }) {
            "Choose an active tag section"
        }
        val tags = submitted.tags.mapValues { (_, values) -> values.map(::normalizeName).distinct() }.toMutableMap()
        for (tag in additions) tags[tag.sectionId] = (tags[tag.sectionId].orEmpty() + tag.name).distinct()
        previous?.takeIf { !it.autosave && it.syncState != SyncState.SYNCED }?.let { request(it.newTags, sections) }
        if (!submitted.autosave) request(submitted.newTags, sections, deliberate = true)
        return preserve(submitted.copy(tags = tags, newTags = encode(additions)), previous)
    }

    fun preserve(submitted: JournalDraft, previous: JournalDraft?): JournalDraft {
        val pending = outbox.journalTags().toSet()
        val kept = previous?.let { parse(it.newTags) }.orEmpty().filter { it.kind == "permanent" && it in pending }
        val additions = (kept + parse(submitted.newTags)).distinctBy { it.sectionId to it.name }
        return submitted.copy(newTags = encode(additions))
    }

    companion object {
        fun normalizeName(raw: String): String = raw.trim().lowercase().also {
            require(it.isNotEmpty() && it.codePointCount(0, it.length) <= 200 && it.matches(Regex("[\\p{L}\\p{N} ._-]+"))) { "Use letters, numbers, spaces, dots, dashes or underscores for tags" }
        }
        fun sharedNames(values: JSONArray?): List<String> = if (values == null) emptyList() else
            (0 until values.length()).mapNotNull { index -> runCatching { normalizeName(values.optString(index)) }.getOrNull() }

        fun parse(raw: String): List<JournalTagAddition> {
            val values = JSONArray(raw)
            return (0 until values.length()).map { index ->
                val item = values.getJSONObject(index)
                val section = item.getString("section_id").also { require(it.isNotBlank()) }
                val kind = item.optString("kind", "temporary").also { require(it in setOf("permanent", "temporary")) }
                JournalTagAddition(section, normalizeName(item.getString("name")), kind)
            }.distinct()
        }
        fun encode(values: List<JournalTagAddition>): String = JSONArray(values.map { it.json() }).toString()
    }
}
