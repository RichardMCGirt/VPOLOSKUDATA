// ===== GOOGLE SHEETS + GIS SIGN-IN (popup token flow) =====

// --- Config ---
const CLIENT_ID = "518347118969-drq9o3vr7auf78l16qcteor9ng4nv7qd.apps.googleusercontent.com";
const API_KEY   = "AIzaSyBGYsHkTEvE9eSYo9mFCUIecMcQtT8f0hg";
const SHEET_ID  = "1E3sRhqKfzxwuN6VOmjI2vjWsk_1QALEKkX7mNXzlVH8";
const SCOPES    = "https://www.googleapis.com/auth/spreadsheets.readonly";

// If you link to a specific gid in the URL, put it here; 0 = first tab
const DEFAULT_GID = 0;

// Table + UI config
const PRODUCT_TAB_FALLBACK = "DataLoad";   // used if we can't resolve a title from gid
const PRODUCT_RANGE        = "A1:H10000";  // Vendor..Price Extended columns

// Margin
const MARGIN = 0.30;
const MARKUP_MULT = 1 + MARGIN;

// --- State ---
let tokenClient;
let gapiInited = false;
let gisInited  = false;
let tokenRequestInFlight = false; // guard against double-click or race with other flows

// Data state
let ALL_ROWS = [];         // full product list from sheet
let FILTERED_ROWS = [];    // after search/vendor filters
const CART = new Map();    // key: sku|vendor -> {row, qty, unitBase, unitSell}
let LABOR_LINES = [];      // array of {id, base}

// =============== Bootstrap GAPI (Sheets v4) ===============
function gapiLoaded() {
  gapi.load("client", async () => {
    await gapi.client.init({
      apiKey: API_KEY,
      discoveryDocs: ["https://sheets.googleapis.com/$discovery/rest?version=v4"],
    });
    gapiInited = true;
    console.log("[GAPI] Client initialized.");
    maybeEnableButtons();
  });
}

// =============== Bootstrap GIS (OAuth) ====================
function gisLoaded() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: async (tokenResponse) => {
      tokenRequestInFlight = false;
      console.log("[GIS] Token received. Access token present:", !!tokenResponse.access_token);

      // Hide authorize, show signout
      showEl("authorize_button", false);
      showEl("signout_button", true);

      // Show loader bar while we fetch
      showEl("loadingBarOverlay", true);

      try {
        await listSheetData();
        showToast("Sheet loaded.");
      } catch (e) {
        console.error("Error loading sheet:", e);
        showToast("Error loading sheet (see console).");
      } finally {
        showEl("loadingBarOverlay", false);
        showEl("table-container", true);
      }
    },
  });
  gisInited = true;
  console.log("[GIS] OAuth client initialized.");
  maybeEnableButtons();
}

// =============== Buttons/Handlers =========================
function maybeEnableButtons() {
  const authBtn    = document.getElementById("authorize_button");
  const signoutBtn = document.getElementById("signout_button");

  if (!authBtn || !signoutBtn) {
    console.warn("Authorize/Signout buttons not found in DOM.");
    return;
  }

  if (gapiInited && gisInited) {
    authBtn.onclick = () => {
      if (tokenRequestInFlight) {
        console.log("[Buttons] Token request already in flight; ignoring extra click.");
        return;
      }
      tokenRequestInFlight = true;
      console.log("[Buttons] Authorize clicked.");
      // Prompt set to "" means "no forced account picker if already known"
      tokenClient.requestAccessToken({ prompt: "" });
    };
    signoutBtn.onclick = handleSignoutClick;
    console.log("[Buttons] Handlers attached.");
  } else {
    console.log("[Buttons] Waiting for GAPI/GIS init...");
  }
}

function handleSignoutClick() {
  const tokenObj = gapi.client.getToken();
  if (tokenObj && tokenObj.access_token) {
    google.accounts.oauth2.revoke(tokenObj.access_token, () => {
      console.log("[GIS] Token revoked.");
      gapi.client.setToken(""); // clear in gapi
      tokenRequestInFlight = false;

      showEl("authorize_button", true);
      showEl("signout_button", false);

      // Clear UI
      const tbody = document.querySelector("#data-table tbody");
      if (tbody) tbody.innerHTML = "";
      ALL_ROWS = [];
      FILTERED_ROWS = [];
      CART.clear();
      LABOR_LINES = [];
      renderCart();
      showToast("Signed out.");
      // Disable filters
      setDisabled("searchInput", true);
      setDisabled("vendorFilter", true);
      setDisabled("clearFilters", true);
    });
  }
}

