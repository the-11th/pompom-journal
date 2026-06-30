# Leading-Indicators Analytics — Design

**Date:** 2026-06-30
**Status:** Approved (brainstorming complete)
**Scope:** Spec 3 of a 3-feature sequence (`#numeric` inline capture → `[]` inline
task spawning → **this**). Journal analytics only; new pure helpers + a new
analytics tab. No data-model change, no new deps.

## Summary

A new analysis answering **"what predicts *tomorrow's* mood?"** For each candidate
predictor measured on day *D*, correlate it against the target (mood) on day
*D+lag* and rank the strongest **leading** indicators:

> "Nights under ~6h sleep → next-day mood **−0.7** (r=−0.52, n=23)."
> "Higher productivity today → tomorrow's mood **+0.4** (r=0.38, n=19)."

It is the *lagged* cousin of the existing same-day Overview drivers board, and is
only cheap because every stream (mood, numeric sections, sleep, productivity,
music, tags, tasks) lives in one date-keyed store. A **lag-profile** chart shows
*where* an effect peaks (same-day vs genuinely predictive), keeping the feature
honest.

## Locked decisions (from brainstorming)

1. **Target = mood (1–7)** for v1. Helpers take a `target` argument shaped so a
   future target (e.g. productivity pulse) slots in; the UI exposes only mood now.
