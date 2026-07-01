# Analytics ideas — brainstorm menu

A slate of new analytics ideas for `/journal/analytics`, biased toward the app's
real differentiator: **one combined store of journal + tasks + a per-entry mood
(1–7)**, so cross-domain correlations are cheap and unique to this app.

Conventions assumed throughout:
- Pure helpers live in `journal.py` / `todo.py` (zero Flask), injectable date
  bounds, mirror the existing helper shapes so they slot into `analytics_payload`.
- Charts are hand-rolled SVG pushed onto the `CHARTS` registry in `analytics.js`;
  colors come from CSS vars + section hex; no new deps.
- **Mood is integer 1–7 or null. Every mood aggregation ignores null moods.**

Effort key: **S** ≈ one helper + one descriptor; **M** ≈ a few helpers / a richer
chart; **L** ≈ new tab, multiple helpers, or new plumbing.

---

## A. Mood-centric

| # | Idea | One-liner | Builds on | Effort | Value | Placement |
|---|------|-----------|-----------|:-:|:-:|-----------|
| A1 | **Mood over time** | Line/area of daily mood, with a rolling average overlay. | new `mood_series`; reuse `rollingAvg`, `drawLine` | S | High | Mood tab + Overview sparkline |
| A2 | **Mood day-of-week average** | Bar chart: mean mood per weekday (Mon–Sun). | new `mood_dow_averages` (mirrors `dow_averages`) | S | High | Mood tab |
| A3 | **Mood distribution** | Histogram of counts per mood value 1–7. | new `mood_distribution` | S | Med-High | Mood tab |
| A4 | **Mood rolling average** | 7-day smoothed mood trend (the calm signal under the noise). | folded into A1 as an overlay | S | High | Mood tab (overlay) |
| A5 | **Mood streaks / best & worst stretches** | Longest run of "good" (≥5) and "rough" (≤3) days; current run. | new `mood_streaks` (mirrors `tag_streak` run logic) | M | Med | Mood tab stats row |
| A6 | **Mood calendar heatmap** | Month grid where each day is shaded by mood (dark→amber). | reuse `buildMonthGrid`; new `mood_by_date` | M | High | Mood tab |
| A7 | **Mood vs words written** | Do you write more on good or bad days? scatter mood × body word count. | `word_counts` + `mood_series` | S | Med | Mood tab |
| A8 | **Mood volatility** | Stdev of mood over the range + a "swinginess" callout. | `describe(mood values)` | S | Low-Med | Overview stat |

## B. Cross-domain (the app's real strength)

| # | Idea | One-liner | Builds on | Effort | Value | Placement |
|---|------|-----------|-----------|:-:|:-:|-----------|
| B1 | **Mood vs numeric section** | Scatter + correlation: mood × each numeric section (e.g. sleep hrs). | new `mood_numeric_pairs`; reuse scatter plumbing | M | **Very High** | Mood tab (small-multiple per numeric section) |
| B2 | **Mood vs task-completion volume** | Scatter: that day's completed-task count × mood. | `mood_by_date` + JS `taskThroughput` | M | High | Tasks tab or Mood tab |
| B3 | **Tags that ride with good/bad moods** | For each tag, avg mood on days it appears vs overall; rank uplift. | new `mood_tag_uplift` | M | **Very High** | Mood tab / Tags tab |
| B4 | **Mood vs journaling consistency** | Compare avg mood inside a streak vs on isolated days. | `entry_streak` + `mood_by_date` | M | Med | Insights |
| B5 | **Difficulty vs mood** | Avg mood on days you finished a hard task vs easy/none. | `difficulty_breakdown` per-day + `mood_by_date` | M | Med | Tasks/Mood |

## C. Insight callouts (auto-generated plain language)

A compact "Insights" strip on Overview that turns the numbers into sentences.
Each insight is a pure function returning `{text, kind}` (or None when the data
is too thin), so it is fully unit-testable.

