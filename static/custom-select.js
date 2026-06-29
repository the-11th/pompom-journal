/* Custom themed dropdown — replaces the native <select> popup (which can't be
 * styled) with a dark popover consistent with the app's panels.
 *
 * Progressive enhancement: the real <select> stays in the DOM (hidden but still
 * named, so form submission is unchanged) and is the single source of truth.
 * Selecting an option sets select.value and dispatches a native 'change' event,
 * so existing listeners (e.g. the recurrence custom_n toggle) keep working.
 *
 * Auto-enhances every <select> on the page on DOMContentLoaded. Mark a select
 * with `data-no-enhance` to opt out.
 */
(function () {
  "use strict";

  var _open = null;   // currently-open .custom-select, if any

  function closeOpen() {
    if (_open) {
      _open.classList.remove("is-open");
      _open.querySelector(".cs-popover").hidden = true;
      _open.querySelector(".cs-trigger").setAttribute("aria-expanded", "false");
      _open = null;
    }
  }

  function labelFor(select) {
    var opt = select.options[select.selectedIndex];
    return opt ? opt.textContent : "";
  }

  function enhance(select) {
    if (select.dataset.enhanced || select.hasAttribute("data-no-enhance")) return;
    select.dataset.enhanced = "1";

    var wrap = document.createElement("div");
    wrap.className = "custom-select";
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);              // keep the real select inside, hidden
    select.classList.add("cs-native");

    var trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "cs-trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    var valueSpan = document.createElement("span");
    valueSpan.className = "cs-value";
    valueSpan.textContent = labelFor(select);
    var caret = document.createElement("span");
    caret.className = "cal-caret";
    caret.textContent = "▾";        // ▾, same caret as other controls
    trigger.appendChild(valueSpan);
    trigger.appendChild(caret);
    wrap.appendChild(trigger);

    var popover = document.createElement("div");
    popover.className = "cs-popover";
    popover.setAttribute("role", "listbox");
    popover.hidden = true;

    Array.prototype.forEach.call(select.options, function (opt, i) {
      var item = document.createElement("button");
      item.type = "button";
      item.className = "cs-option" + (i === select.selectedIndex ? " is-selected" : "");
      item.setAttribute("role", "option");
      item.textContent = opt.textContent;
      item.addEventListener("click", function (e) {
        e.stopPropagation();
        select.value = opt.value;
        valueSpan.textContent = opt.textContent;
        popover.querySelectorAll(".cs-option").forEach(function (o) {
          o.classList.remove("is-selected");
        });
        item.classList.add("is-selected");
        select.dispatchEvent(new Event("change", { bubbles: true }));
        closeOpen();
      });
      popover.appendChild(item);
    });
    wrap.appendChild(popover);

    trigger.addEventListener("click", function (e) {
      e.stopPropagation();
      var isOpen = _open === wrap;
      closeOpen();
      if (!isOpen) {
        wrap.classList.add("is-open");
        popover.hidden = false;
        trigger.setAttribute("aria-expanded", "true");
        _open = wrap;
      }
    });

    // Keep the trigger label in sync if the value changes programmatically.
    select.addEventListener("change", function () {
      valueSpan.textContent = labelFor(select);
    });
  }

  // Exposed so selects created dynamically after load (e.g. inside a popup)
  // can be themed on demand, not just those present at DOMContentLoaded.
  window.enhanceSelect = enhance;

  document.addEventListener("click", closeOpen);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeOpen();
  });

  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll("select").forEach(enhance);
  });
}());
