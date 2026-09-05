// Pure math: turn venue quotes into comparable "buy YES" / "sell YES" prices
// (probability space, 0..1, commission/fee adjusted), detect arbs and value bets,
// and size stakes with fractional Kelly.

/** Betfair back at decimal odds B: cost per $1 payout after commission c on net winnings. */
export function bfBuyPrice(backOdds, c) {
  if (!backOdds || backOdds <= 1) return null;
  return 1 / (1 + (backOdds - 1) * (1 - c));
}

/** Betfair lay at decimal odds L: what you effectively receive per $1 of YES exposure sold. */
export function bfSellPrice(layOdds, c) {
  if (!layOdds || layOdds <= 1) return null;
  return (1 - c) / (layOdds - c);
}

/** Polymarket: taker fee modelled as a fraction of notional. */
export const pmBuyPrice = (ask, fee) => (ask == null ? null : ask * (1 + fee));
export const pmSellPrice = (bid, fee) => (bid == null ? null : bid * (1 - fee));

/**
 * Build a unified quote for one outcome on both venues.
 * bf: { back, lay, backSize, laySize }  (odds; sizes in account currency)
 * pm: { bid, ask, bidSize, askSize, mid } (prices 0..1; sizes in USD)
 */
export function unifiedQuotes({ bf, pm, bfCommission, pmFee, gbpUsd }) {
  return {
    bf: {
      buy: bfBuyPrice(bf?.back, bfCommission),
      sell: bfSellPrice(bf?.lay, bfCommission),
      buyLiq: (bf?.backSize ?? 0) * gbpUsd,
      sellLiq: (bf?.laySize ?? 0) * gbpUsd * ((bf?.lay ?? 2) - 1), // liability capacity = capital needed to sell YES
      mid: bf?.back && bf?.lay ? (1 / bf.back + 1 / bf.lay) / 2 : null,
    },
    pm: {
      buy: pmBuyPrice(pm?.ask, pmFee),
      sell: pmSellPrice(pm?.bid, pmFee),
      buyLiq: (pm?.askSize ?? 0) * (pm?.ask ?? 0),
      sellLiq: (pm?.bidSize ?? 0) * (1 - (pm?.bid ?? 1)), // cost of the NO shares = capital needed to sell YES
      mid: pm?.mid ?? (pm?.bid != null && pm?.ask != null ? (pm.bid + pm.ask) / 2 : null),
    },
  };
}

/** Risk-free cross-venue arbitrage: buy YES cheap on one venue, sell YES dear on the other. */
export function findArbs(q, minMargin) {
  const out = [];
  if (q.pm.buy != null && q.bf.sell != null && q.bf.sell - q.pm.buy > minMargin) {
    out.push({ kind: "arb", buyVenue: "polymarket", sellVenue: "betfair", buy: q.pm.buy, sell: q.bf.sell, margin: q.bf.sell - q.pm.buy });
  }
  if (q.bf.buy != null && q.pm.sell != null && q.pm.sell - q.bf.buy > minMargin) {
    out.push({ kind: "arb", buyVenue: "betfair", sellVenue: "polymarket", buy: q.bf.buy, sell: q.pm.sell, margin: q.pm.sell - q.bf.buy });
  }
  return out;
}

/** Blended "fair" probability from both mids (Betfair usually sharper/deeper). */
export function fairProb(q, wBf) {
  const a = q.bf.mid, b = q.pm.mid;
  if (a == null && b == null) return null;
  if (a == null) return b;
  if (b == null) return a;
  return wBf * a + (1 - wBf) * b;
}

/**
 * Value bets: buy YES where price < fair - minEdge, or sell YES (lay / buy NO) where
 * price > fair + minEdge. Not risk-free; relies on the other venue being right.
 */
export function findValueBets(q, fair, minEdge) {
  if (fair == null) return [];
  const out = [];
  for (const venue of ["pm", "bf"]) {
    const v = q[venue];
    const name = venue === "pm" ? "polymarket" : "betfair";
    if (v.buy != null && fair - v.buy > minEdge) out.push({ kind: "value", side: "buy", venue: name, price: v.buy, fair, edge: fair - v.buy });
    if (v.sell != null && v.sell - fair > minEdge) out.push({ kind: "value", side: "sell", venue: name, price: v.sell, fair, edge: v.sell - fair });
  }
  return out;
}

/**
 * Fractional Kelly stake for buying a binary contract at `price` with win prob `p`.
 * Selling YES at price s is buying NO at (1-s) with prob (1-p).
 */
export function kellyStake({ p, price, bankroll, fraction, maxStake, minStake }) {
  if (price <= 0 || price >= 1) return 0;
  const b = (1 - price) / price; // net odds
  const f = (p * b - (1 - p)) / b;
  if (f <= 0) return 0;
  const stake = Math.min(maxStake, bankroll * fraction * f);
  return stake >= minStake ? round2(stake) : 0;
}

/** Arb stake: split so both legs pay out the same $1 notional; capped by liquidity on both legs. */
export function arbStake({ buy, sell, buyLiq, sellLiq, maxStake, minStake }) {
  const notional = Math.min(maxStake / buy, buyLiq / buy, sellLiq / (1 - sell)); // $ payout units
  const stake = notional * buy;
  return stake >= minStake ? round2(stake) : 0;
}

export const round2 = (x) => Math.round(x * 100) / 100;
export const toOdds = (p) => (p > 0 ? round2(1 / p) : null);
