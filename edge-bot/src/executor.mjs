import { config } from "./config.mjs";
import { log } from "./logger.mjs";
import { state } from "./state.mjs";
import * as pm from "./polymarket.mjs";
import * as bf from "./betfair.mjs";
import { toOdds, round2 } from "./edge.mjs";

/**
 * Turn an opportunity into concrete legs, apply risk checks, and (if LIVE) send orders.
 * opp: { kind, pair, quotes, stakeUsd, ...arb/value fields }
 */
export async function execute(opp) {
  const { pair, stakeUsd } = opp;
  const key = `${pair.pm.id}:${pair.pmOutcome.tokenId}:${opp.kind}`;
  const legs = buildLegs(opp);
  const label = `${opp.kind.toUpperCase()} ${pair.pm.question} | BF ${pair.bf.question} / ${pair.bfRunner.name}`;

  if (!stakeUsd) return skip(label, "stake below minimum");
  if (pair.source === "auto" && !config.autoMatchTrade) return skip(label, "auto-matched (set AUTO_MATCH_TRADE=true or add to mappings.json)", legs);
  if (state.recentlyBet(key)) return skip(label, "cooldown");
  if (state.exposureToday() + stakeUsd > config.maxDailyExposure) return skip(label, "daily exposure cap");

  log.bet(`${config.live ? "LIVE" : "DRY "} ${label}`);
  for (const l of legs) log.bet("   ->", describeLeg(l));

  if (!config.live) { state.record({ key, live: false, stakeUsd, legs, label }); return { placed: false, legs }; }

  const results = [];
  try {
    for (const l of legs) results.push(await sendLeg(l));
    state.record({ key, live: true, stakeUsd, legs, label, results });
    return { placed: true, legs, results };
  } catch (e) {
    log.error("execution failed (check for a one-sided fill!)", e.message);
    state.record({ key, live: true, stakeUsd, legs, label, error: e.message, results });
    return { placed: false, error: e.message, legs, results };
  }
}

function buildLegs(opp) {
  const { pair, quotes, stakeUsd } = opp;
  const legs = [];
  const bfStake = round2(stakeUsd / config.gbpUsd);
  const bfRaw = pair.bfRaw, pmRaw = pair.pmRaw;
  const noToken = pair.pm.outcomes.find((o) => o.tokenId !== pair.pmOutcome.tokenId)?.tokenId;

  const pmBuyYes = () => legs.push({ venue: "polymarket", action: "BUY YES", tokenId: pair.pmOutcome.tokenId, price: pmRaw.ask, usd: stakeUsd });
  const bfBack = () => legs.push({ venue: "betfair", action: "BACK", marketId: pair.bf.id, selectionId: pair.bfRunner.selectionId, runner: pair.bfRunner.name, price: bfRaw.back, stake: bfStake });
  // "Sell YES" legs, sized for `notionalUsd` of $1-payout contracts: the leg must LOSE notional*(1-sell) if YES.
  const pmBuyNo = (notionalUsd) => legs.push({ venue: "polymarket", action: "BUY NO", tokenId: noToken, price: round2(1 - pmRaw.bid), usd: round2(notionalUsd * (1 - quotes.pm.sell)) });
  const bfLay = (notionalUsd) => {
    const liabilityUsd = notionalUsd * (1 - quotes.bf.sell);
    legs.push({ venue: "betfair", action: "LAY", marketId: pair.bf.id, selectionId: pair.bfRunner.selectionId, runner: pair.bfRunner.name, price: bfRaw.lay, stake: round2(liabilityUsd / config.gbpUsd / (bfRaw.lay - 1)) });
  };

  if (opp.kind === "arb") {
    // Buy leg costs stakeUsd at effective price `buy`, i.e. stakeUsd/buy contracts; hedge the same notional.
    if (opp.buyVenue === "polymarket") { pmBuyYes(); bfLay(stakeUsd / quotes.pm.buy); } else { bfBack(); pmBuyNo(stakeUsd / quotes.bf.buy); }
  } else if (opp.side === "buy") {
    opp.venue === "polymarket" ? pmBuyYes() : bfBack();
  } else {
    // Value "sell": spend stakeUsd on the sell side.
    opp.venue === "polymarket" ? pmBuyNo(stakeUsd / (1 - quotes.pm.sell)) : legs.push({ venue: "betfair", action: "LAY", marketId: pair.bf.id, selectionId: pair.bfRunner.selectionId, runner: pair.bfRunner.name, price: bfRaw.lay, stake: round2(bfStake / (bfRaw.lay - 1)) });
  }
  return legs;
}

async function sendLeg(l) {
  if (l.venue === "polymarket") return pm.placeOrder({ tokenId: l.tokenId, side: "buy", price: l.price, usd: l.usd });
  return bf.placeOrder({ marketId: l.marketId, selectionId: l.selectionId, side: l.action, price: l.price, stake: l.stake });
}

function describeLeg(l) {
  return l.venue === "polymarket"
    ? `Polymarket ${l.action} @ ${l.price} (${toOdds(l.price)}) for $${l.usd}`
    : `Betfair ${l.action} ${l.runner} @ ${l.price} stake ${l.stake}`;
}

function skip(label, why, legs) {
  log.info(`skip  ${label} :: ${why}`);
  if (legs) for (const l of legs) log.info("       (would be)", describeLeg(l));
  return { placed: false, skipped: why };
}
