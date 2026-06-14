// POST /api/dispatch  { orderId }            -> dispatch one order
//                     { orderIds: [..] }     -> dispatch a batch (the "Dispatch all" button)
// Moves an order from its Awaiting state (Pending Pickup / Pending Dispatch) to the
// final Dispatched status in Maropost. Pure status move - no QuickB2B, no label.
import { checkAuth, json, cfg, updateOrderStatus } from "../../lib/bridge.mjs";

export default async (req) => {
  const unauth = checkAuth(req);
  if (unauth) return unauth;
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const body = await req.json();
    const ids = Array.isArray(body.orderIds)
      ? body.orderIds.map((x) => String(x).trim()).filter(Boolean)
      : body.orderId ? [String(body.orderId).trim()] : [];
    if (!ids.length) return json({ error: "orderId or orderIds required" }, 400);

    const status = cfg().dispatchedStatus;
    const results = [];
    for (const id of ids) {
      try {
        await updateOrderStatus(id, status);
        results.push({ orderId: id, ok: true });
      } catch (e) {
        results.push({ orderId: id, ok: false, error: e.message });
      }
    }
    const done = results.filter((r) => r.ok).length;
    return json({ ok: done > 0, status, count: done, failed: results.length - done, results });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};
