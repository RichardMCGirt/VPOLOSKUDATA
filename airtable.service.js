(function (global) {
  "use strict";

  // === HARD-CODE YOUR CONFIG HERE ===
  const AIRTABLE_CONFIG = Object.freeze({
    API_KEY: "patTGK9HVgF4n1zqK.cbc0a103ecf709818f4cd9a37e18ff5f68c7c17f893085497663b12f2c600054",
    BASE_ID: "appeNSp44fJ8QYeY5",
    TABLE_ID: "tblRp5bukUiw9tX9j",
    VIEW_ID: "viwh9UWnGFNAoQwcT",

    // Source tables for linked/synced dropdowns
    SOURCES: {
      FIELD_MANAGER: {
        TABLE_ID: "tbla2bIyzulMrfsxC",
        VIEW_ID:  "viwDKoeJ0MEWVMJTe",
        LABEL_CANDIDATES: ["Full Name","Name","Field Manager","Field Manager Name","Title"]
      },
      BRANCH: {
        TABLE_ID: "tblwEBpPQ7J6ogSIE",
        VIEW_ID:  "viwhuabkWxRYif3Ci",
        LABEL_CANDIDATES: ["Vanir Office","Branch","Name","Division","Office"]
      },
      CUSTOMER: {
        TABLE_ID: "tblkXhrCv8229ctCh",
        VIEW_ID:  "Grid view",
        LABEL_CANDIDATES: ["Client Name","Client","Name"]
      },
      // Optional curated lists if your target fields are NOT select fields:
      NEEDED_BY: {
        TABLE_ID: "tblNeedBy123456789",      // <== create if you need a curated list
        VIEW_ID:  "Grid view",
        LABEL_CANDIDATES: ["Name","Needed By","Label","Title"]
      },
      REASON: {
        TABLE_ID: "tblReasonABCDEF123",      // <== create if you need a curated list
        VIEW_ID:  "Grid view",
        LABEL_CANDIDATES: ["Name","Reason","Label","Title"]
      }
    }
  });

  // ---------- Logging Utility ----------
// ---------- Logging Utility ----------
const AIRTABLE_LOGGER = (() => {
  const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 };

  const QS = new URLSearchParams((typeof location !== "undefined" && location.search) || "");
  const qsLevel = (QS.get("atlog") || "").toLowerCase();
  const stored = (typeof localStorage !== "undefined" && localStorage.getItem("AIRTABLE_LOG_LEVEL")) || "";
  let _level = (qsLevel in LEVELS) ? qsLevel : (stored in LEVELS) ? stored : "info";

  function setLevel(lvl) {
    if (lvl in LEVELS) {
      _level = lvl;
      try { localStorage.setItem("AIRTABLE_LOG_LEVEL", _level); } catch {}
    }
  }
  function getLevel() { return _level; }
  function _enabled(min) { return LEVELS[_level] >= LEVELS[min]; }
  function _ts() {
    try {
      const d = new Date();
      return d.toTimeString().split(" ")[0] + "." + String(d.getMilliseconds()).padStart(3,"0");
    } catch { return ""; }
  }

  const baseStyle = "padding:2px 6px;border-radius:6px;font-weight:600;";
  const tagStyle  = "background:#111;color:#fff;";
  const dbgStyle  = "background:#6b7280;color:#fff;";
  const infStyle  = "background:#2563eb;color:#fff;";
  const wrnStyle  = "background:#b45309;color:#fff;";
  const errStyle  = "background:#b91c1c;color:#fff;";

  function _log(kind, tag, ...args) {
    if (!_enabled(kind)) return;
    const map = { trace: dbgStyle, debug: dbgStyle, info: infStyle, warn: wrnStyle, error: errStyle };
    const style  = baseStyle + (map[kind] || dbgStyle);
    const tstyle = baseStyle + tagStyle;
    const prefix = [`%cAT%c${tag ? " " + tag : ""}%c ${_ts()}`, tstyle, style, ""];
    const fn = console[kind] || console.log;
    try { fn.apply(console, prefix.concat(args)); } catch {}
  }

  // Gate groups and timers too (previously unconditional)
  function _canGroup()   { return _enabled("info"); }  // groups at >= info
  function _canTime()    { return _enabled("debug"); } // timers at >= debug
  function _canTimeEnd() { return _enabled("debug"); }

  const api = {
    setLevel, getLevel, LEVELS,

    trace: (...a)          => _log("trace","",...a),
    debug: (tag,...a)      => _log("debug",tag,...a),
    info:  (tag,...a)      => _log("info", tag,...a),
    warn:  (tag,...a)      => _log("warn", tag,...a),
    error: (tag,...a)      => _log("error",tag,...a),

    group(tag, label) {
      if (!_canGroup()) return;
      try { console.group(`%cAT %c${tag} ${label||""}`, baseStyle+tagStyle, baseStyle+dbgStyle); } catch {}
    },
    groupEnd() {
      if (!_canGroup()) return;
      try { console.groupEnd(); } catch {}
    },

    time(label)   { if (!_canTime())    return; try { console.time(label); }   catch {} },
    timeEnd(label){ if (!_canTimeEnd()) return; try { console.timeEnd(label);} catch {} },

    maskToken(tok) {
      if (!tok || typeof tok !== "string") return tok;
      const raw = tok.replace(/^Bearer\s+/i,"");
      if (raw.length <= 8) return "••"+raw.length;
      return raw.slice(0,4)+"…"+raw.slice(-4);
    },
    redactHeaders(h) {
      try {
        const out = { ...(h||{}) };
        if (out.Authorization) out.Authorization = `Bearer ${this.maskToken(out.Authorization)}`;
        return out;
      } catch { return h; }
    }
  };

  return api;
})();

// === add near top of the file (config section) ===
const FEATURES = Object.freeze({
  USE_METADATA_SCHEMA: false, // set to true only if your PAT has schema access
  USE_CURATED_SOURCES: false, // set to true only if those tables actually exist
});

  // ---------- Core Service ----------
  class AirtableService {
    constructor(cfg = AIRTABLE_CONFIG) {
      this.apiKey = cfg.API_KEY;
      this.baseId = cfg.BASE_ID;
      this.tableId = cfg.TABLE_ID;
      this.viewId  = cfg.VIEW_ID;
      this.sources = cfg.SOURCES || {};

      AIRTABLE_LOGGER.info("init","AirtableService ready",{
        baseId:this.baseId, tableId:this.tableId, viewId:this.viewId,
        apiKey:`Bearer ${AIRTABLE_LOGGER.maskToken(this.apiKey||"")}`
      });
    }

    headers() {
      if (!this.apiKey) { AIRTABLE_LOGGER.error("headers","Missing Airtable API key."); throw new Error("Missing Airtable API key."); }
      const h = { "Authorization": `Bearer ${this.apiKey}`, "Content-Type": "application/json" };
      AIRTABLE_LOGGER.debug("headers", AIRTABLE_LOGGER.redactHeaders(h));
      return h;
    }

    // ---- URLs for main table ----
    listUrl(offset) {
      const base = `https://api.airtable.com/v0/${this.baseId}/${this.tableId}?view=${encodeURIComponent(this.viewId)}`;
      const url = offset ? `${base}&offset=${encodeURIComponent(offset)}` : base;
      AIRTABLE_LOGGER.debug("listUrl", url); return url;
    }
    tableUrl(id) {
      const base = `https://api.airtable.com/v0/${this.baseId}/${this.tableId}`;
      const url = id ? `${base}/${id}` : base;
      AIRTABLE_LOGGER.debug("tableUrl", url); return url;
    }

    // ---- URLs for arbitrary source tables ----
    otherListUrl(tableId, viewId, offset) {
      const base = `https://api.airtable.com/v0/${this.baseId}/${tableId}?view=${encodeURIComponent(viewId)}`;
      return offset ? `${base}&offset=${encodeURIComponent(offset)}` : base;
    }
    otherTableUrl(tableId, id) {
      const base = `https://api.airtable.com/v0/${this.baseId}/${tableId}`;
      return id ? `${base}/${id}` : base;
    }

    // === Metadata (Option A)
    async fetchTablesSchema(signal){
      if (this._schemaCache) return this._schemaCache;
      const url = `https://api.airtable.com/v0/meta/bases/${this.baseId}/tables`;
      const res = await this._fetch(url, { headers: this.headers(), signal }, "meta-tables");
      if (!res.ok) throw new Error(`Metadata tables failed: ${res.status} ${await res.text()}`);
      const j = await res.json();
      this._schemaCache = j?.tables || [];
      return this._schemaCache;
    }

    /**
     * Return allowed options for a specific field (Single select / Multi select).
     * Output: { type, options: ["Option A","Option B",...], raw }
     */
    async fetchSelectOptionsFromSchema({ tableId, fieldName, signal }){
      const tables = await this.fetchTablesSchema(signal);
      const table = tables.find(t => t.id === tableId || t.name === tableId);
      if (!table) throw new Error(`Table not found in schema: ${tableId}`);

      const field = (table.fields || []).find(f => f.name === fieldName || f.id === fieldName);
      if (!field) throw new Error(`Field not found in schema: ${fieldName} (table ${tableId})`);

      const choices = field?.options?.choices || [];
      const labels = choices
        .map(c => (c?.name ?? "").trim())
        .filter(Boolean)
        .sort((a,b)=>a.localeCompare(b, undefined, {numeric:true, sensitivity:"base"}));

      AIRTABLE_LOGGER.info("meta", `${fieldName} type=${field.type} choices=${labels.length}`);
      return { type: field.type, options: labels, raw: field };
    }

    // ---- internal fetch w/ logging ----
    async _fetch(url, options = {}, tag = "fetch") {
      AIRTABLE_LOGGER.group(tag, `${options.method||"GET"} ${url}`);
      const safeOptions = { ...options, headers: AIRTABLE_LOGGER.redactHeaders(options.headers||{}) };
      const t0 = performance.now ? performance.now() : Date.now();
      try {
        const res = await fetch(url, options);
        const ms = (performance.now?performance.now():Date.now()) - t0;
        AIRTABLE_LOGGER.info(tag, "response", { ok:res.ok, status:res.status, durationMs:Math.round(ms) });
        return res;
      } catch (err) {
        const ms = (performance.now?performance.now():Date.now()) - t0;
        AIRTABLE_LOGGER.error(tag, "network error", { error:err, durationMs:Math.round(ms) });
        throw err;
      } finally { AIRTABLE_LOGGER.groupEnd(); }
    }

    // ---- main table ops ----
    async fetchAllRecords(signal) {
      AIRTABLE_LOGGER.group("fetchAllRecords","pagination begin");
      let url = this.listUrl(); const out = []; let page=0;
      while (url) {
        page++; AIRTABLE_LOGGER.time(`page ${page}`);
        const res = await this._fetch(url,{headers:this.headers(),signal},"list");
        if (!res.ok) throw new Error(`List failed: ${res.status} ${await res.text()}`);
        const j = await res.json(); const len = (j.records||[]).length;
        out.push(...(j.records||[])); url = j.offset ? this.listUrl(j.offset) : null; AIRTABLE_LOGGER.timeEnd(`page ${page}`);
        AIRTABLE_LOGGER.info("list",`page ${page} records`, len);
      }
      AIRTABLE_LOGGER.info("fetchAllRecords","total", out.length); AIRTABLE_LOGGER.groupEnd(); return out;
    }

    /** Legacy helper to scan current view for distinct values. */
    async fetchDropdowns({
      branchField = "Branch",
      fieldMgrField = "Field Manager",
      neededByField = "Needed By",
      reasonField = "Reason For Fill In",
    } = {}) {
      const recs = await this.fetchAllRecords();
      const setB = new Set(), setFM = new Set(), setN = new Set(), setR = new Set();
      for (const r of recs) {
        const f = r.fields || {};
        if (typeof f[branchField] === "string") setB.add(f[branchField]);
        if (typeof f[fieldMgrField] === "string") setFM.add(f[fieldMgrField]);
        if (f[neededByField]) setN.add(String(f[neededByField]));
        if (f[reasonField]) setR.add(String(f[reasonField]));
      }
      return {
        branch: Array.from(setB).sort(),
        fieldManager: Array.from(setFM).sort(),
        neededBy: Array.from(setN).sort(),
        reason: Array.from(setR).sort(),
      };
    }

    // ---- source table ops (for linked fields) ----
    async fetchAllFromSource(tableId, viewId, signal) {
      let url = this.otherListUrl(tableId, viewId);
      const out = [];
      while (url) {
        const res = await this._fetch(url, { headers: this.headers(), signal }, "list-src");
        if (!res.ok) throw new Error(`List (src) failed: ${res.status} ${await res.text()}`);
        const j = await res.json();
        out.push(...(j.records || []));
        url = j.offset ? this.otherListUrl(tableId, viewId, j.offset) : null;
      }
      return out;
    }

    static _pickLabel(fields, candidates) {
      for (const key of candidates) {
        const val = fields?.[key];
        if (val != null) {
          if (Array.isArray(val) && val.length) return String(val[0]);
          if (typeof val === "string" && val.trim()) return val.trim();
          if (typeof val === "number") return String(val);
        }
      }
      for (const [k,v] of Object.entries(fields||{})) {
        if (v == null) continue;
        if (Array.isArray(v) && v.length && typeof v[0] !== "object") return String(v[0]);
        if (typeof v === "string" && v.trim()) return v.trim();
        if (typeof v === "number") return String(v);
      }
      return "";
    }

    /** Returns { options:[{id,label}], idToLabel:Map, labelToId:Map } */
    async fetchOptionsFromSource({ tableId, viewId, labelCandidates = [] } = {}) {
      const recs = await this.fetchAllFromSource(tableId, viewId);
      const options = [];
      const idToLabel = new Map();
      const labelToId = new Map();
      for (const r of recs) {
        const id = r.id;
        const label = AirtableService._pickLabel(r.fields || {}, labelCandidates);
        if (!id || !label) continue;
        options.push({ id, label });
        idToLabel.set(id, label);
        if (!labelToId.has(label)) labelToId.set(label, id);
      }
      options.sort((a,b)=>a.label.localeCompare(b.label, undefined, {numeric:true, sensitivity:"base"}));
      return { options, idToLabel, labelToId };
    }

    async fetchFieldManagerOptions() {
      const src = this.sources.FIELD_MANAGER || {};
      return this.fetchOptionsFromSource({ tableId: src.TABLE_ID, viewId: src.VIEW_ID, labelCandidates: src.LABEL_CANDIDATES || [] });
    }
    async fetchBranchOptions() {
      const src = this.sources.BRANCH || {};
      return this.fetchOptionsFromSource({ tableId: src.TABLE_ID, viewId: src.VIEW_ID, labelCandidates: src.LABEL_CANDIDATES || [] });
    }
    async fetchCustomerOptions() {
      const src = this.sources.CUSTOMER || {};
      return this.fetchOptionsFromSource({ tableId: src.TABLE_ID, viewId: src.VIEW_ID, labelCandidates: src.LABEL_CANDIDATES || [] });
    }

    // ---- CRUD main table ----
    async createRecord(fields) {
      const res = await this._fetch(this.tableUrl(), {
        method: "POST", headers: this.headers(), body: JSON.stringify({ records: [{ fields }] }),
      }, "create");
      if (!res.ok) throw new Error((await safeText(res)) || `Create failed: ${res.status}`);
      const j = await res.json(); return j?.records?.[0] || null;
      async function safeText(resp){ try { return await resp.text(); } catch { return ""; } }
    }
    async patchRecord(id, fields) {
      const res = await this._fetch(this.tableUrl(id), {
        method: "PATCH", headers: this.headers(), body: JSON.stringify({ fields }),
      }, "patch");
      if (!res.ok) throw new Error((await safeText(res)) || `Patch failed: ${res.status}`);
      return await res.json();
      async function safeText(resp){ try { return await resp.text(); } catch { return ""; } }
    }
    async readRecord(id) {
      const res = await this._fetch(this.tableUrl(id), { headers: this.headers() }, "read");
      if (!res.ok) throw new Error((await safeText(res)) || `Read failed: ${res.status}`);
      return await res.json();
      async function safeText(resp){ try { return await resp.text(); } catch { return ""; } }
    }

    static config() {
      return {
        API_KEY: `Bearer ${AIRTABLE_LOGGER.maskToken(AIRTABLE_CONFIG.API_KEY)}`,
        BASE_ID: AIRTABLE_CONFIG.BASE_ID,
        TABLE_ID: AIRTABLE_CONFIG.TABLE_ID,
        VIEW_ID: AIRTABLE_CONFIG.VIEW_ID,
        SOURCES: AIRTABLE_CONFIG.SOURCES,
      };
    }
    static setLogLevel(level) { AIRTABLE_LOGGER.setLevel(level); }
    static getLogLevel() { return AIRTABLE_LOGGER.getLevel(); }
  }

  // ====== Helpers (GLOBAL so both bootstrap + fallback can use them) ======
  function populateSelect(sel, labels){
    if (!sel) return;
    sel.innerHTML = "";
    for (const lbl of labels){
      const opt = document.createElement("option");
      opt.value = lbl;
      opt.textContent = lbl;
      sel.appendChild(opt);
    }
  }
  global.populateSelect = populateSelect; // expose for any external callers

  // ====== Bootstrap after DOM is ready ======
  document.addEventListener("DOMContentLoaded", async () => {
  AIRTABLE_LOGGER.setLevel("silent"); // you already have this

  const at = new AirtableService();
  const MAIN_TABLE_ID = "tblRp5bukUiw9tX9j";

  async function trySchemaFill(fieldName, sel) {
    if (!FEATURES.USE_METADATA_SCHEMA) return false;   // <— gate it
    try {
      const { type, options } = await at.fetchSelectOptionsFromSchema({ tableId: MAIN_TABLE_ID, fieldName });
      AIRTABLE_LOGGER.info("schema", `${fieldName}: type=${type} options=${options.length}`);
      if (options.length) { populateSelect(sel, options); return true; }
    } catch (e) { AIRTABLE_LOGGER.warn("schema", `Failed for ${fieldName}`, e); }
    return false;
  }

  async function tryCuratedSource(sourceKey, sel) {
    if (!FEATURES.USE_CURATED_SOURCES) return false;   // <— gate it
    try {
      const srcMap = {
        NEEDED_BY: () => at.fetchOptionsFromSource({
          tableId: AIRTABLE_CONFIG.SOURCES.NEEDED_BY.TABLE_ID,
          viewId:  AIRTABLE_CONFIG.SOURCES.NEEDED_BY.VIEW_ID,
          labelCandidates: AIRTABLE_CONFIG.SOURCES.NEEDED_BY.LABEL_CANDIDATES
        }),
        REASON: () => at.fetchOptionsFromSource({
          tableId: AIRTABLE_CONFIG.SOURCES.REASON.TABLE_ID,
          viewId:  AIRTABLE_CONFIG.SOURCES.REASON.VIEW_ID,
          labelCandidates: AIRTABLE_CONFIG.SOURCES.REASON.LABEL_CANDIDATES
        })
      };
      if (!AIRTABLE_CONFIG.SOURCES[sourceKey]) return false;
      const { options } = await srcMap[sourceKey]();
      const labels = options.map(o => o.label);
      if (labels.length) { populateSelect(sel, labels); AIRTABLE_LOGGER.info("fallback", `Filled from source ${sourceKey} (${labels.length})`); return true; }
    } catch (e) { AIRTABLE_LOGGER.warn("fallback", `Source ${sourceKey} failed`, e); }
    return false;
  }

    async function tryLegacyScrape(fieldName, sel) {
      try {
        const dd = await at.fetchDropdowns({ neededByField: "Needed By", reasonField: "Reason For Fill In" });
        const map = {
          "Needed By": dd.neededBy || [],
          "Reason For Fill In": dd.reason || []
        };
        const arr = map[fieldName] || [];
        if (arr.length) {
          populateSelect(sel, arr);
          AIRTABLE_LOGGER.info("legacy", `Filled ${fieldName} from current view values (${arr.length})`);
          return true;
        }
      } catch (e) {
        AIRTABLE_LOGGER.warn("legacy", `Scrape failed for ${fieldName}`, e);
      }
      return false;
    }

    // Wire explicit IDs if present
    const neededBySel = document.getElementById("neededBySelect");
    const reasonSel   = document.getElementById("reasonSelect");

    if (neededBySel) {
      let ok = await trySchemaFill("Needed By", neededBySel);
      if (!ok) ok = await tryCuratedSource("NEEDED_BY", neededBySel);
      if (!ok) ok = await tryLegacyScrape("Needed By", neededBySel);
      if (!ok) AIRTABLE_LOGGER.warn("ui", "Needed By: no options found (check field TYPE or name spelling).");
    }

    if (reasonSel) {
      let ok = await trySchemaFill("Reason For Fill In", reasonSel);
      if (!ok) ok = await tryCuratedSource("REASON", reasonSel);
      if (!ok) ok = await tryLegacyScrape("Reason For Fill In", reasonSel);
      if (!ok) AIRTABLE_LOGGER.warn("ui", "Reason For Fill In: no options found (check field TYPE or name spelling).");
    }

    // Auto-wire any <select data-airtable-field="...">
    const autoSelects = Array.from(document.querySelectorAll('select[data-airtable-field]'));
    for (const sel of autoSelects) {
      const fieldName = sel.getAttribute('data-airtable-field');
      let ok = await trySchemaFill(fieldName, sel);
      if (!ok) {
        // try to guess curated fallback
        if (/needed\s*by/i.test(fieldName)) ok = await tryCuratedSource("NEEDED_BY", sel);
        if (!ok && /reason/i.test(fieldName)) ok = await tryCuratedSource("REASON", sel);
      }
      if (!ok) ok = await tryLegacyScrape(fieldName, sel);
      if (!ok) AIRTABLE_LOGGER.warn("ui", `${fieldName}: no options found.`);
    }
  });

  // Expose to window
  global.AirtableService = AirtableService;
  global.AIRTABLE_CONFIG = AIRTABLE_CONFIG;
  global.AIRTABLE_LOGGER = AIRTABLE_LOGGER;

})(window);
