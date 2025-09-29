// ==== CONFIG (must be first) ====
const CLIENT_ID = "518347118969-drq9o3vr7auf78l16qcteor9ng4nv7qd.apps.googleusercontent.com";
const API_KEY   = "AIzaSyBGYsHkTEvE9eSYo9mFCUIecMcQtT8f0hg";
const SHEET_ID  = "1E3sRhqKfzxwuN6VOmjI2vjWsk_1QALEKkX7mNXzlVH8";
const SCOPES    = "https://www.googleapis.com/auth/spreadsheets.readonly";
const RL_MAX_PER_MIN = 30;       
const RL_INTERVAL_MS = 60_000;  
let __rl_timestamps = [];     
var ALL_ROWS = [];
var FILTERED_ROWS = [];
var FULLY_LOADED = false;
var EXPECTED_ROW_COUNT = Number(localStorage.getItem("EXPECTED_ROW_COUNT")||0) || 0;
const RENDER_ONLY_AFTER_INTERACTION = false; 
const RENDER_ONLY_AFTER_FULL_FETCH = false;   
var ALL_CATEGORIES = [];
var ACTIVE_CATEGORY = "";
let _controlsWired = false;
var USER_INTERACTED = false;
var NO_LOGIN_MODE = true; 
let _isLoadingPage = false;
let _noMorePages   = false;
let _pageCursor    = 0;
var gisInited = false;
var gapiInited = false;
var tokenClient = null;
var accessToken = null;
const EXPECTED_KEY = "EXPECTED_ROW_COUNT";
const chipText = window.__chipSearchText || "";
const inp = document.getElementById("searchInput");
if (inp && chipText && inp.value !== chipText) inp.value = chipText;
let __INFLIGHT = 0;         
let __ROWS_DONE = false;     
let __OVERLAY_SHOWN_AT = 0;
let __OVERLAY_HIDDEN = false;
let __LAST_ACTIVITY_TS = 0;
const OVERLAY_MIN_MS  = 1200;   
const QUIET_WINDOW_MS = 800;  
const PRODUCT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; 
const PRODUCT_CACHE_KEY = "vanir_products_cache_v2"; 
const PRODUCT_CACHE_SS_KEY = "vanir_products_cache_v2_ss";
let __filterTimer = null;
function updateTableVisibility() {
  const show = hasAnyActiveFilter(); // true if search OR a dropdown has a value
  const vp = document.getElementById("table-viewport");   // virtualized grid
  const tc = document.getElementById("table-container");  // legacy table (if used)
  if (vp) vp.style.display = show ? "" : "none";
  if (tc) tc.style.display = show ? "" : "none";
  toggleBgHint?.(); // keep your background hint in sync
}

function isFresh(savedAt){
  try { return (Date.now() - Number(savedAt || 0)) < PRODUCT_CACHE_TTL_MS; }
  catch { return false; }
}

window.addEventListener("storage", (e) => {
  if (e.key === PRODUCT_CACHE_KEY && e.newValue) {
    try {
      const obj = JSON.parse(e.newValue);
      if (obj && Array.isArray(obj.rows)) {
        window.ALL_ROWS = obj.rows.slice();
        window.FULLY_LOADED = true;
        setControlsEnabledState?.();
        applyFilters?.({ render: true, sort: "stable" });
        updateDataStatus?.("fresh", "Up to date • " + new Date(obj.savedAt).toLocaleTimeString());
      }
    } catch {}
  }
});

function loadProductCache7d(){
  try{
    let raw = sessionStorage.getItem(PRODUCT_CACHE_SS_KEY)
          || localStorage.getItem(PRODUCT_CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !Array.isArray(obj.rows) || !obj.savedAt) return null;
    // 7-day TTL
    if (Date.now() - obj.savedAt > 7*24*60*60*1000) return null;
    return obj;
  } catch { return null; }
}

function __noteActivity(){ __LAST_ACTIVITY_TS = Date.now(); }

function $(id){ return document.getElementById(id); }

function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }

async function listSheetData() {
const cached = loadProductCache7d(); 
const freshEnough = !!(cached && isFresh(cached.savedAt));
  const now = Date.now();
  if (cached) {
    ALL_ROWS = Array.isArray(cached.rows) ? cached.rows.slice() : [];
    logFetchCount("listSheetData:cache-hydrate", ALL_ROWS, { cached: true });
    setExpectedRowCount && setExpectedRowCount(ALL_ROWS.length);
    try { FULLY_LOADED = true; setControlsEnabledState?.(); } catch {}
    try { refreshCategoriesFromAllRows?.(); applyFilters?.({ render: true, sort: "stable" }); } catch {}
    updateDataStatus(freshEnough ? "fresh" : "stale",
      freshEnough ? ("Up to date • " + new Date(cached.savedAt).toLocaleTimeString())
                  : "Showing cached data… revalidating");
  }
  if (freshEnough) {
    try { bumpLoadingTo?.(100, "Ready"); } catch {}
    return;
  }
  try {
    ALL_ROWS = []; FILTERED_ROWS = []; _pageCursor = 0; _noMorePages = false;
    __ROWS_DONE = false;
    updateDataStatus("loading", cached ? "Revalidating…" : "Loading…");
    showLoadingBar?.(true, cached ? "Checking for updates…" : "Initializing…");
    bumpLoadingTo?.(25, "Fetching product data…");
    await loadNextPage();

    const headNow = fingerprintRows(ALL_ROWS);
    const headOld = cached?.fp || "none";
    logFetchCount("listSheetData:full-fetch-complete", ALL_ROWS, { cached: false });
    if (headNow === headOld && cached) {
      ALL_ROWS = cached.rows.slice();
      setExpectedRowCount?.(ALL_ROWS.length);
      __ROWS_DONE = true; FULLY_LOADED = true;
      setControlsEnabledState?.();
      applyFilters?.({ render: true, sort: "stable" });
      bumpLoadingTo?.(100, "No changes");
      showLoadingBar?.(false);
      updateDataStatus("fresh", "Up to date • " + new Date().toLocaleTimeString());
      return;
    }

    if (typeof preloadAllPages === "function") {
      await preloadAllPages(); 
    }
    _saveProductCacheDebounced();
    saveProductCache(ALL_ROWS);
    try { refreshCategoriesFromAllRows?.(); applyFilters?.({ render: true, sort: "stable" }); } catch {}
  } catch (e) {
    console.error("[listSheetData] revalidate failed", e);
    updateDataStatus("error", "Load failed");
  } finally {
    bumpLoadingTo?.(100, "Ready");
    setTimeout(() => { try { __maybeHideOverlay?.(); } catch {} }, 0);
  }
}
window.addEventListener("storage", (e) => {
  if (e.key === PRODUCT_CACHE_KEY && e.newValue) {
    try {
      const obj = JSON.parse(e.newValue);
      if (obj && Array.isArray(obj.rows)) {
        window.ALL_ROWS = obj.rows.slice();
        window.FULLY_LOADED = true;
        setControlsEnabledState?.();
        wireControlsOnce?.();               
        applyFilters?.({ render: true, sort: "stable" });
        updateDataStatus?.("fresh", "Up to date • " + new Date(obj.savedAt).toLocaleTimeString());
      }
    } catch {}
  }
});

function saveProductCache(rows){
  const payload = { rows: Array.isArray(rows)? rows : [], savedAt: Date.now() };
  const json = JSON.stringify(payload);
  try { sessionStorage.setItem(PRODUCT_CACHE_SS_KEY, json); } catch {}
  // Removed localStorage write to avoid double-caching (big memory hit)
}


function clearProductCache() {
  try { sessionStorage.removeItem(PRODUCT_CACHE_SS_KEY); } catch {}
  try { localStorage.removeItem(PRODUCT_CACHE_KEY); } catch {}
}

document.addEventListener("DOMContentLoaded", () => {
  if (__renderFromCacheNow("DOMContentLoaded")) return;
  if (!window.__SKIP_BOOTSTRAP) {
    if (window.gapi?.load) gapiLoaded();
    else console.debug("[boot] waiting for gapi script to load");
  }
});

function hasFreshCache7d() {
  const obj = loadProductCache7d();
  if (!obj) return false;
  return (Date.now() - Number(obj.savedAt)) < PRODUCT_CACHE_TTL_MS;
}

let __maxPct = 0;

function setOverlayVisible(show){
  const ov = $("loadingBarOverlay"); if (!ov) return;
  ov.style.display = show ? "flex" : "none";
  try { document.body.style.overflow = show ? "hidden" : ""; } catch {}
}

function setBar(pct){
  const bar = $("loadingBar");
  if (bar){
    const p = clamp(pct|0, 0, 100);
    bar.style.width = p + "%";
    try { bar.parentElement?.parentElement?.setAttribute("aria-valuenow", String(p)); } catch {}
  }
}

function setLabel(label){
  if (label == null) return;
  const lbl = $("loadingBarLabel"), meta = $("loadingBarMeta");
  if (lbl)  lbl.textContent  = String(label);
  if (meta) meta.textContent = String(label);
}

window.showLoadingBar = function(show, label=""){
  setOverlayVisible(show);
  if (show){
    __OVERLAY_SHOWN_AT = Date.now();
    __OVERLAY_HIDDEN   = false;
    __INFLIGHT = 0;
    __ROWS_DONE = false;
    __maxPct = 0;
    setBar(5);
    setLabel(label || "Starting…");
    __noteActivity();
  }
};
window.bumpLoadingTo = function(percent=0, label){
  __maxPct = Math.max(__maxPct, clamp(percent|0, 0, 100));
  if (label != null) setLabel(label);
  setBar(__maxPct);
};

function __maybeHideOverlay(){
  const now = Date.now();
  const minShown = (now - __OVERLAY_SHOWN_AT) >= OVERLAY_MIN_MS;
  const quiet    = (now - __LAST_ACTIVITY_TS) >= QUIET_WINDOW_MS;
  if (!__ROWS_DONE) return;
  if (__INFLIGHT > 0) return;
  if (!quiet) return;
  if (!minShown){
    setTimeout(__maybeHideOverlay, OVERLAY_MIN_MS - (now - __OVERLAY_SHOWN_AT));
    return;
  }
  if (__OVERLAY_HIDDEN) return;
  __OVERLAY_HIDDEN = true;
  try { bumpLoadingTo(100, "All records loaded"); } catch {}
  try { showLoadingBar(false); } catch {}
}