| # | Insight | Trigger | Builds on | Effort |
|---|---------|---------|-----------|:-:|
| C1 | "Your mood averages **higher on weekends** (+0.6)." | weekend vs weekday mean diff ≥ threshold | `mood_dow_averages` | S |
| C2 | "Days you log **exercise** average **+0.8 mood**." | top tag uplift ≥ threshold | `mood_tag_uplift` (B3) | M |
| C3 | "More sleep tracks with **better mood** (r=+0.4)." | strongest mood↔numeric correlation | `mood_numeric_pairs` (B1) | M |
| C4 | "Best stretch: **6 good days** ending Jun 18." | longest good-mood run | `mood_streaks` (A5) | S |
| C5 | "You've journaled **12 days straight** — your longest yet." | current == longest streak | `entry_streak` | S |

`build_insights(data, start, end)` would call the underlying helpers and emit a
ranked, deduped list (cap ~4) — a single descriptor renders them as a styled
list on Overview.

## D. Beyond the obvious (surprise)

| # | Idea | One-liner | Builds on | Effort | Value |
|---|------|-----------|-----------|:-:|:-:|
| D1 | **Period-over-period delta cards** | This period vs the previous equal-length window: entries, avg mood, tasks done — each with ▲/▼. | date math + existing aggregations | M | High |
| D2 | **"Mood words"** | Most frequent body words on top-mood days vs bottom-mood days. | tokenize bodies + `mood_by_date` | M | Med (fun) |
| D3 | **Tag-mood network** | Co-occurrence matrix tinted by the pair's average mood. | `tag_cooccurrence` + `mood_by_date` | L | Med |
| D4 | **Forecast-y "on track" ring** | Entries this period vs your personal daily-rate baseline. | throughput + entry density | M | Low-Med |
| D5 | **Mood autocorrelation** | Does a bad day predict the next? lag-1 mood scatter. | `mood_series` | S | Low (nerdy) |

---

## Prioritized recommendation

The user explicitly asked for (1) **mood analytics** and (2) a **stronger
Overview**. Recommended build order, highest value-per-effort first:

1. **A1 Mood over time** (+ A4 rolling overlay) — the headline mood chart. **[ship]**
2. **A2 Mood day-of-week average** — trivial given `dow_averages`. **[ship]**
3. **A3 Mood distribution** — completes the "shape of my moods" story. **[ship]**
4. **B1 Mood vs numeric section** — the standout cross-domain insight; reuses the
   existing scatter pattern cleanly. **[ship]**
5. **C1–C5 insight callouts on Overview** — turns Overview into a dashboard that
   *talks*. Highest perceived value for the Overview upgrade. **[ship the cheap
   ones: C1, C4, C5; C2/C3 follow once B1/B3 land]**
6. B3 tag uplift, A5 streaks, A6 mood calendar, D1 delta cards — strong follow-ups.

### Placement decision

**Add a dedicated `Mood` tab.** Mood earns its own home: it's a first-class
per-entry field with at least 3–4 distinct chart shapes (trend, day-of-week,
distribution, mood×numeric), which is more than fits cleanly into Consistency or
Numeric. The tab is gated on `hasMood()` so it only appears once any entry has a
recorded mood — matching the existing `needs`-gated Numeric/Tasks tabs.

**Upgrade Overview** with prominent **stat cards** (entry streak, entries this
period, average mood + a tiny mood **sparkline**, tasks completed this period) plus
a small **auto-insights** list (C1/C4/C5). Keep it to a headline glance — the deep
charts stay on their tabs.

### This change ships

- Helpers: `mood_series`, `mood_dow_averages`, `mood_distribution`,
  `mood_by_date`, `mood_numeric_pairs` (B1), and `mood` surfaced in
  `analytics_payload` entries.
- A `Mood` tab with: mood-over-time (+rolling), mood day-of-week, mood
  distribution, mood-vs-numeric scatter.
- An upgraded Overview: stat cards + mood sparkline + a few auto-insights.
