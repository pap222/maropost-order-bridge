// netlify/functions/maropost-to-quickb2b.js
//
// SCHEDULED bridge: pulls new paid Website orders from Maropost (Neto) and
// pushes them into QuickB2B as packing dockets. Dedups via synced_orders so an
// order is never pushed twice. Leaves the TouchSMS webhook untouched.
//
// SAFETY GATE: does nothing unless AUTO_MODE=1. While you review orders by hand
// on the dashboard page, leave AUTO_MODE unset. When you trust it, set
// AUTO_MODE=1 in Netlify and this takes over automatically every 5 minutes.
//
// All the real logic lives in lib/bridge.mjs (shared with the review-page API).
//
// REQUIRED ENV VARS (Netlify -> Site settings -> Environment variables):
//   NETO_API_URL, NETO_API_KEY, QB2B_BASE_URL, QB2B_API_KEY, QB2B_SUPPLIER_ID,
//   QB2B_WEB_CUSTOMER_CODE, SUPABASE_URL, SUPABASE_SERVICE_KEY,
//   REVIEW_PASSWORD (for the page), QB2B_TEST_MODE ("1" = test endpoint),
//   AUTO_MODE ("1" = let this cron run).

import { isAutoMode, loadItemMap, fetchWebsiteOrders, syncedSet, buildPayload, createQb2bOrder, markSynced, purgeOldFulfilled } from "../../lib/bridge.mjs";

export default async function handler() {
  // Housekeeping (runs in both manual and auto mode): drop Completed-tab rows
  // older than a week. The permanent record stays in Maropost.
  try { await purgeOldFulfilled(7); } catch { /* non-fatal */ }

  if (!(await isAutoMode())) {
    const msg = { skippedAll: true, reason: "Automation OFF - manual review mode (toggle on the review page or set AUTO_MODE=1)" };
    console.log("maropost->qb2b", JSON.stringify(msg));
    return new Response(JSON.stringify(msg), { status: 200, headers: { "Content-Type": "application/json" } });
  }

  const summary = { fetched: 0, skipped: 0, needsMapping: 0, created: 0, failed: 0, errors: [] };
  try {
    const itemMap = await loadItemMap();
    const orders = await fetchWebsiteOrders();
    summary.fetched = orders.length;

    const ids = orders.map((o) => String(o.OrderID));
    const done = await syncedSet(ids);

    for (const order of orders) {
      const id = String(order.OrderID);
      if (done.has(id)) { summary.skipped++; continue; }

      const { payload, unmapped } = buildPayload(order, itemMap);
      // Auto-send ONLY fully-mapped orders. If any line can't resolve to a
      // QuickB2B item, leave the whole order for a human to map + push by hand
      // (so nothing is silently part-shipped or guessed).
      if (unmapped.length || payload.OrderDetail.length === 0) {
        summary.needsMapping++;
        summary.errors.push({ id, msg: `left for manual: unmapped ${unmapped.join(", ") || "(no sendable lines)"}` });
        continue;
      }
      const result = await createQb2bOrder(payload, false);
      if (result.ok) {
        await markSynced(id, "created", payload);
        summary.created++;
      } else {
        summary.failed++;
        summary.errors.push({ id, msg: result.data?.message || `HTTP ${result.status}` });
      }
    }
  } catch (e) {
    summary.errors.push({ fatal: e.message });
  }

  console.log("maropost->qb2b", JSON.stringify(summary));
  return new Response(JSON.stringify(summary), { status: 200, headers: { "Content-Type": "application/json" } });
}

// Every 5 minutes — but it no-ops unless AUTO_MODE=1.
export const config = { schedule: "*/5 * * * *" };
