"""Backtest engine: replays matches point-by-point, prices the underdog
contract at every point, and executes Rules against that price path.
"""
from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Iterable, Optional

from .markov import calibrate, clear_caches
from .match import Event, MatchState, infer_best_of, parse_pbp
from .pricing import MarketModel
from .strategies import Rule


@dataclass
class MatchRecord:
    match_id: str
    date: str
    tour: str            # 'atp' | 'wta'
    player_a: str        # server1
    player_b: str
    pbp: str
    winner: str          # 'A' | 'B'
    p_a: float           # pre-match implied prob that A wins (de-vigged)
    best_of: int = 3
    tournament: str = ""
    external_p_ud: Optional[list] = None  # optional per-point external (bookmaker) underdog prob, for Strategy E

    @property
    def underdog(self) -> str:
        return "B" if self.p_a >= 0.5 else "A"

    @property
    def favourite(self) -> str:
        return "A" if self.p_a >= 0.5 else "B"

    @property
    def p_underdog(self) -> float:
        return 1 - self.p_a if self.p_a >= 0.5 else self.p_a


@dataclass
class PricePoint:
    idx: int
    fair_ud: float
    bid: float
    ask: float
    events: list
    score: str
    set_no: int
    server_next: str = "A"   # who serves the next point
    pts_ud: int = 0          # underdog points in current game
    pts_fav: int = 0
    in_tb: bool = False


@dataclass
class Trade:
    match_id: str
    rule: str
    date: str
    favourite: str
    underdog: str
    p_underdog_prematch: float
    entry_idx: int
    entry_price: float
    shares: float
    exit_idx: int
    exit_price: float
    exit_reason: str
    fees: float
    pnl: float                 # $ on `stake`
    pnl_cents: float           # exit - entry, price units
    max_bid_seen: float        # MFE
    min_bid_seen: float        # MAE
    holding_points: int
    underdog_won: bool
    entry_score: str
    exit_score: str


def price_path(rec: MatchRecord, market: MarketModel, tb_target: int = 7) -> list[PricePoint]:
    """Underdog price after every point (index 0 = before first point)."""
    pA, pB = calibrate(rec.p_a, rec.best_of, rec.tour)
    st = MatchState(best_of=rec.best_of, tb_target=tb_target)
    ud_is_a = rec.underdog == "A"
    overshoot = {"jump": 0.0, "age": 0}
    k, decay = market.overreaction, max(1, market.overreaction_decay)

    def ud_fair(s: MatchState) -> float:
        p = s.win_prob_a(pA, pB)
        return p if ud_is_a else 1 - p

    prev_fair = ud_fair(st)

    def pp(i: int, ev: list) -> PricePoint:
        nonlocal prev_fair
        f = ud_fair(st)
        excess = 0.0
        if k:
            if any(e.kind in ("break", "set") for e in ev) and not st.finished:
                overshoot["jump"], overshoot["age"] = f - prev_fair, 0
            if overshoot["jump"] and overshoot["age"] < decay:
                excess = k * overshoot["jump"] * (1 - overshoot["age"] / decay)
                overshoot["age"] += 1
        prev_fair = f
        bid, ask = market.quote(f, excess)
        pa, pb = st.pts_a, st.pts_b
        set_of_point = ev[0].set_no if ev else st.set_no   # set the point was played in
        return PricePoint(i, f, bid, ask, ev, st.score_str(), set_of_point, st.server_of_next_point() if not st.finished else "-",
                          pa if ud_is_a else pb, pb if ud_is_a else pa, st.in_tb)

    out = [pp(0, [])]
    for i, server_won in enumerate(parse_pbp(rec.pbp), start=1):
        if st.finished:
            break
        server = st.server_of_next_point()
        a_won = server_won if server == "A" else not server_won
        ev = st.apply_point(a_won)
        out.append(pp(i, ev))
    return out


def _has(events: list, kind: str, player: str) -> bool:
    return any(e.kind == kind and e.player == player for e in events)


