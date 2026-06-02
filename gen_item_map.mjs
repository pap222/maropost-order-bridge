import { readFileSync, writeFileSync } from "node:fs";

const SRC = "C:/Users/User/Downloads/mp-qb-mapping.json";
const OUT = "C:/Users/User/Downloads/New folder/item_map_seed.sql";

// Confirmed picks for the 12 ambiguous Maropost SKUs (user-approved 2026-06-02,
// reconciled against real Maropost product names via GetItem).
const OVERRIDES = {
  "111": "SWEE", "114": "ORAK", "137": "MANK", "143": "BROCK",
  "223": "FEN", "506": "PINK", "650": "PUMQ", "712": "BIT",
  "CHERTH": "CHERTM", "GRAFY": "GRAF", "JAPP": "JAP", "PARK": "PARSNE",
};

const j = JSON.parse(readFileSync(SRC, "utf8"));
const su = j.pairs.filter((p) => p.same_unit === true);

// maropost_code -> Map(qb_code -> qb_name)
const byMp = new Map();
for (const p of su) {
  if (!byMp.has(p.maropost_code)) byMp.set(p.maropost_code, new Map());
  byMp.get(p.maropost_code).set(p.quickb2b_code, p.quickb2b_name);
}

const esc = (s) => String(s).replace(/'/g, "''");

// Resolve every Maropost SKU to exactly ONE QuickB2B code.
//  - single option  -> that code
//  - multiple options -> OVERRIDES pick, else exact code match, else first
const rows = [];
let nClean = 0, nOverride = 0, nExact = 0;
for (const [mp, qbs] of byMp) {
  const codes = [...qbs.keys()];
  let qb, note;
  if (codes.length === 1) {
    qb = codes[0];
    note = esc(qbs.get(qb));
    nClean++;
  } else {
    if (OVERRIDES[mp]) { qb = OVERRIDES[mp]; note = "[chosen] " + esc(qbs.get(qb)); nOverride++; }
    else {
      const exact = codes.find((c) => c.toLowerCase() === mp.toLowerCase());
      qb = exact || codes[0];
      note = "[default] " + esc(qbs.get(qb));
      nExact++;
    }
    if (!qbs.has(qb)) throw new Error(`Override ${mp}=${qb} is not a valid option (${codes.join(",")})`);
  }
  rows.push({ mp, qb, note });
}
rows.sort((a, b) => a.mp.localeCompare(b.mp));

// Render value rows with the comma BEFORE the inline comment (a trailing comma
// after "-- ..." would be swallowed by the line comment and break the INSERT).
const renderRows = (rs) =>
  rs
    .map(({ mp, qb, note }, i) =>
      `  ('${esc(mp)}', '${esc(qb)}')${i === rs.length - 1 ? "" : ","}  -- ${note}`)
    .join("\n");

let sql = "";
sql += "-- item_map seed — generated from mp-qb-mapping.json (same_unit:true only)\n";
sql += "-- " + rows.length + " rows, one QuickB2B code per Maropost SKU. Ready to run as-is.\n";
sql += "-- " + nClean + " unambiguous, " + nExact + " resolved by exact code match, "
     + nOverride + " resolved by confirmed choice ([chosen]).\n";
sql += "insert into item_map (maropost_sku, qb2b_item_code) values\n";
sql += renderRows(rows);
sql += "\non conflict (maropost_sku) do update set qb2b_item_code = excluded.qb2b_item_code;\n";

writeFileSync(OUT, sql);

console.log("wrote", OUT);
console.log("total rows:", rows.length, "| clean:", nClean, "| exact-default:", nExact, "| chosen:", nOverride);
