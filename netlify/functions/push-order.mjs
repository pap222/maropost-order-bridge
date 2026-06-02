// POST /api/push-order  { orderId, testMode }
// Re-fetches the order live, builds the docket from current item_map, pushes to
// QuickB2B (test or live), and records it in synced_orders. Idempotent: a second
// push of the same order is skipped.
import { checkAuth, json, loadItemMap, fetchOneOrder, buildPayload, createQb2bOrder, markSynced, syncedSet } from "../../lib/bridge.mjs";

export default async (req) => {
  const unauth = checkAuth(req);
  if (unauth) return unauth;
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const { orderId, testMode } = await req.json();
    if (!orderId) return json({ error: "orderId required" }, 400);

    const done = await syncedSet([String(orderId)]);
    if (done.has(String(orderId))) {
      return json({ ok: true, already: true, message: "Already pushed earlier" });
    }

    const order = await fetchOneOrder(orderId);
    if (!order) return json({ error: `Order ${orderId} not found or not a paid Website order` }, 404);

    const itemMap = await loadItemMap();
    const { payload, unmapped } = buildPayload(order, itemMap);
    if (payload.OrderDetail.length === 0) {
      return json({ error: "Every line is unmapped - map at least one before pushing", unmapped }, 400);
    }

    const result = await createQb2bOrder(payload, !!testMode);
    if (result.ok) {
      await markSynced(orderId, testMode ? "test" : "created", payload);
      return json({ ok: true, testMode: !!testMode, qb2b: result.data, unmapped });
    }
    return json({
      ok: false,
      status: result.status,
      message: result.data?.message || `HTTP ${result.status}`,
      qb2b: result.data,
    }, 502);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};