// ===================== Sheet Helpers ======================
const HEADER_ALIASES = {
  vendor:        ["vendor","supplier"],
  sku:           ["sku","item","item code","item #","item#"],
  uom:           ["uom","unit","unit of measure"],
  description:   ["description","desc","item description"],
  skuHelper:     ["skuhelper","sku helper","helper"],
  uomMultiple:   ["uom multiple","uommultiple","multiplier","pack qty","pack quantity"],
  cost:          ["cost","unit cost","price"],
  priceExtended: ["price extende","price extended","extended price","ext price"]
};

function norm(s){ return String(s ?? "").trim(); }

function headerKey(name) {
  const n = norm(name).toLowerCase();
  for (const [key, variants] of Object.entries(HEADER_ALIASES)) {
    if (variants.includes(n)) return key;
  }
  return null;
}

function parseNumber(x) {
  const s = norm(x).replace(/\$/g, "").replace(/,/g, "");
  if (!s) return null;
  if (s === "#VALUE!" || /\*need to review/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function makeSkuHelper(sku, vendor) {
  const v = norm(vendor) || "N/A";
  return `${norm(sku)}${v}`;
}

async function getSheetTitleByGid(spreadsheetId, gidNumber) {
  try {
    const meta = await gapi.client.sheets.spreadsheets.get({
      spreadsheetId,
      includeGridData: false,
    });
    const sheet = (meta.result.sheets || []).find(
      s => String(s.properties.sheetId) === String(gidNumber)
    );
    return sheet ? sheet.properties.title : null;
  } catch (e) {
    console.warn("Failed to get spreadsheet meta:", e);
    return null;
  }
}

// Main: fetch + transform
async function fetchProductSheet(spreadsheetId, gidNumber = null) {
  // 1) Determine the tab title
  let title = null;
  if (gidNumber !== null && gidNumber !== undefined) {
    title = await getSheetTitleByGid(spreadsheetId, gidNumber);
  }
  if (!title) title = PRODUCT_TAB_FALLBACK;
  console.log(`[Sheets] Using tab "${title}"`);

  // 2) Read values
  const res = await gapi.client.sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${title}'!${PRODUCT_RANGE}`,
  });
  const values = res.result.values || [];
  if (!values.length) return { rows: [], bySku: {}, bySkuVendor: {} };

  // 3) Identify header row (first row that looks like headers)
  let headerRowIdx = 0;
  for (let r = 0; r < Math.min(5, values.length); r++) {
    const row = (values[r] || []).map(x => norm(x).toLowerCase());
    if (row.some(c => c.includes("sku")) && row.some(c => c.includes("desc"))) {
      headerRowIdx = r; break;
    }
  }
  const headerRow = values[headerRowIdx] || [];
  const dataRows  = values.slice(headerRowIdx + 1);

  // 4) Map columns using tolerant aliases
  const colMap = {};
  headerRow.forEach((h, idx) => {
    const key = headerKey(h);
    if (key && !(key in colMap)) colMap[key] = idx; // first match wins
  });

  if (colMap.sku == null || colMap.description == null) {
    console.warn("SKU/Description not detected. Current colMap:", colMap);
  }

  // 5) Build row objects
  const rows = [];
  for (const row of dataRows) {
    const vendor  = colMap.vendor        != null ? row[colMap.vendor]        : "";
    const sku     = colMap.sku           != null ? row[colMap.sku]           : "";
    const uom     = colMap.uom           != null ? row[colMap.uom]           : "";
    const desc    = colMap.description   != null ? row[colMap.description]   : "";
    const helper  = colMap.skuHelper     != null ? row[colMap.skuHelper]     : "";
    const mult    = colMap.uomMultiple   != null ? parseNumber(row[colMap.uomMultiple])   : null;
    const cost    = colMap.cost          != null ? parseNumber(row[colMap.cost])          : null;
    let   px      = colMap.priceExtended != null ? parseNumber(row[colMap.priceExtended]) : null;

    const cleanSku = norm(sku);
    if (!cleanSku) continue; // skip empty lines

    // Compute extended price if missing/invalid
    if (px == null) {
      const m = (mult == null ? 1 : mult);
      const c = (cost == null ? 0 : cost);
      px = m * c;
    }

    rows.push({
      vendor: norm(vendor) || "N/A",
      sku: cleanSku,
      uom: norm(uom),
      description: norm(desc),
      skuHelper: norm(helper) || makeSkuHelper(sku, vendor),
      uomMultiple: mult,
      cost: cost,
      priceExtended: px,
    });
  }

  // 6) Lookups (if you need programmatic access elsewhere)
  const bySku = Object.create(null);
  const bySkuVendor = Object.create(null);
  for (const r of rows) {
    const key = `${r.sku}|${r.vendor}`;
    bySkuVendor[key] = r;
    if (!bySku[r.sku]) bySku[r.sku] = r; // first wins
  }

  return { rows, bySku, bySkuVendor, title };
}

