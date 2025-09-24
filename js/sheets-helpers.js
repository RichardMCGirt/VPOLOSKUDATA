// ---- singleflight global (must be at file top) ----
// Use `var` + globalThis to avoid TDZ and dedupe across files.
var __singleflight = (globalThis.__singleflight instanceof Map)
  ? globalThis.__singleflight
  : (globalThis.__singleflight = new Map());

function singleflight(key, fn) {
  const m = __singleflight;
  if (m.has(key)) return m.get(key);
  const p = (async () => await fn())();
  m.set(key, p);
  return p;
}


// ===== 429-aware fetch + rate limit gate (Sheets) =====
const hideLoadingOnce = (() => {
  let done = false;
  return () => { if (done) return; done = true; showLoadingBar(false); };
})();



// Normalize helpers
function normTxt(s){ return String(s || "").toLowerCase(); }
function normSKU(s){ return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }

// Build (and memoize) a lightweight index per row so matching is fast
function rowIndex(r){
  if (r._idx) return r._idx;
  const skuRaw = String(r.sku || "");
  const obj = {
    skuRaw,
    sku: normSKU(skuRaw),
    desc: normTxt(r.description),
    vendor: normTxt(r.vendor),
    uom: normTxt(r.uom),
    cat: normTxt(r.category || ""),
  };
  obj.hay = `${obj.sku} ${obj.desc} ${obj.vendor} ${obj.uom} ${obj.cat}`;
  r._idx = obj;
  return obj;
}

// Optional macros for “shortcut words” -> multiple real terms
const SEARCH_MACROS = {
  // Example: ALLROOFNAIL will behave like typing: roof nail
  "allroofnail": ["roof", "nail"],
  // Add more shortcuts as needed:
  // "fasteners": ["screw","nail","staple","bolt","washer","anchor"]
};

// Tokenize: quotes for phrases, space = AND, "|" inside a token = OR group.
// Supports field filters: sku:, desc:, vendor:, uom:, cat:
// Supports leading "-" to exclude.
function parseQuery(q){
  const raw = String(q || "").trim();
  if (!raw) return { pos:[], ors:[], neg:[], fields:{} };

  const m = raw.match(/"([^"]+)"|\S+/g) || [];
  const pos = [];           // plain positive tokens (AND)
  const ors = [];           // array of [alt1,alt2,...]
  const neg = [];           // negative tokens (exclude)
  const fields = { sku:[], desc:[], vendor:[], uom:[], cat:[] };

  function pushMacroOrToken(token, bucket){
    const t = token.toLowerCase();
    if (SEARCH_MACROS[t]) {
      // expand macro into multiple words (AND each)
      for (const expanded of SEARCH_MACROS[t]) bucket.push(expanded.toLowerCase());
    } else {
      bucket.push(t);
    }
  }

  for (let tok of m){
    if (tok.startsWith('"') && tok.endsWith('"')) {
      tok = tok.slice(1, -1);
    }

    // Exclusion
    if (tok.startsWith("-")) {
      const t = tok.slice(1);
      if (!t) continue;
      // fielded exclusion?
      const f = t.match(/^(\w+):(.*)$/);
      if (f && fields[f[1]?.toLowerCase()]) {
        fields[f[1].toLowerCase()].push({ v: f[2].toLowerCase(), not: true });
      } else {
        neg.push(t.toLowerCase());
      }
      continue;
    }

    // Fielded token
    const mField = tok.match(/^(\w+):(.*)$/);
    if (mField && fields[mField[1]?.toLowerCase()]) {
      const f = mField[1].toLowerCase();
      const val = mField[2].toLowerCase();
      // allow OR within field token: vendor:lansing|abc
      if (val.includes("|")){
        fields[f].push({ or: val.split("|").map(s=>s.trim()).filter(Boolean) });
      } else {
        fields[f].push({ v: val });
      }
      continue;
    }

    // OR group (unfielded)
    if (tok.includes("|")) {
      const alts = tok.split("|").map(s=>s.toLowerCase().trim()).filter(Boolean);
      if (alts.length) ors.push(alts);
      continue;
    }

    // Plain positive
    pushMacroOrToken(tok, pos);
  }

  return { pos, ors, neg, fields };
}

// Otherwise: substring match.
function tokenMatch(hay, token){
  if (!token) return true;
  if (token.endsWith("*")) {
    const base = token.slice(0, -1);
    return base ? hay.includes(base) || hay.startsWith(base) : true;
  }
  if (token.startsWith("^")) {
    const base = token.slice(1);
    return base ? hay.startsWith(base) : true;
  }
  return hay.includes(token);
}


