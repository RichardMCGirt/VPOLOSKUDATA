(function () {
  "use strict";

  // ====== CONFIG (edit if your IDs differ) ======
  const CFG = {
    tableId: 'table-container',
    searchId: 'search-input',
    filterRootId: 'filters',
    minQueryLen: 1,          // require at least 1 char to trigger search-only mode
    attachGlobal: true,      // exposes window.UIVisibility
    logPrefix: '[UIVisibility]'
  };

  // ====== STATE ======
  const state = {
    loading: false,
    lastResults: [],
    lastRenderCount: 0
  };

  // ====== UTILS ======
  const $ = (sel) => document.querySelector(sel);
  const byId = (id) => document.getElementById(id);

  function ensureEl(tag, id, className, parent) {
    let el = byId(id);
    if (!el) {
      el = document.createElement(tag);
      el.id = id;
      if (className) el.className = className;
      (parent || document.body).appendChild(el);
    }
    return el;
  }

  function injectCSS() {
    const styleId = 'ui-visibility-styles';
    if (byId(styleId)) return;
    const css = `
#${CFG.tableId}{display:none}
.uiv-hidden{display:none !important}
.uiv-hint, .uiv-noresults{
  margin:1rem auto; padding:1rem 1.25rem; max-width:980px;
  border:1px dashed #bbb; border-radius:12px; font:14px/1.4 system-ui,Segoe UI,Roboto,Arial;
  background:#fafafa; color:#222
}
.uiv-hint strong, .uiv-noresults strong{font-weight:600}
#uiv-loading{
  position:fixed; inset:0; display:none; align-items:center; justify-content:center;
  background:rgba(255,255,255,0.75); z-index:9999; font:15px/1.4 system-ui,Segoe UI,Roboto,Arial; color:#111
}
#uiv-loading .uiv-spinner{
  width:32px; height:32px; border-radius:50%;
  border:3px solid rgba(0,0,0,.15); border-left-color:#111; margin-right:.75rem;
  animation:uiv-spin 1s linear infinite
}
#uiv-loading .uiv-row{display:flex; align-items:center; padding:1rem 1.25rem; background:#fff; border-radius:14px; box-shadow:0 6px 20px rgba(0,0,0,.08)}
@keyframes uiv-spin{to{transform:rotate(360deg)}}
    `.trim();
    const style = document.createElement('style');
    style.id = styleId;
    style.type = 'text/css';
    style.appendChild(document.createTextNode(css));
    document.head.appendChild(style);
  }

  function show(el){ if (el) el.style.display = el.dataset.uiDisplay || ''; }
  function hide(el){ if (el) { el.dataset.uiDisplay = el.dataset.uiDisplay || getComputedStyle(el).display; el.style.display = 'none'; } }

  function log(...args){ try { console.log(CFG.logPrefix, ...args); } catch{} }

  // ====== ELEMENTS (created on init) ======
  let $table, $filtersRoot, $search, $hint, $nores, $loading;

  function mountElements(){
    $table = byId(CFG.tableId);
    $filtersRoot = byId(CFG.filterRootId);
    $search = byId(CFG.searchId);

    // Safe guards
    if (!$table){ console.warn(CFG.logPrefix, `Missing #${CFG.tableId}.`); }
    if (!$filtersRoot){ console.warn(CFG.logPrefix, `Missing #${CFG.filterRootId}.`); }
    if (!$search){ console.warn(CFG.logPrefix, `Missing #${CFG.searchId}.`); }

    $hint = ensureEl('div', 'uiv-hint', 'uiv-hint', $table?.parentElement || document.body);
    $hint.innerHTML = `<strong>Start</strong>: select a filter or type in the search box to view records.`;

    $nores = ensureEl('div', 'uiv-noresults', 'uiv-noresults', $table?.parentElement || document.body);
    $nores.innerHTML = `<strong>No matches</strong> for your current filters/search. Try adjusting your criteria.`;
    hide($nores);

    $loading = ensureEl('div', 'uiv-loading', '', document.body);
    $loading.innerHTML = `<div class="uiv-row"><div class="uiv-spinner"></div><div>Loading records…</div></div>`;
    hide($loading);

    // Hide table on mount
    if ($table) hide($table);
  }

  // ====== FILTER / SEARCH DETECTION ======
  function safeHasAnyActiveFilter(){
    // Prefer user's function if present
    try {
      if (typeof window.hasAnyActiveFilter === 'function') {
        return !!window.hasAnyActiveFilter();
      }
    } catch {}
    // Fallback: look for non-empty selects/checked checkboxes within #filters
    if (!$filtersRoot) return false;
    const selects = Array.from($filtersRoot.querySelectorAll('select')).filter(s => (s.value || '').trim() !== '');
    const checks = Array.from($filtersRoot.querySelectorAll('input[type="checkbox"]')).filter(c => c.checked);
    const radios  = Array.from($filtersRoot.querySelectorAll('input[type="radio"]')).filter(r => r.checked);
    return selects.length + checks.length + radios.length > 0;
  }

  function getQuery(){
    return (($search && typeof $search.value === 'string') ? $search.value : '').trim();
  }

  // ====== LOADING STATE ======
  function setLoading(v){
    state.loading = !!v;
    if (state.loading) {
      if ($loading) show($loading);
      if ($table) hide($table);
      if ($nores) hide($nores);
      if ($hint) hide($hint);
    } else {
      if ($loading) hide($loading);
    }
  }

  // ====== RESULTS PIPELINE ======
  function runSearchAndFilters(){
    // If user has their own apply function(s), use those first
    try {
      if (typeof window.applyFiltersAndSearch === 'function') {
        return window.applyFiltersAndSearch(getQuery());
      }
      if (typeof window.applyFilters === 'function') {
        // If applyFilters returns rows, use them; otherwise assume it rendered internally
        const res = window.applyFilters(getQuery());
        if (Array.isArray(res)) return res;
      }
    } catch (e) {
      console.warn(CFG.logPrefix, 'Error calling user filter function:', e);
    }

    // Fallback: generic search across window.ALL_ROWS (array of objects or arrays)
    const rows = Array.isArray(window.ALL_ROWS) ? window.ALL_ROWS : [];
    const q = getQuery().toLowerCase();
    const hasFilter = safeHasAnyActiveFilter();

    // Without user's specific filter logic, we can only provide search matching
    if (!hasFilter && q.length < CFG.minQueryLen) return [];

    const out = [];
    for (const row of rows) {
      // stringify each row robustly
      let text = '';
      if (row && typeof row === 'object') {
        if (Array.isArray(row)) {
          text = row.join(' | ');
        } else {
          try {
            text = Object.values(row).join(' | ');
          } catch {}
        }
      } else {
        text = String(row ?? '');
      }
      if (!q || text.toLowerCase().includes(q)) {
        out.push(row);
      }
    }
    return out;
  }

  function renderMatches(rows){
    state.lastResults = rows || [];
    state.lastRenderCount = state.lastResults.length;

    // If user has their own renderer, let them handle it
    try {
      if (typeof window.renderTable === 'function') {
        window.renderTable(state.lastResults);
        return;
      }
      if (typeof window.renderTableAppend === 'function') {
        // If their renderer only appends, you may want to clear first if they expose a clear API.
        if (typeof window.clearTable === 'function') window.clearTable();
        for (const chunk of chunkify(state.lastResults, 200)) {
          window.renderTableAppend(chunk);
        }
        return;
      }
    } catch (e) {
      console.warn(CFG.logPrefix, 'Error calling user renderer:', e);
    }

    // Minimal built-in fallback rendering if no renderer available:
    if (!$table) return;
    $table.innerHTML = '';
    const pre = document.createElement('pre');
    pre.style.whiteSpace = 'pre-wrap';
    pre.style.font = '12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    pre.textContent = JSON.stringify(state.lastResults.slice(0, 200), null, 2) + (state.lastResults.length > 200 ? `\n… (${state.lastResults.length - 200} more)` : '');
    $table.appendChild(pre);
  }

  function chunkify(arr, size){
    const out = [];
    for (let i=0; i<arr.length; i+=size) out.push(arr.slice(i, i+size));
    return out;
  }

  // ====== MAIN VIEW UPDATER ======
  function updateView(){
    if (state.loading) return; // loading controls visibility already

    const hasFilter = safeHasAnyActiveFilter();
    const query = getQuery();

    if (!hasFilter && query.length < CFG.minQueryLen) {
      // Nothing selected / typed -> show start hint, hide table + noresults
      if ($table) hide($table);
      if ($nores) hide($nores);
      if ($hint) show($hint);
      log('Waiting for user filter/search to show records…');
      return;
    }

    // We have filter(s) and/or search -> compute matches
    const rows = runSearchAndFilters();
    if (Array.isArray(rows) && rows.length > 0) {
      if ($hint) hide($hint);
      if ($nores) hide($nores);
      renderMatches(rows);
      if ($table) show($table);
      log('Rendered matches:', rows.length);
    } else {
      if ($table) hide($table);
      if ($hint) hide($hint);
      if ($nores) show($nores);
      log('No matches for current criteria.');
    }
  }

  // ====== EVENT BINDINGS ======
  function bindEvents(){
    // Search input (debounced)
    let t;
    if ($search) {
      $search.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(updateView, 120);
      });
    }
    // Filters (change bubbling)
    if ($filtersRoot) {
      $filtersRoot.addEventListener('change', () => {
        updateView();
      });
    }

    // Custom hooks if user wants to request a refresh:
    window.addEventListener('records:filters:changed', updateView);
    window.addEventListener('records:search:changed', updateView);
  }

  // ====== PUBLIC API ======
  const API = {
    startFetch(){
      setLoading(true);
    },
    endFetch(){
      setLoading(false);
      updateView();
    },
    refresh(){
      updateView();
    },
    // Helpful wrapper: await with loading overlay
    async withLoading(promiseOrFn){
      setLoading(true);
      try {
        const p = (typeof promiseOrFn === 'function') ? promiseOrFn() : promiseOrFn;
        return await p;
      } finally {
        setLoading(false);
        updateView();
      }
    }
  };

  // ====== INIT ======
  function init(){
    injectCSS();
    mountElements();
    bindEvents();

    // On first load: hide table, show hint until user interacts
    setLoading(false);
    updateView();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  if (CFG.attachGlobal) {
    window.UIVisibility = API;
  }

  // ====== USAGE EXAMPLES (uncomment & adapt) ======
  // Example: wrap your sheet loader so the table stays hidden while fetching
  // async function listSheetData(){
  //   return UIVisibility.withLoading(async () => {
  //     // your existing fetch logic...
  //     await reallyFetch();
  //     // optionally set window.ALL_ROWS then call UIVisibility.refresh();
  //   });
  // }
})();
