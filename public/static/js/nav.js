/* Header behaviour: mobile menu, theme toggle, scrolled state. */
(function () {
  var header = document.querySelector("[data-site-header]");
  var toggle = document.querySelector("[data-nav-toggle]");
  var menu = document.querySelector("[data-mobile-menu]");
  var themeBtn = document.querySelector("[data-theme-toggle]");

  // The header is sticky below an optional announcement bar, so the menu can start well below the top of
  // the screen. Size it to the space that is actually left, otherwise its last links fall off-screen.
  function fitMenu() {
    if (!menu || menu.hidden) return;
    var vh = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
    var room = vh - menu.getBoundingClientRect().top - (window.matchMedia("(min-width: 900px)").matches ? 16 : 0);
    menu.style.maxHeight = Math.max(160, Math.floor(room)) + "px";
  }

  function setMenu(open) {
    if (!toggle || !menu) return;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", (open ? toggle.getAttribute("data-label-close") : toggle.getAttribute("data-label-open")) || "");
    menu.hidden = !open;
    // Only the full-screen mobile sheet locks page scrolling; the desktop panel is a small popover.
    if (open) { fitMenu(); } else { menu.style.maxHeight = ""; }
    document.body.style.overflow = open && !window.matchMedia("(min-width: 900px)").matches ? "hidden" : "";
  }

  if (toggle && menu) {
    window.addEventListener("resize", fitMenu);
    if (window.visualViewport) window.visualViewport.addEventListener("resize", fitMenu);
    window.addEventListener("scroll", fitMenu, { passive: true });
    toggle.addEventListener("click", function () {
      setMenu(toggle.getAttribute("aria-expanded") !== "true");
    });
    menu.addEventListener("click", function (e) {
      if (e.target.closest("a")) setMenu(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && toggle.getAttribute("aria-expanded") === "true") { setMenu(false); toggle.focus(); }
    });
    document.addEventListener("click", function (e) {
      if (toggle.getAttribute("aria-expanded") === "true" && !menu.contains(e.target) && !toggle.contains(e.target)) setMenu(false);
    });
    window.matchMedia("(min-width: 900px)").addEventListener("change", function () {
      if (toggle.getAttribute("aria-expanded") === "true") setMenu(true);
    });
  }

  if (themeBtn) {
    themeBtn.addEventListener("click", function () {
      var next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
      if (window.__setTheme) window.__setTheme(next);
    });
  }

  if (header) {
    var onScroll = function () { header.classList.toggle("is-scrolled", window.scrollY > 8); };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }
})();
