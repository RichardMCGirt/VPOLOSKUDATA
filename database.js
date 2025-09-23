// === Record Count Verification ==============================================
const EXPECTED_ROW_COUNT = Number(localStorage.getItem('EXPECTED_ROW_COUNT') || 12709);
// Example inside your chunking loop:


function setExpectedRowCount(n){
  try { localStorage.setItem('EXPECTED_ROW_COUNT', String(n)); }
  catch {}
}
function setControlsEnabledState(){
  // Only enable after the full dataset is ready
  const ready = !!FULLY_LOADED;
  setDisabled("searchInput", !ready);
  setDisabled("vendorFilter", !ready);
  setDisabled("categoryFilter", !ready);
  setDisabled("clearFilters", !ready);
}

function verifyRecordCount(){
  try {
    const expected = EXPECTED_ROW_COUNT || 0;
    const actual = Array.isArray(ALL_ROWS) ? ALL_ROWS.length : 0;
    const ok = expected ? (actual === expected) : true;
    // (keep your existing lines above)

// NEW: reflect real progress while pages stream in
try {
  if (expected > 0) {
    const pct = Math.max(0, Math.min(100, Math.floor((actual / expected) * 100)));
    if (!ok) bumpLoadingTo(Math.max(40, pct), `Loading ${actual} / ${expected}…`);
    else bumpLoadingTo(100, "All records loaded");
  }
} catch (_) {}
// (keep your existing console.log and status pill updates below)

   if (ok) { try { FULLY_LOADED = true; setControlsEnabledState(); } catch(_){} }
    console.log("[verifyRecordCount]", { expected, actual, ok });

    // Update status pill if available
    if (typeof updateDataStatus === "function"){
      const msg = expected ? `Loaded ${actual}${ok ? " ✓" : ` / ${expected}`}` : `Loaded ${actual}`;
      updateDataStatus(ok ? "fresh" : "warn", msg);
    }

    // Update badge
    const badge = document.getElementById("fetch-count");
    if (badge){
      badge.textContent = expected ? `${actual} / ${expected}` : String(actual);
      if (ok) { badge.classList.add("ok"); badge.classList.remove("warn"); }
      else { badge.classList.add("warn"); badge.classList.remove("ok"); }
    }
    return { expected, actual, ok };
  } catch (e){
    console.warn("[verifyRecordCount] failed", e);
    return { expected: EXPECTED_ROW_COUNT || 0, actual: 0, ok: false };
  }
}

// Expose for console checking
window.setExpectedRowCount = setExpectedRowCount;
window.verifyRecordCount = verifyRecordCount;

// ===== 429-aware fetch + rate limit gate (Sheets) ============================
const RL_MAX_PER_MIN = 30;             // Adjust if your quota allows
const RL_INTERVAL_MS = 60_000;
let __rl_timestamps = [];

/** Blocks until a slot is available under the per-minute cap. */
async function __rateLimitGate(){
  while (true){
    const now = Date.now();
    __rl_timestamps = __rl_timestamps.filter(t => now - t < RL_INTERVAL_MS);
    if (__rl_timestamps.length < RL_MAX_PER_MIN){
      __rl_timestamps.push(now);
      return;
    }
    const waitMs = (RL_INTERVAL_MS - (now - __rl_timestamps[0])) + Math.floor(Math.random()*250);
    await new Promise(r => setTimeout(r, waitMs));
  }
}
// ========== Search v2 helpers (tokenized + field-aware) ==========

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

/**
 * Advance the bar but never go backwards; good for milestone bumps.
 * Example: bumpLoadingTo(40, "Fetching data…");
 */
let __loadingBarMax = 0;
function bumpLoadingTo(percent, label = "") {
  __loadingBarMax = Math.max(__loadingBarMax, Math.min(100, Math.floor(percent)));
  setLoadingBar(__loadingBarMax, label);
}

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

/**
 * fetchJSON429(url, init): wraps fetch with RL gate + exponential backoff.
 * Retries on 429 and 5xx (up to 6 attempts). On other statuses, throws immediately.
 */
