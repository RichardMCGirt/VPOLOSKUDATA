// ===== GOOGLE SHEETS + GIS SIGN-IN (popup token flow) =====

// --- Config ---
const CLIENT_ID = "518347118969-drq9o3vr7auf78l16qcteor9ng4nv7qd.apps.googleusercontent.com";
const API_KEY   = "AIzaSyBGYsHkTEvE9eSYo9mFCUIecMcQtT8f0hg";
const SHEET_ID  = "1E3sRhqKfzxwuN6VOmjI2vjWsk_1QALEKkX7mNXzlVH8";
const SCOPES    = "https://www.googleapis.com/auth/spreadsheets.readonly";

// If you link to a specific gid in the URL, put it here; 0 = first tab
const DEFAULT_GID = 0;

// Table + UI config
const PRODUCT_TAB_FALLBACK = "DataLoad";
const PRODUCT_RANGE        = "A1:H10000";

// Margin (materials only)
const MARGIN = 0.30;
const MARKUP_MULT = 1 + MARGIN;

// --- State ---
let tokenClient;
let gapiInited = false;
let gisInited  = false;

// Data state
let ALL_ROWS = [];
let FILTERED_ROWS = [];
const CART = new Map();    // key: sku|vendor -> {row, qty, unitBase, unitSell}
let LABOR_LINES = [];      // {id, name, rate, qty}

// Cached categories
let ALL_CATEGORIES = [];
let ACTIVE_CATEGORY = "";

// ======== Token persistence & silent refresh ========
const TOKEN_STORAGE_KEY = "vanir_gis_token_v1";
let refreshTimerId = null;

function setAndPersistToken(tokenResponse) {
  if (!tokenResponse || !tokenResponse.access_token) return;
  const expiresInSec = Number(tokenResponse.expires_in || 3600);
  const expiresAt = Date.now() + expiresInSec * 1000;
  const stored = { access_token: tokenResponse.access_token, expires_at: expiresAt };
  try { localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(stored)); } catch {}
  gapi.client.setToken({ access_token: tokenResponse.access_token });
  scheduleSilentRefresh(Math.max(expiresAt - Date.now() - 5 * 60 * 1000, 10 * 1000));
  showEl("authorize_button", false);
  showEl("signout_button", true);
}
function tryLoadStoredToken() {
  let raw;
  try { raw = localStorage.getItem(TOKEN_STORAGE_KEY); } catch {}
  if (!raw) return false;
  let obj; try { obj = JSON.parse(raw); } catch { return false; }
  if (!obj || !obj.access_token || !obj.expires_at) return false;
  const skewMs = 10 * 1000;
  if (Date.now() >= (obj.expires_at - skewMs)) return false;
  gapi.client.setToken({ access_token: obj.access_token });
  showEl("authorize_button", false);
  showEl("signout_button", true);
  scheduleSilentRefresh(Math.max(obj.expires_at - Date.now() - 5 * 60 * 1000, 10 * 1000));
  return true;
}
function scheduleSilentRefresh(delayMs) {
  if (refreshTimerId) clearTimeout(refreshTimerId);
  refreshTimerId = setTimeout(() => {
    try { tokenClient.requestAccessToken({ prompt: "" }); } catch {}
  }, delayMs);
}
function clearLocalToken() {
  try { localStorage.removeItem(TOKEN_STORAGE_KEY); } catch {}
  try { gapi.client.setToken(null); } catch {}
  if (refreshTimerId) { clearTimeout(refreshTimerId); refreshTimerId = null; }
}