// ====================== Render: Product Table ============================
function ensureTable() {
  let table = document.getElementById("data-table");
  if (!table) {
    console.warn("#data-table not found. Creating one inside #table-container.");
    const container = document.getElementById("table-container") || document.body;
    table = document.createElement("table");
    table.id = "data-table";
    table.innerHTML = "<thead></thead><tbody></tbody>";
    container.appendChild(table);
  }
  return table;
}

function formatMoney(n) {
  const x = Number(n ?? 0);
  if (!Number.isFinite(x)) return "$0.00";
  return x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2, style: "currency", currency: "USD" });
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function unitBase(row) {
  // Use priceExtended if available; otherwise cost * uomMultiple
  const mult = row.uomMultiple == null ? 1 : Number(row.uomMultiple) || 1;
  const px = (row.priceExtended != null ? Number(row.priceExtended) : null);
  const cost = (row.cost != null ? Number(row.cost) : 0);
  return (px != null ? px : (mult * cost));
}

function unitSell(row) {
  return unitBase(row) * MARKUP_MULT;
}

function renderTable(rows) {
  const table = ensureTable();
  const thead = table.querySelector("thead");
  const tbody = table.querySelector("tbody");

  if (thead) {
    thead.innerHTML = `
      <tr>
        <th>Vendor</th>
        <th>SKU</th>
        <th>UOM</th>
        <th>Description</th>
        <th style="width:120px;">Qty</th>
        <th style="width:120px;"></th>
      </tr>`;
  }
  if (tbody) {
    tbody.innerHTML = rows.map((r, idx) => {
      const key = `${r.sku}|${r.vendor}`;
      return `
      <tr data-key="${escapeHtml(key)}">
        <td>${escapeHtml(r.vendor)}</td>
        <td>${escapeHtml(r.sku)}</td>
        <td>${escapeHtml(r.uom)}</td>
        <td>${escapeHtml(r.description)}</td>
        <td><input type="number" class="qty-input" min="1" step="1" value="1" id="qty_${idx}"></td>
        <td class="row-actions">
          <button class="btn add-to-cart" data-key="${escapeHtml(key)}" data-idx="${idx}">Add</button>
        </td>
      </tr>`;
    }).join("");
  }

  // Delegate clicks for Add
  tbody.onclick = (ev) => {
    const btn = ev.target.closest(".add-to-cart");
    if (!btn) return;
    const idx = Number(btn.getAttribute("data-idx") || "0");
    const qtyInput = document.getElementById(`qty_${idx}`);
    let qty = Number(qtyInput?.value || 1);
    if (!Number.isFinite(qty) || qty <= 0) qty = 1;
    addToCart(rows[idx], qty);
  };
}

// ====================== Filters & Search ============================
function populateVendorFilter(rows) {
  const sel = document.getElementById("vendorFilter");
  if (!sel) return;
  const vendors = Array.from(new Set(rows.map(r => r.vendor).filter(Boolean))).sort((a,b)=>a.localeCompare(b));
  sel.innerHTML = `<option value="">All vendors</option>` + vendors.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
}

