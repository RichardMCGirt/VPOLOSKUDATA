/* cart.js
   Wires the Fill-In form to AirtableService:
   - Populates Branch & Field Manager from SOURCE TABLES (linked records; values = record IDs)
   - Populates Needed By & Reason by scanning current Fill-In view (plain/single-select)
   - Saves/patches a record on "Save to Airtable"
   - Prefills when ?rec=recXXXX is present
   - Renders cart from localStorage, supports inline qty/margin edits, per-row remove, and Clear All
   - Broadcasts cart changes to other tabs (index.html) using BroadcastChannel "vanir_cart_bc"
   Requires: airtable.service.js
*/
(function () {
  "use strict";

  // ---------- Shared constants ----------
  const STORAGE_KEY = "vanir_cart_v1";

  // ---------- BroadcastChannel (for live sync between pages) ----------
  const bc = ("BroadcastChannel" in window) ? new BroadcastChannel("vanir_cart_bc") : null;
  function broadcastCart(state) {
    if (!bc) return;
    // Use a single canonical message shape everywhere
    try { bc.postMessage({ type: "cartUpdate", state }); } catch {}
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
  function itemUnitSell(item) {
    const pct = Math.max(0, Number(item?.marginPct ?? 30) || 0);
    return (Number(item.unitBase) || 0) * (1 + pct / 100);
  }

  // LocalStorage helpers
  function getSaved() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { cart: [], labor: [] };
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return { cart: [], labor: [] };
      if (!Array.isArray(parsed.cart)) parsed.cart = [];
      if (!Array.isArray(parsed.labor)) parsed.labor = [];
      return parsed;
    } catch {
      return { cart: [], labor: [] };
    }
  }
  function setSaved(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      broadcastCart(state);
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
      populateSelectWithPairs(els.branch,   brOptions.map(o => ({ value: o.id, label: o.label })));

      const { neededBy, reason } = await service.fetchDropdowns({
        branchField: "___ignore_branch___",
        fieldMgrField: "___ignore_fm___",
        neededByField: "Needed By",
        reasonField: "Reason For Fill In",
      });
      populateSelectStrings(els.neededBy, neededBy);
      populateSelectStrings(els.reason, reason);

      setStatus(
        `Dropdowns loaded (FM: ${fmOptions.length}, Branch: ${brOptions.length}, Needed By: ${neededBy.length}, Reason: ${reason.length})`,
        "ok"
      );
    } catch (err) {
      logger.error?.("dropdowns", err);
      setStatus("Failed to load dropdowns", "err");
      showToast("Failed to load dropdowns — check console");
    } finally {
      ["branch","fieldMgr","neededBy","reason"].forEach(k => els[k]?.removeAttribute("aria-busy"));
    }
  }

  function setSelectFromLinked(selectEl, rawVal, map) {
    if (!selectEl) return;
    if (Array.isArray(rawVal) && rawVal.length) {
      const id = rawVal[0];
      selectEl.value = id;
      if (!selectEl.value) {
        const label = map.idToLabel.get(id);
        const fallbackId = label ? map.labelToId.get(label) : null;
        if (fallbackId) selectEl.value = fallbackId;
      }
    } else if (typeof rawVal === "string" && rawVal.trim()) {
      const id = map.labelToId.get(rawVal.trim());
      if (id) selectEl.value = id;
    }
  }

  async function prefillIfRecord(service, recId) {
    if (!recId) return;
    setStatus(`Loading record ${recId}…`, "info");
    try {
      const rec = await service.readRecord(recId);
      const f = rec?.fields || {};

      if (nonEmpty(f["Customer Name"])) els.customerName.value = f["Customer Name"];
      setSelectFromLinked(els.branch, f["Branch"], maps.branch);
      setSelectFromLinked(els.fieldMgr, f["Field Manager"], maps.fieldMgr);
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

  // ---------- CART RENDER / REMOVE / CLEAR ----------
  function renderSavedCart(state) {
    const tbody = document.querySelector("#cart-table tbody");
    if (!tbody) return;

    const items = Array.isArray(state?.cart) ? state.cart : [];
    const rows = [];

    let productsTotal = 0;

    for (const saved of items) {
      const unit = itemUnitSell(saved);
      const qty = Math.max(0, Math.floor(Number(saved.qty) || 0));
      const line = unit * qty;
      productsTotal += line;

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
              <div class="margin-override">
                <label class="field-label">Margin (%)</label>
                <input type="number" class="cart-margin-pct" min="0" step="1"
                       value="${Math.max(0, Number(saved.marginPct ?? 30) || 0)}"
                       data-key="${(saved.key || "")}">
              </div>
            </div>
          </td>
          <td data-label="Unit" data-cell="unit"><span class="cell-text nowrap-ellipsize">${formatMoney(unit)}</span></td>
          <td data-label="Line Total" data-cell="line"><span class="cell-text nowrap-ellipsize">${formatMoney(line)}</span></td>
          <td data-label="Actions"><button class="btn danger remove-item" data-key="${(saved.key || "")}">Remove</button></td>
        </tr>
      `);
    }

    tbody.innerHTML = rows.join("");

    // Totals
    const labor = Array.isArray(state?.labor) ? state.labor : [];
    const laborTotal = labor.reduce((sum, l) => {
      const qty  = Math.max(0, Math.floor(Number(l.qty) || 0));
      const rate = Math.max(0, Number(l.rate) || 0);
      const pct  = Math.max(0, Number(l.marginPct) || 0);
      return sum + qty * rate * (1 + pct / 100);
    }, 0);

    $("#productTotal").textContent = formatMoney(productsTotal);
    $("#laborTotal").textContent   = formatMoney(laborTotal);
    $("#grandTotal").textContent   = formatMoney(productsTotal + laborTotal);

    // Inline edits update storage + totals
    tbody.oninput = (ev) => {
      const qtyEl = ev.target.closest(".cart-qty");
      const pctEl = ev.target.closest(".cart-margin-pct");
      if (!qtyEl && !pctEl) return;

      const key = (qtyEl || pctEl).getAttribute("data-key");
      const data = getSaved();
      const item = data.cart.find(c => c.key === key);
      if (!item) return;

      if (qtyEl) item.qty = Math.max(0, Math.floor(Number(qtyEl.value) || 0));
      if (pctEl) {
        let pct = Number(pctEl.value);
        if (!Number.isFinite(pct)) pct = 30;
        item.marginPct = Math.max(0, pct);
      }
      setSaved(data);            // persist + broadcast
      renderSavedCart(data);     // re-render row + totals
    };

    // Remove buttons
    tbody.onclick = (ev) => {
      const btn = ev.target.closest(".remove-item");
      if (!btn) return;
      const key = btn.getAttribute("data-key");
      removeItemFromCart(key);
    };
  }

  // Dedicated remove function (requested)
  function removeItemFromCart(key) {
    if (!key) return;
    const data = getSaved();
    const beforeLen = data.cart.length;
    data.cart = data.cart.filter(c => c.key !== key);
    if (data.cart.length !== beforeLen) {
      setSaved(data);                    // persist + broadcast
      renderSavedCart(data);             // refresh UI
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
      setSaved(data);                    // persist + broadcast
      renderSavedCart(data);
      showToast?.("Cart cleared");
    }, { passive: true });
  }

  // ---------- Init ----------
  document.addEventListener("DOMContentLoaded", async () => {
    // Show/hide API key banner
    updateBannerVisibility();

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
          const newId = await saveToAirtable(service, recId);
        } catch { /* handled above */ }
      });
    }

    // Cart wiring
    wireClearAll();
    const state = getSaved();
    renderSavedCart(state);

    // Listen for external updates (e.g., from index.html)
    if (bc) {
      bc.onmessage = (ev) => {
        if (ev?.data?.type === "cartUpdate") {
          // Re-read from storage for safety and re-render
          renderSavedCart(getSaved());
        }
      };
    }
  });
})();
