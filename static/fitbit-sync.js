// Background Fitbit sleep sync on the journal entry page.
(function () {
  const panel = document.getElementById("sleep-panel");
  if (!panel) return;
  const connected = panel.dataset.connected === "1";

  function span(cls, text) {
    const el = document.createElement("span");
    el.className = cls;
    el.textContent = text;
    return el;
  }

  function renderSleep(s) {
    if (!s) return;  // leave the server-rendered "No sleep data" line
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
    const date = panel.dataset.date;
    return fetch(`/integrations/fitbit/sync?days=${days}&date=${date}`,
                 { method: "POST" })
      .then((r) => r.json())
      .then((body) => { if (body.sleep && body.sleep[date]) renderSleep(body.sleep[date]); })
      .catch(() => {});
  }

  // Throttle the auto-sync to once an hour using the stored last_sync.
  if (connected) {
    const last = panel.dataset.lastSync;
    const stale = !last || (Date.now() - Date.parse(last)) > 3600 * 1000;
    if (stale) sync(7);
  }

  // "Sync now" buttons (entry page + settings page) force a refresh.
  document.querySelectorAll("#fitbit-sync-now, #fitbit-sync-entry")
    .forEach((b) => b.addEventListener("click", () => sync(7).then(() => {
      if (b.id === "fitbit-sync-now") location.reload();
    })));
})();
