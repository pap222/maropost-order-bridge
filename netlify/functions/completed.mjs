// GET /api/completed  -> orders marked ready in the last 7 days (the Completed
// tab). This is just a rolling working list; the permanent record lives in
// Maropost, so these rows are auto-purged weekly by the cron.
import { checkAuth, json, completedList } from "../../lib/bridge.mjs";

export default async (req) => {
  const unauth = checkAuth(req);
  if (unauth) return unauth;
  try {
    const rows = await completedList(7);
    const orders = rows.map((r) => ({
      order_id: r.maropost_order_id,
      mode: r.mode,
      status: r.status,
      customer: r.customer,
      shipping: r.shipping,
      total: Number(r.total || 0),
      fulfilled_at: r.fulfilled_at,
    }));
    return json({ count: orders.length, orders });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};
