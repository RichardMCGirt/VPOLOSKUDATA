// ===== Core constants & helpers =====
const RL_MAX_PER_MIN = 60;       
const RL_INTERVAL_MS = 60_000;   
let __rl_timestamps = [];        
let __INFLIGHT = 0;         
let __ROWS_DONE = false;    
let __OVERLAY_SHOWN_AT = 0;
let __OVERLAY_HIDDEN = false;
let __LAST_ACTIVITY_TS = 0;
let __maxPct = 0;
let EXPECTED_ROW_COUNT = Number(localStorage.getItem("EXPECTED_ROW_COUNT")||0) || 0;

const OVERLAY_MIN_MS  = 1200;   
const QUIET_WINDOW_MS = 800;   

function __noteActivity(){ __LAST_ACTIVITY_TS = Date.now(); }
function $(id){ return document.getElementById(id); }
function clamp(n, lo, hi){ return Math.max(lo, Math.min(hi, n)); }
function getExpectedRowCount(){ return EXPECTED_ROW_COUNT || 0; }

// Lazy-load one window of rows, then recompute & paint safely.
async function loadNextPage() {
  try {
    if (_isLoadingPage || _noMorePages) return;
    _isLoadingPage = true;

    if (typeof showEl === "function") showEl("loadingBarOverlay", true);

    // --- Fetch the next page/window of rows ---
    const pageIdx = _pageCursor || 0;
    const pageSize = (typeof VIRTUAL_PAGE_SIZE === "number" && VIRTUAL_PAGE_SIZE > 0)
      ? VIRTUAL_PAGE_SIZE
      : 600;

    // You should already have this function implemented
    const { rows = [], noMore = false } = await fetchRowsWindow(pageIdx, pageSize);

    // Append to master buffer (no DOM work yet)
    if (Array.isArray(rows) && rows.length) {
      if (Array.isArray(ALL_ROWS)) {
        ALL_ROWS.push(...rows);
      } else {
        window.ALL_ROWS = [...rows];
      }
    }

    // Update end-of-data flag
    _noMorePages = !!noMore;

    // >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
    // PLACE THE CALL *RIGHT HERE*:
    // After ALL_ROWS has new data and _noMorePages is known.
    recomputePaintAfterAppend();
    // <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<

    // Advance cursor after successful paint/recompute
    _pageCursor = (typeof _pageCursor === "number" ? _pageCursor : 0) + 1;

    // Optional: progress UI
    if (typeof cacheStatusProgress === "function") {
      cacheStatusProgress({
        actual: Array.isArray(ALL_ROWS) ? ALL_ROWS.length : 0,
        expected: (typeof EXPECTED_ROW_COUNT === "number" ? EXPECTED_ROW_COUNT : 0),
        done: !!_noMorePages
      });
    }

    if (typeof verifyRecordCount === "function") {
      verifyRecordCount();
    }
  } catch (err) {
    console.error("[loadNextPage] error", err);
    if (typeof showToast === "function") showToast("Error loading data (see console).");
  } finally {
    if (typeof showEl === "function") showEl("loadingBarOverlay", false);
    _isLoadingPage = false;
  }
}



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
/*************************************************************
 * Minimal rate-limit helpers used by fetchJSON429()
 * - __rateLimitGate(): caps concurrent requests per time window
 * - withBackoff429(fn): retries on 429 / quota errors with jittered backoff
 *************************************************************/
