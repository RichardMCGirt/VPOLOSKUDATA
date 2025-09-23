/* cart.js
   Wires the Fill-In form to AirtableService:
   - Populates Branch & Field Manager from SOURCE TABLES (linked records; values = record IDs)
   - Populates Needed By & Reason by scanning current Fill-In view (plain/single-select)
   - Saves/patches a record on "Save to Airtable"
   - Prefills when ?rec=recXXXX is present
   - Renders cart from localStorage, supports inline qty edits, per-row remove, and Clear All
   - Broadcasts cart changes to other tabs (index.html) using BroadcastChannel "vanir_cart_bc"
   - Full Labor UI — add/edit/remove rows, persists to localStorage, updates totals
   - Branch dropdown filters out options that are NOT likely US cities (heuristic)
   - NEW (this update):
       • Single global Material Margin (%) input (default 30) near totals that applies to ALL materials
       • Removed per-row margin inputs
       • More robust labor removal (delegated listener)
   Requires: airtable.service.js
*/
(function () {
  "use strict";

  // ---------- Shared constants ----------
  const STORAGE_KEY = "vanir_cart_v1";
  const GLOBAL_MARGIN_KEY = "vanir_global_margin_pct";

  // ---------- BroadcastChannel (for live sync between pages) ----------
  const bc = ("BroadcastChannel" in window) ? new BroadcastChannel("vanir_cart_bc") : null;
function broadcastCart(state) {
  if (!bc) return;
  try {
    // Canonical name
    bc.postMessage({ type: "cart:update", state });
    // Backward-compat while both pages are in flux
    bc.postMessage({ type: "cartUpdate", state });
  } catch {}
}


  // ---------- Tiny utils ----------
  const $ = (sel) => document.querySelector(sel);
  const nonEmpty = (v) => v != null && String(v).trim().length > 0;

  function formatMoney(n) {
    const x = Number(n ?? 0);
    if (!Number.isFinite(x)) return "$0.00";
    return x.toLocaleString(undefined, {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
      style: "currency", currency: "USD"
    });
  }
  function toNumberLoose(val) {
    if (val == null) return 0;
    const s = String(val).replace(/[^0-9.+-]/g, ""); // strip $, %, spaces, etc.
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }

  // ---------- Global material margin ----------
  function getGlobalMarginPct() {
    const raw = localStorage.getItem(GLOBAL_MARGIN_KEY);
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 30;
  }
  function setGlobalMarginPct(pct) {
    const v = Math.max(0, Math.floor(Number(pct) || 0));
    try { localStorage.setItem(GLOBAL_MARGIN_KEY, String(v)); } catch {}
    const inp = $("#globalMarginPct");
    if (inp && String(inp.value) !== String(v)) inp.value = String(v);
  }

  function itemUnitSell(item) {
    const pct = getGlobalMarginPct(); // single global margin now
    return (Number(item.unitBase) || 0) * (1 + pct / 100);
  }

  // LocalStorage helpers
function getSaved() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return normalizeSaved(raw ? JSON.parse(raw) : null);
  } catch {
    return { cart: [], labor: [] };
  }
}

