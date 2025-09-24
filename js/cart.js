// ===== Cart =====
// cart.js (very top)
window.STORAGE_KEY = window.STORAGE_KEY || "vanir_cart_v1";

function addToCart(row, qty) {
  if (!(qty > 0)) return; // ignore 0 / invalid
const key = `${row.sku}|${row.vendor}|${row.uom || ''}`;
  const existing = CART.get(key);
  const ub = unitBase(row);
  if (existing) existing.qty += qty;
  else CART.set(key, { row, qty, unitBase: ub, marginPct: DEFAULT_PRODUCT_MARGIN_PCT });
  // Default labor section present with 0 qty so it stays $0 until used
  if (LABOR_LINES.length === 0) addLaborLine(0, 0, "Labor line", 0);
  renderCart();
  showToast(`Added ${qty} ${row?.sku || "item"} to cart`);
  showEl("cart-section", true);
  persistState();
  updateCartBadge();
}
// marginPct is percentage (number), e.g., 30 => +30%
function addLaborLine(rate = 0, qty = 0, name = "Labor line", marginPct = 0) {
  const safeQty  = Math.max(0, Math.floor(qty || 0));
  const safeRate = Number(rate) || 0;
  const safePct  = Math.max(0, Number(marginPct) || 0);
  LABOR_LINES.push({ id: _laborIdSeq++, rate: safeRate, qty: safeQty, name, marginPct: safePct });
  showEl("cart-section", true);
  renderCart();
  persistState();
}

function updateCartQty(key, qty) {
  const item = CART.get(key);
  if (!item) return;
  item.qty = Math.max(1, Math.floor(qty || 1));
  renderCart();
  persistState();
  updateCartBadge();
}
function removeCartItem(key) {
  if (!CART.has(key)) return;
  CART.delete(key);
  renderCart();
  if (CART.size === 0 && LABOR_LINES.length === 0) showEl("cart-section", false);
  persistState();
  updateCartBadge();
}
function clearCart() {
  CART.clear();
  renderCart();
  if (LABOR_LINES.length === 0) showEl("cart-section", false);
  persistState();
  updateCartBadge();
}

let _laborIdSeq = 1;

function removeLaborLine(id) {
  LABOR_LINES = LABOR_LINES.filter(l => l.id !== id);
  renderCart();
  if (CART.size === 0 && LABOR_LINES.length === 0) showEl("cart-section", false);
  persistState();
}

// Compute labor total
function calcLaborTotal() {
  let total = 0;
  for (const l of LABOR_LINES) {
    const qty  = Math.max(0, Math.floor(Number(l.qty) || 0));
    const rate = Math.max(0, Number(l.rate) || 0);
    const pct  = Math.max(0, Number(l.marginPct) || 0);
    total += qty * rate * (1 + pct / 100);
  }
  return total;
}

function renderCart() {
  const tbody = document.querySelector("#cart-table tbody");
  if (!tbody) return;

  const rows = [];
  for (const [key, item] of CART.entries()) {
    const unit = itemUnitSell(item);
    const line = unit * Math.max(0, Math.floor(Number(item.qty) || 0));
    rows.push(`
      <tr data-key="${escapeHtml(key)}">
        <td data-label="Vendor">${escapeHtml(item.row.vendor)}</td>
        <td data-label="SKU">${escapeHtml(item.row.sku)}</td>
        <td data-label="Description">${escapeHtml(item.row.description)}</td>
        <td data-label="Qty">
          <div class="stack">
            <label class="field-label" for="cart-qty-${escapeHtml(key)}">QTY</label>
            <input
              id="cart-qty-${escapeHtml(key)}"
              type="number" class="qty-input cart-qty"
              min="0" step="1"
              value="${Math.max(0, Math.floor(Number(item.qty) || 0))}"
              data-key="${escapeHtml(key)}"
              aria-label="Cart quantity">
            <div class="margin-override">
              <label class="field-label" for="cart-margin-${escapeHtml(key)}">Margin (%)</label>
              <input
                id="cart-margin-${escapeHtml(key)}"
                type="number" class="cart-margin-pct"
                min="0" step="1"
                value="${Math.max(0, Number(item.marginPct ?? DEFAULT_PRODUCT_MARGIN_PCT) || 0)}"
                data-key="${escapeHtml(key)}"
                aria-label="Cart margin percent">
            </div>
          </div>
        </td>
        <td data-label="Unit" data-cell="unit"><span class="cell-text nowrap-ellipsize">${formatMoney(unit)}</span></td>
        <td data-label="Line Total" data-cell="line"><span class="cell-text nowrap-ellipsize">${formatMoney(line)}</span></td>
        <td data-label="Actions"><button class="btn danger remove-item" data-key="${escapeHtml(key)}">Remove</button></td>
      </tr>
    `);
  }
  tbody.innerHTML = rows.join("");

  // Inline updates for qty & margin
  tbody.oninput = (ev) => {
    const qtyEl = ev.target.closest(".cart-qty");
    if (qtyEl) {
      const key = qtyEl.getAttribute("data-key");
      const item = CART.get(key);
      if (!item) return;
      item.qty = Math.max(0, Math.floor(Number(qtyEl.value) || 0));
      updateTotalsCellsForRow(qtyEl.closest("tr"), item);
      updateTotalsOnly();
      persistState();
      updateCartBadge();
      return;
    }
    const pctEl = ev.target.closest(".cart-margin-pct");
    if (pctEl) {
      const key = pctEl.getAttribute("data-key");
      const item = CART.get(key);
      if (!item) return;
      let pct = Number(pctEl.value);
      if (!Number.isFinite(pct)) pct = DEFAULT_PRODUCT_MARGIN_PCT;
      item.marginPct = Math.max(0, pct);
      updateTotalsCellsForRow(pctEl.closest("tr"), item);
      updateTotalsOnly();
      persistState();
      updateCartBadge();
    }
  };

  tbody.onclick = (ev) => {
    const btn = ev.target.closest(".remove-item");
    if (!btn) return;
    const key = btn.getAttribute("data-key");
    if (!CART.has(key)) return;
    CART.delete(key);
    renderCart();
    if (CART.size === 0 && LABOR_LINES.length === 0) showEl("cart-section", false);
    persistState();
    updateCartBadge();
  };

  // Re-render labor & totals
  renderLabor();
  updateTotalsOnly();
}

