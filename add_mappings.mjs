// Upsert the resolved same_unit:false mappings into Supabase item_map.
// qty_factor converts the Maropost selling unit to the QuickB2B unit.
// Requires: alter table item_map add column if not exists qty_factor numeric not null default 1;
// Run:  node --env-file=.env add_mappings.mjs

const supaUrl = process.env.SUPABASE_URL;
const supaKey = process.env.SUPABASE_SERVICE_KEY;

// [maropost_sku, qb2b_item_code, qty_factor, note]
const MAP = [
  // --- 1:1 unit matches (factor 1) ---
  ["124",    "WATE",  1, "Watermelon Whole ~7.5kg -> Watermelon Seedless EACH"],
  ["217",    "TOMRE", 1, "Tomato Roma (Each) -> Tomato Roma EACH"],
  ["219",    "ZUCE",  1, "Zucchini (Each) -> Zucchini Each"],
  ["302396", "MANK",  1, "Mandarins Imperial (PER KILO) -> Mandarins PER KILO"],
  ["516",    "BANE",  1, "Banana (Each) -> Banana EACH"],
  ["521",    "BROCE", 1, "Broccoli (Per Head) -> Broccoli Each"],
  ["711",    "ON1",   1, "Onion Brown (1 Kilo Bag) -> Onion Brown 1KG BAG"],
  ["CAPGE",  "CAPGE", 1, "Capsicum Green (Each) -> Capsicum Green EACH"],
  ["CAPRE",  "CAPRE", 1, "Capsicum Red (Each) -> Capsicum Red EACH"],
  ["CORN",   "CORN",  1, "Corn Sweet Cob -> Corn Sweet COB"],
  ["JAPW",   "JAPW",  1, "Pumpkin Jap Whole -> Pumpkin Jap Whole EACH"],
  ["LEBE",   "LEBE",  1, "Cucumber Lebanese (Each) -> Cucumber Lebanese EACH"],
  ["123",    "WATQ",  1, "Watermelon Cut ~2kg -> Watermelon Seedless CUT QUARTER  [confirm]"],

  // --- unit conversions (per-kilo / fraction), per your instructions ---
  ["182",    "MUSKP", 0.25, "Mushroom Field 250g Pack -> Mushroom Flat PER KILO x0.25"],
  ["218",    "TOMTK", 0.25, "Tomato Truss Bunch of 5 -> Tomato Truss PER KILO x0.25"],
  ["502",    "CELB",  0.5,  "Celery (Half) -> Celery BUNCH x0.5"],
  ["503",    "CAUE",  0.5,  "Cauliflower (Half) -> Cauliflower EACH x0.5  [confirm]"],

  // --- onions: QuickB2B codes confirmed by you ---
  ["186",    "ONE",   1, "Onion Brown (Each) -> ONE"],
  ["187",    "SALE",  1, "Onion Red (Each) -> SALE"],
];

const rows = MAP.map(([maropost_sku, qb2b_item_code, qty_factor]) => ({
  maropost_sku, qb2b_item_code, qty_factor,
}));

const res = await fetch(`${supaUrl}/rest/v1/item_map`, {
  method: "POST",
  headers: {
    apikey: supaKey,
    Authorization: `Bearer ${supaKey}`,
    "Content-Type": "application/json",
    Prefer: "resolution=merge-duplicates,return=representation",
  },
  body: JSON.stringify(rows),
});

const text = await res.text();
console.log("HTTP", res.status);
if (!res.ok) { console.log("ERROR:", text); process.exit(1); }

console.log("upserted", rows.length, "mappings:\n");
for (const [mp, qb, f, note] of MAP) console.log(`  ${mp.padEnd(8)} -> ${qb.padEnd(7)} x${String(f).padEnd(4)} | ${note}`);

const cnt = await fetch(`${supaUrl}/rest/v1/item_map?select=maropost_sku`, {
  headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}`, Prefer: "count=exact" },
});
console.log("\nitem_map now has", cnt.headers.get("content-range"), "rows (range header)");
