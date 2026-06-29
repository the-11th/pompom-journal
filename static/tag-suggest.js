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
      lbl.textContent = "Frequent words you don't tag yet — click to tag them:";
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
        .catch(function () { del.disabled = false; });
    });

    chip.appendChild(body);
    chip.appendChild(del);
    return chip;
  }

  // ----- apply popup -----
  var _applyPopup = null;
  function closeApplyPopup() {
    if (_applyPopup) { _applyPopup.remove(); _applyPopup = null; }
    document.removeEventListener("keydown", _applyEscHandler);
    document.removeEventListener("mousedown", _applyOutsideHandler, true);
  }
  function _applyEscHandler(e) { if (e.key === "Escape") closeApplyPopup(); }
  function _applyOutsideHandler(e) {
    if (_applyPopup && !_applyPopup.contains(e.target)) closeApplyPopup();
  }

  function openApplyPopup(word, chip) {
    closeApplyPopup();
    var overlay = document.createElement("div");
    overlay.className = "suggest-popup-overlay";
    var pop = document.createElement("div");
    pop.className = "suggest-popup";
    overlay.appendChild(pop);

    var close = document.createElement("button");
    close.type = "button";
    close.className = "suggest-popup-close";
    close.textContent = "×";
    close.addEventListener("click", closeApplyPopup);
    pop.appendChild(close);

    var head = document.createElement("div");
    head.className = "suggest-popup-head";
    head.textContent = "Tag “" + word + "”";
    pop.appendChild(head);

    var loading = document.createElement("p");
    loading.className = "analytics-empty";
    loading.textContent = "Loading…";
    pop.appendChild(loading);

    document.body.appendChild(overlay);
    _applyPopup = overlay;
    document.addEventListener("keydown", _applyEscHandler);
    document.addEventListener("mousedown", _applyOutsideHandler, true);

    fetch("/journal/suggestions/" + encodeURIComponent(word),
          { headers: { "Accept": "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (d) { fillApplyPopup(pop, loading, word, chip, d); })
      .catch(function () { loading.textContent = "Could not load suggestion."; });
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
      b.textContent = k[1];
      b.addEventListener("click", function () {
        kindVal = k[0];
        kindWrap.querySelectorAll(".kind-opt").forEach(function (o) {
          o.classList.remove("active");
        });
        b.classList.add("active");
      });
      kindWrap.appendChild(b);
    });
    pop.appendChild(labeledRow("Kind", kindWrap));

    // Section select (active tag sections).
    var sel = document.createElement("select");
    sel.className = "suggest-section-select";
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

    function checkedDates() {
      return boxes.filter(function (b) { return b.checked; })
                  .map(function (b) { return b.value; });
    }
    function refreshConfirm() {
      confirm.disabled = !sections.length || checkedDates().length === 0;
    }
    refreshConfirm();

    confirm.addEventListener("click", function () {
      var dates = checkedDates();
      if (!dates.length || !sections.length) return;
      confirm.disabled = true;
      var fd = new FormData();
      fd.append("section_id", sel.value);
      fd.append("kind", kindVal);
      dates.forEach(function (dt) { fd.append("dates", dt); });
      apiPost("/journal/suggestions/" + encodeURIComponent(word) + "/apply", fd)
        .then(function (res) {
          if (res && res.ok) {
            location.reload();
          } else {
            confirm.disabled = false;
          }
        })
        .catch(function () { confirm.disabled = false; });
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
