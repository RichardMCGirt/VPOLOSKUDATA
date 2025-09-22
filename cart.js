/* cart.js
   Wires the Fill-In form to AirtableService:
   - Populates Branch & Field Manager from SOURCE TABLES (linked records; values = record IDs)
   - Populates Needed By & Reason by scanning current Fill-In view (plain/single-select)
   - Saves/patches a record on "Save to Airtable"
   - Prefills when ?rec=recXXXX is present
   Requires: airtable.service.js
*/
(function () {
  "use strict";

  // ------- DOM helpers -------
  const $ = (sel) => document.querySelector(sel);

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

  // ------- UI status / toast -------
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

  // ------- Select helpers -------
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
  const nonEmpty = (v) => v != null && String(v).trim().length > 0;

  // ------- Caches for label<->id mapping -------
  const maps = {
    branch: { idToLabel: new Map(), labelToId: new Map() },
    fieldMgr: { idToLabel: new Map(), labelToId: new Map() },
  };

  // ------- Save logic -------
  async function saveToAirtable(service, recordId) {
    const fields = {
      "Customer Name": els.customerName.value || undefined,
      "Job Name": els.jobName.value || undefined,
      "Plan Name": els.planName.value || undefined,
      "Elevation": els.elevation.value || undefined,
      "Materials Needed": nonEmpty(els.materialsNeeded.value) ? els.materialsNeeded.value : undefined,
      "Reason For Fill In": els.reason.value || undefined,
      "Needed By": els.neededBy.value || undefined,
    };

    // Linked record fields must be arrays of record IDs
    if (els.branch.value) fields["Branch"] = [els.branch.value];
    if (els.fieldMgr.value) fields["Field Manager"] = [els.fieldMgr.value];

    // Strip empties
    Object.keys(fields).forEach((k) => { if (fields[k] === undefined || fields[k] === "") delete fields[k]; });

    els.btnSave.disabled = true;
    setStatus("Saving…", "info");

    try {
      let resp;
      if (recordId) {
        logger.info?.("save", "Patching record", recordId, fields);
        resp = await service.patchRecord(recordId, fields);
      } else {
        logger.info?.("save", "Creating record", fields);
        resp = await service.createRecord(fields);
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
      els.btnSave.disabled = false;
    }
  }

  // ------- Dropdowns init -------
  async function initDropdowns(service) {
    setStatus("Loading dropdowns…", "info");
    ["branch","fieldMgr","neededBy","reason"].forEach(k => els[k]?.setAttribute("aria-busy","true"));

    try {
      // 1) Linked record options from SOURCE TABLES (values = rec IDs)
      const [{ options: fmOptions, idToLabel: fmIdToLabel, labelToId: fmLabelToId },
             { options: brOptions, idToLabel: brIdToLabel, labelToId: brLabelToId }] = await Promise.all([
        service.fetchFieldManagerOptions(),
        service.fetchBranchOptions(),
      ]);

      maps.fieldMgr.idToLabel = fmIdToLabel; maps.fieldMgr.labelToId = fmLabelToId;
      maps.branch.idToLabel   = brIdToLabel; maps.branch.labelToId   = brLabelToId;

      populateSelectWithPairs(els.fieldMgr, fmOptions.map(o => ({ value: o.id, label: o.label })));
      populateSelectWithPairs(els.branch,   brOptions.map(o => ({ value: o.id, label: o.label })));

      // 2) Plain text/single-select from current Fill-In table for "Needed By" & "Reason"
      const { neededBy, reason } = await service.fetchDropdowns({
        branchField: "___ignore_branch___",   // ignore scanning branch (linked)
        fieldMgrField: "___ignore_fm___",     // ignore scanning field mgr (linked)
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

  // ------- Record prefill (handles linked IDs & label fallbacks) -------
  function setSelectFromLinked(selectEl, rawVal, map) {
    if (!selectEl) return;
    if (Array.isArray(rawVal) && rawVal.length) {
      // Linked record array of IDs (preferred)
      const id = rawVal[0];
      selectEl.value = id;
      if (!selectEl.value) {
        // If ID wasn't in options (rare), try label->id fallback
        const label = map.idToLabel.get(id);
        const fallbackId = label ? map.labelToId.get(label) : null;
        if (fallbackId) selectEl.value = fallbackId;
      }
    } else if (typeof rawVal === "string" && rawVal.trim()) {
      // Sometimes lookups return label strings; map back to ID
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

  // ------- Banner logic (hard-coded PAT vs localStorage) -------
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

  // ------- Init -------
  document.addEventListener("DOMContentLoaded", async () => {
    updateBannerVisibility();

    let service;
    try { service = new window.AirtableService(); }
    catch (e) { logger.error?.("init", e); setStatus("Airtable init failed", "err"); showToast("Airtable init failed — check console"); return; }

    await initDropdowns(service);

    const params = new URLSearchParams(location.search);
    const recId = params.get("rec");
    await prefillIfRecord(service, recId);

    els.btnSave?.addEventListener("click", async () => {
      try {
        const newId = await saveToAirtable(service, recId);
        if (!recId && newId) {
          const next = new URL(location.href);
          next.searchParams.set("rec", newId);
          history.replaceState({}, "", next);
        }
      } catch { /* handled */ }
    });
  });
})();
