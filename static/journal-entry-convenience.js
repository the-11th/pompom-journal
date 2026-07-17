/* Durable browser drafts, title suggestions, and entry-page shortcuts. */
(function () {
  "use strict";

  var form = document.getElementById("journal-form");
  if (!form) return;
  var date = form.getAttribute("data-entry-date") || "";
  var baseUpdated = form.getAttribute("data-entry-updated") || "";
  var key = "todopup:journal-draft:" + date;
  var status = document.getElementById("draft-status");
  var title = form.querySelector('input[name="title"]');
  var body = form.querySelector('textarea[name="body"]');
  var suggestion = document.getElementById("title-suggestion");
  var timer = null;

  function setStatus(message) {
    if (status) status.textContent = message;
  }

  function values() {
    var out = {};
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name || el.type === "submit" || el.type === "button") return;
      if (el.type === "checkbox" || el.type === "radio") {
        if (!out[el.name]) out[el.name] = [];
        if (el.checked) out[el.name].push(el.value);
      } else {
        out[el.name] = el.value;
      }
    });
    return out;
  }

  function restore(saved) {
    var map = saved.values || {};
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name || !Object.prototype.hasOwnProperty.call(map, el.name)) return;
      if (el.type === "checkbox" || el.type === "radio") {
        el.checked = (map[el.name] || []).indexOf(el.value) >= 0;
      } else {
        el.value = map[el.name];
      }
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    setStatus("Draft restored");
    updateTitleSuggestion();
  }

  function saveDraft() {
    try {
      localStorage.setItem(key, JSON.stringify({
        base_updated: baseUpdated,
        edited_at: new Date().toISOString(),
        values: values(),
      }));
      setStatus("Draft saved locally");
    } catch (e) {
      setStatus("Draft could not be saved");
    }
  }

  function queueDraft() {
    setStatus("Unsaved changes");
    clearTimeout(timer);
    timer = setTimeout(saveDraft, 350);
    updateTitleSuggestion();
  }

  function updateTitleSuggestion() {
    if (!suggestion || !title || !body || !window.todoPupVoice) return;
    var proposed = title.value.trim() ? "" : window.todoPupVoice.suggestTitle(body.value);
    suggestion.hidden = !proposed;
    suggestion.dataset.value = proposed;
    var label = suggestion.querySelector("span");
    if (label) label.textContent = proposed ? "Suggested: “" + proposed + "”" : "";
  }

  if (suggestion) {
    suggestion.querySelector("button").addEventListener("click", function () {
      if (!title || !suggestion.dataset.value || title.value.trim()) return;
      title.value = suggestion.dataset.value;
      suggestion.hidden = true;
      title.dispatchEvent(new Event("input", { bubbles: true }));
      title.focus();
    });
  }

  var params = new URLSearchParams(window.location.search);
  if (params.get("saved") === "1") {
    localStorage.removeItem(key);
    params.delete("saved");
    var clean = window.location.pathname + (params.toString() ? "?" + params : "") + window.location.hash;
    history.replaceState(null, "", clean);
    setStatus("Entry saved");
  } else {
    try {
      var saved = JSON.parse(localStorage.getItem(key) || "null");
      if (saved && saved.values) {
        if (saved.base_updated === baseUpdated) restore(saved);
        else if (window.confirmModal) {
          window.confirmModal("A local draft exists, but this entry changed elsewhere. Restore the local draft for review?", "Restore")
            .then(function (yes) { if (yes) restore(saved); });
        }
      }
    } catch (e) { localStorage.removeItem(key); }
  }

  form.addEventListener("input", queueDraft);
  form.addEventListener("change", queueDraft);
  form.addEventListener("submit", function (event) {
    if (title && !title.value.trim()) {
      updateTitleSuggestion();
      event.preventDefault();
      if (suggestion && !suggestion.hidden) suggestion.querySelector("button").focus();
      else title.focus();
      setStatus("Choose or write a title before finishing");
      return;
    }
    clearTimeout(timer);
    saveDraft();
  });

  document.addEventListener("keydown", function (event) {
    if (!event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Enter") {
      event.preventDefault();
      if (form.requestSubmit) form.requestSubmit(); else form.submit();
    } else if (event.shiftKey && (event.key || "").toLowerCase() === "m") {
      var mic = document.querySelector(".dictation-mic:not([disabled])");
      if (mic) { event.preventDefault(); mic.click(); }
    }
  });

  updateTitleSuggestion();
})();
