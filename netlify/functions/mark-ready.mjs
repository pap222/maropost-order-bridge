// POST /api/mark-ready  { orderId }
// "Marks an order ready" by changing its Maropost status:
//   pickup   -> Pending Pickup   (fires the "ready to collect" SMS)
//   delivery -> Dispatched       (fires the "on its way" SMS)
// The status change is what triggers the customer's TouchSMS webhook. We also
// log the order to the Completed list (auto-purged weekly) so the dashboard can
// move the card off the active board and show it under Completed.
import {
  checkAuth, json, fetchOneOrder, fulfilmentMode, readyStatusFor,
  updateOrderStatus, markFulfilled,
} from "../../lib/bridge.mjs";

function orderName(o) {
  const name = [o.ShipFirstName || o.BillFirstName, o.ShipLastName || o.BillLastName]
    .filter(Boolean).join(" ");
  return name || o.ShipCompany || o.BillCompany || o.Email || "Web customer";
}

export default async (req) => {
  const unauth = checkAuth(req);
  if (unauth) return unauth;
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const { orderId } = await req.json();
    if (!orderId) return json({ error: "orderId required" }, 400);

    // Re-fetch live so we set the status on the real, current order.
    const order = await fetchOneOrder(orderId);
    if (!order) return json({ error: `Order ${orderId} not found` }, 404);

    const mode = fulfilmentMode(order);     // "pickup" | "delivery"
    const status = readyStatusFor(order);   // Pending Pickup | Dispatched

    await updateOrderStatus(orderId, status);

    // Log to the Completed working list (best-effort; don't fail the SMS trigger).
    try {
      await markFulfilled(orderId, {
        mode,
        status,
        customer: orderName(order),
        shipping: order.ShippingOption || "",
        total: Number(order.GrandTotal || 0),
      });
    } catch { /* the status change (and SMS) already happened */ }

    return json({ ok: true, orderId: String(orderId), mode, status });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};
