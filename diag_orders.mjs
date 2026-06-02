// Diagnostic v2: figure out why GetOrder returns 0. Tries several filter
// strategies and reports each. Read-only. Run:
//   node --env-file=.env diag_orders.mjs

const url = process.env.NETO_API_URL;
const key = process.env.NETO_API_KEY;

const OUT = [
  "OrderID", "OrderStatus", "DatePlaced", "GrandTotal", "SalesChannel", "OrderPayment",
];

async function getOrder(label, filter) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      NETOAPI_ACTION: "GetOrder",
      NETOAPI_KEY: key,
    },
    body: JSON.stringify({ Filter: filter }),
  });
  let data;
  try { data = await res.json(); } catch { data = { parseError: await res.text() }; }
  const orders = Array.isArray(data.Order) ? data.Order : [];
  console.log(`\n--- ${label} ---`);
  console.log(`HTTP ${res.status} | Ack: ${data.Ack} | Messages: ${JSON.stringify(data.Messages || {})} | returned ${orders.length}`);
  for (const o of orders.slice(0, 8)) {
    const pays = Array.isArray(o.OrderPayment) ? o.OrderPayment : o.OrderPayment ? [o.OrderPayment] : [];
    const paySummary = pays.map((p) => `${p.PaymentType || "?"}:$${p.Amount}${p.DatePaid ? " paid" : " UNPAID"}`).join("; ") || "(none)";
    console.log(`  #${o.OrderID} | ${o.OrderStatus} | ch=${o.SalesChannel || "?"} | $${o.GrandTotal} | ${o.DatePlaced} | ${paySummary}`);
  }
  return orders;
}

// 1) Wide date range, no status filter — most likely fix.
await getOrder("A: date range 2024-01-01 .. 2026-12-31", {
  OutputSelector: OUT,
  DatePlacedFrom: "2024-01-01",
  DatePlacedTo: "2026-12-31",
  Page: 0, Limit: 15,
});

// 2) Each common Neto order status, no date filter.
for (const st of ["New", "Pick", "Pack", "Pending", "Pending Pick", "Pending Dispatch", "Dispatched", "On Hold", "Backorder"]) {
  await getOrder(`B: OrderStatus=${st}`, {
    OutputSelector: OUT,
    OrderStatus: [st],
    Page: 0, Limit: 5,
  });
}
