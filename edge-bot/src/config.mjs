import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Minimal .env loader (no dotenv dependency). Real env vars win.
function loadDotEnv() {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).replace(/\s+#.*$/, "").trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadDotEnv();

const num = (k, d) => (process.env[k] === undefined || process.env[k] === "" ? d : Number(process.env[k]));
const bool = (k, d = false) => (process.env[k] === undefined || process.env[k] === "" ? d : /^(1|true|yes)$/i.test(process.env[k]));
const str = (k, d = "") => process.env[k] ?? d;

export const config = {
  root: ROOT,
  live: bool("LIVE") && bool("I_UNDERSTAND_THIS_BETS_REAL_MONEY"),
  autoMatchTrade: bool("AUTO_MATCH_TRADE"),

  bankroll: num("BANKROLL_USD", 1000),
  kellyFraction: num("KELLY_FRACTION", 0.25),
  maxStake: num("MAX_STAKE_USD", 50),
  minStake: num("MIN_STAKE_USD", 2),
  maxDailyExposure: num("MAX_DAILY_EXPOSURE_USD", 300),
  minEdge: num("MIN_EDGE", 0.04),
  minArbMargin: num("MIN_ARB_MARGIN", 0.01),
  minLiquidity: num("MIN_LIQUIDITY_USD", 20),
  cooldownMin: num("COOLDOWN_MIN", 180),
  matchThreshold: num("MATCH_THRESHOLD", 0.62),
  gbpUsd: num("GBP_USD", 1.27),
  fairWeightBf: num("FAIR_WEIGHT_BF", 0.7),

  pm: {
    fee: num("PM_FEE", 0),
    maxMarkets: num("PM_MAX_MARKETS", 300),
    privateKey: str("PM_PRIVATE_KEY"),
    funder: str("PM_FUNDER"),
    signatureType: num("PM_SIGNATURE_TYPE", 1),
    gamma: "https://gamma-api.polymarket.com",
    clob: "https://clob.polymarket.com",
    chainId: 137,
  },

  bf: {
    appKey: str("BF_APP_KEY"),
    username: str("BF_USERNAME"),
    password: str("BF_PASSWORD"),
    sessionToken: str("BF_SESSION_TOKEN"),
    commission: num("BF_COMMISSION", 0.05),
    eventTypes: str("BF_EVENT_TYPES", "Politics,Soccer,Tennis,Basketball,American Football,Special Bets")
      .split(",").map((s) => s.trim()).filter(Boolean),
    maxMarkets: num("BF_MAX_MARKETS", 400),
    identity: "https://identitysso.betfair.com/api/login",
    betting: "https://api.betfair.com/exchange/betting/json-rpc/v1",
  },

  stateFile: path.join(ROOT, "state.json"),
  mappingsFile: path.join(ROOT, "mappings.json"),
};
