/* Theme bootstrap — runs synchronously in <head> so the correct theme is
   applied before first paint (no flash). Follows the OS until the visitor
   picks one; the choice is kept in this browser only. */
(function () {
  var root = document.documentElement;
  var saved = null;
  try { saved = localStorage.getItem("lummet-theme"); } catch (e) {}
  var dark = saved ? saved === "dark" : window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
  root.setAttribute("data-theme", dark ? "dark" : "light");
  root.className += " js";
  window.__setTheme = function (theme) {
    root.setAttribute("data-theme", theme);
    try { localStorage.setItem("lummet-theme", theme); } catch (e) {}
  };
})();
