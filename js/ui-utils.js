/* ui-utils.fixed.js
   Common DOM + UX helpers (complete file; properly closed)
*/

(function () {
  "use strict";

  // -------- General DOM helpers --------
  function $(id) {
    if (!id) return null;
    return (typeof id === "string") ? document.getElementById(id) : id;
  }
  function qs(sel, root) {
    return (root || document).querySelector(sel);
  }
  function qsa(sel, root) {
    return Array.from((root || document).querySelectorAll(sel));
  }

  function showEl(idOrEl, show) {
    const el = $(idOrEl) || idOrEl;
    if (!el) return;
    el.style.display = show ? "" : "none";
  }

  function addClass(idOrEl, cls) {
    const el = $(idOrEl) || idOrEl;
    if (!el) return;
    el.classList.add(cls);
  }

  function removeClass(idOrEl, cls) {
    const el = $(idOrEl) || idOrEl;
    if (!el) return;
    el.classList.remove(cls);
  }

  function toggleClass(idOrEl, cls, force) {
    const el = $(idOrEl) || idOrEl;
    if (!el) return;
    if (typeof force === "boolean") el.classList.toggle(cls, force);
    else el.classList.toggle(cls);
  }

  function setText(idOrEl, text) {
    const el = $(idOrEl) || idOrEl;
    if (!el) return;
    el.textContent = (text == null) ? "" : String(text);
  }

  function setHTML(idOrEl, html) {
    const el = $(idOrEl) || idOrEl;
    if (!el) return;
    el.innerHTML = (html == null) ? "" : String(html);
  }

  // -------- Events --------
  function on(elOrSel, ev, fn, opts) {
    const el = (typeof elOrSel === "string") ? qs(elOrSel) : elOrSel;
    if (!el) return () => {};
    el.addEventListener(ev, fn, opts);
    return () => el.removeEventListener(ev, fn, opts);
  }

  function delegate(rootSel, ev, matchSel, fn, opts) {
    const root = (typeof rootSel === "string") ? qs(rootSel) : rootSel;
    if (!root) return () => {};
    const handler = (e) => {
      const m = e.target.closest(matchSel);
      if (m && root.contains(m)) fn(e, m);
    };
    root.addEventListener(ev, handler, opts);
    return () => root.removeEventListener(ev, handler, opts);
  }

  // -------- Throttle & Debounce --------
  function debounce(fn, wait = 250, opts = {}) {
    let t, lastArgs, lastThis;
    const leading = !!opts.leading;
    const trailing = (opts.trailing !== false);

    return function debounced(...args) {
      lastArgs = args;
      lastThis = this;

      const callNow = leading && !t;
      clearTimeout(t);
      t = setTimeout(() => {
        t = undefined;
        if (trailing && lastArgs) {
          const a = lastArgs, th = lastThis;
          lastArgs = lastThis = undefined;
          fn.apply(th, a);
        }
      }, wait);

      if (callNow) {
        fn.apply(this, args);
      }
    };
  }

  function throttle(fn, wait = 100) {
    let last = 0, t, lastArgs, lastThis;
    return function throttled(...args) {
      const now = Date.now();
      lastArgs = args;
      lastThis = this;
      if (now - last >= wait) {
        last = now;
        fn.apply(this, args);
      } else if (!t) {
        const rem = wait - (now - last);
        t = setTimeout(() => {
          last = Date.now();
          t = undefined;
          fn.apply(lastThis, lastArgs);
        }, rem);
      }
    };
  }

  // -------- Misc helpers --------
  function esc(s) {
    s = (s == null) ? "" : String(s);
    return s.replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[c]);
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function raf() {
    return new Promise(r => requestAnimationFrame(r));
  }

  function clamp(n, min, max) {
    n = Number(n);
    if (!Number.isFinite(n)) return min;
    return Math.max(min, Math.min(max, n));
  }

  function formatNumber(n) {
    const x = Number(n);
    return Number.isFinite(x) ? x.toLocaleString() : "";
    // customize locale if necessary
  }

  function formatCurrency(n, currency = "USD", locale = undefined) {
    const x = Number(n);
    if (!Number.isFinite(x)) return "";
    try {
      return new Intl.NumberFormat(locale, { style: "currency", currency }).format(x);
    } catch {
      return `$${x.toFixed(2)}`;
    }
  }

  // -------- Toast --------
  const TOAST_ID = "toast";
  function ensureToast() {
    let el = $(TOAST_ID);
    if (!el) {
      el = document.createElement("div");
      el.id = TOAST_ID;
      el.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:24px;min-width:240px;max-width:90vw;padding:10px 14px;border-radius:8px;background:#222;color:#fff;box-shadow:0 6px 24px rgba(0,0,0,.25);z-index:999999;display:none;text-align:center;font:14px/1.3 system-ui,Segoe UI,Roboto,Arial";
      document.body.appendChild(el);
    }
    return el;
  }

  function showToast(msg, opts = {}) {
    const el = ensureToast();
    el.textContent = (msg == null) ? "" : String(msg);
    showEl(el, true);
    const dur = Number.isFinite(opts.duration) ? opts.duration : 2500;
    clearTimeout(el.__tid);
    el.__tid = setTimeout(() => { showEl(el, false); }, dur);
  }

  // -------- Exports on window --------
  window.$ = window.$ || $;
  window.qs = window.qs || qs;
  window.qsa = window.qsa || qsa;

  window.showEl = window.showEl || showEl;
  window.addClass = window.addClass || addClass;
  window.removeClass = window.removeClass || removeClass;
  window.toggleClass = window.toggleClass || toggleClass;
  window.setText = window.setText || setText;
  window.setHTML = window.setHTML || setHTML;

  window.on = window.on || on;
  window.delegate = window.delegate || delegate;

  window.debounce = window.debounce || debounce;
  window.throttle = window.throttle || throttle;

  window.esc = window.esc || esc;
  window.sleep = window.sleep || sleep;
  window.raf = window.raf || raf;
  window.clamp = window.clamp || clamp;
  window.formatNumber = window.formatNumber || formatNumber;
  window.formatCurrency = window.formatCurrency || formatCurrency;

  window.showToast = window.showToast || showToast;
})();
