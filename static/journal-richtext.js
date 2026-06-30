/* journal-richtext.js — click-to-edit rich rendering for the entry body.
   Vanilla JS only, no third-party libraries.

   The body field is a <textarea> while focused (raw markup) and renders the
   formatted + mention-colored result in place on blur; clicking the rendered
   view returns to the textarea.

   Supported inline markup (Discord-style):
     **bold**   *italic*   __underline__   ~~strikethrough~~
   Nesting of DIFFERENT markers is supported; malformed overlaps render
   literally. @mentions whose normalized name is a known tag are colored by
   their section. The raw body is HTML-escaped first so it can never inject
   markup.
*/

(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Guard + DOM references                                               */
  /* ------------------------------------------------------------------ */

  var field    = document.querySelector('.body-field');
  if (!field) return;
  var input    = field.querySelector('.body-input');
  var rendered = field.querySelector('.body-rendered');
  if (!input || !rendered) return;

  var indexEl = document.getElementById('mention-index');
  var INDEX   = {};
  if (indexEl) {
    try { INDEX = JSON.parse(indexEl.textContent || '{}') || {}; }
    catch (e) { INDEX = {}; }
  }

  // Numeric (#name value) index: {name: {section_id, color, unit}}.
  var numIndexEl = document.getElementById('numeric-index');
  var NUM_INDEX  = {};
  if (numIndexEl) {
    try { NUM_INDEX = JSON.parse(numIndexEl.textContent || '{}') || {}; }
    catch (e) { NUM_INDEX = {}; }
  }

  /* ------------------------------------------------------------------ */
  /* Helpers                                                              */
  /* ------------------------------------------------------------------ */

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function normalize(name) {
    return (name || '').trim().toLowerCase();
  }

  // Mirror journal.extract_mentions: '@' at a word boundary (start of string
  // or preceded by a non-word char) followed by [A-Za-z0-9_-]+.
  var MENTION_RE = /(^|\W)@([A-Za-z0-9_-]+)/g;

  // Resolve a mention token to a known tag name in INDEX, or null. Mirrors
  // journal._resolve_mention: try the token as-is, then with underscores as
  // spaces (so `@alex_dad` matches a multi-word tag `alex dad`); literal wins.
  function resolveMention(token) {
    var direct = normalize(token);
    if (INDEX[direct]) return direct;
    var spaced = normalize(token.replace(/_/g, ' '));
    if (INDEX[spaced]) return spaced;
    return null;
  }

  // Mirror journal._NUMERIC_RE: '#' at a word boundary, a name [A-Za-z0-9_-]+,
  // whitespace, then a number (-?\d+(\.\d+)?). So `a#b 1` does not match.
  var NUMERIC_RE = /(^|\W)#([A-Za-z0-9_-]+)\s+(-?\d+(?:\.\d+)?)/g;

  // Resolve a numeric token to a known section name in NUM_INDEX, or null.
  // Mirrors journal._resolve_mention (as-is, then underscores -> spaces;
  // literal-underscore section wins).
  function resolveNumeric(token) {
    var direct = normalize(token);
    if (NUM_INDEX[direct]) return direct;
    var spaced = normalize(token.replace(/_/g, ' '));
    if (NUM_INDEX[spaced]) return spaced;
    return null;
  }

  // Apply the four inline markers to already-HTML-escaped text. Longest tokens
  // first so '**'/'__'/'~~' are not mis-read as their single-char cousins.
  // Each pass is non-greedy and forbids the delimiter inside, so malformed
  // overlaps (e.g. "**bold _italic** text_") are left literal. Different
  // markers nest because each replacement leaves the inner markers intact for
  // the next pass.
  var MARKERS = [
    { re: /\*\*([^]+?)\*\*/g, tag: 'strong' },
    { re: /__([^]+?)__/g,     tag: 'u' },
    { re: /~~([^]+?)~~/g,     tag: 's' },
    { re: /\*([^*]+?)\*/g,    tag: 'em' }
  ];

  function applyMarkers(html) {
    for (var i = 0; i < MARKERS.length; i++) {
      var m = MARKERS[i];
      html = html.replace(m.re, '<' + m.tag + '>$1</' + m.tag + '>');
    }
    return html;
  }

  // Wrap recognized @mentions in a colored span showing the tag's name WITHOUT
  // the leading '@'. Runs on escaped text; the displayed name comes from the
  // controlled index (allowlisted tag chars) and the color is controlled, so
  // the result stays safe.
  function applyMentions(html) {
    return html.replace(MENTION_RE, function (match, boundary, name) {
      var key = resolveMention(name);
      if (!key) return match;
      return boundary +
        '<span class="mention-highlight" style="--tag-bg: ' + INDEX[key].color + '">' +
        escapeHtml(key) + '</span>';
    });
  }

  // Wrap recognized #name value tokens in a colored span showing "name value
  // unit" WITHOUT the leading '#' (the numeric analogue of applyMentions). Runs
  // on escaped text; the displayed name/unit come from the controlled index
  // (allowlisted chars) and the value is captured by the numeric regex, so the
  // result stays safe.
  function applyNumbers(html) {
    return html.replace(NUMERIC_RE, function (match, boundary, name, value) {
      var key = resolveNumeric(name);
      if (!key) return match;
      var info = NUM_INDEX[key];
      var unit = info.unit ? ' ' + info.unit : '';
      return boundary +
        '<span class="numeric-highlight" style="--tag-bg: ' + info.color + '">' +
        escapeHtml(key) + ' ' + escapeHtml(value) + escapeHtml(unit) + '</span>';
    });
  }

  function render(raw, index) {
    INDEX = index || INDEX;
    var html = escapeHtml(raw);
    html = applyMarkers(html);
    html = applyMentions(html);
    html = applyNumbers(html);
    // Preserve author line breaks in the rendered (block) view.
    html = html.replace(/\n/g, '<br>');
    return html;
  }

  // Reflect recognized #name value tokens into their numeric section's
  // input[name="num:<sid>"] field (overwrite, visible) — the numeric analogue
  // of mentions ticking chips. Last occurrence per section wins. Additive in
  // spirit: removing the text does not clear the field.
  function reflectNumbers(raw) {
    var re = /(^|\W)#([A-Za-z0-9_-]+)\s+(-?\d+(?:\.\d+)?)/g;  // own lastIndex
    var m, values = {};
    while ((m = re.exec(raw)) !== null) {
      var key = resolveNumeric(m[2]);
      if (!key) continue;
      values[NUM_INDEX[key].section_id] = m[3];   // last write wins
    }
    Object.keys(values).forEach(function (sid) {
      var field = document.querySelector('input[name="num:' + sid + '"]');
      if (field) field.value = values[sid];
    });
  }

  /* ------------------------------------------------------------------ */
  /* Chip reconciliation                                                  */
  /* ------------------------------------------------------------------ */

  // Reflect recognized @mentions in the "Tag the day" chip area: tick the
  // matching chip, or inject a checked dashed temp chip for a tag that has no
  // chip yet. Purely additive / non-destructive (Q4): removing a mention never
  // unticks a chip — the user unticks manually.
  function selectChip(sectionId, name) {
    var section = document.querySelector('.section[data-section-id="' + sectionId + '"]');
    if (!section) return;
    var chips = section.querySelector('.chips');
    if (!chips) return;

    var boxes = chips.querySelectorAll('input[type="checkbox"]');
    for (var i = 0; i < boxes.length; i++) {
      if (normalize(boxes[i].value) === name) {   // already has a chip
        boxes[i].checked = true;
        return;
      }
    }
    // No chip for this (temporary) tag yet — add a dashed, checked one,
    // mirroring how the template renders temp chips. createTextNode keeps it
    // injection-safe regardless of the (already-normalized) name.
    var label = document.createElement('label');
    label.className = 'chip temp tag-toggle';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.name = 'tag:' + sectionId;
    cb.value = name;
    cb.checked = true;
    label.appendChild(cb);
    label.appendChild(document.createTextNode(' ' + name));
    chips.appendChild(label);
  }

  function reconcileChips(raw) {
    var re = /(^|\W)@([A-Za-z0-9_-]+)/g;   // own regex: don't share lastIndex
    var m, seen = {};
    while ((m = re.exec(raw)) !== null) {
      var name = resolveMention(m[2]);     // canonical tag name (spaces, no @)
      if (!name) continue;
      var hit = INDEX[name];
      var dedupe = hit.section_id + '|' + name;
      if (seen[dedupe]) continue;
      seen[dedupe] = true;
      selectChip(hit.section_id, name);
    }
  }

  /* ------------------------------------------------------------------ */
  /* View swapping                                                        */
  /* ------------------------------------------------------------------ */

  function showRendered() {
    rendered.innerHTML = render(input.value, INDEX);
    reconcileChips(input.value);
    reflectNumbers(input.value);
    rendered.hidden = false;
    input.hidden = true;
  }

  function showInput(focus) {
    input.hidden = false;
    rendered.hidden = true;
    if (focus) input.focus();
  }

  input.addEventListener('focus', function () { showInput(false); });
  input.addEventListener('blur', showRendered);
  rendered.addEventListener('click', function () { showInput(true); });

  // Initial state: render if there's content, else stay in the textarea.
  if ((input.value || '').trim() !== '') {
    showRendered();
  } else {
    showInput(false);
  }

  // Expose the renderer for manual verification / future reuse.
  window.journalRender = render;
})();
