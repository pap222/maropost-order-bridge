from tennis_scalper.backtest import Backtester, price_path
from tennis_scalper.pricing import MarketModel
from tennis_scalper.simulate import simulate_matches
from tennis_scalper.stats import first_touch_table, summarize
from tennis_scalper.strategies import DEFAULT_RULES, Rule


def test_price_path_is_bounded_and_settles():
    m = simulate_matches(5, seed=3)[0]
    path = price_path(m, MarketModel())
    assert all(0 < pp.fair_ud < 1 for pp in path[:-1])
    end = path[-1].fair_ud
    assert (end > 0.99) == (m.winner == m.underdog)


def test_fair_market_has_roughly_zero_expectancy():
    matches = simulate_matches(600, seed=7)
    rule = Rule("t", "pre_match", 0.0, 1.0, 0.15, 0.10, max_hold="match")
    bt = Backtester(MarketModel(half_spread=0.0), [rule], stake=100)
    trades, _ = bt.run(matches)
    s = summarize(trades, 100)
    assert s["trades"] == 600
    assert abs(s["expectancy_pct_of_stake"]) < 6  # noise band, not a bias


def test_costs_hurt_and_control_rule_runs():
    matches = simulate_matches(200, seed=11)
    free = Backtester(MarketModel(half_spread=0.0), DEFAULT_RULES, 100).run(matches)[0]
    paid = Backtester(MarketModel(half_spread=0.02, fee_rate=0.05), DEFAULT_RULES, 100).run(matches)[0]
    assert sum(t.pnl for t in paid) < sum(t.pnl for t in free)


def test_sell_on_break_exits_on_break():
    matches = simulate_matches(300, seed=5)
    rule = Rule("brk", "pre_match", 0.0, 1.0, 9.0, 9.0, exit_on="underdog_break", max_hold="set1")
    trades, summaries = Backtester(MarketModel(), [rule], 100).run(matches)
    reasons = {t.exit_reason for t in trades}
    assert "underdog_break" in reasons
    brk = [t for t in trades if t.exit_reason == "underdog_break"]
    # a break-back after being broken first can exit below entry, but most break exits are green
    assert sum(t.pnl_cents > 0 for t in brk) / len(brk) > 0.5
    assert first_touch_table(summaries)