function renderLabor() {
  const wrap = document.getElementById("labor-list");
  if (!wrap) return;

  const existingRows = wrap.querySelectorAll(".labor-row");
  existingRows.forEach(el => el.remove());

  for (const l of LABOR_LINES) {
    const safeQty  = Math.max(0, Math.floor(l.qty || 0));
    const safeRate = Number(l.rate) || 0;
    const safePct  = Math.max(0, Number(l.marginPct) || 0);

    const row = document.createElement("div");
    row.className = "labor-row";
    row.innerHTML = `
      <div class="field">
        <label class="field-label" for="labor-name-${l.id}">Labor name</label>
        <input id="labor-name-${l.id}" aria-label="Labor name" type="text" class="labor-name" data-id="${l.id}" value="${escapeHtml(l.name || "Labor line")}" placeholder="Labor line">
      </div>
      <div class="field">
        <label class="field-label" for="labor-qty-${l.id}">QTY</label>
        <input id="labor-qty-${l.id}" aria-label="Labor quantity" type="number" min="0" step="1" value="${safeQty}" class="labor-qty" data-id="${l.id}" placeholder="Qty">
      </div>
      <div class="field">
        <label class="field-label" for="labor-rate-${l.id}">Labor cost ($)</label>
        <input id="labor-rate-${l.id}" aria-label="Labor cost per unit" type="number" min="0" step="0.01" value="${safeRate}" class="labor-rate" data-id="${l.id}" placeholder="$/unit">
      </div>
      <div class="field">
        <label class="field-label" for="labor-margin-${l.id}">Margin (%)</label>
        <input id="labor-margin-${l.id}" aria-label="Labor margin percent" type="number" min="0" step="1" value="${safePct}" class="labor-margin-pct" data-id="${l.id}" placeholder="e.g., 30">
      </div>
      <div class="field">
        <label class="field-label">&nbsp;</label>
        <button class="btn danger remove-labor" data-id="${l.id}">Remove</button>
      </div>
    `;
    wrap.appendChild(row);
  }

  wrap.oninput = (ev) => {
    const qtyEl = ev.target.closest(".labor-qty");
    if (qtyEl) {
      const id  = Number(qtyEl.getAttribute("data-id"));
      const val = Math.max(0, Math.floor(Number(qtyEl.value) || 0));
      const l   = LABOR_LINES.find(x => x.id === id);
      if (!l) return;
      l.qty = val;
      document.getElementById("laborTotal").textContent = formatMoney(calcLaborTotal());
      document.getElementById("grandTotal").textContent =
        formatMoney(calcProductsTotal() + calcLaborTotal());
      persistState();
      return;
    }

    const rateEl = ev.target.closest(".labor-rate");
    if (rateEl) {
      const id  = Number(rateEl.getAttribute("data-id"));
      const val = Math.max(0, Number(rateEl.value) || 0);
      const l   = LABOR_LINES.find(x => x.id === id);
      if (!l) return;
      l.rate = val;
      document.getElementById("laborTotal").textContent = formatMoney(calcLaborTotal());
      document.getElementById("grandTotal").textContent =
        formatMoney(calcProductsTotal() + calcLaborTotal());
      persistState();

      return;
    }

    const marginEl = ev.target.closest(".labor-margin-pct");
    if (marginEl) {
      const id  = Number(marginEl.getAttribute("data-id"));
      let val = Number(marginEl.value);
      if (!Number.isFinite(val)) val = 0;
      val = Math.max(0, val); // 0..∞; 30 => +30%
      const l = LABOR_LINES.find(x => x.id === id);
      if (!l) return;
      l.marginPct = val;
      document.getElementById("laborTotal").textContent = formatMoney(calcLaborTotal());
      document.getElementById("grandTotal").textContent =
        formatMoney(calcProductsTotal() + calcLaborTotal());
      persistState();
      return;
    }

    const nameEl = ev.target.closest(".labor-name");
    if (nameEl) {
      const id = Number(nameEl.getAttribute("data-id"));
      const l  = LABOR_LINES.find(x => x.id === id);
      if (l) { l.name = nameEl.value; persistState(); }
    }
  };

  wrap.onclick = (ev) => {
    const btn = ev.target.closest(".remove-labor");
    if (!btn) return;
    const id = Number(btn.getAttribute("data-id"));
    removeLaborLine(id);
  };
}

