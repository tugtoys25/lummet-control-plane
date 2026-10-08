/* Scroll-reveal. Content is fully visible without JS (the hiding rule is
   scoped under .js); with reduced-motion or no IntersectionObserver
   everything is shown immediately. */
(function () {
  var els = document.querySelectorAll(".reveal");
  if (!els.length) return;
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || !("IntersectionObserver" in window)) {
    els.forEach(function (el) { el.classList.add("is-visible"); });
    return;
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        io.unobserve(entry.target);
      }
    });
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
  els.forEach(function (el, i) {
    el.style.transitionDelay = Math.min((i % 6) * 60, 300) + "ms";
    io.observe(el);
  });
})();