// ===== Sheet Helpers =====
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
    const meta = await sheetsSpreadsheetsGet({
      spreadsheetId,
      includeGridData: false,
    });
    const sheet = (meta.result.sheets || []).find(
      s => String(s.properties.sheetId) === String(gidNumber))

    return sheet ? sheet.properties.title : null;
  } catch (e) {
    console.warn("Failed to get spreadsheet meta:", e);
    return null;
  }
}
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

// ===== Singleflight + caches for sheet metadata & header =====
// put near top of sheets-helpers.js (or your globals file)

function singleflight(key, fn){
  if (__singleflight.has(key)) return __singleflight.get(key);
  const p = (async () => await fn())();   // create the promise first
  __singleflight.set(key, p);             // then store it
  return p;
}


const SHEET_META_CACHE = new Map();  // spreadsheetId -> meta
const HEADER_CACHE = new Map();      // `${spreadsheetId}|${range}` -> header array

// Set this to true in dev to see logs
window.DEBUG_SHEETS_META = (window.DEBUG_SHEETS_META ?? true);

async function fetchSpreadsheetMeta(spreadsheetId, apiKey) {
  const cacheKey = String(spreadsheetId || "");
  const maskKey = (k) => (k ? String(k).slice(0, 6) + "…(masked)" : "(none)");
  const log = (...args) => { if (window.DEBUG_SHEETS_META) console.log("[sheets.meta]", ...args); };
  const warn = (...args) => { if (window.DEBUG_SHEETS_META) console.warn("[sheets.meta]", ...args); };
  const timeLabel = `sheets.meta ${cacheKey}`;

  try {
    if (!spreadsheetId) {
      warn("No spreadsheetId provided");
    }
    if (!apiKey) {
      warn("No apiKey provided");
    }

    // Cache hit?
    if (typeof SHEET_META_CACHE !== "undefined" && SHEET_META_CACHE.has(cacheKey)) {
      const cached = SHEET_META_CACHE.get(cacheKey);
      log("cache HIT →", cacheKey, "(sheets:", Array.isArray(cached?.sheets) ? cached.sheets.length : "?", ")");
      return cached;
    }
    log("cache MISS →", cacheKey);

    const url =
      `https://content-sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(cacheKey)}?includeGridData=false&key=${encodeURIComponent(apiKey)}`;

    // Singleflight wrapper (dedupe concurrent callers)
    const p = singleflight(`meta:${cacheKey}`, async () => {
      log("fetch START", { spreadsheetId: cacheKey, key: maskKey(apiKey) });
      console.time(timeLabel);
      const t0 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();

      const data = await fetchJSON429(url, { method: "GET" });

      const t1 = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
      console.timeEnd(timeLabel);

      // Lightweight payload stats
      let size = 0;
      try { size = JSON.stringify(data).length; } catch {}
      const sheetCount = Array.isArray(data?.sheets) ? data.sheets.length : 0;

      log("fetch OK",
        { ms: Math.round(t1 - t0), sheets: sheetCount, bytes: size }
      );

      if (typeof SHEET_META_CACHE !== "undefined") {
        SHEET_META_CACHE.set(cacheKey, data);
        log("cache SET →", cacheKey);
      }
      return data;
    });

    const result = await p;
    return result;
  } catch (e) {
    // Preserve original error but add context
    warn("fetch ERROR", { spreadsheetId: cacheKey, key: maskKey(apiKey), err: e && (e.stack || e.message || e) });
    throw e;
  }
}


async function fetchSheetHeader(spreadsheetId, apiKey, sheetName, startCol="A", endCol="H"){
  const range = `'${sheetName}'!${startCol}1:${endCol}1`;
  const cacheKey = `${spreadsheetId}|${range}`;
  if (HEADER_CACHE.has(cacheKey)) return HEADER_CACHE.get(cacheKey);
  const base = `https://content-sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`;
  const url = `${base}?valueRenderOption=UNFORMATTED_VALUE&key=${encodeURIComponent(apiKey)}`;
  const p = singleflight(`hdr:${cacheKey}`, async () => {
    const json = await fetchJSON429(url, { method: "GET" });
    const values = (json && json.values && json.values[0]) ? json.values[0] : [];
    HEADER_CACHE.set(cacheKey, values);
    return values;
  });
  return await p;
}
(function () {
    // If already defined elsewhere, keep it
    if (typeof window.listSheetData === "function") return;

    // Try to pick an existing loader in your app
    function pickLoader() {
      if (typeof startLazyLoad === "function") return startLazyLoad;
      if (typeof loadNextPage === "function") return async function(){ 
        // kick off at least one page so the UI renders
        return loadNextPage(); 
      };
      // Add other known names from your codebase here if needed
      return null;
    }

    const chosen = pickLoader();

    // Define the global expected by init-gapi.js
    window.listSheetData = async function () {
      if (!chosen) {
        throw new Error("No data loader found. Define startLazyLoad() or loadNextPage(), or provide a real listSheetData().");
      }
      return chosen();
    };
  })();

  // ===== Windowed fetch for Sheets values (A:H) =====
