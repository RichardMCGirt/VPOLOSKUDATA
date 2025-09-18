
// === DEBUG LOGGING ===
const DEBUG_LOGS = true;  // set to false to silence
function dbg(...args){ try { if (DEBUG_LOGS) console.log(...args); } catch(_){} }
function dgw(label, obj){ try { if (DEBUG_LOGS) console.groupCollapsed(label); console.log(obj); console.groupEnd(); } catch(_){} }
// ======================

// --- Virtualization / paging config (mobile-first) ---
const VIRTUAL_PAGE_SIZE = 250;   // ~250 rows per window feels snappy on iPhone
const VIRTUAL_PREFETCH = 1;      // prefetch next page proactively
let _pageCursor = 0;             // 0-based page index
let _pageTitle = null;           // resolved sheet title
let _isLoadingPage = false;
let _noMorePages = false;
// ===== GOOGLE SHEETS + GIS SIGN-IN (popup token flow) =====
// When adding:

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
// === NO LOGIN MODE ===
const NO_LOGIN_MODE = true;

// Global default product margin (materials only). Users can override per line.
const DEFAULT_PRODUCT_MARGIN_PCT = 30; // 30% default

// Back-compat: keep these, but line pricing now uses per-item margin where set.
const MARGIN = 0.30;
const MARKUP_MULT = 1 + MARGIN;

// --- State ---
let tokenClient;
let gapiInited = false;
let gisInited  = false;
  let headerRowIdx = 0;

// Data state
let ALL_ROWS = [];
let FILTERED_ROWS = [];
// key: sku|vendor -> {row, qty, unitBase, marginPct}
const CART = new Map();
// {id, name, rate, qty, marginPct}  // percentage (e.g., 30 => +30%)
let LABOR_LINES = [];

// Cached categories
let ALL_CATEGORIES = [];
let ACTIVE_CATEGORY = "";

// ======== Token persistence & silent refresh ========
const TOKEN_STORAGE_KEY = "vanir_gis_token_v1";
let refreshTimerId = null;
let LAST_QTY = Number(localStorage.getItem("vanir_last_qty") || 1) || 1;

function qtyFromUI(qtyEl){
  const q = Math.max(1, Math.floor(Number(qtyEl?.value) || LAST_QTY || 0));
  LAST_QTY = q; localStorage.setItem("vanir_last_qty", String(q));
  return q;
}
// Near top-level in database.js
const CART_URL = "cart.html";
const CART_WINDOW_NAME = "vanir_cart_tab";
const cartChannel = ("BroadcastChannel" in window) ? new BroadcastChannel("vanir_cart_bc") : null;

// In maybeEnableButtons(), replace the FAB click:
if (cartFab) {
  cartFab.onclick = (e) => {
    e.preventDefault();
    const w = window.open(CART_URL, CART_WINDOW_NAME);
    try { w && w.focus && w.focus(); } catch {}
    try { cartChannel?.postMessage({ type: "focus" }); } catch {}
  };
}

