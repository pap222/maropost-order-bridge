import { test } from "node:test";
import assert from "node:assert/strict";
import { bfBuyPrice, bfSellPrice, unifiedQuotes, findArbs, findValueBets, fairProb, kellyStake, arbStake } from "../src/edge.mjs";
import { similarity, matchMarkets } from "../src/matcher.mjs";

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("betfair effective prices reduce to 1/odds with zero commission", () => {
  close(bfBuyPrice(4, 0), 0.25);
  close(bfSellPrice(4, 0), 0.25);
  assert.ok(bfBuyPrice(4, 0.05) > 0.25, "commission makes backing dearer");
  assert.ok(bfSellPrice(4, 0.05) < 0.25, "commission makes laying cheaper");
  assert.equal(bfBuyPrice(null, 0.05), null);
});

test("arb detected when Polymarket ask is below Betfair lay price", () => {
  const q = unifiedQuotes({ bf: { back: 2.1, lay: 2.2, backSize: 100, laySize: 100 }, pm: { bid: 0.35, ask: 0.36, bidSize: 500, askSize: 500 }, bfCommission: 0.05, pmFee: 0, gbpUsd: 1.27 });
  const arbs = findArbs(q, 0.01);
  assert.equal(arbs.length, 1);
  assert.equal(arbs[0].buyVenue, "polymarket");
  assert.ok(arbs[0].margin > 0.05);
});

test("no arb when prices agree", () => {
  const q = unifiedQuotes({ bf: { back: 2.0, lay: 2.04, backSize: 100, laySize: 100 }, pm: { bid: 0.49, ask: 0.51, bidSize: 500, askSize: 500 }, bfCommission: 0.05, pmFee: 0, gbpUsd: 1.27 });
  assert.deepEqual(findArbs(q, 0.01), []);
});

test("value bet: buy on the cheap venue when fair prob exceeds price by min edge", () => {
  const q = unifiedQuotes({ bf: { back: 1.9, lay: 1.92, backSize: 100, laySize: 100 }, pm: { bid: 0.44, ask: 0.45, bidSize: 500, askSize: 500 }, bfCommission: 0.05, pmFee: 0, gbpUsd: 1.27 });
  const fair = fairProb(q, 0.7);
  const bets = findValueBets(q, fair, 0.04);
  assert.ok(bets.some((b) => b.venue === "polymarket" && b.side === "buy"));
});

test("kelly sizing", () => {
  assert.equal(kellyStake({ p: 0.5, price: 0.5, bankroll: 1000, fraction: 0.25, maxStake: 50, minStake: 2 }), 0);
  const s = kellyStake({ p: 0.6, price: 0.5, bankroll: 1000, fraction: 0.25, maxStake: 1000, minStake: 2 });
  close(s, 50); // full kelly 0.2 * 1000 * 0.25
  assert.equal(kellyStake({ p: 0.9, price: 0.5, bankroll: 1000, fraction: 1, maxStake: 50, minStake: 2 }), 50);
});

test("arb stake is capped by liquidity on both legs", () => {
  assert.equal(arbStake({ buy: 0.4, sell: 0.5, buyLiq: 1000, sellLiq: 1000, maxStake: 40, minStake: 2 }), 40);
  assert.equal(arbStake({ buy: 0.4, sell: 0.5, buyLiq: 8, sellLiq: 1000, maxStake: 40, minStake: 2 }), 8);
  assert.equal(arbStake({ buy: 0.4, sell: 0.5, buyLiq: 1000, sellLiq: 5, maxStake: 40, minStake: 2 }), 4);
});

test("similarity handles aliases and noise", () => {
  assert.ok(similarity("Will Manchester United win the Premier League?", "Man Utd - Premier League Winner") > 0.6);
  assert.ok(similarity("Will Bitcoin hit 100k?", "Wimbledon Men's Singles") < 0.2);
});

test("matchMarkets pairs binary Polymarket YES with the named Betfair runner", () => {
  const pm = [{ id: "c1", slug: "will-arsenal-win-the-premier-league", question: "Will Arsenal win the Premier League?", eventTitle: "Premier League Winner", endDate: "2026-05-24T00:00:00Z",
    outcomes: [{ name: "Yes", tokenId: "t1" }, { name: "No", tokenId: "t2" }] }];
  const bf = [{ id: "1.1", question: "English Premier League - Winner", eventTitle: "English Premier League", endDate: "2026-05-24T00:00:00Z",
    outcomes: [{ name: "Arsenal", selectionId: 1 }, { name: "Liverpool", selectionId: 2 }] }];
  const pairs = matchMarkets(pm, bf, 0.4);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].bfRunner.name, "Arsenal");
  assert.equal(pairs[0].pmOutcome.name, "Yes");
  assert.equal(pairs[0].source, "auto");
});
