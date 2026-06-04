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

import { isAutoMode, loadItemMap, fetchWebsiteOrders, syncedSet, buildPayload, createQb2bOrder, markSynced, purgeOldFulfilled, notifyPackr, qb2bInvoiceNo, customerInfo, notifySlack, notifiedSet, markNotified, orderDeepLink, notifyPackrNeedsMapping, prunePackrNeedsMapping } from "../../lib/bridge.mjs";

export default async function handler() {
  // Housekeeping (runs in both manual and auto mode): drop Completed-tab rows
  // older than a week. The permanent record stays in Maropost.
  try { await purgeOldFulfilled(7); } catch { /* non-fatal */ }

  const summary = { fetched: 0, skipped: 0, needsMapping: 0, alerted: 0, created: 0, failed: 0, auto: false, errors: [] };
  try {
    const auto = await isAutoMode();
    summary.auto = auto;
    const itemMap = await loadItemMap();
    const orders = await fetchWebsiteOrders();
    summary.fetched = orders.length;

    const ids = orders.map((o) => String(o.OrderID));
    const done = await syncedSet(ids);

    // Classify the NEW (un-synced) orders: fully-mapped vs needs-mapping.
    const built = orders
      .filter((o) => !done.has(String(o.OrderID)))
      .map((o) => ({ o, id: String(o.OrderID), ...buildPayload(o, itemMap) }));
    summary.skipped = orders.length - built.length;
    const needMap = built.filter((b) => b.unmapped.length || b.payload.OrderDetail.length === 0);
    const ready = built.filter((b) => !b.unmapped.length && b.payload.OrderDetail.length);
    summary.needsMapping = needMap.length;

    // PACKR banner feed: refresh the "needs mapping" entry for every outstanding
    // unmapped order (idempotent per id) so the eachbulk page can flag same-day
    // pickups that would otherwise be missed. Then drop any stale (past-dated)
    // entries. Runs in BOTH manual and auto mode.
    for (const b of needMap) {
      await notifyPackrNeedsMapping(b.o, b.unmapped);
    }
    await prunePackrNeedsMapping();

    // Slack alert for newly-arrived orders that need mapping. Runs in BOTH manual
    // and auto mode (you always want to know an order is waiting on a mapping).
    // Record-then-send so a Slack hiccup can't re-alert the same order, and skip
    // entirely if the notified_orders dedup table isn't there yet.
    if (needMap.length) {
      try {
        const already = await notifiedSet(needMap.map((b) => b.id));
        for (const b of needMap) {
          if (already.has(b.id)) continue;
          await markNotified(b.id);
          const cust = (customerInfo(b.o).name || "").trim();
          const link = orderDeepLink(b.id);
          const skus = b.unmapped.join(", ") || "(no sendable lines)";
          const text =
            `:package: New web order *#${b.id}* needs mapping` + (cust ? ` — ${cust}` : "") +
            `\nUnmapped: ${skus}` +
            (link ? `\n<${link}|Open in dashboard>` : "");
          if (await notifySlack(text)) summary.alerted++;
        }
      } catch (e) {
        summary.errors.push({ slack: "notify skipped: " + e.message });
      }
    }

    // Auto-push the fully-mapped orders (only when automation is ON). Anything in
    // needMap is deliberately left for a human to map + push by hand.
    if (auto) {
      for (const b of ready) {
        const result = await createQb2bOrder(b.payload, false);
        if (result.ok) {
          await markSynced(b.id, "created", b.payload);
          summary.created++;
          // Alert the PACKR packing screen (non-fatal).
          await notifyPackr(b.o, b.payload, qb2bInvoiceNo(result.data));
        } else {
          summary.failed++;
          summary.errors.push({ id: b.id, msg: result.data?.message || `HTTP ${result.status}` });
        }
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
