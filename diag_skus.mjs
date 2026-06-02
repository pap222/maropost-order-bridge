// Diagnostic: for the orders the bridge fetches, show each line's Maropost SKU,
// product name, and what item_map maps it to (or UNMAPPED). Read-only. Run:
//   node --env-file=.env diag_skus.mjs

const netoUrl = process.env.NETO_API_URL;
const netoKey = process.env.NETO_API_KEY;
const supaUrl = process.env.SUPABASE_URL;
const supaKey = process.env.SUPABASE_SERVICE_KEY;

// 1) Load item_map from Supabase
const mapRes = await fetch(`${supaUrl}/rest/v1/item_map?select=maropost_sku,qb2b_item_code`, {
  headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` },
});
const mapRows = await mapRes.json();
const itemMap = new Map(mapRows.map((r) => [String(r.maropost_sku), r.qb2b_item_code]));
console.log("item_map rows loaded:", itemMap.size);

// 2) Fetch the same orders the bridge targets
const res = await fetch(netoUrl, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
    NETOAPI_ACTION: "GetOrder",
    NETOAPI_KEY: netoKey,
  },
  body: JSON.stringify({
    Filter: {
      OrderStatus: ["Pick", "Pack", "Pending Dispatch"],
      OutputSelector: ["OrderID", "SalesChannel", "OrderLine"],
      Page: 0, Limit: 50,
    },
  }),
});
const data = await res.json();
const orders = (Array.isArray(data.Order) ? data.Order : []).filter((o) => o.SalesChannel === "Website");

const allSkus = new Set();
const unmapped = new Set();

for (const o of orders) {
  const lines = Array.isArray(o.OrderLine) ? o.OrderLine : o.OrderLine ? [o.OrderLine] : [];
  console.log(`\n#${o.OrderID} (${lines.length} lines)`);
  for (const l of lines) {
    const sku = String(l.SKU || "");
    allSkus.add(sku);
    const mapped = itemMap.get(sku);
    if (!mapped) unmapped.add(sku);
    console.log(`  SKU=${sku.padEnd(10)} qty=${String(l.Quantity).padEnd(5)} -> ${mapped ? "qb=" + mapped : "*** UNMAPPED ***"}   (${l.ProductName || ""})`);
  }
}

console.log("\n================ SUMMARY ================");
console.log("distinct SKUs in these orders:", allSkus.size);
console.log("UNMAPPED SKUs (" + unmapped.size + "):", [...unmapped].sort().join(", ") || "(none)");
console.log("========================================");