// Legacy shim: we now bind table clicks inside renderTable()
function bindTableHandlers(){ /* no-op (handled in renderTable) */ }

  function openOrFocusCart(e){
    if (e) e.preventDefault();
    const w = window.open(CART_URL, CART_WINDOW_NAME);
    // Most browsers will re-use the same named window instead of opening a new one
    try { w && w.focus && w.focus(); } catch(_) {}
    // Optional: nudge the cart tab to bring itself to front (see BroadcastChannel below)
    try { cartChannel?.postMessage({type:"focus"}); } catch(_) {}
  }

  // Wire it
  const cartLink = document.getElementById("cartLink");
  cartLink?.addEventListener("click", openOrFocusCart);

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
  // FASTENERS first to win over generic hardware mentions
  { name: "Fasteners", includes: [
      "screw","screws","deck screw","trim screw","self-tapping",
      "nail","nails","roofing nail","ring shank","finish nail","common nail","framing nail",
      "staple","staples",
      "anchor","concrete anchor","tapcon",
      "bolt","bolts","lag bolt","lag","carriage bolt",
      "washer","washers","nut","nuts","collated","paslode"
    ],
    excludes: ["nailer","nailing","gun","adhesive"] },

  { name: "Hardware", includes: [
      "joist hanger","hanger","bracket","connector","strap","clip","plate","tie","simpson strong-tie","strong-tie","post base","hurricane clip"
    ],
    excludes: ["screw","nail","bolt","washer","anchor"] },

  { name: "PVC", includes: ["pvc","azek","versatex","cellular pvc","pvc trim","vtp","pvc board","pvc sheet"] },

  { name: "Trim", includes: [
      "trim","casing","base","baseboard","mould","molding","crown","shoe","quarter round","qtr round","brickmould","jamb","apron","stop"
    ]},

  { name: "Siding - Vinyl", includes: [
      "vinyl siding","vinyl","soffit","fascia","j-channel","j channel","starter strip","starter-strip","starter",
      "outside corner","outside corner post","ocp","ocb","underpinning","utility trim","finish trim"
    ],
    excludes: ["hardie","fiber cement"] },

  { name: "Siding - Fiber Cement", includes: [
      "fiber cement","hardie","james hardie","hardiplank","hardieplank","hardi","fc siding","fc trim"
    ]},

  { name: "Insulation", includes: [
      "insulation","batt","r-","foam","spray foam","expanding foam","sealant foam","rigid foam","polyiso"
    ]},

  { name: "Adhesives / Sealants", includes: [
      "adhesive","construction adhesive","glue","caulk","sealant","liquid nails","polyurethane sealant","silicone"
    ]},

  { name: "Roofing", includes: [
      "roof","roofing","shingle","felt","underlayment","drip edge","ridge","ridge vent","pipe boot","ice & water","ice and water"
    ]},

  { name: "Doors / Windows", includes: [
      "door","prehang","pre-hung","slab","window","sash","stile","frame","threshold","jamb set"
    ]},

  { name: "Tools", includes: [
      "blade","saw","bit","tape","knife","hammer","drill","driver","chalk","level","square","nailer","stapler"
    ]},

  { name: "Paint / Finish", includes: [
      "paint","primer","stain","finish","enamel","latex","oil-based","acrylic"
    ]},

  { name: "Plumbing", includes: [
      "plumb","pipe","pvc sch","cpvc","pex","fitting","coupling","tee","elbow","trap","valve","supply line"
    ]},

  { name: "Lumber", includes: [
      "lumber","stud","2x","x4","osb","plywood","board","4x8","rim","joist","pt","treated","cdx","advantech","lvl"
    ]},

  { name: "Misc", includes: [] }
];
// Called by <script src="https://accounts.google.com/gsi/client" onload="gisLoaded()">
function gisLoaded() {
  try {
    gisInited = true; // just a boolean you already track
    // Create a token client only if you actually want login enabled
    if (!NO_LOGIN_MODE && window.google?.accounts?.oauth2) {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: (tokenResponse) => setAndPersistToken(tokenResponse),
      });
    }
  } catch (e) {
    console.warn("GIS init skipped or failed:", e);
  } finally {
    // Wire any buttons that depend on GIS being present
    maybeEnableButtons && maybeEnableButtons();
  }
}

function categorizeDescription(desc = "") {
  const d = String(desc || "");
  if (/\bliquid\s+nails\b/i.test(d)) return "Adhesives / Sealants";
  for (const rule of CATEGORY_RULES) {
    const hasAll = !rule.all || rule.all.every(kw => wordMatch(d, kw));
    const hasAny = rule.includes?.some(kw => wordMatch(d, kw));
    const hasExclude = rule.excludes?.some(kw => wordMatch(d, kw));
    if (hasAll && hasAny && !hasExclude) return rule.name;
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

    // Authless: enable controls and load data immediately
    try {
      // Enable UI you previously disabled until sign-in
      setDisabled("searchInput", false);
      setDisabled("vendorFilter", false);
      setDisabled("categoryFilter", false);
      setDisabled("clearFilters", false);

      showEl("table-container", true);
      showEl("loadingBarOverlay", true);
      await listSheetData();
    } catch (e) {
      console.error("Error loading sheet (no-login mode):", e);
      showToast("Error loading sheet (see console).");
    } finally {
      showEl("loadingBarOverlay", false);
    }

    // Hide any leftover auth buttons if they exist in DOM
    showEl("authorize_button", false);
    showEl("signout_button", false);

    maybeEnableButtons();
  });
}


