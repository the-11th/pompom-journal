// Fitbit sleep sync. Loaded on the journal entry page (auto-syncs + renders the
// read-only sleep panel in place) and on the integrations settings page (wires
// the "Sync now" button). Works with or without a #sleep-panel present.
(function () {
  const panel = document.getElementById("sleep-panel");

  function span(cls, text) {
    const el = document.createElement("span");
    el.className = cls;
    el.textContent = text;
    return el;
  }

  function renderSleep(s) {
    if (!panel || !s) return;  // leave the server-rendered "No sleep data" line
    const dur = `${Math.floor(s.duration_min / 60)}h ${s.duration_min % 60}m`;
    const label = s.score != null ? "Quality" : "Quality (efficiency)";
    // Build via textContent (not innerHTML) so values are never parsed as markup.
    panel.replaceChildren(
      span("sleep-icon", "🛌"),
      span("sleep-times", `${s.start} → ${s.end}`),
      span("sleep-dur", dur),
      span("sleep-qual", `${label} ${s.quality}`),
    );
  }

  function sync(days) {
    const date = panel ? panel.dataset.date : null;
    let url = `/integrations/fitbit/sync?days=${days}`;
    if (date) url += `&date=${date}`;
    return fetch(url, { method: "POST" })
      .then((r) => r.json())
      .then((body) => { if (date && body.sleep && body.sleep[date]) renderSleep(body.sleep[date]); })
      .catch(() => {});
  }

  // Auto-sync on the entry page, throttled to once an hour via the stored last_sync.
  if (panel && panel.dataset.connected === "1") {
    const last = panel.dataset.lastSync;
    const stale = !last || (Date.now() - Date.parse(last)) > 3600 * 1000;
    if (stale) sync(7);
  }

  // "Sync now" buttons: #fitbit-sync-now (settings page, reloads to refresh
  // last-synced) and the optional #fitbit-sync-entry (entry page, in-place).
  document.querySelectorAll("#fitbit-sync-now, #fitbit-sync-entry")
    .forEach((b) => b.addEventListener("click", () => sync(7).then(() => {
      if (b.id === "fitbit-sync-now") location.reload();
    })));
})();
