/* Themed color fields. The original input remains the form's source of truth. */
(function (global) {
  'use strict';
  var open = null, nextId = 0;
  function hex(value) {
    var text = String(value || '').trim().replace(/^#/, '').toLowerCase();
    if (/^[0-9a-f]{3}$/.test(text)) text = text.split('').map(function (c) { return c + c; }).join('');
    return /^[0-9a-f]{6}$/.test(text) ? '#' + text : null;
  }
  function close(restore) {
    if (!open) return;
    var previous = open;
    open = null;
    previous.popup.hidden = true;
    previous.trigger.setAttribute('aria-expanded', 'false');
    if (restore && previous.trigger.isConnected) previous.trigger.focus();
  }
  function position() {
    if (!open) return;
    var box = open.trigger.getBoundingClientRect(), popup = open.popup;
    var width = popup.offsetWidth, height = popup.offsetHeight;
    var gutter = document.body.classList.contains('media-mobile') ? 18 : 8;
    popup.style.left = Math.max(gutter, Math.min(box.left, innerWidth - width - gutter)) + 'px';
    popup.style.top = Math.max(gutter, Math.min(box.bottom + 4, innerHeight - height - gutter)) + 'px';
  }
  function enhance(input) {
    if (input.dataset.colorEnhanced || input.type !== 'color') return;
    input.dataset.colorEnhanced = '1';
    var name = input.getAttribute('aria-label') || Array.from(input.labels || []).map(function (label) {
      var copy = label.cloneNode(true);
      copy.querySelectorAll('input, button').forEach(function (el) { el.remove(); });
      return copy.textContent.trim();
    }).join(' ') || 'Color';
    var wrap = document.createElement('span');
    wrap.className = 'color-field';
    input.before(wrap); wrap.append(input);
    input.classList.add('color-native');
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');
    input.addEventListener('click', function (event) { event.preventDefault(); });
    var trigger = document.createElement('button');
    trigger.type = 'button'; trigger.className = 'color-trigger';
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-expanded', 'false');
    var swatch = document.createElement('span');
    swatch.className = 'color-swatch'; swatch.setAttribute('aria-hidden', 'true');
    trigger.append(swatch);
    var popup = document.createElement('div');
    popup.className = 'color-popover'; popup.hidden = true;
    popup.id = 'color-popover-' + (++nextId);
    popup.setAttribute('role', 'dialog'); popup.setAttribute('aria-label', name);
    trigger.setAttribute('aria-controls', popup.id);
    var palette = document.createElement('div'); palette.className = 'color-palette';
    var label = document.createElement('div'); label.className = 'color-hex';
    var caption = document.createElement('span'); caption.textContent = 'Hex';
    var edit = document.createElement('input'); edit.type = 'text'; edit.spellcheck = false;
    edit.setAttribute('aria-label', 'Hex color'); edit.autocomplete = 'off'; edit.maxLength = 7;
    label.append(caption, edit);
    var error = document.createElement('p'); error.className = 'color-error'; error.hidden = true;
    error.id = popup.id + '-error'; error.setAttribute('role', 'alert');
    edit.setAttribute('aria-describedby', error.id);
    var actions = document.createElement('div'); actions.className = 'color-actions';
    var cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
    var apply = document.createElement('button'); apply.type = 'button'; apply.textContent = 'Apply';
    actions.append(cancel, apply); popup.append(palette, label, error, actions); wrap.append(trigger, popup);
    function clearError() { error.hidden = true; edit.removeAttribute('aria-invalid'); }
    function sync() {
      var value = hex(input.value);
      swatch.style.setProperty('--chosen-color', value);
      trigger.setAttribute('aria-label', name + ': ' + value);
      trigger.title = name + ': ' + value;
      trigger.disabled = input.matches(':disabled');
      if (open && open.trigger === trigger && trigger.disabled) close();
      if (popup.hidden) edit.value = value;
    }
    function commit(value) {
      var chosen = hex(value);
      if (!chosen) {
        error.textContent = 'Use a hex color, like #e0a955.'; error.hidden = false;
        edit.setAttribute('aria-invalid', 'true'); edit.focus(); position(); return;
      }
      close(true); clearError();
      if (input.value !== chosen) {
        input.value = chosen;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
      sync();
    }
    function fillPalette() {
      palette.replaceChildren();
      var styles = getComputedStyle(document.documentElement);
      var colors = ['--accent', '--danger', '--location-laptop', '--text', '--muted', '--panel'].map(function (key) { return hex(styles.getPropertyValue(key)); });
      document.querySelectorAll('input[type="color"]').forEach(function (field) { colors.push(hex(field.value)); });
      Array.from(new Set(colors.filter(Boolean))).slice(0, 12).forEach(function (value) {
        var choice = document.createElement('button'); choice.type = 'button'; choice.className = 'color-swatch';
        choice.style.setProperty('--chosen-color', value); choice.title = value;
        choice.setAttribute('aria-label', 'Use ' + value);
        choice.setAttribute('aria-pressed', String(input.value === value));
        choice.onclick = function () { commit(value); }; palette.append(choice);
      });
    }
    trigger.onclick = function () {
      if (open && open.trigger === trigger) { close(true); return; }
      close(); sync(); if (trigger.disabled) return;
      clearError(); edit.value = input.value; fillPalette();
      popup.hidden = false; trigger.setAttribute('aria-expanded', 'true');
      open = { popup: popup, trigger: trigger, wrap: wrap };
      position();
      var selected = palette.querySelector('[aria-pressed="true"]') || palette.querySelector('button');
      if (document.body.classList.contains('media-mobile') && selected) selected.focus();
      else { edit.focus(); edit.select(); }
    };
    cancel.onclick = function () { close(true); };
    apply.onclick = function () { commit(edit.value); };
    edit.oninput = clearError;
    edit.onkeydown = function (event) { if (event.key === 'Enter') { event.preventDefault(); commit(edit.value); } };
    input.addEventListener('input', sync); input.addEventListener('change', sync);
    new MutationObserver(sync).observe(input, { attributes: true, attributeFilter: ['disabled', 'value'] });
    if (input.form) input.form.addEventListener('reset', function () { close(); setTimeout(sync, 0); });
    wrap.addEventListener('focusout', function (event) {
      if (open && open.wrap === wrap && event.relatedTarget && !wrap.contains(event.relatedTarget)) close();
    });
    sync();
  }
  document.addEventListener('click', function (event) { if (open && !open.wrap.contains(event.target)) close(); });
  document.addEventListener('keydown', function (event) {
    if (open && event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(true); }
  }, true);
  global.addEventListener('resize', position);
  document.addEventListener('scroll', position, true);
  global.enhanceColor = enhance;
  function init() { document.querySelectorAll('input[type="color"]').forEach(enhance); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(window);