function setSaved(nextState) {
  try {
    const prev = getSaved();
    const merged = normalizeSaved({
      cart:  Array.isArray(nextState?.cart)  ? nextState.cart  : prev.cart,
      labor: Array.isArray(nextState?.labor) ? nextState.labor : prev.labor,
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
    broadcastCart(merged);
  } catch {}
}



  // ---------- Airtable wiring (unchanged logic; minor cleanups) ----------
  const els = {
    banner: $("#airtableBanner"),
    status: $("#airtableStatus"),
    btnSave: $("#saveAirtable"),
    customerName: $("#customerName"),
    branch: $("#branchSelect"),
    fieldMgr: $("#fieldManagerSelect"),
    neededBy: $("#neededBySelect"),
    reason: $("#reasonSelect"),
    jobName: $("#jobName"),
    planName: $("#planName"),
    elevation: $("#elevation"),
    materialsNeeded: $("#materialsNeeded"),
    pleaseDescribe: $("#pleaseDescribe"),
    toast: $("#toast"),
  };
  const logger = window.AIRTABLE_LOGGER || console;

  function setStatus(text, tone = "idle") {
    if (!els.status) return;
    els.status.textContent = text;
    els.status.setAttribute("data-tone", tone);
    const colors = { idle:"rgba(0,0,0,.04)", info:"#e6f0ff", ok:"#e7f9ee", warn:"#fff9e6", err:"#ffe9e6" };
    els.status.style.background = colors[tone] || colors.idle;
  }
  let toastTimer = null;
  function showToast(msg, ms = 2200) {
    if (!els.toast) return;
    els.toast.textContent = msg;
    els.toast.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (els.toast.style.display = "none"), ms);
  }

  function clearSelect(sel) { while (sel.firstChild) sel.removeChild(sel.firstChild); }
  function addPlaceholder(sel, text = "—") { const opt=document.createElement("option"); opt.value=""; opt.textContent=text; sel.appendChild(opt); }
  function populateSelectWithPairs(sel, pairs) {
    clearSelect(sel); addPlaceholder(sel);
    (pairs||[]).forEach(({value,label}) => { const opt=document.createElement("option"); opt.value=value; opt.textContent=label; sel.appendChild(opt); });
  }
  function populateSelectStrings(sel, values) {
    clearSelect(sel); addPlaceholder(sel);
    (values||[]).forEach((v)=>{ const opt=document.createElement("option"); const str=String(v).trim(); opt.value=str; opt.textContent=str; sel.appendChild(opt); });
  }

  const maps = {
    branch: { idToLabel: new Map(), labelToId: new Map() },
    fieldMgr: { idToLabel: new Map(), labelToId: new Map() },
  };

  async function saveToAirtable(service, recordId) {
    const fields = {
      "Customer Name": els.customerName?.value || undefined,
      "Job Name": els.jobName?.value || undefined,
      "Plan Name": els.planName?.value || undefined,
      "Elevation": els.elevation?.value || undefined,
      "Materials Needed": nonEmpty(els.materialsNeeded?.value) ? els.materialsNeeded.value : undefined,
      "Reason For Fill In": els.reason?.value || undefined,
      "Needed By": els.neededBy?.value || undefined,
    };
    if (els.branch?.value) fields["Branch"] = [els.branch.value];
    if (els.fieldMgr?.value) fields["Field Manager"] = [els.fieldMgr.value];
    Object.keys(fields).forEach((k) => { if (fields[k] === undefined || fields[k] === "") delete fields[k]; });

    if (els.btnSave) els.btnSave.disabled = true;
    setStatus("Saving…", "info");
    try {
      let resp;
      if (recordId) {
        logger.info?.("save", "Patching record", recordId, fields);
        resp = await window.AirtableService.prototype.patchRecord.call(new window.AirtableService(), recordId, fields);
      } else {
        logger.info?.("save", "Creating record", fields);
        resp = await window.AirtableService.prototype.createRecord.call(new window.AirtableService(), fields);
      }
      const newId = resp?.id || resp?.records?.[0]?.id || recordId;
      setStatus(`Saved ${newId ? `(#${newId})` : ""}`, "ok");
      showToast("Saved to Airtable");
      return newId || null;
    } catch (err) {
      logger.error?.("save", err);
      setStatus("Save failed", "err");
      showToast("Save failed — check console");
      throw err;
    } finally {
      if (els.btnSave) els.btnSave.disabled = false;
    }
  }

  // ---------- US City filter (heuristic) ----------
  const US_STATE_ABBR = new Set([
    "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA",
    "HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
    "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
    "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
    "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC"
  ]);
  const ALLOWLIST_CITIES = new Set([
    // e.g. "Raleigh","Charleston","Greensboro","Myrtle Beach","Wilmington","Columbia","Charlotte","Greenville"
  ]);
  const NON_CITY_KEYWORDS = /\b(office|division|warranty|calendar|group|inc|llc|corp|company|test|sample|vendor|subcontractor|internal|template)\b/i;

  function isLikelyUSCity(label) {
    if (!label) return false;
    const s = String(label).trim();
    if (!s) return false;
    if (ALLOWLIST_CITIES.size && ALLOWLIST_CITIES.has(s)) return true;
    if (/[0-9@/\\]|https?:/i.test(s)) return false;
    if (/[–—]/.test(s)) return false;
    if (NON_CITY_KEYWORDS.test(s)) return false;
    const m = s.match(/^(?<city>[A-Za-z .'-]+?)(?:,\s*(?<st>[A-Za-z]{2}))?$/);
    if (!m) return false;
    const city = (m.groups.city || "").trim();
    const st = m.groups.st ? m.groups.st.toUpperCase() : null;
    if (!city) return false;
    if (st && !US_STATE_ABBR.has(st)) return false;
    const words = city.split(/\s+/).filter(Boolean);
    if (words.length < 1 || words.length > 3) return false;
    if (!/^[A-Za-z][A-Za-z .'-]*$/.test(city)) return false;
    return true;
  }
  function filterToUSCities(options) {
    const filtered = [];
    const rejected = [];
    (options || []).forEach(o => (isLikelyUSCity(o.label) ? filtered : rejected).push(o));
    return { filtered, rejected };
  }

  async function initDropdowns(service) {
    setStatus("Loading dropdowns…", "info");
    ["branch","fieldMgr","neededBy","reason"].forEach(k => els[k]?.setAttribute("aria-busy","true"));
    try {
      const [{ options: fmOptions, idToLabel: fmIdToLabel, labelToId: fmLabelToId },
             { options: brOptions, idToLabel: brIdToLabel, labelToId: brLabelToId }] = await Promise.all([
        service.fetchFieldManagerOptions(),
        service.fetchBranchOptions(),
      ]);

      maps.fieldMgr.idToLabel = fmIdToLabel; maps.fieldMgr.labelToId = fmLabelToId;
      maps.branch.idToLabel   = brIdToLabel; maps.branch.labelToId   = brLabelToId;

      populateSelectWithPairs(els.fieldMgr, fmOptions.map(o => ({ value: o.id, label: o.label })));
      const { filtered: brFiltered } = filterToUSCities(brOptions);
      populateSelectWithPairs(els.branch, brFiltered.map(o => ({ value: o.id, label: o.label })));

      const { neededBy, reason } = await service.fetchDropdowns({
        branchField: "___ignore_branch___",
        fieldMgrField: "___ignore_fm___",
        neededByField: "Needed By",
        reasonField: "Reason For Fill In",
      });
      populateSelectStrings(els.neededBy, neededBy);
      populateSelectStrings(els.reason, reason);

      setStatus("", "");
    } catch (err) {
      logger.error?.("dropdowns", err);
      setStatus("Failed to load dropdowns", "err");
      showToast("Failed to load dropdowns — check console");
    } finally {
      ["branch","fieldMgr","neededBy","reason"].forEach(k => els[k]?.removeAttribute("aria-busy"));
    }
  }

  function ensureOption(selectEl, value, label) {
    if (!selectEl || !value) return;
    const exists = Array.from(selectEl.options).some(o => o.value === value);
    if (!exists) {
      const opt = document.createElement("option");
      opt.value = value;
      opt.textContent = label || value;
      opt.dataset.nonCity = "true";
      selectEl.appendChild(opt);
    }
    selectEl.value = value;
  }

  function setSelectFromLinked(selectEl, rawVal, map, { ensureIfMissing = false } = {}) {
    if (!selectEl) return;
    if (Array.isArray(rawVal) && rawVal.length) {
      const id = rawVal[0];
      selectEl.value = id;
      if (!selectEl.value) {
        const label = map.idToLabel.get(id);
        const fallbackId = label ? map.labelToId.get(label) : null;
        if (fallbackId) selectEl.value = fallbackId;
        if (ensureIfMissing && !selectEl.value) {
          const lab = label || `(ID ${id})`;
          ensureOption(selectEl, id, lab);
        }
      }
    } else if (typeof rawVal === "string" && rawVal.trim()) {
      const id = map.labelToId.get(rawVal.trim());
      if (id) {
        selectEl.value = id;
        if (!selectEl.value && ensureIfMissing) ensureOption(selectEl, id, rawVal.trim());
      } else if (ensureIfMissing) {
        ensureOption(selectEl, rawVal.trim(), rawVal.trim());
      }
    }
  }

  async function prefillIfRecord(service, recId) {
    if (!recId) return;
    setStatus(`Loading record ${recId}…`, "info");
    try {
      const rec = await service.readRecord(recId);
      const f = rec?.fields || {};

      if (nonEmpty(f["Customer Name"])) els.customerName.value = f["Customer Name"];
      setSelectFromLinked(els.branch,    f["Branch"],        maps.branch,   { ensureIfMissing: true });
      setSelectFromLinked(els.fieldMgr,  f["Field Manager"], maps.fieldMgr, { ensureIfMissing: true });

      if (nonEmpty(f["Needed By"])) els.neededBy.value = Array.isArray(f["Needed By"]) ? String(f["Needed By"][0]) : String(f["Needed By"]);
      if (nonEmpty(f["Reason For Fill In"])) els.reason.value = Array.isArray(f["Reason For Fill In"]) ? String(f["Reason For Fill In"][0]) : String(f["Reason For Fill In"]);

      if (nonEmpty(f["Job Name"])) els.jobName.value = f["Job Name"];
      if (nonEmpty(f["Plan Name"])) els.planName.value = f["Plan Name"];
      if (nonEmpty(f["Elevation"])) els.elevation.value = f["Elevation"];
      if (nonEmpty(f["Materials Needed"])) els.materialsNeeded.value = Array.isArray(f["Materials Needed"]) ? String(f["Materials Needed"][0]) : String(f["Materials Needed"]);
      if (nonEmpty(f["Please Describe"])) els.pleaseDescribe.value = Array.isArray(f["Please Describe"]) ? String(f["Please Describe"][0]) : String(f["Please Describe"]);

      setStatus(`Loaded #${recId}`, "ok");
    } catch (err) {
      logger.error?.("prefill", err);
      setStatus("Failed loading record", "err");
    }
  }

  function updateBannerVisibility() {
    try {
      const hasHardcoded =
        window.AIRTABLE_CONFIG &&
        typeof window.AIRTABLE_CONFIG.API_KEY === "string" &&
        window.AIRTABLE_CONFIG.API_KEY.toLowerCase().startsWith("pat");

      const hasLocal =
        typeof localStorage !== "undefined" &&
        typeof localStorage.getItem("AIRTABLE_API_KEY") === "string" &&
        (localStorage.getItem("AIRTABLE_API_KEY") || "").trim().length > 0;

      els.banner && (els.banner.style.display = (hasHardcoded || hasLocal) ? "none" : "block");
    } catch { els.banner && (els.banner.style.display = "none"); }
  }

  // ---------- LABOR RENDER / ADD / EDIT / REMOVE ----------
  function ensureLaborRowsContainer() {
    const host = $("#labor-list");
    if (!host) return null;
    let rows = host.querySelector("#labor-rows");
    if (!rows) {
      rows = document.createElement("div");
      rows.id = "labor-rows";
      rows.style.display = "grid";
      rows.style.gridTemplateColumns = "1fr";
      rows.style.gap = "8px";
      rows.style.marginTop = "10px";
      host.appendChild(rows);
    }
    return rows;
  }

 
function renderLaborList(state) {
  const rowsHost = (typeof ensureLaborRowsContainer === "function")
    ? ensureLaborRowsContainer()
    : document.getElementById("labor-rows");
  if (!rowsHost) return;

  const live = state ?? getSaved();

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
  const toNumber = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
  const clampInt = (v) => Math.max(0, Math.floor(Number(v) || 0));
  const money = (n) => (typeof formatMoney === "function") ? formatMoney(n) : `$${(Number(n)||0).toFixed(2)}`;
  const computeLine = (qty, rate, marginPct) => clampInt(qty) * toNumber(rate) * (1 + (toNumber(marginPct) / 100));

  // Delegate listeners (bind once)
  if (!rowsHost._bound) {
    const onFieldEdit = (ev) => {
      const card = ev.target.closest(".card[data-labor-id]");
      if (!card) return;
      const id = card.getAttribute("data-labor-id");
      const data = getSaved();
      const rec = (data.labor || []).find(x => x.id === id);
      if (!rec) return;

      rec.description = card.querySelector("input.labor-desc")?.value ?? (rec.description || rec.desc || "Labor");
      rec.qty    = clampInt(card.querySelector("input.labor-qty")?.value ?? rec.qty);
      rec.rate   = toNumber(card.querySelector("input.labor-rate")?.value ?? rec.rate);
      rec.margin = toNumber(card.querySelector("input.labor-margin")?.value ?? (rec.margin ?? rec.marginPct ?? 0));

      setSaved(data);

      const line = computeLine(rec.qty, rec.rate, rec.margin);
      const lineEl = card.querySelector('[data-cell="line"] .cell-text, [data-line-total]');
      if (lineEl) lineEl.textContent = money(line);

      updateTotalsOnly(getSaved());
    };

    rowsHost.addEventListener("input", onFieldEdit);
    rowsHost.addEventListener("change", onFieldEdit); // catches spinner clicks & mobile keyboards

    rowsHost.addEventListener("click", (ev) => {
      const btn = ev.target.closest(".remove-labor");
      if (!btn) return;
      const card = btn.closest(".card[data-labor-id]");
      const id = card ? card.getAttribute("data-labor-id") : null;

      const data = getSaved();
      let next = Array.isArray(data.labor) ? data.labor.slice() : [];

      // Prefer id match; fall back to DOM index if needed
      let idx = id ? next.findIndex(x => x.id === id) : -1;
      if (idx === -1 && card?.dataset?.idx) idx = Number(card.dataset.idx);
      if (idx >= 0) next.splice(idx, 1);

      data.labor = next;
      setSaved(data);

      renderLaborList(getSaved());
      updateTotalsOnly(getSaved());
      try { showToast && showToast("Labor line removed"); } catch {}
    });

    rowsHost._bound = true;
  }

  const labor = Array.isArray(live?.labor) ? live.labor : [];
  if (!labor.length) {
    rowsHost.innerHTML = `<div class="muted-sm" style="opacity:.8;">No labor lines yet. Click “+ Add Labor Line”.</div>`;
    return;
  }

  // Backfill ids & normalize keys, then persist once so storage matches DOM
  let dirty = false;
  for (const row of labor) {
    if (!row.id) { row.id = "L" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); dirty = true; }
    if (row.desc && !row.description) { row.description = row.desc; dirty = true; }
    if (row.marginPct != null && row.margin == null) { row.margin = row.marginPct; dirty = true; }
  }
  if (dirty) {
    const s = getSaved(); s.labor = labor;
    try { localStorage.setItem("vanir_cart_v1", JSON.stringify(normalizeSaved(s))); } catch {}
  }

  // Build cards (now with data-idx)
  const cards = labor.map((row, i) => {
    const id = row.id;
    const desc   = esc(row.description || "Labor");
    const qty    = clampInt(row.qty);
    const rate   = toNumber(row.rate);
    const margin = toNumber(row.margin);
    const line   = computeLine(qty, rate, margin);

    return `
      <div class="card" data-labor-id="${id}" data-idx="${i}">
        <div class="grid grid-labor">
          <div class="stack">
            <label class="field-label">Description</label>
            <input type="text" class="labor-desc" value="${desc}">
          </div>
          <div class="stack">
            <label class="field-label">Qty</label>
            <input type="number" class="labor-qty" min="0" step="1" value="${qty}">
          </div>
          <div class="stack">
            <label class="field-label">Rate</label>
            <input type="number" class="labor-rate" min="0" step="0.01" value="${rate}">
          </div>
          <div class="stack">
            <label class="field-label">Margin (%)</label>
            <input type="number" class="labor-margin" min="0" step="1" value="${margin}">
          </div>
          <div class="stack">
            <label class="field-label">Line Total</label>
            <div data-cell="line"><span class="cell-text nowrap-ellipsize">${
              money(line)
            }</span></div>
          </div>
          <div class="stack" style="align-self:end;">
            <button type="button" class="btn danger remove-labor">Remove</button>
          </div>
        </div>
      </div>
    `;
  });

  rowsHost.innerHTML = cards.join("");

  // NEW: after render, read the DOM once and persist exactly what’s displayed
  syncLaborFromDOM();
}




function addLaborLine(defaults = {}) {
  const data = getSaved();
  const id = "L" + Date.now().toString(36) + Math.random().toString(36).slice(2,7);

  // Use the normalized keys the rest of the code expects
  const item = {
    id,
    description: (defaults.description ?? defaults.desc ?? "Labor"),
    qty: Number.isFinite(defaults.qty) ? Math.max(0, Math.floor(defaults.qty)) : 1,
    rate: Number.isFinite(defaults.rate) ? Math.max(0, defaults.rate) : 0,
    margin: Number.isFinite(defaults.margin ?? defaults.marginPct)
              ? Math.max(0, (defaults.margin ?? defaults.marginPct))
              : 0,
  };

  data.labor = Array.isArray(data.labor) ? data.labor : [];
  data.labor.push(item);
  setSaved(data);
  renderLaborList(data);
  updateTotalsOnly(data);
  showToast?.("Labor line added");
}


  // ---------- CART RENDER / REMOVE / CLEAR ----------
 // Replace your renderSavedCart with this version
function renderSavedCart(stateMaybe) {

 const fresh = getSaved();
  const state = (stateMaybe && Array.isArray(stateMaybe.cart))
    ? { ...fresh, cart: stateMaybe.cart }
    : fresh;

  const tbody = document.querySelector("#cart-table tbody");
  if (!tbody) return;

  const items = Array.isArray(state.cart) ? state.cart : [];
  const rows = [];

  for (const saved of items) {
    const unit = itemUnitSell(saved);
    const qty = Math.max(0, Math.floor(Number(saved.qty) || 0));
    const line = unit * qty;

    rows.push(`
      <tr data-key="${(saved.key || "")}">
        <td data-label="Vendor">${(saved?.row?.vendor ?? "")}</td>
        <td data-label="SKU">${(saved?.row?.sku ?? "")}</td>
        <td data-label="Description">${(saved?.row?.description ?? "")}</td>
        <td data-label="Qty">
          <div class="stack">
            <label class="field-label">QTY</label>
            <input type="number" class="cart-qty" min="0" step="1"
                   value="${qty}" data-key="${(saved.key || "")}">
          </div>
        </td>
        <td data-label="Unit" data-cell="unit"><span class="cell-text nowrap-ellipsize">${formatMoney(unit)}</span></td>
        <td data-label="Line Total" data-cell="line"><span class="cell-text nowrap-ellipsize">${formatMoney(line)}</span></td>
        <td data-label="Actions"><button class="btn danger remove-item" data-key="${(saved.key || "")}">Remove</button></td>
      </tr>
    `);
  }

  tbody.innerHTML = rows.join("");

  // Render labor & totals from the *freshest* state
  renderLaborList(state);
  updateTotalsOnly(state);

  // Inline qty edits
  tbody.oninput = (ev) => {
    const qtyEl = ev.target.closest(".cart-qty");
    if (!qtyEl) return;
    const key = qtyEl.getAttribute("data-key");
    const data = getSaved();
    const item = data.cart.find(c => c.key === key);
    if (!item) return;

    item.qty = Math.max(0, Math.floor(Number(qtyEl.value) || 0));
    setSaved(data);
    renderSavedCart(); // no arg → will pull fresh
  };

  // Remove product buttons
  tbody.onclick = (ev) => {
    const btn = ev.target.closest(".remove-item");
    if (!btn) return;
    const key = btn.getAttribute("data-key");
    removeItemFromCart(key);
  };
 
}


function updateTotalsOnly(state) {
  const products = Array.isArray(state?.cart) ? state.cart : [];
  const labor    = Array.isArray(state?.labor) ? state.labor : [];

  const marginPct = getGlobalMarginPct();
  const productsTotal = products.reduce((sum, saved) => {
    const base = Number(saved.unitBase) || 0;
    const qty = Math.max(0, Math.floor(Number(saved.qty) || 0));
    const unitSell = base * (1 + marginPct / 100);
    return sum + unitSell * qty;
  }, 0);

  const laborTotal = labor.reduce((sum, l) => {
    const qty  = Math.max(0, Math.floor(toNumberLoose(l.qty)));
    const rate = Math.max(0, toNumberLoose(l.rate));
    const pct  = Math.max(0, toNumberLoose(l.margin ?? l.marginPct)); // ← accept both
    return sum + qty * rate * (1 + pct / 100);
  }, 0);

  $("#productTotal").textContent = formatMoney(productsTotal);
  $("#laborTotal").textContent   = formatMoney(laborTotal);
  $("#grandTotal").textContent   = formatMoney(productsTotal + laborTotal);
}


  // Dedicated remove function
  function removeItemFromCart(key) {
    if (!key) return;
    const data = getSaved();
    const beforeLen = data.cart.length;
    data.cart = data.cart.filter(c => c.key !== key);
    if (data.cart.length !== beforeLen) {
      setSaved(data);
      renderSavedCart(data);
      showToast?.("Removed from cart");
    }
  }

  function wireClearAll() {
    const btn = $("#clearCart");
    if (!btn || btn._bound) return;
    btn._bound = true;
    btn.addEventListener("click", () => {
      const data = getSaved();
      data.cart = [];
      data.labor = [];
      setSaved(data);
      renderSavedCart(data);
      showToast?.("Cart cleared");
    }, { passive: true });
  }

  function wireAddLabor() {
    const btn = $("#addLabor");
    if (!btn || btn._bound) return;
    btn._bound = true;
    btn.addEventListener("click", () => addLaborLine(), { passive: true });
  }

  function wireGlobalMargin() {
    const input = $("#globalMarginPct");
    if (!input || input._bound) return;
    input._bound = true;

    // Initialize from storage or default 30
    const curr = getGlobalMarginPct();
    input.value = String(curr);

    input.addEventListener("input", () => {
      const pct = Math.max(0, Math.floor(Number(input.value) || 0));
      setGlobalMarginPct(pct);
      // Re-render materials area to update Unit/Line columns
      const state = getSaved();
      renderSavedCart(state);
    });
  }
function normalizeSaved(state) {
  const s = (state && typeof state === "object") ? state : {};
  s.cart  = Array.isArray(s.cart)  ? s.cart  : [];
  s.labor = Array.isArray(s.labor) ? s.labor : [];
  // Backfill stable IDs so per-row remove can target exactly one
  for (const row of s.labor) {
    if (!row.id) row.id = "L" + Date.now().toString(36) + Math.random().toString(36).slice(2,7);
  }
  return s;
}

  // ---------- Init ----------
  document.addEventListener("DOMContentLoaded", async () => {
    // Show/hide API key banner
    updateBannerVisibility();

    // Default global margin if not set
    if (localStorage.getItem(GLOBAL_MARGIN_KEY) == null) {
      setGlobalMarginPct(30);
    }

    // Airtable init
    let service;
    try { service = new window.AirtableService(); }
    catch (e) { logger.error?.("init", e); setStatus("Airtable init failed", "err"); showToast("Airtable init failed — check console"); }

    if (service) {
      await initDropdowns(service);
      const params = new URLSearchParams(location.search);
      const recId = params.get("rec");
      await prefillIfRecord(service, recId);
      els.btnSave?.addEventListener("click", async () => {
        try {
          await saveToAirtable(service, recId);
        } catch { /* handled above */ }
      });
    }

    // Cart wiring
    wireClearAll();
    wireAddLabor();
    wireGlobalMargin();

    const state = getSaved();
    renderSavedCart(state);

    // Cross-tab updates (from index.html or another cart tab)
if (bc && !bc._bound) {
  bc._bound = true;
  bc.onmessage = (ev) => {
    const t = ev?.data?.type;
    if (t === "focus") { try { window.focus(); } catch {} return; }
    if (t !== "cart:update" && t !== "cartUpdate") return;

    const s = normalizeSaved(getSaved());   // heal missing keys
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch {}
    renderSavedCart(s);
  };
}

  });
})();
