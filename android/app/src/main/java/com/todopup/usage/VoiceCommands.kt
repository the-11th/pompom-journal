package com.todopup.usage

data class VoiceTagCommand(
    val original: String,
    val name: String,
    var sectionId: String? = null,
    val sectionIds: List<String> = emptyList(),
    var status: String = "new",
    var keepAsText: Boolean = false,
)

data class VoiceCapture(val text: String, val commands: MutableList<VoiceTagCommand>)
data class VoiceJoin(val value: String, val caret: Int)
data class InlineMention(
    val name: String,
    val sectionId: String,
    val color: String,
    val start: Int,
    val end: Int,
)

object VoiceCommands {
    private fun norm(value: String) = value.trim().lowercase().replace(Regex("\\s+"), " ")

    fun punctuation(value: String): String {
        var text = value
        text = text.replace(Regex("\\bat symbol\\s*", RegexOption.IGNORE_CASE), "@")
            .replace(Regex("\\bhashtag\\s*", RegexOption.IGNORE_CASE), "#")
            .replace(Regex("\\s*\\bunderscore\\b\\s*", RegexOption.IGNORE_CASE), "_")
            .replace(Regex("\\s*\\bslash\\b\\s*", RegexOption.IGNORE_CASE), "/")
            .replace(Regex("\\b(?:open close bracket|checkbox)\\b", RegexOption.IGNORE_CASE), "[]")
            .replace(Regex("\\s*\\bnew line\\b\\s*", RegexOption.IGNORE_CASE), "\n")
            .replace(Regex("(\\s*)\\bleft quote\\b\\s*", RegexOption.IGNORE_CASE), "$1“")
            .replace(Regex("\\s*\\bright quote\\b(\\s*)", RegexOption.IGNORE_CASE), "”$1")
            .replace(Regex("\\s*\\bdot dot dot\\b", RegexOption.IGNORE_CASE), "...")
            .replace(Regex("\\s*\\bexclamation mark\\b", RegexOption.IGNORE_CASE), "!")
            .replace(Regex("\\s*\\bquestion mark\\b", RegexOption.IGNORE_CASE), "?")
            .replace(Regex("\\s*\\bperiod\\b", RegexOption.IGNORE_CASE), ".")
            .replace(Regex("\\s*\\bcomma\\b", RegexOption.IGNORE_CASE), ",")
            .replace(Regex("\\s*\\bcolon\\b", RegexOption.IGNORE_CASE), ":")
        var open = true
        text = Regex("(\\s*)\\b(?:parenthesis|parentheses)\\b(\\s*)", RegexOption.IGNORE_CASE)
            .replace(text) { match ->
                if (open) { open = false; match.groupValues[1] + "(" }
                else { open = true; ")" + match.groupValues[2] }
            }
        return text.replace(Regex(" {2,}"), " ")
    }

    fun parse(value: String, sections: List<JournalSection>): VoiceCapture {
        val catalog = sections.filter { it.type == "tag" }.flatMap { section ->
            section.tags.map { Triple(norm(it), section.id, norm(section.name)) }
        }
        val commands = mutableListOf<VoiceTagCommand>()
        val regex = Regex("\\btag\\s+([^,;.!?\\n]+?)(?=\\s+\\btag\\s+|[,;.!?\\n]|$)",
            RegexOption.IGNORE_CASE)
        var cleaned = regex.replace(punctuation(value)) { match ->
            var raw = norm(match.groupValues[1])
            val hint = sections.filter { it.type == "tag" }
                .sortedByDescending { it.name.length }
                .firstOrNull { raw == norm(it.name) || raw.startsWith(norm(it.name) + " ") }
            if (hint != null) raw = norm(raw.removePrefix(norm(hint.name)))
            val matches = catalog.filter { it.first == raw && (hint == null || it.second == hint.id) }
            val ids = matches.map { it.second }.distinct()
            commands += VoiceTagCommand(match.value, raw,
                if (ids.size == 1) ids.first() else hint?.id, ids,
                if (matches.isEmpty()) "new" else if (ids.size == 1) "matched" else "ambiguous")
            ""
        }
        cleaned = cleaned.replace(Regex("\\s+([,;.!?])"), "$1")
            .replace(Regex("([,;])\\s*([,;])"), "$2")
            .replace(Regex("[,;]\\s*([.!?])"), "$1")
            .replace(Regex("(^|\\n)\\s*[,;]\\s*"), "$1")
            .replace(Regex("[ \\t]{2,}"), " ").trim()
        return VoiceCapture(cleaned, commands)
    }