def run_rule(rec: MatchRecord, path: list[PricePoint], rule: Rule, market: MarketModel,
             stake: float = 100.0, hold_pct: Optional[float] = None) -> Optional[Trade]:
    ud, fav = rec.underdog, rec.favourite
    if rule.min_underdog_hold_pct is not None:
        if hold_pct is None or hold_pct < rule.min_underdog_hold_pct:
            return None

    # ---- find entry
    entry_i = None
    fav_broke = False
    ud_broke = False
    ud_held = False
    ud_serve_games_seen = 0
    for pp in path:
        if pp.set_no > rule.entry_set_max:
            break
        evs = pp.events
        if rule.abort_if_fav_breaks_first and _has(evs, "break", fav):
            fav_broke = True
        if _has(evs, "break", ud):
            ud_broke = True
        if _has(evs, "hold", ud):
            ud_held = True
        trig = False
        t = rule.entry_trigger
        if t == "pre_match":
            trig = pp.idx == 0
        elif t == "underdog_holds_first":
            trig = ud_held and not fav_broke and not ud_broke
        elif t == "underdog_breaks_first":
            trig = ud_broke and not fav_broke
        elif t == "underdog_0_30":
            trig = _ud_returning_0_30(pp, ud) and not fav_broke
        elif t == "underdog_break_point":
            trig = _has(evs, "break_point", ud) and not fav_broke
        elif t == "external_edge":
            if rec.external_p_ud is None or pp.idx >= len(rec.external_p_ud):
                return None
            trig = rec.external_p_ud[pp.idx] - pp.ask >= rule.edge
        if trig:
            if rule.entry_lo <= pp.ask <= rule.entry_hi:
                entry_i = pp.idx
            break  # one shot: trigger fires once
        if t != "pre_match" and fav_broke and rule.abort_if_fav_breaks_first:
            break
    if entry_i is None:
        return None

    ep = path[entry_i]
    fill, shares, fee_in = market.buy(ep.ask, stake)
    tp = fill + rule.take_profit
    sl = fill - rule.stop_loss
    max_bid = min_bid = ep.bid
    exit_i = None
    reason = ""
    entry_set = ep.set_no
    horizon_set = {"set1": 1, "set2": 2, "match": 99}[rule.max_hold]
    horizon_set = max(horizon_set, entry_set)  # can't be shorter than the entry set

    for pp in path[entry_i + 1:]:
        max_bid = max(max_bid, pp.bid)
        min_bid = min(min_bid, pp.bid)
        if pp.bid >= tp:
            exit_i, reason = pp.idx, "take_profit"
            break
        if pp.bid <= sl:
            exit_i, reason = pp.idx, "stop_loss"
            break
        if rule.exit_on == "underdog_break" and _has(pp.events, "break", ud):
            exit_i, reason = pp.idx, "underdog_break"
            break
        if _has(pp.events, "set", "A") or _has(pp.events, "set", "B"):
            # set just ended (pp.set_no is the set that point belonged to)
            if pp.set_no >= horizon_set:
                exit_i, reason = pp.idx, f"max_hold_{rule.max_hold}"
                break
    if exit_i is None:
        pp = path[-1]
        exit_i = pp.idx
        if rule.max_hold == "match":
            reason = "settlement"
        else:
            reason = "match_end"
    xp = path[exit_i]
    if reason == "settlement":
        settle = 1.0 if rec.winner == ud else 0.0
        xfill, proceeds, fee_out = settle, settle * shares, 0.0
    else:
        xfill, proceeds, fee_out = market.sell(xp.bid, shares)
    pnl = proceeds - stake - fee_in - fee_out
    return Trade(
        match_id=rec.match_id, rule=rule.name, date=rec.date, favourite=getattr(rec, f"player_{fav.lower()}"),
        underdog=getattr(rec, f"player_{ud.lower()}"), p_underdog_prematch=rec.p_underdog,
        entry_idx=entry_i, entry_price=round(fill, 4), shares=round(shares, 2), exit_idx=exit_i,
        exit_price=round(xfill, 4), exit_reason=reason, fees=round(fee_in + fee_out, 4), pnl=round(pnl, 2),
        pnl_cents=round(xfill - fill, 4), max_bid_seen=max_bid, min_bid_seen=min_bid,
        holding_points=exit_i - entry_i, underdog_won=rec.winner == ud, entry_score=ep.score, exit_score=xp.score,
    )


