/* Live task badges. Keep the tiers in sync with todo.time_remaining and Android. */
(function () {
  'use strict';

  function remaining(due, now) {
    // Date-only values mean local midnight, just like the server's ISO parser.
    const value = /^\d{4}-\d{2}-\d{2}$/.test(due) ? due + 'T00:00:00' : due;
    const seconds = (Date.parse(value) - now) / 1000;
    if (!Number.isFinite(seconds)) return { text: '', overdue: false };
    if (seconds <= 0) {
      const past = -seconds;
      const text = past >= 86400 ? `overdue by ${Math.floor(past / 86400)} day(s)`
        : past >= 3600 ? `overdue by ${Math.floor(past / 3600)} hour(s)` : 'overdue';
      return { text, overdue: true };
    }
    return { text: seconds >= 172800 ? `${Math.floor(seconds / 86400)} day(s) left`
      : seconds >= 3600 ? `${Math.floor(seconds / 3600)} hour(s) left` : 'due soon', overdue: false };
  }

  function refresh() {
    if (document.hidden) return;
    const now = Date.now();
    document.querySelectorAll('[data-task-due]').forEach(badge => {
      const state = remaining(badge.dataset.taskDue, now);
      if (badge.textContent !== state.text) badge.textContent = state.text;
      badge.classList.toggle('overdue', state.overdue);
    });
  }

  refresh();
  window.setInterval(refresh, 30000);
  window.addEventListener('focus', refresh);
  window.addEventListener('pageshow', refresh);
  document.addEventListener('visibilitychange', refresh);
})();