function trackAsync(promiseLike){
  __INFLIGHT++;
  return Promise.resolve(promiseLike)
    .finally(() => {
      __INFLIGHT--;
      __noteActivity();
      setTimeout(__maybeHideOverlay, 0);
    });
}

function getExpectedRowCount(){ return EXPECTED_ROW_COUNT || 0; }

function updateProgressLabelFromCounts(actual){
  const exp = getExpectedRowCount();
  if (exp > 0){
    const pct = Math.max(6, Math.min(95, Math.floor((actual / exp) * 100)));
    bumpLoadingTo(pct, `Loading ${actual} / ${exp}…`);
  } else {
    const base = Math.min(90, 5 + Math.floor(actual / 800)); 
    bumpLoadingTo(base, `Loading ${actual}…`);
  }
}

async function loadNextPage(){
  if (_isLoadingPage || _noMorePages) return;
  _isLoadingPage = true;

  try {
    const { header, dataRows, title } =
      await trackAsync(fetchRowsWindow(SHEET_ID, DEFAULT_GID, _pageCursor, VIRTUAL_PAGE_SIZE));

    logFetchCount?.("loadNextPage:window", dataRows, {
      page: _pageCursor,
      size: VIRTUAL_PAGE_SIZE,
      title
    });

    const transformed = transformWindowRows(header, dataRows);

    const startLen = ALL_ROWS.length;
    if (transformed && transformed.length){
      for (let i = 0; i < transformed.length; i++) {
        transformed[i]._seq = startLen + i;
      }
      ALL_ROWS.push(...transformed);
    }

    logFetchCount?.("loadNextPage:accumulated", ALL_ROWS, {
      page: _pageCursor,
      appended: transformed?.length || 0
    });

    const got = Array.isArray(dataRows) ? dataRows.length : 0;
    if (got < VIRTUAL_PAGE_SIZE || transformed?.length === 0) {
      _noMorePages = true;
      __ROWS_DONE = true;
      FULLY_LOADED = true;
      updateDataStatus?.("fresh", `Loaded ${ALL_ROWS.length}${getExpectedRowCount() ? ` / ${getExpectedRowCount()}` : ""} ✓`);
    } else {
      _pageCursor++;
      updateDataStatus?.("loading", `Loaded ${ALL_ROWS.length}…`);
    }

    updateProgressLabelFromCounts?.(ALL_ROWS.length);
    verifyRecordCount?.();

  } catch (e){
    console.error("[loadNextPage] error", e);
    throw e;
  } finally {
    _isLoadingPage = false;
    setTimeout(__maybeHideOverlay, 0);
  }
}

async function preloadAllPages(){
  __ROWS_DONE = false;
  _noMorePages = false;
  _pageCursor = 0;

  const title = await resolveSheetTitle(SHEET_ID, DEFAULT_GID);
  const used = await getSheetUsedRowCount(SHEET_ID, title);
  const expectedData = Math.max(0, used - 1); 
  setExpectedRowCount(expectedData);

  console.time("sheet:full-load");
  while (!_noMorePages) {
    await loadNextPage();
  }
  console.timeEnd("sheet:full-load");
}

function logFetchCount(where, rowsLike, extra = {}) {

  const got = Array.isArray(rowsLike)
    ? rowsLike.length
    : (rowsLike?.result?.values?.length ?? 0);

  const total = Array.isArray(window.ALL_ROWS) ? window.ALL_ROWS.length : 0;
  const expected = Number(getExpectedRowCount?.() || window.EXPECTED_ROW_COUNT || 0);

  console.log(`[sheet] ${where}`, {
    got,                  
    totalAccumulated: total,
    expected,             
    ...extra
  });
}



(function(){
  const __origFetch = window.fetch.bind(window);
  window.fetch = async function(input, init){
    try {
      const url = (typeof input === "string") ? input
                : (input && input.url) ? input.url
                : "";
      if (url && url.includes("content-sheets.googleapis.com/v4/spreadsheets/")){
        const data = await fetchJSON429(url, init || {}, __origFetch);
        return new Response(
          new Blob([JSON.stringify(data)], { type: "application/json" }),
          { status: 200 }
        );
      }
    } catch (e){
      console.warn("[fetch wrapper] error", e);
      throw e;
    }
    return __origFetch(input, init);
  };
})();

document.getElementById("refreshData")?.addEventListener("click", async () => {
  clearProductCache();                       
  updateDataStatus?.("loading", "Refreshing…");
  ALL_ROWS = []; FILTERED_ROWS = [];
  _pageCursor = 0; _noMorePages = false; __ROWS_DONE = false; FULLY_LOADED = false;
  showLoadingBar?.(true, "Refreshing…");
  await listSheetData();                     
  bumpLoadingTo?.(100, "Ready");
  showLoadingBar?.(false);
if (Array.isArray(ALL_ROWS) && ALL_ROWS.length > 0) {
    saveProductCache(ALL_ROWS);
  }
  updateDataStatus?.("fresh", "Up to date • " + new Date().toLocaleTimeString());
});

function setExpectedRowCount(n){
  try {
    window.EXPECTED_ROW_COUNT = Number(n || 0);
    const badge = document.getElementById("fetch-count");
    if (badge) {
      const actual = Array.isArray(window.ALL_ROWS) ? window.ALL_ROWS.length : 0;
      badge.textContent = n ? `${actual} / ${n}` : String(actual);
    }
  } catch {}
}

function getExpectedRowCount(){
  return Number(window.EXPECTED_ROW_COUNT || 0);
}

function getExpectedRowCount(){
  if (EXPECTED_ROW_COUNT > 0) return EXPECTED_ROW_COUNT;
  try {
    const fromLS = Number(localStorage.getItem('EXPECTED_ROW_COUNT')) || 0;
    if (fromLS > 0) EXPECTED_ROW_COUNT = fromLS;
  } catch {}
  return EXPECTED_ROW_COUNT || 0;
}

(function earlyHydrateIfCached(){
 const cached = loadProductCache7d?.();
const hasRows = !!(cached && Array.isArray(cached.rows) && cached.rows.length);
if (hasRows) {
  ALL_ROWS = cached.rows.slice();
  FULLY_LOADED = true;
  setExpectedRowCount?.(ALL_ROWS.length);
  setControlsEnabledState?.();
  refreshCategoriesFromAllRows?.();
  refreshVendorsFromAllRows();  
  applyFilters?.({ render: true, sort: "stable" });
  updateDataStatus?.("fresh", "Up to date • " + new Date(cached.savedAt).toLocaleTimeString());
  window.__SKIP_BOOTSTRAP = true;
} else {
  FULLY_LOADED = false;
  window.__SKIP_BOOTSTRAP = false;
}
})();

async function __rateLimitGate(){
  while (true){
    const now = Date.now();
    __rl_timestamps = __rl_timestamps.filter(t => now - t < RL_INTERVAL_MS);
    if (__rl_timestamps.length < RL_MAX_PER_MIN){
      __rl_timestamps.push(now);
      return;
    }
    const waitMs = (RL_INTERVAL_MS - (now - __rl_timestamps[0])) + Math.floor(Math.random() * 250);
    await new Promise(r => setTimeout(r, waitMs));
  }
}

(function(){
  function $(id){ return document.getElementById(id); }
  function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }
  let __maxPct = 0;

  function setBar(pct){
    const bar = $("loadingBar");
    if (bar) bar.style.width = clamp(pct|0, 0, 100) + "%";
  }

  function setLabel(label){
    const lbl = $("loadingBarLabel");
    if (lbl && label != null) lbl.textContent = String(label);
    const meta = $("loadingBarMeta");
    if (meta && label != null) meta.textContent = String(label);
  }

window.showLoadingBar = function(show, label=""){
  const ov = document.getElementById("loadingBarOverlay");
  if (!ov) return;
  ov.style.display = show ? "flex" : "none";
  try { document.body.style.overflow = show ? "hidden" : ""; } catch {}

  if (show){
    __OVERLAY_SHOWN_AT = Date.now();
    __OVERLAY_HIDDEN   = false;
    __LAST_ACTIVITY_TS = Date.now();
    try { setLoadingBar(5, label || "Starting…"); } catch {}
  }
};

  window.setLoadingBar = function(percent = 0, label){
    if (label != null) setLabel(label);
    __maxPct = clamp(percent|0, 0, 100);
    setBar(__maxPct);
  };

  window.bumpLoadingTo = function(percent = 0, label){
    __maxPct = Math.max(__maxPct, clamp(percent|0, 0, 100));
    if (label != null) setLabel(label);
    setBar(__maxPct);
  };
})();

function __noteActivity(){ __LAST_ACTIVITY_TS = Date.now(); }

// ===== Virtualized table renderer =====
let VIRT_ROW_HEIGHT = 44;
const VIRT_OVERSCAN = 10;
let __virtEls = null;
let __virtBound = false;

function __virtEnsureEls() {
  if (__virtEls) return __virtEls;
  const vp = document.getElementById("table-viewport");
  const spacer = document.getElementById("table-spacer");
  if (!vp || !spacer) return null;

  // Hidden measurer to learn height once
  const measureRow = document.createElement("div");
  measureRow.className = "vrow";
  measureRow.style.visibility = "hidden";
  measureRow.style.position = "absolute";
  measureRow.style.top = "0px";
  measureRow.innerHTML = `
    <div>Vendor</div><div>SKU</div><div>UOM</div><div>Description</div>
    <div>Helper</div><div>Multiple</div><div>Cost</div><div>Price Ext</div>
  `;
  spacer.appendChild(measureRow);

  __virtEls = { vp, spacer, measureRow };
  return __virtEls;
}

function __virtMeasureRowHeight() {
  const els = __virtEnsureEls();
  if (!els) return;
  const h = els.measureRow.getBoundingClientRect().height | 0;
  if (h > 0) VIRT_ROW_HEIGHT = h;
}