def _ud_returning_0_30(pp: PricePoint, ud: str) -> bool:
    """Underdog is returning and has reached 0-30 (or 0-40) on the favourite's serve."""
    return (not pp.in_tb) and pp.server_next != ud and pp.server_next != "-" and pp.pts_ud >= 2 and pp.pts_fav == 0


class Backtester:
    def __init__(self, market: MarketModel, rules: Iterable[Rule], stake: float = 100.0, tb_target: int = 7):
        self.market = market
        self.rules = list(rules)
        self.stake = stake
        self.tb_target = tb_target
        self.hold_stats: dict[str, list[int]] = {}  # player -> [holds, service_games], updated chronologically

    def _hold_pct(self, player: str) -> Optional[float]:
        h = self.hold_stats.get(player)
        if not h or h[1] < 10:
            return None
        return h[0] / h[1]

    def _update_hold_stats(self, rec: MatchRecord, path: list[PricePoint]) -> None:
        for name, side in ((rec.player_a, "A"), (rec.player_b, "B")):
            st = self.hold_stats.setdefault(name, [0, 0])
            for pp in path:
                for e in pp.events:
                    if e.kind == "hold" and e.player == side:
                        st[0] += 1
                        st[1] += 1
                    elif e.kind == "break" and e.player != side:
                        st[1] += 1

    def run(self, matches: Iterable[MatchRecord]) -> tuple[list[Trade], list[dict]]:
        trades: list[Trade] = []
        summaries: list[dict] = []
        for n, rec in enumerate(matches):
            if n % 500 == 0:
                clear_caches()
            path = price_path(rec, self.market, self.tb_target)
            hold_pct = self._hold_pct(getattr(rec, f"player_{rec.underdog.lower()}"))
            for rule in self.rules:
                t = run_rule(rec, path, rule, self.market, self.stake, hold_pct)
                if t:
                    trades.append(t)
            summaries.append(match_summary(rec, path))
            self._update_hold_stats(rec, path)
        return trades, summaries


def match_summary(rec: MatchRecord, path: list[PricePoint]) -> dict:
    """Per-match facts used by the player scan and first-touch tables."""
    ud, fav = rec.underdog, rec.favourite
    set1 = [pp for pp in path if pp.set_no == 1]
    first_break = next((e.player for pp in path for e in pp.events if e.kind == "break"), None)
    ud_broke_first_set1 = first_break == ud and any(e.kind == "break" for pp in set1 for e in pp.events)
    fav_down_break_set1 = any(_has(pp.events, "break", ud) for pp in set1)
    max_bid_set1 = max(pp.bid for pp in set1)
    min_bid_set1 = min(pp.bid for pp in set1)
    return {
        "match_id": rec.match_id, "date": rec.date, "tour": rec.tour, "tournament": rec.tournament,
        "favourite": getattr(rec, f"player_{fav.lower()}"), "underdog": getattr(rec, f"player_{ud.lower()}"),
        "p_underdog": round(rec.p_underdog, 3), "entry_ask": path[0].ask,
        "fav_won": rec.winner == fav, "first_break_by": first_break,
        "ud_broke_first": ud_broke_first_set1, "fav_down_break_set1": fav_down_break_set1,
        "max_bid_set1": max_bid_set1, "min_bid_set1": min_bid_set1,
        "spike_set1": round(max_bid_set1 - path[0].ask, 4),
        "max_bid_match": max(pp.bid for pp in path), "points": len(path) - 1,
    }


def trades_to_dicts(trades: list[Trade]) -> list[dict]:
    return [asdict(t) for t in trades]
