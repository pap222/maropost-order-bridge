# edge-bot — Betfair × Polymarket edge finder

Pulls live prices for the same events from **Betfair Exchange** and **Polymarket**, converts both to
commission-adjusted probabilities, and bets when one venue is mispriced against the other.

Two kinds of opportunity:

| kind  | what it does | risk |
|-------|--------------|------|
| `arb` | buy YES on the cheap venue, sell YES (lay / buy NO) on the dear venue; margin > `MIN_ARB_MARGIN` | ~none if both legs fill; one-sided fill risk |
| `value` | one venue's price is more than `MIN_EDGE` away from the blended "fair" mid; fractional-Kelly stake | real — you're trusting the other venue's price |

**Dry-run by default.** Nothing is sent to either exchange unless `LIVE=true` **and**
`I_UNDERSTAND_THIS_BETS_REAL_MONEY=true`. Fuzzy-matched events are report-only unless
`AUTO_MATCH_TRADE=true`; put pairs you have checked by hand in `mappings.json`.

## Run

```bash
cd edge-bot
cp .env.example .env      # fill in keys
node src/index.mjs pm-markets    # list Polymarket markets (no keys needed)
node src/index.mjs bf-markets    # list Betfair markets + selectionIds (for mappings.json)
node src/index.mjs scan          # one pass
node src/index.mjs watch 60      # loop every 60s
npm test
```

Only Node ≥ 20 is required for scanning. Live Polymarket orders additionally need
`npm i @polymarket/clob-client ethers` plus `PM_PRIVATE_KEY` / `PM_FUNDER`.

## How the math works (`src/edge.mjs`)

* Betfair back at odds *B* with commission *c*: cost per $1 payout = `1 / (1 + (B-1)(1-c))`
* Betfair lay at odds *L*: effective sell price = `(1-c) / (L-c)`
* Polymarket: best ask × (1+fee) to buy, best bid × (1-fee) to sell
* Arb when `sell(venue A) - buy(venue B) > MIN_ARB_MARGIN`
* Fair prob = `FAIR_WEIGHT_BF · Betfair mid + (1-FAIR_WEIGHT_BF) · Polymarket mid`
* Stake = `KELLY_FRACTION · bankroll · (p·b - q)/b`, capped by `MAX_STAKE_USD`, book depth, and `MAX_DAILY_EXPOSURE_USD`

## Layout

```
src/index.mjs      CLI + scan loop
src/polymarket.mjs Gamma (markets) + CLOB (order book, orders)
src/betfair.mjs    login, listMarketCatalogue, listMarketBook, placeOrders
src/matcher.mjs    manual mappings + fuzzy event/runner matching
src/edge.mjs       price normalisation, arb/value detection, Kelly
src/executor.mjs   risk checks, leg construction, dry/live dispatch
src/state.mjs      state.json: cooldowns + daily exposure
```

## Caveats you should actually read

* **Jurisdiction.** Betfair Exchange and Polymarket each block many countries (Polymarket blocks the US and UK). Check what you're allowed to use.
* **Matching is the weak link.** Two markets can share a title and settle differently (dates, tie rules, "official" sources). Verify every pair before trusting it, and prefer `mappings.json`.
* **Execution risk.** Arb legs are sent sequentially; if the second leg fails you hold a naked position. The bot logs it; it does not unwind.
* **Betfair sizing** assumes an account in GBP via `GBP_USD`. Adjust for your currency. Betfair minimum stake is ~£2.
* Not investment advice. Expect to lose money while tuning thresholds.
