// GET  /api/settings            -> { auto_mode: true|false }
// POST /api/settings { auto_mode: true|false }  -> sets the live automation flag
//
// The auto_mode flag lives in Supabase (app_settings table) so the scheduled
// cron reads it at runtime and the review page can flip it without a redeploy.
import { checkAuth, json, getSetting, setSetting } from "../../lib/bridge.mjs";

export default async (req) => {
  const unauth = checkAuth(req);
  if (unauth) return unauth;
  try {
    if (req.method === "GET") {
      const v = await getSetting("auto_mode", process.env.AUTO_MODE === "1" ? "1" : "0");
      return json({ auto_mode: v === "1" });
    }
    if (req.method === "POST") {
      const body = await req.json();
      const on = body.auto_mode === true || body.auto_mode === "1" || body.auto_mode === 1;
      await setSetting("auto_mode", on ? "1" : "0");
      return json({ ok: true, auto_mode: on });
    }
    return json({ error: "GET or POST only" }, 405);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};
