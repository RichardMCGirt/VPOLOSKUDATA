// ===== Category rules (Description-based) =====
function escapeRegExp(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function wordMatch(text, kw) {
  const t = String(text || "").toLowerCase();
  const k = String(kw || "").toLowerCase();
  if (!k) return false;
  const boundary = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(k)}(?![A-Za-z0-9])`, "i");
  if (boundary.test(t)) return true;
  return t.includes(k);
}

const CATEGORY_RULES = [
  { name: "Fasteners", includes: [
      "screw","screws","deck screw","trim screw","self-tapping",
      "nail","nails","roofing nail","ring shank","finish nail","common nail","framing nail",
      "staple","staples",
      "anchor","concrete anchor","tapcon",
      "bolt","bolts","lag bolt","lag","carriage bolt",
      "washer","washers","nut","nuts","collated","paslode"
    ],
    excludes: ["nailer","nailing","gun","adhesive"] },

  { name: "Hardware", includes: [
      "joist hanger","hanger","bracket","connector","strap","clip","plate","tie","simpson strong-tie","strong-tie","post base","hurricane clip"
    ],
    excludes: ["screw","nail","bolt","washer","anchor"] },

  { name: "PVC", includes: ["pvc","azek","versatex","cellular pvc","pvc trim","vtp","pvc board","pvc sheet"] },

  { name: "Trim", includes: [
      "trim","casing","base","baseboard","mould","molding","crown","shoe","quarter round","qtr round","brickmould","jamb","apron","stop"
    ]},

  { name: "Siding - Vinyl", includes: [
      "vinyl siding","vinyl","soffit","fascia","j-channel","j channel","starter strip","starter-strip","starter",
      "outside corner","outside corner post","ocp","ocb","underpinning","utility trim","finish trim"
    ],
    excludes: ["hardie","fiber cement"] },

  { name: "Siding - Fiber Cement", includes: [
      "fiber cement","hardie","james hardie","hardiplank","hardieplank","hardi","fc siding","fc trim"
    ]},

  { name: "Insulation", includes: [
      "insulation","batt","r-","foam","spray foam","expanding foam","sealant foam","rigid foam","polyiso"
    ]},

  { name: "Adhesives / Sealants", includes: [
      "adhesive","construction adhesive","glue","caulk","sealant","liquid nails","polyurethane sealant","silicone"
    ]},

  { name: "Roofing", includes: [
      "roof","roofing","shingle","felt","underlayment","drip edge","ridge","ridge vent","pipe boot","ice & water","ice and water"
    ]},

  { name: "Doors / Windows", includes: [
      "door","prehang","pre-hung","slab","window","sash","stile","frame","threshold","jamb set"
    ]},

  { name: "Tools", includes: [
      "blade","saw","bit","tape","knife","hammer","drill","driver","chalk","level","square","nailer","stapler"
    ]},

  { name: "Paint / Finish", includes: [
      "paint","primer","stain","finish","enamel","latex","oil-based","acrylic"
    ]},

  { name: "Plumbing", includes: [
      "plumb","pipe","pvc sch","cpvc","pex","fitting","coupling","tee","elbow","trap","valve","supply line"
    ]},

  { name: "Lumber", includes: [
      "lumber","stud","2x","x4","osb","plywood","board","4x8","rim","joist","pt","treated","cdx","advantech","lvl"
    ]},

  { name: "Misc", includes: [] }
];

function categorizeDescription(desc = "") {
  const d = String(desc || "");
  if (/\bliquid\s+nails\b/i.test(d)) return "Adhesives / Sealants";
  for (const rule of CATEGORY_RULES) {
    const hasAll = !rule.all || rule.all.every(kw => wordMatch(d, kw));
    const hasAny = rule.includes?.some(kw => wordMatch(d, kw));
    const hasExclude = rule.excludes?.some(kw => wordMatch(d, kw));
    if (hasAll && hasAny && !hasExclude) return rule.name;
  }
  return "Misc";
}

async function fetchJSON(url, init){
  return trackAsync(
    fetch(url, init).then(async (res) => {
      __noteActivity();
      if (!res.ok){
        const t = await res.text().catch(()=> "");
        throw new Error(`HTTP ${res.status} ${res.statusText}\n${t}`);
      }
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("application/json")){
        return res.json();
      }
      const txt = await res.text();
      try { return JSON.parse(txt); } catch { return txt; }
    })
  );
}
