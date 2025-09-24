/* recompute-paint-safely-after-adding-windowrows.js
   - Exposes window.recomputePaintAfterAppend()
   - Never touches bare FILTERED_ROWS at top-level (avoids ReferenceError)
*/
(function () {
  "use strict";

  // Ensure globals exist without throwing even if not declared yet
  if (!("ALL_ROWS" in window)) window.ALL_ROWS = [];
  if (!("FILTERED_ROWS" in window)) window.FILTERED_ROWS = [];

  // Safe accessors / stubs
  function getFiltered() {
    if (!Array.isArray(window.FILTERED_ROWS)) window.FILTERED_ROWS = [];
    return window.FILTERED_ROWS;
  }
  const hasAnyActiveFilter = (typeof window.hasAnyActiveFilter === "function")
    ? window.hasAnyActiveFilter : function () { return false; };
  const applyFilters = (typeof window.applyFilters === "function")
    ? window.applyFilters : function () {};
  const ensureTable = (typeof window.ensureTable === "function")
    ? window.ensureTable : function () { return document.getElementById("data-table"); };
  const renderTableAppend = (typeof window.renderTableAppend === "function")
    ? window.renderTableAppend : function () {};
  const renderTableAppendChunked = (typeof window.renderTableAppendChunked === "function")
    ? window.renderTableAppendChunked : function () {};

  // Call this right after you push new rows into ALL_ROWS
  window.recomputePaintAfterAppend = function () {
    const hadActive = hasAnyActiveFilter();
    const beforeLen = getFiltered().length;

    // Recompute only — do not paint inside applyFilters
    try {
      applyFilters({ render: false, sort: "stable" });
    } catch (e) {
      console.error("[recomputePaintAfterAppend] applyFilters error", e);
    }

    const filteredNow = getFiltered();

    if (hadActive) {
      // Full repaint so nothing stale during active filters/search
      const table = document.getElementById("data-table") || ensureTable();
      const tbody = table && table.querySelector("tbody");
      if (tbody) tbody.innerHTML = "";
      renderTableAppendChunked(filteredNow, 0);
    } else {
      // Infinite scroll path: append only the new tail
      const afterLen = filteredNow.length;
      const delta = (afterLen > beforeLen) ? filteredNow.slice(beforeLen) : [];
      renderTableAppend(delta);
    }
  };
})();
