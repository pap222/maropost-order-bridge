"""Market microstructure model: spread, slippage, fees, and an optional
over/under-reaction knob so you can ask "how mispriced does the market
have to be for this strategy to pay?".
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class MarketModel:
    half_spread: float = 0.01          # $ per share each side of fair
    slippage: float = 0.0              # extra $ per share paid on every fill
    fee_rate: float = 0.0              # Polymarket sports taker fee rate (set from the help centre; 0 = maker)
    fee_shape: str = "p_1mp"           # 'p_1mp': rate*p*(1-p)*shares  | 'min_p': rate*min(p,1-p)*shares | 'flat': rate*p*shares
    overreaction: float = 0.0          # k>0: on a break/set the market overshoots the fair jump by k, then decays back
    overreaction_decay: int = 4        # points over which the overshoot decays to zero
    tick: float = 0.01

    def displayed(self, fair: float, excess: float = 0.0) -> float:
        """Transient mispricing: `excess` is the current overshoot above fair value.

        A permanent scaling of the fair price is still a martingale, so it can never
        create an edge; only a jump that REVERTS can be sold into.  That is what
        `overreaction` models.
        """
        return min(max(fair + excess, self.tick), 1 - self.tick)

    def quote(self, fair: float, excess: float = 0.0) -> tuple[float, float]:
        p = self.displayed(fair, excess)
        bid = round(max(p - self.half_spread, self.tick) / self.tick) * self.tick
        ask = round(min(p + self.half_spread, 1 - self.tick) / self.tick) * self.tick
        return round(bid, 4), round(ask, 4)

    def fee(self, price: float, shares: float) -> float:
        if self.fee_rate <= 0:
            return 0.0
        if self.fee_shape == "p_1mp":
            return self.fee_rate * price * (1 - price) * shares
        if self.fee_shape == "min_p":
            return self.fee_rate * min(price, 1 - price) * shares
        return self.fee_rate * price * shares

    def buy(self, ask: float, stake: float) -> tuple[float, float, float]:
        """Return (fill_price, shares, fee) for a taker buy of `stake` dollars."""
        px = ask + self.slippage
        shares = stake / px
        return px, shares, self.fee(px, shares)

    def sell(self, bid: float, shares: float) -> tuple[float, float, float]:
        """Return (fill_price, proceeds, fee) for a taker sell."""
        px = max(bid - self.slippage, self.tick)
        return px, px * shares, self.fee(px, shares)
