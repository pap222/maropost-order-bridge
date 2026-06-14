// GET /api/counts -> { active, delivery, pickup } tab badge counts.
// Lightweight: counts the orders in each tab's status set without the customer
// enrichment, so the dashboard can show "how many waiting" on each tab without
// the user clicking in. Mirrors the same status sets / windows as /api/orders.
import { checkAuth, json, cfg, countWebsiteOrders } from "../../lib/bridge.mjs";

export default async (req) => {
  const unauth = checkAuth(req);
  if (unauth) return unauth;
  try {
    const c = cfg();
    const since = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
    const [active, delivery, pickup] = await Promise.all([
      countWebsiteOrders({ statuses: c.activeStatuses }),
      countWebsiteOrders({ statuses: [c.deliveryStatus], requirePaid: false, limit: 200, extraFilter: { DateUpdatedFrom: since(60) } }),
      countWebsiteOrders({ statuses: [c.pickupStatus], requirePaid: false, limit: 200, extraFilter: { DateUpdatedFrom: since(60) } }),
    ]);
    return json({ active, delivery, pickup });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};