function __virtRowHTML(r, idx, topPx) {
  const key = `${String(r.sku||"")}|${String(r.vendor||"")}|${String(r.uom||"")}`;
  return `
    <div class="vrow" style="top:${topPx}px" data-key="${escapeHtml(key)}" data-idx="${idx}">
      <div>${escapeHtml(r.vendor||"")}</div>
      <div>${escapeHtml(r.sku||"")}</div>
      <div>${escapeHtml(r.uom||"")}</div>
      <div>${escapeHtml(r.description||"")}</div>
      <div>${escapeHtml(r.skuHelper||"")}</div>
      <div>${escapeHtml(r.uomMultiple==null? "" : String(r.uomMultiple))}</div>
      <div>${escapeHtml(formatMoney(r.cost))}</div>
      <div>${escapeHtml(formatMoney(unitBase(r)))}</div>
      <!-- actions (new) -->
      <div class="vactions" style="display:flex;align-items:center;gap:8px;">
        <input aria-label="Quantity" type="number" class="qty-input" min="1" step="1" value="1"
               data-idx="${idx}" style="width:70px;padding:4px 6px;">
        <button class="btn add-to-cart" data-key="${escapeHtml(key)}" data-idx="${idx}">Add</button>
      </div>
    </div>
  `;
}
function addToCartFromRow(row, key, qty) {
  try {
    if (!window.CART || !(window.CART instanceof Map)) window.CART = new Map();

    const k = key || `${row.sku}|${row.vendor}|${row.uom||""}`;
    const existing = window.CART.get(k);

    const unitBaseVal = unitBase(row);
    const item = existing || {
      key: k,
      sku: row.sku,
      vendor: row.vendor,
      uom: row.uom || "",
      desc: row.description || "",
      qty: 0,
      unitBase: unitBaseVal,
      row
    };

    item.qty = Math.max(0, Number(item.qty||0)) + Math.max(1, Number(qty||1));
    item.unitBase = unitBaseVal; // keep fresh in case pricing updated

    window.CART.set(k, item);

    if (typeof renderCart === "function") renderCart();
    if (typeof persistState === "function") persistState();
    if (typeof showToast === "function") showToast(`Added ${item.qty} × ${item.sku} (${item.vendor})`);
    const badge = document.getElementById("cartCountBadge");
    if (badge) {
      let total = 0; for (const v of window.CART.values()) total += Number(v.qty||0);
      badge.textContent = String(total);
    }
  } catch (e) {
    console.error("[addToCartFromRow] failed", e);
    try { showToast?.("Could not add item (see console)."); } catch {}
  }
}

function wireVirtualRowClicks() {
  const vp = document.getElementById("table-viewport");
  if (!vp || vp.__wiredAddClick) return;
  vp.__wiredAddClick = true;

  vp.addEventListener("click", (e) => {
    const btn = e.target.closest && e.target.closest(".add-to-cart");
    if (!btn) return;

    const rowIdx = Number(btn.getAttribute("data-idx")) || 0;
    const key = btn.getAttribute("data-key") || "";
    const row = (Array.isArray(window.FILTERED_ROWS) ? window.FILTERED_ROWS[rowIdx] : null);
    if (!row) return;

    const holder = btn.parentElement;
    let qty = 1;
    if (holder) {
      const inp = holder.querySelector(".qty-input");
      if (inp) {
        const v = Number(inp.value);
        qty = Number.isFinite(v) && v > 0 ? Math.floor(v) : 1;
      }
    }

    addToCartFromRow(row, key, qty);
  }, { passive: true });
}

function renderVirtualTableSlice() {
  const els = __virtEnsureEls();
  if (!els) return;
  const rows = Array.isArray(window.FILTERED_ROWS) ? window.FILTERED_ROWS : [];
  const total = rows.length;

  const scrollTop = els.vp.scrollTop;
  const viewportH = els.vp.clientHeight || 600;

  const firstRow = Math.max(0, Math.floor(scrollTop / VIRT_ROW_HEIGHT) - VIRT_OVERSCAN);
  const lastRow  = Math.min(total - 1, Math.ceil((scrollTop + viewportH) / VIRT_ROW_HEIGHT) + VIRT_OVERSCAN);

  let html = "";
  for (let i = firstRow; i <= lastRow; i++) {
    const top = i * VIRT_ROW_HEIGHT;
    html += __virtRowHTML(rows[i], i, top);
  }
  els.spacer.innerHTML = html;
}

function renderVirtualTableInit() {
  const els = __virtEnsureEls();
  if (!els) return;

  __virtMeasureRowHeight();

  const total = Array.isArray(window.FILTERED_ROWS) ? window.FILTERED_ROWS.length : 0;
  els.spacer.style.height = (total * VIRT_ROW_HEIGHT) + "px";

  if (!__virtBound) {
    __virtBound = true;
    els.vp.addEventListener("scroll", () => {
      window.requestAnimationFrame(renderVirtualTableSlice);
    }, { passive: true });
    window.addEventListener("resize", () => {
      __virtMeasureRowHeight();
      renderVirtualTableInit();
      renderVirtualTableSlice();
    });
  }

  renderVirtualTableSlice();
  wireVirtualRowClicks(); // <— make sure clicks are wired
}

function renderTableAllVirtual(rows) {
  // Hide legacy table path (we only use the virtual viewport)
  try {
    const tc = document.getElementById("table-container");
    if (tc) tc.style.display = "none";
  } catch {}
  const vp = document.getElementById("table-viewport");
  if (vp) vp.style.display = "";

  window.FILTERED_ROWS = Array.isArray(rows) ? rows : [];
  renderVirtualTableInit();
}

// Compatibility shim if something calls this
function initVirtualTable() {
  renderVirtualTableInit();
}



function __maybeHideOverlay(reason = ""){
  const now = Date.now();
  const minShown = (now - __OVERLAY_SHOWN_AT) >= OVERLAY_MIN_MS;
  const quiet    = (now - __LAST_ACTIVITY_TS) >= QUIET_WINDOW_MS;

  if (!__ROWS_DONE) return;
  if (__INFLIGHT > 0) return;
  if (!quiet) return;
  if (!minShown) { setTimeout(() => __maybeHideOverlay("min-delay"), OVERLAY_MIN_MS - (now - __OVERLAY_SHOWN_AT)); return; }
  if (__OVERLAY_HIDDEN) return;

  __OVERLAY_HIDDEN = true;
  try { if (typeof bumpLoadingTo === "function") bumpLoadingTo(100, "All records loaded"); } catch {}
  try { if (typeof showLoadingBar === "function") showLoadingBar(false); } catch {}
  try { if (typeof setControlsEnabledState === "function") setControlsEnabledState(); } catch {}
  console.debug("[loading] overlay hidden", reason);
}

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function parseBody(res){
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    try { return await res.json(); } catch {  }
  }
  const txt = await res.text();
  try { return JSON.parse(txt); } catch { return txt; }
}

async function fetchJSON429(url, init = {}, rawFetch = fetch){
  const MAX_ATTEMPTS = 6;
  const BASE_DELAY_MS = 300;
  const JITTER_MS = 250;
  let lastErr;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++){
    await __rateLimitGate?.(); 
    try {
      const res = await rawFetch(url, init); 
      if (res.status === 429 || res.status === 503){
        const ra = Number(res.headers.get("Retry-After"));
        let waitMs = Number.isFinite(ra) ? ra * 1000 : BASE_DELAY_MS * (2 ** attempt);
        waitMs += Math.floor(Math.random() * JITTER_MS);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      if (res.status >= 500 && res.status < 600){
        const waitMs = BASE_DELAY_MS * (2 ** attempt) + Math.floor(Math.random() * JITTER_MS);
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      if (!res.ok){
        const body = await res.text().catch(()=> "");
        const err = new Error(`HTTP ${res.status} ${res.statusText} at ${url}\n${body}`);
        err.status = res.status;
        throw err;
      }
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("application/json")) return await res.json();
      const txt = await res.text();
      try { return JSON.parse(txt); } catch { return { text: txt }; }
    } catch (e){
      lastErr = e;
      const waitMs = BASE_DELAY_MS * (2 ** attempt) + Math.floor(Math.random() * JITTER_MS);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
  throw lastErr || new Error(`fetchJSON429 exhausted retries for ${url}`);
}

function setControlsEnabledState(){
  const ready = !!FULLY_LOADED || (Array.isArray(ALL_ROWS) && ALL_ROWS.length > 0);
  setDisabled("searchInput", !ready);
  setDisabled("vendorFilter", !ready);
  setDisabled("categoryFilter", !ready);
  setDisabled("clearFilters", !ready);
}

function verifyRecordCount(){
  try {
const expected = Number(getExpectedRowCount()) || 0;
    const actual   = Array.isArray(ALL_ROWS) ? ALL_ROWS.length : 0;
    try {
      if (expected > 0) {
        const pct = Math.max(0, Math.min(100, Math.floor((actual / expected) * 100)));
        bumpLoadingTo(Math.max(40, pct), `Loading ${actual} / ${expected}…`);
      }
    } catch {}

    const ok = (expected > 0) && (actual >= expected) && (__ROWS_DONE === true);

    if (ok && !__LOADING_HID_ONCE) {
      __LOADING_HID_ONCE = true;
      bumpLoadingTo(100, "All records loaded");
      try { FULLY_LOADED = true; setControlsEnabledState?.(); } catch {}
    }

    console.log("[verifyRecordCount]", { expected, actual, ok });

    if (typeof updateDataStatus === "function"){
      const msg = expected ? `Loaded ${actual}${ok ? " ✓" : ` / ${expected}`}` : `Loaded ${actual}`;
      updateDataStatus(ok ? "fresh" : "warn", msg);
    }

    const badge = document.getElementById("fetch-count");
    if (badge){
      badge.textContent = expected ? `${actual} / ${expected}` : String(actual);
      if (ok) { badge.classList.add("ok"); badge.classList.remove("warn"); }
      else    { badge.classList.add("warn"); badge.classList.remove("ok"); }
    }
    return { expected, actual, ok };

  } catch (e){
    console.warn("[verifyRecordCount] failed", e);
    return { expected: Number(EXPECTED_ROW_COUNT) || 0, actual: 0, ok: false };
  }
}

window.setExpectedRowCount = setExpectedRowCount;
window.verifyRecordCount = verifyRecordCount;

const hideLoadingOnce = (() => {
  let done = false;
  return () => { if (done) return; done = true; showLoadingBar(false); };
})();

function normTxt(s){ return String(s || "").toLowerCase(); }
function normSKU(s){ return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); }

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

const SEARCH_MACROS = {
  
  "allroofnail": ["roof", "nail"],

};

function parseQuery(q){
  const raw = String(q || "").trim();
  if (!raw) return { pos:[], ors:[], neg:[], fields:{} };

  const m = raw.match(/"([^"]+)"|\S+/g) || [];
  const pos = [];          
  const ors = [];           
  const neg = [];           
  const fields = { sku:[], desc:[], vendor:[], uom:[], cat:[] };

  function pushMacroOrToken(token, bucket){
    const t = token.toLowerCase();
    if (SEARCH_MACROS[t]) {
      for (const expanded of SEARCH_MACROS[t]) bucket.push(expanded.toLowerCase());
    } else {
      bucket.push(t);
    }
  }

  for (let tok of m){
    if (tok.startsWith('"') && tok.endsWith('"')) {
      tok = tok.slice(1, -1);
    }

    if (tok.startsWith("-")) {
      const t = tok.slice(1);
      if (!t) continue;
 
      const f = t.match(/^(\w+):(.*)$/);
      if (f && fields[f[1]?.toLowerCase()]) {
        fields[f[1].toLowerCase()].push({ v: f[2].toLowerCase(), not: true });
      } else {
        neg.push(t.toLowerCase());
      }
      continue;
    }

    const mField = tok.match(/^(\w+):(.*)$/);
    if (mField && fields[mField[1]?.toLowerCase()]) {
      const f = mField[1].toLowerCase();
      const val = mField[2].toLowerCase();

      if (val.includes("|")){
        fields[f].push({ or: val.split("|").map(s=>s.trim()).filter(Boolean) });
      } else {
        fields[f].push({ v: val });
      }
      continue;
    }
    if (tok.includes("|")) {
      const alts = tok.split("|").map(s=>s.toLowerCase().trim()).filter(Boolean);
      if (alts.length) ors.push(alts);
      continue;
    }
    pushMacroOrToken(tok, pos);
  }

  return { pos, ors, neg, fields };
}

