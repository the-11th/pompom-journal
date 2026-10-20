/* journal.js — custom dark calendar widget for the journal entry form.
   Vanilla JS only, no third-party libraries. */

(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Helpers                                                              */
  /* ------------------------------------------------------------------ */

  var DAYS   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MONTHS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  var MONTHS_SHORT = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'
  ];

  /** Format a YYYY-MM-DD string as e.g. "Sat, Jun 20 2026". */
  function prettyDate(iso) {
    var parts = iso.split('-');
    var y = parseInt(parts[0], 10);
    var m = parseInt(parts[1], 10) - 1;
    var d = parseInt(parts[2], 10);
    var dow = new Date(y, m, d).getDay();
    return DAYS[dow] + ', ' + MONTHS_SHORT[m] + ' ' + d + ' ' + y;
  }

  /** Pad a number to 2 digits. */
  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  /** Build a YYYY-MM-DD string from year, month (0-based), day. */
  function toISO(y, m, d) { return y + '-' + pad2(m + 1) + '-' + pad2(d); }

  /** Today as YYYY-MM-DD (local time). */
  function todayISO() {
    var t = new Date();
    return toISO(t.getFullYear(), t.getMonth(), t.getDate());
  }

  /* ------------------------------------------------------------------ */
  /* State                                                                */
  /* ------------------------------------------------------------------ */

  var entryDatesEl = document.getElementById('entry-dates-data');
  if (!entryDatesEl) return;  // not on a journal entry page, bail out
  var entryDatesSet = new Set(JSON.parse(entryDatesEl.textContent || '[]'));
  var occupiedDatesEl = document.getElementById('occupied-dates-data');
  var occupiedDatesSet = new Set(JSON.parse((occupiedDatesEl || entryDatesEl).textContent || '[]'));

  var calField = document.querySelector('.cal-field');
  if (!calField) return;

  var currentDate = calField.getAttribute('data-current-date');
  var isSaved     = calField.getAttribute('data-is-saved') === 'true';

  var trigger      = calField.querySelector('.cal-trigger');
  var triggerLabel = calField.querySelector('.cal-trigger-label');
  var hiddenInput  = calField.querySelector('.cal-input');

  var moveBtn   = document.querySelector('.move-btn');
  var moveInput = document.querySelector('.move-input');
  var moveForm  = document.getElementById('move-form');
  var deleteBtn = document.querySelector('.delete-entry-btn');
  var deleteForm = document.getElementById('delete-form');
  var journalForm = document.getElementById('journal-form');
  var documentEditor = !!(journalForm && journalForm.dataset.mediaEditor);

  /* Dirty tracking -- set true when the user edits any journal field. */
  var dirty = false;
  document.addEventListener('journal:saved', function (event) {
    var detail = event.detail;
    if (!detail || !detail.date || detail.date === currentDate) dirty = false;
    if (detail && detail.date === currentDate && Object.prototype.hasOwnProperty.call(detail, 'entryId')) {
      var savedId = detail.persisted && typeof detail.entryId === 'string' && detail.entryId;
      [moveBtn, deleteBtn].forEach(function (button) { if (button) button.hidden = !savedId; });
      [moveForm, deleteForm].forEach(function (form) {
        if (!form || !form.dataset.actionTemplate) return;
        if (savedId) form.setAttribute('action', form.dataset.actionTemplate.replace('__ENTRY_ID__', encodeURIComponent(savedId)));
        else form.removeAttribute('action');
      });
    }
    if (!detail || !detail.date || typeof detail.hasEntry !== 'boolean') return;
    if (detail.hasEntry) entryDatesSet.add(detail.date); else entryDatesSet.delete(detail.date);
    if (detail.persisted) occupiedDatesSet.add(detail.date); else occupiedDatesSet.delete(detail.date);
    entryDatesEl.textContent = JSON.stringify(Array.from(entryDatesSet));
    if (occupiedDatesEl) occupiedDatesEl.textContent = JSON.stringify(Array.from(occupiedDatesSet));
    if (detail.date === currentDate) isSaved = detail.persisted;
    if (popover) renderPopover();
  });

  var trackSelectors = [
    'input[name="title"]',
    'textarea[name="body"]',
    'input[name^="tag:"]',
    'input[name^="num:"]',
    'input[name^="newtag-name:"]',
    'input[name^="newtag-kind:"]',
    'input[name="mood"]'
  ];
  trackSelectors.forEach(function (sel) {
    document.querySelectorAll(sel).forEach(function (el) {
      el.addEventListener('input',  function () { dirty = true; });
      el.addEventListener('change', function () { dirty = true; });
    });
  });

  /* ------------------------------------------------------------------ */
  /* Calendar popover                                                     */
  /* ------------------------------------------------------------------ */

  var popover = null;     // the currently open popover element
  var moveMode = false;   // true when opened by the Move button
  var viewYear, viewMonth;  // month currently shown in the popover

  function positionPopover() {
    if (!popover || !popover.isConnected) return;
    var field = calField.getBoundingClientRect();
    popover.style.position = 'fixed';
    popover.style.maxHeight = 'calc(100dvh - 32px)';
    popover.style.overflowY = 'auto';
    var width = popover.offsetWidth, height = popover.offsetHeight;
    var left = Math.max(16, Math.min(field.right - width, innerWidth - width - 16));
    popover.style.left = left + 'px';
    popover.style.right = 'auto';
    var top = field.bottom + 6;
    if (top + height > innerHeight - 16 && field.top - height - 6 >= 16) top = field.top - height - 6;
    popover.style.top = Math.max(16, Math.min(top, innerHeight - height - 16)) + 'px';
  }
  window.addEventListener('resize', positionPopover);
  document.addEventListener('scroll', positionPopover, true);

  /** Open the calendar popover. Pass `inMoveMode=true` for the move flow. */
  function openPopover(inMoveMode) {
    if (popover) closePopover();
    moveMode = !!inMoveMode;

    var selDate = hiddenInput.value || currentDate;
    var parts   = selDate.split('-');
    viewYear  = parseInt(parts[0], 10);
    viewMonth = parseInt(parts[1], 10) - 1;

    popover = document.createElement('div');
    popover.className = 'cal-popover';
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-label', moveMode ? 'Move entry to date' : 'Journal date');
    popover.addEventListener('keydown', calendarKey);
    popover.addEventListener('focusin', function (event) {
      var day = event.target.closest('.cal-day[data-date]');
      if (day) popover.querySelectorAll('.cal-day[data-date]').forEach(function (cell) { cell.tabIndex = cell === day ? 0 : -1; });
    });

    renderPopover();
    calField.appendChild(popover);
    positionPopover();
    trigger.setAttribute('aria-expanded', String(!moveMode));
    if (moveBtn) moveBtn.setAttribute('aria-expanded', String(moveMode));
    var selected = popover.querySelector('.cal-day.is-selected') || popover.querySelector('button.cal-day:not(:disabled)');
    if (selected) selected.focus();

    // Close on outside click
    document.addEventListener('click', outsideClick);
    document.addEventListener('keydown', escKey);
  }

  function closePopover(restoreFocus) {
    if (popover) {
      popover.parentNode && popover.parentNode.removeChild(popover);
      popover = null;
    }
    document.removeEventListener('click', outsideClick);
    document.removeEventListener('keydown', escKey);
    trigger.setAttribute('aria-expanded', 'false');
    if (moveBtn) moveBtn.setAttribute('aria-expanded', 'false');
    if (restoreFocus) (moveMode && moveBtn ? moveBtn : trigger).focus();
  }

  function outsideClick(e) {
    if (e.target.closest('.modal-overlay')) return;
    if (popover && !calField.contains(e.target) &&
        (!moveBtn || !moveBtn.contains(e.target))) {
      closePopover();
    }
  }

  function escKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopImmediatePropagation(); closePopover(true);
    }
  }

  function calendarKey(e) {
    var cell = e.target.closest('.cal-day[data-date]');
    if (!cell) return;
    var date = new Date(cell.dataset.date + 'T00:00:00');
    var offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key in offsets) date.setDate(date.getDate() + offsets[e.key]);
    else if (e.key === 'Home') date.setDate(date.getDate() - date.getDay());
    else if (e.key === 'End') date.setDate(date.getDate() + 6 - date.getDay());
    else return;
    e.preventDefault();
    var targetDate = toISO(date.getFullYear(), date.getMonth(), date.getDate());
    if (moveMode && occupiedDatesSet.has(targetDate)) return;
    viewYear = date.getFullYear(); viewMonth = date.getMonth();
    renderPopover();
    popover.querySelector('[data-date="' + targetDate + '"]').focus();
  }

  /** Re-render the popover contents for the current viewYear/viewMonth. */
  function renderPopover() {
    if (!popover) return;
    var focused = popover.contains(document.activeElement) ? document.activeElement : null;
    var focusedDate = focused && focused.getAttribute('data-date');
    var focusedNav = focused && focused.classList.contains('cal-nav') && focused.getAttribute('aria-label');
    popover.innerHTML = '';

    var today    = todayISO();
    var selDate  = hiddenInput.value || currentDate;

    // Header
    var head = document.createElement('div');
    head.className = 'cal-head';

    var prev = document.createElement('button');
    prev.type = 'button';
    prev.textContent = '‹';
    prev.className = 'cal-nav';
    prev.setAttribute('aria-label', 'Previous month');
    prev.addEventListener('click', function (e) {
      e.stopPropagation();
      viewMonth--;
      if (viewMonth < 0) { viewMonth = 11; viewYear--; }
      renderPopover();
      popover.querySelector('[aria-label="Previous month"]').focus();
    });

    var title = document.createElement('span');
    title.className = 'cal-month-title';
    title.textContent = MONTHS[viewMonth] + ' ' + viewYear;

    var next = document.createElement('button');
    next.type = 'button';
    next.textContent = '›';
    next.className = 'cal-nav';
    next.setAttribute('aria-label', 'Next month');
    next.addEventListener('click', function (e) {
      e.stopPropagation();
      viewMonth++;
      if (viewMonth > 11) { viewMonth = 0; viewYear++; }
      renderPopover();
      popover.querySelector('[aria-label="Next month"]').focus();
    });

    head.appendChild(prev);
    head.appendChild(title);
    head.appendChild(next);
    popover.appendChild(head);

    // Grid
    var grid = document.createElement('div');
    grid.className = 'cal-grid';

    // Weekday headers
    DAYS.forEach(function (d) {
      var wh = document.createElement('div');
      wh.className = 'cal-weekday';
      wh.textContent = d.slice(0, 2);
      grid.appendChild(wh);
    });

    // Leading blank cells
    var firstDow = new Date(viewYear, viewMonth, 1).getDay();
    for (var b = 0; b < firstDow; b++) {
      var blank = document.createElement('div');
      blank.className = 'cal-day cal-day-blank';
      grid.appendChild(blank);
    }

    // Day cells
    var daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    for (var day = 1; day <= daysInMonth; day++) {
      var iso = toISO(viewYear, viewMonth, day);
      var cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cal-day';
      cell.setAttribute('data-date', iso);
      cell.setAttribute('aria-label', MONTHS[viewMonth] + ' ' + day + ', ' + viewYear);
      cell.tabIndex = iso === selDate ? 0 : -1;
      cell.setAttribute('aria-pressed', String(iso === selDate && !moveMode));

      var num = document.createElement('span');
      num.className = 'cal-day-num';
      num.textContent = String(day);
      cell.appendChild(num);

      if (iso === today) cell.classList.add('is-today');
      // Selection highlight is only meaningful when navigating, not when
      // choosing a move target -- otherwise the current (occupied) date would
      // collide with the disabled style in move mode.
      if (iso === selDate && !moveMode) cell.classList.add('is-selected');

      if (moveMode && occupiedDatesSet.has(iso)) {
        cell.classList.add('is-disabled');
        cell.disabled = true;
      } else if (!moveMode && entryDatesSet.has(iso)) {
        var dot = document.createElement('span');
        dot.className = 'cal-dot';
        cell.appendChild(dot);
      }

      if (!cell.classList.contains('is-disabled')) {
        (function (dateStr) {
          cell.addEventListener('click', function (e) {
            e.stopPropagation();
            handleDayClick(dateStr);
          });
        })(iso);
      }

      grid.appendChild(cell);
    }

    if (!grid.querySelector('.cal-day[tabindex="0"]:not(:disabled)')) {
      var firstDay = grid.querySelector('button.cal-day:not(:disabled)');
      if (firstDay) firstDay.tabIndex = 0;
    }
    popover.appendChild(grid);
    positionPopover();
    if (focused) {
      var replacement = focusedDate ? popover.querySelector('[data-date="' + focusedDate + '"]:not(:disabled)') :
        focusedNav ? popover.querySelector('[aria-label="' + focusedNav + '"]') : null;
      if (replacement) replacement.focus();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Day click logic                                                      */
  /* ------------------------------------------------------------------ */

  function restoreCalendarDate(dateStr) {
    if (!popover) return;
    var cell = popover.querySelector('[data-date="' + dateStr + '"]:not(:disabled)');
    if (cell) cell.focus();
  }

  var entryActionPending = false;
  async function submitEntryAction(form, action) {
    if (entryActionPending) return;
    entryActionPending = true;
    document.querySelectorAll('.move-btn, .delete-entry-btn').forEach(function (button) { button.disabled = true; });
    var submitted = false;
    try {
      if (documentEditor) {
        await window.PupJournalEditorReady;
        var editor = window.PupJournalEditor;
        if (!editor || !editor.prepareEntryAction) throw new Error('Entry editor unavailable');
        if (!await editor.prepareEntryAction(action)) return;
      }
      closePopover();
      form.submit();
      submitted = true;
    } catch (error) {
      var status = document.getElementById('draft-status');
      if (status) status.textContent = 'Could not prepare entry · try again';
    } finally {
      if (!submitted) {
        entryActionPending = false;
        document.querySelectorAll('.move-btn, .delete-entry-btn').forEach(function (button) { button.disabled = false; });
      }
    }
  }

  function handleDayClick(dateStr) {
    if (moveMode) {
      // Move mode: submit the move form
      if (entryActionPending) return;
      moveInput.value = dateStr;
      void submitEntryAction(moveForm, 'move');
      return;
    }

    if (isSaved || documentEditor) {
      // Saved entry: navigate to that day, with dirty-check
      if (dirty) {
        window.confirmModal('You have unsaved changes that will be lost. Continue?')
          .then(function (confirmed) {
            if (confirmed) {
              closePopover();
              window.location = '/journal/' + dateStr;
            } else restoreCalendarDate(dateStr);
          });
      } else {
        closePopover(true);
        window.location = '/journal/' + dateStr;
      }
    } else {
      // New (unsaved) entry
      if (occupiedDatesSet.has(dateStr)) {
        if (dirty) {
          // Only warn if the user actually typed/selected something to lose.
          confirmModal(
            'Opening ' + prettyDate(dateStr) + ' will discard your current entry. Continue?'
          ).then(function (confirmed) {
            if (confirmed) {
              closePopover();
              window.location = '/journal/' + dateStr;
            } else restoreCalendarDate(dateStr);
          });
        } else {
          // Nothing entered yet -- just open that day, no warning.
          closePopover();
          window.location = '/journal/' + dateStr;
        }
      } else {
        // Empty day: just update the date field in place, no navigation
        hiddenInput.value = dateStr;
        triggerLabel.textContent = dateStr;
        currentDate = dateStr;    // update so selected highlight is right
        closePopover();
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Wire up events                                                        */
  /* ------------------------------------------------------------------ */

  trigger.addEventListener('click', function (e) {
    e.stopPropagation();
    if (popover && !moveMode) {
      closePopover();
    } else {
      openPopover(false);
    }
  });
  trigger.setAttribute('aria-expanded', 'false');
  calField.addEventListener('focusout', function () {
    setTimeout(function () {
      // Confirmation owns focus while checking an unsaved entry.
      if (popover && !calField.contains(document.activeElement) && !document.activeElement.closest('.modal-overlay')) closePopover();
    }, 0);
  });

  // Delete entry: confirm via the dark modal, then submit the delete form.
  if (deleteBtn && deleteForm) {
    deleteBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      confirmModal('Delete this entry and its local draft? This cannot be undone.', 'Delete')
        .then(function (confirmed) {
          if (confirmed) void submitEntryAction(deleteForm, 'delete');
        });
    });
  }

  if (moveBtn) {
    moveBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (popover && moveMode) {
        closePopover();
      } else {
        openPopover(true);
      }
    });
  }

})();
