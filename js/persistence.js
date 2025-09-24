// ===== Persistence =====
const STORAGE_KEY = "vanir_cart_v1";
let _restoreCache = null;

function serializeState() {
  return {
    cart: Array.from(CART.entries()).map(([key, item]) => ({
      key,
      qty: item.qty,
      unitBase: item.unitBase,
      marginPct: Math.max(0, Number(item.marginPct ?? DEFAULT_PRODUCT_MARGIN_PCT) || 0),
      row: {
        vendor: item?.row?.vendor ?? "",
        sku: item?.row?.sku ?? "",
        uom: item?.row?.uom ?? "",
        description: item?.row?.description ?? "",
        price: item?.row?.price,
        priceExtended: item?.row?.priceExtended,
        category: item?.row?.category ?? "Misc",
      },
    })),
    labor: LABOR_LINES.map(l => ({
      id: l.id,
      rate: Number(l.rate) || 0,
      qty: Math.max(0, Math.floor(Number(l.qty ?? 0) || 0)), // allow 0
      name: l.name || "Labor line",
      marginPct: Math.max(0, Number(l.marginPct) || 0), // percentage
    })),
    laborIdSeq: typeof _laborIdSeq === "number" ? _laborIdSeq : 1,
    activeCategory: ACTIVE_CATEGORY
  };
}
function persistState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(serializeState())); } catch (e) {}
}
function stageRestoreFromLocalStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    _restoreCache = raw ? JSON.parse(raw) : null;
  } catch (e) { _restoreCache = null; }
}
function applyRestoreAfterDataLoad() {
  if (!_restoreCache) { updateCartBadge(); return; }
const index = new Map(ALL_ROWS.map(r => [`${r.sku}|${r.vendor}|${r.uom || ''}`, r]));
  CART.clear();
  for (const saved of _restoreCache.cart || []) {
    const key = saved.key || `${saved?.row?.sku}|${saved?.row?.vendor}`;
    const liveRow = index.get(key) || saved.row || null;
    if (!liveRow) continue;
    if (!liveRow.category) liveRow.category = categorizeDescription(liveRow.description || "");
    const ub = unitBase(liveRow);
    CART.set(key, {
      row: liveRow,
      qty: Math.max(1, Math.floor(saved.qty || 1)),
      unitBase: ub,
      marginPct: Math.max(0, Number(saved.marginPct ?? DEFAULT_PRODUCT_MARGIN_PCT) || 0)
    });
  }
  LABOR_LINES = Array.isArray(_restoreCache.labor) ? _restoreCache.labor.map(l => {
    // Backwards compatibility: if older "margin" multiplier exists, convert to percent.
    let pct = 0;
    if (typeof l.marginPct === "number") {
      pct = Math.max(0, Number(l.marginPct) || 0);
    } else if (typeof l.margin === "number" && l.margin > 0) {
      pct = Math.max(0, (Number(l.margin) - 1) * 100);
    }
    return {
      id: l.id,
      rate: Number(l.rate ?? l.base ?? 0) || 0,
      qty: Math.max(1, Math.floor(Number(l.qty ?? 1) || 1)),
      name: l.name || "Labor line",
      marginPct: pct
    };
  }) : [];
  if (typeof _restoreCache.laborIdSeq === "number") {
    _laborIdSeq = _restoreCache.laborIdSeq;
  }
  ACTIVE_CATEGORY = _restoreCache.activeCategory || "";
  _restoreCache = null;
  renderCart();
  updateCartBadge();
}

// Debounce
function debounce(fn, ms) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }
