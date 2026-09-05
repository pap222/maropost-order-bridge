import math

from tennis_scalper.markov import calibrate, match_win_prob, p_game, p_match_sets, p_set, p_tiebreak


def test_game_closed_form():
    # classic result: p=0.6 -> P(hold)=0.7357
    assert abs(p_game(0, 0, 0.6) - 0.7357) < 1e-3
    assert p_game(0, 0, 0.5) == 0.5
    assert p_game(4, 2, 0.6) == 1.0 and p_game(2, 4, 0.6) == 0.0
    assert p_game(3, 3, 0.6) == p_game(4, 4, 0.6)


def test_symmetry():
    assert abs(p_tiebreak(0, 0, True, 0.6, 0.6) - 0.5) < 1e-9
    assert abs(p_set(0, 0, True, 0.6, 0.6) + p_set(0, 0, False, 0.6, 0.6) - 1.0) < 1e-9
    assert abs(p_match_sets(0, 0, 3, 0.6, 0.6) - 0.5) < 1e-9


def test_monotone():
    a = [p_match_sets(0, 0, 3, 0.55 + d, 0.55 - d) for d in (0.0, 0.02, 0.05, 0.1)]
    assert all(x < y for x, y in zip(a, a[1:]))
    assert p_match_sets(0, 0, 5, 0.6, 0.55) > p_match_sets(0, 0, 3, 0.6, 0.55)  # longer format favours the better player


def test_calibrate_roundtrip():
    for tgt in (0.55, 0.65, 0.8, 0.9):
        pA, pB = calibrate(tgt, 3, "wta")
        assert abs(p_match_sets(0, 0, 3, pA, pB) - tgt) < 2e-3


def test_live_state_extremes():
    assert match_win_prob(2, 0, 0, 0, 0, 0, True, False, True, 3, 0.6, 0.6) == 1.0
    assert match_win_prob(0, 2, 0, 0, 0, 0, True, False, True, 3, 0.6, 0.6) == 0.0
    # match point for A: 1-0 sets, 5-4, 40-0 serving
    p = match_win_prob(1, 0, 5, 4, 3, 0, True, False, True, 3, 0.6, 0.6)
    assert p > 0.97
    # a break should move the price
    before = match_win_prob(0, 0, 0, 0, 0, 0, True, False, True, 3, 0.6, 0.6)
    after = match_win_prob(0, 0, 0, 1, 0, 0, False, False, True, 3, 0.6, 0.6)
    assert before - after > 0.1
