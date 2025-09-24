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

const DEBUG_LOGS = true;  
function dbg(...args){ try { if (DEBUG_LOGS) console.log(...args); } catch(_){} }
function dgw(label, obj){ try { if (DEBUG_LOGS) console.groupCollapsed(label); console.log(obj); console.groupEnd(); } catch(_){} }
let gisInited = false;
let gapiInited = false;
let tokenClient = null;
let accessToken = null;
const RENDER_ONLY_AFTER_INTERACTION = true; 
const RENDER_ONLY_AFTER_FULL_FETCH = true;  
let USER_INTERACTED = false;               
let FULLY_LOADED = false;                 
let BACKGROUND_PAGE_DELAY_MS = 400;
const RENDER_CHUNK = 200; 
const ric = window.requestIdleCallback || (fn => setTimeout(() => fn({ timeRemaining: () => 8 }), 0));
let _ingestSeq = 0; 
let _controlsWired = false;
const VIRTUAL_PAGE_SIZE = 600;   
const VIRTUAL_PREFETCH = 1;      
let _pageCursor = 0;             
let _pageTitle = null;          
let _isLoadingPage = false;
let _noMorePages = false;
let __LOADING_HID_ONCE = false;   

// --- Config ---
const CLIENT_ID = "518347118969-drq9o3vr7auf78l16qcteor9ng4nv7qd.apps.googleusercontent.com";
const API_KEY = "AIzaSyBGYsHkTEvE9eSYo9mFCUIecMcQtT8f0hg";
const SHEET_ID  = "1E3sRhqKfzxwuN6VOmjI2vjWsk_1QALEKkX7mNXzlVH8";
const SCOPES    = "https://www.googleapis.com/auth/spreadsheets.readonly";

const DEFAULT_GID = 0;
const PRODUCT_TAB_FALLBACK = "DataLoad";
const PRODUCT_RANGE        = "A1:H10000";
const DEFAULT_PRODUCT_MARGIN_PCT = 30; // 30% default
const MARGIN = 0.30;
const MARKUP_MULT = 1 + MARGIN;

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

persistCart()
 document.addEventListener('DOMContentLoaded', () => {
    const row = document.getElementById('gentleModeRow');
    if (row) row.hidden = true; 
  });

FILTERED_ROWS = [];

function bindTableHandlers(){  }


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