// =============== Category rules (Description-based) ===============
function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function wordMatch(text, kw) {
  const t = String(text || "").toLowerCase();
  const k = String(kw || "").toLowerCase();
  if (!k) return false;
  const boundary = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(k)}(?![A-Za-z0-9])`, "i");
  if (boundary.test(t)) return true;
  return t.includes(k);
}
const CATEGORY_RULES = [
  { name: "Fasteners", includes: [
      "screw", "screws", "nail", "nails", "ring shank", "finish nail", "common nail", "framing nail",
      "staple", "staples", "anchor", "bolt", "bolts", "washer", "washers", "collated", "deck screw",
      "trim screw", "self-tapping"
    ]},
  { name: "Hardware", includes: [
      "joist hanger", "hanger", "bracket", "connector", "strap", "clip", "plate", "tie", "simpson"
    ]},
  { name: "PVC", includes: ["pvc","azek","versatex","cellular pvc","pvc trim","vtp"] },
  { name: "Trim", includes: ["trim","casing","base","mould","molding","crown","shoe","quarter round","brickmould","jamb"] },
  { name: "Siding - Vinyl", includes: ["vinyl siding","vinyl","soffit","fascia","j-channel","starter strip","starter","outside corner","ocb"] },
  { name: "Siding - Fiber Cement", includes: ["fiber cement","hardie","james hardie","hardiplank","hardieplank"] },
  { name: "Insulation", includes: ["insulation","batt","r-","foam","expanding foam","sealant foam"] },
  { name: "Adhesives / Sealants", includes: ["adhesive","caulk","sealant","construction adhesive","glue","liquid nails"] },
  { name: "Roofing", includes: ["roof","shingle","felt","underlayment","drip edge","ridge","vent"] },
  { name: "Doors / Windows", includes: ["door","prehang","slab","window","sash","stile","frame"] },
  { name: "Tools", includes: ["blade","saw","bit","tape","knife","hammer","drill","driver","chalk","level"] },
  { name: "Paint / Finish", includes: ["paint","primer","stain","finish"] },
  { name: "Electrical", includes: ["electrical","wire","outlet","switch","box"] },
  { name: "Plumbing", includes: ["plumb","pipe","pvc sch","cpvc","pex","fitting","coupling","tee","elbow"] },
  { name: "Lumber", includes: ["lumber","stud","2x","x4","osb","plywood","board","4x8","rim","joist"] },
  { name: "Misc", includes: [] }
];
function categorizeDescription(desc = "") {
  const d = String(desc || "");
  if (/\bliquid\s+nails\b/i.test(d)) return "Adhesives / Sealants";
  for (const rule of CATEGORY_RULES) {
    if (rule.includes.some(kw => wordMatch(d, kw))) return rule.name;
  }
  return "Misc";
}

// =============== Bootstrap GAPI (Sheets v4) ===============
function gapiLoaded() {
  gapi.load("client", async () => {
    await gapi.client.init({
      apiKey: API_KEY,
      discoveryDocs: ["https://sheets.googleapis.com/$discovery/rest?version=v4"],
    });
    gapiInited = true;
    if (tryLoadStoredToken()) {
      showEl("table-container", true);
      showEl("loadingBarOverlay", true);
      listSheetData().finally(() => showEl("loadingBarOverlay", false));
    }
    maybeEnableButtons();
  });
}

// =============== Bootstrap GIS (OAuth) ====================
function gisLoaded() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPES,
    callback: async (tokenResponse) => {
      setAndPersistToken(tokenResponse);
      if (!ALL_ROWS.length) {
        try {
          showEl("loadingBarOverlay", true);
          await listSheetData();
          showToast("Sheet loaded.");
          showEl("table-container", true);
        } catch (e) {
          console.error("Error loading sheet:", e);
          showToast("Error loading sheet (see console).");
        } finally {
          showEl("loadingBarOverlay", false);
        }
      }
    },
  });
  gisInited = true;

  const hasValid = !!gapi.client.getToken()?.access_token;
  if (!hasValid) {
    try { tokenClient.requestAccessToken({ prompt: "" }); }
    catch (e) { console.warn("Silent token attempt failed:", e); }
  }
  maybeEnableButtons();
}

// =============== Buttons/Handlers =========================
function maybeEnableButtons() {
  const authBtn    = document.getElementById("authorize_button");
  const signoutBtn = document.getElementById("signout_button");
  const updateBtn  = document.getElementById("updatePricing");
  const cartFab    = document.getElementById("cartFab");

  if (authBtn) {
    authBtn.onclick = () => {
      try { tokenClient.requestAccessToken({ prompt: "" }); }
      catch { tokenClient.requestAccessToken({ prompt: "consent" }); }
    };
  }

  if (signoutBtn) {
    signoutBtn.onclick = () => {
      clearLocalToken();
      showEl("authorize_button", true);
      showEl("signout_button", false);

      const tbody = document.querySelector("#data-table tbody");
      if (tbody) tbody.innerHTML = "";
      ALL_ROWS = [];
      FILTERED_ROWS = [];
      CART.clear();
      LABOR_LINES = [];
      renderCart();
      updateCartBadge();
      showToast("Signed out (local).");
      setDisabled("searchInput", true);
      setDisabled("vendorFilter", true);
      setDisabled("categoryFilter", true);
      setDisabled("clearFilters", true);
      showEl("categoryChips", false);
    };
  }

  if (updateBtn) {
    updateBtn.disabled = false;
    updateBtn.onclick = updateAllPricingFromSheet;
  }

  if (cartFab) {
    cartFab.onclick = () => {
      // ensure cart is visible, then scroll to cart table body
      showEl("cart-section", true);
      const target = document.querySelector("#cart-table tbody") || document.getElementById("cart-section");
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    };
  }
}

async function updateAllPricingFromSheet() {
  try {
    showEl("loadingBarOverlay", true);
    const { rows } = await fetchProductSheet(SHEET_ID, DEFAULT_GID);
    const idx = new Map(rows.map(r => [`${r.sku}|${r.vendor}`, r]));

    let updated = 0;
    for (const [key, item] of CART.entries()) {
      const r = idx.get(key);
      if (!r) continue;
      item.row = r;
      item.unitBase = unitBase(r);
      item.unitSell = item.unitBase * MARKUP_MULT;
      updated++;
    }

    renderCart();
    persistState();
    showToast(`Updated pricing for ${updated} item${updated === 1 ? "" : "s"}.`);
  } catch (e) {
    console.error("Update pricing failed:", e);
    showToast("Failed to update pricing. See console.");
  } finally {
    showEl("loadingBarOverlay", false);
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
  let title = null;
  if (gidNumber !== null && gidNumber !== undefined) {
    title = await getSheetTitleByGid(spreadsheetId, gidNumber);
  }
  if (!title) title = PRODUCT_TAB_FALLBACK;

  const res = await gapi.client.sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${title}'!${PRODUCT_RANGE}`,
  });
  const values = res.result.values || [];
  if (!values.length) return { rows: [], bySku: {}, bySkuVendor: {} };

  // Identify header row
  let headerRowIdx = 0;
  for (let r = 0; r < Math.min(5, values.length); r++) {
    const row = (values[r] || []).map(x => norm(x).toLowerCase());
    if (row.some(c => c.includes("sku")) && row.some(c => c.includes("desc"))) {
      headerRowIdx = r; break;
    }
  }
  const headerRow = values[headerRowIdx] || [];
  const dataRows  = values.slice(headerRowIdx + 1);

  // Map columns
  const colMap = {};
  headerRow.forEach((h, idx) => {
    const key = headerKey(h);
    if (key && !(key in colMap)) colMap[key] = idx;
  });

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
    if (!cleanSku) continue;

    if (px == null) {
      const m = (mult == null ? 1 : mult);
      const c = (cost == null ? 0 : cost);
      px = m * c;
    }

    const description = norm(desc);
    rows.push({
      vendor: norm(vendor) || "N/A",
      sku: cleanSku,
      uom: norm(uom),
      description,
      skuHelper: norm(helper) || makeSkuHelper(sku, vendor),
      uomMultiple: mult,
      cost: cost,
      priceExtended: px,
      category: categorizeDescription(description),
    });
  }

  const bySku = Object.create(null);
  const bySkuVendor = Object.create(null);
  for (const r of rows) {
    const key = `${r.sku}|${r.vendor}`;
    bySkuVendor[key] = r;
    if (!bySku[r.sku]) bySku[r.sku] = r;
  }

  return { rows, bySku, bySkuVendor, title };
}

