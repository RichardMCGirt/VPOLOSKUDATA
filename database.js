// ==== CONFIG (must be first) ====
const CLIENT_ID = "518347118969-drq9o3vr7auf78l16qcteor9ng4nv7qd.apps.googleusercontent.com";
const API_KEY   = "AIzaSyBGYsHkTEvE9eSYo9mFCUIecMcQtT8f0hg";
const SHEET_ID  = "1E3sRhqKfzxwuN6VOmjI2vjWsk_1QALEKkX7mNXzlVH8";
const SCOPES    = "https://www.googleapis.com/auth/spreadsheets.readonly";
const RL_MAX_PER_MIN = 30;       // tune to your quota
const RL_INTERVAL_MS = 60_000;   // sliding 1-minute window
let __rl_timestamps = [];        // timestamps of recent calls
// ==== STATE GLOBALS (use var to avoid TDZ) ====
var ALL_ROWS = [];
var FILTERED_ROWS = [];
var FULLY_LOADED = false;
var EXPECTED_ROW_COUNT = Number(localStorage.getItem("EXPECTED_ROW_COUNT")||0) || 0;
// --- UX gating (mobile-first) ---
// UX gating
const RENDER_ONLY_AFTER_INTERACTION = false;  // was true
const RENDER_ONLY_AFTER_FULL_FETCH = false;   // was true

// ==== STATE GLOBALS (must be initialized before any code uses them) ====
// categories (must exist before applyFilters runs)
var ALL_CATEGORIES = [];
var ACTIVE_CATEGORY = "";


// add these two so early code can read them safely
var USER_INTERACTED = false;
var NO_LOGIN_MODE = true;  // keep your “no login” mode default

// Google auth/globals
var gisInited = false;
var gapiInited = false;
var tokenClient = null;
var accessToken = null;
const EXPECTED_KEY = "EXPECTED_ROW_COUNT";
// If you maintain chip text separately, sync it into the input here:
const chipText = window.__chipSearchText || "";
const inp = document.getElementById("searchInput");
if (inp && chipText && inp.value !== chipText) inp.value = chipText;

// ---- Loading overlay / quiescence globals (safe defaults) ----
// ===== Network + loading overlay coordination =====
let __INFLIGHT = 0;          // active network calls
let __ROWS_DONE = false;     // set true when pagination is finished
let __OVERLAY_SHOWN_AT = 0;
let __OVERLAY_HIDDEN = false;
let __LAST_ACTIVITY_TS = 0;
const OVERLAY_MIN_MS  = 1200;   // minimum visible time
const QUIET_WINDOW_MS = 800;    // time of silence before hide
// Cache TTL (e.g., 15 minutes)
const PRODUCT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PRODUCT_CACHE_KEY = "vanir_products_cache_v2"; // keep same as your code
const PRODUCT_CACHE_SS_KEY = "vanir_products_cache_v2_ss";
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
// ===== listSheetData with stale-while-revalidate =====
async function listSheetData() {
  // 1) Try cache
const cached = loadProductCache7d();   // <- use the 7-day cache
const freshEnough = !!(cached && isFresh(cached.savedAt));
  const now = Date.now();

  if (cached) {
    // Hydrate memory instantly for snappy UI
    ALL_ROWS = Array.isArray(cached.rows) ? cached.rows.slice() : [];
    setExpectedRowCount && setExpectedRowCount(ALL_ROWS.length);
    // Mark as fully loaded for UI gates that require it
    try { FULLY_LOADED = true; setControlsEnabledState?.(); } catch {}
    // Render vendor/category + table only when the user interacts (your gate)
    try { refreshCategoriesFromAllRows?.(); applyFilters?.({ render: true, sort: "stable" }); } catch {}
    updateDataStatus(freshEnough ? "fresh" : "stale",
      freshEnough ? ("Up to date • " + new Date(cached.savedAt).toLocaleTimeString())
                  : "Showing cached data… revalidating");
  }

  // 2) If cache is fresh, we’re done — no API calls needed
  if (freshEnough) {
    // Still nudge the overlay to end gracefully if it’s showing
    try { bumpLoadingTo?.(100, "Ready"); } catch {}
    return;
  }

  // 3) Cache is missing/stale: REVALIDATE in background without blocking UI
  try {
    // Quick “head” probe: load the first window and compare a short fingerprint
    ALL_ROWS = []; FILTERED_ROWS = []; _pageCursor = 0; _noMorePages = false;
    __ROWS_DONE = false;
    updateDataStatus("loading", cached ? "Revalidating…" : "Loading…");
    showLoadingBar?.(true, cached ? "Checking for updates…" : "Initializing…");
    bumpLoadingTo?.(25, "Fetching product data…");

    // Pull just the first page (your pager already fetches Google Sheets via your wrappers)
    await loadNextPage();

    const headNow = fingerprintRows(ALL_ROWS);
    const headOld = cached?.fp || "none";

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

    // 4) Changes detected OR no cache: continue to fetch all pages in background
    if (typeof preloadAllPages === "function") {
      await preloadAllPages(); // this uses your loadNextPage loop + nice delay, then sets FULLY_LOADED
    }

    // Save fresh cache for next navigation
    _saveProductCacheDebounced();
saveProductCache(ALL_ROWS);

    // Re-render (filters may depend on category lists)
    try { refreshCategoriesFromAllRows?.(); applyFilters?.({ render: true, sort: "stable" }); } catch {}

  } catch (e) {
    console.error("[listSheetData] revalidate failed", e);
    updateDataStatus("error", "Load failed");
  } finally {
    bumpLoadingTo?.(100, "Ready");
    // Quiescence gate will hide overlay once the network is quiet
    setTimeout(() => { try { __maybeHideOverlay?.(); } catch {} }, 0);
  }
}
function saveProductCache(rows){
  const payload = { rows: Array.isArray(rows)? rows : [], savedAt: Date.now() };
  const json = JSON.stringify(payload);
  try { sessionStorage.setItem(PRODUCT_CACHE_SS_KEY, json); } catch {}
  try { localStorage.setItem(PRODUCT_CACHE_KEY, json); } catch {}
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


// 7-day freshness check using either store.
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

// Only hide when: paging done + no inflight + quiet + min visible elapsed
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
    // Unknown total: stay under 90% and climb slowly per page
    const base = Math.min(90, 5 + Math.floor(actual / 800)); // tune
    bumpLoadingTo(base, `Loading ${actual}…`);
  }
}
async function loadNextPage(){
  if (_isLoadingPage || _noMorePages) return;
  _isLoadingPage = true;

  try {
    // wrap the fetch in the tracker so __INFLIGHT is accurate
    const windowRows = await trackAsync(fetchRowsWindow(_pageCursor, VIRTUAL_PAGE_SIZE));

    // If your transform is async, also track it. If sync, call directly.
    const transformed = transformWindowRows(windowRows);  // or await trackAsync(transformWindowRows(...))

    const startLen = ALL_ROWS.length;
    if (transformed && transformed.length){
      for (let i = 0; i < transformed.length; i++) transformed[i]._seq = startLen + i;
      ALL_ROWS.push(...transformed);
    }

    // If we got fewer than requested, we just hit the last page.
    // That means we can compute the total (if we didn’t know it).
    if (windowRows.length < VIRTUAL_PAGE_SIZE){
      const discoveredTotal = ALL_ROWS.length; // current actual is final
      if (!getExpectedRowCount()){
        setExpectedRowCount(discoveredTotal);
      }
      _noMorePages = true;
      __ROWS_DONE  = true;          // <---- paging is finished
    }

    // If we explicitly got 0 rows, we’re definitely done.
    if (windowRows.length === 0){
      if (!getExpectedRowCount()){
        setExpectedRowCount(ALL_ROWS.length);
      }
      _noMorePages = true;
      __ROWS_DONE  = true;          // <---- paging is finished
    }

    // Update visible progress every page
    updateProgressLabelFromCounts(ALL_ROWS.length);
    verifyRecordCount?.();

    // Advance the cursor if we’re not done
    if (!_noMorePages) _pageCursor++;

  } catch (e){
    console.error("[loadNextPage] error", e);
    throw e;
  } finally {
    _isLoadingPage = false;
    // Re-evaluate whether we can hide (only hides when done+quiet+no inflight)
    setTimeout(__maybeHideOverlay, 0);
  }
}

