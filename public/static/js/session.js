/* Signed-in staff get their dashboard link in place of the sign-in link.
   Pages are cached and shared, so the page itself never changes; this asks
   a tiny per-visitor endpoint and rewrites the sign-in links in place.
   Label and target come from the page (data attributes filled from the
   database). Without them, or if the request fails, nothing changes. */
(function () {
  var header = document.querySelector("[data-site-header]");
  if (!header || !window.fetch) return;
  var label = header.getAttribute("data-signed-in-label");
  var href = header.getAttribute("data-signed-in-href");
  if (!label || !href) return;
  function links() {
    var all = header.querySelectorAll("a[href]");
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var path = (all[i].getAttribute("href") || "").split(/[?#]/)[0];
      if (path === "/login") out.push(all[i]);
    }
    return out;
  }

  var targets = links();
  if (!targets.length) return;

  fetch("/session-status", { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (!data || data.signedIn !== true) return;
      for (var i = 0; i < targets.length; i++) {
        targets[i].textContent = label;
        targets[i].setAttribute("href", href);
        targets[i].setAttribute("data-signed-in", "");
      }
    })
    .catch(function () { /* leave the link as it is */ });
})();
