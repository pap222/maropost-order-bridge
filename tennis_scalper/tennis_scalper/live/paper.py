"""Paper trader: applies a Rule to a live (price, score) stream and logs
hypothetical fills.  Prices come from the recorder's snapshots (or a
live feed), the score comes from a ScoreFeed implementation you supply.

The engine is the same as the backtest: build a MatchState from the
score feed, derive events (hold/break/break point) from state changes,
and let `run_rule`-style logic decide entries/exits against the REAL
bid/ask rather than the Markov fair value.
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from ..strategies import Rule


@dataclass
class PaperPosition:
    rule: str
    market: str
    entry_ts: float
    entry_price: float
    shares: float
    max_bid: float
    min_bid: float


@dataclass
class PaperTrader:
    rule: Rule
    stake: float
    log_path: Path
    positions: dict = field(default_factory=dict)  # market -> PaperPosition
    done: set = field(default_factory=set)         # markets already traded (one shot per rule)

    def on_tick(self, market: str, bid: Optional[float], ask: Optional[float], events: list[str],
                underdog_side: bool, set_no: int, match_over: bool) -> None:
        """events: subset of {'underdog_break','fav_break','underdog_hold','underdog_0_30','underdog_break_point','set_end'}."""
        if bid is None or ask is None or not underdog_side:
            return
        pos = self.positions.get(market)
        if pos is None:
            if market in self.done or set_no > self.rule.entry_set_max:
                return
            t = self.rule.entry_trigger
            trig = (t == "pre_match" and set_no == 1 and not events) or \
                   (t == "underdog_holds_first" and "underdog_hold" in events) or \
                   (t == "underdog_breaks_first" and "underdog_break" in events) or \
                   (t == "underdog_0_30" and "underdog_0_30" in events) or \
                   (t == "underdog_break_point" and "underdog_break_point" in events)
            if "fav_break" in events and self.rule.abort_if_fav_breaks_first and t != "pre_match":
                self.done.add(market)
                return
            if trig and self.rule.entry_lo <= ask <= self.rule.entry_hi:
                self.positions[market] = PaperPosition(self.rule.name, market, time.time(), ask, self.stake / ask, bid, bid)
                self.done.add(market)
                self._log({"type": "entry", "market": market, "rule": self.rule.name, "price": ask, "ts": time.time()})
            return
        pos.max_bid = max(pos.max_bid, bid)
        pos.min_bid = min(pos.min_bid, bid)
        reason = None
        if bid >= pos.entry_price + self.rule.take_profit:
            reason = "take_profit"
        elif bid <= pos.entry_price - self.rule.stop_loss:
            reason = "stop_loss"
        elif self.rule.exit_on == "underdog_break" and "underdog_break" in events:
            reason = "underdog_break"
        elif "set_end" in events and {"set1": 1, "set2": 2, "match": 99}[self.rule.max_hold] <= set_no:
            reason = f"max_hold_{self.rule.max_hold}"
        elif match_over:
            reason = "match_end"
        if reason:
            pnl = (bid - pos.entry_price) * pos.shares
            self._log({"type": "exit", "market": market, "rule": self.rule.name, "entry": pos.entry_price, "exit": bid,
                       "reason": reason, "pnl": round(pnl, 2), "mfe": pos.max_bid, "mae": pos.min_bid, "ts": time.time()})
            del self.positions[market]

    def _log(self, row: dict) -> None:
        with open(self.log_path, "a") as f:
            f.write(json.dumps(row) + "\n")