    /** Mirror journal.extract_mentions for immediate Android highlighting/tags. */
    fun inlineMentions(value: String, sections: List<JournalSection>): List<InlineMention> {
        val known = mutableMapOf<String, JournalSection>()
        sections.filter { it.type == "tag" }.forEach { section ->
            (section.mentionTags.ifEmpty { section.tags }).forEach { known[norm(it)] = section }
        }
        val mention = Regex("(?:^|(?<=\\W))@([A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*)")
        return mention.findAll(value).mapNotNull { match ->
            val token = match.groupValues[1]
            val direct = norm(token)
            val spaced = norm(token.replace('_', ' '))
            val name = when {
                direct in known -> direct
                spaced in known -> spaced
                else -> return@mapNotNull null
            }
            val section = known.getValue(name)
            InlineMention(name, section.id, section.color, match.range.first, match.range.last + 1)
        }.toList()
    }

    fun inlineTagMap(value: String, sections: List<JournalSection>): Map<String, List<String>> {
        val grouped = linkedMapOf<String, MutableList<String>>()
        inlineMentions(value, sections).forEach { mention ->
            val names = grouped.getOrPut(mention.sectionId) { mutableListOf() }
            if (mention.name !in names) names.add(mention.name)
        }
        return grouped
    }

    fun smartJoin(before: String, spoken: String, after: String): VoiceJoin {
        val text = spoken.trim(' ', '\t')
        val closing = setOf('.', ',', '!', '?', ';', ':', ')', ']', '}', '”', '’', '/')
        val opening = setOf('(', '[', '{', '“', '‘', '/')
        val lead = if (text.isNotEmpty() && before.isNotEmpty() &&
            !before.last().isWhitespace() && before.last() !in opening &&
            !text.first().isWhitespace() && text.first() !in closing) " " else ""
        val trail = if (text.isNotEmpty() && after.isNotEmpty() &&
            !text.last().isWhitespace() && text.last() !in opening &&
            !after.first().isWhitespace() && after.first() !in closing) " " else ""
        val caret = before.length + lead.length + text.length
        return VoiceJoin(before + lead + text + trail + after, caret)
    }

    fun suggestTitle(body: String, limit: Int = 60): String {
        var first = body.lineSequence().map(String::trim).firstOrNull(String::isNotEmpty) ?: return ""
        first = Regex("^.*?[.!?](?:\\s|$)").find(first)?.value ?: first
        first = first.replace(Regex("^(?:-\\s*)?\\[\\s*]\\s*"), "")
            .replace(Regex("\\s+>(?:today|tomorrow|[a-z]+|\\+\\d+[dwm]|\\d{4}-\\d{2}-\\d{2})\\b", RegexOption.IGNORE_CASE), "")
            .replace(Regex("\\[task:[0-9a-f]+]\\s*", RegexOption.IGNORE_CASE), "")
            .replace(Regex("\\*\\*|__|~~|\\*"), "")
            .replace(Regex("@([A-Za-z0-9_.-]+)")) { it.groupValues[1].replace('_', ' ') }
            .replace(Regex("\\s+"), " ").trim(' ', '.', ',', ':', ';', '!', '?', '-', '–', '—')
        if (first.length > limit) first = first.take(limit + 1).substringBeforeLast(' ', first.take(limit))
        return first.replaceFirstChar { it.uppercase() }
    }
}
