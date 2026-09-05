import fs from "node:fs";
import { config } from "./config.mjs";

// Tiny JSON-file state: bets placed (for cooldown + daily exposure).
function load() {
  try { return JSON.parse(fs.readFileSync(config.stateFile, "utf8")); } catch { return { bets: [] }; }
}
function save(s) { fs.writeFileSync(config.stateFile, JSON.stringify(s, null, 2)); }

export const state = {
  recentlyBet(key, cooldownMin = config.cooldownMin) {
    const cutoff = Date.now() - cooldownMin * 60_000;
    return load().bets.some((b) => b.key === key && Date.parse(b.at) > cutoff);
  },
  exposureToday() {
    const day = new Date().toISOString().slice(0, 10);
    return load().bets.filter((b) => b.at.startsWith(day) && b.live).reduce((s, b) => s + b.stakeUsd, 0);
  },
  record(bet) {
    const s = load();
    s.bets.push({ ...bet, at: new Date().toISOString() });
    if (s.bets.length > 5000) s.bets = s.bets.slice(-5000);
    save(s);
  },
};
