// POST /api/set-unavailable  { orderId, sku, unavailable }
// Flags (or unflags) one order line as "not available". Persisted in Supabase
// so the mark survives a page refresh and feeds the refund total + invoice.
import { checkAuth, json, setUnavailable } from "../../lib/bridge.mjs";

export default async (req) => {
  const unauth = checkAuth(req);
  if (unauth) return unauth;
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const { orderId, sku, unavailable } = await req.json();
    if (!orderId || !sku) return json({ error: "orderId and sku required" }, 400);
    await setUnavailable(orderId, sku, !!unavailable);
    return json({ ok: true, orderId: String(orderId), sku: String(sku), unavailable: !!unavailable });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};
