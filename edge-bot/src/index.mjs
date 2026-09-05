#!/usr/bin/env node
import { config } from "./config.mjs";
import { log } from "./logger.mjs";
import * as pm from "./polymarket.mjs";
import * as bf from "./betfair.mjs";
import { matchMarkets } from "./matcher.mjs";
import { unifiedQuotes, findArbs, findValueBets, fairProb, kellyStake, arbStake, toOdds } from "./edge.mjs";
import { execute } from "./executor.mjs";

const cmd = process.argv[2] ?? "scan";
const intervalSec = Number(process.argv[3] ?? 60);

async function scan() {
  log.info(`scan start (${config.live ? "LIVE" : "DRY-RUN"}; auto-match trading ${config.autoMatchTrade ? "on" : "off"})`);
  const pmMarkets = await pm.fetchMarkets();
  log.info(`polymarket: ${pmMarkets.length} markets`);
  if (!bf.configured()) { log.warn("Betfair not configured (BF_APP_KEY + BF_USERNAME/BF_PASSWORD or BF_SESSION_TOKEN); nothing to compare against"); return []; }
  const bfMarkets = await bf.fetchMarkets();
  log.info(`betfair: ${bfMarkets.length} markets`);

  const pairs = matchMarkets(pmMarkets, bfMarkets);
  log.info(`matched ${pairs.length} outcome pairs (${pairs.filter((p) => p.source === "manual").length} manual)`);
  if (!pairs.length) return [];

  const books = await bf.fetchBooks([...new Set(pairs.map((p) => p.bf.id))]);
  const opps = [];
  for (const pair of pairs) {
    const bfRaw = books.get(pair.bf.id)?.get(pair.bfRunner.selectionId);
    if (!bfRaw || bfRaw.status !== "ACTIVE" || bfRaw.marketStatus !== "OPEN") continue;
    let pmRaw;
    try { pmRaw = await pm.fetchQuote(pair.pmOutcome.tokenId); } catch (e) { log.warn("pm quote failed", pair.pm.slug, e.message); continue; }
    pair.bfRaw = bfRaw; pair.pmRaw = pmRaw;

    const q = unifiedQuotes({ bf: bfRaw, pm: pmRaw, bfCommission: config.bf.commission, pmFee: config.pm.fee, gbpUsd: config.gbpUsd });
    const fair = fairProb(q, config.fairWeightBf);
    log.info(`${pad(pair.pm.question, 60)} | PM ${fmt(q.pm.buy)}/${fmt(q.pm.sell)} | BF ${fmt(q.bf.buy)}/${fmt(q.bf.sell)} (${bfRaw.back}/${bfRaw.lay}) | fair ${fmt(fair)} | ${pair.source} ${pair.score.toFixed(2)}`);

    for (const a of findArbs(q, config.minArbMargin)) {
      const buyLiq = a.buyVenue === "polymarket" ? q.pm.buyLiq : q.bf.buyLiq;
      const sellLiq = a.sellVenue === "polymarket" ? q.pm.sellLiq : q.bf.sellLiq;
      if (Math.min(buyLiq, sellLiq) < config.minLiquidity) continue;
      const stakeUsd = arbStake({ ...a, buyLiq, sellLiq, maxStake: config.maxStake, minStake: config.minStake });
      opps.push({ ...a, pair, quotes: q, stakeUsd, note: `margin ${(a.margin * 100).toFixed(1)}%` });
    }
    for (const v of findValueBets(q, fair, config.minEdge)) {
      const liq = v.side === "buy" ? q[v.venue === "polymarket" ? "pm" : "bf"].buyLiq : q[v.venue === "polymarket" ? "pm" : "bf"].sellLiq;
      if (liq < config.minLiquidity) continue;
      const p = v.side === "buy" ? fair : 1 - fair, price = v.side === "buy" ? v.price : 1 - v.price;
      const stakeUsd = kellyStake({ p, price, bankroll: config.bankroll, fraction: config.kellyFraction, maxStake: config.maxStake, minStake: config.minStake });
      opps.push({ ...v, pair, quotes: q, stakeUsd, note: `edge ${(v.edge * 100).toFixed(1)} pts vs fair ${fmt(fair)} (${toOdds(fair)})` });
    }
  }

  // Arbs first (risk-free), then biggest edges.
  opps.sort((a, b) => (a.kind === b.kind ? (b.margin ?? b.edge) - (a.margin ?? a.edge) : a.kind === "arb" ? -1 : 1));
  log.info(`${opps.length} opportunities`);
  for (const o of opps) await execute(o);
  return opps;
}

const fmt = (x) => (x == null ? "  -  " : x.toFixed(3));
const pad = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));

async function main() {
  if (cmd === "pm-markets") {
    for (const m of await pm.fetchMarkets()) console.log(m.slug, "|", m.question, "|", m.outcomes.map((o) => `${o.name}=${o.lastPrice}`).join(", "));
  } else if (cmd === "bf-markets") {
    for (const m of await bf.fetchMarkets()) console.log(m.id, "|", m.question, "|", m.outcomes.map((o) => `${o.name}#${o.selectionId}`).join(", "));
  } else if (cmd === "scan") {
    await scan();
  } else if (cmd === "watch") {
    for (;;) {
      try { await scan(); } catch (e) { log.error(e.stack ?? e.message); }
      await new Promise((r) => setTimeout(r, intervalSec * 1000));
    }
  } else {
    console.log("usage: node src/index.mjs [scan|watch [seconds]|pm-markets|bf-markets]");
  }
}
main().catch((e) => { log.error(e.stack ?? e.message); process.exit(1); });
