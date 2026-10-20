package com.todopup.usage

data class VoiceTagCommand(
    val original: String,
    val name: String,
    var sectionId: String? = null,
    val sectionIds: List<String> = emptyList(),
    var status: String = "new",
    var keepAsText: Boolean = false,
    val source: String = "explicit",
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
data class TagSuggestion(
    val name: String,
    val sectionId: String,
    val color: String,
    val replaceStart: Int,
    val replaceEnd: Int,
)

object VoiceCommands {
    private fun norm(value: String) = value.trim().lowercase().replace(Regex("\\s+"), " ")
    private val spokenWord = Regex("[\\p{L}\\p{N}]+(?:'[\\p{L}]+)?")
    private val mentionToken = Regex("@([\\p{L}\\p{N}_-]+(?:\\.[\\p{L}\\p{N}_-]+)*)")
    private val suggestionToken = Regex("[\\p{L}\\p{N}_.-]+")
    private val wordCodePoint = Regex("[\\p{L}\\p{N}_]")
    private fun atBoundary(value: String, index: Int): Boolean = index == 0 ||
        !wordCodePoint.matches(String(Character.toChars(Character.codePointBefore(value, index))))

    fun inlineNumber(value: String, name: String): Double? {
        val pattern = Regex("#" + Regex.escape(name.replace(' ', '_')) + "\\s+(-?\\d+(?:\\.\\d+)?)", RegexOption.IGNORE_CASE)
        return pattern.findAll(value).filter { atBoundary(value, it.range.first) }.lastOrNull()
            ?.groupValues?.get(1)?.toDoubleOrNull()?.takeIf { it.isFinite() }
    }

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
        val existing = commands.map { it.name }.toMutableSet()
        autoTagMatches(cleaned, sections).groupBy { it.name }.forEach { (name, matches) ->
            if (!existing.add(name)) return@forEach
            val sectionIds = matches.map { it.sectionId }.distinct()
            commands += VoiceTagCommand(
                original = matches.first().spoken,
                name = name,
                sectionId = sectionIds.singleOrNull(),
                sectionIds = sectionIds,
                status = if (sectionIds.size == 1) "suggested" else "ambiguous",
                source = "detected",
            )
        }
        return VoiceCapture(cleaned, commands)
    }

    data class AutoTagMatch(
        val name: String,
        val sectionId: String,
        val spoken: String,
        val start: Int,
        val end: Int,
    )

    /** Find the first inflected/fuzzy occurrence of each known tag phrase. */
    fun autoTagMatches(value: String, sections: List<JournalSection>): List<AutoTagMatch> {
        val words = spokenWord.findAll(value).toList()
        val tags = sections.filter { it.type == "tag" }.flatMap { section ->
            (section.tags + section.mentionTags).map(::norm).filter(String::isNotBlank).distinct()
                .map { name -> section to name }
        }.sortedByDescending { (_, name) -> name.split(' ').size * 1000 + name.length }
        val seen = mutableSetOf<Pair<String, String>>()
        val matches = mutableListOf<AutoTagMatch>()
        tags.forEach { (section, name) ->
            if (!seen.add(section.id to name)) return@forEach
            val tagWords = name.split(' ')
            if (tagWords.isEmpty() || words.size < tagWords.size) return@forEach
            for (index in 0..words.size - tagWords.size) {
                val window = words.subList(index, index + tagWords.size)
                if (window.indices.all { similarWord(window[it].value.lowercase(), tagWords[it]) }) {
                    val start = window.first().range.first
                    val end = window.last().range.last + 1
                    matches += AutoTagMatch(name, section.id, value.substring(start, end), start, end)
                    break
                }
            }
        }
        return matches.sortedBy { it.start }
    }

    private fun similarWord(spoken: String, tag: String): Boolean {
        if (spoken == tag) return true
        if (!spoken.matches(Regex("[a-z]+")) || !tag.matches(Regex("[a-z]+"))) return false
        if (spoken in inflections(tag)) return true
        if (spoken.length < 5 || tag.length < 5 || spoken.firstOrNull() != tag.firstOrNull()) return false
        return kotlin.math.abs(spoken.length - tag.length) <= 1 && editDistanceAtMostOne(spoken, tag)
    }

    private fun inflections(word: String): Set<String> = buildSet {
        add(word)
        add(word + "s")
        add(word + "es")
        add(word + "ed")
        add(word + "ing")
        when {
            word.endsWith("e") && word.length > 2 -> {
                add(word + "d")
                add(word.dropLast(1) + "ing")
            }
            word.endsWith("y") && word.length > 2 -> {
                add(word.dropLast(1) + "ied")
                add(word.dropLast(1) + "ies")
            }
        }
        if (word.length >= 3 && word.last() !in "aeiouwxy" && word[word.lastIndex - 1] in "aeiou" &&
            word[word.lastIndex - 2] !in "aeiou") {
            add(word + word.last() + "ed")
            add(word + word.last() + "ing")
        }
    }

    private fun editDistanceAtMostOne(left: String, right: String): Boolean {
        if (left == right) return true
        if (kotlin.math.abs(left.length - right.length) > 1) return false
        var leftIndex = 0
        var rightIndex = 0
        var edits = 0
        while (leftIndex < left.length && rightIndex < right.length) {
            if (left[leftIndex] == right[rightIndex]) {
                leftIndex++
                rightIndex++
            } else {
                if (++edits > 1) return false
                when {
                    left.length > right.length -> leftIndex++
                    right.length > left.length -> rightIndex++
                    else -> { leftIndex++; rightIndex++ }
                }
            }
        }
        if (leftIndex < left.length || rightIndex < right.length) edits++
        return edits <= 1
    }

    fun tagSuggestions(
        value: String,
        cursor: Int,
        sections: List<JournalSection>,
        limit: Int = 6,
    ): List<TagSuggestion> {
        if (cursor !in 0..value.length) return emptyList()
        val before = value.substring(0, cursor)
        val at = before.lastIndexOf('@')
        if (at < 0 || !atBoundary(before, at)) return emptyList()
        val typed = before.substring(at + 1)
        if (typed.isNotEmpty() && !suggestionToken.matches(typed)) return emptyList()
        val query = norm(typed.replace('_', ' '))
        return sections.filter { it.type == "tag" }.flatMap { section ->
            (section.mentionTags + section.tags + section.archivedTags).map(::norm).filter(String::isNotBlank).distinct()
                .map { name -> TagSuggestion(name, section.id, section.color, at, cursor) }
        }.distinctBy { it.name to it.sectionId }
            .filter { query.isBlank() || it.name.startsWith(query) }
            .sortedWith(compareBy<TagSuggestion>({ it.name != query }, { it.name.length }, { it.name }))
            .take(limit)
    }

    fun completeTag(value: String, cursor: Int, suggestion: TagSuggestion): VoiceJoin {
        if (cursor != suggestion.replaceEnd || suggestion.replaceStart !in 0..cursor || cursor > value.length)
            return VoiceJoin(value, cursor.coerceIn(0, value.length))
        val mention = "@" + suggestion.name.replace(' ', '_')
        return VoiceJoin(
            value.substring(0, suggestion.replaceStart) + mention + value.substring(cursor),
            suggestion.replaceStart + mention.length,
        )
    }

    /** Mirror journal.extract_mentions for immediate Android highlighting/tags. */
    fun inlineMentions(value: String, sections: List<JournalSection>): List<InlineMention> {
        val known = mutableMapOf<String, JournalSection>()
        sections.filter { it.type == "tag" }.forEach { section ->
            (section.mentionTags + section.tags + section.archivedTags).distinct().forEach { known[norm(it)] = section }
        }
        return mentionToken.findAll(value).filter { atBoundary(value, it.range.first) }.mapNotNull { match ->
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
        first = mentionToken.replace(first) { if (atBoundary(first, it.range.first)) it.groupValues[1].replace('_', ' ') else it.value }
        first = Regex("#([\\p{L}\\p{N}_-]+)\\s+(-?\\d+(?:\\.\\d+)?)").replace(first) {
            if (atBoundary(first, it.range.first)) it.groupValues[1].replace('_', ' ') + " " + it.groupValues[2] else it.value
        }.replace(Regex("\\s+"), " ").trim(' ', '.', ',', ':', ';', '!', '?', '-', '–', '—')
        if (first.codePointCount(0, first.length) > limit) {
            val clipped = first.substring(0, first.offsetByCodePoints(0, limit + 1))
            first = clipped.substringBeforeLast(' ', first.substring(0, first.offsetByCodePoints(0, limit)))
        }
        return first.replaceFirstChar { it.uppercase() }
    }
}
