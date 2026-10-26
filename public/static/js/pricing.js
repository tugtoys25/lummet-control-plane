/* Accessible product-family filter for pricing cards and comparison rows. */
(function () {
  var select = document.getElementById("pricing-family");
  if (!select) return;
  select.addEventListener("change", function () {
    var value = select.value;
    document.querySelectorAll("[data-pricing-family]").forEach(function (node) {
      node.hidden = value !== "all" && node.getAttribute("data-pricing-family") !== value;
    });
    document.querySelectorAll("[data-comparison-family]").forEach(function (node) {
      node.hidden = value !== "all" && node.getAttribute("data-comparison-family") !== value;
    });
  });
})();
