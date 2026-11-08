/* Pricing page: instant Monthly/Yearly switch and the accessible product-family filter.
   Both billing periods are already in the page (hidden), so switching is a local show/hide: no request, no reload, no scroll jump.
   Without scripts the two chips are ordinary links to /pricing and /pricing?billing=annual, so nothing depends on this file. */
(function () {
  var chips = document.querySelectorAll("[data-period]");
  var panels = document.querySelectorAll("[data-period-panel]");
  if (chips.length && panels.length) {
    var show = function (period) {
      var known = false;
      panels.forEach(function (p) { if (p.getAttribute("data-period-panel") === period) known = true; });
      if (!known) return false;
      panels.forEach(function (p) { p.hidden = p.getAttribute("data-period-panel") !== period; });
      chips.forEach(function (c) {
        var on = c.getAttribute("data-period") === period;
        c.classList.toggle("is-active", on);
        if (on) c.setAttribute("aria-current", "true"); else c.removeAttribute("aria-current");
      });
      return true;
    };
    chips.forEach(function (chip) {
      chip.addEventListener("click", function (e) {
        // Let the browser handle modified clicks (new tab, etc.) and anything unexpected exactly as a normal link.
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        var period = chip.getAttribute("data-period");
        if (!show(period)) return;
        e.preventDefault();
        try { // keep the address shareable: /pricing or /pricing?billing=annual (other params, such as ?family=, are kept)
          var u = new URL(window.location.href);
          if (period === "annual") u.searchParams.set("billing", "annual"); else u.searchParams.delete("billing");
          history.replaceState(null, "", u.pathname + u.search + u.hash);
        } catch (_) { /* the switch itself already worked */ }
      });
    });
  }

  var select = document.getElementById("pricing-family");
  if (!select) return;
  function apply() {
    var value = select.value;
    document.querySelectorAll("[data-pricing-family]").forEach(function (node) {
      node.hidden = value !== "all" && node.getAttribute("data-pricing-family") !== value;
    });
    document.querySelectorAll("[data-comparison-family]").forEach(function (node) {
      node.hidden = value !== "all" && node.getAttribute("data-comparison-family") !== value;
    });
  }
  select.addEventListener("change", apply);
  if (select.value !== "all") apply(); // /pricing?family=<slug> opens with that family selected
})();
