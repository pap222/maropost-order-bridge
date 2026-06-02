// Diagnostic: GetItem the unmapped Maropost SKUs so we can see their real
// names/units and pick the matching QuickB2B variant. Read-only. Run:
//   node --env-file=.env diag_items.mjs

const url = process.env.NETO_API_URL;
const key = process.env.NETO_API_KEY;

const SKUS = [
  "123","124","182","186","187","217","218","219","302396",
  "502","503","516","521","711","CAPGE","CAPRE","CORN","JAPW","LEBE",
];

const res = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json",
    NETOAPI_ACTION: "GetItem",
    NETOAPI_KEY: key,
  },
  body: JSON.stringify({
    Filter: {
      SKU: SKUS,
      OutputSelector: ["SKU", "Name", "DefaultPrice", "Unit", "Brand"],
      Page: 0, Limit: 100,
    },
  }),
});

const data = await res.json();
console.log("HTTP", res.status, "| Ack:", data.Ack, "| Messages:", JSON.stringify(data.Messages || {}));
const items = Array.isArray(data.Item) ? data.Item : data.Item ? [data.Item] : [];
console.log("returned", items.length, "items\n");

const found = new Set();
for (const it of items) {
  found.add(String(it.SKU));
  console.log(`${String(it.SKU).padEnd(10)} | ${it.Name || ""}  | unit=${it.Unit || "?"} | $${it.DefaultPrice || "?"}`);
}
const missing = SKUS.filter((s) => !found.has(s));
console.log("\nNOT FOUND in Maropost (" + missing.length + "):", missing.join(", ") || "(none)");
