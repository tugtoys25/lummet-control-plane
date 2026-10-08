/* Brand category filter. The chips ship `hidden` and are revealed here,
   so with JS disabled visitors simply see the full list. */
(function () {
  var bar = document.querySelector("[data-filter-bar]");
  var grid = document.querySelector("[data-filter-grid]");
  if (!bar || !grid) return;
  bar.hidden = false;
  var chips = bar.querySelectorAll("[data-filter]");
  var cards = grid.querySelectorAll("[data-category]");

  bar.addEventListener("click", function (e) {
    var chip = e.target.closest("[data-filter]");
    if (!chip) return;
    var value = chip.getAttribute("data-filter");
    chips.forEach(function (c) {
      var on = c === chip;
      c.classList.toggle("is-active", on);
      c.setAttribute("aria-pressed", String(on));
    });
    cards.forEach(function (card) {
      card.hidden = value !== "" && card.getAttribute("data-category") !== value;
    });
  });
})();
