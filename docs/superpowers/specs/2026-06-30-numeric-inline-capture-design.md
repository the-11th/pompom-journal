# `#numeric` Inline Capture — Design

**Date:** 2026-06-30
**Status:** Approved (brainstorming complete)
**Scope:** Spec 1 of a 3-feature sequence (**this** → `[]` inline task spawning →
leading-indicators analytics). Journal-only. No data-model migration, no new deps.

## Summary

The direct sibling of `@mention` tagging, for the **numeric** half of the entry
model. Typing `#sectionname value` in the journal entry body fills that numeric
section for the day — `#weight 175`, `#hours_slept 7.5`, `#coffee 3`. It mirrors
the `@mention` pipeline almost exactly: a name→section index, a body extractor, a
client-side highlight + reflect-into-control on blur, and a server-side merge on
save.

Mnemonic (and the framing for the README cheat-sheet): **`@` = who/what (tags),
`#` = how much (numbers).**

## Locked decisions (from brainstorming)

1. **Sigil + grammar:** `#` at a word boundary, then a name (`[A-Za-z0-9_-]+`),
   then whitespace, then a number (`-?\d+(\.\d+)?`). Example matches:
   `#weight 175`, `weighed in at #weight 175 today`, `#hours_slept 7.5`,
   `#mood_proxy -2`. The leading word-boundary rule mirrors `_MENTION_RE` so
   `a#b` does not match. Only whitespace separates name and value in v1 (no
   `:`/`=` — YAGNI; can extend later).
2. **Match existing numeric sections only.** A `#name` is captured only when
   `name` resolves to an **active numeric section**. Unknown `#foo` stays plain
   text. No on-the-fly section creation (mirrors `@mention` not creating tags —
   numeric sections need name + unit + color, too much for inline).
3. **Underscore→space resolution.** `#hours_slept` matches a section named
   "hours slept", reusing the same fallback logic as `_resolve_mention`. A
   section literally named with underscores wins over the spaced form when both
   exist.
4. **Last occurrence wins.** If a section is written more than once in the body
   (`#coffee 2 ... #coffee 3`), the last value wins (a correction reads
   naturally). Tags dedupe first-seen; numbers take the latest because there is
   one value per section/day.
5. **Precedence = "body reflects into the field; explicit field is source of
   truth" (option A).**
   - **Client (on blur):** for each recognized `#name value`, write the parsed
     value into that section's `num:{sid}` input (overwrite, visible) — the
     numeric analogue of mentions ticking chips.
   - **Server (authoritative):** read the explicit `num:{sid}` fields as today,
     then parse the body and fill **only** sections that have no explicit field
     value — a no-JS fallback. Net effect: the body value lands; a later hand-edit
     of the field wins.
6. **Highlight rendering:** recognized `#name value` renders as a colored span in
   the section's `color`, showing `name value` (the `#` is dropped, like mentions
   drop `@`); the section's `unit` is appended when present (`weight 175 lbs`).
   Re-uses the click-to-edit body renderer.

## Data model — unchanged

- Entry `body` stays plain text holding the raw `#weight 175` verbatim; the
  capture is render-time + save-time only.
- Entry `numbers` stays `{section_id: float}`. Inline values are persisted by
  setting `numbers[sid]` on save (validated by the existing `upsert_entry`
  cleaning path). No new fields, no new store key → `load()` / `_empty()`
  unchanged, no migration.

## Pure helpers (`journal.py`, zero Flask)

Siblings of `tag_section_index` / `extract_mentions`:

```python
_NUMERIC_RE = re.compile(
    r"(?:^|(?<=\W))#([A-Za-z0-9_-]+)\s+(-?\d+(?:\.\d+)?)"
)

def numeric_section_index(data):
    """{normalized_name: sid} over ACTIVE numeric sections only.
    Mirror of tag_section_index (but no tag-list overlay — a numeric section
    has just a name). Names normalized via _normalize_name (strip+lower)."""

def extract_numbers(body, index):
    """Find #name value tokens in `body` matching a known numeric section.
    Returns {sid: float}. Name resolved via the mention rule (as-is, then
    underscores→spaces). Unknown names dropped. Last write per section wins.
    Value parsed with float()."""
```

