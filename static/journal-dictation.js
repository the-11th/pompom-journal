/* journal-dictation.js — live voice dictation into the journal body via the
   Web Speech API. Vanilla JS, no third-party libraries.

   Behaviour (v1):
   - A record button sits in the top-right corner of the body text box. Click it
     to start/stop recognition (only shown when the browser supports Web Speech).
   - Recognized words are inserted at the current caret. If text is selected when
     recording starts, that selection is overwritten (this is how a word is
     replaced: select the word, then dictate).
   - Everything dictated in the current session stays HIGHLIGHTED (a translucent
     amber run drawn by the backdrop behind the textarea) until confirmed.
   - A small confirm (✓) button in the bottom-right commits the run: the
     highlight clears and the text becomes normal editable body text.

   The <textarea> stays the single source of truth (save / @mentions / #numeric /
   [] tasks / rich rendering all keep working); the highlight is a visual overlay
   only. journal-richtext.js is told to keep the raw textarea live while dictating
   (input.dataset.dictating) so the backdrop stays aligned. */

/* Turn spoken command words into symbols/punctuation, live. Kept outside the
   browser initializer so this pure transformation can be tested in Node. */
function applyVoiceCommands(text) {
  var t = text;
  // Prefix symbols glue to the following word.
  t = t.replace(/\bat symbol\s*/gi, "@");
  t = t.replace(/\bhashtag\s*/gi, "#");
  // Infix symbols glue to both neighboring words.
  t = t.replace(/\s*\bunderscore\b\s*/gi, "_");
  t = t.replace(/\s*\bslash\b\s*/gi, "/");
  // Task marker is a standalone token; keep the space before its title.
  t = t.replace(/\b(?:open close bracket|checkbox)\b/gi, "[]");
  // Line break consumes the spaces around it.
  t = t.replace(/\s*\bnew line\b\s*/gi, "\n");
  // Opening quote preserves preceding space and glues to the following text.
  t = t.replace(/(\s*)\bleft quote\b\s*/gi, function (m, pre) {
    return pre + "\u201c";
  });
  // Closing quote glues to preceding text and preserves following space.
  t = t.replace(/\s*\bright quote\b(\s*)/gi, function (m, post) {
    return "\u201d" + post;
  });
  // Suffix punctuation glues to the preceding word.
  t = t.replace(/\s*\bdot dot dot\b/gi, "...");
  t = t.replace(/\s*\bexclamation mark\b/gi, "!");
  t = t.replace(/\s*\bquestion mark\b/gi, "?");
  t = t.replace(/\s*\bperiod\b/gi, ".");
  t = t.replace(/\s*\bcomma\b/gi, ",");
  t = t.replace(/\s*\bcolon\b/gi, ":");
  // "Parenthesis" alternates left/right across the complete transcript.
  var openParen = true;
  t = t.replace(/(\s*)\b(?:parenthesis|parentheses)\b(\s*)/gi, function (m, pre, post) {
    if (openParen) { openParen = false; return pre + "("; }
    openParen = true;
    return ")" + post;
  });
  // Tidy accidental double spaces without touching newlines.
  return t.replace(/ {2,}/g, " ");
}

