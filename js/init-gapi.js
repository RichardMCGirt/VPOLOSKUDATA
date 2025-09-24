/******************************************************
 * init-gapi.js — robust bootstrap for Google Sheets
 * - Never leaves the loading overlay stuck
 * - Falls back to direct fetch path if GAPI is slow/blocked
 * - Very chatty logs so you can pinpoint the stall
 ******************************************************/

// ===== UI helpers (calls your existing helpers safely) =====
function __setLabel(msg){ try{ setLoadingBar(undefined, msg); }catch{} }
function __bump(p, msg){ try{ bumpLoadingTo(p, msg); }catch{} }
function __show(show, msg){ try{ showLoadingBar(show, msg||""); }catch{} }
function __hide(){ try{ /* smooth finish */ __bump(100,"Ready"); setTimeout(()=>showLoadingBar(false), 300); }catch{} }
function __finalizeOK(){ try{
  // render & enable controls after data is in
  if (typeof applyFilters === "function") applyFilters({ render:true, sort:"stable" });
  if (typeof setControlsEnabledState === "function") setControlsEnabledState();
}catch{} }

// Tiny sleep
const __sleep = (ms)=>new Promise(r=>setTimeout(r, ms));

// Promise timeout wrapper
async function __withTimeout(promise, ms, tag="operation"){
  let t; const timeout = new Promise((_,rej)=>{ t=setTimeout(()=>rej(new Error(`[timeout] ${tag} > ${ms}ms`)), ms); });
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(t); }
}

// ===== Direct load (no GAPI) =====
async function __loadWithoutGapi(){
  console.log("[boot] Falling back to direct REST path (no GAPI)");
  __show(true, "Loading data…");
  __bump(25, "Fetching product data…");
  await listSheetData();            // your existing REST-based loader
  __bump(85, "Finalizing table…");
  __finalizeOK();
  __hide();
}

// ===== Normal path (with GAPI) =====
async function __loadWithGapi(){
  console.log("[boot] Starting GAPI flow");
  __show(true, "Initializing…");
  __bump(8, "Loading Google API client…");

  // 1) Ensure window.gapi exists (script tag could be blocked)
  if (typeof window.gapi === "undefined" || !gapi.load){
    console.warn("[boot] window.gapi missing — going fallback");
    return __loadWithoutGapi();
  }

  // 2) gapi.load('client') with a ceiling timeout (4s)
  await __withTimeout(new Promise((resolve, reject)=>{
    try {
      gapi.load("client", () => resolve());
    } catch(e){ reject(e); }
  }), 4000, "gapi.load(client)");

  __bump(12, "Initializing GAPI client…");

  // 3) gapi.client.init() with timeout (4s)
  try {
    await __withTimeout(gapi.client.init({
      apiKey: (typeof API_KEY !== "undefined") ? API_KEY : "",
      discoveryDocs: ["https://sheets.googleapis.com/$discovery/rest?version=v4"],
    }), 4000, "gapi.client.init");
  } catch (e){
    console.warn("[boot] gapi.client.init failed/slow — fallback path:", e);
    return __loadWithoutGapi();
  }

  // Mark inited for any code that checks it
  try { window.gapiInited = true; } catch {}

  // 4) proceed to data fetch (you use REST anyway)
  try { if (typeof showEl === "function") showEl("authorize_button", false); } catch {}
  __bump(15, "Connecting to Sheets API…");
  __bump(25, "Fetching product data…");

  await listSheetData();

  __bump(85, "Finalizing table…");
  __finalizeOK();
  __hide();
}

// ===== Public entrypoint (called by <script onload="gapiLoaded()">) =====
async function gapiLoaded(){
  try {
    console.log("[boot] gapiLoaded() fired");
    // Safety: if the overlay element id is wrong, you’d never see anything.
    // Ensure your HTML has: id="loadingBarOverlay" (no typos).
    __show(true, "Booting…");

    // Try the normal GAPI flow first; it’ll fall back if blocked/slow.
    await __loadWithGapi();
  } catch (e){
    console.error("[boot] Unhandled error in gapiLoaded:", e);
    try { __setLabel("Error loading data — see console"); } catch {}
    // Fallback to direct if anything explodes before we fetched:
    try { await __loadWithoutGapi(); } catch (e2){
      console.error("[boot] Fallback also failed:", e2);
      try { showToast("Failed to load data. See console."); } catch {}
      __hide();
    }
  }
}

// ===== Optional: defensive global in case the Google script fires BEFORE this file =====
try { window.gapiLoaded = gapiLoaded; } catch {}
