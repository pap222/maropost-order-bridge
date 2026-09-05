"""Synthetic match generator.

Draws a pre-match favourite probability, calibrates serve-point
probabilities to it, and simulates points.  Because the price model and
the simulator share the same Markov chain, the simulated market is FAIR:
every strategy's pre-cost expectancy is ~0.  That is the point: it gives
the base rates (how often 40c touches 55c before 30c) and the cost drag,
and lets you dial `--overreaction` to see how mispriced the market must be
for the strategy to make money.  Real edge can only be measured on real
order-book data (see live/recorder.py).
"""
from __future__ import annotations

import random

from .backtest import MatchRecord
from .markov import calibrate
from .match import MatchState

_POOL = 40  # synthetic player pool so player_scan has something to group on


def simulate_match(rng: random.Random, match_id: str, tour: str = "wta", best_of: int = 3,
                   p_fav: float | None = None) -> MatchRecord:
    if p_fav is None:
        p_fav = min(0.95, 0.5 + rng.betavariate(1.3, 2.2) * 0.5)   # mass around 55-75%
    fav_is_a = rng.random() < 0.5
    p_a = p_fav if fav_is_a else 1 - p_fav
    pA, pB = calibrate(p_a, best_of, tour)
    st = MatchState(best_of=best_of)
    tokens: list[str] = []
    cur_set = 1
    game_chars: list[str] = []
    games: list[str] = []
    sets: list[str] = []
    while not st.finished:
        server = st.server_of_next_point()
        p_srv = pA if server == "A" else pB
        server_won = rng.random() < p_srv
        a_won = server_won if server == "A" else not server_won
        ev = st.apply_point(a_won)
        game_chars.append("S" if server_won else "R")
        if any(e.kind in ("hold", "break", "set") for e in ev):
            games.append("".join(game_chars))
            game_chars = []
        if any(e.kind == "set" for e in ev):
            sets.append(";".join(games))
            games = []
            cur_set += 1
    pbp = ".".join(sets)
    fa, fb = rng.randrange(_POOL), rng.randrange(_POOL)
    while fb == fa:
        fb = rng.randrange(_POOL)
    return MatchRecord(
        match_id=match_id, date=f"2026-{1 + rng.randrange(12):02d}-{1 + rng.randrange(28):02d}", tour=tour,
        player_a=f"Player{fa:02d}", player_b=f"Player{fb:02d}", pbp=pbp, winner=st.winner, p_a=p_a,
        best_of=best_of, tournament="SIM",
    )


def simulate_matches(n: int, seed: int = 1, tour: str = "wta", best_of: int = 3) -> list[MatchRecord]:
    rng = random.Random(seed)
    out = [simulate_match(rng, f"sim{seed}-{i}", tour, best_of) for i in range(n)]
    out.sort(key=lambda m: m.date)
    return out
