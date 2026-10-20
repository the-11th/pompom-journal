/* Prevent duplicate page-changing POSTs while retaining normal form data. */
(function () {
  'use strict';
  var pending = new Map();

  function restore(form, state) {
    if (state.busy === null) form.removeAttribute('aria-busy');
    else form.setAttribute('aria-busy', state.busy);
    form.inert = state.inert;
    state.buttons.forEach(function (item) { item.node.disabled = item.disabled; });
    pending.delete(form);
  }

  window.addEventListener('submit', function (event) {
    var form = event.target;
    if (event.defaultPrevented || !(form instanceof HTMLFormElement) || form.method.toLowerCase() !== 'post' || (form.target && form.target !== '_self')) return;
    if (pending.has(form)) { event.preventDefault(); return; }
    var state = {busy: form.getAttribute('aria-busy'), inert: form.inert, buttons: []};
    pending.set(form, state); form.setAttribute('aria-busy', 'true');
    // Wait for the next task: microtasks can run before the browser captures
    // the submitter's name/value and would remove it by disabling its button.
    setTimeout(function () {
      if (event.defaultPrevented) { restore(form, state); return; }
      if (pending.get(form) !== state) return;
      state.buttons = Array.from(form.elements).filter(function (control) { return control.type === 'submit' || control.type === 'image'; })
        .map(function (node) { return {node: node, disabled: node.disabled}; });
      state.buttons.forEach(function (item) { item.node.disabled = true; });
      form.inert = true;
    }, 0);
  });

  window.addEventListener('pageshow', function () {
    pending.forEach(function (state, form) { restore(form, state); });
  });
})();
