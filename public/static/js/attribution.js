// Where did this enquiry come from? Fills the hidden _attr field of a form with the campaign tags in the address (utm_source,
// utm_medium, utm_campaign) and the site that sent the visitor. Done in the browser because form pages are cached and shared:
// the server must not put one visitor's source into a page another visitor receives.
(function () {
  var fields = document.querySelectorAll('input[name="_attr"]');
  if (!fields.length) return;
  var params = new URLSearchParams(location.search);
  var parts = [];
  [["utm_source", "source"], ["utm_medium", "medium"], ["utm_campaign", "campaign"]].forEach(function (pair) {
    var v = params.get(pair[0]);
    if (v) parts.push(pair[1] + "=" + v.replace(/[;=]/g, " ").slice(0, 80));
  });
  try {
    var host = document.referrer && new URL(document.referrer).hostname;
    if (host && host !== location.hostname) parts.push("referrer=" + host);
  } catch (e) { /* no usable referrer */ }
  var value = parts.join(";");
  for (var i = 0; i < fields.length; i++) fields[i].value = value;
})();
