  // =========================
  // CONFIG: tweak if needed
  // =========================
  const CUSTOMER_NAME_IS_PLAINTEXT = false; // true ONLY if "Customer Name" is plain text in Airtable

  // --- Utilities ---
  const REC_ID_RE = /^rec[a-zA-Z0-9]{14}$/;

  function fmtMoney(n){
    const num = Number(n || 0);
    try { return num.toLocaleString(undefined, { style: "currency", currency: "USD" }); }
    catch { return "$" + (Math.round(num*100)/100).toFixed(2); }
  }
  function nonEmpty(s){ return typeof s === "string" && s.trim() !== ""; }
  function unmoney(s){
    if (!nonEmpty(s)) return null;
    return Number(String(s).replace(/[^0-9.-]/g,"")) || null;
  }

  // Read saved cart (labor intentionally ignored for Materials Needed)
  function readSavedState(){
    try {
      const raw = localStorage.getItem("vanir_cart_v1");
      const obj = raw ? JSON.parse(raw) : {};
      if (!Array.isArray(obj.cart)) obj.cart = [];
      return obj;
    } catch {
      return { cart: [] };
    }
  }

  // Scrape visible cart table in case localStorage cart items don't have vendor/fields
  function scrapeCartFromDOM(){
    const rows = Array.from(document.querySelectorAll("#cart-table tbody tr"));
    const out = [];
    for (const tr of rows) {
      const tds = tr.querySelectorAll("td");
      if (!tds || tds.length < 6) continue;
      const vendor = tds[0]?.textContent?.trim() || "";
      const sku    = tds[1]?.textContent?.trim() || "";
      const desc   = tds[2]?.textContent?.trim() || "";
      // Qty cell could contain an <input>; prefer its value
      let qty = tds[3]?.querySelector("input,select")?.value ?? tds[3]?.textContent?.trim() ?? "";
      qty = String(qty).trim();
      const lineStr = tds[5]?.textContent?.trim() || "";
      const lineTotal = unmoney(lineStr);

      out.push({ vendor, sku, desc, qty, lineTotal });
    }
    return out;
  }

  // Robust vendor extractor: handles many possible key names
  function getVendor(it){
    return (
      it.vendor ??
      it.Vendor ??
      it.vendorName ??
      it.VendorName ??
      it.vendor_name ??
      it.brand ??
      it.Brand ??
      it.manufacturer ??
      it.Manufacturer ??
      it.mfg ??
      it.MFG ??
      ""
    );
  }

  // Prefer saved cart, but if it lacks vendors, merge in DOM info; if cart empty, use DOM
  function getEffectiveMaterials(){
    const { cart } = readSavedState();
    const domRows = scrapeCartFromDOM();

    if (!cart.length && domRows.length) return domRows;

    // Merge: for each saved item, fill vendor/SKU/desc/qty/line if missing using DOM row at same index
    const merged = cart.map((it, i) => {
      const dom = domRows[i] || {};
      const vendor = nonEmpty(getVendor(it)) ? getVendor(it) : (dom.vendor || "");
      const sku    = nonEmpty(it.sku) ? it.sku : nonEmpty(it.SKU) ? it.SKU : (dom.sku || (it.key?.split?.("|")?.[0]) || "");
      const desc   = nonEmpty(it.desc) ? it.desc : nonEmpty(it.description) ? it.description : nonEmpty(it.Description) ? it.Description : (dom.desc || "");
      const qty    = it.qty != null ? it.qty : (it.quantity != null ? it.quantity : (nonEmpty(dom.qty) ? dom.qty : it.Qty));
      const line   = it.lineTotal != null ? it.lineTotal : (it.ext != null ? it.ext : (it.priceExt != null ? it.priceExt : (dom.lineTotal ?? null)));
      return { vendor, sku, desc, qty, lineTotal: line };
    });

    return merged;
  }

  // Build "Materials Needed" (materials ONLY; includes per-line Vendor + VENDORS section)
  function buildMaterialsNeededText(){
    const items = getEffectiveMaterials();
    const lines = [];

    // Collect vendors for summary section
    const vendorSet = new Set();
    for (const it of items) {
      const v = String(getVendor(it) || it.vendor || "").trim();
      if (v) vendorSet.add(v);
    }

    lines.push("MATERIALS");
    lines.push("---------");
    if (items.length) {
      items.forEach((it, idx) => {
        const vendor = (getVendor(it) || it.vendor || "").trim();
        const sku    = (it.sku || it.SKU || "").trim();
        const desc   = (it.desc || it.description || it.Description || "").trim();
        const qty    = (it.qty != null ? it.qty : (it.quantity != null ? it.quantity : it.Qty));
        const qtyStr = (qty == null || qty === "") ? "1" : String(qty);

        const parts = [
          `${idx+1}.`,
          `Vendor: ${nonEmpty(vendor) ? vendor : "—"}`,
          nonEmpty(sku)  ? `SKU: ${sku}`   : ``,
          `Desc: ${nonEmpty(desc) ? desc : "—"}`,
          `Qty: ${qtyStr}`
        ].filter(Boolean);

        // If we have a numeric line total, append it
        const line = (it.lineTotal != null) ? it.lineTotal : null;
        if (line != null && !Number.isNaN(Number(line))) parts.push(``);

        lines.push(parts.join(" | "));
      });
      lines.push("");
    } else {
      lines.push("(none)");
      lines.push("");
    }

    const productTotal = document.getElementById("productTotal")?.textContent?.trim();
    if (productTotal) {
      lines.push("TOTAL Cost");
      lines.push("------");
      lines.push(`${productTotal}`);
    }

    return lines.join("\n");
  }

  (async function initDropdowns(){
    try {
      const svc = new AirtableService();

      const { options: customerOpts } = await svc.fetchCustomerOptions();
      const customerSel = document.getElementById("customerSelect");
      if (customerSel) {
        for (const opt of customerOpts) {
          const o = document.createElement("option");
          o.value = opt.id;          
          o.textContent = opt.label; 
          customerSel.appendChild(o);
        }
      }

      const { options: branchOpts } = await svc.fetchBranchOptions();
      const branchSel = document.getElementById("branchSelect");
      if (branchSel) {
        for (const opt of branchOpts) {
          const o = document.createElement("option");
          o.value = opt.id; o.textContent = opt.label;
          branchSel.appendChild(o);
        }
      }

      const { options: fmOpts } = await svc.fetchFieldManagerOptions();
      const fmSel = document.getElementById("fieldManagerSelect");
      if (fmSel) {
        for (const opt of fmOpts) {
          const o = document.createElement("option");
          o.value = opt.id; o.textContent = opt.label;
          fmSel.appendChild(o);
        }
      }
    } catch (e) {
      console.error("Error initializing dropdowns:", e);
      const banner = document.getElementById("airtableBanner");
      if (banner) banner.style.display = "block";
    }
  })();

  (function wireSave(){
    const btn = document.getElementById("saveAirtable");
    const status = document.getElementById("airtableStatus");
    if (!btn) return;

    function setStatus(s, tone){
      if (!status) return;
      status.textContent = s;
      status.style.background = tone === "bad" ? "#fee2e2" :
                                tone === "ok"  ? "#dcfce7" : "rgba(0,0,0,.06)";
      status.style.color = tone === "bad" ? "#991b1b" :
                           tone === "ok"  ? "#065f46" : "inherit";
    }

    async function handleSave(){
      btn.disabled = true;
      const svc = new AirtableService();
      const fields = {};

      const customerSel = document.getElementById("customerSelect");
      const branchSel   = document.getElementById("branchSelect");
      const fmSel       = document.getElementById("fieldManagerSelect");
      const neededBySel = document.getElementById("neededBySelect");

      // --- Customer Name ---
      if (customerSel) {
        const val   = customerSel.value?.trim();
        const label = customerSel.selectedOptions?.[0]?.textContent?.trim() || "";
        if (CUSTOMER_NAME_IS_PLAINTEXT) {
          if (nonEmpty(label) && label !== "—") fields["Customer Name"] = label;
        } else {
          if (REC_ID_RE.test(val)) {
            fields["Customer Name"] = [val]; // linked-record
          } else if (nonEmpty(val) || nonEmpty(label)) {
            console.warn('Omitting "Customer Name": no rec id selected.', { val, label });
          }
        }
      }

      // --- Branch (linked) ---
      if (branchSel?.value && REC_ID_RE.test(branchSel.value)) {
        fields["Branch"] = [branchSel.value];
      } else if (branchSel?.value) {
        console.warn('Omitting "Branch": value is not a record id:', branchSel.value);
      }

      // --- Field Manager (linked) ---
      if (fmSel?.value && REC_ID_RE.test(fmSel.value)) {
        fields["Field Manager"] = [fmSel.value];
      } else if (fmSel?.value) {
        console.warn('Omitting "Field Manager": value is not a record id:', fmSel.value);
      }

      // --- Needed By (assumed text/select/date) ---
      if (neededBySel?.value) fields["Needed By"] = neededBySel.value;

      // --- Free text fields (omit if empty) ---
      const jobName  = document.getElementById("jobName")?.value || "";
      const planName = document.getElementById("planName")?.value || "";
      const elev     = document.getElementById("elevation")?.value || "";
      const reason   = document.getElementById("reasonSelect")?.value || "";
      const describe = document.getElementById("pleaseDescribe")?.value || "";
      if (nonEmpty(jobName))  fields["Job Name"]           = jobName;
      if (nonEmpty(planName)) fields["Plan Name"]          = planName;
      if (nonEmpty(elev))     fields["Elevation"]          = elev;
      if (nonEmpty(reason))   fields["Reason For Fill In"] = reason;
      if (nonEmpty(describe)) fields["Please Describe"]    = describe;

      // --- Materials Needed (now includes a VENDORS section + per-line vendor) ---
      fields["Materials Needed"] = buildMaterialsNeededText();

      try {
        // Preflight debug
        const debugFields = JSON.parse(JSON.stringify(fields));
        console.table(Object.entries(debugFields).map(([k,v]) => ({
          field: k,
          type: Array.isArray(v) ? "array" : typeof v,
          value: Array.isArray(v) ? v.join(",") : (String(v).length > 80 ? String(v).slice(0,80)+"…" : v)
        })));
        console.debug("Airtable payload fields:", debugFields);

        setStatus("Saving…");
        const rec = await svc.createRecord(fields);
        setStatus("Saved ✓", "ok");
        console.log("Created record:", rec);
      } catch (e) {
        console.error("Save failed:", e);
        setStatus("Error saving", "bad");
        const banner = document.getElementById("airtableBanner");
        if (banner && /Missing Airtable API Key/i.test(String(e))) banner.style.display = "block";
      } finally {
        setTimeout(() => { btn.disabled = false; }, 300);
      }
    }

    // Use { once:true } to avoid duplicate listeners; we reattach after each click.
    function attachOnce(){
      const btnEl = document.getElementById("saveAirtable");
      btnEl.addEventListener("click", function onClick(){
        btnEl.removeEventListener("click", onClick);
        handleSave().finally(attachOnce);
      }, { once: true });
    }
    attachOnce();
  })();
