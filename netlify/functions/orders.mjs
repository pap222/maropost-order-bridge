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
    const query = (params.get("q") || "").trim();
    const statusFor = { delivery: [c.deliveryStatus], pickup: [c.pickupStatus] };
    // The ready tabs don't require the paid filter (already vetted when processed)
    // and pull only the matching post-fulfilment status.
    const opts = statusFor[view]
      ? { statuses: statusFor[view], requirePaid: false }
      : {};
    const itemMap = await loadItemMap();
    // A bare number (with/without "N") is always an order-id lookup.
    const idLike = (lookupId || (query && /^N?\d+$/i.test(query) ? query : "")).trim();

    let orders;
    if (idLike) {
      // Search by order number: accept "27575" or "N27575" and look it up directly.
      const id = /^N/i.test(idLike) ? idLike.toUpperCase() : "N" + idLike.replace(/\D/g, "");
      const one = await fetchOneOrder(id);
      orders = one ? [one] : [];
    } else if (query) {
      // Whole-database text search: pull every operational order (active + ready +
      // dispatched) and filter by customer name / email / company / shipping.
      const allStatuses = [...new Set([...c.activeStatuses, c.deliveryStatus, c.pickupStatus, "Dispatched", "On Hold"])];
      const ql = query.toLowerCase();
      const pool = await fetchWebsiteOrders({ statuses: allStatuses, requirePaid: false, limit: 200 });
      orders = pool.filter((o) => {
        const hay = [
          o.OrderID, o.Email, o.ShipFirstName, o.ShipLastName, o.ShipCompany,
          o.BillFirstName, o.BillLastName, o.BillCompany, o.ShippingOption,
        ].map((x) => String(x || "").toLowerCase()).join(" ");
        return hay.includes(ql);
      });
    } else {
      orders = await fetchWebsiteOrders(opts);
    }
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
