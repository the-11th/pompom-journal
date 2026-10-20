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
    if (!s) { panel.replaceChildren(span("muted", "No sleep data for this day")); return; }
    const kids = [icon("sleep")];
    if (s.start && s.end) kids.push(span("sleep-times", `${s.start} → ${s.end}`));
    if (Number.isFinite(s.duration_min)) {
      const minutes = Math.round(s.duration_min);
      kids.push(span("sleep-dur", `${Math.floor(minutes / 60)}h ${minutes % 60}m`));
    }
    if (Number.isFinite(s.quality)) kids.push(span("sleep-qual", `Quality ${s.quality}`));
    panel.replaceChildren(...kids);
  }
  function renderRescuetime(panel, r) {
    if (!r) { panel.replaceChildren(span("muted", "No RescueTime data for this day")); return; }
    const kids = [icon("rescuetime")];
    if (Number.isFinite(r.pulse)) kids.push(span("rt-pulse", `Pulse ${r.pulse}`));
    if (Number.isFinite(r.productive_min)) {
      const minutes = Math.round(r.productive_min);
      kids.push(span("rt-prod", `${Math.floor(minutes / 60)}h ${minutes % 60}m productive`));
    }
    panel.replaceChildren(...kids);
  }
  function renderMusic(panel, m) {
    if (!m) { panel.replaceChildren(span("muted", "No listening data for this day")); return; }
    const kids = [icon("music"),
                  span("music-min", `${m.minutes} min`),
                  span("music-tracks", `${m.tracks} tracks`)];
    if (m.top_artists && m.top_artists[0]) kids.push(span("music-artist", m.top_artists[0].name));
    if (m.source === "history_import") kids.push(span("muted", "Imported history"));
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

  function showStatus(p, panel, message) {
    let status = document.getElementById(`${p.name}-sync-status`);
    if (!status && message) {
      status = document.createElement("p");
      status.id = `${p.name}-sync-status`;
      status.className = "integration-sync-status";
      status.setAttribute("role", "status");
      const card = p.buttons[0]?.closest(".integration-card");
      if (card) card.appendChild(status);
      else if (panel) panel.after(status);
      else p.buttons[0]?.after(status);
    }
    if (status) { status.textContent = message; status.hidden = !message; }
  }

  function sync(p, panel, manual = false) {
    if (p.pending) return p.pending;
    const date = panel ? panel.dataset.date : null;
    let url = `${p.syncPath}?days=7`;
    if (date) url += `&date=${encodeURIComponent(date)}`;
    if (manual) url += "&force=1";
    p.buttons.forEach(button => { button.disabled = true; button.textContent = "Syncing…"; });
    showStatus(p, panel, "");
    p.pending = fetch(url, { method: "POST" })
      .then((r) => {
        if (!r.ok) throw new Error("Sync failed");
        return r.json();
      })
      .then((body) => {
        if (!body || body.ok === false) throw new Error("Sync failed");
        if (body.connected === false) { showStatus(p, panel, "Reconnect to sync"); return false; }
        const bag = body[p.key];
        if (date && bag && Object.prototype.hasOwnProperty.call(bag, date)) p.render(panel, bag[date]);
        if (body.errors?.length) { showStatus(p, panel, "Some days could not sync · try again"); return false; }
        if (panel) panel.dataset.lastSync = new Date().toISOString();
        return true;
      })
      .catch(() => { showStatus(p, panel, "Sync failed · try again"); return false; })
      .finally(() => {
        p.pending = null;
        p.buttons.forEach(button => { button.disabled = false; button.textContent = "Sync now"; });
      });
    return p.pending;
  }

  PROVIDERS.forEach((p) => {
    const panel = document.getElementById(p.panelId);
    p.buttons = Array.from(document.querySelectorAll(`#${p.name}-sync-now`));
    if (panel && panel.dataset.connected === "1") {
      const last = panel.dataset.lastSync;
      const stale = !Number.isFinite(Date.parse(last)) || (Date.now() - Date.parse(last)) > 3600 * 1000;
      if (stale) sync(p, panel);
    }
    // "Sync now" button on the settings page (and optional entry button).
    p.buttons.forEach((b) =>
      b.addEventListener("click", () => sync(p, panel, true).then((saved) => { if (saved) location.reload(); })));
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
