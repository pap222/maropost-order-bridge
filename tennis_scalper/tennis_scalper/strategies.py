"""Rule definitions.  A Rule says WHEN to buy the underdog and WHEN to get out.

Entry triggers (evaluated in set 1 only unless `entry_set_max` is raised):
  pre_match             buy before the first point
  underdog_holds_first  underdog holds their first service game (no prior fav break)
  underdog_breaks_first underdog breaks before being broken
  underdog_0_30         underdog reaches 0-30 (or better) returning, first time
  underdog_break_point  underdog earns a break point, first time
  external_edge         external bookmaker prob for underdog exceeds market ask by `edge` (Strategy E)

Exit: first of take_profit, stop_loss, exit_on event, max_hold horizon.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional


@dataclass(frozen=True)
class Rule:
    name: str
    entry_trigger: str = "pre_match"
    entry_lo: float = 0.25          # underdog price band (ask) for entry
    entry_hi: float = 0.45
    take_profit: float = 0.15       # $ above entry
    stop_loss: float = 0.10         # $ below entry
    exit_on: Optional[str] = None   # 'underdog_break' -> sell at first underdog break after entry
    max_hold: str = "set1"          # 'set1' | 'set2' | 'match' (match = never; ride to settlement)
    abort_if_fav_breaks_first: bool = True  # for post-match triggers: cancel entry if fav breaks before trigger
    min_underdog_hold_pct: Optional[float] = None  # Strategy B: needs player hold stats
    edge: float = 0.03              # Strategy E threshold
    entry_set_max: int = 1
    tags: tuple = field(default_factory=tuple)


DEFAULT_RULES: list[Rule] = [
    Rule("A_prematch_sell_on_break", "pre_match", 0.30, 0.45, 0.15, 0.10, exit_on="underdog_break"),
    Rule("A2_prematch_tp15_sl10", "pre_match", 0.30, 0.45, 0.15, 0.10),
    Rule("A3_prematch_tp25_sl10", "pre_match", 0.30, 0.45, 0.25, 0.10),
    Rule("B_strong_server", "pre_match", 0.30, 0.45, 0.15, 0.10, exit_on="underdog_break", min_underdog_hold_pct=0.70),
    Rule("C_after_underdog_hold", "underdog_holds_first", 0.25, 0.50, 0.15, 0.10, exit_on="underdog_break"),
    Rule("D_after_0_30", "underdog_0_30", 0.25, 0.55, 0.12, 0.08),
    Rule("D2_break_point", "underdog_break_point", 0.25, 0.60, 0.12, 0.08),
    Rule("E_external_edge", "external_edge", 0.20, 0.60, 0.10, 0.08, edge=0.03),
    Rule("X_hold_to_settlement", "pre_match", 0.30, 0.45, 9.0, 9.0, max_hold="match", tags=("control",)),
]


def rules_by_name(names: list[str]) -> list[Rule]:
    m = {r.name: r for r in DEFAULT_RULES}
    return [m[n] for n in names]
