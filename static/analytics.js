/* Analytics dashboard. Fetches /journal/analytics/data, filters by date in
 * memory, and renders charts via the CHARTS registry. To add a chart, push a
 * descriptor onto CHARTS (see analytics.js chart sections). No chart hardcodes
 * a section/tag name or a theme color — colors come from CSS variables and the
 * fetched section list, so new sections/tags appear automatically. */
(function () {
  "use strict";

  var root = document.getElementById("analytics-root");
  if (!root) return;

  // ----- state -----
  var ENDPOINT = root.dataset.endpoint;
  var _data = { sections: [], entries: [], date_range: { min: null, max: null } };
  var _from = null, _to = null;
  var _activeTab = "overview";
  var _category = "overview";   // active primary category (see CATEGORIES)
  var _lastFetch = 0;
  var _tagQuery = "";       // current tag in the Tag detail tab
  var _tagCache = {};       // {name: payload} cache for /tag/<name>/overview
  // Collapsed chart boxes by chart id. In-memory for this page visit only, so
  // collapse survives tab/category switches + re-renders but resets on reload.
  var _collapsed = {};
  // Section scope filter for the Numeric & Tags tabs. null = all shown; else an
  // array of selected section ids of that type. Keyed by section type.
  var _secSel = { numeric: null, tag: null };
  // Leading-indicators tab state: selectable lag (0..3) and the currently
  // selected indicator (a leadingIndicators row) for the detail panel.
  var _lead = { lag: 1, selected: null };

  // Panel (sub-tab) definitions. `needs` optionally gates a tab's visibility;
  // a tab with no `needs` is always visible. Panels are grouped into primary
  // categories by CATEGORIES below.
  var PANELS = [
    { id: "overview", label: "Overview" },
    { id: "mood", label: "Mood", needs: hasMood },
    { id: "sleep", label: "Sleep", needs: hasSleep },
    { id: "numeric", label: "Numeric", needs: hasNumeric },
    { id: "tags", label: "Tags" },
    { id: "productivity", label: "Productivity", needs: hasRescueTime },
    { id: "music", label: "Music", needs: hasMusic },
    { id: "usage", label: "Phone usage", needs: hasUsage },
    { id: "throughput", label: "Throughput", needs: hasTasks },
    { id: "timeliness", label: "Timeliness", needs: hasTasks },
    { id: "adherence", label: "Adherence", needs: hasTasks },
    { id: "difficulty", label: "Difficulty", needs: hasTasks },
    { id: "leading", label: "Leading", needs: hasLeading },
    { id: "consistency", label: "Consistency" },
    { id: "coverage", label: "Coverage" },
  ];

  // Two-tier grouped navigation: a primary category row + a secondary sub-tab
  // row. Each category lists its sub-tab panel ids (in display order). A
  // category auto-hides when none of its sub-tabs are visible; the secondary
  // row shows only when the active category has ≥2 visible sub-tabs. Overview
  // has a single sub-tab (itself) so it never shows a secondary row.
  var CATEGORIES = [
    { id: "overview", label: "Overview", tabs: ["overview"] },
    { id: "health", label: "Health", tabs: ["mood", "sleep"] },
    { id: "data", label: "Data", tabs: ["numeric", "tags"] },
    { id: "digital", label: "Digital", tabs: ["productivity", "music", "usage"] },
    { id: "tasks", label: "Tasks", tabs: ["throughput", "timeliness", "adherence", "difficulty"] },
    { id: "patterns", label: "Patterns", tabs: ["leading", "consistency", "coverage"] },
  ];

  // Filled by the chart sections (Tasks 11-13).
  var CHARTS = [];
  window.__ANALYTICS_CHARTS__ = CHARTS;  // exposed so chart files can push

  function hasNumeric() {
    return _data.sections.some(function (s) { return s.type === "numeric"; });
  }

  function hasTasks() {
    var t = _data.tasks;
    return !!t && (t.active.length || t.archive.length || t.expired.length);
  }

  function hasMood() {
    return _data.entries.some(function (e) { return e.mood != null; });
  }

  function hasSleep() {
    // Use the same usable-sleep guard the charts use (sleepOf requires a
    // truthy duration_min), so the tab never shows with all-empty charts.
    return _data.entries.some(function (e) { return sleepOf(e); });
  }

  function hasRescueTime() {
    return _data.entries.some(function (e) { return rescueTimeOf(e); });
  }

  function hasMusic() {
    return _data.entries.some(function (e) { return musicOf(e); });
  }

  function hasUsage() {
    return _data.entries.some(function (e) { return usageOf(e); });
  }

  // The Leading tab needs a mood target, >= 2 available predictor streams, and
  // >= LEAD_MIN_N lagged pairs for at least one predictor at the default lag.
  // Mirrors the Python gating from the Spec-3 design.
  function hasLeading() {
    if (!hasMood()) return false;
    var entries = filterEntries();
    var streams = availableContinuousPredictors(entries);
    // Categorical streams count toward the "predictor stream" total too.
    var catStreams = 0;
    if (tagStreamsPresent(entries)) catStreams++;
    if (hardTaskDates().length) catStreams++;
    if (streams.length + catStreams < 2) return false;
    // At least one predictor must reach LEAD_MIN_N lagged pairs at lag 1.
    var target = moodByDate(entries);
    var anyQualifies = streams.some(function (p) {
      var pred = predictorByDate(entries, p.predictor);
      return laggedPairs(pred, target, 1).length >= LEAD_MIN_N;
    });
    if (anyQualifies) return true;
    // Or a categorical predictor with >= LEAD_MIN_N after-days.
    var upl = laggedTagUplift(entries, target, 1, LEAD_MIN_N);
    if (upl.length) return true;
    var de = laggedDifficultyEffect(entries, target, 1, LEAD_MIN_N);
    return !!de;
  }

  var LEAD_MIN_N = 5;   // minimum lagged pairs to report an indicator

  // Tasks completed within the active date range, by completed-day.
  function taskThroughput() {
    var out = {};
    (_data.tasks ? _data.tasks.archive : []).forEach(function (t) {
      if (!t.completed) return;
      var d = t.completed.slice(0, 10);
      if ((_from && d < _from) || (_to && d > _to)) return;
      out[d] = (out[d] || 0) + 1;
    });
    return out;
  }

  // ----- color resolution (live, from CSS vars) -----
  function colors() {
    var cs = getComputedStyle(document.documentElement);
    function v(name) { return cs.getPropertyValue(name).trim(); }
    return {
      bg: v("--bg"), panel: v("--panel"), text: v("--text"),
      muted: v("--muted"), border: v("--border"),
      accent: v("--accent"), accentDim: v("--accent-dim"), danger: v("--danger"),
    };
  }

  // ----- SVG / stats utilities (U) -----
  var SVGNS = "http://www.w3.org/2000/svg";

  var U = {
    svgEl: function (tag, attrs) {
      var el = document.createElementNS(SVGNS, tag);
      for (var k in attrs) if (attrs[k] != null) el.setAttribute(k, attrs[k]);
      return el;
    },

    svg: function (width, height) {
      var s = U.svgEl("svg", {
        viewBox: "0 0 " + width + " " + height,
        class: "chart-svg",
        preserveAspectRatio: "xMidYMid meet",
      });
      s.dataset.w = width; s.dataset.h = height;
      return s;
    },

    // Like svg(), but renders at its natural pixel size (small) and only
    // shrinks if it would overflow the panel. Use for grid/heatmap charts so
    // a few columns stay small instead of being stretched to full width.
    svgFixed: function (width, height) {
      var s = U.svgEl("svg", {
        viewBox: "0 0 " + width + " " + height,
        width: width, height: height,
        class: "chart-svg-fixed",
        preserveAspectRatio: "xMinYMin meet",
      });
      s.dataset.w = width; s.dataset.h = height;
      return s;
    },

    text: function (svg, x, y, str, fill, opts) {
      opts = opts || {};
      var t = U.svgEl("text", {
        x: x, y: y, fill: fill,
        "font-family": "inherit",
        "font-size": opts.size || 10,
        "text-anchor": opts.anchor || "start",
      });
      t.textContent = str;
      svg.appendChild(t);
      return t;
    },

    drawGrid: function (svg, x, y, w, h, rows, c) {
      for (var i = 0; i <= rows; i++) {
        var yy = y + (h * i) / rows;
        svg.appendChild(U.svgEl("line", {
          x1: x, y1: yy, x2: x + w, y2: yy,
          stroke: c.border, "stroke-width": 1,
        }));
      }
    },

    drawAxis: function (svg, x, y, w, h, labels, c, xlabel) {
      // X-axis baseline + evenly spaced tick labels below it. Optional `xlabel`
      // draws a centered axis title beneath the ticks.
      svg.appendChild(U.svgEl("line", {
        x1: x, y1: y + h, x2: x + w, y2: y + h,
        stroke: c.muted, "stroke-width": 1,
      }));
      var n = labels.length;
      for (var i = 0; i < n; i++) {
        var cx = n === 1 ? x + w / 2 : x + (w * i) / (n - 1);
        U.text(svg, cx, y + h + 12, labels[i], c.muted,
               { anchor: "middle", size: 9 });
      }
      if (xlabel) {
        U.text(svg, x + w / 2, y + h + 26, xlabel, c.muted,
               { anchor: "middle", size: 10 });
      }
    },

    drawBar: function (svg, x, y, w, h, color) {
      svg.appendChild(U.svgEl("rect", {
        x: x, y: y, width: Math.max(w, 0), height: Math.max(h, 0),
        fill: color, rx: 2,
      }));
    },

    drawLine: function (svg, points, color, width) {
      if (points.length < 2) return;
      var d = points.map(function (p, i) {
        return (i ? "L" : "M") + p.x + " " + p.y;
      }).join(" ");
      svg.appendChild(U.svgEl("path", {
        d: d, fill: "none", stroke: color, "stroke-width": width || 1.5,
      }));
    },

    drawDot: function (svg, cx, cy, r, color) {
      svg.appendChild(U.svgEl("circle", { cx: cx, cy: cy, r: r, fill: color }));
    },

    // mean/median/mode/stdev/min/max/count; matches journal.describe (sample stdev).
    describe: function (values) {
      var vals = values.filter(function (v) { return v != null; }).map(Number);
      var n = vals.length;
      if (!n) return { mean: null, median: null, mode: null,
                       stdev: null, min: null, max: null, count: 0 };
      var sorted = vals.slice().sort(function (a, b) { return a - b; });
      var mean = vals.reduce(function (a, b) { return a + b; }, 0) / n;
      var median = n % 2 ? sorted[(n - 1) / 2]
                         : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
      var counts = new Map();
      vals.forEach(function (v) { counts.set(v, (counts.get(v) || 0) + 1); });
      var top = 0;
      counts.forEach(function (c) { if (c > top) top = c; });
      var mode = null;
      if (top > 1) {
        var modes = [];
        counts.forEach(function (c, v) { if (c === top) modes.push(v); });
        mode = Math.min.apply(null, modes);
      }
      var stdev = n >= 2 ? Math.sqrt(vals.reduce(function (a, b) {
        return a + (b - mean) * (b - mean);
      }, 0) / (n - 1)) : null;
      return { mean: mean, median: median, mode: mode, stdev: stdev,
               min: sorted[0], max: sorted[n - 1], count: n };
    },

    // pairs: [["label", "value"], ...]; null/undefined values are skipped.
    statsRow: function (container, pairs) {
      var row = document.createElement("div");
      row.className = "stats-row";
      pairs.forEach(function (p) {
        if (p[1] == null || p[1] === "") return;
        var stat = document.createElement("span");
        stat.className = "stat";
        var l = document.createElement("span");
        l.className = "stat-label"; l.textContent = p[0] + ":";
        var v = document.createElement("span");
        v.className = "stat-value"; v.textContent = p[1];
        stat.appendChild(l); stat.appendChild(v);
        row.appendChild(stat);
      });
      if (row.children.length) container.appendChild(row);
    },

    empty: function (container, msg) {
      var p = document.createElement("p");
      p.className = "analytics-empty";
      p.textContent = msg;
      container.appendChild(p);
    },

    colorMix: function (hex, pct) {
      return "color-mix(in srgb, " + hex + " " + pct + "%, transparent)";
    },

    tagSections: function (sections) {
      return sections.filter(function (s) { return s.type === "tag"; });
    },

    numericSections: function (sections) {
      return sections.filter(function (s) { return s.type === "numeric"; });
    },

    fmt: function (n) {  // tidy number for stat display
      if (n == null) return null;
      return Math.round(n * 100) / 100 + "";
    },
  };

  window.__ANALYTICS_U__ = U;  // exposed for chart files

  // ===================== Overview & Consistency charts ===================== //

  // Shared JS reimplementations of the streak/gap logic (mirror journal.py).
  function uniqueDates(entries) {
    var set = {};
    entries.forEach(function (e) { if (e.date) set[e.date] = true; });
    return Object.keys(set).sort();
  }
  function dayDiff(a, b) {  // whole days between two YYYY-MM-DD strings
    return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
  }
  function isoShift(iso, days) {  // YYYY-MM-DD shifted by N days (UTC-safe)
    var d = new Date(iso + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }
  function streaks(dates) {
    if (!dates.length) return { current: 0, longest: 0, runs: [] };
    var runs = [], run = 1;
    for (var i = 1; i < dates.length; i++) {
      if (dayDiff(dates[i - 1], dates[i]) === 1) run++;
      else { runs.push(run); run = 1; }
    }
    runs.push(run);
    return { current: runs[runs.length - 1], longest: Math.max.apply(null, runs), runs: runs };
  }

  // ----- Overview building blocks -----

  // A prominent stat card: big value + label, optional sub-line.
  function statCard(grid, value, label, sub) {
    var card = document.createElement("div");
    card.className = "stat-card";
    var v = document.createElement("div");
    v.className = "stat-card-value";
    v.textContent = (value == null || value === "") ? "—" : value;
    var l = document.createElement("div");
    l.className = "stat-card-label";
    l.textContent = label;
    card.appendChild(v); card.appendChild(l);
    if (sub != null && sub !== "") {
      var s = document.createElement("div");
      s.className = "stat-card-sub";
      s.textContent = sub;
      card.appendChild(s);
    }
    grid.appendChild(card);
    return card;
  }

  // A tiny inline sparkline (mood 1..7) appended into a stat card.
  function moodSparkline(card, series) {
    if (series.length < 2) return;
    var w = 120, h = 28;
    var svg = U.svgEl("svg", {
      viewBox: "0 0 " + w + " " + h, width: w, height: h, class: "stat-spark",
    });
    var min = 1, max = 7, span = max - min;
    var pts = series.map(function (s, i) {
      return {
        x: (w * i) / (series.length - 1),
        y: 3 + (h - 6) * (1 - (s.mood - min) / span),
      };
    });
    var c = colors();
    U.drawLine(svg, pts, c.accent, 1.5);
    U.drawDot(svg, pts[pts.length - 1].x, pts[pts.length - 1].y, 2, c.accent);
    card.appendChild(svg);
  }

  // Completed tasks in range (whole-store, by completed-day), for Overview.
  function tasksCompletedInRange() {
    var byDay = taskThroughput();
    return Object.keys(byDay).reduce(function (a, d) { return a + byDay[d]; }, 0);
  }

  // Auto-generated plain-language insights. Each returns a string or null.
  function buildInsights(entries) {
    var out = [];
    var moods = moodSeries(entries);

    // Weekend vs weekday mood.
    if (moods.length >= 4) {
      var wk = [], we = [];
      moods.forEach(function (m) {
        var dow = new Date(m.date + "T00:00:00").getDay();  // 0=Sun..6=Sat
        (dow === 0 || dow === 6 ? we : wk).push(m.mood);
      });
      if (wk.length && we.length) {
        var mk = wk.reduce(function (a, b) { return a + b; }, 0) / wk.length;
        var me = we.reduce(function (a, b) { return a + b; }, 0) / we.length;
        var diff = me - mk;
        if (Math.abs(diff) >= 0.4) {
          out.push("Your mood averages " + U.fmt(Math.abs(diff)) +
                   (diff > 0 ? " higher on weekends." : " higher on weekdays."));
        }
      }
    }

    // Best mood stretch (longest run of consecutive good days, mood >= 5).
    if (moods.length) {
      var bestLen = 0, bestEnd = null, run = 0, prev = null;
      moods.forEach(function (m) {
        var good = m.mood >= 5;
        if (good && prev && dayDiff(prev, m.date) === 1) run++;
        else run = good ? 1 : 0;
        prev = m.date;
        if (run > bestLen) { bestLen = run; bestEnd = m.date; }
      });
      if (bestLen >= 3) {
        out.push("Best stretch: " + bestLen + " good days ending " + bestEnd + ".");
      }
    }

    // Streak milestone.
    var dates = uniqueDates(entries);
    var st = streaks(dates);
    if (st.current >= 3 && st.current === st.longest) {
      out.push("You've journaled " + st.current +
               " days straight — your longest yet.");
    }

    // Strongest mood<->numeric correlation across numeric sections.
    var best = null;
    U.numericSections(_data.sections).forEach(function (s) {
      var pairs = entries.filter(function (e) {
        return moodOf(e) != null && (e.numbers || {})[s.id] != null;
      });
      if (pairs.length < 3) return;
      var r = pearson(pairs.map(function (e) { return Number(e.numbers[s.id]); }),
                      pairs.map(function (e) { return moodOf(e); }));
      if (r != null && (!best || Math.abs(r) > Math.abs(best.r))) {
        best = { name: s.name, r: r };
      }
    });
    if (best && Math.abs(best.r) >= 0.3) {
      out.push("More " + best.name + " tracks with " +
               (best.r > 0 ? "better" : "worse") + " mood (r=" +
               (best.r > 0 ? "+" : "") + U.fmt(best.r) + ").");
    }

    return out.slice(0, 4);
  }

  // ----- Overview launchpad: click a card/driver/suggestion into a deep tab.
  // Uses the goTo(category, tab) entry point. Defined up here (hoisted) but
  // they call functions declared later in the IIFE; all are reachable by the
  // time a click fires. -----
  function makeClickable(el, fn) {
    el.classList.add("ov-clickable");
    el.setAttribute("tabindex", "0");
    el.setAttribute("role", "button");
    el.addEventListener("click", fn);
    el.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); }
    });
  }
  function gotoNumeric(sectionId) {
    _secSel.numeric = sectionId ? [sectionId] : null;
    goTo("data", "numeric");
  }
  function gotoMood() {
    goTo("health", "mood");
  }
  function gotoThroughput() {
    goTo("tasks", "throughput");
  }
  function gotoTag(name) {
    _tagQuery = (name || "").trim().toLowerCase();
    goTo("data", "tags");   // renderTagsTab reads _tagQuery for the detail
  }

  // Shift the active [_from,_to] range back one equal-length window. Returns
  // {start, end} or null when the range is open-ended (no deltas then).
  function previousWindow() {
    if (!_from || !_to) return null;
    var len = dayDiff(_from, _to);
    var prevEnd = isoShift(_from, -1);
    return { start: isoShift(prevEnd, -len), end: prevEnd };
  }
  function entriesInRange(start, end) {
    return _data.entries.filter(function (e) {
      return e.date >= start && e.date <= end;
    });
  }
  function tasksCompletedBetween(start, end) {
    var n = 0;
    (_data.tasks ? _data.tasks.archive : []).forEach(function (t) {
      if (!t.completed) return;
      var d = t.completed.slice(0, 10);
      if (d >= start && d <= end) n++;
    });
    return n;
  }
  function totalWords(entries) {
    return entries.reduce(function (a, e) {
      return a + (e.body || "").split(/\s+/).filter(Boolean).length;
    }, 0);
  }
  function meanMood(entries) {
    var ms = moodSeries(entries).map(function (m) { return m.mood; });
    return ms.length ? ms.reduce(function (a, b) { return a + b; }, 0) / ms.length : null;
  }

  // Annotate a stat card with a ▲/▼ delta vs a previous value. Muted/omitted
  // when flat, when there's no previous data, or when prev is null.
  function annotateDelta(card, cur, prev, opts) {
    opts = opts || {};
    if (prev == null || cur == null) return;
    var delta = cur - prev;
    if (Math.abs(delta) < (opts.eps || 1e-9)) return;   // flat -> omit
    var el = document.createElement("div");
    el.className = "stat-delta " + (delta > 0 ? "up" : "down");
    var mag = opts.fmt ? opts.fmt(Math.abs(delta)) : U.fmt(Math.abs(delta));
    el.textContent = (delta > 0 ? "▲ " : "▼ ") + mag + " vs prev";
    card.appendChild(el);
  }

  // JS mirror of journal.mood_tag_uplift over a set of entries (range-aware).
  // [{name, section_id, avg_mood, baseline, uplift, n}], sorted |uplift| desc.
  function moodTagUplift(entries, minN) {
    minN = minN || 2;
    var moods = moodSeries(entries).map(function (m) { return m.mood; });
    if (!moods.length) return [];
    var baseline = moods.reduce(function (a, b) { return a + b; }, 0) / moods.length;
    var byTag = {};   // "name|sid" -> [moods]
    entries.forEach(function (e) {
      var m = moodOf(e);
      if (m == null) return;
      var tags = e.tags || {};
      Object.keys(tags).forEach(function (sid) {
        var seen = {};
        (tags[sid] || []).forEach(function (raw) {
          var n = String(raw).trim().toLowerCase();
          if (!n || seen[n]) return;
          seen[n] = true;
          var key = n + "|" + sid;
          (byTag[key] = byTag[key] || []).push(m);
        });
      });
    });
    var out = [];
    Object.keys(byTag).forEach(function (key) {
      var moodsT = byTag[key];
      if (moodsT.length < minN) return;
      var sep = key.lastIndexOf("|");
      var avg = moodsT.reduce(function (a, b) { return a + b; }, 0) / moodsT.length;
      out.push({
        name: key.slice(0, sep), section_id: key.slice(sep + 1),
        avg_mood: avg, baseline: baseline, uplift: avg - baseline, n: moodsT.length,
      });
    });
    out.sort(function (a, b) { return Math.abs(b.uplift) - Math.abs(a.uplift); });
    return out;
  }

  // Difficulty -> mood: mean mood on days a `hard` task was completed vs other
  // days. Returns {hardMean, otherMean, diff, nHard, nOther} or null on thin
  // data. Cross-domain: joins _data.tasks archive completions to entry moods.
  function difficultyMoodEffect(entries) {
    var moodBy = moodByDate(entries);
    var hardDays = {};
    (_data.tasks ? _data.tasks.archive : []).forEach(function (t) {
      if (t.difficulty === "hard" && t.completed) {
        hardDays[t.completed.slice(0, 10)] = true;
      }
    });
    var hard = [], other = [];
    Object.keys(moodBy).forEach(function (d) {
      (hardDays[d] ? hard : other).push(moodBy[d]);
    });
    if (hard.length < 2 || !other.length) return null;
    function mean(a) { return a.reduce(function (x, y) { return x + y; }, 0) / a.length; }
    var hm = mean(hard), om = mean(other);
    return { hardMean: hm, otherMean: om, diff: hm - om,
             nHard: hard.length, nOther: other.length };
  }

  // Mood color ramp: map a 1..7 mood onto danger(low) -> accent(high). Returns
  // a color-mix string blending the two theme colors by mood position.
  function moodRampColor(mood, c) {
    var frac = (Math.max(1, Math.min(7, mood)) - 1) / 6;   // 0..1
    // Blend danger and accent: accent share rises with mood.
    return "color-mix(in srgb, " + c.accent + " " +
           Math.round(frac * 100) + "%, " + c.danger + ")";
  }

  // A month grid blending journal + tasks + mood for the Overview heatmap.
  // tint = mood ramp (neutral when no mood); a small dot row marks an entry
  // and task completions; the cell title summarizes the day.
  function buildActivityMonthGrid(year, month, moodBy, entryDays, taskBy, todayIso, c) {
    var wrap = document.createElement("div");
    wrap.className = "cal-month";
    var title = document.createElement("div");
    title.className = "cal-month-title";
    title.textContent = CAL_MONTHS[month] + " " + year;
    wrap.appendChild(title);
    var grid = document.createElement("div");
    grid.className = "cal-grid";
    CAL_DAYS.forEach(function (d) {
      var wh = document.createElement("div");
      wh.className = "cal-weekday"; wh.textContent = d;
      grid.appendChild(wh);
    });
    var firstDow = new Date(year, month, 1).getDay();
    for (var b = 0; b < firstDow; b++) {
      var blank = document.createElement("div");
      blank.className = "cal-day cal-day-blank";
      grid.appendChild(blank);
    }
    var daysInMonth = new Date(year, month + 1, 0).getDate();
    for (var day = 1; day <= daysInMonth; day++) {
      var iso = calIso(year, month, day);
      var cell = document.createElement("div");
      cell.className = "cal-day";
      if (iso === todayIso) cell.classList.add("is-today");
      var mood = moodBy[iso];
      var nTasks = taskBy[iso] || 0;
      var hasEntry = !!entryDays[iso];
      if (mood != null) {
        cell.style.background = U.colorMix(moodRampColor(mood, c), 70);
      } else if (hasEntry || nTasks) {
        cell.style.background = U.colorMix(c.muted, 14);   // activity, no mood
      }
      var bits = [iso];
      bits.push(mood != null ? "mood " + mood : "no mood");
      bits.push(hasEntry ? "entry" : "no entry");
      if (nTasks) bits.push(nTasks + " task" + (nTasks === 1 ? "" : "s") + " done");
      cell.title = bits.join(" · ");
      var num = document.createElement("span");
      num.className = "cal-day-num";
      num.textContent = String(day);
      cell.appendChild(num);
      if (hasEntry || nTasks) {
        var dots = document.createElement("span");
        dots.className = "cal-dots-row";
        if (hasEntry) {
          var ed = document.createElement("span");
          ed.className = "cal-dot";
          dots.appendChild(ed);
        }
        for (var k = 0; k < Math.min(nTasks, 3); k++) {
          var td = document.createElement("span");
          td.className = "cal-dot cal-dot-alt";
          dots.appendChild(td);
        }
        cell.appendChild(dots);
      }
      grid.appendChild(cell);
    }
    wrap.appendChild(grid);
    return wrap;
  }

  CHARTS.push({
    id: "overview-summary",
    panel: "overview",
    title: "Overview",
    render: function (container, entries, sections, c) {
      if (!entries.length) { U.empty(container, "No entries in this range."); return; }
      var dates = uniqueDates(entries);
      var st = streaks(dates);
      var moods = moodSeries(entries);
      var md = U.describe(moods.map(function (m) { return m.mood; }));
      var prev = previousWindow();
      var prevEntries = prev ? entriesInRange(prev.start, prev.end) : null;

      // ----- prominent stat cards (with deltas vs the previous window) -----
      var grid = document.createElement("div");
      grid.className = "stat-cards";

      var entriesCard = statCard(grid, entries.length, "entries this period",
               "last: " + dates[dates.length - 1]);
      if (prevEntries) annotateDelta(entriesCard, entries.length,
               uniqueDates(prevEntries).length, { fmt: function (n) { return n + ""; } });

      statCard(grid, st.current + "d", "current streak", "longest " + st.longest + "d");

      var moodCard = statCard(grid, md.count ? U.fmt(md.mean) : null,
                              "avg mood",
                              md.count ? md.count + " day" + (md.count === 1 ? "" : "s") : "no mood yet");
      if (md.count) moodSparkline(moodCard, moods);
      if (prevEntries && md.count) annotateDelta(moodCard, md.mean, meanMood(prevEntries));
      makeClickable(moodCard, gotoMood);

      if (hasTasks()) {
        var tasksCard = statCard(grid, tasksCompletedInRange(), "tasks completed", null);
        if (prev) annotateDelta(tasksCard, tasksCompletedInRange(),
                 tasksCompletedBetween(prev.start, prev.end),
                 { fmt: function (n) { return n + ""; } });
        makeClickable(tasksCard, gotoThroughput);
      }

      var wordsCard = statCard(grid, totalWords(entries), "words written", null);
      if (prevEntries) annotateDelta(wordsCard, totalWords(entries),
               totalWords(prevEntries), { fmt: function (n) { return n + ""; } });

      // Current numeric highlights: latest value per numeric section (clickable).
      U.numericSections(sections).forEach(function (s) {
        var series = numericSeries(entries, s.id);
        if (!series.length) return;
        var last = series[series.length - 1];
        var nc = statCard(grid, U.fmt(last.value) + (s.unit ? " " + s.unit : ""),
                 s.name, "latest " + last.date);
        makeClickable(nc, function () { gotoNumeric(s.id); });
      });
      container.appendChild(grid);

      // ----- combined activity heatmap (journal + tasks + mood) -----
      renderActivityHeatmap(container, entries, c);

      // ----- drivers board (what moves my mood) -----
      renderDriversBoard(container, entries, sections, c);

      // ----- auto-insights -----
      var insights = buildInsights(entries);
      if (insights.length) {
        var box = document.createElement("div");
        box.className = "insights";
        var h = document.createElement("div");
        h.className = "insights-title";
        h.textContent = "Insights";
        box.appendChild(h);
        var ul = document.createElement("ul");
        ul.className = "insights-list";
        insights.forEach(function (text) {
          var li = document.createElement("li");
          li.textContent = text;
          ul.appendChild(li);
        });
        box.appendChild(ul);
        container.appendChild(box);
      }

      // ----- compact secondary stats (kept from the original summary) -----
      var words = entries.map(function (e) {
        return (e.body || "").split(/\s+/).filter(Boolean).length;
      });
      var coveredCounts = entries.map(function (e) {
        var n = 0;
        sections.forEach(function (s) {
          var t = (e.tags || {})[s.id];
          if ((t && t.length) || (e.numbers || {})[s.id] != null) n++;
        });
        return n;
      });
      U.statsRow(container, [
        ["avg words/entry", U.fmt(U.describe(words).mean)],
        ["avg sections filled", U.fmt(U.describe(coveredCounts).mean)],
      ]);
    },
  });

  // The combined activity heatmap: one month grid per spanned calendar month,
  // each day tinted by mood (ramp) and marked for entry + task completions.
  function renderActivityHeatmap(container, entries, c) {
    var dates = uniqueDates(entries);
    if (!dates.length) return;
    var moodBy = moodByDate(entries);
    var entryDays = {};
    dates.forEach(function (d) { entryDays[d] = true; });
    var taskBy = taskThroughput();   // {YYYY-MM-DD: completed count} in range
    var now = new Date();
    var todayIso = calIso(now.getFullYear(), now.getMonth(), now.getDate());

    var section = document.createElement("div");
    section.className = "ov-section";
    var h = document.createElement("div");
    h.className = "ov-section-title";
    h.textContent = "Activity";
    section.appendChild(h);

    var wrap = document.createElement("div");
    wrap.className = "analytics-cal";
    var first = new Date(dates[0] + "T00:00:00");
    var last = new Date(dates[dates.length - 1] + "T00:00:00");
    var y = first.getFullYear(), m = first.getMonth();
    while (y < last.getFullYear() || (y === last.getFullYear() && m <= last.getMonth())) {
      wrap.appendChild(buildActivityMonthGrid(y, m, moodBy, entryDays, taskBy, todayIso, c));
      m++; if (m > 11) { m = 0; y++; }
    }
    section.appendChild(wrap);

    // Legend: mood ramp + the entry / task dot marks.
    var legend = document.createElement("div");
    legend.className = "heat-legend";
    var ramp = document.createElement("span");
    ramp.className = "heat-legend-ramp";
    ramp.style.background = "linear-gradient(90deg," +
      moodRampColor(1, c) + "," + moodRampColor(4, c) + "," + moodRampColor(7, c) + ")";
    legend.appendChild(document.createTextNode("low "));
    legend.appendChild(ramp);
    legend.appendChild(document.createTextNode(" high mood"));
    var entLeg = document.createElement("span");
    entLeg.className = "heat-legend-mark";
    entLeg.innerHTML = '<span class="cal-dot"></span> entry &nbsp; ' +
                       '<span class="cal-dot cal-dot-alt"></span> task done';
    legend.appendChild(entLeg);
    section.appendChild(legend);
    container.appendChild(section);
  }

  // The drivers board: a ranked one-line list of what correlates with mood —
  // tag uplift, strongest mood↔numeric Pearson, and difficulty→mood. Each row
  // is origin-marked and clickable into the relevant deep tab. Thin rows drop.
  function renderDriversBoard(container, entries, sections, c) {
    var rows = [];   // {kind, label, effect (sortable), build(li)}

    // Tag uplift (top 3 by |uplift|), origin = section dot, click -> Tags tab.
    moodTagUplift(entries, 2).slice(0, 3).forEach(function (u) {
      if (Math.abs(u.uplift) < 0.3) return;
      rows.push({
        effect: Math.abs(u.uplift),
        origin: { dot: sectionColorOf(u.section_id) },
        name: u.name,
        text: (u.uplift > 0 ? "+" : "") + U.fmt(u.uplift) + " mood when present",
        click: function () { gotoTag(u.name); },
      });
    });

    // Strongest mood<->numeric correlation, click -> that numeric section.
    var best = null;
    U.numericSections(sections).forEach(function (s) {
      var pairs = entries.filter(function (e) {
        return moodOf(e) != null && (e.numbers || {})[s.id] != null;
      });
      if (pairs.length < 3) return;
      var r = pearson(pairs.map(function (e) { return Number(e.numbers[s.id]); }),
                      pairs.map(function (e) { return moodOf(e); }));
      if (r != null && (!best || Math.abs(r) > Math.abs(best.r))) {
        best = { name: s.name, id: s.id, r: r, color: s.color };
      }
    });
    if (best && Math.abs(best.r) >= 0.3) {
      rows.push({
        effect: Math.abs(best.r),
        origin: { dot: best.color },
        name: best.name,
        text: "r=" + (best.r > 0 ? "+" : "") + U.fmt(best.r) + " with mood",
        click: function () { gotoNumeric(best.id); },
      });
    }

    // Difficulty -> mood (cross-domain), origin = task mark, click -> Throughput.
    var de = difficultyMoodEffect(entries);
    if (de && Math.abs(de.diff) >= 0.3) {
      rows.push({
        effect: Math.abs(de.diff),
        origin: { task: true },
        name: "hard tasks",
        text: (de.diff > 0 ? "+" : "") + U.fmt(de.diff) + " mood on hard-task days",
        click: gotoThroughput,
      });
    }

    if (!rows.length) return;
    rows.sort(function (a, b) { return b.effect - a.effect; });

    var section = document.createElement("div");
    section.className = "ov-section";
    var h = document.createElement("div");
    h.className = "ov-section-title";
    h.textContent = "What moves my mood";
    section.appendChild(h);
    var list = document.createElement("div");
    list.className = "drivers-list";
    rows.forEach(function (r) {
      var row = document.createElement("div");
      row.className = "driver-row";
      var nm = document.createElement("span");
      nm.className = "driver-name";
      nm.appendChild(r.origin.task ? originTaskMark() : originDot(r.origin.dot));
      nm.appendChild(document.createTextNode(" " + r.name));
      var tx = document.createElement("span");
      tx.className = "driver-effect";
      tx.textContent = r.text;
      row.appendChild(nm); row.appendChild(tx);
      makeClickable(row, r.click);
      list.appendChild(row);
    });
    section.appendChild(list);
    container.appendChild(section);
  }

  // Month-grid calendar matching the journal entry form's custom calendar.
  // Reuses the .cal-* classes from style.css so the look is identical; days
  // with an entry get an amber dot under the number, today gets the amber ring.
  var CAL_MONTHS = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  var CAL_DAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

  function calIso(y, m, d) {
    return y + "-" + String(m + 1).padStart(2, "0") + "-" + String(d).padStart(2, "0");
  }

  function buildMonthGrid(year, month, present, todayIso, marked) {
    var wrap = document.createElement("div");
    wrap.className = "cal-month";

    var title = document.createElement("div");
    title.className = "cal-month-title";
    title.textContent = CAL_MONTHS[month] + " " + year;
    wrap.appendChild(title);

    var grid = document.createElement("div");
    grid.className = "cal-grid";
    CAL_DAYS.forEach(function (d) {
      var wh = document.createElement("div");
      wh.className = "cal-weekday";
      wh.textContent = d;
      grid.appendChild(wh);
    });

    var firstDow = new Date(year, month, 1).getDay();
    for (var b = 0; b < firstDow; b++) {
      var blank = document.createElement("div");
      blank.className = "cal-day cal-day-blank";
      grid.appendChild(blank);
    }

    var daysInMonth = new Date(year, month + 1, 0).getDate();
    for (var day = 1; day <= daysInMonth; day++) {
      var iso = calIso(year, month, day);
      var cell = document.createElement("div");
      cell.className = "cal-day";
      if (iso === todayIso) cell.classList.add("is-today");
      var num = document.createElement("span");
      num.className = "cal-day-num";
      num.textContent = String(day);
      cell.appendChild(num);
      // Optional second marked-set (e.g. task completions) sits beside the
      // entry dot in --accent-dim. When `marked` is given, both dots live in a
      // flex row so they render side by side; existing callers pass no
      // `marked` arg and keep the original single stacked dot.
      if (marked) {
        var dots = document.createElement("span");
        dots.className = "cal-dots-row";
        if (present[iso]) {
          var ed = document.createElement("span");
          ed.className = "cal-dot";
          dots.appendChild(ed);
        }
        if (marked[iso]) {
          var td = document.createElement("span");
          td.className = "cal-dot cal-dot-alt";
          dots.appendChild(td);
        }
        if (dots.children.length) cell.appendChild(dots);
      } else if (present[iso]) {
        var dot = document.createElement("span");
        dot.className = "cal-dot";
        cell.appendChild(dot);
      }
      grid.appendChild(cell);
    }
    wrap.appendChild(grid);
    return wrap;
  }

  // A month grid whose cells are shaded by a numeric value (dark -> section
  // color). `byDate` is {YYYY-MM-DD: value}; `min`/`span` normalize the value to
  // a 0..1 fill fraction. Reuses the same .cal-* classes as buildMonthGrid.
  function buildValueMonthGrid(year, month, byDate, min, span, color, todayIso) {
    var wrap = document.createElement("div");
    wrap.className = "cal-month";
    var title = document.createElement("div");
    title.className = "cal-month-title";
    title.textContent = CAL_MONTHS[month] + " " + year;
    wrap.appendChild(title);
    var grid = document.createElement("div");
    grid.className = "cal-grid";
    CAL_DAYS.forEach(function (d) {
      var wh = document.createElement("div");
      wh.className = "cal-weekday"; wh.textContent = d;
      grid.appendChild(wh);
    });
    var firstDow = new Date(year, month, 1).getDay();
    for (var b = 0; b < firstDow; b++) {
      var blank = document.createElement("div");
      blank.className = "cal-day cal-day-blank";
      grid.appendChild(blank);
    }
    var daysInMonth = new Date(year, month + 1, 0).getDate();
    for (var day = 1; day <= daysInMonth; day++) {
      var iso = calIso(year, month, day);
      var cell = document.createElement("div");
      cell.className = "cal-day";
      if (iso === todayIso) cell.classList.add("is-today");
      if (byDate[iso] != null) {
        var frac = (byDate[iso] - min) / span;  // 0..1
        // Map to 15..100% so even the lowest value is faintly visible.
        cell.style.background = U.colorMix(color, Math.round(15 + frac * 85));
        cell.title = iso + ": " + U.fmt(byDate[iso]);
      }
      var num = document.createElement("span");
      num.className = "cal-day-num";
      num.textContent = String(day);
      cell.appendChild(num);
      grid.appendChild(cell);
    }
    wrap.appendChild(grid);
    return wrap;
  }

  CHARTS.push({
    id: "calendar-heatmap",
    panel: "consistency",
    title: "Entry calendar",
    render: function (container, entries, sections, c) {
      var dates = uniqueDates(entries);
      if (!dates.length) { U.empty(container, "No entries in this range."); return; }
      var present = {};
      dates.forEach(function (d) { present[d] = true; });
      var now = new Date();
      var todayIso = calIso(now.getFullYear(), now.getMonth(), now.getDate());

      // One month grid per calendar month spanned by the filtered range.
      var first = new Date(dates[0] + "T00:00:00");
      var last = new Date(dates[dates.length - 1] + "T00:00:00");
      var wrap = document.createElement("div");
      wrap.className = "analytics-cal";
      var y = first.getFullYear(), m = first.getMonth();
      while (y < last.getFullYear() || (y === last.getFullYear() && m <= last.getMonth())) {
        wrap.appendChild(buildMonthGrid(y, m, present, todayIso));
        m++;
        if (m > 11) { m = 0; y++; }
      }
      container.appendChild(wrap);
      U.statsRow(container, [["days with an entry", dates.length]]);
    },
  });

  CHARTS.push({
    id: "word-count",
    panel: "consistency",
    title: "Words per entry over time",
    render: function (container, entries, sections, c) {
      var series = entries.map(function (e) {
        return { date: e.date, count: (e.body || "").split(/\s+/).filter(Boolean).length };
      }).sort(function (a, b) { return a.date < b.date ? -1 : 1; });
      if (!series.length) { U.empty(container, "No entries in this range."); return; }
      var w = 600, h = 180, pad = 30;
      var svg = U.svg(w, h);
      var max = Math.max.apply(null, series.map(function (s) { return s.count; })) || 1;
      U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 4, c);
      var pts = series.map(function (s, i) {
        var x = series.length === 1 ? pad + (w - pad - 10) / 2
                                    : pad + ((w - pad - 10) * i) / (series.length - 1);
        var y = 10 + (h - pad - 10) * (1 - s.count / max);
        return { x: x, y: y };
      });
      U.drawLine(svg, pts, c.accent, 1.5);
      pts.forEach(function (p) { U.drawDot(svg, p.x, p.y, 2, c.accent); });
      U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10,
                 [series[0].date, series[series.length - 1].date], c);
      container.appendChild(svg);
      var wd = U.describe(series.map(function (s) { return s.count; }));
      U.statsRow(container, [["mean", U.fmt(wd.mean)], ["median", U.fmt(wd.median)]]);
    },
  });

  CHARTS.push({
    id: "entry-gaps",
    panel: "consistency",
    title: "Gaps between entries",
    render: function (container, entries, sections, c) {
      var dates = uniqueDates(entries);
      var gaps = [];
      for (var i = 1; i < dates.length; i++) gaps.push(dayDiff(dates[i - 1], dates[i]));
      if (!gaps.length) { U.empty(container, "Need at least two entries to show gaps."); return; }
      // Histogram by gap size.
      var hist = {};
      gaps.forEach(function (g) { hist[g] = (hist[g] || 0) + 1; });
      var keys = Object.keys(hist).map(Number).sort(function (a, b) { return a - b; });
      var w = 600, h = 180, pad = 30;
      var svg = U.svg(w, h);
      var max = Math.max.apply(null, keys.map(function (k) { return hist[k]; }));
      var bw = (w - pad - 10) / keys.length;
      keys.forEach(function (k, i) {
        var bh = (h - pad - 10) * (hist[k] / max);
        U.drawBar(svg, pad + i * bw + 2, 10 + (h - pad - 10) - bh, bw - 4, bh, c.accent);
      });
      U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10,
                 keys.map(function (k) { return k + "d"; }), c);
      container.appendChild(svg);
      var gd = U.describe(gaps);
      U.statsRow(container, [["mean gap", U.fmt(gd.mean) + "d"],
                             ["median gap", U.fmt(gd.median) + "d"]]);
    },
  });

  CHARTS.push({
    id: "time-of-day",
    panel: "consistency",
    title: "When entries are written",
    render: function (container, entries, sections, c) {
      var hours = {};
      for (var i = 0; i < 24; i++) hours[i] = 0;
      var any = false;
      entries.forEach(function (e) {
        if (!e.created) return;
        var hr = new Date(e.created).getHours();
        if (!isNaN(hr)) { hours[hr]++; any = true; }
      });
      if (!any) { U.empty(container, "No creation timestamps in this range."); return; }
      var w = 600, h = 180, pad = 30;
      var svg = U.svg(w, h);
      var max = Math.max.apply(null, Object.keys(hours).map(function (k) { return hours[k]; })) || 1;
      var bw = (w - pad - 10) / 24;
      for (var hgt = 0; hgt < 24; hgt++) {
        var bh = (h - pad - 10) * (hours[hgt] / max);
        U.drawBar(svg, pad + hgt * bw + 1, 10 + (h - pad - 10) - bh, bw - 2, bh, c.accent);
      }
      U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10, ["0", "6", "12", "18", "23"], c);
      container.appendChild(svg);
      // Mode hour as "usually journals at Xam/pm".
      var counts = Object.keys(hours).map(function (k) { return [Number(k), hours[k]]; });
      counts.sort(function (a, b) { return b[1] - a[1]; });
      var topHr = counts[0][1] > 0 ? counts[0][0] : null;
      var label = topHr == null ? null
        : (topHr % 12 === 0 ? 12 : topHr % 12) + (topHr < 12 ? "am" : "pm");
      U.statsRow(container, [["usually writes around", label]]);
    },
  });

  // ===================== Tag charts (one block per tag section) ============ //

  function tagsForSectionEntry(e, sid) {
    return ((e.tags || {})[sid]) || [];
  }
  function sectionTagFreq(entries, sid) {
    var freq = {};
    entries.forEach(function (e) {
      tagsForSectionEntry(e, sid).forEach(function (t) { freq[t] = (freq[t] || 0) + 1; });
    });
    return freq;
  }

  CHARTS.push({
    id: "tag-frequency",
    panel: "tags",
    title: "Tag frequency",
    render: function (container, entries, sections, c) {
      var tagSecs = U.tagSections(sections);
      if (!tagSecs.length) { U.empty(container, "No tag sections."); return; }
      var rendered = false;
      tagSecs.forEach(function (s) {
        var freq = sectionTagFreq(entries, s.id);
        var keys = Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; });
        if (!keys.length) return;
        rendered = true;
        var block = document.createElement("div");
        block.className = "section-block";
        var h4 = document.createElement("h4");
        h4.textContent = s.name;
        block.appendChild(h4);
        var rowH = 18, w = 600, pad = 90;
        var svg = U.svg(w, keys.length * rowH + 6);
        var max = Math.max.apply(null, keys.map(function (k) { return freq[k]; }));
        keys.forEach(function (k, i) {
          var y = i * rowH + 2;
          U.text(svg, pad - 6, y + 12, k, c.text, { anchor: "end", size: 10 });
          var bw = (w - pad - 30) * (freq[k] / max);
          U.drawBar(svg, pad, y + 3, bw, 11, s.color);
          U.text(svg, pad + bw + 4, y + 12, freq[k], c.muted, { size: 9 });
        });
        block.appendChild(svg);
        // mode (most-used tag) + mean uses/tag.
        var d = U.describe(keys.map(function (k) { return freq[k]; }));
        U.statsRow(block, [["most-used", keys[0]],
                           ["mean uses/tag", U.fmt(d.mean)]]);
        container.appendChild(block);
      });
      if (!rendered) U.empty(container, "No tags recorded in this range.");
    },
  });

  CHARTS.push({
    id: "tag-trend",
    panel: "tags",
    title: "Top-tag trend (per ISO week)",
    render: function (container, entries, sections, c) {
      var tagSecs = U.tagSections(sections);
      var rendered = false;
      tagSecs.forEach(function (s) {
        var freq = sectionTagFreq(entries, s.id);
        var keys = Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; });
        if (!keys.length) return;
        var tag = keys[0];  // chart the section's most-used tag
        // Weekly counts.
        var weeks = {};
        entries.forEach(function (e) {
          if (tagsForSectionEntry(e, s.id).indexOf(tag) === -1) return;
          var d = new Date(e.date + "T00:00:00");
          var wk = isoWeekKey(d);
          weeks[wk] = (weeks[wk] || 0) + 1;
        });
        var wk = Object.keys(weeks).sort();
        if (wk.length < 2) return;
        rendered = true;
        var block = document.createElement("div");
        block.className = "section-block";
        var h4 = document.createElement("h4");
        h4.textContent = s.name + " — “" + tag + "”";
        block.appendChild(h4);
        var w = 600, h = 160, pad = 30;
        var svg = U.svg(w, h);
        var max = Math.max.apply(null, wk.map(function (k) { return weeks[k]; }));
        U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 3, c);
        var pts = wk.map(function (k, i) {
          var x = pad + ((w - pad - 10) * i) / (wk.length - 1);
          var y = 10 + (h - pad - 10) * (1 - weeks[k] / max);
          return { x: x, y: y };
        });
        U.drawLine(svg, pts, s.color, 1.5);
        pts.forEach(function (p) { U.drawDot(svg, p.x, p.y, 2, s.color); });
        U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10,
                   [wk[0], wk[wk.length - 1]], c);
        block.appendChild(svg);
        container.appendChild(block);
      });
      if (!rendered) U.empty(container, "Not enough data for a weekly trend yet.");
    },
  });

  function isoWeekKey(date) {
    // ISO-8601 week number, matching Python's isocalendar().
    var d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    var dayNum = (d.getUTCDay() + 6) % 7;
    d.setUTCDate(d.getUTCDate() - dayNum + 3);
    var firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    var week = 1 + Math.round(
      ((d - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
    return d.getUTCFullYear() + "-W" + (week < 10 ? "0" + week : week);
  }

  CHARTS.push({
    id: "tag-heatmap",
    panel: "tags",
    title: "Per-tag activity",
    render: function (container, entries, sections, c) {
      var tagSecs = U.tagSections(sections);
      var dates = uniqueDates(entries);
      if (!dates.length) { U.empty(container, "No entries in this range."); return; }
      var rendered = false;
      tagSecs.forEach(function (s) {
        var freq = sectionTagFreq(entries, s.id);
        var tags = Object.keys(freq).sort();
        if (!tags.length) return;
        rendered = true;
        var block = document.createElement("div");
        block.className = "section-block";
        var h4 = document.createElement("h4");
        h4.textContent = s.name;
        block.appendChild(h4);
        // rows = tags, cols = dates; cell filled (section color) if tag present that day.
        var byDate = {};
        entries.forEach(function (e) { byDate[e.date] = tagsForSectionEntry(e, s.id); });
        var cell = 14, gap = 3, labelW = 90;
        var w = labelW + dates.length * (cell + gap);
        var h = tags.length * (cell + gap);
        var svg = U.svgFixed(w, h);
        tags.forEach(function (t, r) {
          U.text(svg, labelW - 6, r * (cell + gap) + cell - 2, t, c.text,
                 { anchor: "end", size: 10 });
          dates.forEach(function (d, col) {
            var on = (byDate[d] || []).indexOf(t) !== -1;
            svg.appendChild(U.svgEl("rect", {
              x: labelW + col * (cell + gap), y: r * (cell + gap),
              width: cell, height: cell, rx: 2, class: "heat-cell",
              fill: on ? s.color : U.colorMix(c.muted, 16),
            }));
          });
        });
        block.appendChild(svg);
        container.appendChild(block);
      });
      if (!rendered) U.empty(container, "No tags recorded in this range.");
    },
  });

  CHARTS.push({
    id: "tag-cooccurrence",
    panel: "tags",
    title: "Tag co-occurrence",
    render: function (container, entries, sections, c) {
      var tagSecs = U.tagSections(sections);
      var rendered = false;
      tagSecs.forEach(function (s) {
        // Build co-occurrence within this section.
        var co = {};
        var tagSet = {};
        entries.forEach(function (e) {
          var tags = Array.from(new Set(tagsForSectionEntry(e, s.id))).sort();
          tags.forEach(function (a) {
            tagSet[a] = true;
            tags.forEach(function (b) {
              if (a === b) return;
              co[a] = co[a] || {};
              co[a][b] = (co[a][b] || 0) + 1;
            });
          });
        });
        var tags = Object.keys(tagSet).sort();
        if (tags.length < 2) return;
        rendered = true;
        var block = document.createElement("div");
        block.className = "section-block";
        var h4 = document.createElement("h4");
        h4.textContent = s.name;
        block.appendChild(h4);
        var table = document.createElement("table");
        table.className = "matrix-table";
        var thead = document.createElement("tr");
        thead.appendChild(document.createElement("th"));
        tags.forEach(function (t) {
          var th = document.createElement("th"); th.textContent = t; thead.appendChild(th);
        });
        table.appendChild(thead);
        tags.forEach(function (a) {
          var tr = document.createElement("tr");
          var rh = document.createElement("th"); rh.textContent = a; tr.appendChild(rh);
          tags.forEach(function (b) {
            var td = document.createElement("td");
            if (a === b) { td.textContent = "·"; td.style.color = c.muted; }
            else {
              var n = (co[a] && co[a][b]) || 0;
              td.textContent = n || "";
              if (n) td.style.background = U.colorMix(s.color, Math.min(80, 20 + n * 20));
            }
            tr.appendChild(td);
          });
          table.appendChild(tr);
        });
        block.appendChild(table);
        container.appendChild(block);
      });
      if (!rendered) U.empty(container, "Need a section with 2+ co-occurring tags.");
    },
  });

  // ===================== Numeric & Coverage charts ========================= //

  function numericSeries(entries, sid) {
    return entries
      .filter(function (e) { return (e.numbers || {})[sid] != null; })
      .map(function (e) { return { date: e.date, value: Number(e.numbers[sid]) }; })
      .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
  }
  function rollingAvg(values, win) {
    return values.map(function (_, i) {
      var s = Math.max(0, i - win + 1);
      var slice = values.slice(s, i + 1);
      return slice.reduce(function (a, b) { return a + b; }, 0) / slice.length;
    });
  }
  // Whole days from a date-sorted series' first date to series[i].date.
  function dayIndex(series, i) {
    return dayDiff(series[0].date, series[i].date);
  }
  // Least-squares fit of value vs day-index. Mirrors journal.numeric_regression.
  // Returns {slope, intercept} (units/day) or null when undefined.
  function linearRegression(series) {
    var n = series.length;
    if (n < 2) return null;
    var xs = series.map(function (_, i) { return dayIndex(series, i); });
    var ys = series.map(function (p) { return p.value; });
    var mx = xs.reduce(function (a, b) { return a + b; }, 0) / n;
    var my = ys.reduce(function (a, b) { return a + b; }, 0) / n;
    var sxx = 0, sxy = 0;
    for (var i = 0; i < n; i++) {
      sxx += (xs[i] - mx) * (xs[i] - mx);
      sxy += (xs[i] - mx) * (ys[i] - my);
    }
    if (sxx === 0) return null;
    var slope = sxy / sxx;
    return { slope: slope, intercept: my - slope * mx };
  }

  // Per-section overview stat cards: mean / median / std / min / max / latest /
  // count. One labelled group per numeric section, using the shared .stat-cards.
  CHARTS.push({
    id: "numeric-stat-cards",
    panel: "numeric",
    title: "At a glance",
    render: function (container, entries, sections, c) {
      var nums = U.numericSections(sections);
      if (!nums.length) { U.empty(container, "No numeric sections."); return; }
      var rendered = false;
      nums.forEach(function (s) {
        var series = numericSeries(entries, s.id);
        if (!series.length) return;
        rendered = true;
        var block = document.createElement("div");
        block.className = "section-block";
        var h4 = document.createElement("h4");
        h4.textContent = s.name + (s.unit ? " (" + s.unit + ")" : "");
        block.appendChild(h4);
        var vals = series.map(function (p) { return p.value; });
        var d = U.describe(vals);
        var grid = document.createElement("div");
        grid.className = "stat-cards";
        var unit = s.unit ? " " + s.unit : "";
        statCard(grid, U.fmt(d.mean), "mean", "median " + U.fmt(d.median));
        statCard(grid, U.fmt(d.stdev), "std dev", null);
        statCard(grid, U.fmt(d.min), "min", "max " + U.fmt(d.max));
        statCard(grid, U.fmt(series[series.length - 1].value) + unit, "latest",
                 series[series.length - 1].date);
        statCard(grid, d.count, "data points", null);
        block.appendChild(grid);
        container.appendChild(block);
      });
      if (!rendered) U.empty(container, "No numeric values in this range.");
    },
  });

  CHARTS.push({
    id: "numeric-line",
    panel: "numeric",
    title: "Numeric values over time",
    render: function (container, entries, sections, c) {
      var nums = U.numericSections(sections);
      if (!nums.length) { U.empty(container, "No numeric sections."); return; }
      var rendered = false;
      nums.forEach(function (s) {
        var series = numericSeries(entries, s.id);
        if (!series.length) return;
        rendered = true;
        var block = document.createElement("div");
        block.className = "section-block";
        var h4 = document.createElement("h4");
        h4.textContent = s.name + (s.unit ? " (" + s.unit + ")" : "");
        block.appendChild(h4);
        var w = 600, h = 180, pad = 34;
        var svg = U.svg(w, h);
        var vals = series.map(function (p) { return p.value; });
        var max = Math.max.apply(null, vals), min = Math.min.apply(null, vals);
        var span = max - min || 1;
        U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 4, c);
        function ptAt(i, v) {
          var x = series.length === 1 ? pad + (w - pad - 10) / 2
                                      : pad + ((w - pad - 10) * i) / (series.length - 1);
          var y = 10 + (h - pad - 10) * (1 - (v - min) / span);
          return { x: x, y: y };
        }
        var pts = series.map(function (p, i) { return ptAt(i, p.value); });
        // 7-point rolling average overlay (muted).
        var roll = rollingAvg(vals, 7).map(function (v, i) { return ptAt(i, v); });
        // Least-squares trend line over day-index (units/day), drawn dashed.
        var reg = linearRegression(series);
        if (reg && series.length >= 2) {
          var firstDay = dayIndex(series, 0), lastDay = dayIndex(series, series.length - 1);
          var y0 = reg.intercept + reg.slope * firstDay;
          var y1 = reg.intercept + reg.slope * lastDay;
          var trend = U.svgEl("line", {
            x1: ptAt(0, y0).x, y1: ptAt(0, y0).y,
            x2: ptAt(series.length - 1, y1).x, y2: ptAt(series.length - 1, y1).y,
            stroke: U.colorMix(s.color, 55), "stroke-width": 1,
            "stroke-dasharray": "4 3",
          });
          svg.appendChild(trend);
        }
        U.drawLine(svg, roll, U.colorMix(c.muted, 90), 1);
        U.drawLine(svg, pts, s.color, 1.5);
        pts.forEach(function (p) { U.drawDot(svg, p.x, p.y, 2, s.color); });
        U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10,
                   [series[0].date, series[series.length - 1].date], c);
        U.text(svg, 0, 14, U.fmt(max), c.muted, { size: 9 });
        U.text(svg, 0, h - pad + 2, U.fmt(min), c.muted, { size: 9 });
        block.appendChild(svg);
        var d = U.describe(vals);
        var trendLabel = null;
        if (reg) {
          var perDay = reg.slope;
          var dir = Math.abs(perDay) < 1e-9 ? "flat"
                    : (perDay > 0 ? "▲ rising" : "▼ falling");
          trendLabel = dir + " " + U.fmt(Math.abs(perDay)) + "/day";
        }
        U.statsRow(block, [
          ["mean", U.fmt(d.mean)], ["median", U.fmt(d.median)],
          ["mode", U.fmt(d.mode)], ["std dev", U.fmt(d.stdev)],
          ["min", U.fmt(d.min)], ["max", U.fmt(d.max)],
          ["trend", trendLabel],
        ]);
        container.appendChild(block);
      });
      if (!rendered) U.empty(container, "No numeric values in this range.");
    },
  });

  // Cumulative total over time (running sum of date-sorted values).
  CHARTS.push({
    id: "numeric-cumulative",
    panel: "numeric",
    title: "Cumulative total",
    render: function (container, entries, sections, c) {
      var nums = U.numericSections(sections);
      if (!nums.length) { U.empty(container, "No numeric sections."); return; }
      var rendered = false;
      nums.forEach(function (s) {
        var series = numericSeries(entries, s.id);
        if (series.length < 2) return;
        rendered = true;
        var cum = [], total = 0;
        series.forEach(function (p) { total += p.value; cum.push(total); });
        var block = document.createElement("div");
        block.className = "section-block";
        var h4 = document.createElement("h4");
        h4.textContent = s.name + (s.unit ? " (" + s.unit + ")" : "");
        block.appendChild(h4);
        var w = 600, h = 180, pad = 40;
        var svg = U.svg(w, h);
        var max = Math.max.apply(null, cum), min = Math.min.apply(null, cum.concat(0));
        var span = max - min || 1;
        U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 4, c);
        var pts = cum.map(function (v, i) {
          var x = series.length === 1 ? pad + (w - pad - 10) / 2
                                      : pad + ((w - pad - 10) * i) / (series.length - 1);
          var y = 10 + (h - pad - 10) * (1 - (v - min) / span);
          return { x: x, y: y };
        });
        U.drawLine(svg, pts, s.color, 1.5);
        U.drawDot(svg, pts[pts.length - 1].x, pts[pts.length - 1].y, 2.5, s.color);
        U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10,
                   [series[0].date, series[series.length - 1].date], c);
        U.text(svg, 0, 14, U.fmt(max), c.muted, { size: 9 });
        block.appendChild(svg);
        U.statsRow(block, [["total", U.fmt(total) + (s.unit ? " " + s.unit : "")]]);
        container.appendChild(block);
      });
      if (!rendered) U.empty(container, "Need 2+ values per section for a cumulative line.");
    },
  });

  // Period-over-period delta: this window vs the immediately preceding window
  // of equal length. Mirrors journal.numeric_period_delta (JS-side compute).
  CHARTS.push({
    id: "numeric-period-delta",
    panel: "numeric",
    title: "This period vs. previous",
    render: function (container, entries, sections, c) {
      var nums = U.numericSections(sections);
      if (!nums.length) { U.empty(container, "No numeric sections."); return; }
      if (!_from || !_to) {
        U.empty(container, "Set a date range to compare against the previous period.");
        return;
      }
      function meanIn(sid, a, b) {
        var vs = _data.entries.filter(function (e) {
          return e.date >= a && e.date <= b && (e.numbers || {})[sid] != null;
        }).map(function (e) { return Number(e.numbers[sid]); });
        return vs.length ? vs.reduce(function (x, y) { return x + y; }, 0) / vs.length : null;
      }
      var len = dayDiff(_from, _to);  // window length in days
      var prevEnd = isoShift(_from, -1);
      var prevStart = isoShift(prevEnd, -len);
      var grid = document.createElement("div");
      grid.className = "stat-cards";
      var rendered = false;
      nums.forEach(function (s) {
        var cur = meanIn(s.id, _from, _to);
        var prev = meanIn(s.id, prevStart, prevEnd);
        if (cur == null && prev == null) return;
        rendered = true;
        var sub;
        if (cur != null && prev != null) {
          var delta = cur - prev;
          var arrow = Math.abs(delta) < 1e-9 ? "→" : (delta > 0 ? "▲" : "▼");
          var pct = prev ? "  " + (delta > 0 ? "+" : "") + U.fmt(delta / prev * 100) + "%" : "";
          sub = arrow + " " + (delta > 0 ? "+" : "") + U.fmt(delta) + " vs prev" + pct;
        } else {
          sub = cur == null ? "no current data" : "no prior data";
        }
        statCard(grid, cur == null ? null : U.fmt(cur) + (s.unit ? " " + s.unit : ""),
                 s.name, sub);
      });
      if (!rendered) { U.empty(container, "No values in this window or the previous one."); return; }
      container.appendChild(grid);
      U.statsRow(container, [["previous window", prevStart + " → " + prevEnd]]);
    },
  });

  // Distribution histogram per section (mirrors journal.numeric_histogram).
  CHARTS.push({
    id: "numeric-histogram",
    panel: "numeric",
    title: "Distribution",
    render: function (container, entries, sections, c) {
      var nums = U.numericSections(sections);
      if (!nums.length) { U.empty(container, "No numeric sections."); return; }
      var rendered = false;
      nums.forEach(function (s) {
        var vals = numericSeries(entries, s.id).map(function (p) { return p.value; });
        if (vals.length < 2) return;
        var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
        rendered = true;
        var block = document.createElement("div");
        block.className = "section-block";
        var h4 = document.createElement("h4");
        h4.textContent = s.name + (s.unit ? " (" + s.unit + ")" : "");
        block.appendChild(h4);
        // Bucket spanning min..max (single bucket when all values are equal).
        var bins = Math.min(10, Math.max(4, Math.round(Math.sqrt(vals.length))));
        var buckets;
        if (max === min) {
          buckets = [{ lo: min, hi: max, count: vals.length }];
        } else {
          var width = (max - min) / bins;
          buckets = [];
          for (var b = 0; b < bins; b++) {
            buckets.push({ lo: min + b * width, hi: min + (b + 1) * width, count: 0 });
          }
          vals.forEach(function (v) {
            var idx = Math.floor((v - min) / width);
            if (idx >= bins) idx = bins - 1;
            buckets[idx].count++;
          });
        }
        var w = 600, h = 196, pad = 30, chartH = 140;
        var svg = U.svg(w, h);
        var cmax = Math.max.apply(null, buckets.map(function (bk) { return bk.count; })) || 1;
        var bw = (w - pad - 10) / buckets.length;
        buckets.forEach(function (bk, i) {
          var bh = chartH * (bk.count / cmax);
          U.drawBar(svg, pad + i * bw + 2, 10 + chartH - bh, bw - 4, bh, s.color);
          if (bk.count) {
            U.text(svg, pad + i * bw + bw / 2, 10 + chartH - bh - 3,
                   String(bk.count), c.muted, { anchor: "middle", size: 9 });
          }
        });
        U.drawAxis(svg, pad, 10, w - pad - 10, chartH,
                   [U.fmt(min), U.fmt(max)], c, s.unit || s.name);
        block.appendChild(svg);
        container.appendChild(block);
      });
      if (!rendered) U.empty(container, "Need 2+ values per section for a distribution.");
    },
  });

  // Calendar heatmap per section: each day shaded dark -> section color by value
  // (reuses the month-grid pattern from the consistency/mood calendars).
  CHARTS.push({
    id: "numeric-calendar",
    panel: "numeric",
    title: "Calendar heatmap",
    render: function (container, entries, sections, c) {
      var nums = U.numericSections(sections);
      if (!nums.length) { U.empty(container, "No numeric sections."); return; }
      var now = new Date();
      var todayIso = calIso(now.getFullYear(), now.getMonth(), now.getDate());
      var rendered = false;
      nums.forEach(function (s) {
        var series = numericSeries(entries, s.id);
        if (!series.length) return;
        rendered = true;
        var byDate = {};
        series.forEach(function (p) { byDate[p.date] = p.value; });
        var vals = series.map(function (p) { return p.value; });
        var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
        var span = max - min || 1;
        var block = document.createElement("div");
        block.className = "section-block";
        var h4 = document.createElement("h4");
        h4.textContent = s.name + (s.unit ? " (" + s.unit + ")" : "");
        block.appendChild(h4);
        var first = new Date(series[0].date + "T00:00:00");
        var last = new Date(series[series.length - 1].date + "T00:00:00");
        var wrap = document.createElement("div");
        wrap.className = "analytics-cal";
        var y = first.getFullYear(), m = first.getMonth();
        while (y < last.getFullYear() || (y === last.getFullYear() && m <= last.getMonth())) {
          wrap.appendChild(buildValueMonthGrid(y, m, byDate, min, span, s.color, todayIso));
          m++;
          if (m > 11) { m = 0; y++; }
        }
        block.appendChild(wrap);
        // Legend: low -> high gradient.
        var legend = U.svg(600, 24);
        U.text(legend, 0, 14, "low", c.muted, { size: 9 });
        [0.15, 0.4, 0.65, 0.9].forEach(function (frac, i) {
          legend.appendChild(U.svgEl("rect", {
            x: 28 + i * 18, y: 5, width: 16, height: 14, rx: 2,
            fill: U.colorMix(s.color, Math.round(15 + frac * 85)),
          }));
        });
        U.text(legend, 28 + 4 * 18 + 4, 14, "high", c.muted, { size: 9 });
        block.appendChild(legend);
        container.appendChild(block);
      });
      if (!rendered) U.empty(container, "No numeric values in this range.");
    },
  });

  CHARTS.push({
    id: "numeric-dow",
    panel: "numeric",
    title: "Average by day of week",
    render: function (container, entries, sections, c) {
      var nums = U.numericSections(sections);
      var names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
      var rendered = false;
      nums.forEach(function (s) {
        var buckets = [[], [], [], [], [], [], []];
        entries.forEach(function (e) {
          var v = (e.numbers || {})[s.id];
          if (v == null) return;
          var dow = (new Date(e.date + "T00:00:00").getDay() + 6) % 7;
          buckets[dow].push(Number(v));
        });
        var avgs = buckets.map(function (b) {
          return b.length ? b.reduce(function (a, x) { return a + x; }, 0) / b.length : null;
        });
        if (avgs.every(function (a) { return a == null; })) return;
        rendered = true;
        var block = document.createElement("div");
        block.className = "section-block";
        var h4 = document.createElement("h4");
        h4.textContent = s.name + (s.unit ? " (" + s.unit + ")" : "");
        block.appendChild(h4);
        var w = 600, h = 180, pad = 30;
        var svg = U.svg(w, h);
        var present = avgs.filter(function (a) { return a != null; });
        var max = Math.max.apply(null, present), min = Math.min.apply(null, present.concat(0));
        var bw = (w - pad - 10) / 7;
        avgs.forEach(function (a, i) {
          if (a == null) return;
          var bh = (h - pad - 10) * ((a - Math.min(0, min)) / ((max - Math.min(0, min)) || 1));
          U.drawBar(svg, pad + i * bw + 3, 10 + (h - pad - 10) - bh, bw - 6, bh, s.color);
        });
        U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10, names, c);
        block.appendChild(svg);
        // highest / lowest day.
        var ranked = names
          .map(function (n, i) { return [n, avgs[i]]; })
          .filter(function (p) { return p[1] != null; })
          .sort(function (a, b) { return b[1] - a[1]; });
        U.statsRow(block, [
          ["highest", ranked[0][0] + " (" + U.fmt(ranked[0][1]) + ")"],
          ["lowest", ranked[ranked.length - 1][0] + " (" + U.fmt(ranked[ranked.length - 1][1]) + ")"],
        ]);
        container.appendChild(block);
      });
      if (!rendered) U.empty(container, "No numeric values in this range.");
    },
  });

  CHARTS.push({
    id: "numeric-scatter",
    panel: "numeric",
    title: "Correlation between two numeric sections",
    render: function (container, entries, sections, c) {
      var nums = U.numericSections(sections);
      if (nums.length < 2) { U.empty(container, "Need two numeric sections to correlate."); return; }
      var sx = nums[0], sy = nums[1];
      var pairs = entries.filter(function (e) {
        return (e.numbers || {})[sx.id] != null && (e.numbers || {})[sy.id] != null;
      }).map(function (e) {
        return { x: Number(e.numbers[sx.id]), y: Number(e.numbers[sy.id]) };
      });
      if (!pairs.length) { U.empty(container, "No days with both values recorded."); return; }
      var w = 600, h = 240, pad = 36;
      var svg = U.svg(w, h);
      var xs = pairs.map(function (p) { return p.x; }), ys = pairs.map(function (p) { return p.y; });
      var xMin = Math.min.apply(null, xs), xMax = Math.max.apply(null, xs);
      var yMin = Math.min.apply(null, ys), yMax = Math.max.apply(null, ys);
      var xSpan = xMax - xMin || 1, ySpan = yMax - yMin || 1;
      U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 4, c);
      pairs.forEach(function (p) {
        var x = (xMax - xMin) === 0
          ? pad + (w - pad - 10) / 2
          : pad + (w - pad - 10) * ((p.x - xMin) / xSpan);
        var y = (yMax - yMin) === 0
          ? 10 + (h - pad - 10) / 2
          : 10 + (h - pad - 10) * (1 - (p.y - yMin) / ySpan);
        U.drawDot(svg, x, y, 3, U.colorMix(sx.color, 80));
      });
      U.text(svg, w / 2, h - 2, sx.name + " (x)  vs  " + sy.name + " (y)", c.muted,
             { anchor: "middle", size: 9 });
      container.appendChild(svg);
      U.statsRow(container, [["points", pairs.length]]);
    },
  });

  // Pairwise Pearson r across all numeric sections, as a tinted grid (cells
  // colored by sign/magnitude; r shown). Mirrors journal.numeric_correlation_matrix.
  CHARTS.push({
    id: "numeric-correlation-matrix",
    panel: "numeric",
    title: "Correlation matrix",
    render: function (container, entries, sections, c) {
      var nums = U.numericSections(sections);
      if (nums.length < 2) {
        U.empty(container, "Need 2+ numeric sections for a correlation matrix.");
        return;
      }
      // r[a.id][b.id] over same-day overlapping pairs (n>=2).
      var R = {};
      nums.forEach(function (a) {
        R[a.id] = {};
        nums.forEach(function (b) {
          if (a.id === b.id) { R[a.id][b.id] = 1; return; }
          var xs = [], ys = [];
          entries.forEach(function (e) {
            var n = e.numbers || {};
            if (n[a.id] != null && n[b.id] != null) {
              xs.push(Number(n[a.id])); ys.push(Number(n[b.id]));
            }
          });
          R[a.id][b.id] = pearson(xs, ys);  // null when undefined
        });
      });
      var any = false;
      nums.forEach(function (a) {
        nums.forEach(function (b) {
          if (a.id !== b.id && R[a.id][b.id] != null) any = true;
        });
      });
      if (!any) { U.empty(container, "No section pairs share enough days."); return; }
      var table = document.createElement("table");
      table.className = "matrix-table";
      var thead = document.createElement("tr");
      thead.appendChild(document.createElement("th"));
      nums.forEach(function (s) {
        var th = document.createElement("th"); th.textContent = s.name; thead.appendChild(th);
      });
      table.appendChild(thead);
      nums.forEach(function (a) {
        var tr = document.createElement("tr");
        var rh = document.createElement("th"); rh.textContent = a.name; tr.appendChild(rh);
        nums.forEach(function (b) {
          var td = document.createElement("td");
          var r = R[a.id][b.id];
          if (a.id === b.id) { td.textContent = "1"; td.style.color = c.muted; }
          else if (r == null) { td.textContent = "·"; td.style.color = c.muted; }
          else {
            td.textContent = (r > 0 ? "+" : "") + U.fmt(r);
            // Positive r -> accent tint, negative -> danger tint, by magnitude.
            var tint = Math.min(80, 15 + Math.abs(r) * 70);
            td.style.background = U.colorMix(r >= 0 ? c.accent : c.danger, tint);
          }
          tr.appendChild(td);
        });
        table.appendChild(tr);
      });
      container.appendChild(table);
      U.statsRow(container, [["+ = move together", ""], ["− = move opposite", ""]]);
    },
  });

  // Streaks relative to the section mean (longest above / below; current run).
  // Mirrors journal.numeric_streaks (above means value >= mean).
  CHARTS.push({
    id: "numeric-streaks",
    panel: "numeric",
    title: "Above / below average streaks",
    render: function (container, entries, sections, c) {
      var nums = U.numericSections(sections);
      if (!nums.length) { U.empty(container, "No numeric sections."); return; }
      var rendered = false;
      nums.forEach(function (s) {
        var series = numericSeries(entries, s.id);
        if (series.length < 2) return;
        rendered = true;
        var vals = series.map(function (p) { return p.value; });
        var mean = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
        var flags = vals.map(function (v) { return v >= mean; });
        var above = 0, below = 0, run = 0;
        flags.forEach(function (f, i) {
          run = (i && flags[i] === flags[i - 1]) ? run + 1 : 1;
          if (f) above = Math.max(above, run); else below = Math.max(below, run);
        });
        var cur = 1;
        for (var i = flags.length - 1; i > 0; i--) {
          if (flags[i] === flags[i - 1]) cur++; else break;
        }
        var block = document.createElement("div");
        block.className = "section-block";
        var h4 = document.createElement("h4");
        h4.textContent = s.name + (s.unit ? " (" + s.unit + ")" : "");
        block.appendChild(h4);
        var box = document.createElement("div");
        box.className = "callout";
        var big = document.createElement("div");
        big.className = "callout-big";
        big.textContent = "Currently " + cur + " day" + (cur === 1 ? "" : "s") + " " +
                          (flags[flags.length - 1] ? "above" : "below") + " average";
        box.appendChild(big);
        block.appendChild(box);
        U.statsRow(block, [
          ["mean", U.fmt(mean) + (s.unit ? " " + s.unit : "")],
          ["longest above", above + "d"], ["longest below", below + "d"],
        ]);
        container.appendChild(block);
      });
      if (!rendered) U.empty(container, "Need 2+ values per section for streaks.");
    },
  });

  // Coverage: how often each numeric value is recorded among entries in range.
  // Mirrors journal.numeric_coverage.
  CHARTS.push({
    id: "numeric-coverage",
    panel: "numeric",
    title: "How often each number is logged",
    render: function (container, entries, sections, c) {
      var nums = U.numericSections(sections);
      if (!nums.length) { U.empty(container, "No numeric sections."); return; }
      var total = entries.length;
      if (!total) { U.empty(container, "No entries in this range."); return; }
      var rows = nums.map(function (s) {
        var logged = entries.filter(function (e) {
          return (e.numbers || {})[s.id] != null;
        }).length;
        return { name: s.name, color: s.color, logged: logged,
                 pct: total ? (logged / total) * 100 : 0 };
      });
      var w = 600, rowH = 22, pad = 100;
      var svg = U.svg(w, rows.length * rowH + 6);
      rows.forEach(function (r, i) {
        var y = i * rowH + 2;
        U.text(svg, pad - 6, y + 14, r.name, c.text, { anchor: "end", size: 10 });
        U.drawBar(svg, pad, y + 4, (w - pad - 60), 13, U.colorMix(c.muted, 16));
        U.drawBar(svg, pad, y + 4, (w - pad - 60) * (r.pct / 100), 13, r.color);
        U.text(svg, pad + (w - pad - 60) + 4, y + 14,
               Math.round(r.pct) + "% (" + r.logged + "/" + total + ")",
               c.muted, { size: 9 });
      });
      container.appendChild(svg);
    },
  });

  CHARTS.push({
    id: "section-coverage",
    panel: "coverage",
    title: "Section coverage per entry",
    render: function (container, entries, sections, c) {
      if (!entries.length) { U.empty(container, "No entries in this range."); return; }
      var sorted = entries.slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });
      var cell = 14, gap = 3, labelW = 90;
      var w = labelW + sorted.length * (cell + gap);
      var h = sections.length * (cell + gap);
      var svg = U.svgFixed(w, h);
      var coveredCounts = [];
      sections.forEach(function (s, r) {
        U.text(svg, labelW - 6, r * (cell + gap) + cell - 2, s.name, c.text,
               { anchor: "end", size: 10 });
        sorted.forEach(function (e, col) {
          var t = (e.tags || {})[s.id];
          var on = (t && t.length) || (e.numbers || {})[s.id] != null;
          svg.appendChild(U.svgEl("rect", {
            x: labelW + col * (cell + gap), y: r * (cell + gap),
            width: cell, height: cell, rx: 2, class: "heat-cell",
            fill: on ? s.color : U.colorMix(c.muted, 16),
          }));
        });
      });
      sorted.forEach(function (e) {
        var n = 0;
        sections.forEach(function (s) {
          var t = (e.tags || {})[s.id];
          if ((t && t.length) || (e.numbers || {})[s.id] != null) n++;
        });
        coveredCounts.push(n);
      });
      container.appendChild(svg);
      var pct = sections.length
        ? U.describe(coveredCounts.map(function (n) { return (n / sections.length) * 100; })).mean
        : null;
      U.statsRow(container, [["mean sections filled", pct != null ? U.fmt(pct) + "%" : null]]);
    },
  });

  // ===================== Tasks charts ===================================== //

  // --- Tasks: completion throughput ---
  CHARTS.push({
    id: "task-throughput", panel: "throughput", title: "Tasks completed per day",
    render: function (container, entries, sections, c) {
      var byDay = taskThroughput();
      var days = Object.keys(byDay).sort();
      if (!days.length) { U.empty(container, "No completed tasks in this range."); return; }
      var w = 600, h = 160, pad = 28;
      var svg = U.svg(w, h);
      var max = Math.max.apply(null, days.map(function (d) { return byDay[d]; }));
      var bw = (w - pad) / days.length;
      days.forEach(function (d, i) {
        var bh = (h - pad) * (byDay[d] / max);
        U.drawBar(svg, pad + i * bw, h - pad - bh, Math.max(bw - 2, 1), bh, c.accent);
      });
      container.appendChild(svg);
      var vals = days.map(function (d) { return byDay[d]; });
      var stat = U.describe(vals);
      U.statsRow(container, [["total", vals.reduce(function (a, b) { return a + b; }, 0)],
                             ["best day", stat.max], ["mean/day", U.fmt(stat.mean)]]);
    },
  });

  // --- Tasks: overdue (completed late) + expiry ---
  CHARTS.push({
    id: "task-overdue", panel: "timeliness", title: "On-time vs late & expired",
    render: function (container, entries, sections, c) {
      var t = _data.tasks || { archive: [], expired: [] };
      function inR(d) { return d && (!_from || d >= _from) && (!_to || d <= _to); }
      var late = 0, ontime = 0, expired = 0;
      t.archive.forEach(function (x) {
        if (!x.completed || !x.due) return;
        if (!inR(x.completed.slice(0, 10))) return;
        if (x.completed > x.due) late++; else ontime++;
      });
      t.expired.forEach(function (x) {
        if (inR((x.expired_at || "").slice(0, 10))) expired++;
      });
      if (!(late + ontime + expired)) { U.empty(container, "No due/expired tasks in this range."); return; }
      U.statsRow(container, [["on time", ontime], ["late", late], ["expired", expired]]);
      // simple stacked bar
      var w = 600, h = 40, total = late + ontime + expired, x = 0;
      var svg = U.svg(w, h);
      [["on time", ontime, c.accent], ["late", late, c.danger],
       ["expired", expired, c.muted]].forEach(function (seg) {
        var sw = (w) * (seg[1] / total);
        if (sw > 0) { U.drawBar(svg, x, 8, sw, 20, seg[2]); x += sw; }
      });
      container.appendChild(svg);
    },
  });

  // --- Tasks: recurring adherence ---
  CHARTS.push({
    id: "task-adherence", panel: "adherence", title: "Recurring-task adherence",
    render: function (container, entries, sections, c) {
      var t = _data.tasks || { archive: [], expired: [] };
      function inR(d) { return d && (!_from || d >= _from) && (!_to || d <= _to); }
      var done = t.archive.filter(function (x) {
        return x.recurrence && inR((x.completed || "").slice(0, 10)); }).length;
      var missed = t.expired.filter(function (x) {
        return x.recurrence && inR((x.expired_at || "").slice(0, 10)); }).length;
      var total = done + missed;
      if (!total) { U.empty(container, "No recurring occurrences in this range."); return; }
      var rate = Math.round((done / total) * 100);
      U.statsRow(container, [["completed", done], ["missed", missed], ["hit rate", rate + "%"]]);
      var w = 600, svg = U.svg(w, 40);
      U.drawBar(svg, 0, 8, w * (done / total), 20, c.accent);
      U.drawBar(svg, w * (done / total), 8, w * (missed / total), 20, c.danger);
      container.appendChild(svg);
    },
  });

  // --- Tasks: difficulty breakdown ---
  CHARTS.push({
    id: "task-difficulty", panel: "difficulty", title: "Difficulty of completed tasks",
    render: function (container, entries, sections, c) {
      var t = _data.tasks || { archive: [] };
      function inR(d) { return d && (!_from || d >= _from) && (!_to || d <= _to); }
      var counts = { easy: 0, medium: 0, hard: 0, unrated: 0 };
      t.archive.forEach(function (x) {
        if (!inR((x.completed || "").slice(0, 10))) return;
        counts[(x.difficulty) || "unrated"]++;
      });
      var order = ["easy", "medium", "hard", "unrated"];
      var max = Math.max.apply(null, order.map(function (k) { return counts[k]; }));
      if (!max) { U.empty(container, "No completed tasks in this range."); return; }
      var w = 600, rowH = 22, svg = U.svg(w, order.length * rowH + 4);
      order.forEach(function (k, i) {
        var y = i * rowH + 2;
        U.text(svg, 70 - 6, y + 14, k, c.text, { anchor: "end", size: 10 });
        var bw = (w - 110) * (counts[k] / max);
        U.drawBar(svg, 70, y + 4, bw, 13, k === "hard" ? c.danger : c.accent);
        U.text(svg, 70 + bw + 4, y + 14, counts[k], c.muted, { size: 9 });
      });
      container.appendChild(svg);
    },
  });

  // --- Tags (task-side): task-tag frequency ---
  // Lives in the merged cross-domain "Tags" tab (panel "tags"), after the
  // journal tag charts. Renders its U.empty(...) state when there are no tasks.
  CHARTS.push({
    id: "task-tag-frequency", panel: "tags", title: "Task tag frequency",
    render: function (container, entries, sections, c) {
      var t = _data.tasks || { archive: [], active: [], expired: [], tags: {} };
      function inR(d) { return !d || ((!_from || d >= _from) && (!_to || d <= _to)); }
      var freq = {};
      t.archive.forEach(function (x) {
        if (!inR((x.completed || "").slice(0, 10))) return;
        (x.tags || []).forEach(function (tag) { freq[tag] = (freq[tag] || 0) + 1; });
      });
      var keys = Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; });
      if (!keys.length) { U.empty(container, "No task tags in this range."); return; }
      var w = 600, rowH = 18, pad = 90, svg = U.svg(w, keys.length * rowH + 6);
      var max = Math.max.apply(null, keys.map(function (k) { return freq[k]; }));
      keys.forEach(function (k, i) {
        var y = i * rowH + 2;
        var col = (t.tags && t.tags[k]) || c.accent;
        U.text(svg, pad - 6, y + 12, k, c.text, { anchor: "end", size: 10 });
        var bw = (w - pad - 30) * (freq[k] / max);
        U.drawBar(svg, pad, y + 3, bw, 11, col);
        U.text(svg, pad + bw + 4, y + 12, freq[k], c.muted, { size: 9 });
      });
      container.appendChild(svg);
    },
  });

  // --- Tasks: tasks completed vs. a journal numeric (scatter) ---
  // Mirrors the `numeric-scatter` chart (min/max axis + U.drawDot), but with
  // one small-multiple per numeric section (like `numeric-line`/`tag-frequency`
  // iterate). x = that day's completed-task count; y = the journal numeric.
  CHARTS.push({
    id: "task-numeric-scatter", panel: "timeliness",
    title: "Tasks completed vs. journal number",
    render: function (container, entries, sections, c) {
      var nums = U.numericSections(sections);
      if (!nums.length) { U.empty(container, "No numeric sections."); return; }
      var byDay = taskThroughput();  // {date: count}, already date-filtered
      var rendered = false;
      nums.forEach(function (s) {
        // Per-day pairs: y from the day's journal value, x from completions.
        var pairs = entries.filter(function (e) {
          return (e.numbers || {})[s.id] != null;
        }).map(function (e) {
          return { x: byDay[e.date] || 0, y: Number(e.numbers[s.id]) };
        });
        if (pairs.length < 2) return;
        rendered = true;
        var block = document.createElement("div");
        block.className = "section-block";
        var h4 = document.createElement("h4");
        h4.textContent = s.name + (s.unit ? " (" + s.unit + ")" : "");
        block.appendChild(h4);
        var w = 600, h = 240, pad = 36;
        var svg = U.svg(w, h);
        var xs = pairs.map(function (p) { return p.x; });
        var ys = pairs.map(function (p) { return p.y; });
        var xMin = Math.min.apply(null, xs), xMax = Math.max.apply(null, xs);
        var yMin = Math.min.apply(null, ys), yMax = Math.max.apply(null, ys);
        var xSpan = xMax - xMin || 1, ySpan = yMax - yMin || 1;
        U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 4, c);
        pairs.forEach(function (p) {
          var x = (xMax - xMin) === 0
            ? pad + (w - pad - 10) / 2
            : pad + (w - pad - 10) * ((p.x - xMin) / xSpan);
          var y = (yMax - yMin) === 0
            ? 10 + (h - pad - 10) / 2
            : 10 + (h - pad - 10) * (1 - (p.y - yMin) / ySpan);
          U.drawDot(svg, x, y, 3, U.colorMix(s.color, 80));
        });
        U.text(svg, w / 2, h - 2, "tasks completed (x)  vs  " + s.name + " (y)",
               c.muted, { anchor: "middle", size: 9 });
        block.appendChild(svg);
        U.statsRow(block, [["points", pairs.length]]);
        container.appendChild(block);
      });
      if (!rendered) {
        U.empty(container, "Need 2+ days with both a journal number and a known task-completion count.");
      }
    },
  });

  // --- Tasks: entry-day vs. task-completion-day calendar overlay ---
  // Mirrors `calendar-heatmap` + buildMonthGrid; entry days get the standard
  // amber dot (present), task-completion days get an offset --accent-dim dot.
  CHARTS.push({
    id: "task-entry-calendar", panel: "throughput", title: "Entries & task completions",
    render: function (container, entries, sections, c) {
      var present = {};
      uniqueDates(entries).forEach(function (d) { present[d] = true; });
      var done = taskThroughput();  // {date: count}, already date-filtered
      var entryDates = Object.keys(present);
      var doneDates = Object.keys(done);
      if (!entryDates.length && !doneDates.length) {
        U.empty(container, "No entries or task completions in this range.");
        return;
      }
      var now = new Date();
      var todayIso = calIso(now.getFullYear(), now.getMonth(), now.getDate());

      // Span every calendar month between the earliest and latest marked day.
      var all = entryDates.concat(doneDates).sort();
      var first = new Date(all[0] + "T00:00:00");
      var last = new Date(all[all.length - 1] + "T00:00:00");
      var wrap = document.createElement("div");
      wrap.className = "analytics-cal";
      var y = first.getFullYear(), m = first.getMonth();
      while (y < last.getFullYear() || (y === last.getFullYear() && m <= last.getMonth())) {
        wrap.appendChild(buildMonthGrid(y, m, present, todayIso, done));
        m++;
        if (m > 11) { m = 0; y++; }
      }
      container.appendChild(wrap);
      // Legend: which dot means what.
      var legend = U.svg(600, 22);
      U.drawDot(legend, 8, 11, 4, c.accent);
      U.text(legend, 18, 14, "journal entry", c.muted, { size: 9 });
      U.drawDot(legend, 120, 11, 4, c.accentDim);
      U.text(legend, 130, 14, "task completed", c.muted, { size: 9 });
      container.appendChild(legend);
      U.statsRow(container, [["entry days", entryDates.length],
                             ["completion days", doneDates.length]]);
    },
  });

  // ===================== Mood charts ====================================== //
  // Mood is an int 1..7 or null; every mood reader skips nulls. JS mirrors the
  // pure helpers in journal.py (mood_series / mood_dow_averages /
  // mood_distribution / mood_by_date / mood_numeric_pairs).

  var DOW_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  function moodOf(e) {
    var m = e.mood;
    return (m == null) ? null : Number(m);
  }
  function moodSeries(entries) {
    return entries
      .filter(function (e) { return moodOf(e) != null; })
      .map(function (e) { return { date: e.date, mood: moodOf(e) }; })
      .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
  }
  function moodByDate(entries) {
    var out = {};
    entries.forEach(function (e) { var m = moodOf(e); if (m != null) out[e.date] = m; });
    return out;
  }

  CHARTS.push({
    id: "mood-over-time", panel: "mood", title: "Mood over time",
    render: function (container, entries, sections, c) {
      var series = moodSeries(entries);
      if (!series.length) { U.empty(container, "No mood recorded in this range."); return; }
      var w = 600, h = 180, pad = 30;
      var svg = U.svg(w, h);
      // Fixed 1..7 scale so the chart reads as an absolute mood, not relative.
      var min = 1, max = 7, span = max - min;
      U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 6, c);
      function ptAt(i, v) {
        var x = series.length === 1 ? pad + (w - pad - 10) / 2
                                    : pad + ((w - pad - 10) * i) / (series.length - 1);
        var y = 10 + (h - pad - 10) * (1 - (v - min) / span);
        return { x: x, y: y };
      }
      var vals = series.map(function (s) { return s.mood; });
      var roll = rollingAvg(vals, 7).map(function (v, i) { return ptAt(i, v); });
      var pts = series.map(function (s, i) { return ptAt(i, s.mood); });
      U.drawLine(svg, roll, U.colorMix(c.muted, 90), 1);   // 7-day rolling avg
      U.drawLine(svg, pts, c.accent, 1.5);
      pts.forEach(function (p) { U.drawDot(svg, p.x, p.y, 2, c.accent); });
      U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10,
                 [series[0].date, series[series.length - 1].date], c);
      U.text(svg, 0, 14, "7", c.muted, { size: 9 });
      U.text(svg, 0, h - pad + 2, "1", c.muted, { size: 9 });
      container.appendChild(svg);
      var d = U.describe(vals);
      U.statsRow(container, [
        ["mean", U.fmt(d.mean)], ["median", U.fmt(d.median)],
        ["min", U.fmt(d.min)], ["max", U.fmt(d.max)],
        ["std dev", U.fmt(d.stdev)], ["days", d.count],
      ]);
    },
  });

  CHARTS.push({
    id: "mood-dow", panel: "mood", title: "Average mood by day of week",
    render: function (container, entries, sections, c) {
      var buckets = [[], [], [], [], [], [], []];
      entries.forEach(function (e) {
        var m = moodOf(e);
        if (m == null) return;
        var dow = (new Date(e.date + "T00:00:00").getDay() + 6) % 7;
        buckets[dow].push(m);
      });
      var avgs = buckets.map(function (b) {
        return b.length ? b.reduce(function (a, x) { return a + x; }, 0) / b.length : null;
      });
      if (avgs.every(function (a) { return a == null; })) {
        U.empty(container, "No mood recorded in this range."); return;
      }
      var w = 600, h = 180, pad = 30;
      var svg = U.svg(w, h);
      // Bars scaled on the fixed 1..7 mood scale.
      var min = 1, max = 7;
      U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 6, c);
      var bw = (w - pad - 10) / 7;
      avgs.forEach(function (a, i) {
        if (a == null) return;
        var bh = (h - pad - 10) * ((a - min) / (max - min));
        U.drawBar(svg, pad + i * bw + 3, 10 + (h - pad - 10) - bh, bw - 6, bh, c.accent);
      });
      U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10, DOW_NAMES, c);
      container.appendChild(svg);
      var ranked = DOW_NAMES
        .map(function (n, i) { return [n, avgs[i]]; })
        .filter(function (p) { return p[1] != null; })
        .sort(function (a, b) { return b[1] - a[1]; });
      U.statsRow(container, [
        ["best", ranked[0][0] + " (" + U.fmt(ranked[0][1]) + ")"],
        ["worst", ranked[ranked.length - 1][0] + " (" + U.fmt(ranked[ranked.length - 1][1]) + ")"],
      ]);
    },
  });

  CHARTS.push({
    id: "mood-distribution", panel: "mood", title: "Mood distribution",
    render: function (container, entries, sections, c) {
      var dist = {};
      for (var n = 1; n <= 7; n++) dist[n] = 0;
      var any = false;
      entries.forEach(function (e) {
        var m = moodOf(e);
        if (m != null && m >= 1 && m <= 7) { dist[m]++; any = true; }
      });
      if (!any) { U.empty(container, "No mood recorded in this range."); return; }
      var w = 600, h = 196, pad = 30, chartH = 140;
      var svg = U.svg(w, h);
      var keys = [1, 2, 3, 4, 5, 6, 7];
      var max = Math.max.apply(null, keys.map(function (k) { return dist[k]; })) || 1;
      var bw = (w - pad - 10) / keys.length;
      keys.forEach(function (k, i) {
        var bh = chartH * (dist[k] / max);
        U.drawBar(svg, pad + i * bw + 3, 10 + chartH - bh, bw - 6, bh, c.accent);
        U.text(svg, pad + i * bw + bw / 2, 10 + chartH - bh - 3,
               dist[k] || "", c.muted, { anchor: "middle", size: 9 });
      });
      U.drawAxis(svg, pad, 10, w - pad - 10, chartH,
                 keys.map(String), c, "mood (1–7)");
      container.appendChild(svg);
      // Describe the underlying values (one per recorded mood) for mode etc.
      var vals = [];
      keys.forEach(function (k) { for (var j = 0; j < dist[k]; j++) vals.push(k); });
      var d = U.describe(vals);
      U.statsRow(container, [["most common", U.fmt(d.mode)],
                             ["mean", U.fmt(d.mean)]]);
    },
  });

  CHARTS.push({
    id: "mood-numeric-scatter", panel: "mood",
    title: "Mood vs. journal number",
    render: function (container, entries, sections, c) {
      var nums = U.numericSections(sections);
      if (!nums.length) { U.empty(container, "No numeric sections to correlate."); return; }
      var rendered = false;
      nums.forEach(function (s) {
        // Per-day pairs: x = the numeric value, y = mood (fixed 1..7 axis).
        var pairs = entries.filter(function (e) {
          return moodOf(e) != null && (e.numbers || {})[s.id] != null;
        }).map(function (e) {
          return { x: Number(e.numbers[s.id]), y: moodOf(e) };
        });
        if (pairs.length < 2) return;
        rendered = true;
        var block = document.createElement("div");
        block.className = "section-block";
        var h4 = document.createElement("h4");
        h4.textContent = s.name + (s.unit ? " (" + s.unit + ")" : "");
        block.appendChild(h4);
        var w = 600, h = 240, pad = 36;
        var svg = U.svg(w, h);
        var xs = pairs.map(function (p) { return p.x; });
        var xMin = Math.min.apply(null, xs), xMax = Math.max.apply(null, xs);
        var xSpan = xMax - xMin || 1;
        var yMin = 1, yMax = 7, ySpan = yMax - yMin;
        U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 6, c);
        pairs.forEach(function (p) {
          var x = (xMax - xMin) === 0
            ? pad + (w - pad - 10) / 2
            : pad + (w - pad - 10) * ((p.x - xMin) / xSpan);
          var y = 10 + (h - pad - 10) * (1 - (p.y - yMin) / ySpan);
          U.drawDot(svg, x, y, 3, U.colorMix(s.color, 80));
        });
        U.text(svg, 0, 14, "7", c.muted, { size: 9 });
        U.text(svg, 0, h - pad + 2, "1", c.muted, { size: 9 });
        U.text(svg, w / 2, h - 2, s.name + " (x)  vs  mood (y)", c.muted,
               { anchor: "middle", size: 9 });
        block.appendChild(svg);
        var r = pearson(pairs.map(function (p) { return p.x; }),
                        pairs.map(function (p) { return p.y; }));
        U.statsRow(block, [["points", pairs.length],
                           ["correlation r", r == null ? null : U.fmt(r)]]);
        container.appendChild(block);
      });
      if (!rendered) {
        U.empty(container, "Need 2+ days with both a mood and a journal number.");
      }
    },
  });

  // Pearson correlation coefficient, or null if undefined (n<2 or zero variance).
  function pearson(xs, ys) {
    var n = xs.length;
    if (n < 2) return null;
    var mx = xs.reduce(function (a, b) { return a + b; }, 0) / n;
    var my = ys.reduce(function (a, b) { return a + b; }, 0) / n;
    var sxy = 0, sxx = 0, syy = 0;
    for (var i = 0; i < n; i++) {
      var dx = xs[i] - mx, dy = ys[i] - my;
      sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
    if (sxx === 0 || syy === 0) return null;
    return sxy / Math.sqrt(sxx * syy);
  }

  // ========================= Sleep tab charts ============================== //
  // Mirrors the Mood tab pattern.  All series derived from e.sleep (filtered
  // by _entry_sleep logic: must have a usable duration_min > 0).

  // Return the sleep dict if it has a usable duration, else null.
  // Mirrors journal._entry_sleep.
  function sleepOf(e) {
    var s = e && e.sleep;
    if (s && typeof s === "object" && s.duration_min) return s;
    return null;
  }

  // Convert a clock string "HH:MM" to minutes from midnight.
  function clockToMin(hhmm) {
    if (!hhmm || typeof hhmm !== "string") return null;
    var p = hhmm.split(":");
    if (p.length < 2) return null;
    return parseInt(p[0], 10) * 60 + parseInt(p[1], 10);
  }

  // Format total minutes back to "HH:MM" (wraps mod 1440).
  // Mirrors journal._min_to_clock.
  function minToClock(total) {
    total = Math.round(total) % 1440;
    if (total < 0) total += 1440;
    var h = Math.floor(total / 60), m = total % 60;
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
  }

  // Stat cards: avg duration, quality, bedtime, waketime, nights tracked.
  // Mirrors journal.sleep_stats.
  CHARTS.push({
    id: "sleep-stat-cards", panel: "sleep", title: "Sleep at a glance",
    render: function (container, entries, sections, c) {
      var sleepEntries = entries.filter(function (e) { return sleepOf(e); });
      if (!sleepEntries.length) {
        U.empty(container, "No sleep data in this range."); return;
      }
      var hours = sleepEntries.map(function (e) { return sleepOf(e).duration_min / 60; });
      var avgHours = hours.reduce(function (a, b) { return a + b; }, 0) / hours.length;

      var quals = sleepEntries
        .map(function (e) { return sleepOf(e).quality; })
        .filter(function (q) { return q != null; });
      var avgQual = quals.length
        ? quals.reduce(function (a, b) { return a + b; }, 0) / quals.length : null;

      var clockEntries = sleepEntries.filter(function (e) {
        var s = sleepOf(e); return s.start && s.end;
      });
      var beds = clockEntries.map(function (e) {
        var b = clockToMin(sleepOf(e).start);
        return b >= 12 * 60 ? b - 1440 : b;
      });
      var wakes = clockEntries.map(function (e) { return clockToMin(sleepOf(e).end); });
      var avgBed = beds.length
        ? beds.reduce(function (a, b) { return a + b; }, 0) / beds.length : null;
      var avgWake = wakes.length
        ? wakes.reduce(function (a, b) { return a + b; }, 0) / wakes.length : null;

      var grid = document.createElement("div");
      grid.className = "stat-cards";
      statCard(grid, U.fmt(avgHours) + " hrs", "avg duration", null);
      statCard(grid, avgQual != null ? U.fmt(avgQual) + "%" : null, "avg quality", null);
      statCard(grid, avgBed != null ? minToClock(avgBed) : null, "avg bedtime", null);
      statCard(grid, avgWake != null ? minToClock(avgWake) : null, "avg wake", null);
      statCard(grid, sleepEntries.length, "nights tracked", null);
      container.appendChild(grid);
    },
  });

  // Duration over time with 7-night rolling average. Mirrors mood-over-time.
  CHARTS.push({
    id: "sleep-duration", panel: "sleep", title: "Sleep duration over time",
    render: function (container, entries, sections, c) {
      var series = entries
        .filter(function (e) { return sleepOf(e); })
        .map(function (e) { return { date: e.date, hours: sleepOf(e).duration_min / 60 }; })
        .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
      if (!series.length) { U.empty(container, "No sleep data in this range."); return; }
      var vals = series.map(function (s) { return s.hours; });
      var max = Math.max.apply(null, vals), min = 0, span = max - min || 1;
      var w = 600, h = 180, pad = 34;
      var svg = U.svg(w, h);
      U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 4, c);
      function ptAt(i, v) {
        var x = series.length === 1 ? pad + (w - pad - 10) / 2
                                    : pad + ((w - pad - 10) * i) / (series.length - 1);
        var y = 10 + (h - pad - 10) * (1 - (v - min) / span);
        return { x: x, y: y };
      }
      var roll = rollingAvg(vals, 7).map(function (v, i) { return ptAt(i, v); });
      var pts = series.map(function (s, i) { return ptAt(i, s.hours); });
      U.drawLine(svg, roll, U.colorMix(c.muted, 90), 1);
      U.drawLine(svg, pts, c.accent, 1.5);
      pts.forEach(function (p) { U.drawDot(svg, p.x, p.y, 2, c.accent); });
      U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10,
                 [series[0].date, series[series.length - 1].date], c);
      // Y-axis labels
      U.text(svg, 0, 14, U.fmt(max) + "h", c.muted, { size: 9 });
      U.text(svg, 0, h - pad + 2, "0h", c.muted, { size: 9 });
      container.appendChild(svg);
      var d = U.describe(vals);
      U.statsRow(container, [
        ["mean", U.fmt(d.mean) + " hrs"], ["median", U.fmt(d.median) + " hrs"],
        ["min", U.fmt(d.min) + " hrs"], ["max", U.fmt(d.max) + " hrs"],
        ["nights", d.count],
      ]);
    },
  });

  // Quality over time. Mirrors duration chart but for quality (0..100).
  CHARTS.push({
    id: "sleep-quality", panel: "sleep", title: "Sleep quality over time",
    render: function (container, entries, sections, c) {
      var series = entries
        .filter(function (e) { return sleepOf(e) && sleepOf(e).quality != null; })
        .map(function (e) { return { date: e.date, quality: sleepOf(e).quality }; })
        .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
      if (!series.length) { U.empty(container, "No quality data in this range."); return; }
      var vals = series.map(function (s) { return s.quality; });
      var w = 600, h = 180, pad = 34;
      var svg = U.svg(w, h);
      var min = 0, max = 100, span = 100;
      U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 4, c);
      function ptAt(i, v) {
        var x = series.length === 1 ? pad + (w - pad - 10) / 2
                                    : pad + ((w - pad - 10) * i) / (series.length - 1);
        var y = 10 + (h - pad - 10) * (1 - (v - min) / span);
        return { x: x, y: y };
      }
      var roll = rollingAvg(vals, 7).map(function (v, i) { return ptAt(i, v); });
      var pts = series.map(function (s, i) { return ptAt(i, s.quality); });
      U.drawLine(svg, roll, U.colorMix(c.muted, 90), 1);
      U.drawLine(svg, pts, c.accent, 1.5);
      pts.forEach(function (p) { U.drawDot(svg, p.x, p.y, 2, c.accent); });
      U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10,
                 [series[0].date, series[series.length - 1].date], c);
      U.text(svg, 0, 14, "100%", c.muted, { size: 9 });
      U.text(svg, 0, h - pad + 2, "0%", c.muted, { size: 9 });
      container.appendChild(svg);
      var d = U.describe(vals);
      U.statsRow(container, [
        ["mean", U.fmt(d.mean) + "%"], ["median", U.fmt(d.median) + "%"],
        ["min", U.fmt(d.min) + "%"], ["max", U.fmt(d.max) + "%"],
      ]);
    },
  });

  // Bedtime & wake-time consistency: two lines per night (bed_min, wake_min).
  // Y-axis shows HH:MM. Mirrors bedtime_series logic (pre-midnight negative).
  CHARTS.push({
    id: "sleep-consistency", panel: "sleep", title: "Bedtime & wake-time consistency",
    render: function (container, entries, sections, c) {
      var series = entries
        .filter(function (e) {
          var s = sleepOf(e); return s && s.start && s.end;
        })
        .map(function (e) {
          var s = sleepOf(e);
          var bed = clockToMin(s.start);
          if (bed >= 12 * 60) bed -= 1440;  // pre-midnight → negative
          return { date: e.date, bed_min: bed, wake_min: clockToMin(s.end) };
        })
        .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
      if (!series.length) {
        U.empty(container, "No bedtime/wake data in this range."); return;
      }
      var allMins = series.map(function (s) { return s.bed_min; })
                          .concat(series.map(function (s) { return s.wake_min; }));
      var minV = Math.min.apply(null, allMins), maxV = Math.max.apply(null, allMins);
      var span = maxV - minV || 1;
      var w = 600, h = 200, pad = 42;
      var svg = U.svg(w, h);
      U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 4, c);
      function ptAt(i, v) {
        var x = series.length === 1 ? pad + (w - pad - 10) / 2
                                    : pad + ((w - pad - 10) * i) / (series.length - 1);
        var y = 10 + (h - pad - 10) * (1 - (v - minV) / span);
        return { x: x, y: y };
      }
      var bedPts = series.map(function (s, i) { return ptAt(i, s.bed_min); });
      var wakePts = series.map(function (s, i) { return ptAt(i, s.wake_min); });
      // Bed line in muted accent, wake line in accent.
      U.drawLine(svg, bedPts, U.colorMix(c.accent, 55), 1.5);
      bedPts.forEach(function (p) { U.drawDot(svg, p.x, p.y, 2, U.colorMix(c.accent, 55)); });
      U.drawLine(svg, wakePts, c.accent, 1.5);
      wakePts.forEach(function (p) { U.drawDot(svg, p.x, p.y, 2, c.accent); });
      U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10,
                 [series[0].date, series[series.length - 1].date], c);
      // Y-axis: top and bottom ticks formatted as HH:MM.
      U.text(svg, 0, 14, minToClock(maxV), c.muted, { size: 9 });
      U.text(svg, 0, h - pad + 2, minToClock(minV), c.muted, { size: 9 });
      container.appendChild(svg);
      // Legend.
      var legend = document.createElement("div");
      legend.className = "sleep-stage-legend";
      var bedLeg = document.createElement("span");
      bedLeg.className = "sleep-legend-item";
      bedLeg.style.setProperty("--sl-color", U.colorMix(c.accent, 55));
      bedLeg.textContent = "bedtime";
      var wakeLeg = document.createElement("span");
      wakeLeg.className = "sleep-legend-item";
      wakeLeg.style.setProperty("--sl-color", c.accent);
      wakeLeg.textContent = "wake";
      legend.appendChild(bedLeg);
      legend.appendChild(wakeLeg);
      container.appendChild(legend);
      var beds = series.map(function (s) { return s.bed_min; });
      var wks = series.map(function (s) { return s.wake_min; });
      U.statsRow(container, [
        ["avg bedtime", minToClock(beds.reduce(function (a, b) { return a + b; }, 0) / beds.length)],
        ["avg wake", minToClock(wks.reduce(function (a, b) { return a + b; }, 0) / wks.length)],
      ]);
    },
  });

  // Average duration by day of week. Mirrors mood-dow pattern.
  CHARTS.push({
    id: "sleep-dow", panel: "sleep", title: "Average sleep duration by day of week",
    render: function (container, entries, sections, c) {
      var buckets = [[], [], [], [], [], [], []];
      entries.forEach(function (e) {
        var s = sleepOf(e);
        if (!s) return;
        var dow = (new Date(e.date + "T00:00:00").getDay() + 6) % 7;  // Mon=0
        buckets[dow].push(s.duration_min / 60);
      });
      var avgs = buckets.map(function (b) {
        return b.length ? b.reduce(function (a, x) { return a + x; }, 0) / b.length : null;
      });
      if (avgs.every(function (a) { return a == null; })) {
        U.empty(container, "No sleep data in this range."); return;
      }
      var nonNull = avgs.filter(function (a) { return a != null; });
      var max = Math.max.apply(null, nonNull) || 1;
      var w = 600, h = 180, pad = 34;
      var svg = U.svg(w, h);
      U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 4, c);
      var bw = (w - pad - 10) / 7;
      avgs.forEach(function (a, i) {
        if (a == null) return;
        var bh = (h - pad - 10) * (a / max);
        U.drawBar(svg, pad + i * bw + 3, 10 + (h - pad - 10) - bh, bw - 6, bh, c.accent);
      });
      U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10, DOW_NAMES, c);
      container.appendChild(svg);
      var ranked = DOW_NAMES
        .map(function (n, i) { return [n, avgs[i]]; })
        .filter(function (p) { return p[1] != null; })
        .sort(function (a, b) { return b[1] - a[1]; });
      U.statsRow(container, [
        ["most sleep", ranked[0][0] + " (" + U.fmt(ranked[0][1]) + " hrs)"],
        ["least sleep", ranked[ranked.length - 1][0] + " (" + U.fmt(ranked[ranked.length - 1][1]) + " hrs)"],
      ]);
    },
  });

  // Stage composition: stacked/grouped bars for deep/light/REM/awake averages.
  // Mirrors sleep_stage_averages; only shows when staged nights exist.
  CHARTS.push({
    id: "sleep-stages", panel: "sleep", title: "Average sleep stage composition",
    render: function (container, entries, sections, c) {
      var STAGE_KEYS = ["deep", "light", "rem", "wake"];
      var STAGE_LABELS = ["Deep", "Light", "REM", "Awake"];
      // Collect per-stage values across staged nights only.
      var buckets = { deep: [], light: [], rem: [], wake: [] };
      entries.forEach(function (e) {
        var s = sleepOf(e);
        if (!s || !s.stages) return;
        STAGE_KEYS.forEach(function (k) {
          var v = s.stages[k];
          if (v != null) buckets[k].push(v);
        });
      });
      var avgs = STAGE_KEYS.map(function (k) {
        var b = buckets[k];
        return b.length ? b.reduce(function (a, x) { return a + x; }, 0) / b.length : null;
      });
      var hasData = avgs.some(function (a) { return a != null; });
      if (!hasData) {
        U.empty(container, "No sleep stage data in this range."); return;
      }
      // Bar chart: one bar per stage, value in minutes.
      var maxV = Math.max.apply(null, avgs.filter(function (a) { return a != null; })) || 1;
      var w = 600, h = 180, pad = 34;
      var svg = U.svg(w, h);
      U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 4, c);
      var STAGE_COLORS = [c.accent, U.colorMix(c.accent, 60),
                         U.colorMix(c.accent, 40), U.colorMix(c.danger, 50)];
      var bw = (w - pad - 10) / STAGE_KEYS.length;
      avgs.forEach(function (a, i) {
        if (a == null) return;
        var bh = (h - pad - 10) * (a / maxV);
        U.drawBar(svg, pad + i * bw + 3, 10 + (h - pad - 10) - bh, bw - 6, bh, STAGE_COLORS[i]);
        U.text(svg, pad + i * bw + bw / 2, 10 + (h - pad - 10) - bh - 3,
               a != null ? Math.round(a) + "m" : "", c.muted,
               { anchor: "middle", size: 9 });
      });
      U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10, STAGE_LABELS, c);
      container.appendChild(svg);
      // Stage legend.
      var legend = document.createElement("div");
      legend.className = "sleep-stage-legend";
      STAGE_KEYS.forEach(function (k, i) {
        var item = document.createElement("span");
        item.className = "sleep-legend-item";
        item.style.setProperty("--sl-color", STAGE_COLORS[i]);
        item.textContent = STAGE_LABELS[i] +
          (avgs[i] != null ? " (" + Math.round(avgs[i]) + "m)" : "");
        legend.appendChild(item);
      });
      container.appendChild(legend);
      U.statsRow(container, STAGE_KEYS.map(function (k, i) {
        return [STAGE_LABELS[i].toLowerCase(), avgs[i] != null ? Math.round(avgs[i]) + " min" : null];
      }));
    },
  });

  // Sleep ↔ mood scatter with Pearson r. Mirrors mood-numeric-scatter pattern.
  CHARTS.push({
    id: "sleep-mood-scatter", panel: "sleep", title: "Sleep duration vs. mood",
    render: function (container, entries, sections, c) {
      var pairs = entries.filter(function (e) {
        return sleepOf(e) && e.mood != null;
      }).map(function (e) {
        return { x: sleepOf(e).duration_min / 60, y: Number(e.mood) };
      });
      if (pairs.length < 2) {
        U.empty(container, "Need 2+ nights with both sleep and mood data."); return;
      }
      var xs = pairs.map(function (p) { return p.x; });
      var xMin = Math.min.apply(null, xs), xMax = Math.max.apply(null, xs);
      var xSpan = xMax - xMin || 1;
      var yMin = 1, yMax = 7, ySpan = yMax - yMin;
      var w = 600, h = 240, pad = 36;
      var svg = U.svg(w, h);
      U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 6, c);
      pairs.forEach(function (p) {
        var x = (xMax - xMin) === 0
          ? pad + (w - pad - 10) / 2
          : pad + (w - pad - 10) * ((p.x - xMin) / xSpan);
        var y = 10 + (h - pad - 10) * (1 - (p.y - yMin) / ySpan);
        U.drawDot(svg, x, y, 3, U.colorMix(c.accent, 80));
      });
      U.text(svg, 0, 14, "7", c.muted, { size: 9 });
      U.text(svg, 0, h - pad + 2, "1", c.muted, { size: 9 });
      U.text(svg, w / 2, h - 2, "sleep hours (x)  vs  mood (y)", c.muted,
             { anchor: "middle", size: 9 });
      container.appendChild(svg);
      var r = pearson(xs, pairs.map(function (p) { return p.y; }));
      U.statsRow(container, [
        ["pairs", pairs.length],
        ["correlation r", r == null ? null : U.fmt(r)],
      ]);
    },
  });

  // Coverage: how many of the in-range nights have sleep data.
  CHARTS.push({
    id: "sleep-coverage", panel: "sleep", title: "Sleep tracking coverage",
    render: function (container, entries, sections, c) {
      var nights = entries.filter(function (e) { return sleepOf(e); }).length;
      var total = entries.length;
      if (!total) { U.empty(container, "No entries in this range."); return; }
      var pct = Math.round(100 * nights / total);
      var w = 600, h = 50, pad = 0;
      var svg = U.svg(w, h);
      // Background track.
      svg.appendChild(U.svgEl("rect", {
        x: 0, y: 18, width: w, height: 14, fill: U.colorMix(c.muted, 18), rx: 3,
      }));
      // Fill.
      svg.appendChild(U.svgEl("rect", {
        x: 0, y: 18, width: Math.round(w * nights / total), height: 14,
        fill: c.accent, rx: 3,
      }));
      U.text(svg, w / 2, 30, pct + "% (" + nights + " of " + total + " nights)",
             c.text, { anchor: "middle", size: 10 });
      container.appendChild(svg);
    },
  });

  // ======================= Productivity tab charts ========================= //
  // Mirrors the Sleep tab pattern.  All series derived from e.rescuetime
  // (filtered by _entry_rescuetime logic: must have pulse or total_min).

  // Return the rescuetime dict if it has usable data, else null.
  // Mirrors journal._entry_rescuetime.
  function rescueTimeOf(e) {
    var r = e && e.rescuetime;
    if (r && typeof r === "object" && (r.pulse != null || r.total_min)) return r;
    return null;
  }

  // Format productive minutes as "Xh Ym" for display.
  function fmtProdTime(min) {
    var m = Math.round(min);
    var h = Math.floor(m / 60), rem = m % 60;
    if (h === 0) return rem + "m";
    return h + "h " + rem + "m";
  }

  // Aggregate per-activity (website/app) minutes across entries. Mirrors
  // journal.rescuetime_top_activities (category/productivity from first seen).
  function aggRtActivities(entries) {
    var totals = {}, meta = {};
    entries.forEach(function (e) {
      var r = rescueTimeOf(e);
      if (!r) return;
      (r.top_activities || []).forEach(function (a) {
        if (!a.name) return;
        totals[a.name] = (totals[a.name] || 0) + (a.min || 0);
        if (!(a.name in meta)) {
          meta[a.name] = { category: a.category, productivity: a.productivity };
        }
      });
    });
    return Object.keys(totals).map(function (k) {
      return { name: k, min: totals[k],
               category: meta[k].category, productivity: meta[k].productivity };
    });
  }

  // Bar color by RescueTime productivity score: productive (>0) accent,
  // distracting (<0) danger, neutral/unknown muted.
  function rtProdColor(prod, c) {
    if (prod == null) return c.accent;
    if (prod > 0) return c.accent;
    if (prod < 0) return c.danger;
    return U.colorMix(c.muted, 55);
  }

  // Stat cards: avg pulse, avg productive time, days tracked.
  // Mirrors journal.rescuetime_stats.
  CHARTS.push({
    id: "productivity-stat-cards", panel: "productivity", title: "Productivity at a glance",
    render: function (container, entries, sections, c) {
      var rtEntries = entries.filter(function (e) { return rescueTimeOf(e); });
      if (!rtEntries.length) {
        U.empty(container, "No RescueTime data in this range."); return;
      }
      var pulses = rtEntries
        .map(function (e) { return rescueTimeOf(e).pulse; })
        .filter(function (p) { return p != null; });
      var avgPulse = pulses.length
        ? pulses.reduce(function (a, b) { return a + b; }, 0) / pulses.length : null;
      var prods = rtEntries.map(function (e) {
        return rescueTimeOf(e).productive_min || 0;
      });
      var avgProd = prods.reduce(function (a, b) { return a + b; }, 0) / prods.length;

      var grid = document.createElement("div");
      grid.className = "stat-cards";
      statCard(grid, avgPulse != null ? Math.round(avgPulse) : null, "avg pulse", null);
      statCard(grid, fmtProdTime(avgProd), "avg productive time", null);
      statCard(grid, rtEntries.length, "days tracked", null);
      container.appendChild(grid);
    },
  });

  // Pulse over time with 7-day rolling average. Fixed 0–100 y-axis.
  // Mirrors sleep-duration chart.
  CHARTS.push({
    id: "productivity-pulse", panel: "productivity", title: "Productivity pulse over time",
    render: function (container, entries, sections, c) {
      var series = entries
        .filter(function (e) { return rescueTimeOf(e) && rescueTimeOf(e).pulse != null; })
        .map(function (e) { return { date: e.date, pulse: rescueTimeOf(e).pulse }; })
        .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
      if (!series.length) { U.empty(container, "No pulse data in this range."); return; }
      var vals = series.map(function (s) { return s.pulse; });
      var min = 0, max = 100, span = 100;
      var w = 600, h = 180, pad = 34;
      var svg = U.svg(w, h);
      U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 4, c);
      function ptAt(i, v) {
        var x = series.length === 1 ? pad + (w - pad - 10) / 2
                                    : pad + ((w - pad - 10) * i) / (series.length - 1);
        var y = 10 + (h - pad - 10) * (1 - (v - min) / span);
        return { x: x, y: y };
      }
      var roll = rollingAvg(vals, 7).map(function (v, i) { return ptAt(i, v); });
      var pts = series.map(function (s, i) { return ptAt(i, s.pulse); });
      U.drawLine(svg, roll, U.colorMix(c.muted, 90), 1);
      U.drawLine(svg, pts, c.accent, 1.5);
      pts.forEach(function (p) { U.drawDot(svg, p.x, p.y, 2, c.accent); });
      U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10,
                 [series[0].date, series[series.length - 1].date], c);
      U.text(svg, 0, 14, "100", c.muted, { size: 9 });
      U.text(svg, 0, h - pad + 2, "0", c.muted, { size: 9 });
      container.appendChild(svg);
      var d = U.describe(vals);
      U.statsRow(container, [
        ["mean", Math.round(d.mean)], ["median", Math.round(d.median)],
        ["min", Math.round(d.min)], ["max", Math.round(d.max)],
        ["days", d.count],
      ]);
    },
  });

  // Productive vs distracting vs neutral per-day stacked bars.
  // Reuses the sleep-stages stacked bar pattern.
  CHARTS.push({
    id: "productivity-time-breakdown", panel: "productivity",
    title: "Productive vs distracting vs neutral time",
    render: function (container, entries, sections, c) {
      var series = entries
        .filter(function (e) { return rescueTimeOf(e); })
        .map(function (e) {
          var r = rescueTimeOf(e);
          return {
            date: e.date,
            productive_min: r.productive_min || 0,
            distracting_min: r.distracting_min || 0,
            neutral_min: r.neutral_min || 0,
          };
        })
        .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
      if (!series.length) { U.empty(container, "No time breakdown data in this range."); return; }

      var CAT_KEYS = ["productive_min", "distracting_min", "neutral_min"];
      var CAT_LABELS = ["Productive", "Distracting", "Neutral"];
      var CAT_COLORS = [c.accent, c.danger, U.colorMix(c.muted, 60)];

      // Stacked bar: one bar per day, stack the three categories.
      var maxTotal = Math.max.apply(null, series.map(function (s) {
        return s.productive_min + s.distracting_min + s.neutral_min;
      })) || 1;
      var w = 600, h = 180, pad = 34;
      var svg = U.svg(w, h);
      U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 4, c);
      var bw = (w - pad - 10) / series.length;
      series.forEach(function (s, i) {
        var stackBottom = h - pad - 10 + 10;  // bottom of chart area (y=10 is top)
        var remaining = stackBottom;
        CAT_KEYS.forEach(function (k, ki) {
          var v = s[k];
          if (!v) return;
          var bh = (h - pad - 10) * (v / maxTotal);
          remaining -= bh;
          U.drawBar(svg, pad + i * bw + 1, remaining, bw - 2, bh, CAT_COLORS[ki]);
        });
      });
      U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10,
                 series.length > 1 ? [series[0].date, series[series.length - 1].date] : [series[0].date], c);
      container.appendChild(svg);

      // Legend.
      var legend = document.createElement("div");
      legend.className = "sleep-stage-legend";
      CAT_KEYS.forEach(function (k, i) {
        var item = document.createElement("span");
        item.className = "sleep-legend-item";
        item.style.setProperty("--sl-color", CAT_COLORS[i]);
        item.textContent = CAT_LABELS[i];
        legend.appendChild(item);
      });
      container.appendChild(legend);

      // Averages row.
      var totals = CAT_KEYS.map(function (k) {
        return series.reduce(function (acc, s) { return acc + s[k]; }, 0) / series.length;
      });
      U.statsRow(container, CAT_LABELS.map(function (l, i) {
        return [l.toLowerCase() + " avg", fmtProdTime(totals[i])];
      }));
    },
  });

  // Time by category: top 8 categories aggregated across the range.
  // Mirrors rescuetime_category_totals.
  CHARTS.push({
    id: "productivity-categories", panel: "productivity", title: "Time by category",
    render: function (container, entries, sections, c) {
      var totals = {};
      entries.forEach(function (e) {
        var r = rescueTimeOf(e);
        if (!r) return;
        (r.top_categories || []).forEach(function (cat) {
          totals[cat.name] = (totals[cat.name] || 0) + (cat.min || 0);
        });
      });
      var rows = Object.keys(totals).map(function (k) { return { name: k, min: totals[k] }; });
      rows.sort(function (a, b) { return b.min - a.min; });
      rows = rows.slice(0, 8);
      if (!rows.length) { U.empty(container, "No category data in this range."); return; }

      var maxV = rows[0].min || 1;
      var w = 600, h = Math.max(120, rows.length * 28 + 20), pad = 0;
      var svg = U.svg(w, h);
      var barW = w - 160;
      rows.forEach(function (row, i) {
        var y = i * 28 + 10;
        var bw = barW * (row.min / maxV);
        U.drawBar(svg, 150, y, bw, 18, c.accent);
        U.text(svg, 144, y + 13, row.name, c.muted, { anchor: "end", size: 10 });
        U.text(svg, 150 + bw + 4, y + 13, fmtProdTime(row.min), c.muted, { size: 9 });
      });
      container.appendChild(svg);
    },
  });

  // Top activities (websites/apps) by time. Mirrors rescuetime_top_activities;
  // bar color conveys productivity (accent = productive, danger = distracting).
  CHARTS.push({
    id: "productivity-top-activities", panel: "productivity",
    title: "Top activities by time",
    render: function (container, entries, sections, c) {
      var rows = aggRtActivities(entries);
      rows.sort(function (a, b) { return b.min - a.min; });
      rows = rows.slice(0, 8);
      if (!rows.length) {
        U.empty(container, "No activity breakdown in this range. Re-sync RescueTime to fetch the per-website/app detail.");
        return;
      }
      var notes = rows.map(function (row) {
        return fmtProdTime(row.min) + (row.category ? "  ·  " + row.category : "");
      });
      var maxNote = notes.reduce(function (m, s) { return Math.max(m, s.length); }, 0);
      var maxName = rows.reduce(function (m, r) { return Math.max(m, (r.name || "").length); }, 0);
      var maxV = rows[0].min || 1;
      var w = 600, h = Math.max(120, rows.length * 28 + 20);
      var svg = U.svg(w, h);
      // Left gutter sized to the longest activity name (capped), right gutter
      // to the widest note. ≈6 units/char at these sizes.
      var leftPad = Math.min(210, Math.ceil(maxName * 6) + 14);
      var barW = Math.max(60, w - leftPad - maxNote * 6 - 12);
      rows.forEach(function (row, i) {
        var y = i * 28 + 10;
        var bw = barW * (row.min / maxV);
        U.drawBar(svg, leftPad, y, bw, 18, rtProdColor(row.productivity, c));
        U.text(svg, leftPad - 6, y + 13, row.name, c.muted, { anchor: "end", size: 10 });
        U.text(svg, leftPad + bw + 4, y + 13, notes[i], c.muted, { size: 9 });
      });
      container.appendChild(svg);
    },
  });

  // Time by activity over time: multi-line chart of the top-N activities' daily
  // minutes. Mirrors rescuetime_activity_minutes_series (and usage-app-minutes).
  CHARTS.push({
    id: "productivity-activity-minutes", panel: "productivity",
    title: "Time by activity over time",
    render: function (container, entries, sections, c) {
      var TOP_N = 6;
      var ranked = aggRtActivities(entries);
      ranked.sort(function (a, b) { return b.min - a.min; });
      var acts = ranked.slice(0, TOP_N);
      if (!acts.length) { U.empty(container, "No activity breakdown in this range."); return; }
      var keep = {};
      acts.forEach(function (a) { keep[a.name] = true; });

      var byDate = {};
      entries.forEach(function (e) {
        var r = rescueTimeOf(e);
        if (!r) return;
        var day = byDate[e.date] || (byDate[e.date] = {});
        (r.top_activities || []).forEach(function (a) {
          if (a.name && keep[a.name]) day[a.name] = (day[a.name] || 0) + (a.min || 0);
        });
      });
      var dates = Object.keys(byDate).sort();
      if (dates.length < 2) {
        U.empty(container, "Need 2+ days of activity data to chart trends."); return;
      }

      var PALETTE = [
        c.accent, c.danger, c.accentDim || U.colorMix(c.accent, 65),
        U.colorMix(c.text, 70), U.colorMix(c.danger, 55), U.colorMix(c.accent, 45),
      ];
      var maxV = 1;
      acts.forEach(function (a) {
        dates.forEach(function (d) {
          var v = byDate[d][a.name] || 0;
          if (v > maxV) maxV = v;
        });
      });

      var w = 600, h = 200, pad = 34;
      var svg = U.svg(w, h);
      U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 4, c);
      function ptAt(i, v) {
        var x = dates.length === 1 ? pad + (w - pad - 10) / 2
                                   : pad + ((w - pad - 10) * i) / (dates.length - 1);
        var y = 10 + (h - pad - 10) * (1 - v / maxV);
        return { x: x, y: y };
      }
      acts.forEach(function (a, ai) {
        var color = PALETTE[ai % PALETTE.length];
        var pts = dates.map(function (d, i) { return ptAt(i, byDate[d][a.name] || 0); });
        U.drawLine(svg, pts, color, 1.5);
      });
      U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10,
                 [dates[0], dates[dates.length - 1]], c);
      U.text(svg, 0, 14, fmtProdTime(maxV), c.muted, { size: 9 });
      U.text(svg, 0, h - pad + 2, "0", c.muted, { size: 9 });
      container.appendChild(svg);

      // Legend: colored chip per activity.
      var legend = document.createElement("div");
      legend.className = "sleep-stage-legend";
      acts.forEach(function (a, ai) {
        var item = document.createElement("span");
        item.className = "sleep-legend-item";
        item.style.setProperty("--sl-color", PALETTE[ai % PALETTE.length]);
        item.textContent = a.name;
        legend.appendChild(item);
      });
      container.appendChild(legend);
    },
  });

  // Average productive minutes by day of week. Mirrors rescuetime_dow_averages.
  CHARTS.push({
    id: "productivity-dow", panel: "productivity",
    title: "Average productive time by day of week",
    render: function (container, entries, sections, c) {
      var buckets = [[], [], [], [], [], [], []];
      entries.forEach(function (e) {
        var r = rescueTimeOf(e);
        if (!r) return;
        var dow = (new Date(e.date + "T00:00:00").getDay() + 6) % 7;  // Mon=0
        buckets[dow].push(r.productive_min || 0);
      });
      var avgs = buckets.map(function (b) {
        return b.length ? b.reduce(function (a, x) { return a + x; }, 0) / b.length : null;
      });
      if (avgs.every(function (a) { return a == null; })) {
        U.empty(container, "No productivity data in this range."); return;
      }
      var nonNull = avgs.filter(function (a) { return a != null; });
      var max = Math.max.apply(null, nonNull) || 1;
      var w = 600, h = 180, pad = 34;
      var svg = U.svg(w, h);
      U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 4, c);
      var bw = (w - pad - 10) / 7;
      avgs.forEach(function (a, i) {
        if (a == null) return;
        var bh = (h - pad - 10) * (a / max);
        U.drawBar(svg, pad + i * bw + 3, 10 + (h - pad - 10) - bh, bw - 6, bh, c.accent);
      });
      U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10, DOW_NAMES, c);
      container.appendChild(svg);
      var ranked = DOW_NAMES
        .map(function (n, i) { return [n, avgs[i]]; })
        .filter(function (p) { return p[1] != null; })
        .sort(function (a, b) { return b[1] - a[1]; });
      U.statsRow(container, [
        ["most productive", ranked[0][0] + " (" + fmtProdTime(ranked[0][1]) + ")"],
        ["least productive", ranked[ranked.length - 1][0] + " (" + fmtProdTime(ranked[ranked.length - 1][1]) + ")"],
      ]);
    },
  });

  // Productivity (pulse) ↔ mood scatter with Pearson r.
  // Mirrors sleep-mood-scatter pattern. Gated on both present.
  CHARTS.push({
    id: "productivity-mood-scatter", panel: "productivity",
    title: "Productivity pulse vs. mood",
    render: function (container, entries, sections, c) {
      var pairs = entries.filter(function (e) {
        return rescueTimeOf(e) && rescueTimeOf(e).pulse != null && e.mood != null;
      }).map(function (e) {
        return { x: rescueTimeOf(e).pulse, y: Number(e.mood) };
      });
      if (pairs.length < 2) {
        U.empty(container, "Need 2+ days with both pulse and mood data."); return;
      }
      var xs = pairs.map(function (p) { return p.x; });
      var xMin = Math.min.apply(null, xs), xMax = Math.max.apply(null, xs);
      var xSpan = xMax - xMin || 1;
      var yMin = 1, yMax = 7, ySpan = yMax - yMin;
      var w = 600, h = 240, pad = 36;
      var svg = U.svg(w, h);
      U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 6, c);
      pairs.forEach(function (p) {
        var x = (xMax - xMin) === 0
          ? pad + (w - pad - 10) / 2
          : pad + (w - pad - 10) * ((p.x - xMin) / xSpan);
        var y = 10 + (h - pad - 10) * (1 - (p.y - yMin) / ySpan);
        U.drawDot(svg, x, y, 3, U.colorMix(c.accent, 80));
      });
      U.text(svg, 0, 14, "7", c.muted, { size: 9 });
      U.text(svg, 0, h - pad + 2, "1", c.muted, { size: 9 });
      U.text(svg, w / 2, h - 2, "pulse (x)  vs  mood (y)", c.muted,
             { anchor: "middle", size: 9 });
      container.appendChild(svg);
      var r = pearson(xs, pairs.map(function (p) { return p.y; }));
      U.statsRow(container, [
        ["pairs", pairs.length],
        ["correlation r", r == null ? null : U.fmt(r)],
      ]);
    },
  });

  // ========================= Music tab charts ============================== //
  // Mirrors the Productivity tab pattern.  All series derived from e.music
  // (filtered by _entry_music logic: must have truthy tracks).

  // Cache for the /integrations/spotify/taste endpoint.
  var _tasteCache = null;

  function asArray(v) {
    return Array.isArray(v) ? v : [];
  }
  function finiteNum(v) {
    var n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function firstNum(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      var n = finiteNum(obj && obj[keys[i]]);
      if (n != null) return n;
    }
    return null;
  }
  function fmtMusicTime(min) {
    min = Math.round(min || 0);
    var h = Math.floor(min / 60), m = min % 60;
    if (h && m) return h + "h " + m + "m";
    if (h) return h + "h";
    return m + "m";
  }

  // Return the music dict if it has usable listening data, else null.
  // Mirrors journal._entry_music for existing entries, with tolerance for
  // richer/backfilled payloads where tracks may be an array instead of a count.
  function musicOf(e) {
    var m = e && e.music;
    if (!m || typeof m !== "object") return null;
    var tracks = firstNum(m, ["tracks", "track_count", "plays", "play_count"]);
    if (tracks == null && Array.isArray(m.tracks)) tracks = m.tracks.length;
    if (tracks == null && Array.isArray(m.plays)) tracks = m.plays.length;
    var minutes = firstNum(m, ["minutes", "listened_minutes", "duration_min", "duration_minutes"]);
    var hasLists = ["top_artists", "top_tracks", "top_albums", "contexts", "top_contexts"].some(function (k) {
      return Array.isArray(m[k]) && m[k].length;
    });
    if (tracks || minutes || hasLists) {
      if (tracks != null && typeof m.tracks !== "number") m._track_count = tracks;
      if (minutes != null && m.minutes == null) m._minutes = minutes;
      return m;
    }
    return null;
  }
  function musicTracks(m) {
    return firstNum(m, ["tracks", "track_count", "plays", "play_count", "_track_count"]) || 0;
  }
  function musicMinutes(m) {
    return firstNum(m, ["minutes", "listened_minutes", "duration_min", "duration_minutes", "_minutes"]) || 0;
  }
  function musicDistinct(m) {
    return firstNum(m, ["distinct", "distinct_tracks", "distinct_track_count", "unique_tracks"]);
  }
  function itemName(item) {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object") return null;
    return item.name || item.title || item.album || item.context || item.source || item.uri || null;
  }
  function itemCount(item) {
    if (!item || typeof item !== "object") return 1;
    return firstNum(item, ["count", "plays", "play_count", "tracks", "minutes"]) || 1;
  }
  function addNamedTotals(totals, items) {
    asArray(items).forEach(function (item) {
      var name = itemName(item);
      if (!name) return;
      totals[name] = (totals[name] || 0) + itemCount(item);
    });
  }
  function addObjectTotals(totals, obj) {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return;
    Object.keys(obj).forEach(function (name) {
      var count = finiteNum(obj[name]);
      totals[name] = (totals[name] || 0) + (count == null ? 1 : count);
    });
  }
  function rowsFromTotals(totals, limit) {
    return Object.keys(totals)
      .map(function (k) { return { name: k, count: totals[k] }; })
      .sort(function (a, b) { return b.count - a.count; })
      .slice(0, limit || 10);
  }
  function renderHorizontalBars(container, rows, c) {
    var maxV = rows[0].count || 1;
    var w = 600, h = Math.max(120, rows.length * 28 + 20);
    var svg = U.svg(w, h);
    var barW = w - 180;
    rows.forEach(function (row, i) {
      var y = i * 28 + 10;
      var bw = barW * (row.count / maxV);
      U.drawBar(svg, 170, y, bw, 18, c.accent);
      U.text(svg, 164, y + 13, row.name, c.muted, { anchor: "end", size: 10 });
      U.text(svg, 170 + bw + 4, y + 13, String(row.count), c.muted, { size: 9 });
    });
    container.appendChild(svg);
  }
  function aggregateMusicNames(entries, keys, derive) {
    var totals = {};
    entries.forEach(function (e) {
      var m = musicOf(e);
      if (!m) return;
      keys.forEach(function (k) { addNamedTotals(totals, m[k]); });
      if (derive) derive(m, totals);
    });
    return rowsFromTotals(totals, 10);
  }
  function trackDisplayName(item) {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object") return null;
    var name = item.name || item.title;
    var artists = asArray(item.artists).filter(Boolean).join(", ");
    return name && artists ? name + " · " + artists : name;
  }
  function albumDisplayName(item) {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object") return null;
    var name = item.album || item.album_name || item.name;
    var artists = asArray(item.artists).filter(Boolean).join(", ");
    return name && artists ? name + " · " + artists : name;
  }
  function addDerivedTrackTotals(m, totals) {
    asArray(m.tracks).concat(asArray(m.plays)).forEach(function (item) {
      var name = trackDisplayName(item);
      if (!name) return;
      totals[name] = (totals[name] || 0) + itemCount(item);
    });
  }
  function addDerivedAlbumTotals(m, totals) {
    asArray(m.tracks).concat(asArray(m.plays)).forEach(function (item) {
      var name = albumDisplayName(item);
      if (!name) return;
      totals[name] = (totals[name] || 0) + itemCount(item);
    });
  }
  function sourceOf(m) {
    var sources = asArray(m.sources).filter(Boolean);
    if (sources.length) return sources.join(" + ");
    return m.source || m.import_source || m.imported_from || m.provider || null;
  }
  function hasImportMarker(m) {
    var sources = asArray(m.sources).join(" ");
    return !!(m.imported || m.import_id || m.imported_at || m.import_source ||
              m.imported_from || sources.indexOf("history_import") !== -1);
  }
  function normalizeTaste(taste) {
    var terms = ["short_term", "medium_term", "long_term"];
    var out = {};
    terms.forEach(function (term) {
      out[term] = {
        tracks: (taste && taste[term] && taste[term].tracks) || (taste && taste.tracks && taste.tracks[term]) || [],
        artists: (taste && taste[term] && taste[term].artists) || (taste && taste.artists && taste.artists[term]) || [],
        genres: (taste && taste[term] && taste[term].genres) || (taste && taste.genres && taste.genres[term]) || [],
      };
    });
    return out;
  }

  // Stat cards: total listening time, average, total tracks, days tracked.
  // Mirrors journal.music_stats.
  CHARTS.push({
    id: "music-stat-cards", panel: "music", title: "Music Summary",
    render: function (container, entries, sections, c) {
      var musicEntries = entries.filter(function (e) { return musicOf(e); });
      if (!musicEntries.length) {
        U.empty(container, "No music data in this range."); return;
      }
      var mins = musicEntries.map(function (e) { return musicMinutes(musicOf(e)); });
      var totalMin = mins.reduce(function (a, b) { return a + b; }, 0);
      var avgMin = totalMin / mins.length;
      var totalTracks = musicEntries.reduce(function (acc, e) {
        return acc + musicTracks(musicOf(e));
      }, 0);
      var distinctTotal = 0, hasDistinct = false;
      var sources = {}, imported = 0;
      musicEntries.forEach(function (e) {
        var m = musicOf(e);
        var d = musicDistinct(m);
        if (d != null) { hasDistinct = true; distinctTotal += d; }
        var src = sourceOf(m);
        if (src) sources[src] = true;
        if (hasImportMarker(m)) imported++;
      });
      var sourceCount = Object.keys(sources).length;
      var daySub = [];
      if (sourceCount) daySub.push(sourceCount + " source" + (sourceCount === 1 ? "" : "s"));
      if (imported) daySub.push(imported + " imported");

      var grid = document.createElement("div");
      grid.className = "stat-cards";
      statCard(grid, fmtMusicTime(totalMin), "total time", null);
      statCard(grid, Math.round(avgMin) + " min", "avg per day", null);
      statCard(grid, totalTracks, "track plays", hasDistinct ? distinctTotal + " distinct" : null);
      statCard(grid, musicEntries.length, "days tracked", daySub.join(" · "));
      container.appendChild(grid);
    },
  });

  // Minutes listened over time with 7-day rolling average.
  // Mirrors sleep-duration / productivity-pulse chart.
  CHARTS.push({
    id: "music-minutes", panel: "music", title: "Minutes listened over time",
    render: function (container, entries, sections, c) {
      var series = entries
        .filter(function (e) { return musicOf(e); })
        .map(function (e) { return { date: e.date, minutes: musicMinutes(musicOf(e)) }; })
        .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
      if (!series.length) { U.empty(container, "No music data in this range."); return; }
      var vals = series.map(function (s) { return s.minutes; });
      var max = Math.max.apply(null, vals) || 1, min = 0, span = max - min || 1;
      var w = 600, h = 180, pad = 34;
      var svg = U.svg(w, h);
      U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 4, c);
      function ptAt(i, v) {
        var x = series.length === 1 ? pad + (w - pad - 10) / 2
                                    : pad + ((w - pad - 10) * i) / (series.length - 1);
        var y = 10 + (h - pad - 10) * (1 - (v - min) / span);
        return { x: x, y: y };
      }
      var roll = rollingAvg(vals, 7).map(function (v, i) { return ptAt(i, v); });
      var pts = series.map(function (s, i) { return ptAt(i, s.minutes); });
      U.drawLine(svg, roll, U.colorMix(c.muted, 90), 1);
      U.drawLine(svg, pts, c.accent, 1.5);
      pts.forEach(function (p) { U.drawDot(svg, p.x, p.y, 2, c.accent); });
      U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10,
                 [series[0].date, series[series.length - 1].date], c);
      U.text(svg, 0, 14, Math.round(max) + "m", c.muted, { size: 9 });
      U.text(svg, 0, h - pad + 2, "0m", c.muted, { size: 9 });
      container.appendChild(svg);
      var d = U.describe(vals);
      U.statsRow(container, [
        ["mean", Math.round(d.mean) + " min"], ["median", Math.round(d.median) + " min"],
        ["min", Math.round(d.min) + " min"], ["max", Math.round(d.max) + " min"],
        ["days", d.count],
      ]);
    },
  });

  function renderMusicMoodScatter(container, entries, c, metric, label, unit) {
    var pairs = entries.filter(function (e) {
      var m = musicOf(e);
      return m && e.mood != null && metric(m) != null;
    }).map(function (e) {
      var m = musicOf(e);
      return { x: metric(m), y: Number(e.mood) };
    });
    if (pairs.length < 2) {
      U.empty(container, "Need 2+ days with both " + label.toLowerCase() + " and mood data."); return;
    }
    var xs = pairs.map(function (p) { return p.x; });
    var xMin = Math.min.apply(null, xs), xMax = Math.max.apply(null, xs);
    var xSpan = xMax - xMin || 1;
    var yMin = 1, yMax = 7, ySpan = yMax - yMin;
    var w = 600, h = 240, pad = 36;
    var svg = U.svg(w, h);
    U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 6, c);
    pairs.forEach(function (p) {
      var x = (xMax - xMin) === 0
        ? pad + (w - pad - 10) / 2
        : pad + (w - pad - 10) * ((p.x - xMin) / xSpan);
      var y = 10 + (h - pad - 10) * (1 - (p.y - yMin) / ySpan);
      U.drawDot(svg, x, y, 3, U.colorMix(c.accent, 80));
    });
    U.text(svg, 0, 14, "7", c.muted, { size: 9 });
    U.text(svg, 0, h - pad + 2, "1", c.muted, { size: 9 });
    U.text(svg, w / 2, h - 2, label + (unit ? " (" + unit + ")" : "") + " (x)  vs  mood (y)", c.muted,
           { anchor: "middle", size: 9 });
    container.appendChild(svg);
    var r = pearson(xs, pairs.map(function (p) { return p.y; }));
    U.statsRow(container, [
      ["pairs", pairs.length],
      ["correlation r", r == null ? null : U.fmt(r)],
    ]);
  }

  CHARTS.push({
    id: "music-minutes-mood-scatter", panel: "music", title: "Minutes vs. mood",
    render: function (container, entries, sections, c) {
      renderMusicMoodScatter(container, entries, c, musicMinutes, "Minutes", "min");
    },
  });

  CHARTS.push({
    id: "music-tracks-mood-scatter", panel: "music", title: "Tracks vs. mood",
    render: function (container, entries, sections, c) {
      renderMusicMoodScatter(container, entries, c, musicTracks, "Tracks", "plays");
    },
  });

  // Top artists: horizontal bars for the top 10 aggregated across the range.
  // Mirrors productivity-categories / music_top_artists.
  CHARTS.push({
    id: "music-top-artists", panel: "music", title: "Top artists",
    render: function (container, entries, sections, c) {
      var rows = aggregateMusicNames(entries, ["top_artists", "artists"]);
      if (!rows.length) { U.empty(container, "No artist data in this range."); return; }
      renderHorizontalBars(container, rows, c);
    },
  });

  CHARTS.push({
    id: "music-top-tracks", panel: "music", title: "Top tracks",
    render: function (container, entries, sections, c) {
      var rows = aggregateMusicNames(entries, ["top_tracks", "tracks_list", "played_tracks"], addDerivedTrackTotals);
      if (!rows.length) { U.empty(container, "No track detail in this range."); return; }
      renderHorizontalBars(container, rows, c);
    },
  });

  CHARTS.push({
    id: "music-top-albums", panel: "music", title: "Top albums",
    render: function (container, entries, sections, c) {
      var rows = aggregateMusicNames(entries, ["top_albums", "albums"], addDerivedAlbumTotals);
      if (!rows.length) { U.empty(container, "No album detail in this range."); return; }
      renderHorizontalBars(container, rows, c);
    },
  });

  CHARTS.push({
    id: "music-source-mix", panel: "music", title: "Source mix & import coverage",
    render: function (container, entries, sections, c) {
      var totals = {}, imported = 0, withSource = 0, tracked = 0;
      entries.forEach(function (e) {
        var m = musicOf(e);
        if (!m) return;
        tracked++;
        var src = sourceOf(m);
        if (src) {
          withSource++;
          totals[src] = (totals[src] || 0) + 1;
        }
        if (hasImportMarker(m)) imported++;
      });
      var rows = rowsFromTotals(totals, 10);
      if (!tracked) { U.empty(container, "No music data in this range."); return; }
      if (!rows.length && !imported) {
        U.empty(container, "No source or import metadata in this range."); return;
      }
      if (rows.length) renderHorizontalBars(container, rows, c);
      U.statsRow(container, [
        ["days tracked", tracked],
        ["with source", withSource],
        ["imported", imported],
      ]);
    },
  });

  CHARTS.push({
    id: "music-top-contexts", panel: "music", title: "Top contexts",
    render: function (container, entries, sections, c) {
      var rows = aggregateMusicNames(entries, ["top_contexts", "contexts", "listening_contexts"], function (m, totals) {
        addObjectTotals(totals, m.contexts);
        if (m.context) totals[m.context] = (totals[m.context] || 0) + 1;
      });
      if (!rows.length) { U.empty(container, "No listening context data in this range."); return; }
      renderHorizontalBars(container, rows, c);
    },
  });

  // Taste view: async fetch of /integrations/spotify/taste, rendered as themed
  // lists of top artists / tracks / genres for short/medium/long term.
  // Cached once per page load.
  CHARTS.push({
    id: "music-taste", panel: "music", title: "Your Spotify taste",
    render: function (container, entries, sections, c) {
      var placeholder = document.createElement("p");
      placeholder.className = "chart-muted";
      placeholder.textContent = "Loading taste data…";
      container.appendChild(placeholder);

      function renderTaste(taste) {
        container.removeChild(placeholder);
        var terms = ["short_term", "medium_term", "long_term"];
        var termLabels = { short_term: "Last 4 weeks", medium_term: "Last 6 months", long_term: "All time" };
        var normalized = normalizeTaste(taste || {});
        var hasAny = terms.some(function (t) {
          var td = normalized[t];
          return td && ((td.artists && td.artists.length) ||
                        (td.tracks && td.tracks.length) ||
                        (td.genres && td.genres.length));
        });
        if (!hasAny) {
          var none = document.createElement("p");
          none.className = "chart-muted";
          none.textContent = "No taste data yet — connect Spotify and sync to see your listening profile.";
          container.appendChild(none);
          return;
        }

        terms.forEach(function (term) {
          var td = normalized[term];
          if (!td) return;
          var section = document.createElement("div");
          section.className = "music-taste-section";
          var heading = document.createElement("h4");
          heading.className = "music-taste-heading";
          heading.textContent = termLabels[term];
          section.appendChild(heading);

          var grid = document.createElement("div");
          grid.className = "music-taste-grid";

          function renderList(title, items, key) {
            if (!items || !items.length) return;
            var col = document.createElement("div");
            col.className = "music-taste-col";
            var t = document.createElement("div");
            t.className = "music-taste-col-title";
            t.textContent = title;
            col.appendChild(t);
            var ol = document.createElement("ol");
            ol.className = "music-taste-list";
            items.slice(0, 5).forEach(function (item) {
              var li = document.createElement("li");
              li.textContent = typeof item === "string" ? item : (item[key] || item.name || String(item));
              ol.appendChild(li);
            });
            col.appendChild(ol);
            grid.appendChild(col);
          }

          renderList("Top Artists", td.artists, "name");
          renderList("Top Tracks", td.tracks, "name");
          renderList("Top Genres", td.genres, "name");

          section.appendChild(grid);
          container.appendChild(section);
        });
      }

      if (_tasteCache !== null) {
        renderTaste(_tasteCache);
        return;
      }
      fetch("/integrations/spotify/taste")
        .then(function (resp) { return resp.ok ? resp.json() : null; })
        .then(function (data) {
          _tasteCache = data || {};
          renderTaste(_tasteCache);
        })
        .catch(function () {
          _tasteCache = {};
          renderTaste(_tasteCache);
        });
    },
  });

  // Audio-feature charts: valence↔mood scatter + feature averages bar.
  // Only rendered when entries have feature data (valence != null).
  // When features are absent, renders a single muted note instead.
  CHARTS.push({
    id: "music-audio-features", panel: "music", title: "Audio features",
    render: function (container, entries, sections, c) {
      var hasFeatures = entries.some(function (e) {
        return musicOf(e) && musicOf(e).valence != null;
      });

      if (!hasFeatures) {
        var note = document.createElement("p");
        note.className = "chart-muted";
        note.textContent = "Audio features unavailable for this Spotify app.";
        container.appendChild(note);
        return;
      }

      // Valence ↔ mood scatter with Pearson r. Mirrors sleep-mood-scatter.
      var pairs = entries.filter(function (e) {
        return musicOf(e) && musicOf(e).valence != null && e.mood != null;
      }).map(function (e) {
        return { x: musicOf(e).valence, y: Number(e.mood) };
      });

      var scatterTitle = document.createElement("div");
      scatterTitle.className = "chart-subtitle";
      scatterTitle.textContent = "Valence vs. mood";
      container.appendChild(scatterTitle);

      if (pairs.length < 2) {
        U.empty(container, "Need 2+ days with both valence and mood data.");
      } else {
        var xs = pairs.map(function (p) { return p.x; });
        var xMin = Math.min.apply(null, xs), xMax = Math.max.apply(null, xs);
        var xSpan = xMax - xMin || 1;
        var yMin = 1, yMax = 7, ySpan = yMax - yMin;
        var w = 600, h = 240, pad = 36;
        var svg = U.svg(w, h);
        U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 6, c);
        pairs.forEach(function (p) {
          var x = xSpan === 0
            ? pad + (w - pad - 10) / 2
            : pad + (w - pad - 10) * ((p.x - xMin) / xSpan);
          var y = 10 + (h - pad - 10) * (1 - (p.y - yMin) / ySpan);
          U.drawDot(svg, x, y, 3, U.colorMix(c.accent, 80));
        });
        U.text(svg, 0, 14, "7", c.muted, { size: 9 });
        U.text(svg, 0, h - pad + 2, "1", c.muted, { size: 9 });
        U.text(svg, w / 2, h - 2, "valence (x)  vs  mood (y)", c.muted,
               { anchor: "middle", size: 9 });
        container.appendChild(svg);
        var r = pearson(xs, pairs.map(function (p) { return p.y; }));
        U.statsRow(container, [
          ["pairs", pairs.length],
          ["correlation r", r == null ? null : U.fmt(r)],
        ]);
      }

      // Audio-feature averages bar chart: valence/energy/danceability + normalized tempo.
      // Mirrors music_feature_averages.
      var FEAT_KEYS = ["valence", "energy", "danceability", "tempo"];
      var FEAT_LABELS = ["Valence", "Energy", "Danceability", "Tempo (norm.)"];
      var buckets = { valence: [], energy: [], danceability: [], tempo: [] };
      entries.forEach(function (e) {
        var m = musicOf(e);
        if (!m) return;
        FEAT_KEYS.forEach(function (k) {
          var v = m[k];
          if (v != null) buckets[k].push(v);
        });
      });
      var avgs = FEAT_KEYS.map(function (k) {
        var b = buckets[k];
        return b.length ? b.reduce(function (a, x) { return a + x; }, 0) / b.length : null;
      });

      // Normalize tempo to 0–1 for display (typical BPM range 60–200).
      var tempoIdx = 3;
      if (avgs[tempoIdx] != null) {
        avgs[tempoIdx] = Math.min(1, Math.max(0, (avgs[tempoIdx] - 60) / 140));
      }

      var hasAvgs = avgs.some(function (a) { return a != null; });
      if (!hasAvgs) { return; }

      var avgTitle = document.createElement("div");
      avgTitle.className = "chart-subtitle";
      avgTitle.textContent = "Average audio features";
      container.appendChild(avgTitle);

      var maxV = 1;
      var w2 = 600, h2 = 180, pad2 = 34;
      var svg2 = U.svg(w2, h2);
      U.drawGrid(svg2, pad2, 10, w2 - pad2 - 10, h2 - pad2 - 10, 4, c);
      var FEAT_COLORS = [c.accent, U.colorMix(c.accent, 70),
                         U.colorMix(c.accent, 50), U.colorMix(c.muted, 70)];
      var bw2 = (w2 - pad2 - 10) / FEAT_KEYS.length;
      avgs.forEach(function (a, i) {
        if (a == null) return;
        var bh = (h2 - pad2 - 10) * (a / maxV);
        U.drawBar(svg2, pad2 + i * bw2 + 3, 10 + (h2 - pad2 - 10) - bh, bw2 - 6, bh, FEAT_COLORS[i]);
        U.text(svg2, pad2 + i * bw2 + bw2 / 2, 10 + (h2 - pad2 - 10) - bh - 3,
               U.fmt(a), c.muted, { anchor: "middle", size: 9 });
      });
      U.drawAxis(svg2, pad2, 10, w2 - pad2 - 10, h2 - pad2 - 10, FEAT_LABELS, c);
      container.appendChild(svg2);

      // Stats row shows the RAW averages (tempo in BPM), so label tempo "(bpm)"
      // not "(norm.)" — only the bar chart above plots the normalized tempo.
      var STAT_LABELS = ["valence", "energy", "danceability", "tempo (bpm)"];
      U.statsRow(container, FEAT_KEYS.map(function (k, i) {
        var raw = buckets[k].length
          ? buckets[k].reduce(function (a, x) { return a + x; }, 0) / buckets[k].length
          : null;
        return [STAT_LABELS[i], raw != null ? U.fmt(raw) : null];
      }));
    },
  });

  // ======================= Phone usage tab charts ========================= //
  // Mirrors the Productivity/Music tab pattern.  All series derived from
  // e.usage (via usageOf, the JS mirror of usage._entry_usage).

  // Return the usage dict if it has usable data, else null.
  function usageOf(e) {
    var u = e && e.usage;
    if (u && typeof u === "object" && (u.screen_min || (u.top_apps && u.top_apps.length))) return u;
    return null;
  }

  // Format screen minutes as "Xh Ym".
  function fmtScreen(min) {
    var m = Math.round(min);
    var h = Math.floor(m / 60), rem = m % 60;
    if (h === 0) return rem + "m";
    return h + "h " + rem + "m";
  }

  // Stat cards: avg screen time/day, avg unlocks, days tracked.
  // Mirrors usage.usage_stats.
  CHARTS.push({
    id: "usage-stat-cards", panel: "usage", title: "Phone usage at a glance",
    render: function (container, entries, sections, c) {
      var uEntries = entries.filter(function (e) { return usageOf(e); });
      if (!uEntries.length) {
        U.empty(container, "No phone-usage data in this range."); return;
      }
      var screen = uEntries.map(function (e) { return usageOf(e).screen_min || 0; });
      var unlocks = uEntries.map(function (e) { return usageOf(e).unlocks || 0; });
      var avgScreen = screen.reduce(function (a, b) { return a + b; }, 0) / screen.length;
      var avgUnlocks = unlocks.reduce(function (a, b) { return a + b; }, 0) / unlocks.length;

      var grid = document.createElement("div");
      grid.className = "stat-cards";
      statCard(grid, fmtScreen(avgScreen), "avg screen time/day", null);
      statCard(grid, Math.round(avgUnlocks), "avg unlocks/day", null);
      statCard(grid, uEntries.length, "days tracked", null);
      container.appendChild(grid);
    },
  });

  // Screen time over time with 7-day rolling average.
  CHARTS.push({
    id: "usage-screen-time", panel: "usage", title: "Screen time over time",
    render: function (container, entries, sections, c) {
      var series = entries
        .filter(function (e) { return usageOf(e); })
        .map(function (e) { return { date: e.date, screen_min: usageOf(e).screen_min || 0 }; })
        .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
      if (!series.length) { U.empty(container, "No screen-time data in this range."); return; }
      var vals = series.map(function (s) { return s.screen_min; });
      var max = Math.max.apply(null, vals) || 1;
      var w = 600, h = 180, pad = 34;
      var svg = U.svg(w, h);
      U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 4, c);
      function ptAt(i, v) {
        var x = series.length === 1 ? pad + (w - pad - 10) / 2
                                    : pad + ((w - pad - 10) * i) / (series.length - 1);
        var y = 10 + (h - pad - 10) * (1 - v / max);
        return { x: x, y: y };
      }
      var roll = rollingAvg(vals, 7).map(function (v, i) { return ptAt(i, v); });
      var pts = series.map(function (s, i) { return ptAt(i, s.screen_min); });
      U.drawLine(svg, roll, U.colorMix(c.muted, 90), 1);
      U.drawLine(svg, pts, c.accent, 1.5);
      pts.forEach(function (p) { U.drawDot(svg, p.x, p.y, 2, c.accent); });
      U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10,
                 [series[0].date, series[series.length - 1].date], c);
      U.text(svg, 0, 14, fmtScreen(max), c.muted, { size: 9 });
      U.text(svg, 0, h - pad + 2, "0", c.muted, { size: 9 });
      container.appendChild(svg);
      var d = U.describe(vals);
      U.statsRow(container, [
        ["mean", fmtScreen(d.mean)], ["median", fmtScreen(d.median)],
        ["min", fmtScreen(d.min)], ["max", fmtScreen(d.max)],
        ["days", d.count],
      ]);
    },
  });

  // Aggregate per-app minutes AND opens over the range.  JS mirror of
  // usage.usage_top_apps: rows are {name(pkg), label, min, opens}, min-desc.
  function aggUsageApps(entries) {
    var totals = {}, opens = {}, labels = {};
    entries.forEach(function (e) {
      var u = usageOf(e);
      if (!u) return;
      (u.top_apps || []).forEach(function (a) {
        if (!a.name) return;
        totals[a.name] = (totals[a.name] || 0) + (a.min || 0);
        opens[a.name] = (opens[a.name] || 0) + (a.opens || 0);
        if (!labels[a.name]) labels[a.name] = a.label || a.name;
      });
    });
    return Object.keys(totals).map(function (k) {
      return { name: k, label: labels[k], min: totals[k], opens: opens[k] };
    });
  }

  // Top apps aggregated over the range (bar chart). Mirrors usage.usage_top_apps.
  // Bar length = minutes; each row also annotates its total open count.
  CHARTS.push({
    id: "usage-top-apps", panel: "usage", title: "Top apps by screen time",
    render: function (container, entries, sections, c) {
      var rows = aggUsageApps(entries);
      rows.sort(function (a, b) { return b.min - a.min; });
      rows = rows.slice(0, 8);
      if (!rows.length) { U.empty(container, "No app data in this range."); return; }

      var notes = rows.map(function (row) {
        return fmtScreen(row.min) + (row.opens ? "  ·  " + row.opens + " opens" : "");
      });
      var maxNote = notes.reduce(function (m, s) { return Math.max(m, s.length); }, 0);
      var maxName = rows.reduce(function (m, r) { return Math.max(m, (r.label || "").length); }, 0);
      var maxV = rows[0].min || 1;
      var w = 600, h = Math.max(120, rows.length * 28 + 20);
      var svg = U.svg(w, h);
      // Left gutter sized to the longest app name (not a fixed slab); right
      // gutter to the widest value label. ≈6 units/char at these sizes.
      var leftPad = Math.ceil(maxName * 6) + 14;
      var barW = Math.max(60, w - leftPad - maxNote * 6 - 12);
      rows.forEach(function (row, i) {
        var y = i * 28 + 10;
        var bw = barW * (row.min / maxV);
        U.drawBar(svg, leftPad, y, bw, 18, c.accent);
        U.text(svg, leftPad - 6, y + 13, row.label, c.muted, { anchor: "end", size: 10 });
        U.text(svg, leftPad + bw + 4, y + 13, notes[i], c.muted, { size: 9 });
      });
      container.appendChild(svg);
    },
  });

  // Top apps aggregated over the range by OPEN count (bar chart).
  // Mirrors the opens side of usage.usage_top_apps.
  CHARTS.push({
    id: "usage-top-apps-opens", panel: "usage", title: "Top apps by opens",
    render: function (container, entries, sections, c) {
      var rows = aggUsageApps(entries).filter(function (r) { return r.opens > 0; });
      rows.sort(function (a, b) { return b.opens - a.opens; });
      rows = rows.slice(0, 8);
      if (!rows.length) {
        U.empty(container, "No app-open data in this range."); return;
      }
      var notes = rows.map(function (row) { return row.opens + " opens"; });
      var maxNote = notes.reduce(function (m, s) { return Math.max(m, s.length); }, 0);
      var maxName = rows.reduce(function (m, r) { return Math.max(m, (r.label || "").length); }, 0);
      var maxV = rows[0].opens || 1;
      var w = 600, h = Math.max(120, rows.length * 28 + 20);
      var svg = U.svg(w, h);
      var leftPad = Math.ceil(maxName * 6) + 14;
      var barW = Math.max(60, w - leftPad - maxNote * 6 - 12);
      rows.forEach(function (row, i) {
        var y = i * 28 + 10;
        var bw = barW * (row.opens / maxV);
        U.drawBar(svg, leftPad, y, bw, 18, c.accent);
        U.text(svg, leftPad - 6, y + 13, row.label, c.muted, { anchor: "end", size: 10 });
        U.text(svg, leftPad + bw + 4, y + 13, notes[i], c.muted, { size: 9 });
      });
      container.appendChild(svg);
      var totalOpens = rows.reduce(function (a, r) { return a + r.opens; }, 0);
      U.statsRow(container, [
        ["apps", rows.length],
        ["most-opened", rows[0].label + " (" + rows[0].opens + ")"],
        ["total opens (top " + rows.length + ")", totalOpens],
      ]);
    },
  });

  // Screen time by app over time: multi-line chart of the top-N apps' daily
  // minutes. Mirrors usage.usage_app_minutes_series.
  CHARTS.push({
    id: "usage-app-minutes", panel: "usage", title: "Screen time by app over time",
    render: function (container, entries, sections, c) {
      var TOP_N = 6;
      // Build {apps, dates, series} the same way usage_app_minutes_series does.
      var ranked = aggUsageApps(entries);
      ranked.sort(function (a, b) { return b.min - a.min; });
      var apps = ranked.slice(0, TOP_N);
      if (!apps.length) { U.empty(container, "No app data in this range."); return; }
      var keep = {};
      apps.forEach(function (a) { keep[a.name] = true; });

      var byDate = {};
      entries.forEach(function (e) {
        var u = usageOf(e);
        if (!u) return;
        var day = byDate[e.date] || (byDate[e.date] = {});
        (u.top_apps || []).forEach(function (a) {
          if (a.name && keep[a.name]) day[a.name] = (day[a.name] || 0) + (a.min || 0);
        });
      });
      var dates = Object.keys(byDate).sort();
      if (dates.length < 2) {
        U.empty(container, "Need 2+ days of app data to chart trends."); return;
      }

      var PALETTE = [
        c.accent, c.danger, c.accentDim || U.colorMix(c.accent, 65),
        U.colorMix(c.text, 70), U.colorMix(c.danger, 55), U.colorMix(c.accent, 45),
      ];
      var maxV = 1;
      apps.forEach(function (a) {
        dates.forEach(function (d) {
          var v = byDate[d][a.name] || 0;
          if (v > maxV) maxV = v;
        });
      });

      var w = 600, h = 200, pad = 34;
      var svg = U.svg(w, h);
      U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 4, c);
      function ptAt(i, v) {
        var x = dates.length === 1 ? pad + (w - pad - 10) / 2
                                   : pad + ((w - pad - 10) * i) / (dates.length - 1);
        var y = 10 + (h - pad - 10) * (1 - v / maxV);
        return { x: x, y: y };
      }
      apps.forEach(function (a, ai) {
        var color = PALETTE[ai % PALETTE.length];
        var pts = dates.map(function (d, i) { return ptAt(i, byDate[d][a.name] || 0); });
        U.drawLine(svg, pts, color, 1.5);
      });
      U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10,
                 [dates[0], dates[dates.length - 1]], c);
      U.text(svg, 0, 14, fmtScreen(maxV), c.muted, { size: 9 });
      U.text(svg, 0, h - pad + 2, "0", c.muted, { size: 9 });
      container.appendChild(svg);

      // Legend: colored chip per app.
      var legend = document.createElement("div");
      legend.className = "sleep-stage-legend";
      apps.forEach(function (a, ai) {
        var item = document.createElement("span");
        item.className = "sleep-legend-item";
        item.style.setProperty("--sl-color", PALETTE[ai % PALETTE.length]);
        item.textContent = a.label;
        legend.appendChild(item);
      });
      container.appendChild(legend);
    },
  });

  // Unlocks over time. Mirrors usage.usage_unlocks_series.
  CHARTS.push({
    id: "usage-unlocks", panel: "usage", title: "Unlocks over time",
    render: function (container, entries, sections, c) {
      var series = entries
        .filter(function (e) { return usageOf(e); })
        .map(function (e) { return { date: e.date, unlocks: usageOf(e).unlocks || 0 }; })
        .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
      if (!series.length) { U.empty(container, "No unlock data in this range."); return; }
      var vals = series.map(function (s) { return s.unlocks; });
      var max = Math.max.apply(null, vals) || 1;
      var w = 600, h = 180, pad = 34;
      var svg = U.svg(w, h);
      U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 4, c);
      var bw = (w - pad - 10) / series.length;
      series.forEach(function (s, i) {
        var bh = (h - pad - 10) * (s.unlocks / max);
        U.drawBar(svg, pad + i * bw + 1, 10 + (h - pad - 10) - bh, Math.max(1, bw - 2), bh, c.accent);
      });
      U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10,
                 series.length > 1 ? [series[0].date, series[series.length - 1].date] : [series[0].date], c);
      U.text(svg, 0, 14, String(max), c.muted, { size: 9 });
      U.text(svg, 0, h - pad + 2, "0", c.muted, { size: 9 });
      container.appendChild(svg);
      var d = U.describe(vals);
      U.statsRow(container, [
        ["mean", Math.round(d.mean)], ["median", Math.round(d.median)],
        ["max", Math.round(d.max)], ["days", d.count],
      ]);
    },
  });

  // Average screen time by day of week. Mirrors usage.usage_dow_averages.
  CHARTS.push({
    id: "usage-dow", panel: "usage", title: "Average screen time by day of week",
    render: function (container, entries, sections, c) {
      var buckets = [[], [], [], [], [], [], []];
      entries.forEach(function (e) {
        var u = usageOf(e);
        if (!u) return;
        var dow = (new Date(e.date + "T00:00:00").getDay() + 6) % 7;  // Mon=0
        buckets[dow].push(u.screen_min || 0);
      });
      var avgs = buckets.map(function (b) {
        return b.length ? b.reduce(function (a, x) { return a + x; }, 0) / b.length : null;
      });
      if (avgs.every(function (a) { return a == null; })) {
        U.empty(container, "No phone-usage data in this range."); return;
      }
      var nonNull = avgs.filter(function (a) { return a != null; });
      var max = Math.max.apply(null, nonNull) || 1;
      var w = 600, h = 180, pad = 34;
      var svg = U.svg(w, h);
      U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 4, c);
      var bw = (w - pad - 10) / 7;
      avgs.forEach(function (a, i) {
        if (a == null) return;
        var bh = (h - pad - 10) * (a / max);
        U.drawBar(svg, pad + i * bw + 3, 10 + (h - pad - 10) - bh, bw - 6, bh, c.accent);
      });
      U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10, DOW_NAMES, c);
      container.appendChild(svg);
      var ranked = DOW_NAMES
        .map(function (n, i) { return [n, avgs[i]]; })
        .filter(function (p) { return p[1] != null; })
        .sort(function (a, b) { return b[1] - a[1]; });
      U.statsRow(container, [
        ["most", ranked[0][0] + " (" + fmtScreen(ranked[0][1]) + ")"],
        ["least", ranked[ranked.length - 1][0] + " (" + fmtScreen(ranked[ranked.length - 1][1]) + ")"],
      ]);
    },
  });

  // Screen time ↔ mood scatter with Pearson r. Mirrors usage.usage_mood_pairs.
  CHARTS.push({
    id: "usage-mood-scatter", panel: "usage", title: "Screen time vs. mood",
    render: function (container, entries, sections, c) {
      var pairs = entries.filter(function (e) {
        return usageOf(e) && e.mood != null;
      }).map(function (e) {
        return { x: usageOf(e).screen_min || 0, y: Number(e.mood) };
      });
      if (pairs.length < 2) {
        U.empty(container, "Need 2+ days with both screen time and mood data."); return;
      }
      var xs = pairs.map(function (p) { return p.x; });
      var xMin = Math.min.apply(null, xs), xMax = Math.max.apply(null, xs);
      var xSpan = xMax - xMin || 1;
      var yMin = 1, yMax = 7, ySpan = yMax - yMin;
      var w = 600, h = 240, pad = 36;
      var svg = U.svg(w, h);
      U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 6, c);
      pairs.forEach(function (p) {
        var x = (xMax - xMin) === 0
          ? pad + (w - pad - 10) / 2
          : pad + (w - pad - 10) * ((p.x - xMin) / xSpan);
        var y = 10 + (h - pad - 10) * (1 - (p.y - yMin) / ySpan);
        U.drawDot(svg, x, y, 3, U.colorMix(c.accent, 80));
      });
      U.text(svg, 0, 14, "7", c.muted, { size: 9 });
      U.text(svg, 0, h - pad + 2, "1", c.muted, { size: 9 });
      U.text(svg, w / 2, h - 2, "screen min (x)  vs  mood (y)", c.muted,
             { anchor: "middle", size: 9 });
      container.appendChild(svg);
      var r = pearson(xs, pairs.map(function (p) { return p.y; }));
      U.statsRow(container, [
        ["pairs", pairs.length],
        ["correlation r", r == null ? null : U.fmt(r)],
      ]);
    },
  });

  // ================== Leading indicators tab (Spec 3) ==================== //
  // "What predicts tomorrow's mood?" — lagged cross-domain correlations. JS
  // mirrors of the pure journal.py helpers (_predictor_by_date / lagged_pairs /
  // lagged_correlation / lagged_tag_uplift / lagged_difficulty_effect /
  // leading_indicators / lag_profile). Bespoke render (like the Tags tab):
  // a themed lag selector, a ranked board, and a detail panel (lagged scatter +
  // lag profile). Computes entirely client-side from the existing payload.

  var LEAD_LAGS = [0, 1, 2, 3];

  // Human labels + origin kinds for the fixed continuous predictor descriptors.
  var CONT_PREDICTOR_META = [
    { predictor: ["sleep", "hours"], label: "Sleep duration", kind: "sleep" },
    { predictor: ["sleep", "quality"], label: "Sleep quality", kind: "sleep" },
    { predictor: ["rescuetime", "pulse"], label: "Productivity pulse", kind: "rescuetime" },
    { predictor: ["rescuetime", "productive_min"], label: "Productive minutes", kind: "rescuetime" },
    { predictor: ["music", "minutes"], label: "Music minutes", kind: "music" },
    { predictor: ["music", "valence"], label: "Music valence", kind: "music" },
  ];

  // {date: value} for a continuous predictor over a set of entries. Mirrors
  // journal._predictor_by_date. `predictor` is a [kind, key] pair.
  function predictorByDate(entries, predictor) {
    var kind = predictor[0], key = predictor[1];
    var out = {};
    entries.forEach(function (e) {
      if (!e.date) return;
      var v = null;
      if (kind === "numeric") {
        var nums = e.numbers || {};
        if (nums[key] != null) v = Number(nums[key]);
      } else if (kind === "sleep") {
        var s = sleepOf(e);
        if (s) {
          if (key === "hours") v = s.duration_min / 60;
          else if (s[key] != null) v = Number(s[key]);
        }
      } else if (kind === "rescuetime") {
        var r = rescueTimeOf(e);
        if (r && r[key] != null) v = Number(r[key]);
      } else if (kind === "music") {
        var m = musicOf(e);
        if (m && m[key] != null) v = Number(m[key]);
      }
      if (v != null) out[e.date] = v;
    });
    return out;
  }

  // [[x, y]] pairs where x=predByDate[D], y=targetByDate[D+lag]. Mirrors
  // journal.lagged_pairs (lag=0 = same day).
  function laggedPairs(predByDate, targetByDate, lag) {
    var out = [];
    Object.keys(predByDate).forEach(function (d) {
      var y = targetByDate[isoShift(d, lag)];
      if (y != null) out.push([predByDate[d], y]);
    });
    return out;
  }

  // {r, n} lagged Pearson for one continuous predictor. Mirrors
  // journal.lagged_correlation. Target is mood-by-date.
  function laggedCorrelation(entries, predictor, target, lag) {
    var pairs = laggedPairs(predictorByDate(entries, predictor), target, lag);
    return {
      r: pearson(pairs.map(function (p) { return p[0]; }),
                 pairs.map(function (p) { return p[1]; })),
      n: pairs.length,
      pairs: pairs,
    };
  }

  // [{name, section_id, after_mean, baseline, uplift, n}] — mean target on days
  // AFTER a tag vs baseline. Mirrors journal.lagged_tag_uplift.
  function laggedTagUplift(entries, target, lag, minN) {
    var baseVals = Object.keys(target).map(function (d) { return target[d]; });
    if (!baseVals.length) return [];
    var baseline = baseVals.reduce(function (a, b) { return a + b; }, 0) / baseVals.length;
    var byTag = {};   // "name|sid" -> [after-values]
    entries.forEach(function (e) {
      if (!e.date) return;
      var after = target[isoShift(e.date, lag)];
      if (after == null) return;
      var tags = e.tags || {};
      Object.keys(tags).forEach(function (sid) {
        var seen = {};
        (tags[sid] || []).forEach(function (raw) {
          var n = String(raw).trim().toLowerCase();
          if (!n || seen[n]) return;
          seen[n] = true;
          (byTag[n + "|" + sid] = byTag[n + "|" + sid] || []).push(after);
        });
      });
    });
    var out = [];
    Object.keys(byTag).forEach(function (key) {
      var vals = byTag[key];
      if (vals.length < minN) return;
      var sep = key.lastIndexOf("|");
      var am = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
      out.push({
        name: key.slice(0, sep), section_id: key.slice(sep + 1),
        after_mean: am, baseline: baseline, uplift: am - baseline, n: vals.length,
      });
    });
    out.sort(function (a, b) { return Math.abs(b.uplift) - Math.abs(a.uplift); });
    return out;
  }

  // Set of YYYY-MM-DD dates a hard task was completed on.
  function hardTaskDates() {
    var out = [];
    (_data.tasks ? _data.tasks.archive : []).forEach(function (t) {
      if (t.difficulty === "hard" && t.completed) out.push(t.completed.slice(0, 10));
    });
    return out;
  }

  // {after_mean, baseline, uplift, n} the day AFTER a hard task vs baseline, or
  // null under minN. Mirrors journal.lagged_difficulty_effect.
  function laggedDifficultyEffect(entries, target, lag, minN) {
    var baseVals = Object.keys(target).map(function (d) { return target[d]; });
    if (!baseVals.length) return null;
    var baseline = baseVals.reduce(function (a, b) { return a + b; }, 0) / baseVals.length;
    var after = [];
    hardTaskDates().forEach(function (d) {
      var v = target[isoShift(d, lag)];
      if (v != null) after.push(v);
    });
    if (after.length < minN) return null;
    var am = after.reduce(function (a, b) { return a + b; }, 0) / after.length;
    return { after_mean: am, baseline: baseline, uplift: am - baseline, n: after.length };
  }

  // Any tag used on any in-range entry (a categorical predictor stream exists).
  function tagStreamsPresent(entries) {
    return entries.some(function (e) {
      var tags = e.tags || {};
      return Object.keys(tags).some(function (sid) {
        return (tags[sid] || []).some(function (t) { return String(t).trim(); });
      });
    });
  }

  // [{predictor, label, kind, key}] for every continuous stream with >= 1 usable
  // value in range. Numeric predictors derived from section ids in `numbers`.
  function availableContinuousPredictors(entries) {
    var out = [];
    var seen = {};
    entries.forEach(function (e) {
      var nums = e.numbers || {};
      Object.keys(nums).forEach(function (sid) { if (nums[sid] != null) seen[sid] = true; });
    });
    Object.keys(seen).sort().forEach(function (sid) {
      out.push({ predictor: ["numeric", sid], label: sectionNameOf(sid) || sid,
                 kind: "numeric", key: sid });
    });
    CONT_PREDICTOR_META.forEach(function (m) {
      var by = predictorByDate(entries, m.predictor);
      if (Object.keys(by).length) {
        out.push({ predictor: m.predictor, label: m.label, kind: m.kind,
                   key: m.predictor[1] });
      }
    });
    return out;
  }

  // Ranked leading indicators. Mirrors journal.leading_indicators. Each row:
  // {label, kind, key, r|uplift, n, direction, predictor|section_id, mag}.
  function leadingIndicators(entries, target, lag, minN) {
    var rows = [];
    availableContinuousPredictors(entries).forEach(function (p) {
      var res = laggedCorrelation(entries, p.predictor, target, lag);
      if (res.r == null || res.n < minN) return;
      rows.push({ label: p.label, kind: p.kind, key: p.key, predictor: p.predictor,
                  r: res.r, n: res.n, direction: res.r >= 0 ? "+" : "-",
                  mag: Math.abs(res.r) });
    });
    laggedTagUplift(entries, target, lag, minN).forEach(function (u) {
      rows.push({ label: u.name, kind: "tag", key: u.name, section_id: u.section_id,
                  uplift: u.uplift, n: u.n, direction: u.uplift >= 0 ? "+" : "-",
                  mag: Math.abs(u.uplift) / 6 });
    });
    var de = laggedDifficultyEffect(entries, target, lag, minN);
    if (de) {
      rows.push({ label: "Hard task done", kind: "difficulty", key: "hard",
                  uplift: de.uplift, n: de.n, direction: de.uplift >= 0 ? "+" : "-",
                  mag: Math.abs(de.uplift) / 6 });
    }
    rows.sort(function (a, b) { return b.mag - a.mag; });
    return rows;
  }

  // [{lag, r, n}] for one row across LEAD_LAGS. Mirrors journal.lag_profile
  // (categorical rows carry signed uplift in place of r).
  function lagProfile(entries, row, target) {
    return LEAD_LAGS.map(function (lag) {
      if (row.kind === "tag") {
        var m = laggedTagUplift(entries, target, lag, 1).filter(function (u) {
          return u.name === row.key && u.section_id === row.section_id;
        })[0];
        return { lag: lag, r: m ? m.uplift : null, n: m ? m.n : 0 };
      }
      if (row.kind === "difficulty") {
        var de = laggedDifficultyEffect(entries, target, lag, 1);
        return { lag: lag, r: de ? de.uplift : null, n: de ? de.n : 0 };
      }
      var res = laggedCorrelation(entries, row.predictor, target, lag);
      return { lag: lag, r: res.r, n: res.n };
    });
  }

  // Origin mark for a leading-indicator row: task glyph for difficulty, a
  // section-colored dot for tags, a stream glyph for sleep/productivity/music,
  // a numeric-section dot otherwise.
  var STREAM_GLYPH = { sleep: "☾", rescuetime: "◆", music: "♪" };
  function leadOriginMark(row) {
    if (row.kind === "difficulty") return originTaskMark();
    if (row.kind === "tag") return originDot(sectionColorOf(row.section_id));
    if (row.kind === "numeric") return originDot(sectionColorOf(row.key));
    var s = document.createElement("span");
    s.className = "lead-glyph";
    s.textContent = STREAM_GLYPH[row.kind] || "•";
    return s;
  }

  // The row's phrased effect + r/uplift + n text.
  function leadEffectText(row) {
    var sign = row.direction === "+" ? "+" : "";
    if (row.r != null && row.uplift == null) {
      return "next-day mood r=" + sign + U.fmt(row.r) + " (n=" + row.n + ")";
    }
    return "next-day mood " + sign + U.fmt(row.uplift) + " (n=" + row.n + ")";
  }

  function renderLeadTab(host, c) {
    var entries = filterEntries();
    var target = moodByDate(entries);

    var panel = document.createElement("div");
    panel.className = "analytics-panel";
    var h3 = document.createElement("h3");
    h3.textContent = "What predicts my mood?";
    panel.appendChild(h3);

    // Lag selector — themed segmented control (reuses .kind-toggle).
    var lagRow = document.createElement("div");
    lagRow.className = "lead-lagrow";
    var lagLbl = document.createElement("span");
    lagLbl.className = "lead-lag-label";
    lagLbl.textContent = "lag (days):";
    lagRow.appendChild(lagLbl);
    var toggle = document.createElement("div");
    toggle.className = "kind-toggle lead-lag-toggle";
    LEAD_LAGS.forEach(function (lag) {
      var opt = document.createElement("label");
      opt.className = "kind-opt";
      var input = document.createElement("input");
      input.type = "radio"; input.name = "lead-lag";
      input.value = lag; input.checked = (lag === _lead.lag);
      input.addEventListener("change", function () {
        _lead.lag = lag;
        _lead.selected = null;   // re-rank; selection may no longer qualify
        renderActivePanel();
      });
      opt.appendChild(input);
      opt.appendChild(document.createTextNode(String(lag)));
      toggle.appendChild(opt);
    });
    lagRow.appendChild(toggle);
    panel.appendChild(lagRow);
    host.appendChild(panel);

    var rows = leadingIndicators(entries, target, _lead.lag, LEAD_MIN_N);
    if (!rows.length) {
      U.empty(host, "Not enough paired days yet to surface a leading indicator " +
                    "at this lag. Keep journaling — it fills in over time.");
      appendLeadFootnote(host);
      return;
    }

    // Keep a valid selection; default to the top-ranked indicator.
    var sel = null;
    if (_lead.selected) {
      sel = rows.filter(function (r) {
        return r.kind === _lead.selected.kind && r.key === _lead.selected.key &&
               r.section_id === _lead.selected.section_id;
      })[0];
    }
    if (!sel) sel = rows[0];
    _lead.selected = sel;

    // Ranked board (reuses .drivers-list / .driver-*).
    var boardPanel = document.createElement("div");
    boardPanel.className = "analytics-panel";
    var bh = document.createElement("h3");
    bh.textContent = "Leading indicators";
    boardPanel.appendChild(bh);
    var list = document.createElement("div");
    list.className = "drivers-list";
    rows.forEach(function (r) {
      var row = document.createElement("div");
      row.className = "driver-row lead-row" +
        (r === sel ? " lead-selected" : "");
      var nm = document.createElement("span");
      nm.className = "driver-name";
      nm.appendChild(leadOriginMark(r));
      nm.appendChild(document.createTextNode(" " + r.label));
      var tx = document.createElement("span");
      tx.className = "driver-effect";
      tx.textContent = leadEffectText(r);
      row.appendChild(nm); row.appendChild(tx);
      makeClickable(row, function () { _lead.selected = r; renderActivePanel(); });
      list.appendChild(row);
    });
    boardPanel.appendChild(list);
    host.appendChild(boardPanel);

    // Detail panel: lagged scatter + lag profile for the selected indicator.
    renderLeadDetail(host, entries, target, sel, c);
    appendLeadFootnote(host);
  }

  function appendLeadFootnote(host) {
    var f = document.createElement("p");
    f.className = "lead-footnote";
    f.textContent = "Correlation, not causation. Lag = " + _lead.lag +
                    " day" + (_lead.lag === 1 ? "" : "s") + ".";
    host.appendChild(f);
  }

  function renderLeadDetail(host, entries, target, row, c) {
    var panel = document.createElement("div");
    panel.className = "analytics-panel";
    var h3 = document.createElement("h3");
    h3.textContent = "Detail: " + row.label;
    panel.appendChild(h3);

    // Lagged scatter — only for continuous predictors (categorical has no x).
    if (row.predictor) {
      var res = laggedCorrelation(entries, row.predictor, target, _lead.lag);
      var pairs = res.pairs;
      if (pairs.length >= 2) {
        var w = 600, h = 240, pad = 36;
        var svg = U.svg(w, h);
        var xs = pairs.map(function (p) { return p[0]; });
        var xMin = Math.min.apply(null, xs), xMax = Math.max.apply(null, xs);
        var xSpan = (xMax - xMin) || 1;
        var yMin = 1, yMax = 7, ySpan = yMax - yMin;
        U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 6, c);
        var color = row.kind === "numeric" ? (sectionColorOf(row.key) || c.accent) : c.accent;
        function px(x) {
          return (xMax - xMin) === 0 ? pad + (w - pad - 10) / 2
            : pad + (w - pad - 10) * ((x - xMin) / xSpan);
        }
        function py(y) { return 10 + (h - pad - 10) * (1 - (y - yMin) / ySpan); }
        pairs.forEach(function (p) {
          U.drawDot(svg, px(p[0]), py(p[1]), 3, U.colorMix(color, 80));
        });
        // Least-squares line over the (x, mood) pairs.
        var lr = leastSquares(xs, pairs.map(function (p) { return p[1]; }));
        if (lr) {
          U.drawLine(svg, [
            { x: px(xMin), y: py(lr.slope * xMin + lr.intercept) },
            { x: px(xMax), y: py(lr.slope * xMax + lr.intercept) },
          ], c.accent, 1.5);
        }
        U.text(svg, 0, 14, "7", c.muted, { size: 9 });
        U.text(svg, 0, h - pad + 2, "1", c.muted, { size: 9 });
        U.text(svg, w / 2, h - 2,
               row.label + " (day D)  vs  mood (day D+" + _lead.lag + ")",
               c.muted, { anchor: "middle", size: 9 });
        panel.appendChild(svg);
        U.statsRow(panel, [["points", res.n],
                           ["correlation r", res.r == null ? null : U.fmt(res.r)]]);
      } else {
        U.empty(panel, "Not enough lagged pairs to plot at this lag.");
      }
    } else {
      // Categorical: show after-vs-baseline means.
      var stat = row.kind === "tag"
        ? laggedTagUplift(entries, target, _lead.lag, 1).filter(function (u) {
            return u.name === row.key && u.section_id === row.section_id; })[0]
        : laggedDifficultyEffect(entries, target, _lead.lag, 1);
      if (stat) {
        U.statsRow(panel, [
          ["mood after", U.fmt(stat.after_mean)],
          ["baseline", U.fmt(stat.baseline)],
          ["uplift", (stat.uplift >= 0 ? "+" : "") + U.fmt(stat.uplift)],
          ["days", stat.n],
        ]);
      } else {
        U.empty(panel, "No after-days at this lag.");
      }
    }

    // Lag-profile mini-chart: r (or uplift) at each lag, peak highlighted.
    var prof = lagProfile(entries, row, target);
    var withVal = prof.filter(function (p) { return p.r != null; });
    if (withVal.length) {
      var sub = document.createElement("div");
      sub.className = "chart-subtitle";
      sub.textContent = row.predictor ? "Correlation by lag (peak highlighted)"
                                      : "Uplift by lag (peak highlighted)";
      panel.appendChild(sub);
      var pw = 320, ph = 150, ppad = 28;
      var psvg = U.svg(pw, ph);
      var vals = withVal.map(function (p) { return p.r; });
      var absMax = Math.max.apply(null, vals.map(Math.abs)) || 1;
      var lo = -absMax, hi = absMax, span = hi - lo;
      // zero baseline
      var y0 = 10 + (ph - ppad - 10) * (1 - (0 - lo) / span);
      psvg.appendChild(U.svgEl("line", {
        x1: ppad, y1: y0, x2: pw - 10, y2: y0, stroke: c.border, "stroke-width": 1 }));
      var peak = withVal.reduce(function (a, b) {
        return Math.abs(b.r) > Math.abs(a.r) ? b : a; });
      var n = prof.length;
      var pts = [];
      prof.forEach(function (p, i) {
        var x = ppad + (pw - ppad - 10) * (n === 1 ? 0.5 : i / (n - 1));
        if (p.r == null) return;
        var y = 10 + (ph - ppad - 10) * (1 - (p.r - lo) / span);
        pts.push({ x: x, y: y });
        var isPeak = (p.lag === peak.lag);
        U.drawDot(psvg, x, y, isPeak ? 4.5 : 3, isPeak ? c.accent : c.muted);
      });
      U.drawLine(psvg, pts, c.accent, 1.2);
      U.drawAxis(psvg, ppad, 10, pw - ppad - 10, ph - ppad - 10,
                 prof.map(function (p) { return "L" + p.lag; }), c);
      panel.appendChild(psvg);
    }

    host.appendChild(panel);
  }

  // Ordinary least-squares over parallel x/y arrays -> {slope, intercept} or
  // null. (linearRegression above works over day-indexed series; this variant
  // fits mood against an arbitrary predictor value.)
  function leastSquares(xs, ys) {
    var n = xs.length;
    if (n < 2) return null;
    var mx = xs.reduce(function (a, b) { return a + b; }, 0) / n;
    var my = ys.reduce(function (a, b) { return a + b; }, 0) / n;
    var sxx = 0, sxy = 0;
    for (var i = 0; i < n; i++) {
      sxx += (xs[i] - mx) * (xs[i] - mx);
      sxy += (xs[i] - mx) * (ys[i] - my);
    }
    if (sxx === 0) return null;
    var slope = sxy / sxx;
    return { slope: slope, intercept: my - slope * mx };
  }

  // ===================== Tags tab (search + overview) ==================== //
  // A dedicated, bespoke renderer (not part of the CHARTS loop): a search box +
  // live-preview of all known tag names (journal + task), an async per-tag
  // fetch of /tag/<name>/overview, and per-tag detail showing both the journal
  // and task halves.

  var TAG_MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                 "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function tagShortDate(d) {
    if (!d) return "";
    var p = String(d).split("-");
    return p.length < 3 ? d : TAG_MON[parseInt(p[1], 10) - 1] + " " + p[2];
  }

  function originTaskMark() {
    var s = document.createElement("span");
    s.className = "origin-task";
    s.textContent = "☑";   // ☑
    return s;
  }
  function originDot(color) {
    var s = document.createElement("span");
    s.className = "origin-dot";
    if (color) s.style.setProperty("--dot", color);
    return s;
  }
  function sectionColorOf(sid) {
    var s = (_data.sections || []).filter(function (x) { return x.id === sid; })[0];
    return s ? s.color : null;
  }
  function sectionNameOf(sid) {
    var s = (_data.sections || []).filter(function (x) { return x.id === sid; })[0];
    return s ? s.name : "section";
  }

  // A panel container helper.
  function tagPanel(host, title) {
    var panel = document.createElement("div");
    panel.className = "analytics-panel";
    if (title) {
      var h3 = document.createElement("h3");
      h3.textContent = title;
      panel.appendChild(h3);
    }
    host.appendChild(panel);
    return panel;
  }

  // Mood-over-time chart for the tag (mirrors the mood-over-time chart pattern).
  function tagMoodChart(panel, series, c) {
    if (!series || series.length < 2) {
      U.empty(panel, "Not enough mood data for this tag.");
      return;
    }
    var w = 600, h = 180, pad = 30;
    var svg = U.svg(w, h);
    var min = 1, max = 7, span = max - min;
    U.drawGrid(svg, pad, 10, w - pad - 10, h - pad - 10, 6, c);
    function ptAt(i, v) {
      var x = series.length === 1 ? pad + (w - pad - 10) / 2
                                  : pad + ((w - pad - 10) * i) / (series.length - 1);
      var y = 10 + (h - pad - 10) * (1 - (v - min) / span);
      return { x: x, y: y };
    }
    var vals = series.map(function (s) { return s.mood; });
    var roll = rollingAvg(vals, 7).map(function (v, i) { return ptAt(i, v); });
    var pts = series.map(function (s, i) { return ptAt(i, s.mood); });
    U.drawLine(svg, roll, U.colorMix(c.muted, 90), 1);
    U.drawLine(svg, pts, c.accent, 1.5);
    pts.forEach(function (p) { U.drawDot(svg, p.x, p.y, 2, c.accent); });
    U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10,
               [series[0].date, series[series.length - 1].date], c);
    U.text(svg, 0, 14, "7", c.muted, { size: 9 });
    U.text(svg, 0, h - pad + 2, "1", c.muted, { size: 9 });
    panel.appendChild(svg);
  }

  // Journal day-of-week bars from a 7-count array (Mon..Sun).
  function tagDowChart(panel, dow, color, c) {
    var names = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    var max = Math.max.apply(null, dow) || 1;
    if (!dow.some(function (n) { return n > 0; })) {
      U.empty(panel, "No entries for this tag in range."); return;
    }
    var w = 600, h = 170, pad = 30;
    var svg = U.svg(w, h);
    var bw = (w - pad - 10) / 7;
    dow.forEach(function (n, i) {
      var bh = (h - pad - 10) * (n / max);
      U.drawBar(svg, pad + i * bw + 3, 10 + (h - pad - 10) - bh, bw - 6, bh,
                color || c.accent);
      if (n) U.text(svg, pad + i * bw + bw / 2, 10 + (h - pad - 10) - bh - 3,
                    String(n), c.muted, { anchor: "middle", size: 9 });
    });
    U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10, names, c);
    panel.appendChild(svg);
  }

  // Horizontal co-occurrence bar list. `rows` = [{name, count, color}].
  function tagCoocList(panel, rows, c, taskOrigin) {
    if (!rows.length) { U.empty(panel, "No co-occurring tags."); return; }
    var max = rows[0].count || 1;
    var list = document.createElement("div");
    list.className = "cooc-list";
    rows.slice(0, 10).forEach(function (r) {
      var row = document.createElement("div");
      row.className = "cooc-row";
      var nm = document.createElement("span");
      nm.className = "cooc-name";
      nm.appendChild(taskOrigin ? originTaskMark() : originDot(r.color));
      nm.appendChild(document.createTextNode(" " + r.name));
      var track = document.createElement("span");
      track.className = "cooc-track";
      var fill = document.createElement("span");
      fill.className = "cooc-fill";
      fill.style.width = Math.round((r.count / max) * 100) + "%";
      track.appendChild(fill);
      var cnt = document.createElement("span");
      cnt.className = "cooc-count";
      cnt.textContent = r.count;
      row.appendChild(nm); row.appendChild(track); row.appendChild(cnt);
      list.appendChild(row);
    });
    panel.appendChild(list);
  }

  function renderTagJournal(host, journal, c) {
    // Header stats.
    var head = tagPanel(host, null);
    var hr = document.createElement("div");
    hr.className = "deep-head";
    var nm = document.createElement("span");
    nm.className = "deep-tagname"; nm.textContent = _tagQuery;
    hr.appendChild(nm);
    (journal.sections || []).forEach(function (s) {
      var mark = document.createElement("span");
      mark.className = "pop-origin-mark";
      mark.appendChild(originDot(s.color));
      mark.appendChild(document.createTextNode(" journal · " + s.name));
      hr.appendChild(mark);
    });
    head.appendChild(hr);
    var grid = document.createElement("div");
    grid.className = "stat-cards";
    statCard(grid, journal.entries, "entries",
             (journal.first && journal.last)
               ? journal.first + " → " + journal.last : null);
    statCard(grid, journal.avg_mood != null ? U.fmt(journal.avg_mood) : null,
             "avg mood",
             journal.uplift != null
               ? (journal.uplift > 0 ? "▲ +" : "▼ ") + U.fmt(journal.uplift) + " vs overall"
               : null);
    head.appendChild(grid);

    // Timeline (entry rows link to /journal/<date>).
    var tl = tagPanel(host, "Journal timeline");
    if ((journal.timeline || []).length) {
      var ul = document.createElement("ul");
      ul.className = "timeline";
      journal.timeline.forEach(function (r) {
        var li = document.createElement("li");
        li.className = "tl-row";
        var mark = document.createElement("span");
        mark.className = "tl-mark";
        mark.appendChild(originDot(sectionColorOf((r.sections || [])[0])));
        li.appendChild(mark);
        var a = document.createElement("a");
        a.className = "tl-date"; a.href = "/journal/" + r.date;
        a.textContent = tagShortDate(r.date);
        li.appendChild(a);
        var tx = document.createElement("span");
        tx.className = "tl-text";
        tx.textContent = r.snippet || "(entry)";
        li.appendChild(tx);
        ul.appendChild(li);
      });
      tl.appendChild(ul);
    } else {
      U.empty(tl, "No journal entries carry this tag in range.");
    }

    // Mood when present.
    tagMoodChart(tagPanel(host, "Mood when present"), journal.mood_series, c);
    // Journal day-of-week.
    tagDowChart(tagPanel(host, "Journal day-of-week"), journal.dow || [0,0,0,0,0,0,0],
                (journal.sections || [])[0] ? journal.sections[0].color : null, c);
    // Co-occurrence.
    var coocRows = (journal.cooccurring || []).map(function (x) {
      return { name: x.name, count: x.count, color: sectionColorOf(x.section_id) };
    });
    tagCoocList(tagPanel(host, "Co-occurring journal tags"), coocRows, c, false);
  }

  function renderTagTask(host, task, c) {
    // Header stats.
    var head = tagPanel(host, null);
    var hr = document.createElement("div");
    hr.className = "deep-head";
    var nm = document.createElement("span");
    nm.className = "deep-tagname"; nm.textContent = _tagQuery;
    hr.appendChild(nm);
    var mark = document.createElement("span");
    mark.className = "pop-origin-mark";
    mark.appendChild(originTaskMark());
    mark.appendChild(document.createTextNode(" task tag"));
    hr.appendChild(mark);
    head.appendChild(hr);
    var grid = document.createElement("div");
    grid.className = "stat-cards";
    statCard(grid, task.active, "active tasks", task.completed + " done");
    statCard(grid, task.completed, "completed",
             task.expired ? task.expired + " expired" : null);
    var lead = task.lead_time_days;
    statCard(grid, lead == null ? null : "~" + Math.abs(Math.round(lead * 10) / 10) + "d",
             "lead time",
             lead == null ? null : (lead > 0 ? "finished early" : "finished late"));
    head.appendChild(grid);

    // Lead-time callout.
    var lt = tagPanel(host, "Task lead-time");
    if (lead != null) {
      var box = document.createElement("div");
      box.className = "callout";
      var big = document.createElement("div");
      big.className = "callout-big";
      big.textContent = lead > 0
        ? "Usually finished ~" + Math.abs(Math.round(lead * 10) / 10) + " days early"
        : (lead < 0
          ? "Usually finished ~" + Math.abs(Math.round(lead * 10) / 10) + " days late"
          : "Usually finished on time");
      box.appendChild(big);
      lt.appendChild(box);
    } else {
      U.empty(lt, "No completed tasks with a due date for this tag.");
    }

    // Task timeline.
    var tl = tagPanel(host, "Task timeline");
    if ((task.timeline || []).length) {
      var ul = document.createElement("ul");
      ul.className = "timeline";
      task.timeline.forEach(function (r) {
        var li = document.createElement("li");
        li.className = "tl-row";
        var mk = document.createElement("span");
        mk.className = "tl-mark";
        mk.appendChild(originTaskMark());
        li.appendChild(mk);
        var dt = document.createElement("span");
        dt.className = "tl-date"; dt.textContent = tagShortDate(r.date);
        li.appendChild(dt);
        var tx = document.createElement("span");
        tx.className = "tl-text";
        tx.textContent = r.title + " · " + r.status;
        li.appendChild(tx);
        ul.appendChild(li);
      });
      tl.appendChild(ul);
    } else {
      U.empty(tl, "No tasks carry this tag in range.");
    }

    // Completion throughput for the tag (per-day bars from the timeline).
    var thr = tagPanel(host, "Completion throughput");
    var byDay = {};
    (task.timeline || []).forEach(function (r) {
      if (r.status === "completed" && r.completed) {
        var d = r.completed.slice(0, 10);
        byDay[d] = (byDay[d] || 0) + 1;
      }
    });
    var days = Object.keys(byDay).sort();
    if (days.length) {
      var w = 600, h = 160, pad = 28, svg = U.svg(w, h);
      var max = Math.max.apply(null, days.map(function (d) { return byDay[d]; }));
      var bw = (w - pad) / days.length;
      days.forEach(function (d, i) {
        var bh = (h - pad) * (byDay[d] / max);
        U.drawBar(svg, pad + i * bw, h - pad - bh, Math.max(bw - 2, 1), bh, c.accent);
      });
      thr.appendChild(svg);
      U.statsRow(thr, [["completions", days.reduce(function (a, d) { return a + byDay[d]; }, 0)]]);
    } else {
      U.empty(thr, "No completed tasks for this tag in range.");
    }

    // Task co-occurrence.
    var coocRows = (task.cooccurring || []).map(function (x) {
      return { name: x.name, count: x.count };
    });
    tagCoocList(tagPanel(host, "Co-occurring task tags"), coocRows, c, true);
  }

  function renderTagsTab(host, c) {
    // Search box with a custom live-preview dropdown. We replace the native
    // <datalist> so we control exactly when the preview shows and hides: it
    // updates live as you type and disappears once a tag is committed (Enter,
    // click, or arrow + Enter). Lists both journal and task tags; the rendered
    // detail below shows both halves via run().
    var searchPanel = tagPanel(host, null);
    var row = document.createElement("div");
    row.className = "tag-search-row";
    var label = document.createElement("label");
    label.textContent = "tag"; label.setAttribute("for", "tag-search-input");
    var field = document.createElement("div");
    field.className = "tag-search-field";
    var input = document.createElement("input");
    input.className = "tag-search"; input.id = "tag-search-input";
    input.type = "text"; input.placeholder = "search a tag…";
    input.setAttribute("autocomplete", "off");
    input.value = _tagQuery;
    var preview = document.createElement("ul");
    preview.className = "tag-search-preview";
    preview.hidden = true;
    field.appendChild(input); field.appendChild(preview);
    row.appendChild(label); row.appendChild(field);
    searchPanel.appendChild(row);

    var resultsHost = document.createElement("div");
    resultsHost.className = "tag-detail-results";
    host.appendChild(resultsHost);

    // name -> {task, color}: drives the origin marks beside each preview
    // option. Lists BOTH journal (section) tags and task-registry tags, each
    // origin-marked (● journal / ☑ task; a tag can be both).
    var info = (function () {
      var idx = {};
      (_data.sections || []).forEach(function (s) {
        (s.tags || []).forEach(function (t) {
          if (!idx[t]) idx[t] = { task: false, color: null };
          if (idx[t].color == null) idx[t].color = s.color;
        });
      });
      var tt = _data.tasks && _data.tasks.tags;
      if (tt) Object.keys(tt).forEach(function (t) {
        if (!idx[t]) idx[t] = { task: true, color: null };
        else idx[t].task = true;
      });
      return idx;
    })();
    var names = Object.keys(info).sort();
    var _hi = -1;   // highlighted preview option index

    function matches(q) {
      q = (q || "").trim().toLowerCase();
      return names.filter(function (n) { return n.indexOf(q) !== -1; });
    }

    function hidePreview() { preview.hidden = true; preview.innerHTML = ""; _hi = -1; }

    function setHi(i) {
      var opts = preview.querySelectorAll(".tag-search-opt");
      if (_hi >= 0 && opts[_hi]) opts[_hi].classList.remove("active");
      _hi = i;
      if (_hi >= 0 && opts[_hi]) opts[_hi].classList.add("active");
    }

    function showPreview(q) {
      var ms = matches(q).slice(0, 10);
      preview.innerHTML = ""; _hi = -1;
      if (!ms.length) { preview.hidden = true; return; }
      ms.forEach(function (n, i) {
        var li = document.createElement("li");
        li.className = "tag-search-opt"; li.dataset.name = n;
        var nf = info[n] || {};
        if (nf.task) li.appendChild(originTaskMark());
        if (nf.color != null) li.appendChild(originDot(nf.color));
        li.appendChild(document.createTextNode(" " + n));
        li.addEventListener("mousedown", function (e) {
          e.preventDefault();   // beat the input's blur so the click registers
          commit(n);
        });
        li.addEventListener("mousemove", function () { setHi(i); });
        preview.appendChild(li);
      });
      preview.hidden = false;
    }

    function commit(name) { input.value = name; hidePreview(); run(name); }

    // Default view (no search): ALL aggregate tag charts (every CHARTS entry
    // registered under panel "tags"), rendered like a normal panel — the
    // journal tag charts first, then the task-tag chart. The tag-section scope
    // filter narrows only the section-based (journal) charts.
    function renderAggregateTags() {
      resultsHost.innerHTML = "";
      var entries = filterEntries();
      var c = colors();
      renderSectionFilter(resultsHost, "tag", renderAggregateTags);
      var sectionsArg = filteredSections("tag");
      var charts = CHARTS.filter(function (ch) { return ch.panel === "tags"; });
      if (!charts.length) { U.empty(resultsHost, "No tag charts available."); return; }
      charts.forEach(function (ch) {
        var p = buildChartPanel(ch);
        try {
          ch.render(p.body, entries, sectionsForChart(sectionsArg, ch.id), c);
        } catch (err) {
          U.empty(p.body, "Could not render this chart.");
          if (window.console) console.error(ch.id, err);
        }
        resultsHost.appendChild(p.panel);
      });
    }

    function run(name) {
      _tagQuery = (name || "").trim().toLowerCase();
      updateHash();
      resultsHost.innerHTML = "";
      if (!_tagQuery) {            // no search → show the all-tags overview
        renderAggregateTags();
        return;
      }
      U.empty(resultsHost, "Loading…");
      fetchTagOverview(_tagQuery).then(function (payload) {
        if (_tagQuery !== ((name || "").trim().toLowerCase())) return;  // stale
        resultsHost.innerHTML = "";
        var cc = colors();
        // Render BOTH halves for the searched tag: journal detail then task
        // detail (each shows its own empty state when the tag is absent there).
        renderTagJournal(resultsHost, payload.journal || {}, cc);
        renderTagTask(resultsHost, payload.task || {}, cc);
      }).catch(function () {
        resultsHost.innerHTML = "";
        U.empty(resultsHost, "Could not load this tag.");
      });
    }

    input.addEventListener("input", function () { showPreview(input.value); });
    input.addEventListener("focus", function () { showPreview(input.value); });
    input.addEventListener("blur", function () { setTimeout(hidePreview, 150); });
    input.addEventListener("keydown", function (e) {
      var opts = preview.hidden ? [] : preview.querySelectorAll(".tag-search-opt");
      if (e.key === "ArrowDown" && opts.length) {
        e.preventDefault(); setHi((_hi + 1) % opts.length);
      } else if (e.key === "ArrowUp" && opts.length) {
        e.preventDefault(); setHi((_hi - 1 + opts.length) % opts.length);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (_hi >= 0 && opts[_hi]) commit(opts[_hi].dataset.name);
        else { hidePreview(); run(input.value); }   // commit typed text; hide preview
      } else if (e.key === "Escape") {
        hidePreview();
      }
    });

    run(_tagQuery);   // empty → all-tags overview; set → that tag's detail
  }

  // Fetch /tag/<name>/overview honoring the current date range; cached per
  // (name, range) so re-renders don't refetch needlessly.
  function fetchTagOverview(name) {
    var qs = [];
    if (_from) qs.push("from=" + encodeURIComponent(_from));
    if (_to) qs.push("to=" + encodeURIComponent(_to));
    var key = name + "|" + qs.join("&");
    if (_tagCache[key]) return Promise.resolve(_tagCache[key]);
    var url = "/tag/" + encodeURIComponent(name) + "/overview" +
              (qs.length ? "?" + qs.join("&") : "");
    return fetch(url, { headers: { "Accept": "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (payload) { _tagCache[key] = payload; return payload; });
  }

  // ----- date filtering -----
  function filterEntries() {
    return _data.entries.filter(function (e) {
      return (!_from || e.date >= _from) && (!_to || e.date <= _to);
    });
  }

  // ----- categories + sub-tabs -----
  function panelById(id) {
    for (var i = 0; i < PANELS.length; i++) {
      if (PANELS[i].id === id) return PANELS[i];
    }
    return null;
  }
  function catById(id) {
    for (var i = 0; i < CATEGORIES.length; i++) {
      if (CATEGORIES[i].id === id) return CATEGORIES[i];
    }
    return null;
  }
  function categoryOf(tabId) {
    for (var i = 0; i < CATEGORIES.length; i++) {
      if (CATEGORIES[i].tabs.indexOf(tabId) !== -1) return CATEGORIES[i];
    }
    return null;
  }

  // Every section is always reachable: the nav is a stable, complete map of the
  // app regardless of the current data. Tabs with no data yet render their
  // charts' graceful empty states rather than being hidden. (The `needs`
  // predicates on PANELS still exist for the Overview cards / Leading logic; they
  // no longer gate tab visibility.)
  function tabVisible(p) {
    return !!p;
  }
  // The sub-tab ids of a category, in display order (all always visible).
  function visibleTabsFor(cat) {
    return cat.tabs.filter(function (id) { return tabVisible(panelById(id)); });
  }
  // Every category is always shown.
  function categoryVisible(cat) {
    return cat.tabs.length > 0;
  }

  // Ensure (_category, _activeTab) are mutually consistent and visible: sync
  // _category to the category that owns _activeTab; if that tab/category is
  // gated away, fall back to the first visible tab of the category, else to
  // Overview.
  function reconcileNav() {
    var owner = categoryOf(_activeTab);
    if (owner && categoryVisible(owner)) {
      var vis = visibleTabsFor(owner);
      if (vis.indexOf(_activeTab) === -1) _activeTab = vis[0];
      _category = owner.id;
      return;
    }
    _category = "overview";
    _activeTab = "overview";
  }

  // Primary category row.
  function buildCategories() {
    var bar = root.querySelector(".analytics-cats");
    if (!bar) return;
    bar.innerHTML = "";
    CATEGORIES.forEach(function (cat) {
      if (!categoryVisible(cat)) return;
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "analytics-cat" + (cat.id === _category ? " active" : "");
      btn.textContent = cat.label;
      btn.dataset.cat = cat.id;
      btn.addEventListener("click", function () { switchCategory(cat.id); });
      bar.appendChild(btn);
    });
  }

  // Secondary sub-tab row for the active category. Hidden when the category has
  // fewer than two visible sub-tabs (Overview, or one gated down to a single).
  function buildSubtabs() {
    var bar = root.querySelector(".analytics-subtabs");
    if (!bar) return;
    bar.innerHTML = "";
    var cat = catById(_category);
    var vis = cat ? visibleTabsFor(cat) : [];
    if (vis.length < 2) { bar.hidden = true; return; }
    bar.hidden = false;
    vis.forEach(function (id) {
      var p = panelById(id);
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "analytics-subtab" + (id === _activeTab ? " active" : "");
      btn.textContent = p.label;
      btn.dataset.panel = id;
      btn.addEventListener("click", function () { switchTab(id); });
      bar.appendChild(btn);
    });
  }

  // Activate a category: pick its first visible sub-tab (unless the current
  // active tab already belongs to it) and render.
  function switchCategory(catId) {
    var cat = catById(catId);
    if (!cat) return;
    _category = catId;
    var vis = visibleTabsFor(cat);
    if (vis.indexOf(_activeTab) === -1) _activeTab = vis[0] || "overview";
    buildCategories();
    buildSubtabs();
    renderActivePanel();
    updateHash();
  }

  // Activate a sub-tab within the current category.
  function switchTab(id) {
    _activeTab = id;
    root.querySelectorAll(".analytics-subtab").forEach(function (b) {
      b.classList.toggle("active", b.dataset.panel === id);
    });
    renderActivePanel();
    updateHash();
  }

  // Jump to a specific (category, tab) — used by the Overview launchpad and the
  // #tag deep-link.
  function goTo(catId, tabId) {
    _category = catId;
    _activeTab = tabId;
    buildCategories();
    buildSubtabs();
    renderActivePanel();
    updateHash();
  }

  // Reflect (_activeTab, _tagQuery) into the URL hash via replaceState (no new
  // history entry, no scroll-jump) so a refresh reopens the same tab — mirrors
  // how the Manage page's #sec-* anchors survive a refresh. A searched Tags tab
  // keeps the shareable "#tag=<name>" form; every other tab uses "#tab=<id>".
  function updateHash() {
    var hash = (_activeTab === "tags" && _tagQuery)
      ? "tag=" + encodeURIComponent(_tagQuery)
      : "tab=" + encodeURIComponent(_activeTab);
    if (window.history && history.replaceState) {
      history.replaceState(null, "", "#" + hash);
    } else {
      window.location.hash = hash;
    }
  }

  // ----- section scope filter (Numeric & Tags tabs) -----
  function sectionsOfType(kind) {
    return (_data.sections || []).filter(function (s) { return s.type === kind; });
  }

  // _data.sections with the `kind`-type sections narrowed to the current
  // selection. Sections of other types pass through untouched.
  function filteredSections(kind) {
    if (_secSel[kind] === null) return _data.sections;
    var sel = _secSel[kind];
    return (_data.sections || []).filter(function (s) {
      return s.type !== kind || sel.indexOf(s.id) !== -1;
    });
  }

  // Per-chart section filter, from each section's Manage-page Configure popup
  // (`section.chart_opts[chartId]`). A section not yet configured for this
  // chart id (or any chart added after the section was last configured)
  // defaults to shown. Applied on top of the section-scope filter above.
  function sectionsForChart(sections, chartId) {
    return (sections || []).filter(function (s) {
      var opts = s.chart_opts || {};
      return opts[chartId] !== false;
    });
  }

  // A row of toggle chips choosing which `kind` sections show. All start active
  // (= "show all"); clicking toggles one; the All chip resets. Re-renders via
  // `onChange`. Renders nothing when there's 0–1 section (nothing to filter).
  function renderSectionFilter(host, kind, onChange) {
    var all = sectionsOfType(kind);
    if (all.length <= 1) return;
    var ids = all.map(function (s) { return s.id; });
    var bar = document.createElement("div");
    bar.className = "section-filter";
    var lbl = document.createElement("span");
    lbl.className = "section-filter-label";
    lbl.textContent = (kind === "numeric" ? "numeric" : "tag") + ":";
    bar.appendChild(lbl);

    var allChip = document.createElement("button");
    allChip.type = "button";
    allChip.className = "section-filter-chip" + (_secSel[kind] === null ? " active" : "");
    allChip.textContent = "All";
    allChip.addEventListener("click", function () { _secSel[kind] = null; onChange(); });
    bar.appendChild(allChip);

    all.forEach(function (s) {
      var on = _secSel[kind] === null || _secSel[kind].indexOf(s.id) !== -1;
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "section-filter-chip" + (on ? " active" : "");
      chip.style.setProperty("--chip", s.color);
      chip.textContent = s.name;
      chip.addEventListener("click", function () {
        if (_secSel[kind] === null) {
          // From the default "all selected", the first pick focuses to just
          // this one (deselects the rest).
          _secSel[kind] = [s.id];
        } else {
          // Already narrowed: toggle this one in/out (multi-select).
          var cur = _secSel[kind].slice();
          var i = cur.indexOf(s.id);
          if (i === -1) cur.push(s.id); else cur.splice(i, 1);
          // Back to all (or emptied) → reset to the "all" state.
          _secSel[kind] = (cur.length === 0 || cur.length === ids.length)
            ? null : cur;
        }
        onChange();
      });
      bar.appendChild(chip);
    });
    host.appendChild(bar);
  }

  // Build a chart box: a header row (title + collapse caret, top-right) and a
  // collapsible body. Returns {panel, body} — callers render the chart into
  // `body`. Boxes default to OPEN; collapse state is in-memory only (per page
  // visit, not persisted). When collapsed, the header (title) stays visible.
  function buildChartPanel(ch) {
    var panel = document.createElement("div");
    panel.className = "analytics-panel";
    panel.id = "chart-" + ch.id;

    var head = document.createElement("div");
    head.className = "analytics-panel-head";
    var h3 = document.createElement("h3");
    h3.textContent = ch.title;
    var toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "analytics-panel-toggle";
    toggle.innerHTML = '<svg class="analytics-panel-caret" viewBox="0 0 24 24" ' +
      'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>';

    var body = document.createElement("div");
    body.className = "analytics-panel-body";

    // Restore this box's collapse state (persists across tab switches / re-renders
    // within the page visit).
    function reflect(collapsed) {
      panel.classList.toggle("collapsed", collapsed);
      toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
      toggle.title = collapsed ? "Expand" : "Collapse";
    }
    reflect(!!_collapsed[ch.id]);
    toggle.addEventListener("click", function () {
      _collapsed[ch.id] = !panel.classList.contains("collapsed");
      reflect(_collapsed[ch.id]);
    });

    head.appendChild(h3);
    head.appendChild(toggle);
    panel.appendChild(head);
    panel.appendChild(body);
    return { panel: panel, body: body };
  }

  // ----- rendering -----
  function renderActivePanel() {
    var host = root.querySelector(".analytics-panels");
    host.innerHTML = "";
    var entries = filterEntries();
    var c = colors();

    // The Tags tab has bespoke interaction (search + all-tags overview that the
    // search results replace), so it bypasses the generic CHARTS loop.
    if (_activeTab === "tags") {
      renderTagsTab(host, c);
      return;
    }

    // The Leading tab is bespoke too (lag selector + ranked board + detail).
    if (_activeTab === "leading") {
      renderLeadTab(host, c);
      return;
    }

    // The Numeric tab gets a section scope filter; charts read the (filtered)
    // sections argument, so passing a narrowed list scopes them all at once.
    var sectionsArg = _data.sections;
    if (_activeTab === "numeric") {
      renderSectionFilter(host, "numeric", renderActivePanel);
      sectionsArg = filteredSections("numeric");
    }

    var charts = CHARTS.filter(function (ch) { return ch.panel === _activeTab; });

    if (!charts.length) {
      U.empty(host, "No charts for this section yet.");
      return;
    }
    charts.forEach(function (ch) {
      var p = buildChartPanel(ch);
      try {
        ch.render(p.body, entries, sectionsForChart(sectionsArg, ch.id), c);
      } catch (err) {
        U.empty(p.body, "Could not render this chart.");
        if (window.console) console.error(ch.id, err);
      }
      host.appendChild(p.panel);
    });
  }

  // Read the URL hash on first load: "#tag=<name>" (external deep-link, e.g.
  // the tag popup's "Expand →") opens Data → Tags pre-searched; "#tab=<id>"
  // (written by updateHash on every switch) reopens whichever tab was active
  // when the page was last refreshed. reconcileNav() (called right after, in
  // applyData) fills in the owning category and falls back to Overview if the
  // tab id is unrecognized.
  function readInitialHash() {
    var hash = window.location.hash || "";
    var tagM = /(?:^|[#&])tag=([^&]+)/.exec(hash);
    if (tagM) {
      _tagQuery = decodeURIComponent(tagM[1]).trim().toLowerCase();
      _category = "data";
      _activeTab = "tags";
      return;
    }
    var tabM = /(?:^|[#&])tab=([^&]+)/.exec(hash);
    if (tabM) _activeTab = decodeURIComponent(tabM[1]);
  }

  // ----- data load -----
  var _firstLoad = true;
  function applyData(payload) {
    _data = payload || _data;
    var loading = document.getElementById("analytics-loading");
    if (loading) loading.remove();
    // Initialize date inputs to full range on first load only.
    var fromEl = document.getElementById("date-from");
    var toEl = document.getElementById("date-to");
    if (_from === null && _to === null) {
      _from = _data.date_range.min;
      _to = _data.date_range.max;
      fromEl.value = _from || "";
      toEl.value = _to || "";
    }
    if (_firstLoad) { readInitialHash(); _firstLoad = false; }
    syncDateLabels();
    reconcileNav();
    buildCategories();
    buildSubtabs();
    renderActivePanel();
  }

  function fetchData(force) {
    var now = Date.now();
    if (!force && now - _lastFetch < 10000) return;
    _lastFetch = now;
    fetch(ENDPOINT, { headers: { "Accept": "application/json" } })
      .then(function (r) { return r.json(); })
      .then(applyData)
      .catch(function (err) {
        if (window.console) console.error("analytics fetch failed", err);
      });
  }

  // ----- wiring -----
  document.getElementById("date-from").addEventListener("change", function (e) {
    _from = e.target.value || null;
    _tagCache = {};   // range changed -> the Tag tab must refetch
    renderActivePanel();
  });
  document.getElementById("date-to").addEventListener("change", function (e) {
    _to = e.target.value || null;
    _tagCache = {};
    renderActivePanel();
  });
  document.getElementById("date-reset").addEventListener("click", function () {
    _from = _data.date_range.min;
    _to = _data.date_range.max;
    _tagCache = {};
    document.getElementById("date-from").value = _from || "";
    document.getElementById("date-to").value = _to || "";
    syncDateLabels();
    renderActivePanel();
  });

  // ----- custom date pickers (themed calendar popover, reuses .cal-* CSS) -----
  function syncDateLabels() {
    document.querySelectorAll("[data-datepicker]").forEach(function (btn) {
      var input = document.getElementById(btn.dataset.datepicker);
      var span = btn.querySelector(".cs-value");
      if (input && span) span.textContent = input.value || "—";
    });
  }

  var _openCal = null;
  function closeCal() { if (_openCal) { _openCal.remove(); _openCal = null; } }

  function openCalFor(trigger, input) {
    var pop = document.createElement("div");
    pop.className = "cal-popover";
    pop._owner = trigger;
    pop.addEventListener("click", function (e) { e.stopPropagation(); });

    var base = input.value ? new Date(input.value + "T00:00:00") : new Date();
    var viewY = base.getFullYear(), viewM = base.getMonth();

    function render() {
      pop.innerHTML = "";
      var head = document.createElement("div");
      head.className = "cal-head";
      var prev = document.createElement("button");
      prev.type = "button"; prev.className = "cal-nav"; prev.textContent = "‹";
      prev.addEventListener("click", function () {
        viewM--; if (viewM < 0) { viewM = 11; viewY--; } render();
      });
      var title = document.createElement("span");
      title.className = "cal-month-title";
      title.textContent = CAL_MONTHS[viewM] + " " + viewY;
      var next = document.createElement("button");
      next.type = "button"; next.className = "cal-nav"; next.textContent = "›";
      next.addEventListener("click", function () {
        viewM++; if (viewM > 11) { viewM = 0; viewY++; } render();
      });
      head.appendChild(prev); head.appendChild(title); head.appendChild(next);
      pop.appendChild(head);

      var grid = document.createElement("div");
      grid.className = "cal-grid";
      CAL_DAYS.forEach(function (d) {
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
      var todayIso = calIso(now.getFullYear(), now.getMonth(), now.getDate());
      var dim = new Date(viewY, viewM + 1, 0).getDate();
      for (var day = 1; day <= dim; day++) {
        (function (day) {
          var iso = calIso(viewY, viewM, day);
          var cell = document.createElement("div");
          cell.className = "cal-day";
          if (iso === todayIso) cell.classList.add("is-today");
          if (iso === input.value) cell.classList.add("is-selected");
          var num = document.createElement("span");
          num.className = "cal-day-num"; num.textContent = String(day);
          cell.appendChild(num);
          cell.addEventListener("click", function () {
            input.value = iso;
            input.dispatchEvent(new Event("change", { bubbles: true }));
            syncDateLabels();
            closeCal();
          });
          grid.appendChild(cell);
        }(day));
      }
      pop.appendChild(grid);
    }

    render();
    trigger.parentNode.appendChild(pop);
    _openCal = pop;
  }

  document.querySelectorAll("[data-datepicker]").forEach(function (trigger) {
    var input = document.getElementById(trigger.dataset.datepicker);
    if (!input) return;
    trigger.addEventListener("click", function (e) {
      e.stopPropagation();
      var wasOpen = _openCal && _openCal._owner === trigger;
      closeCal();
      if (!wasOpen) openCalFor(trigger, input);
    });
  });
  document.addEventListener("click", closeCal);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeCal(); });
  syncDateLabels();

  // Live refresh: re-fetch when the tab regains focus (debounced in fetchData).
  window.addEventListener("focus", function () { fetchData(false); });

  // Initial load.
  fetchData(true);
})();
