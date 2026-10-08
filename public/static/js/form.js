/* Form helper: prevents double submits and shows the "sending" label
   (text comes from the page, i.e. from the database). The form works
   fully without this script. */
(function () {
  document.querySelectorAll("form[data-form]").forEach(function (form) {
    form.addEventListener("submit", function () {
      if (!form.checkValidity()) return;
      var btn = form.querySelector("button[type=submit]");
      if (!btn || btn.disabled) return;
      var label = form.getAttribute("data-sending");
      if (label) btn.textContent = label;
      setTimeout(function () { btn.disabled = true; }, 0);
    });
  });
})();