// Uses global API_KEY and SHEET_ID (already defined in ui-loading.js)
// Depends on fetchJSON429() in core-constants-and-helpers.js

(function () {
  // Cache the first-sheet title so we don't re-fetch metadata
  let __FIRST_SHEET_TITLE = null;

  async function getFirstSheetTitleREST(spreadsheetId) {
    if (__FIRST_SHEET_TITLE) return __FIRST_SHEET_TITLE;
    const metaUrl =
      `https://content-sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?includeGridData=false&key=${encodeURIComponent(API_KEY)}`;
    const meta = await fetchJSON429(metaUrl, { method: "GET" });
    const first = (meta && meta.sheets && meta.sheets[0] && meta.sheets[0].properties)
      ? meta.sheets[0].properties.title
      : null;
    if (!first) throw new Error("Could not determine first sheet title.");
    __FIRST_SHEET_TITLE = first;
    return __FIRST_SHEET_TITLE;
  }

  // Normalize header names -> object keys we use elsewhere
  function normHeaderKey(h) {
    const k = String(h || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, " ");
    if (/^sku$/.test(k)) return "sku";
    if (/^description$/.test(k)) return "description";
    if (/^vendor$/.test(k)) return "vendor";
    if (/^uom$/.test(k)) return "uom";
    if (/^category$/.test(k)) return "category";
    if (/^cost$/.test(k)) return "cost";
    if (/^price\s*extended$/.test(k) || /^price$/.test(k) || /^extended$/.test(k)) return "priceExtended";
    if (/^uom\s*multiple$/.test(k) || /^mult(iplier)?$/.test(k)) return "uomMultiple";
    return k.replace(/\s+/g, "_");
  }

  // Map a values[] row by header[] into an object with expected fields
  function mapRow(header, values) {
    const obj = {};
    for (let i = 0; i < header.length; i++) {
      const key = normHeaderKey(header[i]);
      obj[key] = values && values[i] != null ? values[i] : "";
    }
    // Coerce a few numeric fields if present
    if (obj.cost !== undefined) {
      const n = Number(String(obj.cost).replace(/[$,]/g, ""));
      obj.cost = Number.isFinite(n) ? n : null;
    }
    if (obj.priceExtended !== undefined) {
      const n = Number(String(obj.priceExtended).replace(/[$,]/g, ""));
      obj.priceExtended = Number.isFinite(n) ? n : null;
    }
    if (obj.uomMultiple !== undefined) {
      const n = Number(String(obj.uomMultiple).replace(/[$,]/g, ""));
      obj.uomMultiple = Number.isFinite(n) ? n : null;
    }
    return obj;
  }

  // ---- THE MISSING FUNCTION ----
  // Returns: { rows: Array<object>, noMore: boolean }
  window.fetchRowsWindow = async function fetchRowsWindow(pageIdx, pageSize) {
    if (!SHEET_ID || !API_KEY) throw new Error("SHEET_ID / API_KEY missing");
    const title = await getFirstSheetTitleREST(SHEET_ID);

    const startRow = 2 + (pageIdx * pageSize);           // skip header row
    const endRow   = startRow + pageSize - 1;

    // 1) Get header once (A1:H1)
    const headerUrl =
      `https://content-sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SHEET_ID)}/values/${encodeURIComponent("'" + title + "'!A1:H1")}?valueRenderOption=UNFORMATTED_VALUE&key=${encodeURIComponent(API_KEY)}`;
    const headerJson = await fetchJSON429(headerUrl, { method: "GET" });
    const header = (headerJson && headerJson.values && headerJson.values[0]) ? headerJson.values[0] : [];

    // 2) Get the window of rows (A{start}:H{end})
    const range = `'${title}'!A${startRow}:H${endRow}`;
    const dataUrl =
      `https://content-sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(SHEET_ID)}/values/${encodeURIComponent(range)}?valueRenderOption=UNFORMATTED_VALUE&key=${encodeURIComponent(API_KEY)}`;
    const dataJson = await fetchJSON429(dataUrl, { method: "GET" });

    const values = (dataJson && Array.isArray(dataJson.values)) ? dataJson.values : [];
    const rows = values.map(v => mapRow(header, v));

    // Heuristic: if we got fewer than requested, we’re likely at EOF.
    const noMore = values.length < pageSize;

    return { rows, noMore };
  };
})();
