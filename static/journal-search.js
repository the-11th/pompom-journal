/* journal-search.js — live client-side filtering for the Search tab.
   Vanilla JS only, no third-party libraries.

   Filter types:
     - Text: whitespace-split query → whole-word, case-insensitive AND match
             against the entry title + body.
     - Tags: multi-select dropdown, OR semantics (entry passes if any selected
             tag is in entry.tags).
     - Numbers: per numeric section dual-range slider; active only when a
                handle is moved in from the bounds; entries without a value
                for an active section are excluded.
   All three types combine with AND.
*/

(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Guard: bail if we're not on the search page                          */
  /* ------------------------------------------------------------------ */

  var entriesEl = document.getElementById('entries-data');
  if (!entriesEl) return;

  var boundsEl = document.getElementById('bounds-data');
  var ENTRIES  = JSON.parse(entriesEl.textContent || '[]');
  var BOUNDS   = boundsEl ? JSON.parse(boundsEl.textContent || '{}') : {};

  /* ------------------------------------------------------------------ */
  /* DOM references                                                       */
  /* ------------------------------------------------------------------ */

  var qInput      = document.getElementById('q');
  var entryList   = document.getElementById('entry-list');
  var resultCount = document.querySelector('.result-count');
  var rowsById = new Map();
  if (entryList) entryList.querySelectorAll('.entry-row').forEach(function (row) { rowsById.set(row.dataset.id, row); });
  var searchRecords = ENTRIES.map(function (entry) {
    return { entry: entry, row: rowsById.get(String(entry.id)),
      text: ((entry.title || '') + ' ' + (entry.body || '')).normalize('NFC'),
      lines: (entry.body || '').normalize('NFC').split(/\r?\n/) };
  });

  /* ------------------------------------------------------------------ */
  /* Helpers                                                              */
  /* ------------------------------------------------------------------ */

  /** Escape regex special chars so user text is treated as a literal. */
  function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function wordPattern(words, global) {
    var terms = words.slice().sort(function (a, b) { return b.length - a.length; }).map(escapeRegExp).join('|');
    return new RegExp('(^|[^\\p{L}\\p{M}\\p{N}_])(' + terms + ')(?=$|[^\\p{L}\\p{M}\\p{N}_])', global ? 'giu' : 'iu');
  }

  /** Concise context from the first body line containing a query word
   * (whole-word, case-insensitive). '' if none match. */
  function matchingBodyLine(record, matchers) {
    if (!matchers.length) return '';
    var lines = record.lines;
    for (var i = 0; i < lines.length; i++) {
      var first = null;
      for (var j = 0; j < matchers.length; j++) {
        var match = matchers[j].exec(lines[i]);
        if (match && (!first || match.index + match[1].length < first.start)) first = {start: match.index + match[1].length, length: match[2].length};
      }
      if (first) {
        var line = lines[i], start = Math.max(0, first.start - 60), end = Math.min(line.length, Math.max(first.start + first.length, start + 240));
        if (start > 0 && /\S/.test(line[start - 1]) && /\S/.test(line[start])) {
          var leadingSpace = line.slice(start, first.start).search(/\s/);
          if (leadingSpace !== -1) start += leadingSpace + 1;
        }
        if (end < line.length && /\S/.test(line[end - 1]) && /\S/.test(line[end])) {
          var trailingWord = /\s+\S*$/.exec(line.slice(first.start + first.length, end));
          if (trailingWord) end = first.start + first.length + trailingWord.index;
        }
        // Do not split a surrogate pair at either preview boundary.
        if (start > 0 && /[\uDC00-\uDFFF]/.test(line[start])) start++;
        if (end < line.length && /[\uDC00-\uDFFF]/.test(line[end])) end--;
        return (start ? '… ' : '') + line.slice(start, end).trim() + (end < line.length ? ' …' : '');
      }
    }
    return '';
  }

  /** Renders `line` as HTML with every query word wrapped in a highlight span
   * (whole-word, case-insensitive; text otherwise HTML-escaped). */
  function highlightWords(line, re) {
    line = line.normalize('NFC');
    if (!re) return escapeHtml(line);
    re.lastIndex = 0;
    var html = '', last = 0, m;
    while ((m = re.exec(line)) !== null) {
      html += escapeHtml(line.slice(last, m.index + m[1].length));
      html += '<span class="suggest-hl">' + escapeHtml(m[2]) + '</span>';
      last = re.lastIndex;
    }
    html += escapeHtml(line.slice(last));
    return html;
  }

  /* ------------------------------------------------------------------ */
  /* Filter function                                                      */
  /* ------------------------------------------------------------------ */

  function applyFilters() {
    var q       = qInput ? qInput.value : '';
    var words   = q.normalize('NFC').trim().split(/\s+/).filter(Boolean);
    var matchers = words.map(function (word) { return wordPattern([word], false); });
    var highlights = words.length ? wordPattern(words, true) : null;
    var selTags = getSelectedTags();
    var ranges  = getActiveRanges();

    var count = 0;

    searchRecords.forEach(function (record) {
      var entry = record.entry;
      var visible = true;

      /* ---- Text filter: AND over whole-word matches in title + body ---- */
      if (words.length > 0) {
        var haystack = record.text;
        for (var i = 0; i < words.length; i++) {
          if (!matchers[i].test(haystack)) {
            visible = false;
            break;
          }
        }
      }

      /* ---- Tag filter: OR semantics ---- */
      if (visible && selTags.size > 0) {
        var entryTagSet = new Set(entry.tags || []);
        var intersects = false;
        selTags.forEach(function (t) {
          if (entryTagSet.has(t)) intersects = true;
        });
        if (!intersects) visible = false;
      }

      /* ---- Numeric range filters ---- */
      if (visible) {
        for (var sid in ranges) {
          if (!ranges.hasOwnProperty(sid)) continue;
          var r = ranges[sid];
          var nums = entry.numbers || {};
          if (!(sid in nums)) {
            // No value for this section → excluded when filter is active
            visible = false;
            break;
          }
          var val = nums[sid];
          if (val < r.lo || val > r.hi) {
            visible = false;
            break;
          }
        }
      }

      /* ---- Show / hide row ---- */
      var row = record.row;
      if (row) {
        row.style.display = visible ? '' : 'none';

        /* ---- Body-line snippet for the active text search ---- */
        var snippetEl = row.querySelector('.entry-snippet');
        if (snippetEl) {
          var line = words.length ? matchingBodyLine(record, matchers) : '';
          if (line) {
            snippetEl.innerHTML = highlightWords(line, highlights);
            snippetEl.hidden = false;
          } else {
            snippetEl.innerHTML = '';
            snippetEl.hidden = true;
          }
        }
      }
      if (visible) count++;
    });

    /* ---- Update result count ---- */
    if (resultCount) {
      resultCount.textContent = count === 1 ? '1 entry' : count + ' entries';
    }
  }

  /* ------------------------------------------------------------------ */
  /* Tag dropdown                                                          */
  /* ------------------------------------------------------------------ */

  var dropdownBtn   = document.querySelector('.tag-dropdown-btn');
  var dropdownPanel = document.querySelector('.tag-dropdown-panel');

  function positionDropdown() {
    if (!dropdownBtn || !dropdownPanel || dropdownPanel.hidden) return;
    var box = dropdownBtn.getBoundingClientRect(), gutter = 16;
    dropdownPanel.style.position = 'fixed';
    dropdownPanel.style.minWidth = Math.min(200, innerWidth - 2 * gutter) + 'px';
    dropdownPanel.style.maxWidth = Math.min(340, innerWidth - 2 * gutter) + 'px';
    dropdownPanel.style.maxHeight = Math.min(360, innerHeight - 2 * gutter) + 'px';
    var width = dropdownPanel.offsetWidth, height = dropdownPanel.offsetHeight;
    var top = box.bottom + 6;
    if (top + height > innerHeight - gutter && box.top - height - 6 >= gutter) top = box.top - height - 6;
    dropdownPanel.style.left = Math.max(gutter, Math.min(box.left, innerWidth - width - gutter)) + 'px';
    dropdownPanel.style.top = Math.max(gutter, Math.min(top, innerHeight - height - gutter)) + 'px';
  }

  function getSelectedTags() {
    var sel = new Set();
    if (!dropdownPanel) return sel;
    dropdownPanel.querySelectorAll('input[type="checkbox"][data-tag]').forEach(function (cb) {
      if (cb.checked) sel.add(cb.getAttribute('data-tag'));
    });
    return sel;
  }

  function openDropdown() {
    if (!dropdownPanel) return;
    dropdownPanel.hidden = false;
    if (dropdownBtn) dropdownBtn.setAttribute('aria-expanded', 'true');
    positionDropdown();
    var first = dropdownPanel.querySelector('input[type="checkbox"]');
    if (first) first.focus();
    document.addEventListener('click', outsideDropdownClick);
    document.addEventListener('keydown', dropdownEsc);
  }

  function closeDropdown() {
    if (!dropdownPanel) return;
    dropdownPanel.hidden = true;
    if (dropdownBtn) dropdownBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', outsideDropdownClick);
    document.removeEventListener('keydown', dropdownEsc);
  }

  function outsideDropdownClick(e) {
    var dropdown = document.querySelector('.tag-dropdown');
    if (dropdown && !dropdown.contains(e.target)) {
      closeDropdown();
    }
  }

  function dropdownEsc(e) {
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopImmediatePropagation(); closeDropdown();
      if (dropdownBtn) dropdownBtn.focus();
    }
  }

  if (dropdownBtn) {
    dropdownBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (!dropdownPanel.hidden) {
        closeDropdown();
      } else {
        openDropdown();
      }
    });
  }

  if (dropdownPanel) {
    window.addEventListener('resize', positionDropdown);
    document.addEventListener('scroll', positionDropdown, true);
    dropdownPanel.addEventListener('change', function () {
      applyFilters();
    });
    dropdownPanel.parentElement.addEventListener('focusout', function () {
      setTimeout(function () {
        if (!dropdownPanel.parentElement.contains(document.activeElement)) closeDropdown();
      }, 0);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Dual-range sliders                                                   */
  /* ------------------------------------------------------------------ */

  function getActiveRanges() {
    var ranges = {};
    document.querySelectorAll('.num-filter:not(.num-filter-disabled)').forEach(function (block) {
      var minInput = block.querySelector('input[data-role="min"]');
      var maxInput = block.querySelector('input[data-role="max"]');
      if (!minInput || !maxInput) return;

      var sid      = minInput.getAttribute('data-section');
      var bounds   = BOUNDS[sid];
      if (!bounds) return;

      var boundMin = bounds[0];
      var boundMax = bounds[1];
      var lo       = parseFloat(minInput.value);
      var hi       = parseFloat(maxInput.value);

      // Filter is active only if a handle has been moved in from the bounds
      if (lo > boundMin || hi < boundMax) {
        ranges[sid] = { lo: lo, hi: hi };
      }
    });
    return ranges;
  }

  // Round to at most three decimal places (trailing zeros dropped).
  function round3(n) {
    if (!isFinite(n)) return n;
    return Math.round(n * 1000) / 1000;
  }

  function updateRangeReadout(minInput, maxInput) {
    var sid   = minInput.getAttribute('data-section');
    var block = minInput.closest('.num-filter');
    var lo    = parseFloat(minInput.value);
    var hi    = parseFloat(maxInput.value);

    // Reflect the slider values into the number inputs (rounded), but never
    // clobber a field the user is actively typing in.
    if (block) {
      var minNum = block.querySelector('input[data-role="min-num"]');
      var maxNum = block.querySelector('input[data-role="max-num"]');
      if (minNum && document.activeElement !== minNum) minNum.value = round3(lo);
      if (maxNum && document.activeElement !== maxNum) maxNum.value = round3(hi);
    }

    // Position the highlighted fill line between the two handles.
    var fill   = document.querySelector('.range-fill[data-section="' + sid + '"]');
    var bounds = BOUNDS[sid];
    if (fill && bounds) {
      var span = bounds[1] - bounds[0];
      // Degenerate single-value section (span 0): both handles pin left, so
      // show no fill rather than a full bar.
      var l = span > 0 ? ((lo - bounds[0]) / span) * 100 : 0;
      var r = span > 0 ? ((hi - bounds[0]) / span) * 100 : 0;
      fill.style.left  = l + '%';
      fill.style.width = Math.max(0, r - l) + '%';
    }
  }

  document.querySelectorAll('.num-filter:not(.num-filter-disabled)').forEach(function (block) {
    var minInput = block.querySelector('input[data-role="min"]');
    var maxInput = block.querySelector('input[data-role="max"]');
    if (!minInput || !maxInput) return;

    function clampAndFilter(changed) {
      var lo = parseFloat(minInput.value);
      var hi = parseFloat(maxInput.value);

      // Clamp so handles don't cross
      if (changed === 'min' && lo > hi) {
        maxInput.value = lo;
      } else if (changed === 'max' && hi < lo) {
        minInput.value = hi;
      }

      updateRangeReadout(minInput, maxInput);
      applyFilters();
    }

    minInput.addEventListener('input', function () { clampAndFilter('min'); });
    maxInput.addEventListener('input', function () { clampAndFilter('max'); });

    // Typeable range: number inputs drive the sliders (clamped to bounds).
    var sid    = minInput.getAttribute('data-section');
    var bounds = BOUNDS[sid] || [parseFloat(minInput.min), parseFloat(maxInput.max)];
    var minNum = block.querySelector('input[data-role="min-num"]');
    var maxNum = block.querySelector('input[data-role="max-num"]');

    function syncFromNum(which) {
      var el = which === 'min' ? minNum : maxNum;
      var v  = parseFloat(el.value);
      if (isNaN(v)) return;
      if (v < bounds[0]) v = bounds[0];
      if (v > bounds[1]) v = bounds[1];
      if (which === 'min') { minInput.value = v; clampAndFilter('min'); }
      else                 { maxInput.value = v; clampAndFilter('max'); }
    }

    if (minNum) {
      minNum.addEventListener('input', function () { syncFromNum('min'); });
      minNum.addEventListener('blur',  function () { updateRangeReadout(minInput, maxInput); });
    }
    if (maxNum) {
      maxNum.addEventListener('input', function () { syncFromNum('max'); });
      maxNum.addEventListener('blur',  function () { updateRangeReadout(minInput, maxInput); });
    }

    // Initialise readout + fill
    updateRangeReadout(minInput, maxInput);
  });

  /* ------------------------------------------------------------------ */
  /* Text filter                                                           */
  /* ------------------------------------------------------------------ */

  if (qInput) {
    qInput.addEventListener('input', applyFilters);
  }

  /* ------------------------------------------------------------------ */
  /* Tag popover triggers on result chips                                 */
  /* ------------------------------------------------------------------ */
  /* Each search-result tag chip (.entry-tag-chip) becomes a popover
     trigger via the dedicated data-tagpop attribute (tag-popup.js). The
     filter-dropdown checkboxes use a different attribute (data-tag), so
     this never hijacks their filtering behavior. */
  document.querySelectorAll(".entry-tag-chip").forEach(function (chip) {
    var name = (chip.textContent || "").trim();
    if (!name) return;
    chip.classList.add("tag-pop-trigger");
    chip.setAttribute("data-tagpop", name);
    chip.setAttribute("role", "button");
    chip.setAttribute("tabindex", "0");
  });

  /* ------------------------------------------------------------------ */
  /* Initial render                                                        */
  /* ------------------------------------------------------------------ */

  applyFilters();

})();
