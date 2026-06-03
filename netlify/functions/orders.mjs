// GET /api/orders[?view=active|delivery|pickup]
//   active   (default) -> orders still "to process" (active statuses)
//   delivery           -> orders already marked ready for delivery (Dispatched)
//   pickup             -> orders already marked ready for pickup (Pending Pickup)
// Each row carries its QuickB2B mapping + whether it's already synced.
// Protected by shared password.
import { checkAuth, json, cfg, loadItemMap, fetchWebsiteOrders, reviewOrder, syncedSet, unavailableMap } from "../../lib/bridge.mjs";

export default async (req) => {
  const unauth = checkAuth(req);
  if (unauth) return unauth;
  try {
    const c = cfg();
    const view = new URL(req.url).searchParams.get("view") || "active";
    const statusFor = { delivery: [c.deliveryStatus], pickup: [c.pickupStatus] };
    // The ready tabs don't require the paid filter (already vetted when processed)
    // and pull only the matching post-fulfilment status.
    const opts = statusFor[view]
      ? { statuses: statusFor[view], requirePaid: false }
      : {};
    const itemMap = await loadItemMap();
    const orders = await fetchWebsiteOrders(opts);
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
