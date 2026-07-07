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

  /* ------------------------------------------------------------------ */
  /* Helpers                                                              */
  /* ------------------------------------------------------------------ */

  /** Escape regex special chars so user text is treated as a literal. */
  function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /* ------------------------------------------------------------------ */
  /* Filter function                                                      */
  /* ------------------------------------------------------------------ */

  function applyFilters() {
    var q       = qInput ? qInput.value : '';
    var words   = q.trim().split(/\s+/).filter(Boolean);
    var selTags = getSelectedTags();
    var ranges  = getActiveRanges();

    var count = 0;

    ENTRIES.forEach(function (entry) {
      var visible = true;

      /* ---- Text filter: AND over whole-word matches in title + body ---- */
      if (words.length > 0) {
        var haystack = ((entry.title || '') + ' ' + (entry.body || '')).toLowerCase();
        for (var i = 0; i < words.length; i++) {
          var re = new RegExp('\\b' + escapeRegExp(words[i].toLowerCase()) + '\\b');
          if (!re.test(haystack)) {
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
      var row = document.querySelector('.entry-row[data-id="' + entry.id + '"]');
      if (row) {
        row.style.display = visible ? '' : 'none';
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
    setTimeout(function () {
      document.addEventListener('click', outsideDropdownClick);
      document.addEventListener('keydown', dropdownEsc);
    }, 0);
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
    if (e.key === 'Escape') closeDropdown();
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
    dropdownPanel.addEventListener('change', function () {
      applyFilters();
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
