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
(function () {
  "use strict";

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var field = document.querySelector(".body-field");
  if (!field) return;
  var input = field.querySelector(".body-input");
  var backdrop = field.querySelector(".dictation-backdrop");
  var micBtn = field.querySelector(".dictation-mic");
  var confirmBtn = field.querySelector(".dictation-confirm");
  if (!input || !backdrop || !micBtn || !confirmBtn) return;

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

  /* Turn spoken command words into symbols/punctuation, live. Pure function.
       "at symbol alex"      -> "@alex"     (symbol glued to the next word)
       "hashtag weight"      -> "#weight"
       "checkbox call mom"   -> "[] call mom"  (task marker; space kept for the grammar)
       "open close bracket"  -> "[]"
       "done new line next"  -> "done\nnext"
       "hello period"        -> "hello."   (punctuation glued to the previous word)
       "wait dot dot dot"    -> "wait..."
     Case-insensitive; ordered longest-phrase-first so multi-word commands win. */
  function applyVoiceCommands(text) {
    var t = text;
    // Prefix symbols — glue to the FOLLOWING word (drop the trailing space).
    t = t.replace(/\bat symbol\s*/gi, "@");
    t = t.replace(/\bhashtag\s*/gi, "#");
    // Task marker — standalone token; keep the space before the title.
    t = t.replace(/\b(?:open close bracket|checkbox)\b/gi, "[]");
    // Line break — consume the spaces around it.
    t = t.replace(/\s*\bnew line\b\s*/gi, "\n");
    // Suffix punctuation — glue to the PREVIOUS word (drop the leading space).
    t = t.replace(/\s*\bdot dot dot\b/gi, "...");
    t = t.replace(/\s*\bexclamation mark\b/gi, "!");
    t = t.replace(/\s*\bquestion mark\b/gi, "?");
    t = t.replace(/\s*\bperiod\b/gi, ".");
    t = t.replace(/\s*\bcomma\b/gi, ",");
    // Parentheses — spoken "parenthesis" alternates left/right: 1st -> "(" (glued
    // to the next word), 2nd -> ")" (glued to the previous word), 3rd -> "(", ...
    var openParen = true;
    t = t.replace(/(\s*)\b(?:parenthesis|parentheses)\b(\s*)/gi, function (m, pre, post) {
      if (openParen) { openParen = false; return pre + "("; }  // keep leading space, glue next
      openParen = true;
      return ")" + post;                                        // glue previous, keep trailing space
    });
    // Tidy accidental double spaces without touching newlines.
    t = t.replace(/ {2,}/g, " ");
    return t;
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
    var text = applyVoiceCommands(dictated());
    // Smart spacing for mid-text insertions: add a space between the fixed text
    // and the dictated run so words don't run together — but not when a space
    // already exists, before an opening bracket, or before closing punctuation.
    var lead = "", trail = "";
    if (text) {
      if (before && !/[\s([]$/.test(before) && !/^\s/.test(text)) lead = " ";
      if (after && !/\s$/.test(text) && !/^[\s.,!?;:)\]]/.test(after)) trail = " ";
    }
    var newLen = lead.length + text.length + trail.length;
    var oldEnd = before.length + activeLen;   // end of the active run before this paint
    var delta = newLen - activeLen;
    if (delta !== 0) {                          // committed ranges after the run shift with it
      committed = committed.map(function (r) {
        return r[0] >= oldEnd ? [r[0] + delta, r[1] + delta] : r;
      });
    }
    input.value = before + lead + text + trail + after;
    activeLen = newLen;
    var caret = before.length + lead.length + text.length;  // after the run, before any trailing space
    try { input.setSelectionRange(caret, caret); } catch (e) { /* detached */ }
    renderBackdrop();
  }

  /* Append a finalized chunk with sensible spacing. */
  function appendFinal(chunk) {
    chunk = chunk.replace(/^\s+/, "");
    if (!chunk) return;
    var needSpace = finalText && !/\s$/.test(finalText) && !/^[.,!?;:]/.test(chunk);
    finalText += (needSpace ? " " : "") + chunk;
  }

  function startSession() {
    if (window.journalBodyEdit) window.journalBodyEdit();  // ensure raw textarea shown
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
    stopRecognition();
    setRecording(false);
    // Text is already in input.value — just drop the highlight + session state.
    pending = false;
    finalText = interimText = "";
    before = after = "";
    activeLen = 0;
    committed = [];
    field.classList.remove("dictating");
    delete input.dataset.dictating;
    backdrop.innerHTML = "";
    confirmBtn.hidden = true;
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
    renderBackdrop();
  }
  function maybeReanchor() {
    if (!pending) return;
    var s = input.selectionStart, e = input.selectionEnd;
    var runEnd = before.length + activeLen;
    // Only skip when the caret is exactly at the end of the active run (a true
    // "continue in place"); any other move re-anchors to the new position.
    if (s === e && s === runEnd) return;
    reanchorToCaret();
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
    if (pending && !recording) renderBackdrop();
  });

  // Expose a tiny hook for tests / manual verification.
  window.journalDictation = {
    isRecording: function () { return recording; },
    isPending: function () { return pending; },
    transform: applyVoiceCommands,
  };
})();
