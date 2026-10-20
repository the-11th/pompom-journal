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

  var formSaves = new Map();

  function guardRefresh(form, controller) {
    if (!form) return;
    if (!formSaves.has(form)) {
      var controllers = [], waiting = false;
      formSaves.set(form, controllers);
      form.addEventListener("submit", function (event) {
        if (!controllers.some(function (item) { return item.pending(); })) return;
        event.preventDefault();
        if (waiting) return;
        waiting = true;
        var submitter = event.submitter;
        if (submitter) submitter.disabled = true;
        function flush() {
          return Promise.all(controllers.map(function (item) { return item.flush(); }))
            .then(function (results) {
              if (results.some(function (saved) { return !saved; })) return false;
              return controllers.some(function (item) { return item.pending(); }) ? flush() : true;
            });
        }
        flush().then(function (saved) {
          waiting = false;
          if (submitter) submitter.disabled = false;
          if (saved) {
            if (form.requestSubmit) {
              if (submitter) form.requestSubmit(submitter); else form.requestSubmit();
            } else form.submit();
          }
        });
      });
    }
    formSaves.get(form).push(controller);
  }

  function postJSON(url, body) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
      keepalive: true,
    }).then(function (response) {
      if (!response.ok) throw new Error("Save failed");
      return response.json();
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
    var handle = document.createElement("span");
    handle.className = "subtask-drag";
    handle.setAttribute("draggable", "true");
    handle.setAttribute("aria-hidden", "true");
    handle.setAttribute("title", "Drag to reorder");
    handle.textContent = "⠇";  // ⠇ braille grip

    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "subtask-check";
    cb.checked = !!sub.done;
    cb.setAttribute("aria-label", "Complete " + sub.text);

    var text = document.createElement("input");
    text.type = "text";
    text.className = "subtask-text";
    text.setAttribute("draggable", "false");
    text.value = sub.text;
    text.setAttribute("aria-label", "Subtask text");

    var del = document.createElement("button");
    del.type = "button";
    del.className = "subtask-del";
    del.setAttribute("aria-label", "Delete subtask: " + sub.text);
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
    var noteTimer = null, noteSaving = null, subSaving = null;
    var subEditing = false, queuedSubSave = null;
    var savedNotes = notesEl ? notesEl.value.trim() : "", noteError = false, subError = false, hasSaved = false;
    var state = document.createElement("div");
    state.className = "task-save-state";
    var status = document.createElement("span");
    status.className = "task-save-status";
    status.setAttribute("role", "status");
    var retry = document.createElement("button");
    retry.type = "button"; retry.className = "task-save-retry";
    retry.textContent = "Retry notes";
    state.appendChild(status); state.appendChild(retry); details.appendChild(state);

    function notesDirty() { return notesEl && notesEl.value.trim() !== savedNotes; }
    function showState() {
      var busy = !!noteSaving || !!subSaving || !!queuedSubSave;
      details.setAttribute("aria-busy", String(busy));
      status.classList.toggle("is-error", noteError || subError);
      status.textContent = noteError ? "Notes not saved" : subError ? "Could not confirm subtask save · reload to check" : busy ? "Saving…" : notesDirty() ? "Unsaved notes" : hasSaved ? "Saved" : "";
      retry.hidden = !noteError || !!noteSaving;
      state.hidden = !status.textContent;
    }

    function saveNotes() {
      clearTimeout(noteTimer);
      if (noteSaving) return noteSaving;
      if (!notesDirty()) return Promise.resolve(true);
      var value = notesEl.value;
      noteError = false;
      noteSaving = postJSON("/task/" + taskId + "/notes", { text: value })
        .then(function (data) {
          if (typeof data.notes !== 'string' || data.notes !== value.trim()) throw new Error('Invalid note response');
          savedNotes = data.notes;
          if (document.activeElement !== notesEl && notesEl.value.trim() === savedNotes) notesEl.value = savedNotes;
          hasSaved = true; updateHint(toggle, details); return true;
        }).catch(function () { noteError = true; return false; })
        .then(function (saved) {
          noteSaving = null;
          showState();
          return saved && notesDirty() ? saveNotes() : saved;
        });
      showState();
      return noteSaving;
    }
    retry.addEventListener("click", saveNotes);

    // Notes: debounced save on input.
    if (notesEl) {
      notesEl.setAttribute("aria-label", "Task notes");
      notesEl.addEventListener("input", function () {
        clearTimeout(noteTimer);
        if (!notesDirty()) noteError = false;
        noteTimer = setTimeout(saveNotes, 400);
        showState();
      });
      notesEl.addEventListener("blur", function () {
        saveNotes().then(function (saved) { if (saved && document.activeElement !== notesEl && !notesDirty()) notesEl.value = savedNotes; });
      });
      window.addEventListener("beforeunload", function (event) {
        if (!notesDirty()) return;
        void saveNotes();
        event.preventDefault(); event.returnValue = "";
      });
    }

    function mutate(path, body, focusIndex, focusSelector) {
      if (subError) return Promise.resolve(false);
      if (subSaving) {
        // Text edits preserve row indices. Let the click that blurred a field
        // follow its save instead of disappearing when the list becomes inert.
        if (!subEditing || queuedSubSave) return Promise.resolve(false);
        if (list) list.inert = true;
        if (addBtn) addBtn.disabled = true;
        queuedSubSave = subSaving.then(function (saved) {
          queuedSubSave = null;
          return saved ? mutate(path, body, focusIndex, focusSelector) : false;
        });
        return queuedSubSave;
      }
      var textEdit = /^\/subtasks\/\d+$/.test(path);
      var editedInput = textEdit && list && list.querySelector('.subtask-row[data-index="' + focusIndex + '"] .subtask-text');
      var focused = document.activeElement;
      subEditing = textEdit;
      if (list) list.inert = !textEdit;
      if (addBtn) addBtn.disabled = !textEdit;
      subSaving = postJSON("/task/" + taskId + path, body).then(function (data) {
        if (!Array.isArray(data.subtasks)) throw new Error("Invalid subtask response");
        var restoreFocus = !textEdit && focused && list && list.contains(focused);
        if (textEdit) {
          var edited = data.subtasks[focusIndex];
          if (!edited || !editedInput) throw new Error("Invalid subtask response");
          if (editedInput.value.trim() === body.text) editedInput.value = edited.text;
          editedInput._original = edited.text;
          editedInput.closest('.subtask-row').querySelector('.subtask-check').setAttribute('aria-label', 'Complete ' + edited.text);
          editedInput.closest('.subtask-row').querySelector('.subtask-del').setAttribute('aria-label', 'Delete subtask: ' + edited.text);
        } else renderList(taskId, details, data.subtasks);
        if (list) list.inert = !!queuedSubSave;
        if (restoreFocus) {
          var rows = list.querySelectorAll(".subtask-row");
          var row = rows[Math.min(focusIndex || 0, rows.length - 1)];
          var nextFocus = row && row.querySelector(focusSelector || ".subtask-text");
          (nextFocus || addInput || toggle).focus();
        }
        hasSaved = true; updateHint(toggle, details); return true;
      }).catch(function () {
        // Index-based operations may have succeeded before the reply was lost.
        // Keep the list intact and do not replay an uncertain add/toggle/delete.
        subError = true; return false;
      }).then(function (saved) {
        subSaving = null;
        subEditing = false;
        if (list) list.inert = subError || !!queuedSubSave;
        if (addBtn) addBtn.disabled = subError || !!queuedSubSave;
        if (addInput) addInput.readOnly = subError;
        showState(); return saved;
      });
      showState();
      return subSaving;
    }

    // Add subtask (button click or Enter in the add input).
    function addSubtask() {
      var text = addInput.value.trim();
      if (!text || (subSaving && !subEditing) || queuedSubSave || subError) return;
      mutate("/subtasks", { text: text }).then(function (saved) {
        if (saved && addInput.value.trim() === text) addInput.value = "";
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
        mutate("/subtasks/" + idx + "/toggle", {}, Number(idx), ".subtask-check");
      });

      list.addEventListener("click", function (e) {
        var del = e.target.closest(".subtask-del");
        if (!del) return;
        var idx = del.closest(".subtask-row").dataset.index;
        mutate("/subtasks/" + idx + "/delete", {}, Number(idx), ".subtask-del");
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
        mutate("/subtasks/" + idx, { text: text }, Number(idx));
      }
      list.addEventListener("focusout", function (e) {
        var input = e.target.closest(".subtask-text");
        if (input) commitEdit(input);
      });
      list.addEventListener("keydown", function (e) {
        if (e.key !== "Enter") return;
        var input = e.target.closest(".subtask-text");
        if (input) { e.preventDefault(); commitEdit(input); }
      });

      // Only the grip starts native dragging, preserving checkbox clicks and
      // text selection. Drop posts the indices and re-renders the saved list.
      var draggedRow = null;

      function clearDropTargets() {
        list.querySelectorAll(".subtask-row.drop-target").forEach(function (r) {
          r.classList.remove("drop-target");
        });
      }

      list.addEventListener("dragstart", function (e) {
        var grip = e.target.closest(".subtask-drag");
        if (!grip) { e.preventDefault(); return; }
        draggedRow = grip.closest(".subtask-row");
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
        mutate("/subtasks/reorder", { from: from, to: to }, to);
      });

      list.addEventListener("dragend", function () {
        if (draggedRow) draggedRow.classList.remove("dragging");
        clearDropTargets();
        draggedRow = null;
      });
    }

    // Form-safety: never let Enter inside the dropdown submit the /refresh form.
    details.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && e.target.tagName === "INPUT") {
        e.preventDefault();
      }
    });
    guardRefresh(details.closest("form"), {
      pending: function () { return notesDirty() || !!noteSaving || !!subSaving || !!queuedSubSave || subError; },
      flush: function () {
        return Promise.all([saveNotes(), queuedSubSave || subSaving || Promise.resolve(!subError)]).then(function (results) {
          var saved = results.every(Boolean);
          if (!saved) {
            details.hidden = false; toggle.setAttribute("aria-expanded", "true");
            (noteError ? retry : toggle).focus();
          }
          return saved;
        });
      },
    });
    showState();
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
      toggle.setAttribute("aria-expanded", String(on));
      // The collapsed hint is only meaningful when collapsed; keep it visible
      // either way (it's small) but refresh the count on collapse.
      if (!on) updateHint(toggle, details);
    }

    toggle.addEventListener("click", function () { setExpanded(!expanded()); });
    toggle.setAttribute("aria-expanded", String(expanded()));
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