// helpers
function calcProductsTotal() {
  let productTotal = 0;
  for (const [, item] of CART.entries()) productTotal += itemUnitSell(item) * item.qty;
  return productTotal;
}
function updateTotalsOnly() {
  const productTotal = calcProductsTotal();
  document.getElementById("productTotal").textContent = formatMoney(productTotal);
  const laborTotal = calcLaborTotal();
  document.getElementById("laborTotal").textContent = formatMoney(laborTotal);
  document.getElementById("grandTotal").textContent = formatMoney(productTotal + laborTotal);
}
function updateCartBadge() {
  const badge = document.getElementById("cartCountBadge");
  if (!badge) return;
  let total = 0; for (const [, it] of CART) total += Math.max(0, it.qty|0);
  badge.textContent = String(total);
}

try {
  var cartChannel = ("BroadcastChannel" in window) ? new BroadcastChannel("vanir_cart_bc") : null;
} catch (_) { var cartChannel = null; }

if (cartChannel) {
  cartChannel.onmessage = function (ev) {
    var msg = ev && ev.data;
    if (!msg || !msg.type) return;
    if (msg.type === "focus") {
      try { window.focus(); } catch (_) {}
      return;
    }
    if (msg.type === "cart:update") {
      try {
        var s = msg.state || {};
        if (Array.isArray(s.cart)) {
          // Replace in-memory state with incoming
          CART.clear();
          for (var i = 0; i < s.cart.length; i++) {
            var it = s.cart[i] || {};
            var safeQty = Math.max(0, Number(it.qty) || 0);
            CART.set(String(it.key || ""), {
              row: it.row || {},
              qty: safeQty,
              unitBase: Number(it.unitBase) || 0,
              marginPct: Math.max(0, Number(it.marginPct) || 0)
            });
          }
          if (Array.isArray(s.labor)) {
            LABOR_LINES = s.labor.slice();
          }
          // Persist & refresh UI
          try { persistState(); } catch (_e) {}
          try { renderCart(); } catch (_e2) {}
          try { updateCartBadge(); } catch (_e3) {}
        }
      } catch (e) {
        console.error("[cart] Failed to apply broadcast update:", e);
      }
    }
  };
}

window.addEventListener("pageshow", function () {
  try {
    var raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      CART.clear(); LABOR_LINES = [];
      try { renderCart(); } catch (_) {}
      try { updateCartBadge(); } catch (_) {}
      return;
    }
    var s = JSON.parse(raw);
    if (!s || !Array.isArray(s.cart)) return;
    CART.clear();
    for (var i = 0; i < s.cart.length; i++) {
      var it = s.cart[i] || {};
      var safeQty = Math.max(0, Number(it.qty) || 0);
      CART.set(String(it.key || ""), {
        row: it.row || {},
        qty: safeQty,
        unitBase: Number(it.unitBase) || 0,
        marginPct: Math.max(0, Number(it.marginPct) || 0)
      });
    }
    if (Array.isArray(s.labor)) {
      LABOR_LINES = s.labor.slice();
    }
    try { renderCart(); } catch (_) {}
    try { updateCartBadge(); } catch (_) {}
  } catch (e) {
    console.warn("[cart] pageshow resync issue:", e);
  }
}, { passive: true });
