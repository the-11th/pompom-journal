/* journal-sections.js — drag-and-drop tag reassignment on the manage page.
   Vanilla JS only, no third-party libraries (native HTML5 Drag and Drop API).

   Each tag section has two drop zones:
     - Permanent (.perm-zone): the section's master `tags` list.
     - Temporary (.temp-zone): tags derived from entries but not in the master.

   Dragging a chip from one zone and dropping it on the other reassigns it:
     - Temporary -> Permanent: POST the zone's data-promote-url (add_section_tag).
     - Permanent -> Temporary: POST the zone's data-demote-url (demote_section_tag).
   Dropping onto the same zone the chip came from is a no-op.

   On drop we build a tiny POST form and submit it; the server-rendered app uses
   Post/Redirect/Get, so the page reloads with the zones re-derived correctly.
   This is a progressive enhancement: the in-chip ↑/× buttons remain the
   keyboard/no-drag fallback and are untouched.
*/

(function () {
  'use strict';

  var dragged = null;  // the chip element currently being dragged

  // Compare against saved names, so edits in another unsaved form do not make
  // an existing name appear available before its rename is committed.
  var sectionNames = Array.from(document.querySelectorAll('.manage-section[data-section-name]')).map(function (section) {
    return { id: section.dataset.section, name: section.dataset.sectionName.trim().toLowerCase() };
  });
  document.querySelectorAll('[data-unique-section-name]').forEach(function (input) {
    var owner = input.closest('.manage-section');
    function validateName() {
      var value = input.value.trim().toLowerCase();
      var duplicate = sectionNames.some(function (section) { return section.name === value && (!owner || section.id !== owner.dataset.section); });
      input.setCustomValidity(duplicate ? 'Section name already exists.' : '');
    }
    input.addEventListener('input', validateName);
    input.addEventListener('change', validateName);
    if (input.form) input.form.addEventListener('reset', function () { setTimeout(validateName, 0); });
    validateName();
  });

  function canDrop(zone) {
    if (!dragged) return false;
    var origin = dragged.closest('.tag-zone');
    return origin && origin.getAttribute('data-section') === zone.getAttribute('data-section') &&
      dragged.getAttribute('data-origin') !== zone.getAttribute('data-zone');
  }

  function urlFor(zone, attr, tag) {
    var tpl = zone.getAttribute(attr);
    if (!tpl) return null;
    // Templates carry a literal "__TAG__" placeholder (url_for-encoded).
    return tpl.replace('__TAG__', encodeURIComponent(tag));
  }

  function submitPost(url) {
    var form = document.createElement('form');
    form.method = 'post';
    form.action = url;
    document.body.appendChild(form);
    form.submit();
  }

  function onDrop(zone, ev) {
    ev.preventDefault();
    zone.classList.remove('drag-over');
    if (!canDrop(zone)) return;
    var origin = dragged.getAttribute('data-origin');
    var target = zone.getAttribute('data-zone');
    var tag = dragged.getAttribute('data-tag');
    if (!tag || origin === target) return;  // same zone -> no-op
    var url = (target === 'permanent')
      ? urlFor(zone, 'data-promote-url', tag)
      : urlFor(zone, 'data-demote-url', tag);
    if (url) submitPost(url);
  }

  var chips = document.querySelectorAll('.tag-zone .perm-chip[draggable="true"]');
  for (var i = 0; i < chips.length; i++) {
    chips[i].addEventListener('dragstart', function (ev) {
      dragged = this;
      this.classList.add('dragging');
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', this.getAttribute('data-tag') || '');
      }
    });
    chips[i].addEventListener('dragend', function () {
      this.classList.remove('dragging');
      document.querySelectorAll('.tag-zone.drag-over').forEach(function (zone) { zone.classList.remove('drag-over'); });
      dragged = null;
    });
  }

  var zones = document.querySelectorAll('.tag-zone');
  for (var z = 0; z < zones.length; z++) {
    (function (zone) {
      zone.addEventListener('dragover', function (ev) {
        if (!canDrop(zone)) return;
        ev.preventDefault();
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
        zone.classList.add('drag-over');
      });
      zone.addEventListener('dragleave', function (ev) {
        // Ignore leaves into descendant elements.
        if (ev.relatedTarget && zone.contains(ev.relatedTarget)) return;
        zone.classList.remove('drag-over');
      });
      zone.addEventListener('drop', function (ev) { onDrop(zone, ev); });
    })(zones[z]);
  }
})();
