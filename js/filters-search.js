// ===== Filters & Search =====
function hasAnyActiveFilter(){
  try {
    const q = (document.getElementById("searchInput")?.value || "").trim();
    const v = (document.getElementById("vendorFilter")?.value || "");
    const c = (typeof window.ACTIVE_CATEGORY !== "undefined" && window.ACTIVE_CATEGORY)
      ? window.ACTIVE_CATEGORY
      : (document.getElementById("categoryFilter")?.value || "");
    return Boolean(q || v || c);
  } catch {
    return false;
  }
}

function toggleBgHint() {
  try {
    const show = !hasAnyActiveFilter();
    const hint = document.getElementById('bg-hint');
    if (hint) hint.style.display = show ? 'block' : 'none';
  } catch {}
}

function populateVendorFilter(rows) {
  const sel = document.getElementById("vendorFilter");
  if (!sel) return;
  const vendors = Array.from(new Set(rows.map(r => r.vendor).filter(Boolean))).sort((a,b)=>a.localeCompare(b));
  sel.innerHTML = `<option value="">All vendors</option>` + vendors.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
}
function buildCategories(rows) {
  const s = new Set(rows.map(r => r.category || "Misc"));
  const categories = Array.from(s).sort((a,b)=>a.localeCompare(b));
  ALL_CATEGORIES = categories;
  return categories;
}
function populateCategoryFilter(rows) {
  const sel = document.getElementById("categoryFilter");
  if (!sel) return;
  const cats = buildCategories(rows);
  sel.innerHTML = `<option value="">All categories</option>` + cats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
}
function renderCategoryChips() {
  const wrap = document.getElementById("categoryChips");
  if (!wrap) return;

  wrap.innerHTML = "";

  // "All" chip
  const all = document.createElement("button");
  all.className = "chip" + (window.ACTIVE_CATEGORY ? "" : " active");
  all.textContent = "All";
  all.setAttribute("data-cat", "");
  wrap.appendChild(all);

  // Category chips
  for (const c of (window.ALL_CATEGORIES || [])) {
    const btn = document.createElement("button");
    btn.className = "chip" + (c === window.ACTIVE_CATEGORY ? " active" : "");
    btn.textContent = c;
    btn.setAttribute("data-cat", c);
    wrap.appendChild(btn);
  }

  // Click handler (single delegate)
  wrap.onclick = (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;

    window.ACTIVE_CATEGORY = chip.getAttribute("data-cat") || "";
    const sel = document.getElementById("categoryFilter");
    if (sel) sel.value = window.ACTIVE_CATEGORY;

    // If you use the “show only after interaction” gate:
    try { window.USER_INTERACTED = true; } catch {}

    // Visual active state
    Array.from(wrap.querySelectorAll(".chip"))
      .forEach(el => el.classList.toggle("active", el === chip));

    applyFilters({ render: true, sort: "stable" });
  };
}

function refreshCategoriesFromAllRows() {
  const cats = Array.from(new Set((window.ALL_ROWS || []).map(r => r.category || "Misc")))
    .sort((a,b)=>a.localeCompare(b));
  window.ALL_CATEGORIES = cats;
  const sel = document.getElementById("categoryFilter");
  if (sel) {
    sel.innerHTML = `<option value="">All categories</option>` +
      cats.map(c => `<option value="${c}">${c}</option>`).join("");
  }
  renderCategoryChips();
}

function applyFilters(opts = {}){
  try {
    if (RENDER_ONLY_AFTER_INTERACTION && !USER_INTERACTED) {
      showEl && showEl('table-container', false);
      toggleBgHint && toggleBgHint();
      return;
    }
    if (RENDER_ONLY_AFTER_FULL_FETCH && !FULLY_LOADED) {
      showEl && showEl('table-container', false);
      updateDataStatus && updateDataStatus('loading', 'Fetching all records…');
      return;
    }
  } catch(_){}

  const { render = true, sort = "alpha" } = opts;

  // Hide table if nothing is selected/searched
  if (!hasAnyActiveFilter()){
    try {
      const table = document.getElementById('data-table') || ensureTable();
      const tbody = table.querySelector('tbody');
      if (tbody) tbody.innerHTML = '';
      showEl && showEl('table-container', false);
      toggleBgHint && toggleBgHint();
    } catch(_){}
    FILTERED_ROWS = [];
    return;
  } else {
    showEl && showEl("table-container", true);
  }

  const qRaw = (document.getElementById("searchInput")?.value || "").trim();
  const vSel = (document.getElementById("vendorFilter")?.value || "");
  const cSel = ACTIVE_CATEGORY || (document.getElementById("categoryFilter")?.value || "");
  const qObj = parseQuery(qRaw);

  // Compute only — do not touch DOM here
  const filtered = (ALL_ROWS || []).filter(r => {
    // Respect vendor & category even when searching
    if (vSel && r.vendor !== vSel) return false;
    if (cSel && (r.category || "Misc") !== cSel) return false;

    // No search text? pass
    if (!qRaw) return true;

    // Advanced matcher over row
    return rowMatches(r, qObj);
  });

  let arr = filtered.slice();
  if (sort === "alpha"){
    arr.sort((a,b) =>
      (a.category || "").localeCompare(b.category || "") ||
      a.description.localeCompare(b.description) ||
      a.sku.localeCompare(b.sku)
    );
  } else {
    // preserve ingestion order while background pages load
    arr.sort((a,b) => (a._seq || 0) - (b._seq || 0));
  }

  FILTERED_ROWS = arr;
  if (!render) return;

  const table = document.getElementById('data-table') || ensureTable();
  const tbody = table.querySelector('tbody');
  if (tbody) tbody.innerHTML = '';
  renderTableAppendChunked(FILTERED_ROWS, 0);
}
