

// ---- GOOGLE SHEETS + GIS SIGN-IN CONFIG ----
const CLIENT_ID = "518347118969-drq9o3vr7auf78l16qcteor9ng4nv7qd.apps.googleusercontent.com";
const API_KEY   = "AIzaSyBGYsHkTEvE9eSYo9mFCUIecMcQtT8f0hg";
const SHEET_ID  = "1E3sRhqKfzxwuN6VOmjI2vjWsk_1QALEKkX7mNXzlVH8";
const SCOPES    = "https://www.googleapis.com/auth/spreadsheets.readonly";

// If you link to a specific gid in the URL, put it here; 0 = first tab
const DEFAULT_GID = 0;

// Table + UI config
const PRODUCT_TAB_FALLBACK = "DataLoad"; // used if we can't resolve a title from gid
const PRODUCT_RANGE        = "A1:H10000"; // Vendor..Price Extended columns

let tokenClient;
let gapiInited = false;
let gisInited  = false;

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
      // Token granted
      console.log("[GIS] Token received. Access token present:", !!tokenResponse.access_token);

      // Hide authorize, show signout
      document.getElementById("authorize_button").style.display = "none";
      document.getElementById("signout_button").style.display   = "inline-block";

      // Show loader bar while we fetch
      document.getElementById("loadingBarOverlay").style.display = "block";

      // Load data
      try {
        await listSheetData();
        showToast("Sheet loaded.");
      } catch (e) {
        console.error("Error loading sheet:", e);
        showToast("Error loading sheet (see console).");
      } finally {
        document.getElementById("loadingBarOverlay").style.display = "none";
        document.getElementById("table-container").style.display   = "block";
      }
    },
  });
  gisInited = true;
  console.log("[GIS] OAuth client initialized.");
  maybeEnableButtons();
}

function maybeEnableButtons() {
  const authBtn   = document.getElementById("authorize_button");
  const signoutBtn= document.getElementById("signout_button");

  if (!authBtn || !signoutBtn) {
    console.warn("Authorize/Signout buttons not found in DOM.");
    return;
  }

  if (gapiInited && gisInited) {
    authBtn.onclick = () => {
      console.log("[Buttons] Authorize clicked.");
      tokenClient.requestAccessToken({ prompt: "" });
    };
    signoutBtn.onclick = handleSignoutClick;
    console.log("[Buttons] Handlers attached.");
  } else {
    console.log("[Buttons] Waiting for GAPI/GIS init...");
  }
}

function handleSignoutClick() {
  const token = gapi.client.getToken();
  if (token) {
    google.accounts.oauth2.revoke(token.access_token, () => {
      console.log("[GIS] Token revoked.");
      gapi.client.setToken("");
      document.getElementById("authorize_button").style.display = "inline-block";
      document.getElementById("signout_button").style.display   = "none";
      // Clear table
      const tbody = document.querySelector("#data-table tbody");
      if (tbody) tbody.innerHTML = "";
      showToast("Signed out.");
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

// ====================== Render ============================
function formatMoney(n) {
  const x = Number(n ?? 0);
  if (!Number.isFinite(x)) return "";
  return x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderTable(rows) {
  const table = document.getElementById("data-table");
  if (!table) {
    console.warn('#data-table not found. Create <table id="data-table"><thead>…</thead><tbody></tbody></table>');
    return;
  }
  const thead = table.querySelector("thead");
  const tbody = table.querySelector("tbody");
  if (thead) {
    thead.innerHTML = `
      <tr>
        <th>Vendor</th>
        <th>SKU</th>
        <th>UOM</th>
        <th>Description</th>
        <th>SKUHelper</th>
        <th>UOM Multiple</th>
        <th>Cost</th>
        <th>Price Extended</th>
      </tr>`;
  }
  if (tbody) {
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td>${escapeHtml(r.vendor)}</td>
        <td>${escapeHtml(r.sku)}</td>
        <td>${escapeHtml(r.uom)}</td>
        <td>${escapeHtml(r.description)}</td>
        <td>${escapeHtml(r.skuHelper)}</td>
        <td>${r.uomMultiple ?? ""}</td>
        <td>${formatMoney(r.cost)}</td>
        <td>${formatMoney(r.priceExtended)}</td>
      </tr>`).join("");
  }
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

// ====================== Main Flow ========================
async function listSheetData() {
  try {
    const { rows, title } = await fetchProductSheet(SHEET_ID, DEFAULT_GID);
    console.log(`[Sheets] Rows loaded from "${title}":`, rows.length);
    renderTable(rows);
  } catch (e) {
    console.error("listSheetData() failed:", e);
    throw e;
  }
}

// ====================== Toast/UX =========================
function showToast(message = "Done") {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.style.opacity = "1";
  el.classList.add("show");
  setTimeout(() => {
    el.style.opacity = "0";
    el.classList.remove("show");
  }, 1800);
}

// Auto-refresh every 5 minutes if signed in
setInterval(() => {
  const signedIn = document.getElementById("signout_button")?.style.display === "inline-block";
  if (signedIn) {
    document.getElementById("loadingBarOverlay").style.display = "block";
    listSheetData()
      .then(() => showToast("Auto-refreshed."))
      .finally(() => {
        document.getElementById("loadingBarOverlay").style.display = "none";
      });
  }
}, 300000);

// Expose init functions to window for inline script tags that call them
window.gapiLoaded = gapiLoaded;
window.gisLoaded  = gisLoaded;
