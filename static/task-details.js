/* task-details.js — inline notes + subtask checklist for each task.
   Vanilla JS only, no third-party libraries.

   Loaded (with defer) on the Active and Archive pages. Each task row carries
   a clickable .task-title-toggle and a hidden .task-details dropdown.

   Active: clicking the title expands the dropdown; notes save (debounced) and
   subtask add/toggle/edit/delete all POST to granular JSON endpoints and
   re-render the subtask list from the returned `subtasks` array.

   Archive: the dropdown is marked data-readonly — only expand/collapse is
   wired; no save handlers.
*/

(function () {
  "use strict";

  function postJSON(url, body) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    });
  }

  /* ---- collapsed hint (… and n/m count) -------------------------------- */

  function updateHint(toggle, details) {
    var subList = details.querySelector(".subtask-list");
    var rows = subList ? subList.querySelectorAll(".subtask-row") : [];
    var total = rows.length;
    var done = 0;
    rows.forEach(function (row) {
      var cb = row.querySelector(".subtask-check");
      if (cb && cb.checked) done += 1;
    });
    var notesEl = details.querySelector(".task-notes");
    var hasNotes = notesEl ? notesEl.value.trim() !== "" :
      !!details.querySelector(".task-notes-readonly");
    var hasDetails = hasNotes || total > 0;

    var hint = toggle.querySelector(".detail-hint");
    if (hasDetails && !hint) {
      hint = document.createElement("span");
      hint.className = "detail-hint";
      hint.innerHTML = "&hellip;";
      toggle.appendChild(hint);
    } else if (!hasDetails && hint) {
      hint.remove();
    }

    var progress = toggle.querySelector(".subtask-progress");
    if (total > 0) {
      if (!progress) {
        progress = document.createElement("span");
        progress.className = "subtask-progress";
        toggle.appendChild(progress);
      }
      progress.textContent = done + "/" + total;
    } else if (progress) {
      progress.remove();
    }
  }

  /* ---- subtask list rendering (editable / active only) ----------------- */

  function buildRow(taskId, sub, index) {
    var li = document.createElement("li");
    li.className = "subtask-row";
    li.dataset.index = String(index);
    // The whole row is the drag handle so grabbing anywhere reorders it; the
    // grip glyph is just a visual affordance. The text input opts out
    // (draggable=false) so click-to-edit / text selection still work.
    li.setAttribute("draggable", "true");

    var handle = document.createElement("span");
    handle.className = "subtask-drag";
    handle.setAttribute("aria-hidden", "true");
    handle.setAttribute("title", "Drag to reorder");
    handle.textContent = "⠇";  // ⠇ braille grip

    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "subtask-check";
    cb.checked = !!sub.done;

    var text = document.createElement("input");
    text.type = "text";
    text.className = "subtask-text";
    text.setAttribute("draggable", "false");
    text.value = sub.text;

    var del = document.createElement("button");
    del.type = "button";
    del.className = "subtask-del";
    del.setAttribute("aria-label", "delete subtask");
    del.innerHTML = "&times;";

    li.appendChild(handle);
    li.appendChild(cb);
    li.appendChild(text);
    li.appendChild(del);
    return li;
  }

  function renderList(taskId, details, subtasks) {
    var list = details.querySelector(".subtask-list");
    if (!list) return;
    list.innerHTML = "";
    subtasks.forEach(function (sub, i) {
      list.appendChild(buildRow(taskId, sub, i));
    });
  }

  /* ---- wire one active (editable) task --------------------------------- */

  function wireEditable(toggle, details) {
    var taskId = details.dataset.taskId;
    var notesEl = details.querySelector(".task-notes");
    var list = details.querySelector(".subtask-list");
    var addInput = details.querySelector(".subtask-add");
    var addBtn = details.querySelector(".subtask-add-btn");

    // Notes: debounced save on input.
    if (notesEl) {
      var timer = null;
      notesEl.addEventListener("input", function () {
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () {
          postJSON("/task/" + taskId + "/notes", { text: notesEl.value })
            .then(function () { updateHint(toggle, details); });
        }, 400);
      });
    }

    function refresh(resp) {
      if (!resp.ok) return;
      resp.json().then(function (data) {
        renderList(taskId, details, data.subtasks || []);
        updateHint(toggle, details);
      });
    }

    // Add subtask (button click or Enter in the add input).
    function addSubtask() {
      var text = addInput.value.trim();
      if (!text) return;
      postJSON("/task/" + taskId + "/subtasks", { text: text }).then(function (resp) {
        if (resp.ok) addInput.value = "";
        refresh(resp);
      });
    }
    if (addBtn) addBtn.addEventListener("click", addSubtask);
    if (addInput) {
      addInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); addSubtask(); }
      });
    }

    // Delegated handlers on the list (rows are re-rendered from the server).
    if (list) {
      list.addEventListener("change", function (e) {
        var cb = e.target.closest(".subtask-check");
        if (!cb) return;
        var row = cb.closest(".subtask-row");
        var idx = row.dataset.index;
        postJSON("/task/" + taskId + "/subtasks/" + idx + "/toggle").then(refresh);
      });

      list.addEventListener("click", function (e) {
        var del = e.target.closest(".subtask-del");
        if (!del) return;
        var idx = del.closest(".subtask-row").dataset.index;
        postJSON("/task/" + taskId + "/subtasks/" + idx + "/delete").then(refresh);
      });

      // Edit subtask text on blur or Enter, only when it actually changed.
      list.addEventListener("focusin", function (e) {
        var input = e.target.closest(".subtask-text");
        if (input) input._original = input.value;
      });
      function commitEdit(input) {
        var idx = input.closest(".subtask-row").dataset.index;
        var text = input.value.trim();
        if (text === (input._original || "").trim()) return;  // unchanged
        if (!text) { input.value = input._original || ""; return; }  // don't clear
        postJSON("/task/" + taskId + "/subtasks/" + idx, { text: text }).then(refresh);
      }
      list.addEventListener("focusout", function (e) {
        var input = e.target.closest(".subtask-text");
        if (input) commitEdit(input);
      });
      list.addEventListener("keydown", function (e) {
        if (e.key !== "Enter") return;
        var input = e.target.closest(".subtask-text");
        if (input) { e.preventDefault(); input.blur(); }
      });

      // Drag-and-drop reordering (native HTML5 DnD, no libraries). The whole
      // row is draggable so grabbing anywhere reorders it; the text input opts
      // out (draggable=false) so editing/selection is unaffected. On drop we
      // POST the from/to indices and re-render from the returned list.
      var draggedRow = null;

      function clearDropTargets() {
        list.querySelectorAll(".subtask-row.drop-target").forEach(function (r) {
          r.classList.remove("drop-target");
        });
      }

      list.addEventListener("dragstart", function (e) {
        // Never start a row drag from inside the editable text field.
        if (e.target.closest(".subtask-text")) return;
        draggedRow = e.target.closest(".subtask-row");
        if (!draggedRow) return;
        draggedRow.classList.add("dragging");
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move";
          e.dataTransfer.setData("text/plain", draggedRow.dataset.index || "");
          if (e.dataTransfer.setDragImage) {
            e.dataTransfer.setDragImage(draggedRow, 0, 0);
          }
        }
      });

      list.addEventListener("dragover", function (e) {
        if (!draggedRow) return;
        var row = e.target.closest(".subtask-row");
        if (!row || row === draggedRow) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        clearDropTargets();
        row.classList.add("drop-target");
      });

      list.addEventListener("dragleave", function (e) {
        var row = e.target.closest(".subtask-row");
        if (row && !row.contains(e.relatedTarget)) row.classList.remove("drop-target");
      });

      list.addEventListener("drop", function (e) {
        if (!draggedRow) return;
        var row = e.target.closest(".subtask-row");
        clearDropTargets();
        if (!row || row === draggedRow) return;
        e.preventDefault();
        var from = parseInt(draggedRow.dataset.index, 10);
        var to = parseInt(row.dataset.index, 10);
        if (isNaN(from) || isNaN(to) || from === to) return;
        postJSON("/task/" + taskId + "/subtasks/reorder", { from: from, to: to })
          .then(refresh);
      });

      list.addEventListener("dragend", function () {
        if (draggedRow) draggedRow.classList.remove("dragging");
        clearDropTargets();
        draggedRow = null;
      });
    }

    // Form-safety: never let Enter inside the dropdown submit the /refresh form.
    details.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && e.target.tagName !== "TEXTAREA") {
        e.preventDefault();
      }
    });
  }

  /* ---- expand / collapse (all tasks) ----------------------------------- */

  function wireToggle(toggle) {
    var li = toggle.closest(".task");
    if (!li) return;
    var details = li.querySelector(".task-details");
    if (!details) return;

    function expanded() { return !details.hidden; }
    function setExpanded(on) {
      details.hidden = !on;
      // The collapsed hint is only meaningful when collapsed; keep it visible
      // either way (it's small) but refresh the count on collapse.
      if (!on) updateHint(toggle, details);
    }

    toggle.addEventListener("click", function () { setExpanded(!expanded()); });
    toggle.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setExpanded(!expanded());
      }
    });

    if (!details.hasAttribute("data-readonly")) {
      wireEditable(toggle, details);
    }
  }

  document.querySelectorAll(".task-title-toggle").forEach(wireToggle);
}());
