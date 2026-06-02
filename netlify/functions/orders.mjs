// GET /api/orders  -> current paid Website orders with their QuickB2B mapping
// resolved + whether each is already synced. Protected by shared password.
import { checkAuth, json, loadItemMap, fetchWebsiteOrders, reviewOrder, syncedSet } from "../../lib/bridge.mjs";

export default async (req) => {
  const unauth = checkAuth(req);
  if (unauth) return unauth;
  try {
    const itemMap = await loadItemMap();
    const orders = await fetchWebsiteOrders();
    const ids = orders.map((o) => String(o.OrderID));
    const done = await syncedSet(ids);
    const reviewed = orders.map((o) => {
      const r = reviewOrder(o, itemMap);
      r.synced = done.has(r.order_id);
      return r;
    });
    return json({ count: reviewed.length, orders: reviewed });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};