(function(){
  const __origFetch = window.fetch.bind(window);
  window.fetch = async function(input, init){
    try {
      const url = (typeof input === "string") ? input
                : (input && input.url) ? input.url
                : "";
      if (url && url.includes("content-sheets.googleapis.com/v4/spreadsheets/")){
        // IMPORTANT: pass the native fetch to avoid recursion
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
  clearProductCache();                       // clears session + local
  updateDataStatus?.("loading", "Refreshing…");
  ALL_ROWS = []; FILTERED_ROWS = [];
  _pageCursor = 0; _noMorePages = false; __ROWS_DONE = false; FULLY_LOADED = false;
  showLoadingBar?.(true, "Refreshing…");
  await listSheetData();                     // will fetch since cache was cleared
  bumpLoadingTo?.(100, "Ready");
  showLoadingBar?.(false);
if (Array.isArray(ALL_ROWS) && ALL_ROWS.length > 0) {
    saveProductCache(ALL_ROWS);
  }
  updateDataStatus?.("fresh", "Up to date • " + new Date().toLocaleTimeString());
});

function setExpectedRowCount(n, opts){
  const { persist = true, updateUI = true } = opts || {};
  const val = Math.max(0, Number(n) || 0);

  // set global for runtime checks
  window.EXPECTED_ROW_COUNT = val;

  // persist for next session (used by verifyRecordCount)
  if (persist) {
    try { localStorage.setItem(EXPECTED_KEY, String(val)); } catch {}
  }

  // lightweight UI sync (optional)
  if (updateUI) {
    const badge = document.getElementById("fetch-count");
    if (badge) {
      // If ALL_ROWS exists, show "actual / expected", else just expected
      const actual = Array.isArray(window.ALL_ROWS) ? window.ALL_ROWS.length : null;
      badge.textContent = (actual != null) ? `${actual} / ${val}` : String(val);

      // add ok/warn classes when we know both
      if (actual != null) {
        if (actual === val) { badge.classList.add("ok");   badge.classList.remove("warn"); }
        else                { badge.classList.add("warn"); badge.classList.remove("ok");   }
      }
    }

    // Optional status pill integration, if you have it
    if (typeof updateDataStatus === "function" && Array.isArray(window.ALL_ROWS)) {
      const actual = window.ALL_ROWS.length;
      const ok = (val === 0) ? true : (actual === val);
      const msg = (val === 0) ? `Loaded ${actual}` : `Loaded ${actual}${ok ? " ✓" : ` / ${val}`}`;
      updateDataStatus(ok ? "fresh" : "warn", msg);
    }
  }

  return val; // return the normalized value for convenience
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

// Wherever showLoadingBar is defined
window.showLoadingBar = function(show, label=""){
  const ov = document.getElementById("loadingBarOverlay");
  if (!ov) return;
  ov.style.display = show ? "flex" : "none";
  try { document.body.style.overflow = show ? "hidden" : ""; } catch {}

  if (show){
    __OVERLAY_SHOWN_AT = Date.now();
    __OVERLAY_HIDDEN   = false;
    __LAST_ACTIVITY_TS = Date.now();
    // small starting bump so users see movement
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

function __maybeHideOverlay(reason = ""){
  // Only hide when: paging is marked done, no network in flight, quiet for a bit, and min show time elapsed
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
  // Prefer JSON if present; fall back to text
  if (ct.includes("application/json")) {
    try { return await res.json(); } catch { /* fallthrough */ }
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
    await __rateLimitGate?.(); // ok if you have a gate; otherwise remove this line
    try {
      const res = await rawFetch(url, init); // ← use injected native fetch
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

    // progress while paging
    try {
      if (expected > 0) {
        const pct = Math.max(0, Math.min(100, Math.floor((actual / expected) * 100)));
        bumpLoadingTo(Math.max(40, pct), `Loading ${actual} / ${expected}…`);
      }
    } catch {}

    // ✅ only "ok" when we know the target, reached it (or exceeded), AND paging is done
    const ok = (expected > 0) && (actual >= expected) && (__ROWS_DONE === true);

    if (ok && !__LOADING_HID_ONCE) {
      __LOADING_HID_ONCE = true;
      bumpLoadingTo(100, "All records loaded");
      try { FULLY_LOADED = true; setControlsEnabledState?.(); } catch {}
    }

    console.log("[verifyRecordCount]", { expected, actual, ok });

    // status pill
    if (typeof updateDataStatus === "function"){
      const msg = expected ? `Loaded ${actual}${ok ? " ✓" : ` / ${expected}`}` : `Loaded ${actual}`;
      updateDataStatus(ok ? "fresh" : "warn", msg);
    }

    // badge
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



// Expose for console checking
window.setExpectedRowCount = setExpectedRowCount;
window.verifyRecordCount = verifyRecordCount;

// ===== 429-aware fetch + rate limit gate (Sheets) ============================

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
// ===== Loading Bar helpers =====
function setLoadingBar(percent = 0, label = "") {
  try {
    const bar = document.getElementById("loadingBar");
    const lab = document.getElementById("loadingBarLabel");
    const meta = document.getElementById("loadingBarMeta");
    if (bar) bar.style.width = Math.max(0, Math.min(100, percent)) + "%";
    if (lab && label) lab.textContent = label;
    if (meta && label) meta.textContent = label;
  } catch (_) {}
}

function showLoadingBar(show = true, label = "") {
  try {
    const o = document.getElementById("loadingBarOverlay");
    if (!o) return;
    o.style.display = show ? "flex" : "none";
    if (show) setLoadingBar(5, label || "Starting…");
  } catch (_) {}
}


let __loadingBarMax = 0;

// Field match helper: accepts string OR {v,not} OR {or:[…]} objects
function fieldMatches(value, cond){
  const hay = String(value || "");
  const h = hay.toLowerCase();
  const hNormSKU = normSKU(hay); // for sku: allow “LV24*” style
  // Allow matching in either raw-lower or normalized SKU
  function oneMatch(t){
    return tokenMatch(h, t) || tokenMatch(hNormSKU, t);
  }
  if (cond.or) {
    // at least one alt must match
    return cond.or.some(t => oneMatch(t));
  }
  if (cond.not) {
    return !oneMatch(cond.v);
  }
  return oneMatch(cond.v);
}

// Row-level predicate using the parsed structure
function rowMatches(r, qObj){
  const idx = rowIndex(r);

  // Fielded filters — all specified fields must match
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

  // Must contain all positive tokens (AND)
  for (const t of qObj.pos) {
    // check across the combo hay including normalized sku
    const ok = tokenMatch(idx.hay, t) || tokenMatch(idx.sku, t);
    if (!ok) return false;
  }

  // OR groups — each group must match at least one alt
  for (const group of qObj.ors) {
    let ok = false;
    for (const alt of group) {
      if (tokenMatch(idx.hay, alt) || tokenMatch(idx.sku, alt)) { ok = true; break; }
    }
    if (!ok) return false;
  }

  // Negatives — none may match
  for (const t of qObj.neg) {
    if (tokenMatch(idx.hay, t) || tokenMatch(idx.sku, t)) return false;
  }

  return true;
}


/** Exponential backoff with jitter for 429/5xx */
function __backoffDelay(attempt){
  const base = Math.min(16000, 500 * Math.pow(2, attempt)); // 0.5s, 1s, 2s, 4s, 8s, 16s cap
  const jitter = Math.floor(Math.random() * 333);
  return base + jitter;
}



// Generic retry helper for transient fetch errors
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

// === Rate limiting & 429-aware backoff (added) ===


async function withBackoff429(fn, attempts=5){
  let lastErr;
  for (let i=0;i<attempts;i++){
    try{
      await __rateLimitGate();
      return await fn();
    }catch(e){
      const status = e?.status || e?.result?.error?.code;
      if (status !== 429 && status !== 503) throw e;
      // Respect Retry-After if present, else exponential backoff with jitter
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

// Cache header row per (spreadsheetId,title) for this session
const __headerMemo = new Map();
async function getHeaderCached(spreadsheetId, title){
  const key = spreadsheetId + '::' + title;
  if (__headerMemo.has(key)) return await __headerMemo.get(key);
  const p = (async () => {
    const headerRes = await sheetsValuesGet({
      spreadsheetId, range: `'${title}'!A1:H1`, valueRenderOption: 'UNFORMATTED_VALUE'
    });
    const header = headerRes.result.values?.[0] || [];
    __headerMemo.set(key, Promise.resolve(header)); // normalize to a settled promise
    return header;
  })();
  __headerMemo.set(key, p);
  return await p;
}

const DEBUG_LOGS = true;  // set to false to silence
function dbg(...args){ try { if (DEBUG_LOGS) console.log(...args); } catch(_){} }
function dgw(label, obj){ try { if (DEBUG_LOGS) console.groupCollapsed(label); console.log(obj); console.groupEnd(); } catch(_){} }
// ======================

// --- Smooth rendering knobs ---

// --- UX gating (mobile-first) ---

let BACKGROUND_PAGE_DELAY_MS = 400;
const RENDER_CHUNK = 200; // #rows appended to DOM per idle slice
const ric = window.requestIdleCallback || (fn => setTimeout(() => fn({ timeRemaining: () => 8 }), 0));

let _ingestSeq = 0; // monotonically increasing id assigned to each row as it arrives


let _controlsWired = false;
// --- Virtualization / paging config (mobile-first) ---
const VIRTUAL_PAGE_SIZE = 300;   
const VIRTUAL_PREFETCH = 1;      // prefetch next page proactively
let _pageCursor = 0;             // 0-based page index
let _pageTitle = null;           // resolved sheet title
let _isLoadingPage = false;
let _noMorePages = false;
let __LOADING_HID_ONCE = false;   
// ===== GOOGLE SHEETS + GIS SIGN-IN (popup token flow) =====



// If you link to a specific gid in the URL, put it here; 0 = first tab
const DEFAULT_GID = 0;

// Table + UI config
const PRODUCT_TAB_FALLBACK = "DataLoad";
const PRODUCT_RANGE        = "A1:H10000";
// === NO LOGIN MODE ===

// Global default product margin (materials only). Users can override per line.
const DEFAULT_PRODUCT_MARGIN_PCT = 30; // 30% default

// Back-compat: keep these, but line pricing now uses per-item margin where set.
const MARGIN = 0.30;
const MARKUP_MULT = 1 + MARGIN;

// --- State ---

  let headerRowIdx = 0;

// key: sku|vendor -> {row, qty, unitBase, marginPct}
const CART = new Map();
// {id, name, rate, qty, marginPct}  // percentage (e.g., 30 => +30%)
let LABOR_LINES = [];

// --- Cart tab reuse (one source of truth) ---
// --- Cart tab reuse (define once) ---
const CART_URL = "cart.html";
const CART_WINDOW_NAME = "vanir_cart_tab";

function openOrFocusCart(e){
  if (e) e.preventDefault();
  const w = window.open(CART_URL, CART_WINDOW_NAME); // 👈 named window (reused)
  try { w && w.focus && w.focus(); } catch {}
  try { cartChannel?.postMessage({ type: "focus" }); } catch {}
}
function persistCart() {
  try {
    localStorage.setItem("vanir_cart", JSON.stringify(Array.from(CART.entries())));
  } catch (err) { console.error("Persist cart failed", err); }
}

// Whenever you add/remove/clear items:
persistCart();
 document.addEventListener('DOMContentLoaded', () => {
    const row = document.getElementById('gentleModeRow');
    if (row) row.hidden = true; // same as display:none
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
    cartFab.onclick = openOrFocusCart; // 👈 single source of truth
  }

  // (Optional) for a text link elsewhere:
  const cartLink = document.getElementById("cartLink");
  if (cartLink) cartLink.addEventListener("click", openOrFocusCart);
}

FILTERED_ROWS = [];



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

// ===== helper: detect fresh local cache (kept in sync with your TTL) =====
function hasFreshCache() {
  try {
    const raw = localStorage.getItem("PRODUCT_CACHE_V1");
    if (!raw) return false;
    const obj = JSON.parse(raw);
    if (!obj || !Array.isArray(obj.rows) || !obj.savedAt) return false;
    // IMPORTANT: keep PRODUCT_CACHE_TTL_MS consistent with your cache module
    const ttl = (typeof PRODUCT_CACHE_TTL_MS === "number" && PRODUCT_CACHE_TTL_MS > 0)
      ? PRODUCT_CACHE_TTL_MS
      : (15 * 60 * 1000); // default 15 min if not defined
    return (Date.now() - Number(obj.savedAt)) < ttl;
  } catch {
    return false;
  }
}

// ===== merged version =====
async function gapiLoaded() {
  gapi.load("client", async () => {
    const skipOverlay = hasFreshCache7d(); // was: hasFreshCache()
    try {
      if (!skipOverlay) {
        showLoadingBar(true, "Initializing…");
        bumpLoadingTo(8, "Loading Google API client…");
      }
      await gapi.client.init({
        apiKey: (typeof API_KEY !== "undefined") ? API_KEY : "",
        discoveryDocs: ["https://sheets.googleapis.com/$discovery/rest?version=v4"],
      });

      // If cache is fresh, hydrate and EXIT without any head-probe / fetch.
    if (hasFreshCache7d()) {
  const cached = loadProductCache7d();
  if (cached) {
    ALL_ROWS = cached.rows.slice();
    setExpectedRowCount?.(ALL_ROWS.length);
    FULLY_LOADED = true;
    setControlsEnabledState?.();
    refreshCategoriesFromAllRows?.();
    applyFilters?.({ render: true, sort: "stable" });
    updateDataStatus?.("fresh", "Up to date • " + new Date(cached.savedAt).toLocaleTimeString());
    bumpLoadingTo?.(100, "Ready");
    showLoadingBar?.(false);
    return; // <-- prevents any fetch
  }
}


      // Otherwise do your normal load:
      bumpLoadingTo?.(25, "Fetching product data…");
      await listSheetData(); // your existing function

      bumpLoadingTo?.(85, "Finalizing table…");
      applyFilters?.({ render: true, sort: "stable" });
      setControlsEnabledState?.();
      setTimeout(() => { try { __maybeHideOverlay?.(); } catch {} }, 0);
    } catch (e) {
      console.error("Error loading sheet (no-login mode):", e);
      setTimeout(() => { try { __maybeHideOverlay?.(); } catch {} }, 0);
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
        <td data-label="Qty"><input aria-label="Quantity" type="number" class="qty-input" min="1" step="1" value="0" id="qty_${idx}"></td>
        <td data-label="" class="row-actions">
          <button class="btn add-to-cart" data-key="${escapeHtml(key)}" data-idx="${idx}">Add</button>
        </td>
      </tr>`;
    }).join("");
  }
}

// ====================== Filters & Search ============================
// === Background-first: render only when a filter or search is active ===
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

    // Re-filter (stable so results don’t jump)
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


// Render ALL rows (no chunking). Define this once, before applyFilters().
function renderTableAll(rows) {
  const table = document.getElementById("data-table") || (typeof ensureTable === "function" ? ensureTable() : null);
  if (!table) return;

  let tbody = table.querySelector("tbody");
  if (!tbody) { tbody = document.createElement("tbody"); table.appendChild(tbody); }
  tbody.innerHTML = "";

  for (const row of (Array.isArray(rows) ? rows : [])) {
    const tr = document.createElement("tr");
    const cells = Array.isArray(row)
      ? row
      : (row && typeof row === "object") ? Object.values(row) : [row];
    for (const c of cells) {
      const td = document.createElement("td");
      td.textContent = (c == null) ? "" : String(c);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

function applyFilters(opts = {}) {
  // ===== Options & feature flags =====
  const render = opts.render !== false; // default true
  const sortMode = opts.sort || "stable";

  const ONLY_AFTER_INTERACTION = (typeof RENDER_ONLY_AFTER_INTERACTION !== "undefined")
    ? !!RENDER_ONLY_AFTER_INTERACTION : false;
  const ONLY_AFTER_FULL_FETCH  = (typeof RENDER_ONLY_AFTER_FULL_FETCH  !== "undefined")
    ? !!RENDER_ONLY_AFTER_FULL_FETCH  : false;

  // ===== Short-circuit render gating (optional UX) =====
  if (ONLY_AFTER_FULL_FETCH && !window.FULLY_LOADED) {
    if (render) { try { showEl?.("table-container", false); } catch {} }
    return [];
  }
  if (ONLY_AFTER_INTERACTION && !window.USER_INTERACTED) {
    if (render) { try { showEl?.("table-container", false); } catch {} }
    return [];
  }

  // ===== Data source =====
  const all = Array.isArray(window.ALL_ROWS) ? window.ALL_ROWS : [];
  const haveData = all.length > 0;

  if (!haveData) {
    window.FILTERED_ROWS = [];
    if (render) {
      try {
        const table = document.getElementById("data-table") || ensureTable?.();
        const tbody = table?.querySelector("tbody");
        if (tbody) tbody.innerHTML = "";
        if (typeof showEl === "function") showEl("table-container", false);
        else { const tc = document.getElementById("table-container"); if (tc) tc.style.display = "none"; }
        toggleBgHint?.();
      } catch {}
    }
    return [];
  }

  // ===== Read current controls safely =====
  const qRawEl = document.getElementById("searchInput");
  const qRaw = (qRawEl && typeof qRawEl.value === "string" ? qRawEl.value : "").trim();
  const vendorSel = (document.getElementById("vendorFilter")?.value || "").trim();
  const categorySel = (window.ACTIVE_CATEGORY || document.getElementById("categoryFilter")?.value || "").trim();

  // ===== Tokenize search =====
  const q = qRaw.toLowerCase();
  const tokens = q.length ? q.split(/\s+/).filter(Boolean) : [];

  // ===== Flags for filtering =====
  const hasVendor = !!vendorSel;
  const hasCategory = !!categorySel;
  const hasSearch = tokens.length > 0;

  // ===== Default: if nothing is selected/searched, show everything =====
  if (!hasVendor && !hasCategory && !hasSearch) {
    window.FILTERED_ROWS = all.slice();
    if (render) {
      if (typeof showEl === "function") showEl("table-container", true);
      else { const tc = document.getElementById("table-container"); if (tc) tc.style.display = ""; }
      renderTableAll(window.FILTERED_ROWS);
      if (typeof updateDataStatus === "function") updateDataStatus("fresh", `Showing all ${all.length}`);
      const badge = document.getElementById("fetch-count");
      if (badge) {
        badge.textContent = `${all.length} / ${all.length}`;
        badge.classList.add("ok"); badge.classList.remove("warn");
      }
    }
    return window.FILTERED_ROWS;
  }

  // ===== Otherwise, filter by vendor/category/search =====
  let filtered = all.filter((row) => {
    // Normalize row to a searchable string
    let hay = "";
    if (row && typeof row === "object") {
      if (Array.isArray(row)) {
        hay = row.join(" ").toLowerCase();
      } else {
        const vals = [];
        ["SKU", "Name", "Category", "Vendor", "Description", "Model", "Item", "Brand"]
          .forEach(k => { if (row[k] != null) vals.push(String(row[k])); });
        if (vals.length === 0) {
          for (const k in row) {
            if (Object.prototype.hasOwnProperty.call(row, k) && row[k] != null) vals.push(String(row[k]));
          }
        }
        hay = vals.join(" ").toLowerCase();
      }
    } else {
      hay = String(row ?? "").toLowerCase();
    }

    if (hasVendor && !hay.includes(vendorSel.toLowerCase())) return false;
    if (hasCategory && !hay.includes(categorySel.toLowerCase())) return false;
    if (hasSearch) { for (const t of tokens) { if (!hay.includes(t)) return false; } }

    return true;
  });

  // ===== Stable-ish ordering (optional) =====
  if (sortMode === "stable" && Array.isArray(filtered)) {
    // no-op to preserve original order
  }

  // ===== Update global & render =====
  window.FILTERED_ROWS = filtered;

  if (render) {
    try {
      if (typeof showEl === "function") showEl("table-container", true);
      else { const tc = document.getElementById("table-container"); if (tc) tc.style.display = ""; }

      toggleBgHint?.(filtered.length === 0);

      // Render ALL, not chunked
      renderTableAll(filtered);

      // Update status/badge
      if (typeof updateDataStatus === "function") {
        const total = all.length, shown = filtered.length;
        const msg = (shown === total) ? `Showing all ${shown}` : `Showing ${shown} of ${total}`;
        updateDataStatus("fresh", msg);
      }
      const badge = document.getElementById("fetch-count");
      if (badge) {
        const total = all.length, shown = filtered.length;
        badge.textContent = `${shown} / ${total}`;
        badge.classList.toggle("ok", shown === total);
        badge.classList.toggle("warn", shown !== total);
      }
    } catch (e) {
      console.warn("[applyFilters] render failed", e);
    }
  }

  return window.FILTERED_ROWS;
}





// ====================== Cart ============================
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




// ======= Cross-tab cart sync (BroadcastChannel + back/forward cache) =======
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

// When navigating back to this page (bfcache), resync the cart from localStorage
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
function hasFreshCache(){
  try{
    const raw = localStorage.getItem("PRODUCT_CACHE_V1");
    if (!raw) return false;
    const obj = JSON.parse(raw);
    if (!obj || !Array.isArray(obj.rows) || !obj.savedAt) return false;
    // keep in sync with your TTL constant
    return (Date.now() - obj.savedAt) < PRODUCT_CACHE_TTL_MS;
  }catch{ return false; }
}

// ======= Data cache & status (stale-while-revalidate) =======

/** Compact fingerprint based on first N rows' key fields. */
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

// Cache helpers
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
  } catch (e) { /* ignore */ }
}, 350);

// Status pill
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

// Wire Refresh button once
(function bindRefreshOnce(){
  const btn = document.getElementById("refreshData");
  if (!btn || btn._bound) return;
  btn._bound = true;
  btn.addEventListener("click", async () => {
    try {
      clearProductCache(); // clears session + local
      updateDataStatus("loading", "Refreshing…");
      ALL_ROWS = []; FILTERED_ROWS = []; _pageCursor = 0; _noMorePages = false;
      showSkeletonRows?.(8);
      await loadNextPage(); // or your full preloadAllPages()
      removeSkeletonRows?.();
      saveProductCache(ALL_ROWS); // persist fresh
      updateDataStatus("fresh", "Up to date • " + new Date().toLocaleTimeString());
      showToast?.("Data refreshed.");
    } catch (e){
      console.error("[refreshData] failed", e);
      updateDataStatus("error", "Refresh failed");
    }
  }, { passive: true });
})();


// ======= Background preloading (no user interaction required) =======
const AUTO_PRELOAD_ALL = true;
const MAX_BACKGROUND_PAGES = Infinity;         // limit how many windows to fetch in background

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
  if (!hasAnyActiveFilter()) { return; }
  let i = startIdx;
  function work(deadline){
    // Append in RENDER_CHUNK slices while we still have idle time
    while (i < rows.length && deadline.timeRemaining() > 1){
      const end = Math.min(i + RENDER_CHUNK, rows.length);
      renderTableAppend(rows.slice(i, end));
      i = end;
    }
    if (i < rows.length) ric(work);
  }
  ric(work);
}

// ====================== Main Flow ========================
async function listSheetData() {
  try { FULLY_LOADED = false; } catch(_) {}
  dbg("[listSheetData] starting lazy load. Resetting state.");

  // 1) Reset state only (no skeleton, no initial table render)
ALL_ROWS = [];
FILTERED_ROWS = [];
_pageCursor = 0; _noMorePages = false;
// Start background fetch for first window silently
await loadNextPage();


  // 3) Prefetch next window quickly
  setTimeout(() => { loadNextPage().catch(() => {}); }, 0);

  // 4) Enable controls
setControlsEnabledState();

  if (typeof wireControlsOnce === "function") wireControlsOnce();
  if (typeof applyRestoreAfterDataLoad === "function") applyRestoreAfterDataLoad();
  setupInfiniteScroll && setupInfiniteScroll();

  // 5) Background preload (no scrolling required)
  if (typeof preloadAllPages === "function" && AUTO_PRELOAD_ALL) { preloadAllPages().catch(() => {}); }

  updateDataStatus && updateDataStatus("fresh", "Up to date • " + new Date().toLocaleTimeString());
 if (Array.isArray(ALL_ROWS) && ALL_ROWS.length > 0) {
    saveProductCache(ALL_ROWS);
  }

  bumpLoadingTo?.(100, "Ready");
  showLoadingBar?.(false);
  FULLY_LOADED = true;
  setControlsEnabledState?.();
  applyFilters?.({ render: true, sort: "stable" });
}


// ====================== Controls Wiring ===================

function wireControlsOnce() {
  if (_controlsWired) return;
  _controlsWired = true;

  const search = document.getElementById("searchInput");
  const vendor = document.getElementById("vendorFilter");
  const catSel = document.getElementById("categoryFilter");
  const clear  = document.getElementById("clearFilters");
  const clearCartBtn = document.getElementById("clearCart");
  const addLaborBtn  = document.getElementById("addLabor");

  if (search) search.addEventListener("input", debounce(() => { USER_INTERACTED = true; applyFilters({ render: true, sort: "stable" }); }, 120));
  if (vendor) vendor.addEventListener("change", () => { USER_INTERACTED = true; applyFilters({ render: true, sort: "stable" }); });
  if (catSel) catSel.addEventListener("change", () => {
    ACTIVE_CATEGORY = catSel.value || "";
    USER_INTERACTED = true;
    renderCategoryChips();
    applyFilters({ render: true, sort: "stable" });
  });

  if (clear) clear.addEventListener("click", () => { USER_INTERACTED = true;
    if (search) search.value = "";
    if (vendor) vendor.value = "";
    ACTIVE_CATEGORY = "";
    const catSel2 = document.getElementById("categoryFilter");
    if (catSel2) catSel2.value = "";
    renderCategoryChips();
    applyFilters({ render: true, sort: "stable" });
  });

  if (clearCartBtn) clearCartBtn.addEventListener("click", clearCart);
  if (addLaborBtn)  addLaborBtn.addEventListener("click", () => addLaborLine(0, 1, "Labor line", 0));

// Ensure table visibility follows filter state
const $search = document.getElementById('searchInput');
if ($search && !$search.__bgFilterWired) {
  $search.addEventListener('input', () => { USER_INTERACTED = true; applyFilters({ render: true, sort: "stable" }); });
  $search.__bgFilterWired = true;
}
const $vendor = document.getElementById('vendorFilter');
if ($vendor && !$vendor.__bgFilterWired) {
  $vendor.addEventListener('change', () => applyFilters({ render: true, sort: "stable" }));
  $vendor.__bgFilterWired = true;
}
const $cat = document.getElementById('categoryFilter');
if ($cat && !$cat.__bgFilterWired) {
  $cat.addEventListener('change', () => { USER_INTERACTED = true; applyFilters({ render: true, sort: "stable" }); });
  $cat.__bgFilterWired = true;
}
if (typeof window.ACTIVE_CATEGORY !== 'undefined') {
  // In case categories are handled via buttons/chips, re-run filters on change
  document.addEventListener('active-category-changed', () => applyFilters({ render: true, sort: "stable" }));
}

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
function setDisabled(id, disabled){
  const el = document.getElementById(id);
  if (!el) return;
  el.disabled = !!disabled;               // <-- this is what re-enables the control
  el.classList.toggle("is-disabled", !!disabled); // optional styling hook
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
  // Header fetched once per session and memoized
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
const hadActive = hasAnyActiveFilter();

async function loadNextPage() {

  dbg("[loadNextPage] page:", _pageCursor, "loading:", _isLoadingPage, "noMore:", _noMorePages);

  if (_isLoadingPage || _noMorePages) return;
  _isLoadingPage = true;
  if (typeof showEl === 'function') showEl('loadingBarOverlay', true);

  try {
    // Prefer a prefetched page if available
    let header, dataRows;
    if (typeof _prefetched === 'object' && _prefetched && _prefetched[_pageCursor]) {
      ({ header, dataRows } = _prefetched[_pageCursor]);
      try { delete _prefetched[_pageCursor]; } catch(_) {}
    } else {
      const resp = await withRetry(
        () => fetchRowsWindow(SHEET_ID, DEFAULT_GID, _pageCursor, VIRTUAL_PAGE_SIZE),
        3,
        200
      );
      ({ header, dataRows } = resp || {});
    }

    const windowRows = transformWindowRows(header, dataRows);
    dbg("[fetchRowsWindow] pageIdx:", _pageCursor, "pageSize:", VIRTUAL_PAGE_SIZE, "got:", windowRows.length);

if (!Array.isArray(windowRows) || windowRows.length === 0) {
  _noMorePages = true;           // internal flag (you already had this)
  __ROWS_DONE  = true;           // ✅ now we *know* there are no more
  verifyRecordCount();           // tick progress one last time (will hide if counts match)
  return;
}


    // First page — initialize filters/UI and clear old rows
    if (_pageCursor === 0) {
      if (typeof buildCategories === 'function') buildCategories(windowRows);
      if (typeof populateVendorFilter === 'function') populateVendorFilter(windowRows);
      if (typeof populateCategoryFilter === 'function') populateCategoryFilter(windowRows);
      if (typeof renderCategoryChips === 'function') renderCategoryChips();

      const table = document.getElementById('data-table') || ensureTable();
      const tbody = table.querySelector('tbody');
      if (tbody) tbody.innerHTML = '';
    }

    // Append to master list
    if (!Array.isArray(ALL_ROWS)) ALL_ROWS = [];
    Array.prototype.push.apply(ALL_ROWS, windowRows);

    // Keep cart prices in sync with latest rows (if cart exists)
    if (typeof reconcileCartWithCatalog === 'function') {
      try { reconcileCartWithCatalog(ALL_ROWS); } catch (e) { console.warn("[cart reconcile] err", e); }
    }

    // Prefetch next page opportunistically
    if (typeof VIRTUAL_PREFETCH !== "undefined" && VIRTUAL_PREFETCH > 0) {
      setTimeout(() => {
        if (!_noMorePages && !_isLoadingPage) {
          fetchRowsWindow(SHEET_ID, DEFAULT_GID, _pageCursor + 1, VIRTUAL_PAGE_SIZE)
            .then(({ header, dataRows }) => {
              if (typeof _prefetched !== 'object' || !_prefetched) _prefetched = {};
              _prefetched[_pageCursor + 1] = { header, dataRows };
            })
            .catch(() => {});
        }
      }, 0);
    }

    // === Recompute + paint safely after adding windowRows ===
    const hadActive = hasAnyActiveFilter();
    const beforeLen = Array.isArray(FILTERED_ROWS) ? FILTERED_ROWS.length : 0;

    // Recompute ONLY (don’t let applyFilters paint)
    try { applyFilters({ render: false, sort: "stable" }); }
    catch (e) { console.error('[loadNextPage] applyFilters error', e); }

    if (hadActive) {
      // Full repaint so no stale rows can sneak in during search/filter
      const table = document.getElementById('data-table') || ensureTable();
      const tbody = table.querySelector('tbody');
      if (tbody) tbody.innerHTML = '';
      renderTableAppendChunked(FILTERED_ROWS, 0);
    } else {
      // No active filters: append only the new tail for smooth infinite scroll
      const afterLen = Array.isArray(FILTERED_ROWS) ? FILTERED_ROWS.length : 0;
      const delta = (afterLen > beforeLen && Array.isArray(FILTERED_ROWS))
        ? FILTERED_ROWS.slice(beforeLen)
        : [];
      renderTableAppend(delta);  // note: this is a no-op if you gate on hasAnyActiveFilter()
    }

    _pageCursor++;
    // ✅ keep progress up-to-date each page
if (_noMorePages) {
  __ROWS_DONE = true;
}
verifyRecordCount();


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
// ensure global handlers for Google script onload
if (typeof window !== 'undefined') {
  window.gapiLoaded = gapiLoaded;
  window.gisLoaded  = gisLoaded;
}


// ===== Singleflight + caches for sheet metadata & header =====================
const __singleflight = new Map(); // key -> Promise
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

const SHEET_META_CACHE = new Map();  // spreadsheetId -> meta
const HEADER_CACHE = new Map();      // `${spreadsheetId}|${range}` -> header array


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
function renderTableAll(rows) {
  const table = document.getElementById("data-table") || (typeof ensureTable === "function" ? ensureTable() : null);
  if (!table) return;
  let tbody = table.querySelector("tbody");
  if (!tbody) { tbody = document.createElement("tbody"); table.appendChild(tbody); }
  tbody.innerHTML = "";

  // Append ALL rows (no chunking)
  for (const row of rows) {
    const tr = document.createElement("tr");
    const cells = Array.isArray(row)
      ? row
      : (row && typeof row === "object") ? Object.values(row) : [row];
    for (const c of cells) {
      const td = document.createElement("td");
      td.textContent = (c == null) ? "" : String(c);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
}

function __renderFromCacheNow(reason = "pageshow"){
  if (!Array.isArray(window.ALL_ROWS) || window.ALL_ROWS.length === 0) return false;

  // unhide container if HTML started hidden
  const tc = document.getElementById("table-container");
  if (tc) tc.style.display = "";

  // reset any paging/virtualization cursors your renderer might rely on
  try { window._pageCursor = 0; } catch {}
  try { window._noMorePages = false; } catch {}
  try { window.__ROWS_DONE = false; } catch {}

  // rebuild filters (category/vendor lists) from ALL_ROWS if needed
  try { refreshCategoriesFromAllRows?.(); } catch {}

  // default: show everything; filters will narrow later when user types/selects
  window.FILTERED_ROWS = window.ALL_ROWS.slice();
  window.USER_INTERACTED = true;

  // Always render ALL rows on this path to avoid "appending 10"
  renderTableAll(window.FILTERED_ROWS);

  // Optional: update status and badge
  updateDataStatus?.("fresh", `Loaded from cache • ${reason}`);
  const badge = document.getElementById("fetch-count");
  if (badge) {
    const n = window.FILTERED_ROWS.length;
    badge.textContent = `${n} / ${n}`;
    badge.classList.add("ok"); badge.classList.remove("warn");
  }
  return true;
}

// ==== Show from cache when navigating back (BFCache or normal back) ====
window.addEventListener("pageshow", (ev) => {
  if (ev.persisted) { if (__renderFromCacheNow("BFCache")) return; }
  if (window.__SKIP_BOOTSTRAP) { if (__renderFromCacheNow("skip-bootstrap")) return; }
  // otherwise normal bootstrap will run elsewhere
});

// ==== Also try at DOM ready (cold reload with warm cache) ====
document.addEventListener("DOMContentLoaded", () => {
  if (__renderFromCacheNow("DOMContentLoaded")) return;
  if (!window.__SKIP_BOOTSTRAP) {
    if (window.gapi?.load) gapiLoaded();
    else console.debug("[boot] waiting for gapi script to load");
  }
});