let __loadingBarMax = 0;

function fieldMatches(value, cond){
  const hay = String(value || "");
  const h = hay.toLowerCase();
  const hNormSKU = normSKU(hay); 
 
  function oneMatch(t){
    return tokenMatch(h, t) || tokenMatch(hNormSKU, t);
  }
  if (cond.or) {
   
    return cond.or.some(t => oneMatch(t));
  }
  if (cond.not) {
    return !oneMatch(cond.v);
  }
  return oneMatch(cond.v);
}

function rowMatches(r, qObj){
  const idx = rowIndex(r);
  for (const f of Object.keys(qObj.fields)) {
    const arr = qObj.fields[f];
    if (!arr || !arr.length) continue;
    for (const cond of arr) {
      let ok = true;
      if (f === "sku")   ok = fieldMatches(idx.skuRaw, cond) || fieldMatches(idx.sku, cond);
      else if (f === "desc")  ok = fieldMatches(idx.desc, cond);
      else if (f === "vendor") ok = fieldMatches(idx.vendor, cond);
      else if (f === "uom")    ok = fieldMatches(idx.uom, cond);
      else if (f === "cat")    ok = fieldMatches(idx.cat, cond);
      if (!ok) return false;
    }
  }

  for (const t of qObj.pos) {
   
    const ok = tokenMatch(idx.hay, t) || tokenMatch(idx.sku, t);
    if (!ok) return false;
  }
  for (const group of qObj.ors) {
    let ok = false;
    for (const alt of group) {
      if (tokenMatch(idx.hay, alt) || tokenMatch(idx.sku, alt)) { ok = true; break; }
    }
    if (!ok) return false;
  }

  for (const t of qObj.neg) {
    if (tokenMatch(idx.hay, t) || tokenMatch(idx.sku, t)) return false;
  }

  return true;
}

// === One-time migration from old storage key ===
(function migrateLegacyCart(){
  const NEW_KEY = "vanir_cart_v1";
  const OLD_KEY = "vanir_cart";
  try {
    const already = localStorage.getItem(NEW_KEY);
    const legacy  = localStorage.getItem(OLD_KEY);
    if (!already && legacy) {
      // legacy format was Array.from(CART.entries())
      const entries = JSON.parse(legacy);
      if (Array.isArray(entries)) {
        // Build CART Map from entries then let persistState() write v1 schema
        try { window.CART = new Map(entries); } catch { /* ignore */ }
        // If you already have CART as a Map, this is effectively a restore:
        if (typeof persistState === "function") persistState();
      }
    }
  } catch {}
})();


function __backoffDelay(attempt){
  const base = Math.min(16000, 500 * Math.pow(2, attempt)); 
  const jitter = Math.floor(Math.random() * 333);
  return base + jitter;
}

async function withRetry(fn, attempts = 3, baseDelayMs = 200){
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const jitter = 0.8 + Math.random()*0.4;
      const delay = Math.floor((baseDelayMs * Math.pow(2, i)) * jitter);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

async function withBackoff429(fn, attempts=5){
  let lastErr;
  for (let i=0;i<attempts;i++){
    try{
      await __rateLimitGate();
      return await fn();
    }catch(e){
      const status = e?.status || e?.result?.error?.code;
      if (status !== 429 && status !== 503) throw e;
      let ra = 0;
      try {
        const h = e?.headers;
        ra = Number(h?.['retry-after'] || h?.get?.('Retry-After') || 0);
      } catch {}
      const base = ra > 0 ? ra : Math.pow(2, i);
      const jitter = (Math.random()*0.4)+0.8;
      const delay = Math.min(30_000, base*1000*jitter);
      await new Promise(r => setTimeout(r, delay));
      lastErr = e;
    }
  }
  throw lastErr;
}

async function sheetsValuesGet(params){
  return await withBackoff429(() => gapi.client.sheets.spreadsheets.values.get(params));
}

async function sheetsSpreadsheetsGet(params){
  return await withBackoff429(() => gapi.client.sheets.spreadsheets.get(params));
}

const __headerMemo = new Map();
async function getHeaderCached(spreadsheetId, title){
  const key = spreadsheetId + '::' + title;
  if (__headerMemo.has(key)) return await __headerMemo.get(key);
  const p = (async () => {
    const headerRes = await sheetsValuesGet({
      spreadsheetId, range: `'${title}'!A1:H1`, valueRenderOption: 'UNFORMATTED_VALUE'
    });
    const header = headerRes.result.values?.[0] || [];
    __headerMemo.set(key, Promise.resolve(header)); 
    return header;
  })();
  __headerMemo.set(key, p);
  return await p;
}

// Before: const DEBUG_LOGS = true;
const DEBUG_LOGS = false;
function dbg(...args){ try { if (DEBUG_LOGS) console.log(...args); } catch(_){} }


function dgw(label, obj){ try { if (DEBUG_LOGS) console.groupCollapsed(label); console.log(obj); console.groupEnd(); } catch(_){} }

let BACKGROUND_PAGE_DELAY_MS = 400;
const RENDER_CHUNK = 200; 
const ric = window.requestIdleCallback || (fn => setTimeout(() => fn({ timeRemaining: () => 8 }), 0));
let _ingestSeq = 0; 
const VIRTUAL_PAGE_SIZE = 1500;
const VIRTUAL_PREFETCH = 1;     
let _pageTitle = null;          
let __LOADING_HID_ONCE = false;   
const DEFAULT_GID = 0;
const PRODUCT_TAB_FALLBACK = "DataLoad";
const PRODUCT_RANGE        = "A1:H10000";
const DEFAULT_PRODUCT_MARGIN_PCT = 30; 
const MARGIN = 0.30;
const MARKUP_MULT = 1 + MARGIN;
let headerRowIdx = 0;
const CART = new Map();
let LABOR_LINES = [];
const CART_URL = "cart.html";
const CART_WINDOW_NAME = "vanir_cart_tab";

function openOrFocusCart(e){
  if (e) e.preventDefault();
  const w = window.open(CART_URL, CART_WINDOW_NAME); 
  try { w && w.focus && w.focus(); } catch {}
  try { cartChannel?.postMessage({ type: "focus" }); } catch {}
}

 document.addEventListener('DOMContentLoaded', () => {
    const row = document.getElementById('gentleModeRow');
    if (row) row.hidden = true; 
  });

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
      showToast("Signed out (local).");
      setDisabled("searchInput", true);
      setDisabled("vendorFilter", true);
      setDisabled("categoryFilter", true);
      setDisabled("clearFilters", true);
      showEl("categoryChips", false);
    };
  }

  if (cartFab) {
    cartFab.onclick = openOrFocusCart; 
  }

  
  const cartLink = document.getElementById("cartLink");
  if (cartLink) cartLink.addEventListener("click", openOrFocusCart);
}

FILTERED_ROWS = [];

function bindTableHandlers(){  }

  function openOrFocusCart(e){
    if (e) e.preventDefault();
    const w = window.open(CART_URL, CART_WINDOW_NAME);
    try { w && w.focus && w.focus(); } catch(_) {}
    try { cartChannel?.postMessage({type:"focus"}); } catch(_) {}
  }

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

