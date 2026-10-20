package com.todopup.usage

import org.junit.Assert.assertEquals
import org.junit.Test

class VoiceCommandsTest {
    private val sections = listOf(
        JournalSection("people", "people", "tag", "#e0a955", tags = listOf("alex"),
            mentionTags = listOf("alex", "alex dad", "casey")),
        JournalSection("health", "health", "tag", "#e0a955",
            tags = listOf("gym", "wash hair", "morning walk")),
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
        val result = VoiceCommands.parse("tag health sunrise stretch", sections)
        assertEquals("sunrise stretch", result.commands.single().name)
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

    @Test fun smartJoinReplacesOnlyTheSelectedWordAndKeepsTheCaretAfterInsertion() {
        val result = VoiceCommands.smartJoin("I need to ", "washed my hair", " yesterday")
        assertEquals("I need to washed my hair yesterday", result.value)
        assertEquals("I need to washed my hair".length, result.caret)
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

    @Test fun spokenInflectionsSuggestTheFirstMatchingKnownTag() {
        val capture = VoiceCommands.parse(
            "I washed hair after breakfast, then washed hair again.", sections)

        assertEquals("I washed hair after breakfast, then washed hair again.", capture.text)
        assertEquals(listOf("wash hair"), capture.commands.map { it.name })
        assertEquals(listOf("health"), capture.commands.map { it.sectionId })
        assertEquals(listOf("suggested"), capture.commands.map { it.status })
    }

    @Test fun spokenTagSuggestionsPreferLongestPhraseAndIgnoreUnrelatedWords() {
        val capture = VoiceCommands.parse(
            "A morning walked route was nice, but the gymnasium was closed.", sections)

        assertEquals(listOf("morning walk"), capture.commands.map { it.name })
    }

    @Test fun atTagSuggestionsUseTheCursorAndCompleteWithUnderscores() {
        val suggestions = VoiceCommands.tagSuggestions(
            "Today I met @al before lunch", "Today I met @al".length, sections)
        assertEquals(listOf("alex", "alex dad"), suggestions.map { it.name })

        val completed = VoiceCommands.completeTag(
            "Today I met @al before lunch", "Today I met @al".length,
            suggestions[1])
        assertEquals("Today I met @alex_dad before lunch", completed.value)
        assertEquals("Today I met @alex_dad".length, completed.caret)
    }

    @Test fun atTagSuggestionsDisappearWhenCursorLeavesTheMention() {
        assertEquals(emptyList<TagSuggestion>(), VoiceCommands.tagSuggestions(
            "Today I met @alex before lunch", "Today I met".length, sections))
        assertEquals(emptyList<TagSuggestion>(), VoiceCommands.tagSuggestions(
            "email me at julia@example.com", "email me at julia@example".length, sections))
    }

    @Test fun continuousTranscriptKeepsFinalSegmentsAcrossRecognizerRestarts() {
        val transcript = ContinuousTranscript()
        transcript.updatePartial("Today I washed")
        assertEquals("Today I washed", transcript.value())
        transcript.commit("Today I washed my hair")
        transcript.updatePartial("and went outside")
        assertEquals("Today I washed my hair and went outside", transcript.value())
        transcript.commit("and went outside")
        assertEquals("Today I washed my hair and went outside", transcript.value())
    }

    @Test fun continuousTranscriptDoesNotDuplicateARepeatedFinalResult() {
        val transcript = ContinuousTranscript()
        transcript.commit("A calm morning")
        transcript.commit("A calm morning")
        assertEquals("A calm morning", transcript.value())
    }
}
