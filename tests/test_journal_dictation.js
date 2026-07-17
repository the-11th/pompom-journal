"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applyVoiceCommands,
  parseVoiceTagCommands,
  suggestEntryTitle,
  smartDictationJoin,
  adjustHighlightedRanges,
} = require("../static/journal-dictation.js");

test("converts spoken punctuation and inline-grammar commands", () => {
  assert.equal(
    applyVoiceCommands(
      "alex underscore dad colon left quote yes right quote slash maybe"
    ),
    "alex_dad: \u201cyes\u201d/maybe"
  );
});

test("new commands are case-insensitive and preserve useful outer spacing", () => {
  assert.equal(
    applyVoiceCommands("Say LEFT QUOTE hello RIGHT QUOTE now"),
    "Say \u201chello\u201d now"
  );
  assert.equal(applyVoiceCommands("one SLASH two"), "one/two");
});

test("existing voice commands keep their behavior", () => {
  assert.equal(
    applyVoiceCommands(
      "at symbol alex underscore dad new line hashtag sleep underscore hours 8 period"
    ),
    "@alex_dad\n#sleep_hours 8."
  );
  assert.equal(applyVoiceCommands("checkbox call mom"), "[] call mom");
});

const TAGS = [
  { section_id: "people", section_name: "people", name: "alex" },
  { section_id: "people", section_name: "people", name: "alex dad" },
  { section_id: "health", section_name: "health", name: "gym" },
];

test("extracts repeated tag commands without putting them in prose", () => {
  const out = parseVoiceTagCommands(
    "Had lunch, tag Alex, then trained, tag gym.", TAGS
  );
  assert.equal(out.text, "Had lunch, then trained.");
  assert.deepEqual(out.commands.map((c) => [c.name, c.section_id, c.status]), [
    ["alex", "people", "matched"],
    ["gym", "health", "matched"],
  ]);
});

test("voice tags use longest known name and accept a section hint", () => {
  let out = parseVoiceTagCommands("tag Alex dad, hello", TAGS);
  assert.equal(out.commands[0].name, "alex dad");
  assert.equal(out.text, "hello");

  out = parseVoiceTagCommands("tag health morning walk", TAGS);
  assert.equal(out.commands[0].name, "morning walk");
  assert.equal(out.commands[0].section_id, "health");
  assert.equal(out.commands[0].status, "new");
});

test("unknown voice tags remain pending for a section", () => {
  const out = parseVoiceTagCommands("Great day, tag coffee shop.", TAGS);
  assert.equal(out.text, "Great day.");
  assert.equal(out.commands[0].name, "coffee shop");
  assert.equal(out.commands[0].section_id, null);
  assert.equal(out.commands[0].status, "new");
});

test("suggested title is deterministic and omits inline grammar", () => {
  assert.equal(
    suggestEntryTitle("\n**A really good morning** with @alex. More text."),
    "A really good morning with alex"
  );
  assert.equal(suggestEntryTitle("[] call mom >tomorrow"), "Call mom");
  assert.equal(suggestEntryTitle("   "), "");
});

test("smart dictation spacing glues punctuation and brackets correctly", () => {
  assert.equal(smartDictationJoin("hello", ".", "").value, "hello.");
  assert.equal(smartDictationJoin("hello", "world", ".").value, "hello world.");
  assert.equal(smartDictationJoin("(", "hello", ")").value, "(hello)");
  assert.equal(smartDictationJoin("hello", "“world”", "again").value,
    "hello “world” again");
  assert.equal(smartDictationJoin("path/", "home", "").value, "path/home");
  assert.equal(smartDictationJoin("hello", "\nworld", "").value, "hello\nworld");
});

test("manual edits rebase highlighted speech ranges without covering typed text", () => {
  // Insert X inside a dictated run: preserve the spoken text on both sides but
  // leave the manually typed character unhighlighted.
  assert.deepEqual(adjustHighlightedRanges("abcdef", "abcXdef", [[1, 5]]), [
    [1, 3], [4, 6],
  ]);
  // Delete text before a later dictated run: shift that run left.
  assert.deepEqual(adjustHighlightedRanges("one two spoken", "one spoken", [[8, 14]]), [
    [4, 10],
  ]);
  // Deleting inside a run never resurrects the deleted characters.
  assert.deepEqual(adjustHighlightedRanges("spoken words", "spoken ords", [[0, 12]]), [
    [0, 7], [7, 11],
  ]);
});
