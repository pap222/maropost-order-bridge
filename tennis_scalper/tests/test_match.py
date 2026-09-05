from tennis_scalper.match import MatchState, replay


def test_hold_and_break_events():
    st = MatchState()
    evs = []
    for _ in range(4):
        evs += st.apply_point(True)  # A serves and wins 4 points
    assert any(e.kind == "hold" and e.player == "A" for e in evs)
    assert st.games_a == 1 and not st.a_serving
    evs = []
    for _ in range(4):
        evs += st.apply_point(True)  # A breaks B
    assert any(e.kind == "break" and e.player == "A" for e in evs)
    assert st.breaks == [(1, "A")]


def test_break_point_event():
    st = MatchState()  # A serving
    evs = st.apply_point(False) + st.apply_point(False) + st.apply_point(False)
    assert any(e.kind == "break_point" and e.player == "B" for e in evs)


def test_full_match_replay_sackmann_format():
    # A holds every game, B loses every game: 6-0 6-0 = 12 games, each 'SSSS' or 'RRRR' depending on server
    games = []
    for g in range(12):
        games.append("SSSS" if g % 2 == 0 else "RRRR")
    pbp = ";".join(games[:6]) + "." + ";".join(games[6:])
    st, path = replay(pbp, 3)
    assert st.finished and st.winner == "A" and st.sets_a == 2
    assert len(path) == 48


def test_tiebreak_flow():
    st = MatchState()
    # everyone holds to 6-6
    for g in range(12):
        for _ in range(4):
            st.apply_point(st.server_of_next_point() == "A")
    assert st.in_tb and st.games_a == 6 and st.games_b == 6
    # A wins 7 straight TB points
    for _ in range(7):
        st.apply_point(True)
    assert st.sets_a == 1 and not st.in_tb and st.set_no == 2
    # next set served by the player who did not serve TB point 1
    assert st.a_serving is not st.tb_first_a
