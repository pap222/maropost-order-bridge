"""Data loading.

Real data (download yourself; this environment had no network):
  * Point-by-point: https://github.com/JeffSackmann/tennis_pointbypoint
      pbp_matches_atp_main_current.csv, pbp_matches_wta_main_current.csv, *_archive.csv, *_qual_*.csv
  * Pre-match odds:   http://www.tennis-data.co.uk  (yearly xlsx/csv, Bet365 + Pinnacle + Avg closing odds)
    Convert xlsx -> csv, or pass xlsx (needs pandas + openpyxl).

Joining is by date (+-1 day) and surname.  Matches without odds are dropped
unless --default-odds is used.
"""
from __future__ import annotations

import csv
import re
import unicodedata
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Iterable, Optional

from .backtest import MatchRecord
from .match import infer_best_of, replay

SACKMANN_BASE = "https://raw.githubusercontent.com/JeffSackmann/tennis_pointbypoint/master/"
SACKMANN_FILES = [
    "pbp_matches_atp_main_current.csv", "pbp_matches_atp_main_archive.csv",
    "pbp_matches_wta_main_current.csv", "pbp_matches_wta_main_archive.csv",
    "pbp_matches_atp_qual_current.csv", "pbp_matches_wta_qual_current.csv",
]


def download_sackmann(dest: Path) -> list[Path]:
    import urllib.request
    dest.mkdir(parents=True, exist_ok=True)
    out = []
    for f in SACKMANN_FILES:
        p = dest / f
        if not p.exists():
            urllib.request.urlretrieve(SACKMANN_BASE + f, p)
        out.append(p)
    return out


def _norm(s: str) -> str:
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z]", "", s.lower())


def surname_key(name: str) -> str:
    """'Marta Kostyuk' / 'Kostyuk M.' / 'Kostyuk' -> 'kostyuk'."""
    name = name.strip()
    if "." in name:  # tennis-data style "Kostyuk M."
        parts = [p for p in name.replace(".", " ").split() if len(p) > 1]
        return _norm(parts[0]) if parts else _norm(name)
    parts = name.split()
    return _norm(parts[-1]) if parts else _norm(name)


def _parse_date(s: str) -> Optional[date]:
    s = s.strip()
    for fmt in ("%d %b %Y", "%Y-%m-%d", "%d/%m/%Y", "%Y%m%d", "%m/%d/%Y", "%d %B %Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    return None


class OddsIndex:
    """(date, surname_w, surname_l) -> (p_winner, p_loser) de-vigged."""

    def __init__(self):
        self.idx: dict[tuple, tuple[float, float]] = {}

    def add(self, d: date, winner: str, loser: str, odds_w: float, odds_l: float) -> None:
        if odds_w <= 1 or odds_l <= 1:
            return
        iw, il = 1 / odds_w, 1 / odds_l
        s = iw + il
        for dd in (-1, 0, 1):
            self.idx[(d + timedelta(days=dd), surname_key(winner), surname_key(loser))] = (iw / s, il / s)

    def lookup(self, d: date, a: str, b: str) -> Optional[float]:
        """Return P(a beats b) if found."""
        ka, kb = surname_key(a), surname_key(b)
        if (d, ka, kb) in self.idx:
            return self.idx[(d, ka, kb)][0]
        if (d, kb, ka) in self.idx:
            return self.idx[(d, kb, ka)][1]
        return None

    @classmethod
    def from_tennis_data(cls, paths: Iterable[Path], book: str = "Avg") -> "OddsIndex":
        oi = cls()
        for p in paths:
            rows = _read_rows(p)
            for r in rows:
                d = _parse_date(str(r.get("Date", "")))
                if not d:
                    continue
                w, l = r.get("Winner", ""), r.get("Loser", "")
                for bk in (book, "PS", "B365", "Avg", "Max"):
                    try:
                        ow, ol = float(r[f"{bk}W"]), float(r[f"{bk}L"])
                        break
                    except (KeyError, ValueError, TypeError):
                        continue
                else:
                    continue
                oi.add(d, w, l, ow, ol)
        return oi


def _read_rows(p: Path) -> list[dict]:
    if p.suffix.lower() in (".xlsx", ".xls"):
        import pandas as pd  # optional
        df = pd.read_excel(p)
        df["Date"] = df["Date"].astype(str)
        return df.to_dict("records")
    with open(p, newline="", encoding="utf-8", errors="replace") as f:
        return list(csv.DictReader(f))


def load_sackmann(paths: Iterable[Path], odds: Optional[OddsIndex] = None, default_p_a: Optional[float] = None,
                  validate: bool = True, tour_filter: Optional[str] = None) -> tuple[list[MatchRecord], dict]:
    """Load Sackmann pbp CSVs into MatchRecords.  Returns (records, diagnostics)."""
    recs: list[MatchRecord] = []
    diag = {"rows": 0, "no_odds": 0, "replay_mismatch": 0, "bad_pbp": 0, "loaded": 0}
    for p in paths:
        with open(p, newline="", encoding="utf-8", errors="replace") as f:
            for r in csv.DictReader(f):
                diag["rows"] += 1
                tour = "atp" if "atp" in p.name.lower() else "wta"
                if tour_filter and tour != tour_filter:
                    continue
                pbp = (r.get("pbp") or "").strip()
                if not pbp:
                    diag["bad_pbp"] += 1
                    continue
                winner = "A" if str(r.get("winner", "1")).strip() == "1" else "B"
                d = _parse_date(str(r.get("date", "")))
                best_of = infer_best_of(pbp)
                if validate:
                    try:
                        st, _ = replay(pbp, best_of)
                    except Exception:
                        diag["bad_pbp"] += 1
                        continue
                    if not st.finished or st.winner != winner:
                        diag["replay_mismatch"] += 1
                        continue
                pa = odds.lookup(d, r["server1"], r["server2"]) if (odds and d) else None
                if pa is None:
                    pa = default_p_a
                if pa is None:
                    diag["no_odds"] += 1
                    continue
                recs.append(MatchRecord(
                    match_id=str(r.get("pbp_id") or f"{p.stem}:{diag['rows']}"), date=d.isoformat() if d else "",
                    tour=tour, player_a=r["server1"], player_b=r["server2"], pbp=pbp, winner=winner, p_a=pa,
                    best_of=best_of, tournament=r.get("tny_name", ""),
                ))
                diag["loaded"] += 1
    recs.sort(key=lambda m: m.date)
    return recs, diag


def write_csv(rows: list[dict], path: Path) -> None:
    if not rows:
        path.write_text("")
        return
    with open(path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)
