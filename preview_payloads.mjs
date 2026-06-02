// Preview the exact QuickB2B dockets the bridge will send (comment + lines)
// WITHOUT sending anything. Read-only. Run:
//   node --env-file=.env preview_payloads.mjs

const netoUrl = process.env.NETO_API_URL;
const netoKey = process.env.NETO_API_KEY;
const supaUrl = process.env.SUPABASE_URL;
const supaKey = process.env.SUPABASE_SERVICE_KEY;
const webCustomer = process.env.QB2B_WEB_CUSTOMER_CODE || "WEB";

// 1) item_map with conversion factors
const mapRes = await fetch(`${supaUrl}/rest/v1/item_map?select=maropost_sku,qb2b_item_code,qty_factor`, {
  headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` },
});
const mapRows = await mapRes.json();
const itemMap = new Map(mapRows.map((r) => [String(r.maropost_sku), { code: r.qb2b_item_code, factor: Number(r.qty_factor) || 1 }]));

// 2) the orders the bridge targets
const res = await fetch(netoUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json", NETOAPI_ACTION: "GetOrder", NETOAPI_KEY: netoKey },
  body: JSON.stringify({
    Filter: {
      OrderStatus: ["Pick", "Pack", "Pending Dispatch"],
      OutputSelector: ["OrderID", "SalesChannel", "ShipFirstName", "ShipLastName", "BillFirstName", "BillLastName",
        "ShipStreetLine1", "ShipStreetLine2", "ShipCity", "ShipState", "ShipPostCode", "ShipPhone", "BillPhone", "OrderLine"],
      Page: 0, Limit: 50,
    },
  }),
});
const data = await res.json();
const orders = (Array.isArray(data.Order) ? data.Order : []).filter((o) => o.SalesChannel === "Website");

for (const o of orders) {
  const lines = Array.isArray(o.OrderLine) ? o.OrderLine : o.OrderLine ? [o.OrderLine] : [];
  const unmapped = [];
  const detail = [];
  for (const l of lines) {
    const sku = String(l.SKU || "");
    const entry = itemMap.get(sku);
    const orderedQty = Number(l.Quantity || 1);
    if (!entry) { unmapped.push(`${sku} x${orderedQty}`); continue; }
    const qty = Number((orderedQty * entry.factor).toFixed(3));
    detail.push(`${entry.code} qty ${qty}${entry.factor !== 1 ? `  (${orderedQty} x ${entry.factor})` : ""}`);
  }

  const name = [o.ShipFirstName || o.BillFirstName, o.ShipLastName || o.BillLastName].filter(Boolean).join(" ") || "Web customer";
  const addr = [o.ShipStreetLine1, o.ShipStreetLine2, o.ShipCity, o.ShipState, o.ShipPostCode].filter(Boolean).join(", ");
  const phone = o.ShipPhone || o.BillPhone;
  let comment = `WEB ORDER #${o.OrderID} | ${name}`;
  if (phone) comment += ` | ${phone}`;
  if (addr) comment += ` | ${addr}`;
  if (unmapped.length) comment += ` | *** NOT IN QUICKB2B - PACK MANUALLY: ${unmapped.join("; ")} ***`;

  console.log(`\n========== QuickB2B docket: customer_code=${webCustomer} ==========`);
  console.log("comment:", comment);
  console.log("OrderDetail:");
  for (const d of detail) console.log("   -", d);
}
console.log(`\n${orders.length} dockets previewed.`);
