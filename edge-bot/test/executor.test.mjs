import { test } from "node:test";
import assert from "node:assert/strict";
import { execute } from "../src/executor.mjs";
import { unifiedQuotes, findArbs, arbStake } from "../src/edge.mjs";
import { config } from "../src/config.mjs";
import fs from "node:fs";

const GBP = config.gbpUsd, C = config.bf.commission;
const mkPair = (bfRaw, pmRaw) => ({ source: "manual", score: 1, bfRaw, pmRaw,
  pm: { id: "c" + Math.random(), slug: "s", question: "Will Arsenal win?", outcomes: [{ name: "Yes", tokenId: "t1" }, { name: "No", tokenId: "t2" }] },
  pmOutcome: { name: "Yes", tokenId: "t1" }, bf: { id: "1.1", question: "EPL - Winner" }, bfRunner: { name: "Arsenal", selectionId: 1 } });

/** P&L in USD of a leg list if the outcome is YES / NO. */
function pnl(legs, yes) {
  let t = 0;
  for (const l of legs) {
    if (l.venue === "polymarket") {
      const shares = l.usd / l.price, win = l.action === "BUY YES" ? yes : !yes;
      t += win ? shares - l.usd : -l.usd;
    } else if (l.action === "BACK") {
      t += (yes ? l.stake * (l.price - 1) * (1 - C) : -l.stake) * GBP;
    } else {
      t += (yes ? -l.stake * (l.price - 1) : l.stake * (1 - C)) * GBP;
    }
  }
  return t;
}

async function runArb(bfRaw, pmRaw) {
  const q = unifiedQuotes({ bf: bfRaw, pm: pmRaw, bfCommission: C, pmFee: config.pm.fee, gbpUsd: GBP });
  const [a] = findArbs(q, 0.005);
  assert.ok(a, "expected an arb");
  const buyLiq = a.buyVenue === "polymarket" ? q.pm.buyLiq : q.bf.buyLiq, sellLiq = a.sellVenue === "polymarket" ? q.pm.sellLiq : q.bf.sellLiq;
  const stakeUsd = arbStake({ ...a, buyLiq, sellLiq, maxStake: 50, minStake: 2 });
  const r = await execute({ ...a, pair: mkPair(bfRaw, pmRaw), quotes: q, stakeUsd });
  return { a, r, stakeUsd };
}

test.after(() => { try { fs.unlinkSync(config.stateFile); } catch {} });

test("arb legs (buy PM, lay BF) are hedged: same positive P&L either way", async () => {
  const { a, r } = await runArb({ back: 2.1, lay: 2.2, backSize: 100, laySize: 100 }, { bid: 0.35, ask: 0.36, bidSize: 500, askSize: 500 });
  assert.equal(a.buyVenue, "polymarket");
  const y = pnl(r.legs, true), n = pnl(r.legs, false);
  assert.ok(y > 0 && n > 0, `both outcomes profitable: ${y} ${n}`);
  assert.ok(Math.abs(y - n) < 0.5, `balanced within rounding: ${y} vs ${n}`);
});

test("arb legs (back BF, buy NO on PM) are hedged", async () => {
  const { a, r } = await runArb({ back: 3.0, lay: 3.1, backSize: 100, laySize: 100 }, { bid: 0.42, ask: 0.43, bidSize: 500, askSize: 500 });
  assert.equal(a.buyVenue, "betfair");
  const y = pnl(r.legs, true), n = pnl(r.legs, false);
  assert.ok(y > 0 && n > 0, `both outcomes profitable: ${y} ${n}`);
  assert.ok(Math.abs(y - n) < 0.5, `balanced within rounding: ${y} vs ${n}`);
});

test("auto-matched pairs are not traded unless AUTO_MATCH_TRADE", async () => {
  const bfRaw = { back: 2.1, lay: 2.2, backSize: 100, laySize: 100 }, pmRaw = { bid: 0.35, ask: 0.36, bidSize: 500, askSize: 500 };
  const q = unifiedQuotes({ bf: bfRaw, pm: pmRaw, bfCommission: C, pmFee: 0, gbpUsd: GBP });
  const [a] = findArbs(q, 0.01);
  const r = await execute({ ...a, pair: { ...mkPair(bfRaw, pmRaw), source: "auto" }, quotes: q, stakeUsd: 10 });
  assert.match(r.skipped, /auto-matched/);
});