2. **Predictors = continuous + categorical.**
   - **Continuous** (lagged Pearson): each numeric section `("numeric", sid)`;
     sleep `("sleep","hours")` / `("sleep","quality")`; productivity
     `("rescuetime","pulse")` / `("rescuetime","productive_min")`; music
     `("music","minutes")` / `("music","valence")`. A predictor is only offered
     when that stream is present in range.
   - **Categorical** (lagged mean-difference / "uplift"): **tag presence** ("day
     after a `work` tag: mood −0.4") and **hard-task-done** ("day after finishing
     a hard task: mood +0.3"). Reuses the same-day `mood_tag_uplift` /
     difficulty-effect logic, shifted by `lag`.
3. **Lag = selectable (0–3) with a lag-profile chart.** Default `lag=1`. A themed
   selector switches the board's lag; the per-indicator detail shows a lag-profile
   (r at each lag 0–3) so the user sees whether the relationship is contemporaneous
   or predictive.
4. **Placement = new "Leading" tab**, Journal lens, gated on `hasMood` **and** ≥2
   available predictor streams **and** ≥`min_n` paired days for at least one
   predictor (else the tab is hidden, matching other gated tabs).

## Honesty guardrails

- Every row/point shows **`n` and `r`**; nothing is reported below `min_n`
  (default 5) paired days.
- Ranked by `|r|` magnitude; **no significance claims**, no p-values.
- A persistent quiet footnote: "Correlation, not causation. Lag = N day(s)."
- Pearson returns None on n<2 / zero variance (existing `_pearson`), so degenerate
  predictors drop out cleanly.

## Pure helpers (`journal.py`, zero Flask; injectable date bounds)

Reuse `_pearson`, `_filter_entries_by_date`, `mood_by_date`, and the
`_entry_sleep/_entry_rescuetime/_entry_music/_entry_mood` readers.

```python
def _predictor_by_date(entries, predictor, start, end):
    """{date: float} for a continuous predictor descriptor, over date-filtered
    entries that have a usable value. Dispatches on predictor[0]:
      ("numeric", sid)        -> entry["numbers"][sid]
      ("sleep", "hours")      -> _entry_sleep(e)["duration_min"]/60
      ("sleep", "quality")    -> _entry_sleep(e)["quality"]
      ("rescuetime", field)   -> _entry_rescuetime(e)[field]
      ("music", "minutes")    -> _entry_music(e)["minutes"]
      ("music", "valence")    -> _entry_music(e)["valence"]  (None-safe)
    """

def _shift_date(d, days):  # "YYYY-MM-DD" + days -> "YYYY-MM-DD"

def lagged_pairs(pred_by_date, target_by_date, lag):
    """[(x, y)] where x=pred_by_date[D] and y=target_by_date[D+lag] both exist."""

def lagged_correlation(entries, predictor, target="mood", lag=1,
                       start=None, end=None):
    """{r, n} for one continuous predictor at `lag` (r via _pearson, or None)."""

def lagged_tag_uplift(entries, target="mood", lag=1, start=None, end=None,
                      min_n=2):
    """[{name, section_id, after_mean, baseline, uplift, n}] — mean target on
    days AFTER a tag appears vs the baseline mean, per tag. Lagged sibling of
    mood_tag_uplift; sorted by |uplift|."""

def lagged_difficulty_effect(entries, tasks, target="mood", lag=1,
                             start=None, end=None, min_n=2):
    """{after_mean, baseline, uplift, n} — mean target the day AFTER a hard task
    was completed vs other days. (Task completion dates come from the task
    payload already merged into analytics; see Route below.)"""

def leading_indicators(entries, target="mood", lag=1, start=None, end=None,
                       min_n=5, tasks=None):
    """Ranked [{label, kind, key, r|uplift, n, direction}] merging continuous
    (lagged_correlation over every available predictor) and categorical
    (lagged_tag_uplift, lagged_difficulty_effect) effects. Drops rows below
    min_n. Sorted by effect magnitude desc. `kind` in
    {"numeric","sleep","rescuetime","music","tag","difficulty"} for origin marks.
    """

def lag_profile(entries, predictor, target="mood", lags=(0, 1, 2, 3),
                start=None, end=None):
    """[{lag, r, n}] for one predictor across lags — powers the lag-profile chart.
    Accepts a continuous predictor descriptor OR a tag/difficulty key (uses the
    uplift magnitude in place of r for categorical)."""
```

All categorical/continuous predictor magnitudes are normalized to a comparable
0–1 scale for ranking only (|r| for continuous; |uplift|/6 for mood-uplift), with
the **raw** `r`/`uplift` + `n` shown in the row text.

## Payload (`analytics_payload`)

No new per-entry fields are needed — every stream (`mood`, `numbers`, `sleep`,
`rescuetime`, `music`) is already carried per entry, and the task payload (with
completion dates + difficulty) is already merged for the Task lens. The
leading-indicators tab is computed **client-side** from the existing payload,
mirroring how Sleep/Productivity/Music tabs already work (JS mirrors of the pure
helpers). The Python helpers above exist for **unit-test parity** and to keep the
algorithm authoritative/testable, matching the established pattern.

## Client (`static/analytics.js`)

A new tab, `lens: ["journal"]`, gated as in §4. Rendered bespoke (like the Tags
tab) rather than a single `CHARTS` descriptor, because it has its own controls:

- **Lag selector** — themed segmented control (0/1/2/3), default 1; reuses the
  `.kind-toggle` pattern (no native `<select>`). Changing it recomputes the board.
- **Leading-indicator board** — ranked rows reusing `.drivers-list`/`.driver-*`
  styling: each row origin-marked by `kind` (☑ task/difficulty, ● journal-section
  color, stream glyphs for sleep/productivity/music), shows the phrased effect +
  `r`/`uplift` + `n`, and is **clickable** to select it for the detail panel.
- **Detail panel** for the selected indicator:
  - lagged **scatter** (predictor[D] vs mood[D+lag]) with least-squares line +
    Pearson `r` — reuses existing scatter/regression utilities;
  - **lag-profile** mini-chart (r at lag 0–3) highlighting the peak lag.
- **Footnote**: "Correlation, not causation. Lag = N day(s)."

JS-side mirrors of `laggedPairs` / `laggedCorrelation` / `leadingIndicators` /
`lagProfile` join the existing `pearson`/`isoShift`/`linearRegression` mirrors.
Shares the page date-range filter and section-scope state where relevant.

## Edge cases

- **Sparse data:** any predictor with < `min_n` lagged pairs is omitted; if no
  predictor qualifies, the tab is hidden.
- **Gaps in journaling:** lag pairing is by **calendar date** (D and D+lag must
  both have entries with the values); missing days simply yield fewer pairs — no
  interpolation.
- **Zero variance** (e.g. constant predictor): `_pearson` → None → row dropped.
- **Mood nulls:** excluded (mood readers already skip null).
- **Music valence unavailable** (audio-features 403): the `("music","valence")`
  predictor produces no pairs and is omitted; `("music","minutes")` still works.
- **Multiple-comparisons caveat:** acknowledged via the footnote and the `n`/`r`
  display; we intentionally do not auto-declare "significant."

## Testing (TDD; fixed `now`, `tmp_path`)

`tests/test_journal_analytics.py`:
- `_shift_date` / `lagged_pairs`: correct D→D+lag pairing, only when both exist,
  lag=0 degenerates to same-day.
- `lagged_correlation`: known-pairs r matches `_pearson`; n correct; lag shifts.
- `lagged_tag_uplift` / `lagged_difficulty_effect`: after-mean vs baseline, min_n
  gating, lag shifting.
- `leading_indicators`: ranks by magnitude, drops sub-`min_n`, merges kinds,
  hidden when nothing qualifies.
- `lag_profile`: r per lag, peak identifiable.

`tests/test_journal_app.py`:
- `/journal/analytics/data` payload unchanged-but-sufficient (carries the streams
  the JS needs); a smoke assertion that nothing regressed.

## README cheat-sheet (Task #4, this slice)

The "Special features / power input" section is about input grammar, so this
analytics feature gets a one-line mention under a short **"Analytics highlights"**
note instead (or is simply documented in the analytics section of the README) —
final placement decided when the README edit lands.

## Out of scope

- Targets other than mood (productivity/numeric) — code-ready, UI deferred.
- Multivariate / regression-model prediction; significance testing.
- Forecasting future mood; alerts/notifications.
- Lags > 3 days or weekly aggregation.
