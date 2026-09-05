"""Point -> game -> set -> match win probabilities (Markov chain).

All functions take pA / pB = probability that A / B wins a point on
their OWN serve.  Probabilities are for player A winning.
Floats are rounded to 4 dp before caching so repeated calls within a
match hit the cache.
"""
from __future__ import annotations

from functools import lru_cache

_R = 4  # rounding for cache keys


def _r(x: float) -> float:
    return round(x, _R)


@lru_cache(maxsize=None)
def p_game(a: int, b: int, p: float) -> float:
    """P(server wins the game) from point score a (server) - b, p = server point win prob."""
    if a >= 4 and a - b >= 2:
        return 1.0
    if b >= 4 and b - a >= 2:
        return 0.0
    if a >= 3 and b >= 3:
        deuce = p * p / (p * p + (1 - p) * (1 - p))
        if a == b:
            return deuce
        if a > b:  # advantage server
            return p + (1 - p) * deuce
        return p * deuce  # advantage receiver
    return p * p_game(a + 1, b, p) + (1 - p) * p_game(a, b + 1, p)


def tb_server_is_first(points_played: int) -> bool:
    """Who serves the next tiebreak point: True if the player who served point 1."""
    n = points_played + 1
    if n == 1:
        return True
    return ((n - 2) // 2) % 2 == 1


@lru_cache(maxsize=None)
def p_tiebreak(a: int, b: int, first_is_a: bool, pA: float, pB: float, target: int = 7) -> float:
    """P(A wins tiebreak) from a-b, first_is_a = A served point 1."""
    if a >= target and a - b >= 2:
        return 1.0
    if b >= target and b - a >= 2:
        return 0.0
    if a == b and a >= target - 1:
        # next two points are served one by each player -> deuce-like closed form
        win2 = pA * (1 - pB)
        lose2 = (1 - pA) * pB
        return win2 / (win2 + lose2)
    a_serves = tb_server_is_first(a + b) == first_is_a
    pa = pA if a_serves else 1 - pB
    return pa * p_tiebreak(a + 1, b, first_is_a, pA, pB, target) + (1 - pa) * p_tiebreak(
        a, b + 1, first_is_a, pA, pB, target
    )


@lru_cache(maxsize=None)
def p_set(ga: int, gb: int, a_serves: bool, pA: float, pB: float, tb_target: int = 7) -> float:
    """P(A wins set) from games ga-gb with A serving the next game if a_serves."""
    if ga >= 6 and ga - gb >= 2:
        return 1.0
    if gb >= 6 and gb - ga >= 2:
        return 0.0
    if ga == 7:
        return 1.0
    if gb == 7:
        return 0.0
    if ga == 6 and gb == 6:
        return p_tiebreak(0, 0, a_serves, pA, pB, tb_target)
    pg = p_game(0, 0, pA) if a_serves else 1 - p_game(0, 0, pB)
    return pg * p_set(ga + 1, gb, not a_serves, pA, pB, tb_target) + (1 - pg) * p_set(
        ga, gb + 1, not a_serves, pA, pB, tb_target
    )


@lru_cache(maxsize=None)
def p_match_sets(sa: int, sb: int, best_of: int, pA: float, pB: float) -> float:
    """P(A wins match) from set score, at the start of a fresh set."""
    need = best_of // 2 + 1
    if sa >= need:
        return 1.0
    if sb >= need:
        return 0.0
    # who serves first in the next set has a negligible effect; average both.
    ps = 0.5 * (p_set(0, 0, True, pA, pB) + p_set(0, 0, False, pA, pB))
    return ps * p_match_sets(sa + 1, sb, best_of, pA, pB) + (1 - ps) * p_match_sets(
        sa, sb + 1, best_of, pA, pB
    )


def match_win_prob(
    sets_a: int,
    sets_b: int,
    games_a: int,
    games_b: int,
    pts_a: int,
    pts_b: int,
    a_serving: bool,
    in_tb: bool,
    tb_first_a: bool,
    best_of: int,
    pA: float,
    pB: float,
    tb_target: int = 7,
) -> float:
    """P(A wins the match) from an arbitrary live state."""
    pA, pB = _r(pA), _r(pB)
    need = best_of // 2 + 1
    if sets_a >= need:
        return 1.0
    if sets_b >= need:
        return 0.0
    if in_tb:
        p_win_set = p_tiebreak(pts_a, pts_b, tb_first_a, pA, pB, tb_target)
    else:
        if a_serving:
            pg = p_game(pts_a, pts_b, pA)
        else:
            pg = 1 - p_game(pts_b, pts_a, pB)
        p_win_set = pg * p_set(games_a + 1, games_b, not a_serving, pA, pB) + (1 - pg) * p_set(
            games_a, games_b + 1, not a_serving, pA, pB
        )
    return p_win_set * p_match_sets(sets_a + 1, sets_b, best_of, pA, pB) + (
        1 - p_win_set
    ) * p_match_sets(sets_a, sets_b + 1, best_of, pA, pB)


TOUR_AVG_SERVE_PT = {"atp": 0.64, "wta": 0.57}


@lru_cache(maxsize=None)
def calibrate(target_p_a: float, best_of: int = 3, tour: str = "wta", tol: float = 1e-5) -> tuple[float, float]:
    """Find (pA, pB) with pA + pB = 2*tour_avg such that P(A wins match) == target.

    This maps a pre-match implied probability onto serve-point probabilities
    so the whole live price path can be computed.
    """
    avg = TOUR_AVG_SERVE_PT[tour]
    target_p_a = min(max(target_p_a, 0.005), 0.995)
    lo, hi = -(avg - 0.02), (1 - avg - 0.02)
    for _ in range(60):
        mid = (lo + hi) / 2
        pA, pB = _r(avg + mid), _r(avg - mid)
        val = p_match_sets(0, 0, best_of, pA, pB)
        if abs(val - target_p_a) < tol:
            break
        if val < target_p_a:
            lo = mid
        else:
            hi = mid
    return _r(avg + mid), _r(avg - mid)


def clear_caches() -> None:
    for f in (p_game, p_tiebreak, p_set, p_match_sets):
        f.cache_clear()
