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

import { isAutoMode, loadItemMap, fetchWebsiteOrders, syncedSet, buildPayload, createQb2bOrder, markSynced, purgeOldFulfilled, notifyPackr, qb2bInvoiceNo, customerInfo, notifySlack, notifiedSet, markNotified, orderDeepLink, notifyPackrNeedsMapping, prunePackrNeedsMapping, writePackrStalled, waggaHourNow, reqDateISO, todayISO, cfg } from "../../lib/bridge.mjs";

export default async function handler() {
  // Housekeeping (runs in both manual and auto mode): drop Completed-tab rows
  // older than a week. The permanent record stays in Maropost.
  try { await purgeOldFulfilled(7); } catch { /* non-fatal */ }

  const summary = { fetched: 0, skipped: 0, needsMapping: 0, alerted: 0, stalled: 0, eodAlerted: 0, created: 0, failed: 0, auto: false, errors: [] };
  try {
    const c = cfg();
    const auto = await isAutoMode();
    summary.auto = auto;
    const itemMap = await loadItemMap();
    const orders = await fetchWebsiteOrders();
    summary.fetched = orders.length;
    const today = todayISO();

    const ids = orders.map((o) => String(o.OrderID));
    const done = await syncedSet(ids);

    // Build every fetched (To Process) order once: mapping + sync state + wanted date.
    const all = orders.map((o) => ({
      o, id: String(o.OrderID), synced: done.has(String(o.OrderID)),
      iso: reqDateISO(o.DateRequired), ...buildPayload(o, itemMap),
    }));
    const isMapped = (a) => !a.unmapped.length && a.payload.OrderDetail.length;

    // NEW (un-synced) orders: fully-mapped vs needs-mapping.
    const built = all.filter((a) => !a.synced);
    summary.skipped = orders.length - built.length;
    const needMap = built.filter((b) => !isMapped(b));
    const ready = built.filter((b) => isMapped(b));
    summary.needsMapping = needMap.length;

    // PACKR banner feed: refresh the "needs mapping" entry for every outstanding
    // unmapped order (idempotent per id) so the eachbulk page can flag same-day
    // pickups that would otherwise be missed. Then drop any stale (past-dated)
    // entries. Runs in BOTH manual and auto mode.
    for (const b of needMap) {
      await notifyPackrNeedsMapping(b.o, b.unmapped);
    }
    await prunePackrNeedsMapping();

    // STALLED safety net: MAPPED orders still sitting in To Process on/after their
    // pickup/delivery date (nobody marked them ready, so no "ready" SMS fired and
    // they just sit). Overdue ones show on PACKR all day; today's join the banner
    // after the end-of-day cutoff. The whole node is overwritten each run, so it
    // self-clears the moment an order is actioned.
    const stalledOverdue = all.filter((a) => isMapped(a) && a.iso && a.iso < today);
    const stalledToday = all.filter((a) => isMapped(a) && a.iso && a.iso === today);
    const pastCutoff = waggaHourNow() >= c.eodHour;
    const bannerSet = pastCutoff ? stalledOverdue.concat(stalledToday) : stalledOverdue;
    summary.stalled = bannerSet.length;
    await writePackrStalled(bannerSet.map((a) => {
      const ci = customerInfo(a.o);
      return {
        id: a.id,
        biz: (ci.company && ci.company.trim()) || (ci.name && ci.name.trim()) || "Web order",
        iso: a.iso,
        isPickup: /pick\s*-?\s*up/i.test(a.o.ShippingOption || ""),
        shipping: a.o.ShippingOption || "",
      };
    }));

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

    // CUTOFF Slack: after the cutoff hour (default noon), ping once per order for
    // anything MAPPED still sitting in To Process with today's date (or overdue) —
    // i.e. it should have gone out and didn't. Deduped per order per day (the kind
    // carries the date, so a still-stuck order re-pings the next day, not same day).
    if (pastCutoff) {
      const eod = stalledOverdue.concat(stalledToday);
      if (eod.length) {
        const kind = `eod_stall:${today}`;
        try {
          const already = await notifiedSet(eod.map((a) => a.id), kind);
          for (const a of eod) {
            if (already.has(a.id)) continue;
            await markNotified(a.id, kind);
            const cust = (customerInfo(a.o).name || "").trim();
            const link = orderDeepLink(a.id);
            const mode = /pick\s*-?\s*up/i.test(a.o.ShippingOption || "") ? "pickup" : "delivery";
            const when = a.iso === today ? "due TODAY" : `overdue (${a.iso})`;
            const text =
              `:hourglass_flowing_sand: *#${a.id}* still in To Process past cutoff` + (cust ? ` — ${cust}` : "") +
              `\nMapped & pushed but never marked ready — ${mode}, ${when}.` +
              (link ? `\n<${link}|Open in dashboard>` : "");
            if (await notifySlack(text)) summary.eodAlerted++;
          }
        } catch (e) {
          summary.errors.push({ eod: "notify skipped: " + e.message });
        }
      }
    }

    // Auto-push the fully-mapped orders (only when automation is ON). Anything in
    // needMap is deliberately left for a human to map + push by hand.
    if (auto) {
      for (const b of ready) {
        const result = await createQb2bOrder(b.payload, false);
        if (result.ok) {
          // Capture the QuickB2B invoice number so the dashboard can later search
          // this order by its QB2B number (a manual push already does this).
          const invoice = qb2bInvoiceNo(result.data);
          await markSynced(b.id, "created", b.payload, invoice);
          summary.created++;
          // Alert the PACKR packing screen (non-fatal).
          await notifyPackr(b.o, b.payload, invoice);
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
