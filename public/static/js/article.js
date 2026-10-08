/* Article helpers: copy-link button and external links in CMS content. */
(function () {
  var btn = document.querySelector("[data-copy-link]");
  if (btn && navigator.clipboard) {
    btn.addEventListener("click", function () {
      navigator.clipboard.writeText(window.location.href.split("#")[0]).then(function () {
        var original = btn.innerHTML;
        btn.textContent = btn.getAttribute("data-copied") || "";
        setTimeout(function () { btn.innerHTML = original; }, 1800);
      });
    });
  } else if (btn) {
    btn.hidden = true;
  }

  document.querySelectorAll("[data-article-body] a[href^='http']").forEach(function (a) {
    if (a.hostname !== window.location.hostname) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    }
  });
})();