async function fetchJSON429(url, init={}

// Monkey-patch fetch for Google Sheets endpoints to use our 429-aware helper.
(function(){
  const __origFetch = window.fetch.bind(window);
  window.fetch = async function(input, init){
    try {
      const url = (typeof input === "string") ? input : (input && input.url) ? input.url : "";
      if (url && url.includes("content-sheets.googleapis.com/v4/spreadsheets/")){
        // Route through 429-aware path
        return await (async () => {
          const data = await fetchJSON429(url, init || {});
          // Synthesize a Response-like object so downstream .json() keeps working
          return new Response(new Blob([JSON.stringify(data)], {type: "application/json"}), { status: 200 });
        })();
      }
    } catch(e){
      console.warn("[fetch monkeypatch] error in wrapper", e);
      throw e;
    }
    return __origFetch(input, init);
  };
})()

){
  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++){
    await __rateLimitGate();
    try {
      const res = await fetch(url, init);
      if (res.status === 429 || (res.status >= 500 && res.status < 600)){
        const body = await res.text().catch(()=>"(no body)");
        console.warn(`[fetchJSON429] ${res.status} retry #${attempt+1}`, url, body);
        const delay = __backoffDelay(attempt);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      if (!res.ok){
        const txt = await res.text().catch(()=>"(no body)");
        const e = new Error(`HTTP ${res.status} ${res.statusText} for ${url}\n${txt}`);
        e.status = res.status;
        throw e;
      }
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("application/json")){
        return await res.json();
      }
      const txt = await res.text();
      try { return JSON.parse(txt); }
      catch { return { text: txt }; }
    } catch (e){
      lastErr = e;
      // network errors: small delay and retry
      const delay = __backoffDelay(attempt);
      console.warn("[fetchJSON429] network error, retrying in", delay, "ms", e);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr || new Error("fetchJSON429 exhausted retries");
}

// Generic retry helper for transient fetch errors
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

async function __rateLimitGate(){
  while (true){
    const now = Date.now();
    __rl_timestamps = __rl_timestamps.filter(t => now - t < RL_INTERVAL_MS);
    if (__rl_timestamps.length < RL_MAX_PER_MIN){
      __rl_timestamps.push(now);
      return;
    }
    const waitMs = (RL_INTERVAL_MS - (now - __rl_timestamps[0])) + Math.floor(Math.random()*250);
    await new Promise(r => setTimeout(r, waitMs));
  }
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
let gisInited = false;

let gapiInited = false;

let tokenClient = null;

let accessToken = null;

// --- Smooth rendering knobs ---

// --- UX gating (mobile-first) ---
const RENDER_ONLY_AFTER_INTERACTION = true; // Hide table until the user searches or picks a filter
const RENDER_ONLY_AFTER_FULL_FETCH = true;  // Also wait until ALL pages are fetched before showing results
let USER_INTERACTED = false;                // flips true on first search/filter input
let FULLY_LOADED = false;                   // flips true when record count matches EXPECTED_ROW_COUNT
let BACKGROUND_PAGE_DELAY_MS = 400;
const RENDER_CHUNK = 200; // #rows appended to DOM per idle slice
const ric = window.requestIdleCallback || (fn => setTimeout(() => fn({ timeRemaining: () => 8 }), 0));

let _ingestSeq = 0; // monotonically increasing id assigned to each row as it arrives


let _controlsWired = false;
// --- Virtualization / paging config (mobile-first) ---
const VIRTUAL_PAGE_SIZE = 600;   
const VIRTUAL_PREFETCH = 1;      // prefetch next page proactively
let _pageCursor = 0;             // 0-based page index
let _pageTitle = null;           // resolved sheet title
let _isLoadingPage = false;
let _noMorePages = false;
// ===== GOOGLE SHEETS + GIS SIGN-IN (popup token flow) =====

// --- Config ---
const CLIENT_ID = "518347118969-drq9o3vr7auf78l16qcteor9ng4nv7qd.apps.googleusercontent.com";
const API_KEY = "AIzaSyBGYsHkTEvE9eSYo9mFCUIecMcQtT8f0hg";
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

  let headerRowIdx = 0;

// Data state
let ALL_ROWS = [];
// key: sku|vendor -> {row, qty, unitBase, marginPct}
const CART = new Map();
// {id, name, rate, qty, marginPct}  // percentage (e.g., 30 => +30%)
let LABOR_LINES = [];

// Cached categories
let ALL_CATEGORIES = [];
let ACTIVE_CATEGORY = "";
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

// =============== Bootstrap GAPI (Sheets v4) ===============
function gapiLoaded() {
  gapi.load("client", async () => {
    await gapi.client.init({
      apiKey: API_KEY,
      discoveryDocs: ["https://sheets.googleapis.com/$discovery/rest?version=v4"],
    });
    gapiInited = true;

    try {
      setControlsEnabledState();

      showLoadingBar(true, "Initializing…");       // NEW
      bumpLoadingTo(10, "Connecting to Sheets API…");

      // If you need header/meta first, you could bump to ~25% here.

      bumpLoadingTo(25, "Fetching product data…");
      await listSheetData();                       // your existing call

      // When listSheetData returns, we likely transformed rows.
      bumpLoadingTo(85, "Finalizing table…");

    } catch (e) {
      console.error("Error loading sheet (no-login mode):", e);
      showToast("Error loading sheet (see console).");
    } finally {
      bumpLoadingTo(100, "Ready");
      setTimeout(() => showLoadingBar(false), 350);  // small delay for nice finish
    }

    showEl("authorize_button", false);
    showEl("signout_button", false);
    maybeEnableButtons();
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

function applyFilters(opts = {}){
  // UI gates: require interaction + (optionally) full fetch before showing table
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


// ======= Data cache & status (stale-while-revalidate) =======
const PRODUCT_CACHE_KEY = "vanir_products_cache_v2";

/** Compact fingerprint based on first N rows' key fields. */
function fingerprintRows(rows, limit = 400){
  try {
    const slice = (Array.isArray(rows) ? rows : []).slice(0, limit).map(r =>
      `${r?.vendor||""}|${r?.sku||""}|${r?.uom||""}|${r?.description||""}|${r?.price||""}`
    ).join("\n");
    let h = 5381;
    for (let i=0;i<slice.length;i++){ h = ((h << 5) + h) ^ slice.charCodeAt(i); }
    // include count so different lengths produce different prints quickly
    return (h >>> 0).toString(36) + ":" + Math.min(limit, (rows||[]).length);
  } catch(e){ return "0"; }
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
      localStorage.removeItem(PRODUCT_CACHE_KEY);
      updateDataStatus("loading", "Refreshing…");
      // Reset and reload first window
      ALL_ROWS = []; FILTERED_ROWS = []; _pageCursor = 0; _noMorePages = false;
      showSkeletonRows(8);
      await loadNextPage();
      removeSkeletonRows();
      updateDataStatus("fresh", "Up to date • " + new Date().toLocaleTimeString());
      if (typeof showToast === "function") showToast("Data refreshed.");
    } catch (e){
      console.error("[refreshData] failed", e);
      updateDataStatus("error", "Refresh failed");
    }
  }, { passive: true });
})();

// ======= Background preloading (no user interaction required) =======
const AUTO_PRELOAD_ALL = true;                 // set false to revert to infinite-scroll only
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

  // 0) Show cached immediately, then revalidate
  (function showCachedFirst(){
    const cache = loadProductCache && loadProductCache();
    if (cache && Array.isArray(cache.rows) && cache.rows.length){
      try {
        ALL_ROWS = cache.rows.slice();
        if (typeof buildCategories === "function") buildCategories(ALL_ROWS);
        if (typeof populateVendorFilter === "function") populateVendorFilter(ALL_ROWS);
        if (typeof populateCategoryFilter === "function") populateCategoryFilter(ALL_ROWS);
        if (typeof renderCategoryChips === "function") renderCategoryChips();
        try { if (typeof applyFilters === "function") applyFilters(); } catch {}
        const current = Array.isArray(FILTERED_ROWS) ? FILTERED_ROWS.slice() : [];
        const tbody = (document.getElementById("data-table") || ensureTable()).querySelector("tbody");
        if (tbody) tbody.innerHTML = "";
        if (typeof renderTableAppend === "function") renderTableAppend(current);
        updateDataStatus && updateDataStatus(
          "stale",
          `Cached • ${new Date(cache.savedAt || Date.now()).toLocaleTimeString()} — checking for updates…`
        );
      } catch (e){ console.warn("[cache render] failed", e); }
    } else {
      updateDataStatus && updateDataStatus("loading", "Loading…");
    }
  })();

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
      _noMorePages = true;
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
    finally { __singleflight.delete(key); }
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
