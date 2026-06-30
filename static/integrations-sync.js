// Per-provider integration sync. On the journal entry page each connected
// provider auto-syncs (throttled 1h) and re-renders its panel row in place;
// on the settings page the "#<provider>-sync-now" buttons force a sync.
(function () {
  function span(cls, text) {
    const el = document.createElement("span");
    el.className = cls;
    el.textContent = text;
    return el;
  }

  // ---- per-provider render functions (panel row) ----
  function renderSleep(panel, s) {
    if (!s) return;
    const dur = `${Math.floor(s.duration_min / 60)}h ${s.duration_min % 60}m`;
    const label = s.score != null ? "Quality" : "Quality (efficiency)";
    panel.replaceChildren(
      span("sleep-icon", "🛌"),
      span("sleep-times", `${s.start} → ${s.end}`),
      span("sleep-dur", dur),
      span("sleep-qual", `${label} ${s.quality}`));
  }
  function renderRescuetime(panel, r) {
    if (!r) return;
    panel.replaceChildren(
      span("rt-icon", "⏱"),
      span("rt-pulse", `Pulse ${r.pulse}`),
      span("rt-prod", `${Math.round(r.productive_min / 60 * 10) / 10}h productive`));
  }
  function renderMusic(panel, m) {
    if (!m) return;
    const kids = [span("music-icon", "🎧"),
                  span("music-min", `${m.minutes} min`),
                  span("music-tracks", `${m.tracks} tracks`)];
    if (m.top_artists && m.top_artists[0]) kids.push(span("music-artist", m.top_artists[0].name));
    panel.replaceChildren(...kids);
  }

  const PROVIDERS = [
    { name: "google", panelId: "sleep-panel", key: "sleep",
      syncPath: "/integrations/google/sync", render: renderSleep },
    { name: "rescuetime", panelId: "rescuetime-panel", key: "data",
      syncPath: "/integrations/rescuetime/sync", render: renderRescuetime },
    { name: "spotify", panelId: "spotify-panel", key: "music",
      syncPath: "/integrations/spotify/sync", render: renderMusic },
  ];

  function sync(p, panel) {
    const date = panel ? panel.dataset.date : null;
    let url = `${p.syncPath}?days=7`;
    if (date) url += `&date=${date}`;
    return fetch(url, { method: "POST" })
      .then((r) => r.json())
      .then((body) => {
        const bag = body[p.key];
        if (date && bag && bag[date]) p.render(panel, bag[date]);
      })
      .catch(() => {});
  }

  PROVIDERS.forEach((p) => {
    const panel = document.getElementById(p.panelId);
    if (panel && panel.dataset.connected === "1") {
      const last = panel.dataset.lastSync;
      const stale = !last || (Date.now() - Date.parse(last)) > 3600 * 1000;
      if (stale) sync(p, panel);
    }
    // "Sync now" button on the settings page (and optional entry button).
    document.querySelectorAll(`#${p.name}-sync-now`).forEach((b) =>
      b.addEventListener("click", () => sync(p, panel).then(() => location.reload())));
  });
})();