function normalizeVoiceName(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

/* Split spoken `tag Alex, tag gym` controls from prose. The returned commands
   stay pending until the UI confirms the dictation; this pure function is also
   mirrored by Android and covered by the same behavior fixtures. */
function parseVoiceTagCommands(text, catalog) {
  var tags = (catalog || []).map(function (item) {
    return {
      name: normalizeVoiceName(item.name),
      section_id: item.section_id,
      section_name: normalizeVoiceName(item.section_name),
    };
  });
  var sections = [];
  tags.forEach(function (item) {
    if (item.section_id && !sections.some(function (s) { return s.id === item.section_id; })) {
      sections.push({ id: item.section_id, name: item.section_name });
    }
  });
  var commands = [];
  var commandRe = /\btag\s+([^,;.!?\n]+?)(?=\s+\btag\s+|[,;.!?\n]|$)/gi;
  var cleaned = String(text || "").replace(commandRe, function (whole, spoken) {
    var raw = normalizeVoiceName(spoken);
    var section = null;
    sections.sort(function (a, b) { return b.name.length - a.name.length; }).some(function (s) {
      if (raw === s.name || raw.indexOf(s.name + " ") === 0) {
        section = s;
        raw = normalizeVoiceName(raw.slice(s.name.length));
        return true;
      }
      return false;
    });
    var matches = tags.filter(function (item) {
      return item.name === raw && (!section || item.section_id === section.id);
    });
    var ids = [];
    matches.forEach(function (item) { if (ids.indexOf(item.section_id) < 0) ids.push(item.section_id); });
    commands.push({
      original: whole,
      name: raw,
      section_id: ids.length === 1 ? ids[0] : (section ? section.id : null),
      section_ids: ids,
      status: matches.length ? (ids.length === 1 ? "matched" : "ambiguous") : "new",
    });
    return "";
  });
  cleaned = cleaned
    .replace(/\s+([,;.!?])/g, "$1")
    .replace(/([,;])\s*([,;])/g, "$2")
    .replace(/[,;]\s*([.!?])/g, "$1")
    .replace(/(^|\n)\s*[,;]\s*/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+\n/g, "\n")
    .trim();
  return { text: cleaned, commands: commands };
}

function suggestEntryTitle(body, limit) {
  limit = limit || 60;
  var lines = String(body || "").split(/\r?\n/);
  var first = "";
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].trim()) { first = lines[i].trim(); break; }
  }
  if (!first) return "";
  var sentence = first.match(/^.*?[.!?](?:\s|$)/);
  if (sentence) first = sentence[0];
  first = first
    .replace(/^(?:-\s*)?\[\s*\]\s*/, "")
    .replace(/\s+>(?:today|tomorrow|[a-z]+|\+\d+[dwm]|\d{4}-\d{2}-\d{2})\b/gi, "")
    .replace(/\[task:[0-9a-f]+\]\s*/gi, "")
    .replace(/\*\*|__|~~|\*/g, "")
    .replace(/@([A-Za-z0-9_.-]+)/g, function (m, n) { return n.replace(/_/g, " "); })
    .replace(/#([A-Za-z0-9_-]+)\s+(-?\d+(?:\.\d+)?)/g,
      function (m, n, v) { return n.replace(/_/g, " ") + " " + v; })
    .replace(/\s+/g, " ").replace(/^[\s.,:;!?\-–—]+|[\s.,:;!?\-–—]+$/g, "");
  if (first.length > limit) {
    var cut = first.slice(0, limit + 1);
    first = cut.indexOf(" ") >= 0 ? cut.slice(0, cut.lastIndexOf(" ")) : cut.slice(0, limit);
  }
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : "";
}

/* Join one dictated run at a cursor without creating spaces before closing
   punctuation or inside brackets/quotes. Newlines are meaningful, so only
   incidental horizontal whitespace from recognition is trimmed. */
