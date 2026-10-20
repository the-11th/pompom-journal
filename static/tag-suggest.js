/* Tag suggestions on the Manage sections page. Self-contained: reads its data
 * from the #suggest-data JSON blob embedded in the page (suggested words +
 * dormant people), renders suggestion chips and dormant rows into #suggest-root,
 * and drives the apply popup. No dependency on the analytics dashboard.
 *
 * Behavior preserved from the old analytics-Overview implementation:
 *   - a suggestion chip shows the word + an "Nd" day-count hint + an × dismiss;
 *   - × dismisses (POST /journal/suggestions/<word>/dismiss);
 *   - clicking the chip body opens the apply popup (GET /journal/suggestions/
 *     <word> → permanent/temporary kind toggle, section <select>, day-checklist
 *     with highlighted snippets, Confirm → POST .../apply);
 *   - after a successful apply OR dismiss, the page reloads so the manage page
 *     reflects the change (matches the page's existing PRG/reload pattern). */
(function () {
  "use strict";

  var root = document.getElementById("suggest-root");
  var dataEl = document.getElementById("suggest-data");
  if (!root || !dataEl) return;

  var DATA = {};
  try { DATA = JSON.parse(dataEl.textContent || "{}"); } catch (e) { DATA = {}; }
  var SUGGESTIONS = DATA.suggestions || [];
  var DORMANT = DATA.dormant || [];

  // ----- small DOM/HTTP utilities (self-contained) -----
  function apiPost(url, formData) {
    return fetch(url, {
      method: "POST",
      headers: { "Accept": "application/json" },
      body: formData || undefined,
    }).then(function (r) {
      if (!r.ok) throw new Error("bad status " + r.status);
      return r.json();
    });
  }

  function originDot(color) {
    var s = document.createElement("span");
    s.className = "origin-dot";
    if (color) s.style.setProperty("--dot", color);
    return s;
  }

  function escHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // Render the helper's `**word**` markers as a highlight span (body escaped
  // first; only our own marker becomes a styled span).
  function renderSnippet(node, snippet) {
    var html = "";
    var rest = String(snippet || "");
    var re = /\*\*([\s\S]*?)\*\*/g;
    var last = 0, m;
    while ((m = re.exec(rest)) !== null) {
      html += escHtml(rest.slice(last, m.index));
      html += '<span class="suggest-hl">' + escHtml(m[1]) + "</span>";
      last = re.lastIndex;
    }
    html += escHtml(rest.slice(last));
    node.innerHTML = html;
  }

  // ----- render -----
  function render() {
    root.textContent = "";
    if (!SUGGESTIONS.length && !DORMANT.length) {
      var p = document.createElement("p");
      p.className = "muted-note";
      p.textContent = "No suggestions right now.";
      root.appendChild(p);
      return;
    }

    if (SUGGESTIONS.length) {
      var lbl = document.createElement("div");
      lbl.className = "suggest-label";
      lbl.textContent = "Frequent words to tag";
      root.appendChild(lbl);
      var chips = document.createElement("div");
      chips.className = "suggest-chips";
      SUGGESTIONS.forEach(function (s) { chips.appendChild(buildSuggestChip(s)); });
      root.appendChild(chips);
    }

    if (DORMANT.length) {
      var ul = document.createElement("ul");
      ul.className = "dormant-list";
      DORMANT.slice(0, 5).forEach(function (d) {
        var li = document.createElement("li");
        li.className = "dormant-row";
        li.appendChild(originDot(null));
        var tx = document.createElement("span");
        tx.textContent = " Haven't tagged " + d.name + " in " + d.days_since + " days";
        li.appendChild(tx);
        ul.appendChild(li);
      });
      root.appendChild(ul);
    }
  }

  function buildSuggestChip(s) {
    var chip = document.createElement("span");
    chip.className = "suggest-chip suggest-chip-v2";

    var body = document.createElement("button");
    body.type = "button";
    body.className = "suggest-chip-body";
    var wordSpan = document.createElement("span");
    wordSpan.className = "suggest-word";
    wordSpan.textContent = s.word;
    var hint = document.createElement("span");
    hint.className = "suggest-days";
    hint.textContent = (s.days != null ? s.days : s.count) + "d";
    body.appendChild(wordSpan);
    body.appendChild(hint);
    body.addEventListener("click", function () { openApplyPopup(s.word, chip); });

    var del = document.createElement("button");
    del.type = "button";
    del.className = "suggest-dismiss";
    del.setAttribute("aria-label", "Dismiss " + s.word);
    del.textContent = "×";
    del.addEventListener("click", function (e) {
      e.stopPropagation();
      del.disabled = true;
      apiPost("/journal/suggestions/" + encodeURIComponent(s.word) + "/dismiss")
        .then(function () { location.reload(); })
        .catch(function () {
          del.disabled = false;
          var status = root.querySelector('[role="status"]');
          if (!status) {
            status = document.createElement("p"); status.className = "muted-note";
            status.setAttribute("role", "status"); root.appendChild(status);
          }
          status.textContent = "Could not dismiss · try again";
        });
    });

    chip.appendChild(body);
    chip.appendChild(del);
    return chip;
  }

  // ----- apply popup -----
  var _applyPopup = null;
  var _applying = false;
  var _applyOpener = null;
  var _applyOverflow = "";
  function closeApplyPopup() {
    if (_applying) return;
    if (_applyPopup) {
      _applyPopup.remove(); _applyPopup = null;
      document.body.style.overflow = _applyOverflow;
      if (_applyOpener && _applyOpener.isConnected) _applyOpener.focus();
    }
    document.removeEventListener("keydown", _applyEscHandler);
    document.removeEventListener("mousedown", _applyOutsideHandler, true);
  }
  function _applyEscHandler(e) {
    if (e.key === "Escape") {
      e.preventDefault(); e.stopImmediatePropagation(); closeApplyPopup();
    } else if (e.key === "Tab" && _applyPopup) {
      if (_applying) { e.preventDefault(); return; }
      var choices = Array.from(_applyPopup.querySelectorAll('button:not(:disabled), input:not(:disabled)')).filter(function (el) { return el.tabIndex >= 0 && el.getClientRects().length; });
      var first = choices[0], last = choices[choices.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  function _applyOutsideHandler(e) {
    if (_applyPopup && (e.target === _applyPopup || !_applyPopup.contains(e.target))) {
      e.preventDefault(); closeApplyPopup();
    }
  }

  function openApplyPopup(word, chip) {
    if (_applying) return;
    closeApplyPopup();
    _applyOpener = document.activeElement;
    var overlay = document.createElement("div");
    overlay.className = "suggest-popup-overlay";
    var pop = document.createElement("div");
    pop.className = "suggest-popup";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-modal", "true");
    pop.setAttribute("aria-label", "Tag " + word);
    pop.tabIndex = -1;
    overlay.appendChild(pop);

    var close = document.createElement("button");
    close.type = "button";
    close.className = "suggest-popup-close";
    close.textContent = "×";
    close.setAttribute("aria-label", "Close tag suggestion");
    close.addEventListener("click", closeApplyPopup);
    pop.appendChild(close);

    var head = document.createElement("div");
    head.className = "suggest-popup-head";
    head.textContent = "Tag “" + word + "”";
    pop.appendChild(head);

    var loading = document.createElement("p");
    loading.className = "analytics-empty";
    loading.setAttribute("role", "status");
    loading.textContent = "Loading…";
    pop.appendChild(loading);
    var retry = document.createElement("button");
    retry.type = "button";
    retry.className = "modal-cancel";
    retry.textContent = "Retry suggestion";
    retry.hidden = true;
    pop.appendChild(retry);

    document.body.appendChild(overlay);
    _applyPopup = overlay;
    _applyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", _applyEscHandler);
    document.addEventListener("mousedown", _applyOutsideHandler, true);
    close.focus();

    function loadSuggestion() {
      var restore = document.activeElement === retry;
      retry.disabled = true;
      loading.textContent = "Loading…";
      fetch("/journal/suggestions/" + encodeURIComponent(word),
            { headers: { "Accept": "application/json" } })
        .then(function (r) {
          if (!r.ok) throw new Error("Suggestion unavailable");
          return r.json();
        })
        .then(function (d) {
          if (_applyPopup !== overlay) return;
          retry.remove();
          fillApplyPopup(pop, loading, word, chip, d);
          if (restore) pop.querySelector('.kind-opt').focus();
        })
        .catch(function () {
          if (_applyPopup !== overlay) return;
          loading.textContent = "Could not load suggestion.";
          retry.hidden = false; retry.disabled = false;
          if (restore) retry.focus();
        });
    }
    retry.addEventListener('click', loadSuggestion);
    loadSuggestion();
  }

  function fillApplyPopup(pop, loading, word, chip, d) {
    loading.remove();
    var sections = d.sections || [];
    var occ = d.occurrences || [];

    // Kind toggle (permanent / temporary), reusing the .kind-toggle styling.
    var kindWrap = document.createElement("div");
    kindWrap.className = "kind-toggle suggest-kind";
    var kindVal = "permanent";
    [["permanent", "Permanent"], ["temporary", "Temporary"]].forEach(function (k) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "kind-opt" + (k[0] === kindVal ? " active" : "");
      b.setAttribute("aria-pressed", String(k[0] === kindVal));
      b.textContent = k[1];
      b.addEventListener("click", function () {
        kindVal = k[0];
        kindWrap.querySelectorAll(".kind-opt").forEach(function (o) {
          o.classList.remove("active");
          o.setAttribute("aria-pressed", "false");
        });
        b.classList.add("active");
        b.setAttribute("aria-pressed", "true");
      });
      kindWrap.appendChild(b);
    });
    pop.appendChild(labeledRow("Kind", kindWrap));

    // Section select (active tag sections).
    var sel = document.createElement("select");
    sel.className = "suggest-section-select";
    sel.setAttribute("aria-label", "Section");
    sections.forEach(function (s) {
      var o = document.createElement("option");
      o.value = s.id; o.textContent = s.name;
      sel.appendChild(o);
    });
    pop.appendChild(labeledRow("Section", sel));
    if (window.enhanceSelect) window.enhanceSelect(sel);   // themed dropdown

    // Days checklist.
    var daysLabel = document.createElement("div");
    daysLabel.className = "suggest-label";
    daysLabel.textContent = occ.length
      ? "Apply to these days:" : "No recent days mention this word.";
    pop.appendChild(daysLabel);

    var list = document.createElement("div");
    list.className = "suggest-days-list";
    var boxes = [];
    occ.forEach(function (o) {
      var row = document.createElement("label");
      row.className = "suggest-day-row";
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = true;
      cb.value = o.date;
      cb.addEventListener("change", refreshConfirm);
      boxes.push(cb);
      var dt = document.createElement("span");
      dt.className = "suggest-day-date";
      dt.textContent = o.date;
      var sn = document.createElement("span");
      sn.className = "suggest-day-snippet";
      renderSnippet(sn, o.snippet);
      row.appendChild(cb);
      row.appendChild(dt);
      row.appendChild(sn);
      list.appendChild(row);
    });
    pop.appendChild(list);

    // Actions.
    var actions = document.createElement("div");
    actions.className = "suggest-popup-actions";
    var cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "modal-cancel";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", closeApplyPopup);
    var confirm = document.createElement("button");
    confirm.type = "button";
    confirm.className = "modal-confirm";
    confirm.textContent = "Confirm";
    actions.appendChild(cancel);
    actions.appendChild(confirm);
    pop.appendChild(actions);
    var status = document.createElement("p");
    status.className = "muted-note";
    status.setAttribute("role", "status");
    status.hidden = true;
    pop.appendChild(status);
    var applying = false;

    function checkedDates() {
      return boxes.filter(function (b) { return b.checked; })
                  .map(function (b) { return b.value; });
    }
    function refreshConfirm() {
      confirm.disabled = applying || !sections.length || checkedDates().length === 0;
    }
    refreshConfirm();

    confirm.addEventListener("click", function () {
      var dates = checkedDates();
      if (applying || !dates.length || !sections.length) return;
      applying = _applying = true;
      var controls = Array.from(pop.querySelectorAll('button, input, select')).map(function (control) {
        var state = { control: control, disabled: control.disabled };
        control.disabled = true;
        return state;
      });
      pop.setAttribute("aria-busy", "true");
      pop.focus();
      status.hidden = true;
      var fd = new FormData();
      fd.append("section_id", sel.value);
      fd.append("kind", kindVal);
      dates.forEach(function (dt) { fd.append("dates", dt); });
      apiPost("/journal/suggestions/" + encodeURIComponent(word) + "/apply", fd)
        .then(function (res) {
          if (res && res.ok) {
            location.reload();
          } else throw new Error("Apply failed");
        })
        .catch(function () {
          applying = _applying = false;
          controls.forEach(function (state) { state.control.disabled = state.disabled; });
          pop.removeAttribute("aria-busy");
          refreshConfirm();
          confirm.focus();
          status.textContent = "Could not apply · try again";
          status.hidden = false;
        });
    });
  }

  function labeledRow(label, control) {
    var row = document.createElement("div");
    row.className = "suggest-popup-row";
    var l = document.createElement("span");
    l.className = "suggest-popup-rowlabel";
    l.textContent = label;
    row.appendChild(l);
    row.appendChild(control);
    return row;
  }

  render();
})();
