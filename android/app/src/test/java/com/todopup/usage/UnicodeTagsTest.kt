package com.todopup.usage

import org.junit.Assert.*
import org.junit.Test

class UnicodeTagsTest {
    private val han = "\uD840\uDC00"
    private val names = listOf("妈妈", "媽媽", "中文 english42", "閱讀 2026", "好友_甲.乙-3", "café", "２", "ⅳ", han)
    private val sections = listOf(JournalSection("people", "人物", "tag", "#e0a955",
        tags = names, mentionTags = listOf("old"), archivedTags = listOf("舊朋友")))

    @Test fun chineseAndMixedNamesNormalizeWithoutLosingCharacters() {
        for (name in names) assertEquals(name, JournalTagRegistry.normalizeName("  $name  "))
        assertEquals("中文 english42", JournalTagRegistry.normalizeName(" 中文 ENGLISH42 "))
        assertEquals("ⅳ", JournalTagRegistry.normalizeName("Ⅳ"))
        assertEquals(han.repeat(200), JournalTagRegistry.normalizeName(han.repeat(200)))
        assertThrows(IllegalArgumentException::class.java) { JournalTagRegistry.normalizeName(han.repeat(201)) }
    }
    @Test fun forbiddenMarkupControlsAndSymbolsRemainRejected() {
        for (name in listOf("", "中\n文", "中\t文", "中\u0000文", "中文<tag>", "中文/名", "中文@名", "朋友🙂", "e\u0301", "中\u200b文"))
            assertThrows(name, IllegalArgumentException::class.java) { JournalTagRegistry.normalizeName(name) }
    }
    @Test fun inlineChineseMentionsKeepUtf16OffsetsAndWordBoundaries() {
        val text = "🙂 @妈妈 @媽媽 @中文_english42 @$han @舊朋友 中@妈妈 ${han}@媽媽 _@妈妈 @unknown"
        val matches = VoiceCommands.inlineMentions(text, sections)
        assertEquals(listOf("妈妈", "媽媽", "中文 english42", han, "舊朋友"), matches.map { it.name })
        assertEquals(listOf("@妈妈", "@媽媽", "@中文_english42", "@$han", "@舊朋友"), matches.map { text.substring(it.start, it.end) })
        assertEquals(mapOf("people" to listOf("妈妈", "媽媽", "中文 english42", han, "舊朋友")), VoiceCommands.inlineTagMap(text, sections))
    }
    @Test fun supplementarySuggestionsCompleteAndRespectPrecedingCodepoints() {
        val value = "和 @$han"
        val suggestion = VoiceCommands.tagSuggestions(value, value.length, sections).single()
        assertEquals(han, suggestion.name)
        assertEquals(value, VoiceCommands.completeTag(value, value.length, suggestion).value)
        assertTrue(VoiceCommands.tagSuggestions("${han}@$han", 5, sections).isEmpty())
        assertEquals(listOf("媽媽"), VoiceCommands.tagSuggestions("@媽", 2, sections).map { it.name })
    }
    @Test fun dottedMentionsAndEmailTitlesUseTheSameBoundaries() {
        val catalog = listOf(JournalSection("people", "人物", "tag", "#e0a955", tags = listOf("媽媽", "例子.中文")))
        assertEquals(listOf("媽媽", "例子.中文"), VoiceCommands.inlineMentions("@媽媽. @例子.中文! a@例子.中文", catalog).map { it.name })
        assertEquals("Email a@例子.com", VoiceCommands.suggestTitle("Email a@例子.com"))
        assertEquals("和 媽媽 體重 60", VoiceCommands.suggestTitle("和 @媽媽 #體重 60"))
        assertEquals(han.repeat(60), VoiceCommands.suggestTitle(han.repeat(61)))
    }
    @Test fun spokenChineseNamesAndTitlesRemainReadable() {
        assertEquals(listOf("媽媽", han), VoiceCommands.autoTagMatches("和 媽媽 $han 散步", sections).map { it.name })
        assertEquals("妈妈", VoiceCommands.parse("tag 人物 妈妈", sections).commands.single().name)
        assertEquals("和 媽媽 $han 散步", VoiceCommands.suggestTitle("和 @媽媽 @$han 散步"))
        val chinese = listOf(JournalSection("place", "Places", "tag", "#e0a955", tags = listOf("臺北中正區")))
        assertTrue(VoiceCommands.autoTagMatches("臺北中山區", chinese).isEmpty())
    }
    @Test fun numericCaptureUsesUnicodeWordBoundariesWithoutChangingValues() {
        for (prefix in listOf("中文", han, "２", "ⅳ", "_", "a"))
            assertNull(prefix, VoiceCommands.inlineNumber("${prefix}#体重 65", "体重"))
        for (prefix in listOf("", " ", "\n", "🙂", "。"))
            assertEquals(65.0, VoiceCommands.inlineNumber("${prefix}#体重 65", "体重")!!, 0.0)
        assertEquals(-2.5, VoiceCommands.inlineNumber("#體重 -2.5", "體重")!!, 0.0)
        assertEquals(7.0, VoiceCommands.inlineNumber("#步行_時間 2 #步行_時間 7 中文#步行_時間 99", "步行 時間")!!, 0.0)
        assertNull(VoiceCommands.inlineNumber("#体重其他 65", "体重"))
    }
}