function gisLoaded() {
  try {
    gisInited = true; 
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
    maybeEnableButtons && maybeEnableButtons();
  }
}
async function getSheetUsedRowCount(spreadsheetId, title) {
  const res = await sheetsValuesGet({
    spreadsheetId,
    range: `'${title}'!A:A`,
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const col = res?.result?.values || [];
  return col.length; 
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

async function resolveSheetTitle(spreadsheetId, gidNumber) {
  if (_pageTitle) return _pageTitle;
  if (typeof getSheetTitleByGid === 'function') {
    _pageTitle = await getSheetTitleByGid(spreadsheetId, gidNumber);
  }
  if (!_pageTitle) _pageTitle = (typeof PRODUCT_TAB_FALLBACK !== 'undefined' ? PRODUCT_TAB_FALLBACK : 'Sheet1');
  return _pageTitle;
}

async function fetchRowsWindow(spreadsheetId, gidNumber, pageIdx, pageSize) {
  dbg("[fetchRowsWindow] pageIdx:", pageIdx, "pageSize:", pageSize);
  const title  = await resolveSheetTitle(spreadsheetId, gidNumber);
  const header = await getHeaderCached(spreadsheetId, title);
  dbg('[fetchRowsWindow] header length:', header.length);


  const startRow = (pageIdx * pageSize) + 2;        
  const endRow   = startRow + pageSize - 1;
  const range    = `'${title}'!A${startRow}:H${endRow}`;

  const res = await sheetsValuesGet({
    spreadsheetId,
    range,
    valueRenderOption: 'UNFORMATTED_VALUE'
  });
  const dataRows = res.result.values || [];
  dbg('[fetchRowsWindow] fetched rows:', dataRows.length);

  return { header, dataRows, title };
}

async function fetchJSON(url, init){
  return trackAsync(
    fetch(url, init).then(async (res) => {
      __noteActivity();
      if (!res.ok){
        const t = await res.text().catch(()=> "");
        throw new Error(`HTTP ${res.status} ${res.statusText}\n${t}`);
      }
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("application/json")){
        return res.json();
      }
      const txt = await res.text();
      try { return JSON.parse(txt); } catch { return txt; }
    })
  );
}

function hasFreshCache() {
  try {
    const raw = localStorage.getItem("PRODUCT_CACHE_V1");
    if (!raw) return false;
    const obj = JSON.parse(raw);
    if (!obj || !Array.isArray(obj.rows) || !obj.savedAt) return false;
    
    const ttl = (typeof PRODUCT_CACHE_TTL_MS === "number" && PRODUCT_CACHE_TTL_MS > 0)
      ? PRODUCT_CACHE_TTL_MS
      : (15 * 60 * 1000); 
    return (Date.now() - Number(obj.savedAt)) < ttl;
  } catch {
    return false;
  }
}

async function gapiLoaded() {
  gapi.load("client", async () => {
    const skipOverlay = hasFreshCache7d(); 
    try {
      
      if (!skipOverlay) {
        showLoadingBar?.(true, "Initializing…");
        bumpLoadingTo?.(8, "Loading Google API client…");
      }

      await gapi.client.init({
        apiKey: (typeof API_KEY !== "undefined") ? API_KEY : "",
        discoveryDocs: ["https://sheets.googleapis.com/$discovery/rest?version=v4"],
      });

      if (hasFreshCache7d?.()) {
        const cached = loadProductCache7d?.();
        if (cached && Array.isArray(cached.rows) && cached.rows.length) {
          window.ALL_ROWS = cached.rows.slice();
          try { setExpectedRowCount?.(ALL_ROWS.length); } catch {}
          window.FULLY_LOADED = true;
          setControlsEnabledState?.();
          refreshCategoriesFromAllRows?.();
          refreshVendorsFromAllRows();   
          applyFilters?.({ render: true, sort: "stable" });
          wireControlsOnce?.();
          const ts = cached.savedAt ? new Date(cached.savedAt).toLocaleTimeString() : "";
          updateDataStatus?.("fresh", ts ? `Up to date • ${ts}` : "Up to date");
          bumpLoadingTo?.(100, "Ready");
          showLoadingBar?.(false);
          return; 
        }
      }
      bumpLoadingTo?.(25, "Fetching product data…");
      await listSheetData(); 
      bumpLoadingTo?.(85, "Finalizing table…");
      applyFilters?.({ render: true, sort: "stable" });
      setControlsEnabledState?.();
      wireControlsOnce?.();
      bumpLoadingTo?.(100, "Ready");
      setTimeout(() => { try { __maybeHideOverlay?.(); } catch {} }, 0);
      setTimeout(() => showLoadingBar?.(false), 200);
    } catch (e) {
      console.error("Error loading sheet (no-login mode):", e);
      setTimeout(() => { try { __maybeHideOverlay?.(); } catch {} }, 0);
      setTimeout(() => showLoadingBar?.(false), 200);
      showToast?.("Error loading data (see console).");
    }
  });
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

async function fetchProductSheet(spreadsheetId, gidNumber = null) {
  let title = null;
  if (gidNumber !== null && gidNumber !== undefined) {
    try {
      title = await getSheetTitleByGid(spreadsheetId, gidNumber);
    } catch (e) {
      console.warn("[fetchProductSheet] getSheetTitleByGid failed, falling back:", e);
    }
  }
  if (!title) title = PRODUCT_TAB_FALLBACK;

  const res = await gapi.client.sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${title}'!${PRODUCT_RANGE}`,
  });
  const values = res.result?.values || [];

  logFetchCount?.("fetchProductSheet:raw-values", { result: { values } }, {
    title,
    range: PRODUCT_RANGE
  });

  if (!values.length) {
    return { rows: [], bySku: Object.create(null), bySkuVendor: Object.create(null), title };
  }

  const MAX_SCAN = Math.min(5, values.length);
  let headerRowIdx = 0;
  let header = values[0] || [];
  for (let r = 0; r < MAX_SCAN; r++) {
    const row = values[r] || [];
    const joined = row.map(c => String(c || "").toLowerCase());
    const hits = ["vendor", "sku", "uom", "description"].filter(k =>
      joined.some(x => x.includes(k))
    ).length;
    const nonEmpty = row.filter(c => c != null && String(c).trim() !== "").length;
    if (hits >= 2 && nonEmpty >= 3) {
      headerRowIdx = r;
      header = row;
      break;
    }
  }

  const norm = (s) => String(s ?? "").trim();
  const toKey = (s) => norm(s).toLowerCase().replace(/\s+/g, " ").replace(/[^\w ]+/g, "").replace(/\s+/g, "_");

  const h = header.map((name) => toKey(name));
  const findCol = (...candidates) => {
    for (const c of candidates) {
      const idx = h.indexOf(c);
      if (idx !== -1) return idx;
    }
    return null;
  };

  const colMap = {
    vendor:        findCol("vendor","supplier","vendor_name"),
    sku:           findCol("sku","item","item_sku","product_sku"),
    uom:           findCol("uom","unit","unit_of_measure","units"),
    description:   findCol("description","desc","product_description","name"),
    skuHelper:     findCol("sku_helper","helper","alt_sku","sku_hint"),
    uomMultiple:   findCol("uom_multiple","multiple","multiplier"),
    cost:          findCol("cost","unit_cost","buy","buy_cost"),
    priceExtended: findCol("price_extended","extended","extended_price","unit_price","sell","price"),
    marginPct:     findCol("margin_pct","margin","markup_pct","markup"),
  };

  const rows = [];
  for (let r = headerRowIdx + 1; r < values.length; r++) {
    const row = values[r] || [];

    const vendor  = colMap.vendor        != null ? row[colMap.vendor]        : "";
    const sku     = colMap.sku           != null ? row[colMap.sku]           : "";
    const uom     = colMap.uom           != null ? row[colMap.uom]           : "";
    const desc    = colMap.description   != null ? row[colMap.description]   : "";
    const helper  = colMap.skuHelper     != null ? row[colMap.skuHelper]     : "";
    const mult    = colMap.uomMultiple   != null ? parseNumber(row[colMap.uomMultiple])   : null;
    const cost    = colMap.cost          != null ? parseNumber(row[colMap.cost])          : null;
    let   px      = colMap.priceExtended != null ? parseNumber(row[colMap.priceExtended]) : null;

    const cleanSku = norm(sku);
if (!cleanSku && !nm(rawDesc)) continue;

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
      skuHelper: norm(helper) || makeSkuHelper?.(sku, vendor) || "",
      uomMultiple: mult,
      cost: cost,
      priceExtended: px,
      category: categorizeDescription?.(description),
    });
  }

  const bySku = Object.create(null);
  const bySkuVendor = Object.create(null);
  for (const r of rows) {
    const key = `${r.sku}|${r.vendor}|${r.uom || ""}`;
    bySkuVendor[key] = r;
    if (!bySku[r.sku]) bySku[r.sku] = r;
  }

  logFetchCount?.("fetchProductSheet:rows-built", rows, {
    title,
    headerRowIdx,
    productRange: PRODUCT_RANGE
  });

  return { rows, bySku, bySkuVendor, title };
}

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
        <td data-label="Qty"><input aria-label="Quantity" type="number" class="qty-input" min="1" step="1" value="0" id="qty_${idx}"></td>
        <td data-label="" class="row-actions">
          <button class="btn add-to-cart" data-key="${escapeHtml(key)}" data-idx="${idx}">Add</button>
        </td>
      </tr>`;
    }).join("");
  }
}

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
  const all = document.createElement("button");
  all.className = "chip" + (window.ACTIVE_CATEGORY ? "" : " active");
  all.textContent = "All";
  all.setAttribute("data-cat", "");
  wrap.appendChild(all);

  for (const c of (window.ALL_CATEGORIES || [])) {
    const btn = document.createElement("button");
    btn.className = "chip" + (c === window.ACTIVE_CATEGORY ? " active" : "");
    btn.textContent = c;
    btn.setAttribute("data-cat", c);
    wrap.appendChild(btn);
  }

  wrap.onclick = (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;

    window.ACTIVE_CATEGORY = chip.getAttribute("data-cat") || "";
    const sel = document.getElementById("categoryFilter");
    if (sel) sel.value = window.ACTIVE_CATEGORY;
    try { window.USER_INTERACTED = true; } catch {}

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


  // Debounced filters that drive the virtual table (single, global version)

function applyFilters({ render = true, sort = "stable" } = {}) {
  if (__filterTimer) clearTimeout(__filterTimer);
  __filterTimer = setTimeout(() => {
    __applyFiltersNow({ render, sort });
    updateTableVisibility();
  }, 180);
}



function __applyFiltersNow({ render = true, sort = "stable" } = {}) {
  const ONLY_AFTER_INTERACTION =
    (typeof RENDER_ONLY_AFTER_INTERACTION !== "undefined") ? !!RENDER_ONLY_AFTER_INTERACTION : false;
  const ONLY_AFTER_FULL_FETCH  =
    (typeof RENDER_ONLY_AFTER_FULL_FETCH  !== "undefined") ? !!RENDER_ONLY_AFTER_FULL_FETCH  : false;

  if (ONLY_AFTER_FULL_FETCH && !window.FULLY_LOADED) {
    if (render) { try { showEl?.("table-container", false); } catch {} }
    window.FILTERED_ROWS = [];
    return [];
  }
  if (ONLY_AFTER_INTERACTION && !window.USER_INTERACTED) {
    if (render) { try { showEl?.("table-container", false); } catch {} }
    window.FILTERED_ROWS = [];
    return [];
  }

  const all = Array.isArray(window.ALL_ROWS) ? window.ALL_ROWS : [];
  if (!all.length) {
    window.FILTERED_ROWS = [];
    if (render) {
      try {
        const vp = document.getElementById("table-viewport");
        if (vp) vp.style.display = "none";
        const tc = document.getElementById("table-container");
        if (tc) tc.style.display = "none";
      } catch {}
    }
    return [];
  }

  // Read controls (INSIDE the function!)
  const qRawEl = document.getElementById("searchInput");
  const qRaw = (qRawEl && typeof qRawEl.value === "string" ? qRawEl.value : "").trim();
  const vendorSel   = (document.getElementById("vendorFilter")?.value || "").trim();
  const categorySel = (window.ACTIVE_CATEGORY || document.getElementById("categoryFilter")?.value || "").trim();

  const q = qRaw.toLowerCase();
  const tokens = q.length ? q.split(/\s+/).filter(Boolean) : [];

  // Filter
  let rows = all;
  if (vendorSel) {
    rows = rows.filter(r => (String(r.vendor || "") === vendorSel));
  }
  if (categorySel) {
    rows = rows.filter(r => String(r.Category ?? r.category ?? "").trim() === categorySel);
  }
  if (tokens.length) {
    rows = rows.filter(r => {
      const idx = rowIndex(r); // builds r._idx once
      return tokens.every(t => idx.hay.includes(t));
    });
  }
updateTableVisibility();
  // Optional sort
  switch (sort) {
    case "Vendor":
      rows = rows.slice().sort((a,b)=>String(a.vendor||"").localeCompare(String(b.vendor||""), undefined, {sensitivity:"base"}));
      break;
    case "PriceAsc":
      rows = rows.slice().sort((a,b)=>(Number(a.price||a.Price||0) - Number(b.price||b.Price||0)));
      break;
    case "PriceDesc":
      rows = rows.slice().sort((a,b)=>(Number(b.price||b.Price||0) - Number(a.price||a.Price||0)));
      break;
    default:
      break;
  }

  window.FILTERED_ROWS = rows;

  if (render) {
    renderTableAllVirtual(rows);
    try {
      const badge = document.getElementById("fetch-count");
      if (badge) {
        const total = Array.isArray(window.ALL_ROWS) ? window.ALL_ROWS.length : 0;
        badge.textContent = `${rows.length} / ${total}`;
        badge.classList.add("ok");
        badge.classList.remove("warn");
      }
      updateDataStatus?.("fresh", `Showing ${rows.length}`);
    } catch {}
  }
  return rows;
  
}

let VT = {
  rows: [],          
  rowH: 36,          
  buffer: 12,       
  poolSize: 0,      
  pool: [],          
  scroller: null,    
  spacer: null,     
  firstIdx: 0,      
  lastIdx: -1,       
  raf: 0,            
};
document.getElementById("searchInput")?.addEventListener("input", () => {
  window.USER_INTERACTED = true;
  applyFilters({ render: true, sort: "stable" });
});

document.getElementById("vendorFilter")?.addEventListener("change", () => {
  window.USER_INTERACTED = true;
  applyFilters({ render: true, sort: "stable" });
});

document.getElementById("categoryFilter")?.addEventListener("change", () => {
  window.USER_INTERACTED = true;
  applyFilters({ render: true, sort: "stable" });
});

function wireControlsOnce(){
  if (window.__WIRED_ONCE) return; window.__WIRED_ONCE = true;
  const vp = document.getElementById("table-viewport");
  if (vp) vp.style.display = "";
  const tc = document.getElementById("table-container");
  if (tc) tc.style.display = "none";
  const search = document.getElementById("searchInput");
  const vendorSel = document.getElementById("vendorFilter");
  const catSel = document.getElementById("categoryFilter");
  const clearBtn = document.getElementById("clearFilters");
  const trigger = () => applyFilters({ render: true, sort: "stable" });
  search?.addEventListener("input", trigger);
  vendorSel?.addEventListener("change", trigger);
  catSel?.addEventListener("change", trigger);
  clearBtn?.addEventListener("click", () => {
    if (search) search.value = "";
    if (vendorSel) vendorSel.value = "";
    if (catSel) catSel.value = "";
    window.ACTIVE_CATEGORY = "";
    trigger();
  });
}



function initVirtualTable(initialRows) {
  VT.scroller = document.getElementById("table-viewport");
  VT.spacer   = document.getElementById("table-spacer");
  VT.rows     = Array.isArray(initialRows) ? initialRows : [];
  VT.rowH = Math.max(24, measureRowHeight());
  const vis = Math.ceil((VT.scroller.clientHeight || 600) / VT.rowH);
  VT.poolSize = Math.max(30, vis + VT.buffer * 2);
  VT.pool = [];
  VT.spacer.innerHTML = ""; 
  for (let i = 0; i < VT.poolSize; i++) {
    const n = document.createElement("div");
    n.className = "vrow";
    for (let c = 0; c < 8; c++) {
      const cell = document.createElement("div");
      n.appendChild(cell);
    }
    VT.spacer.appendChild(n);
    VT.pool.push(n);
  }
  VT.spacer.style.height = (VT.rows.length * VT.rowH) + "px";
  VT.scroller.removeEventListener("scroll", onVirtualScroll);
  VT.scroller.addEventListener("scroll", onVirtualScroll);
  VT.firstIdx = 0;
  VT.lastIdx  = -1;
  scheduleVirtualPaint();
}

function measureRowHeight(){
  const tmp = document.createElement("div");
  tmp.className = "vrow";
  for (let c = 0; c < 8; c++) tmp.appendChild(document.createElement("div"));
  tmp.style.visibility = "hidden";
  tmp.style.position = "absolute";
  tmp.style.top = "-9999px";
  document.body.appendChild(tmp);
  const h = tmp.getBoundingClientRect().height || 36;
  document.body.removeChild(tmp);
  return Math.round(h);
}

function onVirtualScroll(){
  if (VT.raf) return;
  VT.raf = requestAnimationFrame(() => {
    VT.raf = 0;
    paintVirtualSlice();
  });
}

function scheduleVirtualPaint(){
  if (VT.raf) cancelAnimationFrame(VT.raf);
  VT.raf = requestAnimationFrame(() => {
    VT.raf = 0;
    paintVirtualSlice();
  });
}

function paintVirtualSlice(){
  if (!VT.scroller) return;
  const scrollTop = VT.scroller.scrollTop|0;
  const viewportH = VT.scroller.clientHeight|0;

  const first = Math.max(0, Math.floor(scrollTop / VT.rowH) - VT.buffer);
  const last  = Math.min(VT.rows.length - 1, Math.ceil((scrollTop + viewportH) / VT.rowH) + VT.buffer);

  if (first === VT.firstIdx && last === VT.lastIdx) return;
  VT.firstIdx = first;
  VT.lastIdx  = last;

  const need = Math.max(0, last - first + 1);
  if (!need) return;

  for (let i = 0; i < VT.poolSize; i++) {
    const dom = VT.pool[i];
    const dataIdx = first + i;
    if (i >= need || dataIdx >= VT.rows.length) {
      dom.style.transform = "translateY(-99999px)";
      continue;
    }
    const r = VT.rows[dataIdx];
    const y = dataIdx * VT.rowH;
    dom.style.transform = `translateY(${y}px)`;
    const cells = dom.children;
    cells[0].textContent = safeText(r.vendor);
    cells[1].textContent = safeText(r.sku);
    cells[2].textContent = safeText(r.uom);
    cells[3].textContent = safeText(r.description);
    cells[4].textContent = safeText(r.skuHelper);
    cells[5].textContent = toFixedMaybe(r.uomMultiple);
    cells[6].textContent = moneyMaybe(r.cost);
    cells[7].textContent = moneyMaybe(r.priceExtended);
  }
}

function safeText(v){
  return (v==null) ? "" : String(v);
}

function toFixedMaybe(v){
  if (v==null || v==="") return "";
  const n = Number(v);
  return Number.isFinite(n) ? (Math.round(n*100)/100).toString() : String(v);
}

function moneyMaybe(v){
  if (v==null || v==="") return "";
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  return "$" + (Math.round(n*100)/100).toFixed(2);
}

function updateVirtualRows(newRows){
  VT.rows = Array.isArray(newRows) ? newRows : [];
  if (VT.spacer) {
    VT.spacer.style.height = (VT.rows.length * VT.rowH) + "px";
  }
  if (VT.scroller) {
    VT.scroller.scrollTop = 0; 
  }
  VT.firstIdx = 0; VT.lastIdx = -1;
  scheduleVirtualPaint();
}

function renderTableAll(rows) {
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
  if (!tbody) return;

  tbody.innerHTML = "";

  const N = rows.length;
  const chunk = Math.max(100, Math.min(500, (typeof RENDER_CHUNK === "number" ? RENDER_CHUNK : 200)));
  let i = 0;

  const ric = window.requestIdleCallback || (fn => setTimeout(() => fn({ timeRemaining: () => 8 }), 0));

  function pump(deadline){
    while ((deadline.timeRemaining ? deadline.timeRemaining() > 4 : true) && i < N) {
      const end = Math.min(i + chunk, N);
      const frag = document.createDocumentFragment();
      for (; i < end; i++) {
        const r = rows[i];
        const tr = document.createElement("tr");
        tr.setAttribute("data-key", `${r.sku}|${r.vendor}|${r.uom || ""}`);
        tr.innerHTML = `
          <td data-label="Vendor">${escapeHtml(r.vendor)}</td>
          <td data-label="SKU">${escapeHtml(r.sku)}</td>
          <td data-label="UOM">${escapeHtml(r.uom)}</td>
          <td data-label="Description">${escapeHtml(r.description)}</td>
          <td data-label="Qty"><input aria-label="Quantity" type="number" class="qty-input" min="1" step="1" value="0" id="qty_${i}"></td>
          <td data-label="" class="row-actions">
            <button class="btn add-to-cart" data-key="${escapeHtml(r.sku)}|${escapeHtml(r.vendor)}|${escapeHtml(r.uom || "")}" data-idx="${i}">Add</button>
          </td>
        `;
        frag.appendChild(tr);
      }
      tbody.appendChild(frag);
    }
    if (i < N) ric(pump);
  }
  ric(pump);
}

function addToCart(row, qty) {
  if (!(qty > 0)) return; 
const key = `${row.sku}|${row.vendor}|${row.uom || ''}`;
  const existing = CART.get(key);
  const ub = unitBase(row);
  if (existing) existing.qty += qty;
  else CART.set(key, { row, qty, unitBase: ub, marginPct: DEFAULT_PRODUCT_MARGIN_PCT });
  if (LABOR_LINES.length === 0) addLaborLine(0, 0, "Labor line", 0);
  renderCart();
  showToast(`Added ${qty} ${row?.sku || "item"} to cart`);
  showEl("cart-section", true);
  persistState();
  updateCartBadge();
}

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
      val = Math.max(0, val);
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
      qty: Math.max(0, Math.floor(Number(l.qty ?? 0) || 0)), 
      name: l.name || "Labor line",
      marginPct: Math.max(0, Number(l.marginPct) || 0), 
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

function debounce(fn, ms) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }

function hasFreshCache(){
  try{
    const raw = localStorage.getItem("PRODUCT_CACHE_V1");
    if (!raw) return false;
    const obj = JSON.parse(raw);
    if (!obj || !Array.isArray(obj.rows) || !obj.savedAt) return false;
    return (Date.now() - obj.savedAt) < PRODUCT_CACHE_TTL_MS;
  }catch{ return false; }
}

function fingerprintRows(rows, limit = 400){
  if (!Array.isArray(rows) || rows.length === 0) return "empty:0";
  const slice = rows.slice(0, limit).map(r =>
    `${r?.vendor||""}|${r?.sku||""}|${r?.uom||""}|${r?.description||""}|${r?.priceExtended??""}`
  ).join("\n");
  let h = 5381;
  for (let i = 0; i < slice.length; i++) h = ((h << 5) + h) ^ slice.charCodeAt(i);
  return (h >>> 0).toString(36) + ":" + Math.min(limit, rows.length);
}

cartChannel?.postMessage({ type: "cartUpdate", cart: Array.from(CART.entries()) });

function loadProductCache(){
  try {
    const raw = localStorage.getItem(PRODUCT_CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!Array.isArray(obj.rows)) return null;
    return obj;
  } catch (e) { return null; }
}

const _saveProductCacheDebounced = debounce(() => {
  try {
    const rows = Array.isArray(ALL_ROWS) ? ALL_ROWS : [];
    const payload = { rows, fp: fingerprintRows(rows), savedAt: Date.now() };
    localStorage.setItem(PRODUCT_CACHE_KEY, JSON.stringify(payload));
  } catch (e) { }
}, 350);

function updateDataStatus(state = "idle", message = ""){
  const el = document.getElementById("dataStatus");
  if (!el) return;
  el.setAttribute("data-state", state);
  el.textContent = message || (
    state === "loading" ? "Loading…"
    : state === "fresh" ? "Up to date"
    : state === "stale" ? "Showing cached data…"
    : state === "error" ? "Error"
    : "Ready"
  );
}

(function bindRefreshOnce(){
  const btn = document.getElementById("refreshData");
  if (!btn || btn._bound) return;
  btn._bound = true;
  btn.addEventListener("click", async () => {
    try {
      clearProductCache(); 
      updateDataStatus("loading", "Refreshing…");
      ALL_ROWS = []; FILTERED_ROWS = []; _pageCursor = 0; _noMorePages = false;
      showSkeletonRows?.(8);
      await loadNextPage(); 
      removeSkeletonRows?.();
      saveProductCache(ALL_ROWS); 
      updateDataStatus("fresh", "Up to date • " + new Date().toLocaleTimeString());
      showToast?.("Data refreshed.");
    } catch (e){
      console.error("[refreshData] failed", e);
      updateDataStatus("error", "Refresh failed");
    }
  }, { passive: true });
})();

const AUTO_PRELOAD_ALL = true;
const MAX_BACKGROUND_PAGES = Infinity;         

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function preloadAllPages() {
  try {
    let pagesFetched = 0;
    updateDataStatus && updateDataStatus("loading", "Preloading…");
    while (!_noMorePages && pagesFetched < MAX_BACKGROUND_PAGES) {
      await loadNextPage();
      pagesFetched++;
      if (BACKGROUND_PAGE_DELAY_MS) await sleep(BACKGROUND_PAGE_DELAY_MS);
    }
    FULLY_LOADED = true;
    setControlsEnabledState();
    updateDataStatus && updateDataStatus("fresh", "Up to date • " + new Date().toLocaleTimeString());
  } catch (e) {
    console.error("[preloadAllPages] failed", e);
    updateDataStatus && updateDataStatus("error", "Preload failed");
  }
}
function renderTableAppendChunked(rows, startIdx = 0){
  let i = startIdx;
  function work(deadline){
    while (i < rows.length && deadline.timeRemaining() > 1){
      const end = Math.min(i + RENDER_CHUNK, rows.length);
      renderTableAppend(rows.slice(i, end));
      i = end;
    }
    if (i < rows.length) ric(work);
  }
  ric(work);
}

async function listSheetData(){
  console.time("listSheetData");
  try {
    try { showLoadingBar?.(true, "Initializing…"); } catch {}
    try { bumpLoadingTo?.(8, "Loading Google API client…"); } catch {}
    try { updateDataStatus?.("loading", "Starting…"); } catch {}
    let renderedFromCache = false;
    try {
      renderedFromCache = __renderFromCacheNow?.() || false;
      if (renderedFromCache) {
        try {
          window.FILTERED_ROWS = Array.isArray(window.ALL_ROWS) ? window.ALL_ROWS.slice() : [];
          if (document.getElementById("table-viewport")) {
            if (!listSheetData.__vtInit && typeof initVirtualTable === "function") {
              initVirtualTable(window.FILTERED_ROWS);
              listSheetData.__vtInit = true;
            } else if (typeof updateVirtualRows === "function") {
              updateVirtualRows(window.FILTERED_ROWS);
            }
            const tc = document.getElementById("table-container");
            if (tc) tc.style.display = "none"; 
          } else if (typeof renderTableAll === "function") {
            renderTableAll(window.FILTERED_ROWS);
          }
          updateDataStatus?.("fresh", `Loaded ${window.ALL_ROWS.length} (cache)…`);
        } catch {}
      }
    } catch {}
    try { bumpLoadingTo?.(25, "Fetching sheet metadata…"); } catch {}
    window.ALL_ROWS = [];
    try { window.FILTERED_ROWS = []; } catch {}
    try { _noMorePages = false; _isLoadingPage = false; _pageCursor = 0; } catch {}
    try { bumpLoadingTo?.(45, "Loading rows…"); } catch {}
    await preloadAllPages(); 

    window.FILTERED_ROWS = Array.isArray(window.ALL_ROWS) ? window.ALL_ROWS.slice() : [];
    if (document.getElementById("table-viewport")) {
      if (!listSheetData.__vtInit && typeof initVirtualTable === "function") {
        initVirtualTable(window.FILTERED_ROWS);       
        listSheetData.__vtInit = true;
      } else if (typeof updateVirtualRows === "function") {
        updateVirtualRows(window.FILTERED_ROWS);     
      }
      const tc = document.getElementById("table-container");
      if (tc) tc.style.display = "none";
    } else {
      if (typeof renderTableAll === "function") {
        renderTableAll(window.FILTERED_ROWS);
      }
    }

    try { updateProgressLabelFromCounts?.(window.ALL_ROWS.length); } catch {}
    try { verifyRecordCount?.(); } catch {}

    const exp = (typeof getExpectedRowCount === "function") ? getExpectedRowCount() : 0;
    try {
      updateDataStatus?.(
        "fresh",
        `Loaded ${window.ALL_ROWS.length}${exp ? ` / ${exp}` : ""} ✓`
      );
    } catch {}

  } catch (e) {
    console.error("[listSheetData] error:", e);
    try { updateDataStatus?.("error", "Load failed"); } catch {}
    try { showToast?.("Error loading sheet (see console)."); } catch {}
  } finally {
    try { bumpLoadingTo?.(100, "Ready"); } catch {}
    try { setTimeout(() => showLoadingBar?.(false), 350); } catch {}
    try { setTimeout(() => __maybeHideOverlay?.(), 0); } catch {}
    console.timeEnd("listSheetData");
  }
}

;(function earlyHydrateIfCached(){
  const cached = loadProductCache7d?.();
  const hasRows = !!(cached && Array.isArray(cached.rows) && cached.rows.length);

  if (hasRows) {
    window.ALL_ROWS = cached.rows.slice();
    window.FULLY_LOADED = true;

    try { setExpectedRowCount?.(ALL_ROWS.length); } catch {}

    try { setControlsEnabledState?.(); } catch {}
    try {
      refreshCategoriesFromAllRows?.();
      refreshVendorsFromAllRows();  

      applyFilters?.({ render: true, sort: "stable" });
    } catch {}

    try { wireControlsOnce?.(); } catch {}


    try {
      const ts = cached.savedAt ? new Date(cached.savedAt).toLocaleTimeString() : "";
      updateDataStatus?.("fresh", ts ? `Loaded from cache • ${ts}` : "Loaded from cache");
    } catch {}

    window.__SKIP_BOOTSTRAP = true;
  } else {
    window.FULLY_LOADED = false;
    window.__SKIP_BOOTSTRAP = false;
  }
})();

var VENDOR_FIELD = "Vendor";  

function getVendorName(row){
  if (!row || typeof row !== "object") return "";
  let v = row[VENDOR_FIELD];
  if (!v) v = row.vendor || row.vendor_name || row["Vendor Name"] || row["vendor name"];
  return String(v ?? "").trim();
}

function computeVendorsList(){
  const set = new Set();
  if (Array.isArray(window.ALL_ROWS)) {
    for (const r of ALL_ROWS) {
      const v = getVendorName(r);
      if (v) set.add(v);
    }
  }
  return Array.from(set).sort((a,b)=>a.localeCompare(b, undefined, {sensitivity:"base"}));
}

function refreshVendorsFromAllRows() {
  const sel = document.getElementById("vendorFilter");
  if (!sel) return;

  const prev = sel.value || "";
  const vendors = computeVendorsList();

  sel.innerHTML = "";
  const optAll = document.createElement("option");
  optAll.value = "";
  optAll.textContent = "All vendors";
  sel.appendChild(optAll);

  for (const v of vendors) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    sel.appendChild(opt);
  }

  if (prev && vendors.includes(prev)) {
    sel.value = prev;
  } else {
    sel.value = "";
  }
}

function wireControlsOnce() {
  if (window._controlsWired) return;
  window._controlsWired = true;

  const search = document.getElementById("searchInput");
  const vendor = document.getElementById("vendorFilter");
  const catSel = document.getElementById("categoryFilter");
  const clear  = document.getElementById("clearFilters");
  const sortBy = document.getElementById("sortBy"); 

  try { refreshVendorsFromAllRows(); } catch {}
  try { typeof refreshCategoriesFromAllRows === "function" && refreshCategoriesFromAllRows(); } catch {}

 if (search) search.addEventListener("input", (typeof debounce === "function"
  ? debounce(() => {
       window.USER_INTERACTED = true;
       applyFilters({ render: true, sort: "stable" });
     }, 120)
   : () => {
       window.USER_INTERACTED = true;
       applyFilters({ render: true, sort: "stable" });
     }
 ));

  if (vendor) vendor.addEventListener("change", () => {
    window.USER_INTERACTED = true;
    applyFilters({ render: true, sort: "stable" });
  });

  if (catSel) catSel.addEventListener("change", () => {
    window.ACTIVE_CATEGORY = catSel.value || "";
    window.USER_INTERACTED = true;
    if (typeof renderCategoryChips === "function") renderCategoryChips();
    applyFilters({ render: true, sort: "stable" });
  });

  if (sortBy) sortBy.addEventListener("change", () => {
    window.USER_INTERACTED = true;
    applyFilters({ render: true, sort: "stable" }); 
  });

  if (clear) clear.addEventListener("click", () => {
    window.USER_INTERACTED = true;

    if (search) search.value = "";
    if (vendor) vendor.value = "";
    window.ACTIVE_CATEGORY = "";
    const catSel2 = document.getElementById("categoryFilter");
    if (catSel2) catSel2.value = "";

    if (typeof renderCategoryChips === "function") renderCategoryChips();
    applyFilters({ render: true, sort: "stable" });
  });
}

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
function setDisabled(id, disabled){
  const el = document.getElementById(id);
  if (!el) return;
  el.disabled = !!disabled;              
  el.classList.toggle("is-disabled", !!disabled); 
}
document.addEventListener("DOMContentLoaded", () => {
  if (!window.__SKIP_BOOTSTRAP) {
    if (window.gapi?.load) gapiLoaded();
    else console.debug("[boot] waiting for gapi script to load");
  }
});

(function(){
  const nf = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input?.url || "";
    if (url.includes("content-sheets.googleapis.com/v4/spreadsheets/")){
      console.warn("[NETWORK] Sheets fetch attempted:", url);
    }
    return nf(input, init);
  };
})();

console.debug("[boot] cache?", !!loadProductCache7d?.(), 
              "skip?", !!window.__SKIP_BOOTSTRAP);
setInterval(() => {
  const signedIn = !!gapi.client.getToken()?.access_token;
  if (signedIn) {
    showEl("loadingBarOverlay", true);
    listSheetData()
      .then(() => showToast("Auto-refreshed."))
      .finally(() => { showEl("loadingBarOverlay", false); });
  }
}, 300000);

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
  const header = await getHeaderCached(spreadsheetId, title);
  dbg('[fetchRowsWindow] header length:', header.length);
  const startRow = (pageIdx * pageSize) + 2;
  const endRow   = startRow + pageSize - 1;
  const range    = `'${title}'!A${startRow}:H${endRow}`;
  const res = await sheetsValuesGet({
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
    const key = (typeof headerKey === 'function')
      ? headerKey(h)
      : (''+h).trim().toLowerCase().replace(/\s+/g,'').replace(/[^\w]/g,'');
    if (key && !(key in colMap)) colMap[key] = idx;
  });

  const pn = (typeof parseNumber === 'function') ? parseNumber : (v => (v==null||v==='')?null:Number(v));
  const nm = (typeof norm === 'function') ? norm : (v => (v==null)?'':String(v).trim());
  const makeHelper = (typeof makeSkuHelper === 'function') ? makeSkuHelper : ((s, v)=> s&&v ? (s+' • '+v) : (s||v||''));
  const catFn = (typeof categorizeDescription === 'function') ? categorizeDescription : (()=>'');

  const rows = [];
  let skippedNoSku = 0, skippedAllBlank = 0;

  for (const row of (dataRows||[])) {
    const rawVendor  = colMap.vendor        != null ? row[colMap.vendor]        : '';
    const rawSku     = colMap.sku           != null ? row[colMap.sku]           : '';
    const rawUom     = colMap.uom           != null ? row[colMap.uom]           : '';
    const rawDesc    = colMap.description   != null ? row[colMap.description]   : '';
    const rawHelper  = colMap.skuhelper     != null ? row[colMap.skuhelper]     : '';
    const rawMult    = colMap.uommultiple   != null ? row[colMap.uommultiple]   : null;
    const rawCost    = colMap.cost          != null ? row[colMap.cost]          : null;
    const rawPx      = colMap.priceextended != null ? row[colMap.priceextended] : null;

    const allBlank = [rawVendor,rawSku,rawUom,rawDesc,rawHelper,rawMult,rawCost,rawPx]
      .every(v => v == null || String(v).trim() === '');
    if (allBlank) { skippedAllBlank++; continue; }

    const cleanSku = nm(rawSku);
    if (!cleanSku) { skippedNoSku++; continue; }

    let mult = rawMult===''?null:pn(rawMult);
    let cost = rawCost===''?null:pn(rawCost);
    let px   = rawPx  ===''?null:pn(rawPx);
    if (px == null) px = (mult == null ? 1 : mult) * (cost == null ? 0 : cost);

    const description = nm(rawDesc);

    rows.push({
      vendor: nm(rawVendor) || 'N/A',
      sku: cleanSku,
      uom: nm(rawUom),
      description,
      skuHelper: nm(rawHelper) || makeHelper(rawSku, rawVendor),
      uomMultiple: mult,
      cost: cost,
      priceExtended: px,
      category: catFn(description),
    });
  }

  dbg('[transformWindowRows] produced rows:', rows.length);
  console.log('[transformWindowRows:summary]', {
    input: (dataRows||[]).length,
    produced: rows.length,
    skippedNoSku,
    skippedAllBlank
  });

  return rows;
}

function renderTableAppend(rows) {
if (!hasAnyActiveFilter()) { return; }
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
      <td data-label="Qty"><input aria-label="Quantity" type="number" class="qty-input" min="0" step="1" value="0"></td>
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
  let qty = Math.max(0, Math.floor(Number(qtyInput && qtyInput.value) || 0));
    if (qty <= 0) { showToast('Enter a quantity first.'); return; }      const item = (Array.isArray(ALL_ROWS) ? ALL_ROWS : []).find(r => `${r.sku}|${r.vendor}|${r.uom || ''}` === key);
      if (item && typeof addToCart === 'function') addToCart(item, qty);
    });
  }
}

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
    const row = FILTERED_ROWS[idx]; 
    if (row) addToCart(row, qty);
  }, { passive: true });

  tbody._bound = true;
}

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
const hadActive = hasAnyActiveFilter();

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

if (typeof window !== 'undefined') {
  window.gapiLoaded = gapiLoaded;
  window.gisLoaded  = gisLoaded;
}

const __singleflight = new Map(); 
function singleflight(key, fn){
  if (__singleflight.has(key)) return __singleflight.get(key);
  const p = (async () => {
    try { return await fn(); }
    finally {     
__singleflight.delete(key); }
  })();
  __singleflight.set(key, p);
  return p;
}

const SHEET_META_CACHE = new Map();  
const HEADER_CACHE = new Map();      


async function fetchSpreadsheetMeta(spreadsheetId, apiKey){
  const cacheKey = spreadsheetId;
  if (SHEET_META_CACHE.has(cacheKey)) return SHEET_META_CACHE.get(cacheKey);
  const url = `https://content-sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}?includeGridData=false&key=${encodeURIComponent(apiKey)}`;
  const p = singleflight(`meta:${cacheKey}`, async () => {
    const data = await fetchJSON429(url, { method: "GET" });
    SHEET_META_CACHE.set(cacheKey, data);
    return data;
  });
  return await p;
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

