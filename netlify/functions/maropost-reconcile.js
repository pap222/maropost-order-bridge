// netlify/functions/maropost-reconcile.js
//
// SCHEDULED address-change watchdog. A web order is pushed to QuickB2B once and
// never revisited, so a delivery-address change made in Maropost AFTER the push
// silently never reaches the docket or the driver — goods can land at the old
// address. This re-checks every not-yet-dispatched web order against the address
// we snapshotted at sync time and Slack-alerts on any change.
//
// Alert-only: it never changes an order. Safe to run in both manual and auto mode
// (it doesn't push anything), so there's no AUTO_MODE gate.
//
// Uses the same env as the main bridge (NETO_*, SUPABASE_*, Slack webhook).

import { reconcileAddresses } from "../../lib/bridge.mjs";

export default async function handler() {
  let summary;
  try {
    summary = await reconcileAddresses();
  } catch (e) {
    summary = { fatal: e.message };
  }
  console.log("maropost-reconcile", JSON.stringify(summary));
  return new Response(JSON.stringify(summary), { status: 200, headers: { "Content-Type": "application/json" } });
}

// Every 10 minutes — independent of AUTO_MODE (alert-only).
export const config = { schedule: "*/10 * * * *" };
