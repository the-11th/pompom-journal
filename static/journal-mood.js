/* journal-mood.js — click-to-pick mood for the entry form.
   Vanilla JS only, no third-party libraries.

   Seven Pompompurin GIFs (1..7) sit on the "What happened today" line. Mood is
   single-select and optional: click a GIF to select it (CSS dims the other six
   via the picker's `has-selection` class); click the selected one again to
   deselect. The chosen value (1..7, or "") is mirrored into a hidden input
   (name="mood") that posts with the form. The template pre-renders the saved
   state server-side; this script keeps it in sync on interaction.
*/

(function () {
  'use strict';

  var picker = document.querySelector('.mood-picker');
  if (!picker) return;
  var input = document.querySelector('.mood-input');
  if (!input) return;
  var opts = picker.querySelectorAll('.mood-opt');

  function reconcile() {
    var current = (input.value || '').trim();
    var selected = false;
    for (var i = 0; i < opts.length; i++) {
      var on = opts[i].getAttribute('data-mood') === current;
      opts[i].classList.toggle('selected', on);
      opts[i].setAttribute('aria-pressed', String(on));
      selected = selected || on;
    }
    picker.classList.toggle('has-selection', selected);
    if (!selected) input.value = '';
  }

  for (var i = 0; i < opts.length; i++) {
    opts[i].addEventListener('click', function () {
      var value = this.getAttribute('data-mood') || '';
      input.value = input.value === value ? '' : value;
      reconcile();
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  // Reconcile from the hidden input on load (defensive; the template already
  // pre-renders the classes).
  input.addEventListener('change', reconcile);
  reconcile();
})();
