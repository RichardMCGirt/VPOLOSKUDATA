/* cache-status.js
   - Safe references to BroadcastChannel
   - Local debounce implementation (so we don't depend on ui-utils.js order)
   - Updates simple cache/fetch UI status without crashing if elements are missing
*/

(function () {
  "use strict";

  // ---- Safe globals / channels ----
  const chan = (typeof window !== "undefined" && (window.cartChannel || window.bc)) || null;

  // ---- Local debounce (no external deps needed) ----
  function debounce(fn, wait = 250, opts = {}) {
    let t, lastArgs, lastThis, lastCall = 0;
    const leading = !!opts.leading;
    const trailing = (opts.trailing !== false);
    return function debounced(...args) {
      const now = Date.now();
      const invoke = () => {
        t = undefined;
        if (trailing && lastArgs) {
          const a = lastArgs; const th = lastThis;
          lastArgs = lastThis = undefined;
          fn.apply(th, a);
        }
      };
      const shouldCallLeading = leading && !t;

      lastArgs = args;
      lastThis = this;
      clearTimeout(t);
      t = setTimeout(invoke, wait);

      if (shouldCallLeading) {
        fn.apply(this, args);
      }
    };
  }

  // ---- DOM helpers (no-op safe) ----
  function $(id) {
    if (!id) return null;
    return (typeof id === "string") ? document.getElementById(id) : id;
  }
  function setText(el, text) {
    el = $(el);
    if (!el) return;
    el.textContent = text;
  }
  function show(el, visible) {
    el = $(el);
    if (!el) return;
    el.style.display = visible ? "" : "none";
  }
  function addClass(el, cls) {
    el = $(el);
    if (!el) return;
    el.classList.add(cls);
  }
  function removeClass(el, cls) {
    el = $(el);
    if (!el) return;
    el.classList.remove(cls);
  }

  // ---- Elements (optional) ----
  const statusBadge = $("fetch-count");       // e.g., a badge "1234 / 12709"
  const statusPill  = $("data-status-pill");  // e.g., a pill indicating "fresh"/"warn"
  const overlay     = $("loadingBarOverlay"); // loading overlay (optional)

  // ---- Public API to update status (call from verifyRecordCount, etc.) ----
  function updateDataStatus(kind, msg) {
    // kind: "fresh" | "warn" | "error"
    if (statusPill) {
      removeClass(statusPill, "fresh");
      removeClass(statusPill, "warn");
      removeClass(statusPill, "error");
      addClass(statusPill, kind || "fresh");
      setText(statusPill, msg || "");
    }
  }
  window.updateDataStatus = window.updateDataStatus || updateDataStatus;

  // Debounced progress updater
  const updateProgressDebounced = debounce(function (actual, expected, done) {
    if (statusBadge) {
      if (Number.isFinite(expected) && expected > 0) {
        setText(statusBadge, `${actual} / ${expected}`);
        if (actual >= expected) {
          addClass(statusBadge, "ok");
          removeClass(statusBadge, "warn");
        } else {
          addClass(statusBadge, "warn");
          removeClass(statusBadge, "ok");
        }
      } else {
        setText(statusBadge, String(actual));
      }
    }
    if (overlay) {
      if (done) {
        show(overlay, false);
      } else {
        show(overlay, true);
      }
    }
  }, 120);

  // Listen for cart updates as a proxy for “work happening”, but guard if channel missing.
  if (chan) {
    try {
      chan.onmessage = function () {
        // Could update some minor UI if desired
      };
    } catch (e) {
      // ignore channel errors
    }
  }

  // Expose a tiny helper you can call whenever you finish a page:
  // cacheStatusProgress({ actual, expected, done })
  window.cacheStatusProgress = function (o) {
    const actual = (o && Number.isFinite(o.actual)) ? o.actual : 0;
    const expected = (o && Number.isFinite(o.expected)) ? o.expected : 0;
    const done = !!(o && o.done);
    updateProgressDebounced(actual, expected, done);
  };

})();
