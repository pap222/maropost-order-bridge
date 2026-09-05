import { config } from "./config.mjs";
import { log } from "./logger.mjs";

const j = async (url) => {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`${url} -> ${r.status} ${await r.text()}`);
  return r.json();
};
const parse = (v) => (typeof v === "string" ? JSON.parse(v) : v ?? []);

/** Active Polymarket markets, one row per market, with outcome/token pairs. */
export async function fetchMarkets(limit = config.pm.maxMarkets) {
  const out = [];
  for (let offset = 0; out.length < limit; offset += 100) {
    const page = await j(`${config.pm.gamma}/markets?active=true&closed=false&archived=false&limit=100&offset=${offset}&order=volume24hr&ascending=false`);
    if (!page.length) break;
    for (const m of page) {
      const outcomes = parse(m.outcomes), tokens = parse(m.clobTokenIds), prices = parse(m.outcomePrices).map(Number);
      if (!tokens.length || outcomes.length !== tokens.length) continue;
      out.push({
        venue: "polymarket",
        id: m.conditionId,
        slug: m.slug,
        question: m.question,
        eventTitle: m.events?.[0]?.title ?? m.groupItemTitle ?? "",
        endDate: m.endDate,
        volume24h: Number(m.volume24hr ?? 0),
        liquidity: Number(m.liquidityNum ?? m.liquidity ?? 0),
        outcomes: outcomes.map((name, i) => ({ name, tokenId: tokens[i], lastPrice: prices[i] })),
      });
    }
    if (page.length < 100) break;
  }
  return out.slice(0, limit);
}

/** Top of book for one token: best bid/ask and size at that level, plus midpoint. */
export async function fetchQuote(tokenId) {
  const book = await j(`${config.pm.clob}/book?token_id=${tokenId}`);
  const best = (levels, pick) => {
    if (!levels?.length) return null;
    return levels.map((l) => ({ price: Number(l.price), size: Number(l.size) })).reduce((a, b) => (pick(a.price, b.price) ? a : b));
  };
  const bid = best(book.bids, (a, b) => a >= b);
  const ask = best(book.asks, (a, b) => a <= b);
  return {
    bid: bid?.price ?? null, bidSize: bid?.size ?? 0,
    ask: ask?.price ?? null, askSize: ask?.size ?? 0,
    mid: bid && ask ? (bid.price + ask.price) / 2 : null,
  };
}

let client;
async function clobClient() {
  if (client) return client;
  if (!config.pm.privateKey || !config.pm.funder) throw new Error("PM_PRIVATE_KEY and PM_FUNDER required for live Polymarket orders");
  let ClobClient, Side, OrderType, Wallet;
  try {
    ({ ClobClient, Side, OrderType } = await import("@polymarket/clob-client"));
    ({ Wallet } = await import("ethers"));
  } catch {
    throw new Error("Live Polymarket orders need: npm i @polymarket/clob-client ethers");
  }
  const signer = new Wallet(config.pm.privateKey);
  const tmp = new ClobClient(config.pm.clob, config.pm.chainId, signer);
  const creds = await tmp.createOrDeriveApiKey();
  client = new ClobClient(config.pm.clob, config.pm.chainId, signer, creds, config.pm.signatureType, config.pm.funder);
  client._enums = { Side, OrderType };
  return client;
}

/**
 * Place a marketable limit order (FOK) for `usd` notional at `price` on `tokenId`.
 * side: "buy" (buy YES) or "sell" (sell YES you hold; for a fresh position, callers buy the NO token instead).
 */
export async function placeOrder({ tokenId, side, price, usd }) {
  const c = await clobClient();
  const { Side, OrderType } = c._enums;
  const size = Math.floor((usd / price) * 100) / 100; // shares
  const order = await c.createOrder({ tokenID: tokenId, price, size, side: side === "buy" ? Side.BUY : Side.SELL });
  const res = await c.postOrder(order, OrderType.FOK);
  log.info("polymarket order response", JSON.stringify(res));
  return res;
}
