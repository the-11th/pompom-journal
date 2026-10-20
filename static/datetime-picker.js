/* Custom themed datetime picker — replaces the native <input type=datetime-local>
 * popup (calendar + clock, un-stylable) with a dark calendar popover plus themed
 * time inputs, consistent with the rest of the app.
 *
 * Progressive enhancement: the real datetime-local input stays in the form
 * (hidden but still named, value kept as "YYYY-MM-DDTHH:MM") so submission is
 * unchanged. Auto-enhances every datetime-local input on DOMContentLoaded.
 */
(function () {
  "use strict";

  var MONTHS = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  var WK = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

  var _open = null;
  function positionOpen() {
    if (!_open) return;
    var pop = _open.pop, box = _open.owner.getBoundingClientRect();
    var gutter = document.body.classList.contains('media-mobile') ? 18 : 16;
    pop.style.position = 'fixed';
    pop.style.maxWidth = (innerWidth - 2 * gutter) + 'px';
    pop.style.minWidth = Math.min(240, innerWidth - 2 * gutter) + 'px';
    pop.style.maxHeight = (innerHeight - 2 * gutter) + 'px';
    pop.style.overflowY = 'auto';
    var width = pop.offsetWidth, height = pop.offsetHeight;
    pop.style.left = Math.max(gutter, Math.min(box.left, innerWidth - width - gutter)) + 'px';
    pop.style.right = 'auto';
    var top = box.bottom + 6;
    if (top + height > innerHeight - gutter && box.top - height - 6 >= gutter) top = box.top - height - 6;
    pop.style.top = Math.max(gutter, Math.min(top, innerHeight - height - gutter)) + 'px';
  }
  function closeOpen(restoreFocus) {
    if (_open) {
      var owner = _open.owner;
      _open.pop.remove(); _open = null;
      owner.setAttribute("aria-expanded", "false");
      if (restoreFocus) owner.focus();
    }
  }

  function pad(n) { return String(n).padStart(2, "0"); }
  function iso(y, m, d) { return y + "-" + pad(m + 1) + "-" + pad(d); }

  // Parse "YYYY-MM-DDTHH:MM" -> {date:"YYYY-MM-DD", h, min} or null.
  function parseVal(v) {
    var m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(v || "");
    if (!m) return null;
    return { date: m[1], h: parseInt(m[2], 10), min: parseInt(m[3], 10) };
  }

  function labelFor(v, emptyLabel) {
    var p = parseVal(v);
    return p ? p.date + " " + pad(p.h) + ":" + pad(p.min) : (emptyLabel || "no due date");
  }

  function enhance(input) {
    if (input.dataset.enhanced) return;
    input.dataset.enhanced = "1";
    var dateOnly = input.type === 'date';
    var fieldLabel = input.getAttribute('aria-label') || Array.from(input.labels || []).map(function (label) {
      var copy = label.cloneNode(true);
      copy.querySelectorAll('input, button').forEach(function (el) { el.remove(); });
      return copy.textContent.trim();
    }).join(' ') || 'Due date';

    var wrap = document.createElement("div");
    wrap.className = "dt-field";
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    input.classList.add("cs-native");
    input.tabIndex = -1;
    input.setAttribute("aria-hidden", "true");

    var trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "cs-trigger dt-trigger";
    trigger.setAttribute("aria-haspopup", "dialog");
    trigger.setAttribute("aria-expanded", "false");
    trigger.disabled = input.disabled;
    var valueSpan = document.createElement("span");
    valueSpan.className = "cs-value";
    function syncLabel() {
      valueSpan.textContent = dateOnly ? (input.value || input.dataset.emptyLabel || 'any date') : labelFor(input.value, input.dataset.emptyLabel);
      trigger.setAttribute('aria-label', (input.getAttribute('aria-label') || fieldLabel) + ': ' + valueSpan.textContent);
      trigger.disabled = input.matches(':disabled') || input.readOnly;
      if (trigger.disabled && _open && _open.owner === trigger) closeOpen();
    }
    syncLabel();
    var caret = document.createElement("span");
    caret.className = "cal-caret";
    caret.textContent = "▾";
    trigger.appendChild(valueSpan);
    trigger.appendChild(caret);
    wrap.appendChild(trigger);

    function commit(dateStr, h, min) {
      input.value = dateStr ? dateStr + (dateOnly ? '' : "T" + pad(h) + ":" + pad(min)) : "";
      syncLabel();
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function openPopover() {
      var cur = parseVal(input.value + (dateOnly && input.value ? 'T00:00' : ''));
      var selDate = cur ? cur.date : null;
      var h = cur ? cur.h : 9, min = cur ? cur.min : 0;
      var base = selDate ? new Date(selDate + "T00:00:00") : new Date();
      var viewY = base.getFullYear(), viewM = base.getMonth();

      var pop = document.createElement("div");
      pop.className = "cal-popover dt-popover";
      pop.setAttribute("role", "dialog");
      pop.setAttribute("aria-label", input.getAttribute("aria-label") || fieldLabel);
      pop.addEventListener("click", function (e) { e.stopPropagation(); });
      pop.addEventListener('focusin', function (event) {
        var day = event.target.closest('.cal-day[data-date]');
        if (day) pop.querySelectorAll('.cal-day[data-date]').forEach(function (cell) { cell.tabIndex = cell === day ? 0 : -1; });
      });

      function focusDate(date) {
        viewY = date.getFullYear(); viewM = date.getMonth();
        render();
        var cell = pop.querySelector('[data-date="' + iso(viewY, viewM, date.getDate()) + '"]');
        if (cell) cell.focus();
      }

      pop.addEventListener("keydown", function (e) {
        var cell = e.target.closest(".cal-day[data-date]");
        if (!cell) return;
        var date = new Date(cell.dataset.date + "T00:00:00");
        var offsets = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
        if (e.key in offsets) date.setDate(date.getDate() + offsets[e.key]);
        else if (e.key === "Home") date.setDate(date.getDate() - date.getDay());
        else if (e.key === "End") date.setDate(date.getDate() + 6 - date.getDay());
        else return;
        e.preventDefault();
        if (render.readTime && !render.readTime(true)) return;
        focusDate(date);
      });

      function render() {
        pop.innerHTML = "";
        var head = document.createElement("div");
        head.className = "cal-head";
        var prev = document.createElement("button");
        prev.type = "button"; prev.className = "cal-nav"; prev.textContent = "‹";
        prev.setAttribute("aria-label", "Previous month");
        prev.addEventListener("click", function () {
          if (!readTime(true)) return;
          viewM--; if (viewM < 0) { viewM = 11; viewY--; } render();
          pop.querySelector('[aria-label="Previous month"]').focus();
        });
        var title = document.createElement("span");
        title.className = "cal-month-title";
        title.textContent = MONTHS[viewM] + " " + viewY;
        var next = document.createElement("button");
        next.type = "button"; next.className = "cal-nav"; next.textContent = "›";
        next.setAttribute("aria-label", "Next month");
        next.addEventListener("click", function () {
          if (!readTime(true)) return;
          viewM++; if (viewM > 11) { viewM = 0; viewY++; } render();
          pop.querySelector('[aria-label="Next month"]').focus();
        });
        head.appendChild(prev); head.appendChild(title); head.appendChild(next);
        pop.appendChild(head);

        var grid = document.createElement("div");
        grid.className = "cal-grid";
        WK.forEach(function (d) {
          var wh = document.createElement("div");
          wh.className = "cal-weekday"; wh.textContent = d;
          grid.appendChild(wh);
        });
        var firstDow = new Date(viewY, viewM, 1).getDay();
        for (var b = 0; b < firstDow; b++) {
          var bl = document.createElement("div");
          bl.className = "cal-day cal-day-blank";
          grid.appendChild(bl);
        }
        var now = new Date();
        var todayIso = iso(now.getFullYear(), now.getMonth(), now.getDate());
        var dim = new Date(viewY, viewM + 1, 0).getDate();
        for (var day = 1; day <= dim; day++) {
          (function (day) {
            var dIso = iso(viewY, viewM, day);
            var cell = document.createElement("button");
            cell.type = "button";
            cell.className = "cal-day";
            cell.dataset.date = dIso;
            cell.tabIndex = dIso === (selDate || todayIso) ? 0 : -1;
            cell.setAttribute("aria-label", MONTHS[viewM] + " " + day + ", " + viewY);
            cell.setAttribute("aria-pressed", String(dIso === selDate));
            if (dIso === todayIso) cell.classList.add("is-today");
            if (dIso === selDate) cell.classList.add("is-selected");
            var num = document.createElement("span");
            num.className = "cal-day-num"; num.textContent = String(day);
            cell.appendChild(num);
            cell.addEventListener("click", function () {
              if (!readTime(true)) return;
              selDate = dIso;
              commit(selDate, h, min);
              if (dateOnly) { closeOpen(true); return; }
              render();
              pop.querySelector('[data-date="' + dIso + '"]').focus();
            });
            grid.appendChild(cell);
          }(day));
        }
        if (!grid.querySelector('.cal-day[tabindex="0"]')) {
          var firstDay = grid.querySelector('button.cal-day');
          if (firstDay) firstDay.tabIndex = 0;
        }
        pop.appendChild(grid);

        // Time row: HH : MM (24h) with themed steppers, plus a clear button.
        var timeRow = document.createElement("div");
        timeRow.className = "dt-time-row";

        function onTime() {
          if (!readTime()) return false;
          hInput.value = pad(h); mInput.value = pad(min);
          if (selDate) commit(selDate, h, min);
          return true;
        }

        // A plain typeable number field (no spinner arrows — native spinners
        // are hidden via CSS, and we intentionally render no custom steppers).
        function timeField(initial, max) {
          var fwrap = document.createElement("div");
          fwrap.className = "dt-time-wrap";
          var input = document.createElement("input");
          input.type = "number"; input.min = 0; input.max = max; input.step = 1; input.required = true;
          input.className = "dt-time"; input.value = pad(initial);
          fwrap.appendChild(input);
          return { el: fwrap, input: input };
        }

        var hField = timeField(h, 23), mField = timeField(min, 59);
        var hInput = hField.input, mInput = mField.input;
        hInput.setAttribute("aria-label", "Hour");
        mInput.setAttribute("aria-label", "Minute");

        var validation = document.createElement('p');
        validation.className = 'form-validation'; validation.id = 'dt-validation';
        validation.setAttribute('role', 'status'); validation.hidden = true;
        function readTime(focusInvalid) {
          if (dateOnly) return true;
          var invalid = null;
          [hInput, mInput].forEach(function (field) {
            var value = Number(field.value), valid = !field.validity.badInput && field.value !== '' && Number.isInteger(value) && value >= 0 && value <= Number(field.max);
            if (valid) { field.removeAttribute('aria-invalid'); field.removeAttribute('aria-describedby'); }
            else { field.setAttribute('aria-invalid', 'true'); field.setAttribute('aria-describedby', validation.id); if (!invalid) invalid = field; }
          });
          validation.hidden = !invalid;
          validation.textContent = invalid ? invalid.getAttribute('aria-label') + ' must be 0–' + invalid.max + '.' : '';
          if (invalid) { if (focusInvalid) invalid.focus(); positionOpen(); return false; }
          h = Number(hInput.value); min = Number(mInput.value); return true;
        }
        render.readTime = readTime;
        hInput.addEventListener("change", onTime);
        mInput.addEventListener("change", onTime);
        [hInput, mInput].forEach(function (field) {
          field.addEventListener('input', function () { if (!validation.hidden) readTime(); });
          field.addEventListener('keydown', function (event) {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            if (!onTime()) { readTime(true); return; }
            if (selDate) closeOpen(true);
            else pop.querySelector('.cal-day[tabindex="0"]').focus();
          });
        });
        var colon = document.createElement("span");
        colon.className = "dt-colon"; colon.textContent = ":";
        if (!dateOnly) {
          timeRow.appendChild(hField.el);
          timeRow.appendChild(colon);
          timeRow.appendChild(mField.el);
        }

        var clear = document.createElement("button");
        clear.type = "button"; clear.className = "dt-clear"; clear.textContent = "clear";
        clear.addEventListener("click", function () {
          selDate = null; commit("", 0, 0); closeOpen(true);
        });
        timeRow.appendChild(clear);
        pop.appendChild(timeRow);
        pop.appendChild(validation);
        positionOpen();
      }

      render();
      wrap.appendChild(pop);
      _open = { pop: pop, owner: trigger };
      positionOpen();
      trigger.setAttribute("aria-expanded", "true");
      (pop.querySelector('.cal-day[tabindex="0"]') || pop.querySelector('button.cal-day')).focus();
    }

    trigger.addEventListener("click", function (e) {
      e.stopPropagation();
      var wasOpen = _open && _open.owner === trigger;
      closeOpen();
      if (!wasOpen) openPopover();
    });
    wrap.addEventListener("focusout", function () {
      setTimeout(function () { if (_open && _open.owner === trigger && !wrap.contains(document.activeElement)) closeOpen(); }, 0);
    });
    input.addEventListener("change", syncLabel);
    input.addEventListener("focus", function () { trigger.focus(); });
    if (input.form) input.form.addEventListener('reset', function () {
      if (_open && _open.owner === trigger) closeOpen();
      setTimeout(syncLabel, 0);
    });
    new MutationObserver(syncLabel).observe(input, { attributes: true, attributeFilter: ['value', 'disabled', 'readonly', 'aria-label'] });
  }

  document.addEventListener("click", function () { closeOpen(); });
  window.addEventListener('resize', positionOpen);
  document.addEventListener('scroll', positionOpen, true);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && _open) {
      var owner = _open.owner;
      e.preventDefault();
      e.stopImmediatePropagation();
      closeOpen();
      owner.focus();
    }
  });
  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll('input[type="datetime-local"]').forEach(enhance);
  });
  window.enhanceDatetime = enhance;
}());
