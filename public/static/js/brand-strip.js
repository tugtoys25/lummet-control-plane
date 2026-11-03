// Pause / resume for the moving brand strip (WCAG 2.2.2). Motion also stops on hover and keyboard focus (CSS) and for reduced-motion users.
(function () {
  var btn = document.getElementById("brand-strip-pause");
  var box = document.getElementById("brand-marquee");
  if (!btn || !box) return;
  btn.addEventListener("click", function () {
    var paused = box.classList.toggle("is-paused");
    btn.setAttribute("aria-pressed", paused ? "true" : "false");
  });
})();