function applyFilters() {
  const q = (document.getElementById("searchInput")?.value || "").trim().toLowerCase();
  const vSel = (document.getElementById("vendorFilter")?.value || "");
  FILTERED_ROWS = ALL_ROWS.filter(r => {
    const matchesVendor = !vSel || r.vendor === vSel;
    const hay = `${r.sku} ${r.description}`.toLowerCase();
    const matchesQuery = !q || hay.includes(q);
    return matchesVendor && matchesQuery;
  });
  renderTable(FILTERED_ROWS);
}

// ====================== Cart ============================
function addToCart(row, qty) {
  const key = `${row.sku}|${row.vendor}`;
  const existing = CART.get(key);
  const ub = unitBase(row);
  const us = ub * MARKUP_MULT;
  if (existing) {
    existing.qty += qty;
  } else {
    CART.set(key, { row, qty, unitBase: ub, unitSell: us });
  }
  // Ensure there's at least one labor input available
  if (LABOR_LINES.length === 0) {
    addLaborLine(0);
  }
  renderCart();
  showEl("cart-section", true);
}

function updateCartQty(key, qty) {
  const item = CART.get(key);
  if (!item) return;
  item.qty = Math.max(1, Math.floor(qty || 1));
  renderCart();
}

function removeCartItem(key) {
  CART.delete(key);
  renderCart();
  if (CART.size === 0 && LABOR_LINES.length === 0) {
    showEl("cart-section", false);
  }
}

function clearCart() {
  CART.clear();
  renderCart();
  if (LABOR_LINES.length === 0) showEl("cart-section", false);
}

function renderCart() {
  const tbody = document.querySelector("#cart-table tbody");
  if (!tbody) return;
  const rows = [];
  let productTotal = 0;

  for (const [key, item] of CART.entries()) {
    const line = item.unitSell * item.qty;
    productTotal += line;
    rows.push(`
      <tr data-key="${escapeHtml(key)}">
        <td>${escapeHtml(item.row.vendor)}</td>
        <td>${escapeHtml(item.row.sku)}</td>
        <td>${escapeHtml(item.row.description)}</td>
        <td>
          <input type="number" class="qty-input cart-qty" min="1" step="1" value="${item.qty}" data-key="${escapeHtml(key)}">
        </td>
        <td>${formatMoney(item.unitSell)}</td>
        <td>${formatMoney(line)}</td>
        <td><button class="btn danger remove-item" data-key="${escapeHtml(key)}">Remove</button></td>
      </tr>
    `);
  }
  tbody.innerHTML = rows.join("");

  // Wire qty + remove
  tbody.oninput = (ev) => {
    const input = ev.target.closest(".cart-qty");
    if (!input) return;
    const key = input.getAttribute("data-key");
    const qty = Number(input.value);
    updateCartQty(key, qty);
  };
  tbody.onclick = (ev) => {
    const btn = ev.target.closest(".remove-item");
    if (!btn) return;
    removeCartItem(btn.getAttribute("data-key"));
  };

  // Labor
  renderLabor();

  // Totals
  document.getElementById("productTotal").textContent = formatMoney(productTotal);
  const laborTotal = calcLaborTotal();
  document.getElementById("laborTotal").textContent = formatMoney(laborTotal);
  document.getElementById("grandTotal").textContent = formatMoney(productTotal + laborTotal);
}



// ====================== Labor ============================
let _laborIdSeq = 1;
function addLaborLine(base = 0) {
  LABOR_LINES.push({ id: _laborIdSeq++, base: Number(base) || 0 });
  showEl("cart-section", true);
  renderCart();
}

function removeLaborLine(id) {
  LABOR_LINES = LABOR_LINES.filter(l => l.id !== id);
  renderCart();
  if (CART.size === 0 && LABOR_LINES.length === 0) {
    showEl("cart-section", false);
  }
}

function calcLaborTotal() {
  let total = 0;
  for (const l of LABOR_LINES) {
    const sell = (Number(l.base) || 0) * MARKUP_MULT;
    total += sell;
  }
  return total;
}

