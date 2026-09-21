/* outletbox admin panel uploader. No external scripts: tus-js-client is served from this instance. */
(function () {
  'use strict';

  var cfgEl = document.getElementById('outletbox-config');
  if (!cfgEl) return;
  var cfg = JSON.parse(cfgEl.textContent);
  var M = cfg.i18n || {};
  function msg(key, params) {
    var s = M[key] || key;
    Object.keys(params || {}).forEach(function (k) { s = s.replace('{' + k + '}', params[k]); });
    return s;
  }
  // The session cookie is SameSite=Lax, so a cross-site POST never carries it;
  // the header is the synchroniser token the server checks on top of that.
  var headers = { 'X-CSRF-Token': cfg.csrfToken };

  var dropzone = document.getElementById('dropzone');
  var input = document.getElementById('file-input');
  var queue = document.getElementById('queue');
  if (!dropzone || !input || !queue) return;

  var active = 0;
  var succeeded = 0;

  function fmtSize(b) {
    if (b == null) return '—';
    if (b < 1024) return b + ' B';
    var u = ['KB', 'MB', 'GB', 'TB'], v = b / 1024, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : Math.round(v)) + ' ' + u[i];
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function parseError(err) {
    // tus-js-client wraps HTTP errors; the server returns JSON {error, message}.
    var res = err && err.originalResponse;
    if (res) {
      try {
        var body = JSON.parse(res.getBody());
        if (body && body.message) return body.message + ' (HTTP ' + res.getStatus() + ')';
      } catch (e) { /* not JSON */ }
      return 'HTTP ' + res.getStatus();
    }
    return (err && err.message) || String(err);
  }

  /** Reloads only once the whole queue is idle: a reload mid-upload would abort it. */
  function settle() {
    active--;
    if (active === 0 && succeeded > 0) window.location.reload();
  }

  function enqueue(file) {
    var li = el('li');
    var head = el('div', 'q-head');
    var name = el('span', 'q-name', file.name);
    var status = el('span', 'q-status', msg('upload.js.queued'));
    head.appendChild(name); head.appendChild(status);
    var bar = document.createElement('progress'); bar.max = 100; bar.value = 0;
    var actions = el('div', 'q-actions');
    var cancelBtn = el('button', 'btn btn-small', msg('common.cancel')); cancelBtn.type = 'button';
    var retryBtn = el('button', 'btn btn-small', msg('common.retry')); retryBtn.type = 'button'; retryBtn.hidden = true;
    actions.appendChild(cancelBtn); actions.appendChild(retryBtn);
    li.appendChild(head); li.appendChild(bar); li.appendChild(actions);
    queue.insertBefore(li, queue.firstChild);

    var sizeNote = ' (' + fmtSize(file.size) + ')';
    if (file.size > cfg.maxFileBytes) {
      status.textContent = msg('upload.js.too_large', { max: fmtSize(cfg.maxFileBytes) }) + sizeNote;
      status.className = 'q-status error'; cancelBtn.hidden = true; bar.remove();
      return;
    }

    // The last PATCH is "sent" well before the server has finished with it: the object
    // store still has to accept the final part and the app writes the row. A full,
    // frozen bar during that window is indistinguishable from a stalled upload, so the
    // bar goes indeterminate (it visibly keeps moving) until onSuccess fires.
    var lastPct = 0;
    function showProgress(pct) {
      li.classList.remove('finalising');
      bar.value = pct;
    }
    function showFinalising() {
      if (li.classList.contains('finalising')) return;
      li.classList.add('finalising');
      bar.removeAttribute('value'); // native indeterminate <progress>
      status.textContent = msg('upload.js.finalising');
      status.className = 'q-status';
    }

    active++;
    var upload = new tus.Upload(file, {
      endpoint: cfg.tusEndpoint,
      headers: headers,
      chunkSize: cfg.chunkSize,
      retryDelays: [0, 1000, 3000, 5000, 10000, 20000],
      storeFingerprintForResuming: true,
      removeFingerprintOnSuccess: true,
      metadata: { filename: file.name, filetype: file.type || 'application/octet-stream', caseId: cfg.caseId },
      onShouldRetry: function (err) {
        var st = err.originalResponse ? err.originalResponse.getStatus() : 0;
        // 4xx are final (limits, closed case, conflict); network errors / 5xx are retried.
        return !(st >= 400 && st < 500);
      },
      onError: function (err) {
        showProgress(lastPct); // back to a determinate bar: nothing is in flight any more
        status.textContent = msg('upload.js.error', { msg: parseError(err) });
        status.className = 'q-status error';
        retryBtn.hidden = false; cancelBtn.hidden = true;
        settle();
      },
      onProgress: function (sent, total) {
        var pct = total ? Math.floor(sent * 100 / total) : 0;
        lastPct = pct;
        if (total && sent >= total) { showFinalising(); return; }
        showProgress(pct);
        status.textContent = pct + '% · ' + fmtSize(sent) + ' / ' + fmtSize(total);
        status.className = 'q-status';
      },
      onSuccess: function () {
        li.classList.add('done');
        showProgress(100);
        status.textContent = msg('upload.js.done') + sizeNote;
        status.className = 'q-status done';
        cancelBtn.hidden = true; retryBtn.hidden = true;
        succeeded++;
        settle();
      },
    });

    cancelBtn.addEventListener('click', function () {
      showProgress(lastPct);
      upload.abort(true).then(function () {
        status.textContent = msg('upload.js.cancelled'); status.className = 'q-status error'; cancelBtn.hidden = true; settle();
      }).catch(function () { status.textContent = msg('upload.js.cancelled_local'); status.className = 'q-status error'; cancelBtn.hidden = true; settle(); });
    });
    retryBtn.addEventListener('click', function () {
      retryBtn.hidden = true; cancelBtn.hidden = false; status.className = 'q-status'; status.textContent = msg('upload.js.retrying');
      showProgress(lastPct);
      active++;
      startOrResume();
    });

    function startOrResume() {
      // Resume: tus-js-client remembers upload URLs per file fingerprint (name+size+mtime+endpoint) in localStorage.
      upload.findPreviousUploads().then(function (previous) {
        if (previous.length) {
          upload.resumeFromPreviousUpload(previous[0]);
          status.textContent = msg('upload.js.resuming');
        } else {
          status.textContent = msg('upload.js.starting');
        }
        upload.start();
      }).catch(function () { upload.start(); });
    }
    startOrResume();
  }

  function handleFiles(list) {
    Array.prototype.forEach.call(list, enqueue);
  }

  input.addEventListener('change', function () { handleFiles(input.files); input.value = ''; });
  ['dragenter', 'dragover'].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.add('dragover'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    dropzone.addEventListener(ev, function (e) { e.preventDefault(); dropzone.classList.remove('dragover'); });
  });
  dropzone.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
  });
  dropzone.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });
})();
