import { readFileSync, writeFileSync } from "node:fs";

const SRC = "C:/Users/User/Downloads/mp-qb-mapping.json";
const OUT = "C:/Users/User/Downloads/New folder/conflicts_to_choose.md";

const j = JSON.parse(readFileSync(SRC, "utf8"));
const su = j.pairs.filter((p) => p.same_unit === true);

// maropost_code -> { master_name, maropost_qty, options: [{code,name,qty}] }
const byMp = new Map();
for (const p of su) {
  if (!byMp.has(p.maropost_code)) {
    byMp.set(p.maropost_code, {
      master: p.master_name,
      mpQty: p.maropost_qty,
      options: [],
    });
  }
  byMp.get(p.maropost_code).options.push({
    code: p.quickb2b_code,
    name: p.quickb2b_name,
    qty: p.quickb2b_qty,
  });
}

const conflicts = [...byMp.entries()]
  .filter(([, v]) => v.options.length > 1)
  .sort((a, b) => a[0].localeCompare(b[0]));

let md = "# QuickB2B target choices for ambiguous Maropost SKUs\n\n";
md += "One row per Maropost SKU that maps to 2+ QuickB2B codes. The Maropost side\n";
md += "shows the master product + qty multiplier (the file has no Maropost product\n";
md += "name). Pick ONE QuickB2B code per SKU by putting it in the **CHOICE** column.\n\n";
md += "| Maropost SKU | Master product (Maropost qty) | QuickB2B options (code = name @ qty) | CHOICE |\n";
md += "|---|---|---|---|\n";

for (const [mp, v] of conflicts) {
  const opts = v.options
    .map((o) => `\`${o.code}\` = ${o.name} @ ${o.qty}`)
    .join(" <br> ");
  md += `| \`${mp}\` | ${v.master} (qty ${v.mpQty}) | ${opts} |  |\n`;
}

writeFileSync(OUT, md);
console.log("wrote", OUT, "with", conflicts.length, "conflicts");

// Also print a compact console version grouped: exact-match-default vs needs-review
const needsReview = [];
const hasDefault = [];
for (const [mp, v] of conflicts) {
  const exact = v.options.find((o) => o.code.toLowerCase() === mp.toLowerCase());
  (exact ? hasDefault : needsReview).push([mp, v, exact]);
}
const line = (mp, v) =>
  `${mp.padEnd(8)} | ${(v.master + " (q" + v.mpQty + ")").padEnd(40)} | ` +
  v.options.map((o) => `${o.code}=${o.name}`).join("  ||  ");
console.log("\n===== " + needsReview.length + " NEED A DECISION (no exact code match) =====");
for (const [mp, v] of needsReview) console.log(line(mp, v));
console.log("\n===== " + hasDefault.length + " have an exact-code default (likely fine) =====");
for (const [mp, v, ex] of hasDefault) console.log(line(mp, v) + "   [default: " + ex.code + "]");