function __renderFromCacheNow(reason = "pageshow"){
  try {
    if (!Array.isArray(window.ALL_ROWS) || window.ALL_ROWS.length === 0) return false;
    try { window._pageCursor = 0; } catch {}
    try { window._noMorePages = false; } catch {}
    try { window.__ROWS_DONE = false; } catch {}
    try { refreshCategoriesFromAllRows?.(); } catch {}
    try { refreshVendorsFromAllRows?.(); } catch {}

    window.FILTERED_ROWS = window.ALL_ROWS.slice();
    window.USER_INTERACTED = true;

    const hasVirtual = !!document.getElementById("table-viewport");
    if (hasVirtual && typeof initVirtualTable === "function") {

      if (!__renderFromCacheNow.__vtInit) {
        initVirtualTable(window.FILTERED_ROWS);
        __renderFromCacheNow.__vtInit = true;
      } else if (typeof updateVirtualRows === "function") {
        updateVirtualRows(window.FILTERED_ROWS);
      }
     
      const tc = document.getElementById("table-container");
      if (tc) tc.style.display = "none";
    } else {
      
      const tc = document.getElementById("table-container");
      if (tc) tc.style.display = "";
      if (typeof renderTableAll === "function") {
        renderTableAll(window.FILTERED_ROWS);
      } else if (typeof renderTable === "function") {
        renderTable(window.FILTERED_ROWS);
      }
    }

    try {
      const exp = (typeof getExpectedRowCount === "function") ? getExpectedRowCount() : 0;
      updateDataStatus?.("fresh", `Loaded ${window.ALL_ROWS.length}${exp ? ` / ${exp}` : ""} (cache)…`);
      const badge = document.getElementById("fetch-count");
      if (badge) {
        badge.textContent = exp ? `${window.ALL_ROWS.length} / ${exp}` : String(window.ALL_ROWS.length);
        badge.classList.add("ok"); badge.classList.remove("warn");
      }
    } catch {}

    return true;
  } catch (e) {
    console.warn("[cache] __renderFromCacheNow failed:", e);
    return false;
  }
}

window.addEventListener("pageshow", (ev) => {
  if (ev.persisted) { if (__renderFromCacheNow("BFCache")) return; }
  if (window.__SKIP_BOOTSTRAP) { if (__renderFromCacheNow("skip-bootstrap")) return; }
});

document.addEventListener("DOMContentLoaded", () => {
  if (__renderFromCacheNow("DOMContentLoaded")) return;
  if (!window.__SKIP_BOOTSTRAP) {
    if (window.gapi?.load) gapiLoaded();
    else console.debug("[boot] waiting for gapi script to load");
  }
});
