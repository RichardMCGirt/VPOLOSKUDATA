(function (global) {
  "use strict";

  // === HARD-CODE YOUR CONFIG HERE ===
  const AIRTABLE_CONFIG = Object.freeze({
    API_KEY: "patTGK9HVgF4n1zqK.cbc0a103ecf709818f4cd9a37e18ff5f68c7c17f893085497663b12f2c600054", // <- REPLACE with your real Airtable PAT
    BASE_ID: "appeNSp44fJ8QYeY5",
    TABLE_ID: "tblRp5bukUiw9tX9j",       // Fill-In table (where we create/patch)
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
        VIEW_ID:  "viwXQMXGlrIfJZnTT",
        LABEL_CANDIDATES: ["Vanir Office","Branch","Name","Division","Office"]
      }
    }
  });

  // ---------- Logging Utility (safe, toggleable, pretty) ----------
  const AIRTABLE_LOGGER = (() => {
    const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4, trace: 5 };
    const QS = new URLSearchParams((typeof location !== "undefined" && location.search) || "");
    const qsLevel = (QS.get("atlog") || "").toLowerCase();
    const stored = (typeof localStorage !== "undefined" && localStorage.getItem("AIRTABLE_LOG_LEVEL")) || "";
    let _level = LEVELS[qsLevel] != null ? qsLevel
              : LEVELS[stored] != null  ? stored
              : "info";

    function setLevel(lvl) { if (lvl in LEVELS) { _level = lvl; try { localStorage.setItem("AIRTABLE_LOG_LEVEL", _level); } catch {} } }
    function getLevel() { return _level; }
    function _enabled(min) { return LEVELS[_level] >= LEVELS[min]; }
    function _ts() { try { const d = new Date(); return d.toTimeString().split(" ")[0] + "." + String(d.getMilliseconds()).padStart(3,"0"); } catch { return ""; } }

    const baseStyle = "padding:2px 6px;border-radius:6px;font-weight:600;";
    const tagStyle = "background:#111;color:#fff;";
    const dbgStyle = "background:#6b7280;color:#fff;";
    const infStyle = "background:#2563eb;color:#fff;";
    const wrnStyle = "background:#b45309;color:#fff;";
    const errStyle = "background:#b91c1c;color:#fff;";

    function _log(kind, tag, ...args) {
      if (!_enabled(kind)) return;
      const map = { trace: dbgStyle, debug: dbgStyle, info: infStyle, warn: wrnStyle, error: errStyle };
      const style = baseStyle + (map[kind] || dbgStyle);
      const tstyle = baseStyle + tagStyle;
      const prefix = [`%cAT%c${tag ? " " + tag : ""}%c ${_ts()}`, tstyle, style, ""];
      const fn = console[kind] || console.log;
      try { fn.apply(console, prefix.concat(args)); } catch { console.log.apply(console, prefix.concat(args)); }
    }

    const api = {
      setLevel, getLevel, LEVELS,
      trace: (...a) => _log("trace","",...a),
      debug: (tag,...a) => _log("debug",tag,...a),
      info:  (tag,...a) => _log("info", tag,...a),
      warn:  (tag,...a) => _log("warn", tag,...a),
      error: (tag,...a) => _log("error",tag,...a),
      group(tag, label) { if (!_enabled("debug")) return; try { console.group(`%cAT %c${tag} ${label||""}`, baseStyle+tagStyle, baseStyle+dbgStyle); } catch {} },
      groupEnd() { if (!_enabled("debug")) return; try { console.groupEnd(); } catch {} },
      time(label) { if (!_enabled("debug")) return; try { console.time(`AT ${label}`); } catch {} },
      timeEnd(label) { if (!_enabled("debug")) return; try { console.timeEnd(`AT ${label}`); } catch {} },
      maskToken(tok) { if (!tok || typeof tok !== "string") return tok; const raw = tok.replace(/^Bearer\s+/i,""); if (raw.length<=8) return "••"+raw.length; return raw.slice(0,4)+"…"+raw.slice(-4); },
      redactHeaders(h) { try { const out = { ...(h||{}) }; if (out.Authorization) out.Authorization = `Bearer ${this.maskToken(out.Authorization)}`; return out; } catch { return h; } }
    };
    return api;
  })();

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

    // ---- internal fetch w/ logging ----
    async _fetch(url, options = {}, tag = "fetch") {
      AIRTABLE_LOGGER.group(tag, `${options.method||"GET"} ${url}`);
      const safeOptions = { ...options, headers: AIRTABLE_LOGGER.redactHeaders(options.headers||{}) };
      if (AIRTABLE_LOGGER.getLevel() === "debug" || AIRTABLE_LOGGER.getLevel() === "trace") {
        AIRTABLE_LOGGER.debug(tag, "request options", { ...safeOptions, body: options.body ? tryParseJson(options.body) : undefined });
      } else {
        AIRTABLE_LOGGER.info(tag, "request", { method: options.method||"GET", url });
      }
      const t0 = performance.now ? performance.now() : Date.now();
      try {
        if (options.signal) { const sig=options.signal; if (sig.aborted) AIRTABLE_LOGGER.warn(tag,"aborted signal"); sig.addEventListener("abort",()=>AIRTABLE_LOGGER.warn(tag,"Request aborted",{reason:sig.reason}),{once:true}); }
        const res = await fetch(url, options);
        const ms = (performance.now?performance.now():Date.now()) - t0;
        AIRTABLE_LOGGER.info(tag, "response", { ok:res.ok, status:res.status, durationMs:Math.round(ms) });
        return res;
      } catch (err) {
        const ms = (performance.now?performance.now():Date.now()) - t0;
        AIRTABLE_LOGGER.error(tag, "network error", { error:err, durationMs:Math.round(ms) });
        throw err;
      } finally { AIRTABLE_LOGGER.groupEnd(); }
      function tryParseJson(body){ try { return JSON.parse(body); } catch { return body; } }
    }

    // ---- main table ops ----
    async fetchAllRecords(signal) {
      AIRTABLE_LOGGER.group("fetchAllRecords","pagination begin");
      let url = this.listUrl(); const out = []; let page=0;
      while (url) {
        page++; AIRTABLE_LOGGER.time(`page ${page}`);
        const res = await this._fetch(url,{headers:this.headers(),signal},"list");
        if (!res.ok) throw new Error(`List failed: ${res.status} ${await safeText(res)}`);
        const j = await res.json(); const len = (j.records||[]).length;
        out.push(...(j.records||[])); url = j.offset ? this.listUrl(j.offset) : null; AIRTABLE_LOGGER.timeEnd(`page ${page}`);
        AIRTABLE_LOGGER.info("list",`page ${page} records`, len);
      }
      AIRTABLE_LOGGER.info("fetchAllRecords","total", out.length); AIRTABLE_LOGGER.groupEnd(); return out;
      async function safeText(resp){ try { return await resp.text(); } catch { return ""; } }
    }

    /** Legacy helper: scans current view for distinct values. Use only for plain text/single-select fields. */
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
        if (f[branchField] && typeof f[branchField] === "string") setB.add(String(f[branchField]));
        if (f[fieldMgrField] && typeof f[fieldMgrField] === "string") setFM.add(String(f[fieldMgrField]));
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
      // fallback: first non-empty string-ish field
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
        if (!labelToId.has(label)) labelToId.set(label, id); // first wins
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

  // Expose globals
  global.AirtableService = AirtableService;
  global.AIRTABLE_CONFIG = AIRTABLE_CONFIG;
  global.AIRTABLE_LOGGER = AIRTABLE_LOGGER;

})(window);
