"""Command line entry point.

  python -m tennis_scalper backtest --sim 2000 --tour wta
  python -m tennis_scalper backtest --pbp data/pbp_matches_wta_main_current.csv --odds data/2024.csv
  python -m tennis_scalper first-touch --sim 5000
  python -m tennis_scalper scan-players --pbp ... --odds ...
  python -m tennis_scalper download data/
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from .backtest import Backtester, trades_to_dicts
from .data import OddsIndex, download_sackmann, load_sackmann, write_csv
from .pricing import MarketModel
from .simulate import simulate_matches
from .stats import first_touch_table, fmt_table, player_scan, summarize
from .strategies import DEFAULT_RULES, rules_by_name


def _common(p: argparse.ArgumentParser) -> None:
    p.add_argument("--sim", type=int, default=0, help="simulate N matches instead of loading data")
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--tour", default="wta", choices=["atp", "wta"])
    p.add_argument("--best-of", type=int, default=3)
    p.add_argument("--pbp", nargs="*", type=Path, default=[], help="Sackmann pbp csv files")
    p.add_argument("--odds", nargs="*", type=Path, default=[], help="tennis-data.co.uk yearly files")
    p.add_argument("--book", default="Avg", help="odds column prefix: Avg, PS (Pinnacle), B365, Max")
    p.add_argument("--default-p-a", type=float, default=None, help="use this P(server1 wins) when no odds match")
    p.add_argument("--spread", type=float, default=0.01, help="half-spread in $")
    p.add_argument("--slippage", type=float, default=0.0)
    p.add_argument("--fee-rate", type=float, default=0.0, help="taker fee rate (0 = maker / no fee)")
    p.add_argument("--fee-shape", default="p_1mp", choices=["p_1mp", "min_p", "flat"])
    p.add_argument("--overreaction", type=float, default=0.0, help="k: market moves (1+k)x fair")
    p.add_argument("--stake", type=float, default=100.0)
    p.add_argument("--out", type=Path, default=None, help="directory for csv/json output")


def _load(args) -> list:
    if args.sim:
        return simulate_matches(args.sim, args.seed, args.tour, args.best_of)
    if not args.pbp:
        raise SystemExit("give --sim N or --pbp files")
    odds = OddsIndex.from_tennis_data(args.odds, args.book) if args.odds else None
    recs, diag = load_sackmann(args.pbp, odds, args.default_p_a, tour_filter=None)
    print("load:", json.dumps(diag))
    return recs


def _market(args) -> MarketModel:
    return MarketModel(half_spread=args.spread, slippage=args.slippage, fee_rate=args.fee_rate,
                       fee_shape=args.fee_shape, overreaction=args.overreaction)


def cmd_backtest(args) -> None:
    matches = _load(args)
    rules = rules_by_name(args.rules) if args.rules else DEFAULT_RULES
    bt = Backtester(_market(args), rules, args.stake)
    trades, summaries = bt.run(matches)
    print(f"\nmatches: {len(matches)}   stake/trade: ${args.stake:.0f}   market: {_market(args)}\n")
    rows = []
    for r in rules:
        s = summarize([t for t in trades if t.rule == r.name], args.stake)
        s = {"rule": r.name, **{k: v for k, v in s.items() if k != "exit_reasons"}}
        rows.append(s)
    print(fmt_table(rows))
    print("\nexit reasons:")
    for r in rules:
        s = summarize([t for t in trades if t.rule == r.name], args.stake)
        print(f"  {r.name:28s} {s.get('exit_reasons', {})}")
    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)
        write_csv(trades_to_dicts(trades), args.out / "trades.csv")
        write_csv(summaries, args.out / "matches.csv")
        (args.out / "summary.json").write_text(json.dumps(rows, indent=2))
        print(f"\nwrote {args.out}/trades.csv, matches.csv, summary.json")


def cmd_first_touch(args) -> None:
    matches = _load(args)
    bt = Backtester(_market(args), [], args.stake)
    _, summaries = bt.run(matches)
    print(f"\nSet-1 first-touch base rates ({len(matches)} matches, overreaction={args.overreaction}):\n")
    print(fmt_table(first_touch_table(summaries)))
    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)
        write_csv(first_touch_table(summaries), args.out / "first_touch.csv")


def cmd_scan(args) -> None:
    matches = _load(args)
    bt = Backtester(_market(args), [], args.stake)
    _, summaries = bt.run(matches)
    rows = player_scan(summaries, args.min_matches)[: args.top]
    print(f"\nFavourites who go down an early break and still win (top {args.top}):\n")
    print(fmt_table(rows))
    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)
        write_csv(rows, args.out / "player_scan.csv")


def cmd_download(args) -> None:
    for p in download_sackmann(args.dest):
        print("ok", p)


def main(argv=None) -> None:
    ap = argparse.ArgumentParser(prog="tennis_scalper")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("backtest"); _common(b)
    b.add_argument("--rules", nargs="*", default=None, help=f"subset of: {[r.name for r in DEFAULT_RULES]}")
    b.set_defaults(fn=cmd_backtest)
    f = sub.add_parser("first-touch"); _common(f); f.set_defaults(fn=cmd_first_touch)
    s = sub.add_parser("scan-players"); _common(s)
    s.add_argument("--min-matches", type=int, default=5); s.add_argument("--top", type=int, default=30)
    s.set_defaults(fn=cmd_scan)
    d = sub.add_parser("download"); d.add_argument("dest", type=Path); d.set_defaults(fn=cmd_download)
    args = ap.parse_args(argv)
    args.fn(args)


if __name__ == "__main__":
    main()
