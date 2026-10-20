"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  hasUntitledSaveContent,
} = require("../static/journal-entry-convenience.js");

function formWith(fields, updated = "") {
  return {
    getAttribute(name) {
      return name === "data-entry-updated" ? updated : "";
    },
    querySelectorAll() {
      return fields;
    },
  };
}

test("a new tag lets a new entry save before its title is written", () => {
  const form = formWith([
    { name: "newtag-name:people", type: "text", value: "maya" },
  ]);

  assert.equal(hasUntitledSaveContent(form), true);
});

test("an empty new-tag input does not make an otherwise empty entry savable", () => {
  const form = formWith([
    { name: "newtag-name:people", type: "text", value: "   " },
  ]);

  assert.equal(hasUntitledSaveContent(form), false);
});
