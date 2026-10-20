/* Keep browser constraint checks, with feedback in the app's own theme. */
(function () {
  'use strict';
  var messages = new WeakMap(), nextId = 0;

  function fieldName(field) {
    return field.getAttribute('aria-label') || Array.from(field.labels || []).map(function (label) {
      var copy = label.cloneNode(true);
      copy.querySelectorAll('input, select, textarea, button, .custom-select, .dt-field').forEach(function (node) { node.remove(); });
      return copy.textContent.trim();
    }).join(' ') || field.placeholder || (field.name || 'This field').replace(/[_:]/g, ' ');
  }

  function messageFor(field) {
    var name = fieldName(field), validity = field.validity;
    if (validity.valueMissing || (field.required && !field.value.trim())) return name + ' is required.';
    if (validity.customError) return field.validationMessage;
    if (validity.patternMismatch && field.dataset.validationMessage) return name + ': ' + field.dataset.validationMessage;
    if (validity.rangeUnderflow) return name + ': use ' + field.min + ' or more.';
    if (validity.rangeOverflow) return name + ': use ' + field.max + ' or less.';
    if (validity.typeMismatch && field.type === 'email') return name + ': enter an email address.';
    if (validity.typeMismatch && field.type === 'url') return name + ': enter a full URL.';
    if (validity.badInput || validity.stepMismatch) return name + ': enter a valid number.';
    return name + ': check this value.';
  }

  function clear(form) {
    var state = messages.get(form);
    if (!state) return;
    state.marked.forEach(function (item) {
      if (item.invalid === null) item.node.removeAttribute('aria-invalid');
      else item.node.setAttribute('aria-invalid', item.invalid);
      var description = (item.node.getAttribute('aria-describedby') || '').split(/\s+/).filter(function (id) { return id && id !== state.message.id; }).join(' ');
      if (description) item.node.setAttribute('aria-describedby', description);
      else item.node.removeAttribute('aria-describedby');
    });
    state.message.remove();
    messages.delete(form);
  }

  document.addEventListener('invalid', function (event) {
    var field = event.target, form = field.form;
    if (!form) return;
    event.preventDefault();
    var first = Array.from(form.elements).find(function (input) { return input.willValidate && !input.validity.valid; });
    if (field !== first) return;
    clear(form);
    var message = document.createElement('p');
    message.className = 'flash form-validation';
    message.id = 'form-validation-' + (++nextId);
    message.setAttribute('role', 'alert');
    message.textContent = messageFor(field);
    form.after(message);
    var wrapper = field.closest('.custom-select, .dt-field');
    var focusTarget = wrapper ? wrapper.querySelector('.cs-trigger') : field;
    var marked = [field];
    if (focusTarget !== field) marked.push(focusTarget);
    marked = marked.map(function (node) {
      var invalid = node.getAttribute('aria-invalid');
      node.setAttribute('aria-invalid', 'true');
      node.setAttribute('aria-describedby', [node.getAttribute('aria-describedby'), message.id].filter(Boolean).join(' '));
      return { node: node, invalid: invalid };
    });
    messages.set(form, { field: field, message: message, marked: marked });
    focusTarget.focus();
  }, true);

  function corrected(event) {
    var form = event.target.form, state = form && messages.get(form);
    if (state && state.field.validity.valid) clear(form);
  }
  document.addEventListener('input', corrected);
  document.addEventListener('change', corrected);
  document.addEventListener('submit', function (event) { clear(event.target); }, true);
  document.addEventListener('reset', function (event) { clear(event.target); });
})();
