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
  var _lens = "journal";    // "journal" | "task" — swaps the deeper tab set
  var _lastFetch = 0;
  var _tagQuery = "";       // current tag in the Tag detail tab
  var _tagCache = {};       // {name: payload} cache for /tag/<name>/overview
  // Section scope filter for the Numeric & Tags tabs. null = all shown; else an
  // array of selected section ids of that type. Keyed by section type.
  var _secSel = { numeric: null, tag: null };

  // Panel definitions. `needs` optionally gates a tab's visibility.
  // `lens` scopes a tab to one lens; tabs with no lens are shared (Overview),
  // and a tab can list multiple lenses (the Tags tab lives in both).
  var PANELS = [
    { id: "overview", label: "Overview" },
    // Journal lens
    { id: "mood", label: "Mood", lens: ["journal"], needs: hasMood },
    { id: "sleep", label: "Sleep", lens: ["journal"], needs: hasSleep },
    { id: "consistency", label: "Consistency", lens: ["journal"] },
    { id: "tags", label: "Tags", lens: ["journal", "task"] },
    { id: "numeric", label: "Numeric", lens: ["journal"], needs: hasNumeric },
    { id: "coverage", label: "Coverage", lens: ["journal"] },
    // Task lens (the old single "Tasks" tab, refactored into sub-tabs)
    { id: "throughput", label: "Throughput", lens: ["task"], needs: hasTasks },
    { id: "timeliness", label: "Timeliness", lens: ["task"], needs: hasTasks },
    { id: "adherence", label: "Adherence", lens: ["task"], needs: hasTasks },
    { id: "difficulty", label: "Difficulty", lens: ["task"], needs: hasTasks },
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
    return _data.entries.some(function (e) { return e && e.sleep; });
  }

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

    drawAxis: function (svg, x, y, w, h, labels, c) {
      // X-axis baseline + evenly spaced tick labels below it.
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
  // Uses the existing switchLens/switchTab + Tags-search entry points. Defined
  // up here (hoisted) but they call functions declared later in the IIFE; all
  // are reachable by the time a click fires. -----
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
    if (_lens !== "journal") switchLens("journal");
    _secSel.numeric = sectionId ? [sectionId] : null;
    switchTab("numeric");
  }
  function gotoMood() {
    if (_lens !== "journal") switchLens("journal");
    switchTab("mood");
  }
  function gotoThroughput() {
    if (_lens !== "task") switchLens("task");
    switchTab("throughput");
  }
  function gotoTag(name) {
    _tagQuery = (name || "").trim().toLowerCase();
    switchTab("tags");   // renderTagsTab reads _tagQuery and renders the detail
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
    panel: "tags", lens: "journal",
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
    panel: "tags", lens: "journal",
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
    panel: "tags", lens: "journal",
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
    panel: "tags", lens: "journal",
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
        var w = 600, h = 180, pad = 30;
        var svg = U.svg(w, h);
        var cmax = Math.max.apply(null, buckets.map(function (bk) { return bk.count; })) || 1;
        var bw = (w - pad - 10) / buckets.length;
        buckets.forEach(function (bk, i) {
          var bh = (h - pad - 10) * (bk.count / cmax);
          U.drawBar(svg, pad + i * bw + 2, 10 + (h - pad - 10) - bh, bw - 4, bh, s.color);
          if (bk.count) {
            U.text(svg, pad + i * bw + bw / 2, 10 + (h - pad - 10) - bh - 3,
                   String(bk.count), c.muted, { anchor: "middle", size: 9 });
          }
        });
        U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10,
                   [U.fmt(min), U.fmt(max)], c);
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
    id: "task-tag-frequency", panel: "tags", lens: "task", title: "Task tag frequency",
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
      var w = 600, h = 180, pad = 30;
      var svg = U.svg(w, h);
      var keys = [1, 2, 3, 4, 5, 6, 7];
      var max = Math.max.apply(null, keys.map(function (k) { return dist[k]; })) || 1;
      var bw = (w - pad - 10) / keys.length;
      keys.forEach(function (k, i) {
        var bh = (h - pad - 10) * (dist[k] / max);
        U.drawBar(svg, pad + i * bw + 3, 10 + (h - pad - 10) - bh, bw - 6, bh, c.accent);
        U.text(svg, pad + i * bw + bw / 2, 10 + (h - pad - 10) - bh - 3,
               dist[k] || "", c.muted, { anchor: "middle", size: 9 });
      });
      U.drawAxis(svg, pad, 10, w - pad - 10, h - pad - 10,
                 keys.map(String), c);
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

  // ===================== Tags tab (search + overview) ==================== //
  // A dedicated, bespoke renderer (not part of the CHARTS loop): a search box +
  // datalist of all known tag names, an async per-tag fetch of
  // /tag/<name>/overview, and lens-aware rendering (journal half vs task half).

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
    // click, or arrow + Enter). Works the same in both the journal and task
    // lenses (the rendered detail below is lens-aware via run()).
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
    // option. Scoped to the active lens — the Journal lens lists only journal
    // (section) tags; the Task lens lists only task-registry tags.
    var info = (function () {
      var idx = {};
      if (_lens === "task") {
        var tt = _data.tasks && _data.tasks.tags;
        if (tt) Object.keys(tt).forEach(function (t) {
          idx[t] = { task: true, color: null };
        });
      } else {
        (_data.sections || []).forEach(function (s) {
          (s.tags || []).forEach(function (t) {
            if (!idx[t]) idx[t] = { task: false, color: null };
            if (idx[t].color == null) idx[t].color = s.color;
          });
        });
      }
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

    // Default view (no search): the aggregate tag charts for the active lens
    // (the CHARTS registered under panel "tags"), rendered like a normal panel.
    function renderAggregateTags() {
      resultsHost.innerHTML = "";
      var entries = filterEntries();
      var c = colors();
      // Lens-scope the aggregate charts: journal tags in the Journal lens, task
      // tags in the Task lens. Only the journal charts are section-based, so the
      // tag-section scope filter only shows in the Journal lens.
      var sectionsArg = _data.sections;
      if (_lens === "journal") {
        renderSectionFilter(resultsHost, "tag", renderAggregateTags);
        sectionsArg = filteredSections("tag");
      }
      var charts = CHARTS.filter(function (ch) {
        return ch.panel === "tags" && (!ch.lens || ch.lens === _lens);
      });
      if (!charts.length) { U.empty(resultsHost, "No tag charts available."); return; }
      charts.forEach(function (ch) {
        var panel = document.createElement("div");
        panel.className = "analytics-panel";
        panel.id = "chart-" + ch.id;
        var h3 = document.createElement("h3");
        h3.textContent = ch.title;
        panel.appendChild(h3);
        try {
          ch.render(panel, entries, sectionsArg, c);
        } catch (err) {
          U.empty(panel, "Could not render this chart.");
          if (window.console) console.error(ch.id, err);
        }
        resultsHost.appendChild(panel);
      });
    }

    function run(name) {
      _tagQuery = (name || "").trim().toLowerCase();
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
        if (_lens === "task") renderTagTask(resultsHost, payload.task || {}, cc);
        else renderTagJournal(resultsHost, payload.journal || {}, cc);
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

  // ----- lens + tabs -----
  // A tab is visible when: it has no lens (shared, e.g. Overview), OR its lens
  // list includes the active lens. `needs` further gates on available data.
  function tabVisible(p) {
    if (p.lens && p.lens.indexOf(_lens) === -1) return false;
    if (p.needs && !p.needs()) return false;
    return true;
  }

  // The Journal/Task lens toggle. Overview always renders outside it, so the
  // toggle only swaps the deeper tab set. Switching lens keeps the active tab
  // if it is still valid under the new lens, else falls back to Overview.
  function buildLensToggle() {
    var host = root.querySelector(".analytics-lens");
    if (!host) return;
    host.innerHTML = "";
    [["journal", "Journal"], ["task", "Task"]].forEach(function (pair) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "analytics-lens-btn" + (pair[0] === _lens ? " active" : "");
      btn.textContent = pair[1];
      btn.dataset.lens = pair[0];
      btn.addEventListener("click", function () { switchLens(pair[0]); });
      host.appendChild(btn);
    });
  }

  function switchLens(lens) {
    if (lens === _lens) return;
    _lens = lens;
    // Keep the active tab if it survives the lens switch; else go to Overview.
    var stay = PANELS.some(function (p) {
      return p.id === _activeTab && tabVisible(p);
    });
    if (!stay) _activeTab = "overview";
    buildLensToggle();
    buildTabs();
    renderActivePanel();
  }

  function buildTabs() {
    var bar = root.querySelector(".analytics-tabs");
    bar.innerHTML = "";
    PANELS.forEach(function (p) {
      if (!tabVisible(p)) return;
      var btn = document.createElement("button");
      btn.className = "analytics-tab" + (p.id === _activeTab ? " active" : "");
      btn.textContent = p.label;
      btn.dataset.panel = p.id;
      btn.addEventListener("click", function () { switchTab(p.id); });
      bar.appendChild(btn);
    });
    // If the active tab got hidden (e.g. numeric data removed), fall back.
    if (!PANELS.some(function (p) { return p.id === _activeTab && tabVisible(p); })) {
      _activeTab = "overview";
    }
  }

  function switchTab(id) {
    _activeTab = id;
    root.querySelectorAll(".analytics-tab").forEach(function (b) {
      b.classList.toggle("active", b.dataset.panel === id);
    });
    renderActivePanel();
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
      var panel = document.createElement("div");
      panel.className = "analytics-panel";
      panel.id = "chart-" + ch.id;
      var h3 = document.createElement("h3");
      h3.textContent = ch.title;
      panel.appendChild(h3);
      try {
        ch.render(panel, entries, sectionsArg, c);
      } catch (err) {
        U.empty(panel, "Could not render this chart.");
        if (window.console) console.error(ch.id, err);
      }
      host.appendChild(panel);
    });
  }

  // Read #tag=<name> from the URL hash: open the Tags tab pre-searched.
  function readTagHash() {
    var m = /(?:^|[#&])tag=([^&]+)/.exec(window.location.hash || "");
    if (m) {
      _tagQuery = decodeURIComponent(m[1]).trim().toLowerCase();
      _activeTab = "tags";
    }
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
    if (_firstLoad) { readTagHash(); _firstLoad = false; }
    syncDateLabels();
    buildLensToggle();
    buildTabs();
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
