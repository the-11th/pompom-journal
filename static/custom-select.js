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
  var _nextId = 0;

  function positionOpen() {
    if (!_open) return;
    var trigger = _open.querySelector('.cs-trigger'), popover = _open.querySelector('.cs-popover');
    var box = trigger.getBoundingClientRect(), gutter = document.body.classList.contains('media-mobile') ? 18 : 16;
    var below = innerHeight - box.bottom - gutter - 4, above = box.top - gutter - 4;
    popover.style.minWidth = Math.min(box.width, innerWidth - 2 * gutter) + 'px';
    popover.style.maxWidth = (innerWidth - 2 * gutter) + 'px';
    popover.style.maxHeight = Math.max(44, Math.min(280, Math.max(below, above))) + 'px';
    var width = popover.offsetWidth, height = popover.offsetHeight;
    popover.style.left = Math.max(gutter, Math.min(box.left, innerWidth - width - gutter)) + 'px';
    var top = below >= height || below >= above ? box.bottom + 4 : box.top - height - 4;
    popover.style.top = Math.max(gutter, Math.min(top, innerHeight - height - gutter)) + 'px';
  }

  function closeOpen(restoreFocus) {
    if (_open) {
      var trigger = _open.querySelector(".cs-trigger");
      _open.classList.remove("is-open");
      _open.querySelector(".cs-popover").hidden = true;
      trigger.setAttribute("aria-expanded", "false");
      _open = null;
      if (restoreFocus) trigger.focus();
    }
  }

  function labelFor(select) {
    var opt = select.options[select.selectedIndex];
    return opt ? opt.textContent : "";
  }

  function enhance(select) {
    if (select.dataset.enhanced || select.hasAttribute("data-no-enhance")) return;
    select.dataset.enhanced = "1";

    var fieldLabel = select.getAttribute("aria-label") || Array.from(select.labels || []).map(function (label) {
      var copy = label.cloneNode(true);
      copy.querySelectorAll("select").forEach(function (el) { el.remove(); });
      return copy.textContent.trim();
    }).join(" ") || (select.name || "Choose an option").replace(/[_:]/g, " ");

    var wrap = document.createElement("div");
    wrap.className = "custom-select";
    select.parentNode.insertBefore(wrap, select);
    wrap.appendChild(select);              // keep the real select inside, hidden
    select.classList.add("cs-native");
    select.tabIndex = -1;
    select.setAttribute("aria-hidden", "true");

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
    popover.id = "cs-options-" + (++_nextId);
    popover.setAttribute("role", "listbox");
    popover.setAttribute("aria-label", fieldLabel);
    trigger.setAttribute("aria-controls", popover.id);
    popover.hidden = true;

    function sync() {
      valueSpan.textContent = labelFor(select);
      trigger.setAttribute("aria-label", fieldLabel + ": " + labelFor(select));
      trigger.disabled = select.matches(":disabled");
      popover.querySelectorAll(".cs-option").forEach(function (item, i) {
        var selected = i === select.selectedIndex;
        var opt = select.options[i];
        item.classList.toggle("is-selected", selected);
        item.setAttribute("aria-selected", String(selected));
        item.disabled = opt.disabled || (opt.parentElement.tagName === "OPTGROUP" && opt.parentElement.disabled);
        item.hidden = opt.hidden;
      });
      if (trigger.disabled && _open === wrap) closeOpen();
    }

    function buildOptions() {
      popover.innerHTML = "";
      Array.prototype.forEach.call(select.options, function (opt, i) {
        var item = document.createElement("button");
        item.type = "button";
        item.tabIndex = -1;
        item.className = "cs-option";
        item.setAttribute("role", "option");
        item.textContent = opt.textContent;
        item.addEventListener("click", function (e) {
          e.stopPropagation();
          if (item.disabled || select.matches(":disabled")) return;
          select.selectedIndex = i;
          sync();
          closeOpen(true);
          select.dispatchEvent(new Event("change", { bubbles: true }));
        });
        popover.appendChild(item);
      });
      sync();
    }
    buildOptions();
    wrap.appendChild(popover);

    function choices() { return Array.from(popover.querySelectorAll(".cs-option:not(:disabled):not([hidden])")); }

    function open() {
      sync();
      if (trigger.disabled) return;
      closeOpen();
      wrap.classList.add("is-open");
      popover.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      _open = wrap;
      positionOpen();
      var options = choices();
      var selected = options.find(function (item) { return item.classList.contains("is-selected"); });
      (selected || options[0] || trigger).focus();
    }

    trigger.addEventListener("click", function (e) {
      e.stopPropagation();
      var isOpen = _open === wrap;
      closeOpen();
      if (!isOpen) open();
    });

    var search = "", searchTimer;
    wrap.addEventListener("keydown", function (e) {
      if (e.key === "Tab") {
        if (_open === wrap) closeOpen(true);
        return;
      }
      if (e.key === "Escape" && _open === wrap) {
        e.preventDefault(); e.stopImmediatePropagation(); closeOpen(true); return;
      }
      var isArrow = e.key === "ArrowDown" || e.key === "ArrowUp";
      var isEdge = e.key === "Home" || e.key === "End";
      var isText = e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey;
      if (!isArrow && !isEdge && !isText) return;
      e.preventDefault();
      var wasOpen = _open === wrap;
      if (!wasOpen) open();
      var options = choices();
      if (!options.length) return;
      var index = options.indexOf(document.activeElement);
      if (isArrow && wasOpen) index = (index + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
      if (isEdge) index = e.key === "Home" ? 0 : options.length - 1;
      if (isText) {
        clearTimeout(searchTimer);
        search += e.key.toLowerCase();
        searchTimer = setTimeout(function () { search = ""; }, 600);
        var match = options.findIndex(function (item) { return item.textContent.trim().toLowerCase().startsWith(search); });
        if (match >= 0) index = match;
      }
      if (index >= 0) options[index].focus();
    });

    wrap.addEventListener("focusout", function () {
      setTimeout(function () { if (_open === wrap && !wrap.contains(document.activeElement)) closeOpen(); }, 0);
    });
    select.addEventListener("focus", function () { trigger.focus(); });
    select.addEventListener("change", sync);
    if (select.form) select.form.addEventListener("reset", function () { setTimeout(sync, 0); });
    new MutationObserver(buildOptions).observe(select, { attributes: true, childList: true, subtree: true, characterData: true });
  }

  // Exposed so selects created dynamically after load (e.g. inside a popup)
  // can be themed on demand, not just those present at DOMContentLoaded.
  window.enhanceSelect = enhance;

  document.addEventListener("click", function () { closeOpen(); });
  window.addEventListener('resize', positionOpen);
  document.addEventListener('scroll', positionOpen, true);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && _open) {
      e.preventDefault(); e.stopImmediatePropagation(); closeOpen(true);
    }
  });

  document.addEventListener("DOMContentLoaded", function () {
    document.querySelectorAll("select").forEach(enhance);
  });
}());
