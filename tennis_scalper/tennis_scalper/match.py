"""Live match state machine + Sackmann point-by-point parser.

Feeds a sequence of points ("did the server win?") through the scoring
rules and emits events (hold, break, break point, set, match) that the
strategies key off.  Player A is always `server1` (serves game 1).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterator, Optional

from .markov import match_win_prob, tb_server_is_first


@dataclass
class Event:
    kind: str  # 'point','hold','break','break_point','set','match','tb_start'
    player: str  # 'A' or 'B' - who the event favours / who did it
    set_no: int
    game_no: int  # game number within the set (1-based, completed or in progress)


@dataclass
class MatchState:
    best_of: int = 3
    tb_target: int = 7
    sets_a: int = 0
    sets_b: int = 0
    games_a: int = 0
    games_b: int = 0
    pts_a: int = 0
    pts_b: int = 0
    a_serving: bool = True  # server of the current game (or next point in a TB)
    in_tb: bool = False
    tb_first_a: bool = True
    finished: bool = False
    winner: Optional[str] = None
    points_played: int = 0
    set_no: int = 1
    breaks: list = field(default_factory=list)  # (set_no, 'A'/'B') in order

    # ----- scoring -----
    def _need(self) -> int:
        return self.best_of // 2 + 1

    def server_of_next_point(self) -> str:
        if self.in_tb:
            first = tb_server_is_first(self.pts_a + self.pts_b)
            return "A" if (first == self.tb_first_a) else "B"
        return "A" if self.a_serving else "B"

    def apply_point(self, a_won: bool) -> list[Event]:
        """Advance one point. Returns the events it produced."""
        if self.finished:
            raise ValueError("match already finished")
        ev: list[Event] = []
        self.points_played += 1
        game_no = self.games_a + self.games_b + 1
        server = self.server_of_next_point()

        if a_won:
            self.pts_a += 1
        else:
            self.pts_b += 1
        ev.append(Event("point", "A" if a_won else "B", self.set_no, game_no))

        if self.in_tb:
            t = self.tb_target
            if (self.pts_a >= t or self.pts_b >= t) and abs(self.pts_a - self.pts_b) >= 2:
                a_won_set = self.pts_a > self.pts_b
                self._end_game(a_won_set, game_no, ev, tb=True)
            return ev

        # regular game
        if (self.pts_a >= 4 or self.pts_b >= 4) and abs(self.pts_a - self.pts_b) >= 2:
            self._end_game(self.pts_a > self.pts_b, game_no, ev, tb=False, server=server)
        else:
            # break point / game point detection for the returner
            returner = "B" if server == "A" else "A"
            rp = self.pts_b if returner == "B" else self.pts_a
            sp = self.pts_a if returner == "B" else self.pts_b
            if rp >= 3 and rp - sp >= 1:
                ev.append(Event("break_point", returner, self.set_no, game_no))
        return ev

    def _end_game(self, a_won: bool, game_no: int, ev: list[Event], tb: bool, server: str = "") -> None:
        w = "A" if a_won else "B"
        if not tb:
            if w == server:
                ev.append(Event("hold", w, self.set_no, game_no))
            else:
                ev.append(Event("break", w, self.set_no, game_no))
                self.breaks.append((self.set_no, w))
        if a_won:
            self.games_a += 1
        else:
            self.games_b += 1
        self.pts_a = self.pts_b = 0
        if tb:
            # next set is served by the player who did NOT serve TB point 1
            self.a_serving = not self.tb_first_a
            self.in_tb = False
            self._end_set(a_won, ev)
            return
        self.a_serving = not self.a_serving
        ga, gb = self.games_a, self.games_b
        if (ga >= 6 or gb >= 6) and abs(ga - gb) >= 2:
            self._end_set(ga > gb, ev)
        elif ga == 6 and gb == 6:
            self.in_tb = True
            self.tb_first_a = self.a_serving
            ev.append(Event("tb_start", "A" if self.a_serving else "B", self.set_no, game_no + 1))

    def _end_set(self, a_won: bool, ev: list[Event]) -> None:
        if a_won:
            self.sets_a += 1
        else:
            self.sets_b += 1
        ev.append(Event("set", "A" if a_won else "B", self.set_no, self.games_a + self.games_b))
        self.games_a = self.games_b = 0
        if self.sets_a >= self._need() or self.sets_b >= self._need():
            self.finished = True
            self.winner = "A" if self.sets_a > self.sets_b else "B"
            ev.append(Event("match", self.winner, self.set_no, 0))
        else:
            self.set_no += 1

    # ----- pricing -----
    def win_prob_a(self, pA: float, pB: float) -> float:
        return match_win_prob(
            self.sets_a, self.sets_b, self.games_a, self.games_b, self.pts_a, self.pts_b,
            self.a_serving, self.in_tb, self.tb_first_a, self.best_of, pA, pB, self.tb_target,
        )

    def score_str(self) -> str:
        return f"[{self.sets_a}-{self.sets_b}] {self.games_a}-{self.games_b} ({self.pts_a}-{self.pts_b})" + (
            " TB" if self.in_tb else ""
        )


# ---------------------------------------------------------------- Sackmann pbp
_SERVER_WON = {"S", "A"}
_RETURNER_WON = {"R", "D"}


def parse_pbp(pbp: str) -> Iterator[bool]:
    """Yield True when the SERVER won the point, for a Sackmann pbp string.

    Format: sets separated by '.', games by ';', tiebreak serve changes by '/'.
    S=server won, A=ace, R=returner won, D=double fault.
    """
    for ch in pbp:
        if ch in _SERVER_WON:
            yield True
        elif ch in _RETURNER_WON:
            yield False
        # '.', ';', '/' and whitespace are structural


def replay(pbp: str, best_of: int, tb_target: int = 7) -> tuple[MatchState, list[tuple[MatchState, list[Event]]]]:
    """Replay a pbp string. Returns final state and a per-point list of (state snapshot, events)."""
    st = MatchState(best_of=best_of, tb_target=tb_target)
    path = []
    for server_won in parse_pbp(pbp):
        if st.finished:
            break
        server = st.server_of_next_point()
        a_won = server_won if server == "A" else not server_won
        ev = st.apply_point(a_won)
        path.append((_snapshot(st), ev))
    return st, path


def _snapshot(st: MatchState) -> MatchState:
    return MatchState(
        best_of=st.best_of, tb_target=st.tb_target, sets_a=st.sets_a, sets_b=st.sets_b,
        games_a=st.games_a, games_b=st.games_b, pts_a=st.pts_a, pts_b=st.pts_b,
        a_serving=st.a_serving, in_tb=st.in_tb, tb_first_a=st.tb_first_a, finished=st.finished,
        winner=st.winner, points_played=st.points_played, set_no=st.set_no, breaks=list(st.breaks),
    )


def infer_best_of(pbp: str, winner_sets: Optional[int] = None) -> int:
    """Best-of-5 if the winner took 3 sets, else best-of-3."""
    if winner_sets is not None:
        return 5 if winner_sets >= 3 else 3
    n_sets = len([s for s in pbp.split(".") if s.strip()])
    return 5 if n_sets >= 4 else 3
