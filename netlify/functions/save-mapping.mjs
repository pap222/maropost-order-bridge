// POST /api/save-mapping  { maropost_sku, qb2b_item_code, qty_factor }
// Upserts a mapping into Supabase item_map (applies to all future orders too).
import { checkAuth, json, upsertMapping } from "../../lib/bridge.mjs";

export default async (req) => {
  const unauth = checkAuth(req);
  if (unauth) return unauth;
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  try {
    const body = await req.json();
    if (!body.maropost_sku || !body.qb2b_item_code) {
      return json({ error: "maropost_sku and qb2b_item_code are required" }, 400);
    }
    const saved = await upsertMapping(body);
    return json({ ok: true, saved });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};
