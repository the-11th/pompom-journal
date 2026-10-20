/* tag-popup.js — the quick, unified tag popover (loaded app-wide via base.html).
 *
 * Any element carrying `data-tagpop="<name>"` (class `.tag-pop-trigger`) opens a
 * floating, anchored popover summarizing that tag across BOTH domains (tasks +
 * journal), fetched from GET /tag/<name>/overview. The popover always shows the
 * unified cross-domain glance — it ignores any analytics lens.
 *
 * Collision note: the journal search filter checkboxes use a DIFFERENT
 * attribute (`data-tag`) for filtering; this listener only ever reads
 * `data-tagpop`, so the two never interfere.
 *
 * Vanilla JS only, no third-party libraries; the mini sparkline is a tiny
 * self-contained inline SVG (no dependency on analytics.js).
 */
(function () {
  "use strict";

  var SVGNS = "http://www.w3.org/2000/svg";
  var _pop = null;          // the currently-open popover element
  var _anchor = null;       // the trigger it is anchored to
  var _requestId = 0;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function svgEl(tag, attrs) {
    var e = document.createElementNS(SVGNS, tag);
    for (var k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    return e;
  }

  // ----- origin marks -------------------------------------------------------
  function taskMark() {
    var s = el("span", "origin-task");
    s.textContent = "☑";    // ☑
    return s;
  }
  function journalDot(color) {
    var s = el("span", "origin-dot");
    if (color) s.style.setProperty("--dot", color);
    return s;
  }

  // Build a {section_id: color} index from the journal payload sections.
  function sectionColors(journal) {
    var map = {};
    (journal.sections || []).forEach(function (s) { map[s.id] = s.color; });
    return map;
  }
  function sectionNames(journal) {
    var map = {};
    (journal.sections || []).forEach(function (s) { map[s.id] = s.name; });
    return map;
  }

  // ----- date formatting (YYYY-MM-DD -> "Jun 25") ---------------------------
  var MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
             "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function shortDate(d) {
    if (!d) return "";
    var p = d.split("-");
    if (p.length < 3) return d;
    return MON[parseInt(p[1], 10) - 1] + " " + p[2];
  }

  function fmt(n) {
    if (n == null) return null;
    return Math.round(n * 100) / 100 + "";
  }

  // Lead-time phrase from the task side (positive = early).
  function leadPhrase(days) {
    if (days == null) return null;
    var d = Math.round(days * 10) / 10;
    if (Math.abs(d) < 0.05) return "~on time";
    return "~" + Math.abs(d) + "d " + (d > 0 ? "early" : "late");
  }

  // ----- tiny mood sparkline (self-contained) -------------------------------
  function sparkline(series) {
    if (!series || series.length < 2) return null;
    var w = 140, h = 32;
    var svg = svgEl("svg", {
      class: "pop-spark", width: w, height: h, viewBox: "0 0 " + w + " " + h,
    });
    var min = 1, max = 7, span = max - min;
    var pts = series.map(function (s, i) {
      return (w * i) / (series.length - 1) + "," +
             (3 + (h - 6) * (1 - (s.mood - min) / span));
    });
    svg.appendChild(svgEl("polyline", {
      fill: "none", stroke: "var(--accent)", "stroke-width": 1.5,
      points: pts.join(" "),
    }));
    var lastX = (w * (series.length - 1)) / (series.length - 1);
    var lastY = 3 + (h - 6) * (1 - (series[series.length - 1].mood - min) / span);
    svg.appendChild(svgEl("circle", {
      cx: lastX, cy: lastY, r: 2.2, fill: "var(--accent)",
    }));
    return svg;
  }

  // ----- popover construction ----------------------------------------------
  function buildPopover(payload) {
    var task = payload.task || {};
    var journal = payload.journal || {};
    var colors = sectionColors(journal);
    var names = sectionNames(journal);

    var pop = el("div", "tag-pop");
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", payload.name + " tag overview");

    // close button
    var close = el("button", "tag-pop-close", "×");
    close.type = "button";
    close.title = "close";
    close.setAttribute("aria-label", "Close tag overview");
    close.addEventListener("click", function () { closePopover(true); });
    pop.appendChild(close);

    // header: name + origin marks
    var head = el("div", "tag-pop-head");
    head.appendChild(el("span", "tag-pop-name", payload.name));
    var origins = el("span", "tag-pop-origins");
    var taskUses = (task.active || 0) + (task.completed || 0) + (task.expired || 0);
    if (taskUses > 0) {
      var om = el("span", "tag-pop-origin");
      om.appendChild(taskMark());
      om.appendChild(document.createTextNode(" task"));
      origins.appendChild(om);
    }
    if ((journal.sections || []).length) {
      var oj = el("span", "tag-pop-origin");
      oj.appendChild(journalDot(journal.sections[0].color));
      oj.appendChild(document.createTextNode(" journal"));
      origins.appendChild(oj);
    }
    head.appendChild(origins);
    pop.appendChild(head);

    // stat strip
    var stats = el("div", "tag-pop-stats");
    function stat(label, value) {
      if (value == null || value === "") return;
      var s = el("span", "tag-pop-stat");
      s.appendChild(el("span", "tag-pop-stat-label", label));
      var v = el("span", "tag-pop-stat-value");
      if (typeof value === "string" || typeof value === "number") {
        v.textContent = value;
      } else {
        v.appendChild(value);
      }
      s.appendChild(v);
      stats.appendChild(s);
    }
    stat("uses", taskUses + (journal.entries || 0));
    if (taskUses) stat("tasks", task.active + " active / " + task.completed + " done");
    if (journal.entries) stat("entries", journal.entries);
    if (journal.avg_mood != null) {
      var moodVal = el("span");
      moodVal.appendChild(document.createTextNode(fmt(journal.avg_mood)));
      if (journal.uplift != null && Math.abs(journal.uplift) >= 0.05) {
        var up = el("span", "tag-pop-uplift");
        var arrow = journal.uplift > 0 ? "▲" : "▼";
        up.textContent = " " + arrow + " " +
          (journal.uplift > 0 ? "+" : "") + fmt(journal.uplift);
        if (journal.uplift < 0) up.classList.add("down");
        moodVal.appendChild(up);
      }
      stat("avg mood", moodVal);
    }
    var lead = leadPhrase(task.lead_time_days);
    if (lead) stat("lead", lead);
    pop.appendChild(stats);

    // sparkline
    var spark = sparkline(journal.mood_series);
    if (spark) pop.appendChild(spark);

    // top 3 co-occurring (merged, origin-marked)
    var co = mergedCooccurring(task, journal, colors).slice(0, 3);
    if (co.length) {
      pop.appendChild(el("div", "tag-pop-section-label", "Top co-occurring"));
      var chips = el("div", "tag-pop-chips");
      co.forEach(function (c) {
        var chip = el("span", "tag-pop-cochip");
        if (c.origin === "task") chip.appendChild(taskMark());
        else chip.appendChild(journalDot(c.color));
        chip.appendChild(document.createTextNode(c.name + " "));
        chip.appendChild(el("span", "tag-pop-cochip-count", String(c.count)));
        chips.appendChild(chip);
      });
      pop.appendChild(chips);
    }

    // ~5 most-recent merged timeline rows
    var rows = mergedTimeline(task, journal, colors, names).slice(0, 5);
    if (rows.length) {
      pop.appendChild(el("div", "tag-pop-section-label", "Recent"));
      var ul = el("ul", "tag-pop-timeline");
      rows.forEach(function (r) {
        var li = el("li", "tag-pop-tl-row");
        var mark = el("span", "tag-pop-tl-mark");
        if (r.origin === "task") mark.appendChild(taskMark());
        else mark.appendChild(journalDot(r.color));
        li.appendChild(mark);
        li.appendChild(el("span", "tag-pop-tl-date", shortDate(r.date)));
        var text = el("span", "tag-pop-tl-text");
        text.appendChild(document.createTextNode(r.title));
        if (r.snippet) {
          var sn = el("span", "tag-pop-tl-snippet", " " + r.snippet);
          text.appendChild(sn);
        }
        li.appendChild(text);
        ul.appendChild(li);
      });
      pop.appendChild(ul);
    }

    if (!taskUses && !journal.entries) {
      pop.appendChild(el("p", "tag-pop-empty", "No data for this tag yet."));
    }

    // footer: Expand ->
    var foot = el("div", "tag-pop-foot");
    foot.appendChild(el("span", "tag-pop-note", "Analytics · Tag tab"));
    var expand = el("button", "tag-pop-expand", "Expand →");
    expand.type = "button";
    expand.addEventListener("click", function () {
      window.location.href = "/journal/analytics#tag=" +
        encodeURIComponent(payload.name);
    });
    foot.appendChild(expand);
    pop.appendChild(foot);

    return pop;
  }

  // Merge co-occurring tags from both sides into one origin-marked list,
  // sorted by count desc then name. Task tags marked task; journal tags carry
  // their section color.
  function mergedCooccurring(task, journal, colors) {
    var out = [];
    (task.cooccurring || []).forEach(function (c) {
      out.push({ name: c.name, count: c.count, origin: "task" });
    });
    (journal.cooccurring || []).forEach(function (c) {
      out.push({ name: c.name, count: c.count, origin: "journal",
                 color: colors[c.section_id] });
    });
    out.sort(function (a, b) {
      return b.count - a.count || (a.name < b.name ? -1 : 1);
    });
    return out;
  }

  // Merge timeline rows from both sides, newest first.
  function mergedTimeline(task, journal, colors) {
    var out = [];
    (task.timeline || []).forEach(function (r) {
      out.push({ date: r.date, title: r.title, origin: "task",
                 snippet: r.status === "active" ? "" : "· " + r.status });
    });
    (journal.timeline || []).forEach(function (r) {
      var color = (r.sections && r.sections.length)
        ? colors[r.sections[0]] : null;
      out.push({ date: r.date, title: r.snippet || "(entry)", origin: "journal",
                 color: color, snippet: "" });
    });
    out.sort(function (a, b) { return (a.date < b.date) ? 1 : (a.date > b.date ? -1 : 0); });
    return out;
  }

  // ----- positioning (flips near viewport edges) ---------------------------
  function position(pop, anchor) {
    var rect = anchor.getBoundingClientRect();
    pop.style.visibility = "hidden";
    pop.style.left = "0px";
    pop.style.top = "0px";
    document.body.appendChild(pop);
    var pw = pop.offsetWidth, ph = pop.offsetHeight;
    var margin = 8;
    var left = rect.left + window.scrollX;
    var top = rect.bottom + window.scrollY + 6;
    // Flip horizontally if it would overflow the right edge.
    if (left + pw > window.scrollX + window.innerWidth - margin) {
      left = rect.right + window.scrollX - pw;
    }
    if (left < window.scrollX + margin) left = window.scrollX + margin;
    // Flip above the anchor if it would overflow the bottom edge.
    if (rect.bottom + ph + 6 > window.innerHeight - margin) {
      top = rect.top + window.scrollY - ph - 6;
    }
    if (top < window.scrollY + margin) top = window.scrollY + margin;
    pop.style.left = left + "px";
    pop.style.top = top + "px";
    pop.style.visibility = "";
  }

  // ----- open / close -------------------------------------------------------
  function closePopover(restoreFocus) {
    var anchor = _anchor;
    _requestId++;
    if (_pop) { _pop.remove(); _pop = null; }
    _anchor = null;
    if (anchor) {
      anchor.setAttribute("aria-expanded", "false");
      if (restoreFocus && anchor.isConnected) anchor.focus();
    }
    document.removeEventListener("keydown", onEsc);
    document.removeEventListener("click", onOutside, true);
  }

  function onEsc(e) {
    if (e.key === "Escape") {
      e.preventDefault(); e.stopImmediatePropagation(); closePopover(true);
    }
  }

  function onOutside(e) {
    if (_pop && !_pop.contains(e.target) &&
        (!_anchor || !_anchor.contains(e.target))) {
      closePopover();
    }
  }

  function openFor(anchor, name) {
    closePopover();
    _anchor = anchor;
    var requestId = ++_requestId;
    anchor.setAttribute("aria-expanded", "true");
    // Loading placeholder while we fetch.
    var loading = el("div", "tag-pop");
    loading.setAttribute("role", "status");
    loading.appendChild(el("p", "tag-pop-empty", "Loading…"));
    _pop = loading;
    position(loading, anchor);
    document.addEventListener("keydown", onEsc);
    document.addEventListener("click", onOutside, true);

    fetch("/tag/" + encodeURIComponent(name) + "/overview",
          { headers: { "Accept": "application/json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("Tag overview unavailable");
        return r.json();
      })
      .then(function (payload) {
        if (requestId !== _requestId) return;
        var built = buildPopover(payload);
        if (_pop) _pop.remove();
        _pop = built;
        position(built, anchor);
        built.querySelector(".tag-pop-close").focus();
      })
      .catch(function (err) {
        if (requestId !== _requestId) return;
        if (window.console) console.error("tag overview fetch failed", err);
        loading.querySelector("p").textContent = "Could not load this tag.";
        var retry = el("button", "tag-pop-expand", "Retry");
        retry.type = "button";
        retry.addEventListener("click", function () { openFor(anchor, name); });
        loading.appendChild(retry);
        retry.focus();
      });
  }

  // ----- delegated trigger --------------------------------------------------
  document.addEventListener("click", function (e) {
    var trigger = e.target.closest("[data-tagpop]");
    if (!trigger) return;
    e.preventDefault();
    var name = trigger.getAttribute("data-tagpop");
    if (!name) return;
    // Toggle if clicking the same anchor again.
    if (_anchor === trigger && _pop) { closePopover(); return; }
    openFor(trigger, name);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    var trigger = e.target.closest("[data-tagpop]");
    if (!trigger) return;
    e.preventDefault();
    trigger.click();
  });

  // Reposition an open popover on resize/scroll so it stays anchored.
  window.addEventListener("resize", function () {
    if (_pop && _anchor) position(_pop, _anchor);
  });
})();
