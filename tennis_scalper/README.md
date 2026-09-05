# tennis_scalper

Research kit for the "buy the underdog cheap, sell the early spike, never hold to
settlement" tennis strategy.  Pure Python 3.11, no required dependencies.

```
cd tennis_scalper
python -m pytest -q                              # 13 tests
python -m tennis_scalper backtest --sim 3000     # runs today, no data needed
python -m tennis_scalper first-touch --sim 5000  # P(+15c before -10c) by entry price
python -m tennis_scalper scan-players --pbp data/pbp_matches_wta_main_current.csv --odds data/2024.csv
```

## What it does

| module | role |
|---|---|
| `markov.py` | point → game → tiebreak → set → match win probability from any live score; `calibrate()` maps a pre-match implied probability onto serve-point probabilities |
| `match.py` | scoring state machine that emits `hold / break / break_point / set / match` events; parses Sackmann point-by-point strings |
| `pricing.py` | spread, slippage, Polymarket-style fee (`rate·p·(1−p)·shares`, configurable), and a transient-overreaction knob |
| `strategies.py` | Rules A–E from the plan plus a hold-to-settlement control |
| `backtest.py` | prices the underdog contract after every point and executes rules against bid/ask |
| `stats.py` | win rate, avg winner/loser, expectancy, drawdown, first-touch tables, favourite scan |
| `data.py` | loaders for Sackmann pbp CSVs and tennis-data.co.uk odds, joined by date + surname |
| `simulate.py` | synthetic matches from the same Markov chain (a *fair* market) |
| `live/recorder.py` | records Polymarket tennis order books (bid/ask + depth at 1/3/5c) to JSONL |
| `live/paper.py` | paper trader applying a Rule to a live price + score stream |

## Rules

| name | entry | exit |
|---|---|---|
| `A_prematch_sell_on_break` | underdog ask 30–45c before first point | first underdog break, or +15c / −10c, or end of set 1 |
| `A2_prematch_tp15_sl10` / `A3_…tp25` | same | +15c (+25c) / −10c / end of set 1 |
| `B_strong_server` | as A, only if underdog's historical hold % ≥ 70 (rolling, prior matches only) | as A |
| `C_after_underdog_hold` | after underdog holds first service game, no favourite break yet | first underdog break / +15 / −10 |
| `D_after_0_30` | underdog reaches 0-30 on favourite's serve | +12 / −8 |
| `D2_break_point` | underdog earns first break point | +12 / −8 |
| `E_external_edge` | bookmaker live prob − market ask ≥ 3c (needs per-point external feed) | +10 / −8 |
| `X_hold_to_settlement` | as A | never (control) |

Add your own in `strategies.py`; a `Rule` is a frozen dataclass.

## Results on the fair simulator (3000 WTA matches, 1c half-spread, no fees)

| rule | trades | win rate | avg win | avg loss | expectancy |
|---|---|---|---|---|---|
| A sell on break | 1452 | 42.6% | +9.9c | −10.6c | −5.2% |
| A2 +15/−10 | 1452 | 34.0% | +15.8c | −11.2c | −5.5% |
| D2 break point | 1392 | 30.7% | +12.7c | −8.8c | −5.5% |
| X hold to settlement | 1452 | 35.8% | +61.8c | −37.4c | −4.8% |

First-touch base rates in set 1 (5000 matches): P(+15c before −10c) is 22–28%
for every entry bin from 20c to 50c.  P(−10c first) is 72–78%.

**These are the numbers you get when the market is exactly right.**  The simulator
and the pricer share one model, so every rule's pre-cost expectancy is ~0 and the
−5% is spread plus noise.  That is the point: it shows the strategy has *no
mechanical edge*.  A break moves the price by roughly what it should, and stops get
hit far more often than targets because the underdog is usually the one getting broken.

Two things follow directly from the model:

1. **A +30c spike inside set 1 is impossible at fair value in a best-of-3.**  A 42c
   underdog who wins set 1 is worth ~68c; a 47c underdog ~72c.  The screenshots
   (41.7→69, 34.7→61, 42.4→80) therefore came either from set 2 or from a market
   that overshot.  If Polymarket prints those numbers regularly, *that overshoot is
   the whole edge*, and it can only be measured on real order books.
2. The edge, if it exists, is **transient overreaction + thin books**, not tennis.
   `--overreaction k` models the market overshooting a break/set jump by `k` and
   decaying back over 4 points.  A permanent mis-scaling of the price is still a
   martingale and cannot be traded; only reverting jumps can.

## Real data

No network was available in the build environment, so the loaders are untested
against live files.  Download yourself:

```
python -m tennis_scalper download data/            # Sackmann pbp CSVs (GitHub)
# odds: http://www.tennis-data.co.uk  -> data/2023.xlsx, data/2024.xlsx (or export to csv)
python -m tennis_scalper backtest --pbp data/pbp_matches_wta_main_current.csv --odds data/2024.csv --book PS --out out/
python -m tennis_scalper scan-players --pbp data/pbp_matches_wta_main_current.csv --odds data/2024.csv --top 30
```

`load_sackmann` replays every match and drops any whose replayed winner disagrees
with the file (format-drift guard); diagnostics are printed.  Odds are de-vigged
Pinnacle (`--book PS`) or the market average (`Avg`).  Matches with no odds match
are dropped unless `--default-p-a` is given.

`scan-players` ranks favourites by how often they go down an early break and still
win: the players whose opponents' contracts spike and then die.

## Paper trading on Polymarket

```
pip install requests
python -m tennis_scalper.live.recorder --out data/live --interval 2
```

Records every open tennis outcome token: best bid/ask and USD depth within 1/3/5c
of the touch.  That answers the question the screenshots can't: how much could
actually be sold at 69c.  To run rules live you also need a score feed
(`live.recorder.ScoreFeed` protocol); wire one in and hand ticks to
`live.paper.PaperTrader.on_tick`.

**Fees:** set `--fee-rate` / `--fee-shape` from the current Polymarket sports fee
schedule before trusting any P&L.  Default is 0 (maker / rebate case).

## Suggested next steps

1. Run the recorder through one full tournament week; measure realised spike size
   after breaks vs the Markov fair move (`price_path`) — that number *is* the edge.
2. Feed the real odds + pbp files through `first-touch` and `scan-players`.
3. Only then size live trades ($10–25) with resting limit orders at the target.
