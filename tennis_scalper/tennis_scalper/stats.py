"""Summary statistics for trade logs and match summaries."""
from __future__ import annotations

from collections import defaultdict
from typing import Iterable

from .backtest import Trade


def summarize(trades: list[Trade], stake: float) -> dict:
    if not trades:
        return {"trades": 0}
    pnls = [t.pnl for t in trades]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p <= 0]
    cents_w = [t.pnl_cents for t in trades if t.pnl_cents > 0]
    cents_l = [t.pnl_cents for t in trades if t.pnl_cents <= 0]
    eq, peak, mdd = 0.0, 0.0, 0.0
    for p in pnls:
        eq += p
        peak = max(peak, eq)
        mdd = min(mdd, eq - peak)
    gross_w = sum(wins)
    gross_l = -sum(losses)
    reasons = defaultdict(int)
    for t in trades:
        reasons[t.exit_reason] += 1
    return {
        "trades": len(trades),
        "win_rate": round(len(wins) / len(trades), 4),
        "avg_winner_cents": round(100 * sum(cents_w) / len(cents_w), 2) if cents_w else 0.0,
        "avg_loser_cents": round(100 * sum(cents_l) / len(cents_l), 2) if cents_l else 0.0,
        "expectancy_per_trade_$": round(sum(pnls) / len(trades), 3),
        "expectancy_pct_of_stake": round(100 * sum(pnls) / len(trades) / stake, 3),
        "total_pnl_$": round(sum(pnls), 2),
        "fees_$": round(sum(t.fees for t in trades), 2),
        "profit_factor": round(gross_w / gross_l, 3) if gross_l > 0 else float("inf"),
        "max_drawdown_$": round(mdd, 2),
        "avg_holding_points": round(sum(t.holding_points for t in trades) / len(trades), 1),
        "underdog_won_pct": round(sum(t.underdog_won for t in trades) / len(trades), 4),
        "exit_reasons": dict(reasons),
    }


def first_touch_table(summaries: Iterable[dict], targets=(0.10, 0.15, 0.20, 0.30), stops=(0.08, 0.10, 0.12),
                      bins=((0.20, 0.25), (0.25, 0.30), (0.30, 0.35), (0.35, 0.40), (0.40, 0.45), (0.45, 0.50))) -> list[dict]:
    """P(price reaches entry+target before entry-stop within set 1), by entry-price bin.

    Uses per-match max/min bid in set 1.  This is the real question:
    "does 40c go to 55c before it goes to 30c?"  NOTE: with max/min only we can't
    order the touches, so a match where both levels were hit counts as ambiguous;
    the engine's trade log resolves ordering exactly - this table is the quick view.
    """
    rows = []
    S = list(summaries)
    for lo, hi in bins:
        ms = [m for m in S if lo <= m["entry_ask"] < hi]
        if not ms:
            continue
        row = {"entry_bin": f"{int(lo*100)}-{int(hi*100)}c", "n": len(ms),
               "underdog_win_pct": round(100 * sum(not m["fav_won"] for m in ms) / len(ms), 1),
               "avg_spike_set1_c": round(100 * sum(m["spike_set1"] for m in ms) / len(ms), 1)}
        for tg in targets:
            hit = sum(m["max_bid_set1"] >= m["entry_ask"] + tg for m in ms)
            row[f"hit_+{int(tg*100)}c"] = round(100 * hit / len(ms), 1)
        for stp in stops:
            hit = sum(m["min_bid_set1"] <= m["entry_ask"] - stp for m in ms)
            row[f"hit_-{int(stp*100)}c"] = round(100 * hit / len(ms), 1)
        for tg in targets:
            for stp in stops:
                clean = sum((m["max_bid_set1"] >= m["entry_ask"] + tg) and (m["min_bid_set1"] > m["entry_ask"] - stp) for m in ms)
                row[f"+{int(tg*100)}_before_-{int(stp*100)}"] = round(100 * clean / len(ms), 1)
        rows.append(row)
    return rows


def player_scan(summaries: Iterable[dict], min_matches: int = 5) -> list[dict]:
    """Favourites who go down an early break yet still win: the ideal targets to fade."""
    by = defaultdict(list)
    for m in summaries:
        by[m["favourite"]].append(m)
    rows = []
    for name, ms in by.items():
        if len(ms) < min_matches:
            continue
        down = [m for m in ms if m["fav_down_break_set1"]]
        rows.append({
            "favourite": name, "matches_as_fav": len(ms),
            "fav_win_pct": round(100 * sum(m["fav_won"] for m in ms) / len(ms), 1),
            "down_break_set1_pct": round(100 * len(down) / len(ms), 1),
            "won_after_down_break_pct": round(100 * sum(m["fav_won"] for m in down) / len(down), 1) if down else None,
            "ud_broke_first_pct": round(100 * sum(m["ud_broke_first"] for m in ms) / len(ms), 1),
            "avg_ud_spike_set1_c": round(100 * sum(m["spike_set1"] for m in ms) / len(ms), 1),
            "avg_p_underdog": round(sum(m["p_underdog"] for m in ms) / len(ms), 3),
        })
    rows.sort(key=lambda r: (r["down_break_set1_pct"] * (r["won_after_down_break_pct"] or 0)), reverse=True)
    return rows


def fmt_table(rows: list[dict]) -> str:
    if not rows:
        return "(no rows)"
    cols = list(rows[0].keys())
    w = {c: max(len(c), *(len(str(r.get(c, ""))) for r in rows)) for c in cols}
    line = " | ".join(c.ljust(w[c]) for c in cols)
    sep = "-+-".join("-" * w[c] for c in cols)
    body = "\n".join(" | ".join(str(r.get(c, "")).ljust(w[c]) for c in cols) for r in rows)
    return f"{line}\n{sep}\n{body}"
