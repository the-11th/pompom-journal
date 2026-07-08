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

  // Themed line icons — mirror of templates/_integ_icons.html (used when a panel
  // is re-rendered after an auto-sync). Keep the paths in sync with that macro.
  const SVGNS = "http://www.w3.org/2000/svg";
  const ICON_PATHS = {
    sleep: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
    rescuetime: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 1.5"/>',
    music: '<path d="M5 15v-3a7 7 0 0 1 14 0v3"/><rect x="3" y="14.5" width="4.2" height="6" rx="1.6"/><rect x="16.8" y="14.5" width="4.2" height="6" rx="1.6"/>',
  };
  function icon(name) {
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("class", "integ-icon integ-icon-" + name);
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = ICON_PATHS[name] || "";
    return svg;
  }

  // ---- per-provider render functions (panel row) ----
  function renderSleep(panel, s) {
    if (!s) return;
    const dur = `${Math.floor(s.duration_min / 60)}h ${s.duration_min % 60}m`;
    panel.replaceChildren(
      icon("sleep"),
      span("sleep-times", `${s.start} → ${s.end}`),
      span("sleep-dur", dur),
      span("sleep-qual", `Quality ${s.quality}`));
  }
  function renderRescuetime(panel, r) {
    if (!r) return;
    panel.replaceChildren(
      icon("rescuetime"),
      span("rt-pulse", `Pulse ${r.pulse}`),
      span("rt-prod", `${Math.round(r.productive_min / 60 * 10) / 10}h productive`));
  }
  function renderMusic(panel, m) {
    if (!m) return;
    const kids = [icon("music"),
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

  // Entry form: collapse the tracked-data panels behind the caret next to
  // "What happened today". Closed by default; the caret rotates when open.
  const integToggle = document.getElementById("integ-toggle");
  const integPanels = document.getElementById("integ-panels");
  if (integToggle && integPanels) {
    integToggle.addEventListener("click", () => {
      const willOpen = integPanels.hasAttribute("hidden");
      integPanels.toggleAttribute("hidden");
      integToggle.setAttribute("aria-expanded", willOpen ? "true" : "false");
    });
  }
})();