// =============== Buttons/Handlers =========================
function maybeEnableButtons() {
  const authBtn    = document.getElementById("authorize_button");
  const signoutBtn = document.getElementById("signout_button");
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

  if (cartFab) {
    cartFab.onclick = () => {
      // Open dedicated cart page in a new tab (Amazon-style)
      const w = window.open("cart.html", "_blank", "noopener,noreferrer");
      if (!w) {
        // Fallback if popups are blocked: reveal cart section in-place
        showEl("cart-section", true);
        const target = document.querySelector("#cart-table tbody") || document.getElementById("cart-section");
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
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
      // keep per-line marginPct; unit recalculated during render
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
const key = `${r.sku}|${r.vendor}|${r.uom || ''}`;
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
    .replaceAll("<","&lt>")
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
// Compute per-item unit sell using its margin (or default)
function itemUnitSell(item) {
  const pct = Math.max(0, Number(item?.marginPct ?? DEFAULT_PRODUCT_MARGIN_PCT) || 0);
  return (Number(item.unitBase) || 0) * (1 + pct / 100);
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
        <th style="width:160px;">Qty</th>
        <th style="width:120px;"></th>
      </tr>`;
  }

  if (tbody) {
    tbody.innerHTML = rows.map((r, idx) => {
const key = `${r.sku}|${r.vendor}|${r.uom || ''}`;
      return `
      <tr data-key="${escapeHtml(key)}">
        <td data-label="Vendor">${escapeHtml(r.vendor)}</td>
        <td data-label="SKU">${escapeHtml(r.sku)}</td>
        <td data-label="UOM">${escapeHtml(r.uom)}</td>
        <td data-label="Description">${escapeHtml(r.description)}</td>
        <td data-label="Qty"><input aria-label="Quantity" type="number" class="qty-input" min="1" step="1" value="1" id="qty_${idx}"></td>
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
const beforeCount = (typeof FILTERED_ROWS !== 'undefined' && Array.isArray(FILTERED_ROWS)) ? FILTERED_ROWS.length : 0;
  dbg("[applyFilters] before:", beforeCount, "ALL_ROWS:", (Array.isArray(ALL_ROWS)? ALL_ROWS.length : 0));

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

// ====================== Labor (Qty × Rate × (1 + pct/100)) ====================
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


// ========= Persistence =========
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

// ====================== Main Flow ========================
async function listSheetData() {
dbg("[listSheetData] starting lazy load. Resetting state.");

  ALL_ROWS = [];
  FILTERED_ROWS = [];
  _pageCursor = 0; _noMorePages = false;

  showEl && showEl('table-container', true);
  showSkeletonRows(8);

  await loadNextPage(); // first window
  removeSkeletonRows();

  // prefetch next
  setTimeout(() => { loadNextPage().catch(()=>{}); }, 0);

  setDisabled && setDisabled('searchInput', false);
  setDisabled && setDisabled('vendorFilter', false);
  setDisabled && setDisabled('categoryFilter', false);
  setDisabled && setDisabled('clearFilters', false);

  if (typeof wireControlsOnce === 'function') wireControlsOnce();
  if (typeof applyRestoreAfterDataLoad === 'function') applyRestoreAfterDataLoad();
  setupInfiniteScroll();
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
  if (addLaborBtn)  addLaborBtn.addEventListener("click", () => addLaborLine(0, 1, "Labor line", 0)); // default 0% margin
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





async function resolveSheetTitle(spreadsheetId, gidNumber) {
  if (_pageTitle) return _pageTitle;
  if (typeof getSheetTitleByGid === 'function') {
    _pageTitle = await getSheetTitleByGid(spreadsheetId, gidNumber);
  }
  if (!_pageTitle) {
    _pageTitle = typeof PRODUCT_TAB_FALLBACK !== 'undefined' ? PRODUCT_TAB_FALLBACK : 'Sheet1';
  }
  return _pageTitle;
}

async function fetchRowsWindow(spreadsheetId, gidNumber, pageIdx, pageSize) {
dbg("[fetchRowsWindow] pageIdx:", pageIdx, "pageSize:", pageSize);

  const title = await resolveSheetTitle(spreadsheetId, gidNumber);
  const headerRes = await gapi.client.sheets.spreadsheets.values.get({
    spreadsheetId, range: `'${title}'!A1:H1`,
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const header = headerRes.result.values?.[0] || [];
  dbg('[fetchRowsWindow] header:', header);


  const startRow = (pageIdx * pageSize) + 2;
  const endRow   = startRow + pageSize - 1;
  const range    = `'${title}'!A${startRow}:H${endRow}`;

  const res = await gapi.client.sheets.spreadsheets.values.get({
    spreadsheetId, range, valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const dataRows = res.result.values || [];
  dbg('[fetchRowsWindow] fetched rows:', dataRows.length);

  return { header, dataRows, title };
}

function transformWindowRows(header, dataRows) {
dbg("[transformWindowRows] header length:", (header||[]).length, "dataRows:", (dataRows||[]).length);

  const colMap = {};
  (header || []).forEach((h, idx) => {
    if (typeof headerKey === 'function') {
      const key = headerKey(h);
      if (key && !(key in colMap)) colMap[key] = idx;
    } else {
      const key = (''+h).trim().toLowerCase().replace(/\s+/g, '');
      if (key && !(key in colMap)) colMap[key] = idx;
    }
  });

  const rows = [];
  for (const row of dataRows) {
    const vendor  = colMap.vendor        != null ? row[colMap.vendor]        : '';
    const sku     = colMap.sku           != null ? row[colMap.sku]           : '';
    const uom     = colMap.uom           != null ? row[colMap.uom]           : '';
    const desc    = colMap.description   != null ? row[colMap.description]   : '';
    const helper  = colMap.skuHelper     != null ? row[colMap.skuHelper]     : '';
    const multVal = colMap.uomMultiple   != null ? row[colMap.uomMultiple]   : null;
    const costVal = colMap.cost          != null ? row[colMap.cost]          : null;
    const pxVal   = colMap.priceExtended != null ? row[colMap.priceExtended] : null;

    const pn = (typeof parseNumber === 'function') ? parseNumber : (v => (v==null||v==='')?null:Number(v));
    const nm = (typeof norm === 'function') ? norm : (v => (v==null)?'':String(v).trim());

    let mult = multVal===''?null:pn(multVal);
    let cost = costVal===''?null:pn(costVal);
    let px   = pxVal===''?null:pn(pxVal);

    const cleanSku = nm(sku);
    if (!cleanSku) continue;

    if (px == null) {
      const m = (mult == null ? 1 : mult);
      const c = (cost == null ? 0 : cost);
      px = m * c;
    }
    const description = nm(desc);
    const cat = (typeof categorizeDescription === 'function') ? categorizeDescription(description) : '';

    const makeHelper = (typeof makeSkuHelper === 'function') ? makeSkuHelper : ((s, v) => s && v ? (s + ' • ' + v) : (s || v || ''));
    rows.push({
      vendor: nm(vendor) || 'N/A',
      sku: cleanSku,
      uom: nm(uom),
      description,
      skuHelper: nm(helper) || makeHelper(sku, vendor),
      uomMultiple: mult,
      cost: cost,
      priceExtended: px,
      category: cat,
    });
  }
  dbg('[transformWindowRows] produced rows:', rows.length);
  return rows;
}

function renderTableAppend(rows) {
dbg("[renderTableAppend] appending rows:", rows ? rows.length : 0);

  const table = document.getElementById('data-table') || ensureTable();
  const thead = table.querySelector('thead');
  const tbody = table.querySelector('tbody');

  if (!thead.innerHTML) {
    thead.innerHTML = `
      <tr>
        <th>Vendor</th><th>SKU</th><th>UOM</th><th>Description</th>
        <th style="width:160px;">Qty</th><th style="width:120px;"></th>
      </tr>`;
  }

  const frag = document.createDocumentFragment();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
const key = `${r.sku}|${r.vendor}|${r.uom || ''}`;
    const tr = document.createElement('tr');
    tr.setAttribute('data-key', key);
    tr.innerHTML = `
      <td data-label="Vendor">${escapeHtml(r.vendor)}</td>
      <td data-label="SKU">${escapeHtml(r.sku)}</td>
      <td data-label="UOM">${escapeHtml(r.uom || '')}</td>
      <td data-label="Description">${escapeHtml(r.description || '')}</td>
      <td data-label="Qty"><input aria-label="Quantity" type="number" class="qty-input" min="1" step="1" value="1"></td>
      <td data-label="" class="row-actions">
        <button class="btn add-to-cart">Add</button>
      </td>`;
    frag.appendChild(tr);
  }
  tbody.appendChild(frag);

  if (!tbody._bound) {
    tbody._bound = true;
    tbody.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.add-to-cart');
      if (!btn) return;
      const tr = btn.closest('tr');
      const key = tr.getAttribute('data-key');
      const qtyInput = tr.querySelector('input[type="number"]');
      const qty = Math.max(1, Math.floor(Number(qtyInput && qtyInput.value) || 1));
      const item = (Array.isArray(ALL_ROWS) ? ALL_ROWS : []).find(r => `${r.sku}|${r.vendor}` === key);
      if (item && typeof addToCart === 'function') addToCart(item, qty);
    });
  }
}
// Bind once for all future renders
function bindTableHandlersOnce(){
  const tbody = document.querySelector("#data-table tbody");
  if (!tbody || tbody._bound) return;

  tbody.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".add-to-cart");
    if (!btn) return;
    const idx = Number(btn.getAttribute("data-idx") || "0");
    const qtyInput = document.getElementById(`qty_${idx}`);
    let qty = Number(qtyInput?.value || 1);
    if (!Number.isFinite(qty) || qty <= 0) qty = 1;
    const row = FILTERED_ROWS[idx]; // matches data-idx we rendered
    if (row) addToCart(row, qty);
  }, { passive: true });

  tbody._bound = true;
}


// Call this once after you create the table element (and on startup)
bindTableHandlers();

function showSkeletonRows(n=6){
  const table = document.getElementById('data-table') || ensureTable();
  const tbody = table.querySelector('tbody');
  tbody.innerHTML = '';
  for (let i=0;i<n;i++){
    const tr = document.createElement('tr');
    tr.className = 'row-skeleton';
    tr.innerHTML = `<td colspan="6">
      <div class="sk-line"></div>
      <div class="sk-line"></div>
      <div class="sk-line short"></div>
    </td>`;
    tbody.appendChild(tr);
  }
}
function removeSkeletonRows(){
  document.querySelectorAll('.row-skeleton').forEach(el=>el.remove());
}

async function loadNextPage() {
dbg("[loadNextPage] page:", _pageCursor, "loading:", _isLoadingPage, "noMore:", _noMorePages);

  if (_isLoadingPage || _noMorePages) return;
  _isLoadingPage = true;
  if (typeof showEl === 'function') showEl('loadingBarOverlay', true);

  try {
    const { header, dataRows } = await fetchRowsWindow(SHEET_ID, DEFAULT_GID, _pageCursor, VIRTUAL_PAGE_SIZE);
    const windowRows = transformWindowRows(header, dataRows);
    dbg('[loadNextPage] windowRows length:', windowRows ? windowRows.length : 0);
    if (!windowRows.length) {
      _noMorePages = true;
    } else {
      if (!Array.isArray(windowRows)) return;
      if (!Array.isArray(ALL_ROWS)) ALL_ROWS = [];
      ALL_ROWS.push(...windowRows);
      dbg('[loadNextPage] ALL_ROWS after push:', ALL_ROWS.length);

      if (_pageCursor === 0) {
        if (typeof buildCategories === 'function') buildCategories(ALL_ROWS);
        if (typeof populateVendorFilter === 'function') populateVendorFilter(ALL_ROWS);
        if (typeof populateCategoryFilter === 'function') populateCategoryFilter(ALL_ROWS);
        if (typeof renderCategoryChips === 'function') renderCategoryChips();

        try { if (typeof applyFilters === 'function') applyFilters(); } catch(e){ console.error('[loadNextPage] applyFilters error', e); }
        const current = Array.isArray(FILTERED_ROWS) ? FILTERED_ROWS.slice() : [];
        const tbody = (document.getElementById('data-table') || ensureTable()).querySelector('tbody');
        if (tbody) tbody.innerHTML = '';
        renderTableAppend(current);
      } else {
        const before = Array.isArray(FILTERED_ROWS) ? FILTERED_ROWS.length : 0;
        try { if (typeof applyFilters === 'function') applyFilters(); } catch(e){ console.error('[loadNextPage] applyFilters error', e); }
        const after = Array.isArray(FILTERED_ROWS) ? FILTERED_ROWS.length : 0;
        const delta = (after > before && Array.isArray(FILTERED_ROWS)) ? FILTERED_ROWS.slice(before) : [];
        renderTableAppend(delta);
      }
      _pageCursor++;
    }
  } finally {
    if (typeof showEl === 'function') showEl('loadingBarOverlay', false);
    _isLoadingPage = false;
  }
}

function setupInfiniteScroll() {
  const container = document.getElementById('table-container') || document.body;
  if (document.getElementById('infinite-sentry')) return;
  const sentry = document.createElement('div');
  sentry.id = 'infinite-sentry';
  container.appendChild(sentry);

  const io = new IntersectionObserver(async (entries) => {
    if (!entries[0].isIntersecting || _isLoadingPage || _noMorePages) return;
    await loadNextPage();
  }, { rootMargin: '1200px 0px 1200px 0px' });
  io.observe(sentry);
}
