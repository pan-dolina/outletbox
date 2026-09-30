/* outletbox admin panel: copy-to-clipboard and confirmation dialogs. */
(function () {
  'use strict';
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var src = btn.closest('.copy-row, .snippet').querySelector('[data-copy-source]');
      var text = src.tagName === 'INPUT' ? src.value : src.textContent;
      navigator.clipboard.writeText(text).then(function () {
        var old = btn.textContent; btn.textContent = document.body.dataset.copied || 'Copied'; setTimeout(function () { btn.textContent = old; }, 1500);
      }).catch(function () { src.select && src.select(); });
    });
  });
  // Picking an address group copies its members into the form's address list and
  // clears the picker, so the administrator sees who is being added (and can
  // strike someone out) before submitting. Addresses already listed are skipped.
  var groupsEl = document.getElementById('outletbox-groups');
  var groups = groupsEl ? JSON.parse(groupsEl.textContent) : {};
  document.querySelectorAll('select[data-group-fill]').forEach(function (select) {
    select.addEventListener('change', function () {
      var lines = groups[select.value];
      var area = select.form && select.form.querySelector('textarea[name="recipients"]');
      if (!lines || !area) return;
      var present = {};
      (area.value.match(/[^\s<>,;"]+@[^\s<>,;"]+/g) || []).forEach(function (a) { present[a.toLowerCase()] = true; });
      var fresh = lines.split('\n').filter(function (line) { return !present[line.split(' ')[0]]; });
      if (fresh.length) area.value = area.value.replace(/\s+$/, '') + (area.value.trim() ? '\n' : '') + fresh.join('\n');
      select.value = '';
      area.focus();
    });
  });
  document.querySelectorAll('form[data-confirm]').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      if (!window.confirm(form.getAttribute('data-confirm'))) e.preventDefault();
    });
  });
})();
