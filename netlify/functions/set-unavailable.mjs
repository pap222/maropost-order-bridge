// POST /api/set-unavailable  { orderId, sku, qty }
// Sets how many units of one order line are "not available" (short supply).
// qty<=0 clears the mark. Persisted in Supabase so it survives a refresh and
// feeds the refund total + invoice. (Legacy `unavailable: true` still works as
// "whole line".)
import { checkAuth, json, setUnavailable } from "../../lib/bridge.mjs";

export default async (req) => {
  const unauth = checkAuth(req);
  if (unauth) return unauth;
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const body = await req.json();
    const { orderId, sku } = body;
    if (!orderId || !sku) return json({ error: "orderId and sku required" }, 400);
    // Accept an explicit qty; fall back to the old boolean (true = whole line).
    let qty = body.qty;
    if (qty == null && typeof body.unavailable === "boolean") qty = body.unavailable ? 1e9 : 0;
    qty = Number(qty) || 0;
    if (qty < 0) qty = 0;
    await setUnavailable(orderId, sku, qty);
    return json({ ok: true, orderId: String(orderId), sku: String(sku), qty });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};
