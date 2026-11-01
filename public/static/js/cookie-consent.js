/* Cookie consent: shows the banner until the visitor chooses, remembers the choice in a first-party cookie, and lets any
   [data-cookie-settings] control reopen it. Text, links, lifetime and on/off all come from the page (see worker/cookie-consent.js). */
(function () {
  var banner = document.getElementById("lummet-cookie-banner");
  if (!banner) return;
  var name = banner.getAttribute("data-cookie-name") || "lummet_cookie_consent";
  var days = parseInt(banner.getAttribute("data-cookie-days"), 10) || 180;

  function read() {
    var m = document.cookie.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]*)"));
    return m ? decodeURIComponent(m[1]) : null;
  }
  function write(value) {
    var secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie = name + "=" + encodeURIComponent(value) + "; Max-Age=" + days * 86400 + "; Path=/; SameSite=Lax" + secure;
  }
  function announce(choice) {
    try { document.dispatchEvent(new CustomEvent("lummet:cookie-consent", { detail: { choice: choice } })); } catch (e) {}
  }
  function open() { banner.hidden = false; var b = banner.querySelector("[data-cookie-choice]"); if (b) b.focus({ preventScroll: true }); }
  function close() { banner.hidden = true; }

  window.lummetCookieConsent = { get: read, open: open };

  banner.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-cookie-choice]");
    if (!btn) return;
    var choice = btn.getAttribute("data-cookie-choice");
    write(choice);
    close();
    announce(choice);
  });
  document.addEventListener("click", function (e) {
    if (e.target.closest("[data-cookie-settings]")) { e.preventDefault(); open(); }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !banner.hidden && read()) close();
  });

  var existing = read();
  if (existing) announce(existing); else banner.hidden = false;
})();