function smartDictationJoin(before, text, after) {
  before = String(before || "");
  after = String(after || "");
  text = String(text || "").replace(/^[ \t]+|[ \t]+$/g, "");
  var lead = "", trail = "";
  var closes = /^[\s.,!?;:)\]}”’\/]/;
  var opensOrGlues = /[\s(\[{“‘\/]$/;
  if (text && before && !opensOrGlues.test(before) && !closes.test(text)) lead = " ";
  if (text && after && !/[\s(\[{“‘\/]$/.test(text) && !/^[\s.,!?;:)\]}”’\/]/.test(after)) {
    trail = " ";
  }
  var runStart = before.length + lead.length;
  return {
    before: before,
    text: text,
    after: after,
    lead: lead,
    trail: trail,
    runStart: runStart,
    runEnd: runStart + text.length,
    caret: runStart + text.length,
    value: before + lead + text + trail + after,
  };
}

/* Rebase highlight offsets after a manual textarea edit. Text inserted by hand
   is deliberately excluded from speech highlights; surviving dictated text on
   either side stays highlighted and later ranges shift by the edit delta. */
function adjustHighlightedRanges(oldValue, newValue, ranges) {
  oldValue = String(oldValue || "");
  newValue = String(newValue || "");
  var start = 0;
  while (start < oldValue.length && start < newValue.length &&
         oldValue.charAt(start) === newValue.charAt(start)) start++;
  var suffix = 0;
  while (suffix < oldValue.length - start && suffix < newValue.length - start &&
         oldValue.charAt(oldValue.length - 1 - suffix) === newValue.charAt(newValue.length - 1 - suffix)) suffix++;
  var oldEnd = oldValue.length - suffix;
  var newEnd = newValue.length - suffix;
  var delta = newEnd - oldEnd;
  var out = [];
  (ranges || []).forEach(function (range) {
    var a = range[0], b = range[1];
    if (b <= start) { out.push([a, b]); return; }
    if (a >= oldEnd) { out.push([a + delta, b + delta]); return; }
    if (a < start) out.push([a, start]);
    if (b > oldEnd) out.push([newEnd, b + delta]);
  });
  return out.filter(function (range) { return range[1] > range[0]; });
}

if (typeof window !== "undefined") {
  window.todoPupVoice = {
    transform: applyVoiceCommands,
    parseTags: parseVoiceTagCommands,
    suggestTitle: suggestEntryTitle,
    smartJoin: smartDictationJoin,
    adjustRanges: adjustHighlightedRanges,
  };
}

(function () {
  "use strict";

  if (typeof window === "undefined" || typeof document === "undefined") return;

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var field = document.querySelector(".body-field");
  if (!field) return;
  var input = field.querySelector(".body-input");
  var backdrop = field.querySelector(".dictation-backdrop");
  var micBtn = field.querySelector(".dictation-mic");
  var confirmBtn = field.querySelector(".dictation-confirm");
  if (!input || !backdrop || !micBtn || !confirmBtn) return;
  var catalogEl = document.getElementById("tag-voice-catalog");
  var TAG_CATALOG = [];
  try { TAG_CATALOG = JSON.parse((catalogEl && catalogEl.textContent) || "[]") || []; }
  catch (e) { TAG_CATALOG = []; }
  var tagSections = [];
  document.querySelectorAll(".section[data-section-id]").forEach(function (section) {
    var heading = section.querySelector("h3");
    tagSections.push({ id: section.dataset.sectionId, name: heading ? heading.textContent.trim() : "Tags" });
  });

  // No Web Speech support: reveal the button but disable it with a hint.
  if (!SR) {
    micBtn.hidden = false;
    micBtn.disabled = true;
    micBtn.title = "Voice dictation isn't supported in this browser (try Chrome).";
    return;
  }
  micBtn.hidden = false;

  /* ---- session state -------------------------------------------------- */
  var recog = null;
  var recording = false;   // recognition object is currently active
  var wantRecording = false; // user intends to keep dictating (survives auto-end)
  var pending = false;   // a highlighted, unconfirmed dictation run exists
  var before = "";       // fixed text before the ACTIVE run
  var after = "";        // fixed text after the ACTIVE run
  var finalText = "";    // committed final transcript for the active run
  var interimText = "";  // live (unstable) interim transcript
  var activeLen = 0;     // rendered length of the active run in the textarea
  var committed = [];    // [start,end] ranges dictated earlier this session,
                         // still highlighted until confirm (absolute offsets)
  var activeTagCommands = [];
  var committedTagCommands = [];
  var sessionOriginalValue = "";
  var lastTextareaValue = input.value;
  var recognitionRestartTimer = null;

  var reviewEl = document.createElement("div");
  reviewEl.className = "voice-tag-review";
  reviewEl.hidden = true;
  field.insertAdjacentElement("afterend", reviewEl);

  function allTagCommands() { return committedTagCommands.concat(activeTagCommands); }

  function clearPendingTagMarks() {
    document.querySelectorAll(".tag-toggle.voice-pending").forEach(function (el) {
      el.classList.remove("voice-pending");
    });
  }

  function findTagInput(sectionId, name) {
    var section = document.querySelector('.section[data-section-id="' + sectionId + '"]');
    if (!section) return null;
    var found = null;
    section.querySelectorAll('input[type="checkbox"][name^="tag:"]').forEach(function (el) {
      if (normalizeVoiceName(el.value) === normalizeVoiceName(name)) found = el;
    });
    return found;
  }

  function renderTagReview() {
    var commands = allTagCommands();
    clearPendingTagMarks();
    reviewEl.innerHTML = "";
    reviewEl.hidden = !commands.length;
    if (!commands.length) { confirmBtn.disabled = false; return; }

    var title = document.createElement("div");
    title.className = "voice-tag-review-title";
    title.textContent = "Voice tags · review before confirming";
    reviewEl.appendChild(title);
    var unresolved = false;
    commands.forEach(function (command) {
      var row = document.createElement("div");
      row.className = "voice-tag-review-row";
      var chip = document.createElement("span");
      chip.className = "voice-tag-chip" + (command.status === "new" ? " temp" : "");
      chip.textContent = command.name || "unnamed tag";
      row.appendChild(chip);
      if (!command.keepAsText && command.section_id) {
        var existing = findTagInput(command.section_id, command.name);
        if (existing) existing.closest(".tag-toggle").classList.add("voice-pending");
      }
      if (!command.keepAsText && (!command.section_id || command.status === "ambiguous")) {
        unresolved = true;
        var select = document.createElement("select");
        select.setAttribute("aria-label", "Section for " + command.name);
        var blank = document.createElement("option");
        blank.value = ""; blank.textContent = "choose section";
        select.appendChild(blank);
        tagSections.forEach(function (section) {
          var option = document.createElement("option");
          option.value = section.id; option.textContent = section.name;
          select.appendChild(option);
        });
        select.addEventListener("change", function () {
          command.section_id = select.value || null;
          if (command.section_id) command.status = command.section_ids.length ? "matched" : "new";
          renderTagReview();
        });
        row.appendChild(select);
        if (window.enhanceSelect) window.enhanceSelect(select);
      }
      var restore = document.createElement("button");
      restore.type = "button";
      restore.className = "voice-tag-restore";
      restore.textContent = command.keepAsText ? "use as tag" : "keep words";
      restore.addEventListener("click", function () {
        command.keepAsText = !command.keepAsText;
        renderTagReview();
      });
      row.appendChild(restore);
      reviewEl.appendChild(row);
    });
    var cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "voice-review-cancel";
    cancel.textContent = "Cancel dictation";
    cancel.addEventListener("click", cancelDictation);
    reviewEl.appendChild(cancel);
    confirmBtn.disabled = unresolved;
    confirmBtn.title = unresolved ? "Choose a section for each voice tag" : "Confirm dictation";
  }

  /* ---- visible status line (errors / hints) --------------------------- */
  var statusEl = document.createElement("div");
  statusEl.className = "dictation-status";
  statusEl.setAttribute("role", "status");
  statusEl.setAttribute("aria-live", "polite");
  statusEl.hidden = true;
  field.appendChild(statusEl);
  function showStatus(msg) { statusEl.textContent = msg; statusEl.hidden = false; }
  function clearStatus() { statusEl.hidden = true; statusEl.textContent = ""; }

  function errorMessage(code) {
    switch (code) {
      case "not-allowed":
      case "service-not-allowed":
        return "Microphone blocked. Click the site controls (🔒/mic icon) in the address bar and allow the microphone, then reload.";
      case "audio-capture":
        return "No microphone found — check your input device.";
      case "network":
        return "Speech service unreachable. Web Speech needs internet and only works in Google Chrome (not Chromium).";
      case "no-speech":
        return "No speech detected — try again, closer to the mic.";
      case "language-not-supported":
        return "Language not supported for dictation.";
      default:
        return "Dictation error: " + code;
    }
  }

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function dictated() {
    // Space-join the committed run and the live interim so a finalized phrase
    // doesn't butt up against the next interim ("great" + "thinking").
    if (finalText && interimText && !/\s$/.test(finalText) && !/^\s/.test(interimText)) {
      return finalText + " " + interimText;
    }
    return finalText + interimText;
  }

  /* Draw ALL highlighted runs behind the textarea: the previously-dictated
     (committed) ranges plus the currently-active run. Ranges are merged/sorted
     so overlaps render cleanly. */
  function renderBackdrop() {
    var v = input.value;
    var ranges = committed.slice();
    if (activeLen > 0) ranges.push([before.length, before.length + activeLen]);
    ranges = ranges
      .filter(function (r) { return r[1] > r[0]; })
      .sort(function (a, b) { return a[0] - b[0]; });
    var merged = [];
    ranges.forEach(function (r) {
      var last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
      else merged.push([r[0], r[1]]);
    });
    var html = "", pos = 0;
    merged.forEach(function (r) {
      html += escapeHtml(v.slice(pos, r[0]));
      html += '<mark class="dictation-hl">' + escapeHtml(v.slice(r[0], r[1])) + "</mark>";
      pos = r[1];
    });
    html += escapeHtml(v.slice(pos));
    if (v.slice(-1) === "\n") html += " ";  // textarea trailing-newline height fix
    backdrop.innerHTML = html;
    backdrop.scrollTop = input.scrollTop;
  }

  /* Push the current transcript into the textarea, keep the caret at the end of
     the active run, and shift committed ranges that sit after the run. */
  function paint() {
    var parsed = parseVoiceTagCommands(applyVoiceCommands(dictated()), TAG_CATALOG);
    var text = parsed.text;
    activeTagCommands = parsed.commands;
    var joined = smartDictationJoin(before, text, after);
    var lead = joined.lead, trail = joined.trail;
    var newLen = lead.length + text.length + trail.length;
    var oldEnd = before.length + activeLen;   // end of the active run before this paint
    var delta = newLen - activeLen;
    if (delta !== 0) {                          // committed ranges after the run shift with it
      committed = committed.map(function (r) {
        return r[0] >= oldEnd ? [r[0] + delta, r[1] + delta] : r;
      });
    }
    input.value = joined.value;
    lastTextareaValue = input.value;
    activeLen = newLen;
    var caret = before.length + lead.length + text.length;  // after the run, before any trailing space
    try { input.setSelectionRange(caret, caret); } catch (e) { /* detached */ }
    renderBackdrop();
    renderTagReview();
  }

  /* Append a finalized chunk with sensible spacing. */
  function appendFinal(chunk) {
    chunk = chunk.replace(/^\s+/, "");
    if (!chunk) return;
    var needSpace = finalText && !/\s$/.test(finalText) && !/^[.,!?;:]/.test(chunk);
    finalText += (needSpace ? " " : "") + chunk;
  }

  function startSession() {
    if (recognitionRestartTimer) {
      clearTimeout(recognitionRestartTimer);
      recognitionRestartTimer = null;
    }
    if (window.journalBodyEdit) window.journalBodyEdit();  // ensure raw textarea shown
    if (!pending) sessionOriginalValue = input.value;
    input.dataset.dictating = "1";
    field.classList.add("dictating");

    // Anchor at the current caret/selection so dictation always inserts where
    // the cursor is. The only time we DON'T re-anchor is a true "continue" —
    // the caret is still exactly at the end of the current highlighted run
    // (collapsed), so restarting just keeps appending to it.
    var s = input.selectionStart, e = input.selectionEnd;
    var regionEnd = before.length + activeLen;
    var resume = pending && s === e && s === regionEnd;
    if (!resume) {
      // (Re)anchor here — commits any active run so it stays highlighted, then
      // starts a fresh run at the caret. Any selection is overwritten (word-replace).
      reanchorToCaret();
    }
    pending = true;
    confirmBtn.hidden = false;
    startRecognition();
  }

  function startRecognition() {
    recog = new SR();
    recog.continuous = true;
    recog.interimResults = true;
    recog.lang = document.documentElement.lang ?
      (document.documentElement.lang.indexOf("-") === -1 ? "en-US" : document.documentElement.lang) : "en-US";

    recog.onstart = function () { console.log("[dictation] onstart"); clearStatus(); };
    recog.onaudiostart = function () { console.log("[dictation] audiostart"); };
    recog.onspeechstart = function () { console.log("[dictation] speechstart"); };
    recog.onresult = function (e) {
      var interim = "";
      for (var i = e.resultIndex; i < e.results.length; i++) {
        var r = e.results[i];
        if (r.isFinal) appendFinal(r[0].transcript);
        else interim += r[0].transcript;
      }
      console.log("[dictation] result final=" + JSON.stringify(finalText) + " interim=" + JSON.stringify(interim));
      interimText = interim;
      paint();
    };
    recog.onerror = function (e) {
      console.warn("[dictation] error:", e.error, e.message || "");
      // Fatal errors: don't auto-restart (would busy-loop).
      if (e.error === "not-allowed" || e.error === "service-not-allowed" ||
          e.error === "audio-capture" || e.error === "language-not-supported") {
        wantRecording = false;
      }
      if (e.error !== "aborted") showStatus(errorMessage(e.error));
    };
    recog.onend = function () {
      console.log("[dictation] onend (wantRecording=" + wantRecording + ")");
      // Chrome ends recognition after a silence; if the user is still recording,
      // transparently restart so dictation keeps going.
      if (wantRecording) {
        try { recog.start(); return; }
        catch (err) { console.warn("[dictation] auto-restart failed:", err); }
      }
      if (interimText) { appendFinal(interimText); interimText = ""; }
      setRecording(false);
      paint();
    };

    wantRecording = true;
    setRecording(true);
    try {
      recog.start();
      console.log("[dictation] start() called");
    } catch (e) {
      console.warn("[dictation] start() threw:", e);
      showStatus("Couldn't start dictation: " + (e && e.message ? e.message : e));
      wantRecording = false;
      setRecording(false);
    }
  }

  function stopRecognition() {
    wantRecording = false;  // user-initiated stop — prevent the onend auto-restart
    if (recog && recording) { try { recog.stop(); } catch (e) { /* ignore */ } }
  }

  function restartRecognitionAtCursor() {
    if (!recording && !recognitionRestartTimer) return;
    if (recording) {
      var old = recog;
      wantRecording = false;
      if (old) {
        old.onresult = old.onend = old.onerror = null;
        try { old.abort(); } catch (e) { /* ignore */ }
      }
      setRecording(false);
    }
    clearTimeout(recognitionRestartTimer);
    recognitionRestartTimer = setTimeout(function () {
      recognitionRestartTimer = null;
      if (pending) startRecognition();
    }, 140);
  }

  function setRecording(on) {
    recording = on;
    micBtn.classList.toggle("recording", on);
    micBtn.setAttribute("aria-pressed", on ? "true" : "false");
  }

  function confirmDictation() {
    // Detach recognition callbacks FIRST: recog.stop() fires onend
    // asynchronously in real Chrome, and a late onend would paint() over the
    // just-reset state and wipe the textarea.
    if (recog) { recog.onresult = recog.onend = recog.onerror = null; }
    if (recognitionRestartTimer) clearTimeout(recognitionRestartTimer);
    recognitionRestartTimer = null;
    stopRecognition();
    setRecording(false);
    allTagCommands().forEach(function (command) {
      if (command.keepAsText) {
        var words = command.original.trim();
        input.value += (input.value && !/\s$/.test(input.value) ? " " : "") + words;
        return;
      }
      if (!command.section_id || !command.name) return;
      var tagInput = findTagInput(command.section_id, command.name);
      if (!tagInput) {
        var section = document.querySelector('.section[data-section-id="' + command.section_id + '"]');
        var chips = section && section.querySelector(".chips");
        if (!chips) return;
        var label = document.createElement("label");
        label.className = "chip temp tag-toggle";
        tagInput = document.createElement("input");
        tagInput.type = "checkbox";
        tagInput.name = "tag:" + command.section_id;
        tagInput.value = command.name;
        label.appendChild(tagInput);
        label.appendChild(document.createTextNode(" " + command.name));
        chips.appendChild(label);
      }
      tagInput.checked = true;
      tagInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    // Text is already in input.value — drop the highlight + session state.
    pending = false;
    finalText = interimText = "";
    before = after = "";
    activeLen = 0;
    committed = [];
    activeTagCommands = [];
    committedTagCommands = [];
    field.classList.remove("dictating");
    delete input.dataset.dictating;
    backdrop.innerHTML = "";
    confirmBtn.hidden = true;
    confirmBtn.disabled = false;
    reviewEl.hidden = true;
    clearPendingTagMarks();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  }

  function cancelDictation() {
    if (recog) { recog.onresult = recog.onend = recog.onerror = null; }
    if (recognitionRestartTimer) clearTimeout(recognitionRestartTimer);
    recognitionRestartTimer = null;
    stopRecognition();
    setRecording(false);
    input.value = sessionOriginalValue;
    lastTextareaValue = input.value;
    pending = false;
    finalText = interimText = before = after = "";
    activeLen = 0;
    committed = [];
    activeTagCommands = [];
    committedTagCommands = [];
    field.classList.remove("dictating");
    delete input.dataset.dictating;
    backdrop.innerHTML = "";
    confirmBtn.hidden = true;
    confirmBtn.disabled = false;
    reviewEl.hidden = true;
    clearPendingTagMarks();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
  }

  /* Clicking a control must NOT blur the textarea (that would swap to the
     rendered view and drop the selection). preventDefault on mousedown keeps
     focus + any selection intact. */
  function keepFocus(btn) {
    btn.addEventListener("mousedown", function (e) { e.preventDefault(); });
  }
  keepFocus(micBtn);
  keepFocus(confirmBtn);

  micBtn.addEventListener("click", function () {
    console.log("[dictation] mic click (recording=" + recording + ")");
    if (recording) stopRecognition();
    else startSession();
  });
  confirmBtn.addEventListener("click", confirmDictation);

  // Re-anchor the dictation to the caret when the user moves it during a session
  // (click or arrow keys) so following words land where the cursor now is. The
  // active run is COMMITTED first (kept highlighted, not cleared) and a fresh run
  // starts at the caret. Only fires on real user input (our own paint() uses
  // setSelectionRange, which emits no events).
  function reanchorToCaret() {
    if (activeLen > 0) committed.push([before.length, before.length + activeLen]);
    if (activeTagCommands.length) committedTagCommands = committedTagCommands.concat(activeTagCommands);
    activeTagCommands = [];
    var s = input.selectionStart, e = input.selectionEnd;
    // Split any committed range straddling the caret, so inserting there doesn't
    // wrongly stretch the highlight across the newly inserted text.
    var split = [];
    committed.forEach(function (r) {
      if (r[0] < s && s < r[1]) { split.push([r[0], s]); split.push([s, r[1]]); }
      else split.push(r);
    });
    committed = split;
    before = input.value.slice(0, s);
    after = input.value.slice(e);
    finalText = "";
    interimText = "";
    activeLen = 0;
    lastTextareaValue = input.value;
    renderBackdrop();
    renderTagReview();
  }
  function maybeReanchor() {
    if (!pending) return;
    var s = input.selectionStart, e = input.selectionEnd;
    var runEnd = before.length + activeLen;
    // Only skip when the caret is exactly at the end of the active run (a true
    // "continue in place"); any other move re-anchors to the new position.
    if (s === e && s === runEnd) return;
    reanchorToCaret();
    restartRecognitionAtCursor();
  }
  input.addEventListener("mouseup", maybeReanchor);
  input.addEventListener("keyup", function (ev) {
    if (/^(Arrow|Home|End|Page)/.test(ev.key)) maybeReanchor();
  });

  // Keep the highlight aligned on scroll and on manual edits mid-session.
  input.addEventListener("scroll", function () {
    if (pending) backdrop.scrollTop = input.scrollTop;
  });
  input.addEventListener("input", function () {
    if (!pending) { lastTextareaValue = input.value; return; }
    // `input.value = ...` in paint() does not emit an input event, so reaching
    // here means the user typed, pasted, or deleted. Rebase every cached slice
    // from the textarea's current truth before another speech result can paint.
    var ranges = committed.slice();
    if (activeLen > 0) ranges.push([before.length, before.length + activeLen]);
    committed = adjustHighlightedRanges(lastTextareaValue, input.value, ranges);
    if (activeTagCommands.length) committedTagCommands = committedTagCommands.concat(activeTagCommands);
    activeTagCommands = [];
    var s = input.selectionStart, e = input.selectionEnd;
    before = input.value.slice(0, s);
    after = input.value.slice(e);
    finalText = "";
    interimText = "";
    activeLen = 0;
    lastTextareaValue = input.value;
    renderBackdrop();
    renderTagReview();
    restartRecognitionAtCursor();
  });

  // Expose a tiny hook for tests / manual verification.
  window.journalDictation = {
    isRecording: function () { return recording; },
    isPending: function () { return pending; },
    transform: applyVoiceCommands,
    parseTags: parseVoiceTagCommands,
    smartJoin: smartDictationJoin,
    adjustRanges: adjustHighlightedRanges,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    applyVoiceCommands: applyVoiceCommands,
    parseVoiceTagCommands: parseVoiceTagCommands,
    suggestEntryTitle: suggestEntryTitle,
    smartDictationJoin: smartDictationJoin,
    adjustHighlightedRanges: adjustHighlightedRanges,
  };
}
