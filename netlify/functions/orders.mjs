// GET /api/orders[?view=active|delivery|pickup][?id=N27575]
//   active   (default) -> orders still "to process" (active statuses)
//   delivery           -> orders already marked ready for delivery (Dispatched)
//   pickup             -> orders already marked ready for pickup (Pending Pickup)
//   id=<orderId>       -> look up one specific order by number (search box)
// Each row carries its QuickB2B mapping + whether it's already synced.
// Protected by shared password.
import { checkAuth, json, cfg, loadItemMap, fetchWebsiteOrders, fetchOneOrder, reviewOrder, syncedSet, unavailableMap } from "../../lib/bridge.mjs";

export default async (req) => {
  const unauth = checkAuth(req);
  if (unauth) return unauth;
  try {
    const c = cfg();
    const params = new URL(req.url).searchParams;
    const view = params.get("view") || "active";
    const lookupId = (params.get("id") || "").trim();
    const statusFor = { delivery: [c.deliveryStatus], pickup: [c.pickupStatus] };
    // The ready tabs don't require the paid filter (already vetted when processed)
    // and pull only the matching post-fulfilment status.
    const opts = statusFor[view]
      ? { statuses: statusFor[view], requirePaid: false }
      : {};
    const itemMap = await loadItemMap();
    // Search by order number: accept "27575" or "N27575" and look it up directly.
    const orders = lookupId
      ? await (async () => {
          const id = /^N/i.test(lookupId) ? lookupId.toUpperCase() : "N" + lookupId.replace(/\D/g, "");
          const one = await fetchOneOrder(id);
          return one ? [one] : [];
        })()
      : await fetchWebsiteOrders(opts);
    const ids = orders.map((o) => String(o.OrderID));
    const done = await syncedSet(ids);
    const unavail = await unavailableMap(ids);
    const reviewed = orders.map((o) => {
      const r = reviewOrder(o, itemMap, unavail.get(String(o.OrderID)) || new Map());
      r.synced = done.has(r.order_id);
      return r;
    });
    return json({ count: reviewed.length, orders: reviewed });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};
