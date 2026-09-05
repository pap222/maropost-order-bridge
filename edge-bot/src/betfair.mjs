import { config } from "./config.mjs";
import { log } from "./logger.mjs";

let session = config.bf.sessionToken || null;

export function configured() {
  return Boolean(config.bf.appKey && (session || (config.bf.username && config.bf.password)));
}

/** Interactive login (username/password). For cert login set BF_SESSION_TOKEN from your own flow. */
export async function login() {
  if (session) return session;
  const body = new URLSearchParams({ username: config.bf.username, password: config.bf.password });
  const r = await fetch(config.bf.identity, {
    method: "POST",
    headers: { "X-Application": config.bf.appKey, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  });
  const data = await r.json();
  if (data.status !== "SUCCESS") throw new Error(`Betfair login failed: ${data.error ?? JSON.stringify(data)}`);
  session = data.token;
  return session;
}

async function rpc(method, params) {
  await login();
  const r = await fetch(config.bf.betting, {
    method: "POST",
    headers: { "X-Application": config.bf.appKey, "X-Authentication": session, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify([{ jsonrpc: "2.0", method: `SportsAPING/v1.0/${method}`, params, id: 1 }]),
  });
  const [res] = await r.json();
  if (res.error) {
    if (res.error?.data?.APINGException?.errorCode === "INVALID_SESSION_INFORMATION") { session = null; }
    throw new Error(`Betfair ${method}: ${JSON.stringify(res.error)}`);
  }
  return res.result;
}

async function eventTypeIds() {
  const all = await rpc("listEventTypes", { filter: {} });
  const want = new Set(config.bf.eventTypes.map((s) => s.toLowerCase()));
  return all.filter((e) => want.has(e.eventType.name.toLowerCase())).map((e) => e.eventType.id);
}

/** Active WIN markets in the configured sports, with runners. */
export async function fetchMarkets(limit = config.bf.maxMarkets) {
  const ids = await eventTypeIds();
  if (!ids.length) return [];
  const cats = await rpc("listMarketCatalogue", {
    filter: { eventTypeIds: ids, marketTypeCodes: ["WIN", "MATCH_ODDS", "OUTRIGHT", "SPECIAL"], inPlayOnly: false },
    marketProjection: ["EVENT", "RUNNER_DESCRIPTION", "MARKET_START_TIME", "EVENT_TYPE"],
    sort: "MAXIMUM_TRADED",
    maxResults: Math.min(limit, 1000),
  });
  return cats.map((m) => ({
    venue: "betfair",
    id: m.marketId,
    question: `${m.event?.name ?? ""} - ${m.marketName}`,
    eventTitle: m.event?.name ?? "",
    eventType: m.eventType?.name,
    endDate: m.marketStartTime,
    totalMatched: m.totalMatched ?? 0,
    outcomes: (m.runners ?? []).map((r) => ({ name: r.runnerName, selectionId: r.selectionId })),
  }));
}

/** Best back/lay for every runner in the given markets. Returns Map(marketId -> Map(selectionId -> quote)). */
export async function fetchBooks(marketIds) {
  const out = new Map();
  for (let i = 0; i < marketIds.length; i += 40) {
    const books = await rpc("listMarketBook", {
      marketIds: marketIds.slice(i, i + 40),
      priceProjection: { priceData: ["EX_BEST_OFFERS"], exBestOffersOverrides: { bestPricesDepth: 1 } },
    });
    for (const b of books) {
      const m = new Map();
      for (const r of b.runners ?? []) {
        const back = r.ex?.availableToBack?.[0], lay = r.ex?.availableToLay?.[0];
        m.set(r.selectionId, {
          back: back?.price ?? null, backSize: back?.size ?? 0,
          lay: lay?.price ?? null, laySize: lay?.size ?? 0,
          status: r.status, inPlay: b.inplay, marketStatus: b.status,
        });
      }
      out.set(b.marketId, m);
    }
  }
  return out;
}

/** Place a single LIMIT order. side: "BACK" | "LAY". stake in account currency. */
export async function placeOrder({ marketId, selectionId, side, price, stake }) {
  const res = await rpc("placeOrders", {
    marketId,
    instructions: [{
      selectionId, side, orderType: "LIMIT", handicap: 0,
      limitOrder: { size: Math.round(stake * 100) / 100, price, persistenceType: "LAPSE" },
    }],
  });
  log.info("betfair placeOrders response", JSON.stringify(res));
  if (res.status !== "SUCCESS") throw new Error(`Betfair placeOrders ${res.status}: ${res.errorCode}`);
  return res;
}
