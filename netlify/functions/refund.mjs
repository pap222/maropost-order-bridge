// POST /api/refund  { orderId }
// Refunds (via Stripe) the value of the lines marked "not available" on an
// order. Partial + incremental: it only refunds the amount not already refunded,
// so marking more items later and refunding again tops up the difference.
// The Stripe payment is located by the Maropost order id in the charge metadata.
import {
  checkAuth, json, fetchOneOrder, loadItemMap, reviewOrder,
  unavailableSet, refundedTotal, recordRefund, findStripePayment, stripeRefund,
} from "../../lib/bridge.mjs";

export default async (req) => {
  const unauth = checkAuth(req);
  if (unauth) return unauth;
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const { orderId } = await req.json();
    if (!orderId) return json({ error: "orderId required" }, 400);

    // Re-fetch live so the amounts are authoritative, not whatever the page had.
    const order = await fetchOneOrder(orderId);
    if (!order) return json({ error: `Order ${orderId} not found or not a paid Website order` }, 404);

    const itemMap = await loadItemMap();
    const unavail = await unavailableSet(orderId);
    const r = reviewOrder(order, itemMap, unavail);
    if (r.refund_total <= 0) {
      return json({ error: "No items are marked 'not available' on this order" }, 400);
    }

    const already = await refundedTotal(orderId);
    const delta = Number((r.refund_total - already).toFixed(2));
    if (delta <= 0) {
      return json({ ok: true, already: true, refunded: already, message: `Already refunded $${already.toFixed(2)}` });
    }

    const pay = await findStripePayment(orderId);
    if (!pay) {
      return json({
        error: `Couldn't find the Stripe payment for order ${orderId}. ` +
          `Check the order id is stored in the Stripe charge metadata (set STRIPE_ORDER_ID_META_KEY if it uses a different key).`,
      }, 404);
    }

    const amountCents = Math.round(delta * 100);
    const result = await stripeRefund({
      paymentIntentId: pay.paymentIntentId,
      chargeId: pay.chargeId,
      amountCents,
      idempotencyKey: `refund:${orderId}:${Math.round(already * 100)}:${amountCents}`,
      reason: `Unavailable items on web order ${orderId}`,
    });

    const skus = r.lines.filter((l) => l.unavailable).map((l) => l.sku).join(",");
    if (result.ok) {
      await recordRefund({
        orderId,
        stripeRefundId: result.data.id,
        amount: delta,
        status: result.data.status, // succeeded | pending
        skus,
      });
      return json({
        ok: true,
        refunded: delta,
        total_refunded: Number((already + delta).toFixed(2)),
        stripe_refund_id: result.data.id,
        status: result.data.status,
      });
    }
    return json({ ok: false, status: result.status, message: result.message, stripe: result.data }, 502);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};
