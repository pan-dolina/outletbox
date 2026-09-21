/*
 * One-time code boxes. The six inputs work on their own — this only makes them
 * behave like the single field they replace: one caret that moves by itself,
 * a code that lands in all six boxes however it arrives (typed, pasted or
 * autofilled), and no way to end up with a stray letter in one of them.
 */
(function () {
  'use strict';

  var group = document.querySelector('[data-otp]');
  if (!group) return;
  var boxes = Array.prototype.slice.call(group.querySelectorAll('.otp-box'));
  if (boxes.length < 2) return;
  var form = group.closest('form');
  var submitted = false;

  function digitsOf(text) {
    return String(text == null ? '' : text).replace(/\D+/g, '');
  }

  /** Writes digits into the boxes from `start` on, and returns where the caret ended up. */
  function fill(start, digits) {
    var i = start;
    for (var d = 0; d < digits.length && i < boxes.length; d++, i++) boxes[i].value = digits.charAt(d);
    return Math.min(i, boxes.length - 1);
  }

  function focusBox(index) {
    var box = boxes[index];
    if (!box) return;
    box.focus();
    // Selecting rather than placing a caret means the next keystroke overwrites.
    if (box.select) box.select();
  }

  function complete() {
    return boxes.every(function (b) { return b.value.length === 1; });
  }

  /**
   * Six filled boxes mean the code is typed out in full, so there is nothing
   * left to wait for. Submitting once is guarded: a second submission would
   * spend one of the recipient's limited attempts for nothing.
   */
  function maybeSubmit() {
    if (!form || submitted || !complete()) return;
    submitted = true;
    if (form.requestSubmit) form.requestSubmit();
    else form.submit();
  }

  boxes.forEach(function (box, index) {
    // Whether this insertion carries the whole code or a single keystroke has
    // to be decided before the value changes: afterwards "57" in one box could
    // equally be a pasted pair or a digit typed next to an existing one.
    var bulk = false;

    box.addEventListener('focus', function () { if (box.select) box.select(); });

    box.addEventListener('beforeinput', function (e) {
      bulk = e.inputType === 'insertFromPaste' || digitsOf(e.data).length > 1;
    });

    box.addEventListener('input', function () {
      var digits = digitsOf(box.value);
      if (!digits) { box.value = ''; bulk = false; return; }
      if (bulk) {
        // A password manager or a soft keyboard can drop the entire code into
        // one box; spread it over the rest instead of keeping the first digit.
        bulk = false;
        box.value = '';
        focusBox(fill(index, digits));
      } else {
        // The digit just typed wins over whatever the box held before.
        box.value = digits.charAt(digits.length - 1);
        focusBox(Math.min(index + 1, boxes.length - 1));
      }
      maybeSubmit();
    });

    box.addEventListener('keydown', function (e) {
      if (e.key === 'Backspace' && !box.value && index > 0) {
        e.preventDefault();
        boxes[index - 1].value = '';
        focusBox(index - 1);
      } else if (e.key === 'ArrowLeft' && index > 0) {
        e.preventDefault(); focusBox(index - 1);
      } else if (e.key === 'ArrowRight' && index < boxes.length - 1) {
        e.preventDefault(); focusBox(index + 1);
      } else if (e.key === 'Delete') {
        e.preventDefault(); box.value = '';
      }
    });

    box.addEventListener('paste', function (e) {
      var data = e.clipboardData || window.clipboardData;
      if (!data) return;
      var digits = digitsOf(data.getData('text'));
      if (!digits) return;
      e.preventDefault();
      // A code pasted anywhere in the row starts from the first box: people copy
      // the whole code, and aiming at the right box is not their job.
      focusBox(fill(digits.length >= boxes.length ? 0 : index, digits));
      maybeSubmit();
    });
  });
})();