(function () {
  // Keep timestamps of recent requests
  if (!Array.isArray(window.__rl_timestamps)) window.__rl_timestamps = [];

  const RL = {
    WINDOW_MS: 1000,        // sliding window length
    MAX_IN_WINDOW: 4,       // max requests allowed per window
    INITIAL_DELAY: 400,     // first backoff wait (ms)
    MAX_DELAY: 4000,        // max backoff wait (ms)
    JITTER: 0.25            // +/- 25% jitter
  };

  // Gate to prevent bursts that trigger 429s
  window.__rateLimitGate = async function __rateLimitGate() {
    const now = Date.now();
    // keep only events in the last WINDOW_MS
    window.__rl_timestamps = window.__rl_timestamps.filter(t => now - t < RL.WINDOW_MS);

    if (window.__rl_timestamps.length >= RL.MAX_IN_WINDOW) {
      const oldest = window.__rl_timestamps[0];
      const wait = RL.WINDOW_MS - (now - oldest);
      if (wait > 0) {
        await new Promise(r => setTimeout(r, wait));
      }
      // After waiting, re-trim to be safe
      const now2 = Date.now();
      window.__rl_timestamps = window.__rl_timestamps.filter(t => now2 - t < RL.WINDOW_MS);
    }
    window.__rl_timestamps.push(Date.now());
  };

  // Retry wrapper for quota/429 errors
  window.withBackoff429 = async function withBackoff429(fn) {
    let attempt = 0;
    let delay = RL.INITIAL_DELAY;

    for (;;) {
      try {
        return await fn();
      } catch (e) {
        // Detect 429/quota-ish conditions
        const status = e?.status ?? e?.code ?? e?.response?.status;
        const msg = String(e?.message || e);
        const isRate =
          status === 429 ||
          /429/.test(String(status)) ||
          /Too Many Requests/i.test(msg) ||
          /rate|quota|userRateLimitExceeded/i.test(msg);

        if (!isRate) throw e;

        attempt++;
        const jitter = Math.floor(Math.random() * delay * RL.JITTER);
        const wait = delay + jitter;
        await new Promise(r => setTimeout(r, wait));
        delay = Math.min(delay * 2, RL.MAX_DELAY);
      }
    }
  };
})();


// ---- Main: robust fetch with backoff, jitter, Retry-After, and quiescence hooks
async function fetchJSON429(url, init = {}){
  const MAX_ATTEMPTS   = 6;              // overall retries
  const BASE_DELAY_MS  = 300;            // base backoff
  const JITTER_MS      = 250;            // extra random wait
  let lastErr;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++){
    await __rateLimitGate();
    __INFLIGHT++;
    try {
      const res = await fetch(url, init);
      __noteActivity(); // we got a response at least

      // Handle retryable statuses
      if (res.status === 429 || res.status === 503) {
        // Honor server's Retry-After if present
        const retryAfter = res.headers.get("Retry-After");
        let waitMs;
        if (retryAfter) {
          // Retry-After can be seconds or HTTP-date; we handle simple seconds form
          const secs = Number(retryAfter);
          waitMs = isFinite(secs) ? secs * 1000 : BASE_DELAY_MS * (2 ** attempt);
        } else {
          waitMs = BASE_DELAY_MS * (2 ** attempt);
        }
        waitMs += Math.floor(Math.random() * JITTER_MS);
        // Optional: log
        // console.warn(`[fetchJSON429] ${res.status} retry in ${waitMs}ms (attempt ${attempt+1}/${MAX_ATTEMPTS})`, url);
        await sleep(waitMs);
        continue;
      }

      // Retry some transient 5xx errors too
      if (res.status >= 500 && res.status < 600) {
        const waitMs = BASE_DELAY_MS * (2 ** attempt) + Math.floor(Math.random() * JITTER_MS);
        await sleep(waitMs);
        continue;
      }

      // Non-OK and non-retryable: throw with body text for debugging
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const err  = new Error(`HTTP ${res.status} ${res.statusText} at ${url}\n${body}`);
        err.status = res.status;
        throw err;
      }

      // OK response
      const data = await parseBody(res);
      __noteActivity();
      return data;

    } catch (e) {
      lastErr = e;
      // Network errors or thrown above: backoff and retry
      const waitMs = BASE_DELAY_MS * (2 ** attempt) + Math.floor(Math.random() * JITTER_MS);
      // console.warn(`[fetchJSON429] error: ${e?.message || e}. retrying in ${waitMs}ms (${attempt+1}/${MAX_ATTEMPTS})`);
      await sleep(waitMs);
    } finally {
      __INFLIGHT--;
      // Let the quiescence gate check if we're done
      setTimeout(__maybeHideOverlay, 0);
    }
  }

  // Exhausted attempts
  throw lastErr || new Error(`fetchJSON429 exhausted retries for ${url}`);
}

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
