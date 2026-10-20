/* Keep the completed dropdown in place through task edits and tag filtering. */
(function () {
  "use strict";
  var history = document.getElementById("completed-tasks");
  if (!history) return;
  var key = "datapom.completed-tasks.open";
  try { history.open = sessionStorage.getItem(key) === "1"; } catch (_) {}
  function revealAnchor() {
    if (location.hash === "#completed-tasks") history.open = true;
  }
  revealAnchor();
  window.addEventListener("hashchange", revealAnchor);
  history.addEventListener("toggle", function () {
    try { sessionStorage.setItem(key, history.open ? "1" : "0"); } catch (_) {}
  });
}());
