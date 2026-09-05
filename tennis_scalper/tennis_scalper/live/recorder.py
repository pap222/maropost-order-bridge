"""Polymarket tennis order-book recorder (paper-trading data capture).

Records best bid/ask + depth for every active tennis match market so you
can (a) measure REAL spike sizes and how much size the book absorbs at
the spike, and (b) replay the rules against real prices.

Endpoints (public, no key):
  Gamma  https://gamma-api.polymarket.com/events?tag_slug=tennis&active=true&closed=false
  CLOB   https://clob.polymarket.com/book?token_id=<clobTokenId>
Fee schedule for sports markets: check the Polymarket help centre and set
MarketModel.fee_rate / fee_shape accordingly before trusting any P&L.

Usage:
  python -m tennis_scalper.live.recorder --out data/live --interval 2

Output: JSONL, one line per (market, snapshot):
  {"ts", "event", "market", "question", "outcome", "token_id", "bid", "ask",
   "bid_depth_$": {"1c": ..,"3c": ..,"5c": ..}, "ask_depth_$": {...}, "mid"}
NOTE: this only captures prices. To run the rules live you also need a
score feed (server / point / game state); see ScoreFeed below for the
interface the paper trader expects.
"""
from __future__ import annotations

import argparse
import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Optional, Protocol

GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"


class ScoreFeed(Protocol):
    """Anything that can answer 'what is the live score of this match right now'."""

    def state(self, match_key: str) -> Optional[dict]:  # -> {"sets_a","sets_b","games_a","games_b","pts_a","pts_b","a_serving","in_tb"}
        ...


@dataclass
class BookSnapshot:
    ts: float
    event: str
    market: str
    question: str
    outcome: str
    token_id: str
    bid: Optional[float]
    ask: Optional[float]
    bid_depth: dict
    ask_depth: dict

    @property
    def mid(self) -> Optional[float]:
        if self.bid is None or self.ask is None:
            return None
        return (self.bid + self.ask) / 2


def _get(session, url: str, **params):
    r = session.get(url, params=params, timeout=15)
    r.raise_for_status()
    return r.json()


def tennis_markets(session) -> Iterator[dict]:
    """Yield {event, market, question, outcome, token_id} for every open tennis outcome token."""
    offset = 0
    while True:
        events = _get(session, f"{GAMMA}/events", tag_slug="tennis", active="true", closed="false", limit=100, offset=offset)
        if not events:
            return
        for ev in events:
            for m in ev.get("markets", []):
                if m.get("closed"):
                    continue
                try:
                    outcomes = json.loads(m.get("outcomes", "[]"))
                    tokens = json.loads(m.get("clobTokenIds", "[]"))
                except json.JSONDecodeError:
                    continue
                for o, t in zip(outcomes, tokens):
                    yield {"event": ev.get("slug", ""), "market": m.get("slug", ""), "question": m.get("question", ""),
                           "outcome": o, "token_id": t}
        offset += 100


def _depth(levels: list[dict], best: float, side: str, widths=(0.01, 0.03, 0.05)) -> dict:
    out = {}
    for w in widths:
        lim = best - w if side == "bid" else best + w
        usd = 0.0
        for lv in levels:
            p, s = float(lv["price"]), float(lv["size"])
            if (side == "bid" and p >= lim) or (side == "ask" and p <= lim):
                usd += p * s
        out[f"{int(w*100)}c"] = round(usd, 2)
    return out


def snapshot(session, meta: dict) -> BookSnapshot:
    book = _get(session, f"{CLOB}/book", token_id=meta["token_id"])
    bids = sorted(book.get("bids", []), key=lambda x: -float(x["price"]))
    asks = sorted(book.get("asks", []), key=lambda x: float(x["price"]))
    bid = float(bids[0]["price"]) if bids else None
    ask = float(asks[0]["price"]) if asks else None
    return BookSnapshot(
        ts=time.time(), event=meta["event"], market=meta["market"], question=meta["question"], outcome=meta["outcome"],
        token_id=meta["token_id"], bid=bid, ask=ask,
        bid_depth=_depth(bids, bid, "bid") if bid is not None else {},
        ask_depth=_depth(asks, ask, "ask") if ask is not None else {},
    )


def record(out_dir: Path, interval: float = 2.0, refresh_markets_every: float = 300.0, max_seconds: Optional[float] = None) -> None:
    import requests  # optional dependency

    out_dir.mkdir(parents=True, exist_ok=True)
    session = requests.Session()
    session.headers["User-Agent"] = "tennis-scalper-recorder/0.1"
    markets: list[dict] = []
    last_refresh = 0.0
    start = time.time()
    while True:
        now = time.time()
        if now - last_refresh > refresh_markets_every:
            try:
                markets = list(tennis_markets(session))
                last_refresh = now
                print(f"[{time.strftime('%H:%M:%S')}] tracking {len(markets)} outcome tokens")
            except Exception as e:  # keep recording with the stale list
                print("market refresh failed:", e)
        day_file = out_dir / (time.strftime("%Y-%m-%d") + ".jsonl")
        with open(day_file, "a") as f:
            for meta in markets:
                try:
                    s = snapshot(session, meta)
                except Exception as e:
                    print("book failed", meta["market"], e)
                    continue
                f.write(json.dumps({**s.__dict__, "mid": s.mid}) + "\n")
        if max_seconds and time.time() - start > max_seconds:
            return
        time.sleep(max(0.0, interval - (time.time() - now)))


def main(argv=None) -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=Path("data/live"))
    ap.add_argument("--interval", type=float, default=2.0)
    ap.add_argument("--max-seconds", type=float, default=None)
    a = ap.parse_args(argv)
    record(a.out, a.interval, max_seconds=a.max_seconds)


if __name__ == "__main__":
    main()
