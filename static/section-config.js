/* section-config.js — Manage page's "Configure" popup.
   Each section (tag or numeric) has a Configure button (top-right of its
   card) that opens a themed popup listing every analytics chart that section
   could appear in (mirrors journal.chart_options_for / section_chart_options),
   each with a checkbox (checked = shown). Saving POSTs the checked ids to
   /journal/sections/<id>/chart-opts and reloads (PRG-style, like the tag
   suggestions apply popup).
*/
(function () {
  "use strict";

  var dataEl = document.getElementById("section-chart-opts-data");
  if (!dataEl) return;
  var CHART_OPTS = {};
  try { CHART_OPTS = JSON.parse(dataEl.textContent || "{}"); } catch (e) { CHART_OPTS = {}; }

  var _popup = null;
  var _saving = false;
  var _opener = null;
  var _previousOverflow = "";
  function closePopup() {
    if (_saving) return;
    if (_popup) {
      _popup.remove(); _popup = null;
      document.body.style.overflow = _previousOverflow;
      if (_opener && _opener.isConnected) _opener.focus();
    }
    document.removeEventListener("keydown", _escHandler);
    document.removeEventListener("mousedown", _outsideHandler, true);
  }
  function _escHandler(e) {
    if (e.key === "Escape") {
      e.preventDefault(); e.stopImmediatePropagation(); closePopup();
    } else if (e.key === "Tab" && _popup) {
      if (_saving) { e.preventDefault(); return; }
      var choices = Array.from(_popup.querySelectorAll('button:not(:disabled), input:not(:disabled)')).filter(function (el) { return el.tabIndex >= 0 && el.getClientRects().length; });
      var first = choices[0], last = choices[choices.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  function _outsideHandler(e) {
    if (_popup && (e.target === _popup || !_popup.contains(e.target))) {
      e.preventDefault(); closePopup();
    }
  }

  function openPopup(sectionId, sectionName) {
    if (_saving) return;
    closePopup();
    _opener = document.activeElement;
    var options = CHART_OPTS[sectionId] || [];

    var overlay = document.createElement("div");
    overlay.className = "suggest-popup-overlay";
    var pop = document.createElement("div");
    pop.className = "suggest-popup";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-modal", "true");
    pop.setAttribute("aria-label", "Configure " + sectionName);
    pop.tabIndex = -1;
    overlay.appendChild(pop);

    var close = document.createElement("button");
    close.type = "button";
    close.className = "suggest-popup-close";
    close.textContent = "×";
    close.setAttribute("aria-label", "Close configuration");
    close.addEventListener("click", closePopup);
    pop.appendChild(close);

    var head = document.createElement("div");
    head.className = "suggest-popup-head";
    head.textContent = "Configure “" + sectionName + "”";
    pop.appendChild(head);

    var list = document.createElement("div");
    list.className = "chartcfg-list";
    var boxes = [];
    if (!options.length) {
      var empty = document.createElement("p");
      empty.className = "analytics-empty";
      empty.textContent = "No configurable charts for this section.";
      list.appendChild(empty);
    }
    options.forEach(function (opt) {
      var row = document.createElement("label");
      row.className = "chartcfg-row";
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!opt.enabled;
      cb.value = opt.id;
      boxes.push(cb);
      row.appendChild(cb);
      row.appendChild(document.createTextNode(opt.label));
      list.appendChild(row);
    });
    pop.appendChild(list);

    var actions = document.createElement("div");
    actions.className = "suggest-popup-actions";
    var cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "modal-cancel";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", closePopup);
    var save = document.createElement("button");
    save.type = "button";
    save.className = "modal-confirm";
    save.textContent = "Save";
    save.disabled = !options.length;
    actions.appendChild(cancel);
    actions.appendChild(save);
    pop.appendChild(actions);
    var status = document.createElement("p");
    status.className = "muted-note";
    status.setAttribute("role", "status");
    status.hidden = true;
    pop.appendChild(status);

    save.addEventListener("click", function () {
      if (_saving) return;
      _saving = true;
      var controls = Array.from(pop.querySelectorAll('button, input')).map(function (control) {
        var state = { control: control, disabled: control.disabled };
        control.disabled = true;
        return state;
      });
      pop.setAttribute("aria-busy", "true");
      pop.focus();
      status.hidden = true;
      var fd = new FormData();
      boxes.forEach(function (b) { if (b.checked) fd.append("enabled", b.value); });
      fetch("/journal/sections/" + encodeURIComponent(sectionId) + "/chart-opts",
            { method: "POST", body: fd })
        .then(function (response) {
          if (!response.ok) throw new Error("Save failed");
          location.reload();
        })
        .catch(function () {
          _saving = false;
          controls.forEach(function (state) { state.control.disabled = state.disabled; });
          pop.removeAttribute("aria-busy");
          save.focus();
          status.textContent = "Could not save · try again";
          status.hidden = false;
        });
    });

    document.body.appendChild(overlay);
    _popup = overlay;
    _previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", _escHandler);
    document.addEventListener("mousedown", _outsideHandler, true);
    close.focus();
  }

  document.querySelectorAll(".configure-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      openPopup(btn.dataset.section, btn.dataset.name || "");
    });
  });
})();
