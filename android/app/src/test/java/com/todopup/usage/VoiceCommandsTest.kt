package com.todopup.usage

import org.junit.Assert.assertEquals
import org.junit.Test

class VoiceCommandsTest {
    private val sections = listOf(
        JournalSection("people", "people", "tag", "#e0a955", tags = listOf("alex"),
            mentionTags = listOf("alex", "alex dad", "casey")),
        JournalSection("health", "health", "tag", "#e0a955", tags = listOf("gym")),
    )

    @Test fun punctuationMatchesDesktopGrammar() {
        assertEquals("@alex_dad\n#sleep_hours 8.", VoiceCommands.punctuation(
            "at symbol alex underscore dad new line hashtag sleep underscore hours 8 period"))
        assertEquals("[] call mom", VoiceCommands.punctuation("checkbox call mom"))
    }

    @Test fun repeatedTagsAreRemovedAndResolved() {
        val result = VoiceCommands.parse("Had lunch, tag Alex, then trained, tag gym.", sections)
        assertEquals("Had lunch, then trained.", result.text)
        assertEquals(listOf("alex", "gym"), result.commands.map { it.name })
        assertEquals(listOf("people", "health"), result.commands.map { it.sectionId })
    }

    @Test fun unknownTagUsesSectionHintAsTemporary() {
        val result = VoiceCommands.parse("tag health morning walk", sections)
        assertEquals("morning walk", result.commands.single().name)
        assertEquals("health", result.commands.single().sectionId)
        assertEquals("new", result.commands.single().status)
    }

    @Test fun titleSuggestionDoesNotReplaceGrammarWithNoise() {
        assertEquals("A really good morning with alex",
            VoiceCommands.suggestTitle("**A really good morning** with @alex. More text."))
        assertEquals("Call mom", VoiceCommands.suggestTitle("[] call mom >tomorrow"))
    }

    @Test fun smartSpacingMatchesDesktopInsertionRules() {
        assertEquals("hello.", VoiceCommands.smartJoin("hello", ".", "").value)
        assertEquals("hello world.", VoiceCommands.smartJoin("hello", "world", ".").value)
        assertEquals("(hello)", VoiceCommands.smartJoin("(", "hello", ")").value)
        assertEquals("path/home", VoiceCommands.smartJoin("path/", "home", "").value)
        assertEquals("hello\nworld", VoiceCommands.smartJoin("hello", "\nworld", "").value)
    }

    @Test fun inlineMentionsResolveKnownTagsWithWebBoundaries() {
        val body = "Met @alex and @alex_dad; not a@casey.com or @unknown."
        val matches = VoiceCommands.inlineMentions(body, sections)

        assertEquals(listOf("alex", "alex dad"), matches.map { it.name })
        assertEquals(listOf("people", "people"), matches.map { it.sectionId })
        assertEquals(listOf("@alex", "@alex_dad"), matches.map { body.substring(it.start, it.end) })
    }

    @Test fun inlineMentionsAreGroupedForImmediateTagReflection() {
        assertEquals(mapOf("people" to listOf("alex"), "health" to listOf("gym")),
            VoiceCommands.inlineTagMap("@alex met @gym and @alex", sections))
    }
}