// ====================== Render: Product Table ============================
function ensureTable() {
  let table = document.getElementById("data-table");
  if (!table) {
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
  const mult = row.uomMultiple == null ? 1 : Number(row.uomMultiple) || 1;
  const px = (row.priceExtended != null ? Number(row.priceExtended) : null);
  const cost = (row.cost != null ? Number(row.cost) : 0);
  return (px != null ? px : (mult * cost));
}
function unitSell(row) { return unitBase(row) * MARKUP_MULT; }

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
        <td data-label="Vendor">${escapeHtml(r.vendor)}</td>
        <td data-label="SKU">${escapeHtml(r.sku)}</td>
        <td data-label="UOM">${escapeHtml(r.uom)}</td>
        <td data-label="Description">${escapeHtml(r.description)}</td>
        <td data-label="Qty"><input type="number" class="qty-input" min="1" step="1" value="1" id="qty_${idx}"></td>
        <td data-label="" class="row-actions">
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
  const all = document.createElement("button");
  all.className = "chip" + (ACTIVE_CATEGORY ? "" : " active");
  all.textContent = "All";
  all.setAttribute("data-cat", "");
  wrap.appendChild(all);

  for (const c of ALL_CATEGORIES) {
    const btn = document.createElement("button");
    btn.className = "chip" + (c === ACTIVE_CATEGORY ? " active" : "");
    btn.textContent = c;
    btn.setAttribute("data-cat", c);
    wrap.appendChild(btn);
  }
  showEl("categoryChips", true);

  wrap.onclick = (ev) => {
    const chip = ev.target.closest(".chip");
    if (!chip) return;
    ACTIVE_CATEGORY = chip.getAttribute("data-cat") || "";
    const sel = document.getElementById("categoryFilter");
    if (sel) sel.value = ACTIVE_CATEGORY;
    Array.from(wrap.querySelectorAll(".chip")).forEach(c => c.classList.toggle("active", c === chip));
    applyFilters();
  };
}
function applyFilters() {
  const q    = (document.getElementById("searchInput")?.value || "").trim().toLowerCase();
  const vSel = (document.getElementById("vendorFilter")?.value || "");
  const cSel = ACTIVE_CATEGORY || (document.getElementById("categoryFilter")?.value || "");

  const filtered = ALL_ROWS.filter(r => {
    const matchesVendor = !vSel || r.vendor === vSel;
    const matchesCat    = !cSel || r.category === cSel;
    const hay = `${r.sku} ${r.description}`.toLowerCase();
    const matchesQuery = !q || hay.includes(q);
    return matchesVendor && matchesCat && matchesQuery;
  });

  FILTERED_ROWS = filtered.sort((a,b) =>
    (a.category || "").localeCompare(b.category || "") ||
    a.description.localeCompare(b.description) ||
    a.sku.localeCompare(b.sku)
  );

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
  if (LABOR_LINES.length === 0) addLaborLine(0, 1);
  renderCart();
  showEl("cart-section", true);
  persistState();
  updateCartBadge();
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

// ====================== Labor (Qty × Rate, NO MARKUP) ====================
let _laborIdSeq = 1;
function addLaborLine(rate = 0, qty = 1, name = "Labor line") {
  LABOR_LINES.push({ id: _laborIdSeq++, rate: Number(rate) || 0, qty: Math.max(1, Math.floor(qty || 1)), name });
  showEl("cart-section", true);
  renderCart();
  persistState();
}
function removeLaborLine(id) {
  LABOR_LINES = LABOR_LINES.filter(l => l.id !== id);
  renderCart();
  if (CART.size === 0 && LABOR_LINES.length === 0) showEl("cart-section", false);
  persistState();
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
        <td data-label="Vendor">${escapeHtml(item.row.vendor)}</td>
        <td data-label="SKU">${escapeHtml(item.row.sku)}</td>
        <td data-label="Description">${escapeHtml(item.row.description)}</td>
        <td data-label="Qty">
          <input
            type="number"
            class="qty-input cart-qty"
            min="1"
            step="1"
            value="${item.qty}"
            data-key="${escapeHtml(key)}">
        </td>
        <td data-label="Unit">${formatMoney(item.unitSell)}</td>
        <td data-label="Line Total">${formatMoney(line)}</td>
        <td data-label="Action">
          <button class="btn danger remove-item" data-key="${escapeHtml(key)}">Remove</button>
        </td>
      </tr>
    `);
  }

  tbody.innerHTML = rows.join("");

  // Update qty (incremental)
  tbody.oninput = (ev) => {
    const input = ev.target.closest(".cart-qty");
    if (!input) return;

    const key = input.getAttribute("data-key");
    const qty = Math.max(1, Math.floor(Number(input.value) || 1));
    const item = CART.get(key);
    if (!item) return;

    item.qty = qty;

    const tr = input.closest("tr");
    const lineCell = tr?.querySelector("td:nth-child(6)");
    if (lineCell) lineCell.textContent = formatMoney(item.unitSell * item.qty);

    updateTotalsOnly();
    persistState();
    updateCartBadge();
  };

  // Remove material items
  tbody.onclick = (ev) => {
    const btn = ev.target.closest(".remove-item");
    if (!btn) return;
    const key = btn.getAttribute("data-key");
    if (!key) return;
    removeCartItem(key);
  };

  // Labor + totals
  renderLabor();
  document.getElementById("productTotal").textContent = formatMoney(productTotal);
  const laborTotal = calcLaborTotal();
  document.getElementById("laborTotal").textContent = formatMoney(laborTotal);
  document.getElementById("grandTotal").textContent = formatMoney(productTotal + laborTotal);

  updateCartBadge();
}

function calcLaborTotal() {
  let total = 0;
  for (const l of LABOR_LINES) {
    const qty  = Math.max(1, Math.floor(Number(l.qty) || 0));
    const rate = Math.max(0, Number(l.rate) || 0);
    total += qty * rate; // NO MARKUP
  }
  return total;
}

function renderLabor() {
  const wrap = document.getElementById("labor-list");
  if (!wrap) return;

  const existingRows = wrap.querySelectorAll(".labor-row");
  existingRows.forEach(el => el.remove());

  for (const l of LABOR_LINES) {
    const row = document.createElement("div");
    row.className = "labor-row";
    row.innerHTML = `
      <div><input type="text" class="labor-name" data-id="${l.id}" value="${escapeHtml(l.name || "Labor line")}" placeholder="Labor name"></div>
      <div><input type="number" min="1" step="1" value="${Math.max(1, Math.floor(l.qty || 1))}" class="labor-qty" data-id="${l.id}" placeholder="Qty"></div>
      <div><input type="number" min="0" step="0.01" value="${Number(l.rate) || 0}" class="labor-rate" data-id="${l.id}" placeholder="$/unit"></div>
      <div><button class="btn danger remove-labor" data-id="${l.id}">Remove</button></div>
    `;
    wrap.appendChild(row);
  }

  wrap.oninput = (ev) => {
    const qtyEl = ev.target.closest(".labor-qty");
    if (qtyEl) {
      const id  = Number(qtyEl.getAttribute("data-id"));
      const val = Math.max(1, Math.floor(Number(qtyEl.value) || 1));
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
  for (const [, item] of CART.entries()) productTotal += item.unitSell * item.qty;
  return productTotal;
}
function updateTotalsOnly() {
  let productTotal = 0;
  for (const [, item] of CART.entries()) productTotal += item.unitSell * item.qty;
  document.getElementById("productTotal").textContent = formatMoney(productTotal);
  const laborTotal = calcLaborTotal();
  document.getElementById("laborTotal").textContent = formatMoney(laborTotal);
  document.getElementById("grandTotal").textContent = formatMoney(productTotal + laborTotal);
}
function updateCartBadge() {
  const badge = document.getElementById("cartCountBadge");
  if (!badge) return;
  badge.textContent = String(CART.size); // number of DISTINCT records/lines
}

// ========= Persistence =========
const STORAGE_KEY = "vanir_cart_v1";
let _restoreCache = null;

function serializeState() {
  return {
    cart: Array.from(CART.entries()).map(([key, item]) => ({
      key,
      qty: item.qty,
      unitBase: item.unitBase,
      unitSell: item.unitSell,
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
      qty: Math.max(1, Math.floor(Number(l.qty) || 1)),
      name: l.name || "Labor line",
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
  const index = new Map(ALL_ROWS.map(r => [`${r.sku}|${r.vendor}`, r]));
  CART.clear();
  for (const saved of _restoreCache.cart || []) {
    const key = saved.key || `${saved?.row?.sku}|${saved?.row?.vendor}`;
    const liveRow = index.get(key) || saved.row || null;
    if (!liveRow) continue;
    if (!liveRow.category) liveRow.category = categorizeDescription(liveRow.description || "");
    const ub = unitBase(liveRow);
    const us = ub * MARKUP_MULT;
    CART.set(key, { row: liveRow, qty: Math.max(1, Math.floor(saved.qty || 1)), unitBase: ub, unitSell: us });
  }
  LABOR_LINES = Array.isArray(_restoreCache.labor) ? _restoreCache.labor.map(l => ({
    id: l.id,
    rate: Number(l.rate ?? l.base ?? 0) || 0,
    qty: Math.max(1, Math.floor(Number(l.qty ?? 1) || 1)),
    name: l.name || "Labor line",
  })) : [];
  if (typeof _restoreCache.laborIdSeq === "number") _laborIdSeq = _restoreCache.laborIdSeq;
  ACTIVE_CATEGORY = _restoreCache.activeCategory || "";
  _restoreCache = null;
  renderCart();
  updateCartBadge();
}

// Debounce
function debounce(fn, ms) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }

// ====================== Main Flow ========================
async function listSheetData() {
  const { rows } = await fetchProductSheet(SHEET_ID, DEFAULT_GID);
  ALL_ROWS = rows;
  buildCategories(ALL_ROWS);
  populateVendorFilter(ALL_ROWS);
  populateCategoryFilter(ALL_ROWS);
  applyRestoreAfterDataLoad();
  setDisabled("searchInput", false);
  setDisabled("vendorFilter", false);
  setDisabled("categoryFilter", false);
  setDisabled("clearFilters", false);
  wireControlsOnce();
  renderCategoryChips();
  applyFilters();
}

// ====================== Controls Wiring ===================
let _controlsWired = false;
function wireControlsOnce() {
  if (_controlsWired) return;
  _controlsWired = true;

  const search = document.getElementById("searchInput");
  const vendor = document.getElementById("vendorFilter");
  const catSel = document.getElementById("categoryFilter");
  const clear  = document.getElementById("clearFilters");
  const clearCartBtn = document.getElementById("clearCart");
  const addLaborBtn  = document.getElementById("addLabor");

  if (search) search.addEventListener("input", debounce(applyFilters, 120));
  if (vendor) vendor.addEventListener("change", applyFilters);
  if (catSel) catSel.addEventListener("change", () => {
    ACTIVE_CATEGORY = catSel.value || "";
    renderCategoryChips();
    applyFilters();
  });

  if (clear)  clear.addEventListener("click", () => {
    if (search) search.value = "";
    if (vendor) vendor.value = "";
    ACTIVE_CATEGORY = "";
    const catSel2 = document.getElementById("categoryFilter");
    if (catSel2) catSel2.value = "";
    renderCategoryChips();
    applyFilters();
  });

  if (clearCartBtn) clearCartBtn.addEventListener("click", clearCart);
  if (addLaborBtn)  addLaborBtn.addEventListener("click", () => addLaborLine(0, 1));
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
    if (id === "table-container") el.style.display = "block";
  } else {
    el.classList.add("hidden");
  }
}
function setDisabled(id, isDisabled) {
  const el = document.getElementById(id);
  if (!el) return;
  el.disabled = !!isDisabled;
}

// Auto-refresh every 5 minutes if signed in
setInterval(() => {
  const signedIn = !!gapi.client.getToken()?.access_token;
  if (signedIn) {
    showEl("loadingBarOverlay", true);
    listSheetData()
      .then(() => showToast("Auto-refreshed."))
      .finally(() => { showEl("loadingBarOverlay", false); });
  }
}, 300000);

// Restore staged state ASAP
document.addEventListener("DOMContentLoaded", () => {
  stageRestoreFromLocalStorage();
});

// Expose init functions
window.gapiLoaded = gapiLoaded;
window.gisLoaded  = gisLoaded;