No `merge` helper: the save route applies `extract_numbers` output with
field-wins precedence directly (see route changes). `extract_numbers` is
defensive — a value that fails `float()` (shouldn't, given the regex) is skipped.

## Route change (`app.py` `journal_save`)

Immediately after the existing field collection + tag-mention union, before
`upsert_entry`:

```python
# Inline #numeric capture from the body (fills only untouched sections).
nidx = journal.numeric_section_index(data)
body_numbers = journal.extract_numbers(body, nidx)
for sid, val in body_numbers.items():
    base_numbers.setdefault(sid, val)   # explicit field value wins
```

`base_numbers` already has explicit `num:{sid}` values merged in (lines ~658-661
today), so `setdefault` cleanly encodes "field wins, body fills the gap." Only
active sections are considered (index is active-only), preserving the existing
archived-section preservation behavior.

## Client mirror (`static/journal-richtext.js`)

The file already mirrors `extract_mentions`/`_resolve_mention` and reflects into
the chip area. Add a parallel, equally self-contained numeric path:

- **Index source:** a new `<script type="application/json" id="numeric-index">`
  blob in `journal_entry.html` carrying `{name: {sid, color, unit}}` (built by a
  small route-side helper analogous to the existing `mention_index`).
- **Highlight:** in the same blur-render pass, wrap recognized `#name value` in a
  `<span class="numeric-highlight" style="--tag-bg: <color>">name value
  unit</span>`. Reuse the `.mention-highlight` CSS pattern; add a
  `.numeric-highlight` rule in `style.css` (may simply share styling).
- **Reflect into field:** after rendering, for each recognized token set
  `document.querySelector('input[name="num:<sid>"]').value = parsedValue`.
  Additive in spirit (removing the text does not clear the field; matches
  mentions never un-ticking a chip).

The HTML5 `type="number"` field already accepts the reflected value; no new
control, so the dark-theme styling mandate is satisfied by the existing
`.num-field` styling. No native widgets introduced.

## Edge cases

- **No-JS:** server `extract_numbers` + `setdefault` still lands the body value.
- **Both set, JS on:** blur reflects body→field; a later manual field edit wins
  at save (server sees the field populated, `setdefault` is a no-op).
- **Stale body text:** `#weight 175` left in old prose re-applies on every save —
  acceptable and consistent with mentions re-adding their tag on every save.
- **Section named purely numerically** (e.g. "2"): theoretically ambiguous with a
  value; out of scope (numeric section names are descriptive in practice).
- **Negative / decimal:** supported by the regex (`-?\d+(\.\d+)?`).
- **Value out of any expected range:** stored as-is; `upsert_entry` only
  validates that it is a finite number, consistent with the explicit field.

## Testing (TDD, fixed `now` not needed — pure string/number logic)

`tests/test_journal.py`:
- `numeric_section_index`: active-only, normalization, ignores tag sections.
- `extract_numbers`: word-boundary (`a#b 1` no match), underscore→space,
  unknown-name dropped, last-write-wins, negatives/decimals, multiple sections.
- Tag (`@`) and numeric (`#`) extraction are independent and don't interfere in
  one body.

`tests/test_journal_app.py`:
- Save with body `#weight 175`, empty field → entry `numbers` has the value.
- Save with body `#weight 175` **and** field `180` → field wins (180).
- Save with unknown `#foo 9` → ignored, no spurious section.
- Round-trip: saved entry re-renders with the field populated.

## README cheat-sheet (Task #4, this slice)

Add a **"Special features / power input"** section near the bottom of the README
documenting the inline grammar shipped so far: `@mention` tagging and `#numeric`
capture, each with a one-line "how to use" and an example. Subsequent specs
(`[]` tasks) append their row to the same section.

## Out of scope

- Inline numeric capture in **task** titles/notes (journal-only).
- On-the-fly numeric **section creation** from the body.
- `:`/`=` separators, units typed inline, ranges, or arithmetic.