function renderLabor() {
  const wrap = document.getElementById("labor-list");
  if (!wrap) return;
  // Clear existing rows (keeping header area)
  const existingRows = wrap.querySelectorAll(".labor-row");
  existingRows.forEach(el => el.remove());

  for (const l of LABOR_LINES) {
    const sell = (Number(l.base) || 0) * MARKUP_MULT;
    const row = document.createElement("div");
    row.className = "labor-row";
    row.innerHTML = `
      <div>Labor line</div>
      <div><input type="number" min="0" step="0.01" value="${l.base}" class="labor-base" data-id="${l.id}" placeholder="Base cost"></div>
      <div><input type="text" value="${formatMoney(sell)}" readonly></div>
      <div><button class="btn danger remove-labor" data-id="${l.id}">Remove</button></div>
    `;
    wrap.appendChild(row);
  }

  wrap.oninput = (ev) => {
    const input = ev.target.closest(".labor-base");
    if (!input) return;
    const id = Number(input.getAttribute("data-id"));
    const val = Number(input.value);
    const l = LABOR_LINES.find(x => x.id === id);
    if (l) {
      l.base = Number.isFinite(val) ? val : 0;
      // Do a partial rerender for totals + read-only sell
      renderCart(); // simple: reuse totals render
    }
  };
  wrap.onclick = (ev) => {
    const btn = ev.target.closest(".remove-labor");
    if (!btn) return;
    const id = Number(btn.getAttribute("data-id"));
    removeLaborLine(id);
  };
}

// ====================== Main Flow ========================
async function listSheetData() {
  try {
    const { rows, title } = await fetchProductSheet(SHEET_ID, DEFAULT_GID);
    console.log(`[Sheets] Rows loaded from "${title}":`, rows.length);
    ALL_ROWS = rows;
    populateVendorFilter(ALL_ROWS);
    // Enable controls
    setDisabled("searchInput", false);
    setDisabled("vendorFilter", false);
    setDisabled("clearFilters", false);

    // Wire control events once
    wireControlsOnce();

    // Initial render
    applyFilters();
  } catch (e) {
    console.error("listSheetData() failed:", e);
    throw e;
  }
}

// ====================== Controls Wiring ===================
let _controlsWired = false;
function wireControlsOnce() {
  if (_controlsWired) return;
  _controlsWired = true;

  const search = document.getElementById("searchInput");
  const vendor = document.getElementById("vendorFilter");
  const clear  = document.getElementById("clearFilters");
  const clearCartBtn = document.getElementById("clearCart");
  const addLaborBtn  = document.getElementById("addLabor");

  if (search) search.addEventListener("input", debounce(applyFilters, 120));
  if (vendor) vendor.addEventListener("change", applyFilters);
  if (clear)  clear.addEventListener("click", () => {
    if (search) search.value = "";
    if (vendor) vendor.value = "";
    applyFilters();
  });
  if (clearCartBtn) clearCartBtn.addEventListener("click", clearCart);
  if (addLaborBtn)  addLaborBtn.addEventListener("click", () => addLaborLine(0));
}

// ====================== Toast/UX/Utils =========================
function showToast(message = "Done") {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.style.visibility = "visible";
  el.style.opacity = "1";
  el.classList.add("show");
  setTimeout(() => {
    el.style.opacity = "0";
    el.classList.remove("show");
    el.style.visibility = "hidden";
  }, 1800);
}

function showEl(id, show) {
  const el = document.getElementById(id);
  if (!el) return;
  if (show) {
    el.classList.remove("hidden");
    el.style.display = (id === "table-container" ? "block" : "");
  } else {
    el.classList.add("hidden");
  }
}

function setDisabled(id, isDisabled) {
  const el = document.getElementById(id);
  if (!el) return;
  el.disabled = !!isDisabled;
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// Auto-refresh every 5 minutes if signed in
setInterval(() => {
  const signedIn = document.getElementById("signout_button")?.style.display === "inline-block";
  if (signedIn) {
    showEl("loadingBarOverlay", true);
    listSheetData()
      .then(() => showToast("Auto-refreshed."))
      .finally(() => {
        showEl("loadingBarOverlay", false);
      });
  }
}, 300000);

// Expose init functions for script onload callbacks
window.gapiLoaded = gapiLoaded;
window.gisLoaded  = gisLoaded;
