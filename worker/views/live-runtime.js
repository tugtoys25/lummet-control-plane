// =====================================================
// LIVE RUNTIME (browser): keeps marked regions up to date without reloading the page.
//
//   <tbody data-live-src="/api/organizations/ID/sites/live-rows" data-live-hash="...">
//
// The endpoint answers { success, data: { html, hash, busy } }. The runtime polls it, swaps the region's content only when the hash changed,
// polls quickly (4 s) while the server says something is in flight and slowly (30 s) otherwise, stops while the tab is hidden and checks
// at once when it becomes visible again, backs off after errors, never replaces a region while the person is typing in it, and gives up
// quietly (one reload to reach the login page) when the session has ended. Handlers inside a swapped region keep working because every
// action is a delegated data-onclick (see csp.js). Same-origin fetch only; the response is data, the html comes from our own renderer.
// =====================================================
export const LIVE_RUNTIME = `
(function () {
  var FAST = 4000, SLOW = 30000, MAX_BACKOFF = 300000;
  var regions = [];

  function typing(el) {
    var a = document.activeElement;
    return !!(a && el.contains(a) && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName));
  }

  function start(el) {
    if (el.__live) return;
    var src = el.getAttribute('data-live-src');
    if (!src) return;
    var state = { el: el, src: src, hash: el.getAttribute('data-live-hash') || '', timer: null, inflight: false, fails: 0, stopped: false, pending: false };
    el.__live = state;
    regions.push(state);
    schedule(state, SLOW);
  }

  function schedule(s, ms) {
    clearTimeout(s.timer);
    if (s.stopped || document.hidden) return;
    s.timer = setTimeout(function () { tick(s); }, ms);
  }

  function tick(s) {
    if (s.stopped) return;
    if (document.hidden) return;
    if (s.inflight) { s.pending = true; return; }
    s.inflight = true;
    var next = SLOW;
    fetch(s.src, { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function (r) {
        if (r.status === 401) { s.stopped = true; location.reload(); return null; }
        if (r.status === 403 || r.status === 404) { s.stopped = true; return null; }
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
      })
      .then(function (body) {
        if (!body) return;
        s.fails = 0;
        var d = body && body.success && body.data;
        if (!d || typeof d.html !== 'string') return;
        if (d.hash !== s.hash) {
          if (typing(s.el)) { next = FAST; return; }
          s.el.innerHTML = d.html;
          s.hash = d.hash;
          s.el.setAttribute('data-live-hash', d.hash);
          try { s.el.dispatchEvent(new CustomEvent('lummet:live', { bubbles: true })); } catch (_) {}
        }
        next = d.busy ? FAST : SLOW;
      })
      .catch(function () { s.fails += 1; next = Math.min(MAX_BACKOFF, SLOW * Math.pow(2, s.fails)); })
      .then(function () {
        s.inflight = false;
        var again = s.pending; s.pending = false;
        schedule(s, again ? 0 : next);
      });
  }

  function refresh(el) {
    regions.forEach(function (s) { if (!el || s.el === el || el.contains(s.el)) { clearTimeout(s.timer); tick(s); } });
  }

  document.addEventListener('visibilitychange', function () {
    regions.forEach(function (s) { if (document.hidden) clearTimeout(s.timer); else if (!s.stopped) { clearTimeout(s.timer); tick(s); } });
  });
  window.addEventListener('online', function () { regions.forEach(function (s) { if (!s.stopped) { s.fails = 0; tick(s); } }); });

  window.lummetLiveRefresh = refresh;
  window.lummetLiveStart = start;

  function init() { Array.prototype.forEach.call(document.querySelectorAll('[data-live-src]'), start); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
`;
