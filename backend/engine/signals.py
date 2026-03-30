"""Quantitative signals for forward-looking expected return tilts."""

from __future__ import annotations

import numpy as np
import pandas as pd


def _rank_normalize(s: pd.Series) -> pd.Series:
    """Map ranks to [-1, 1]; tied scores share average rank."""
    n = len(s)
    if n <= 1:
        return pd.Series(0.0, index=s.index, dtype=float)
    rnk = s.rank(method="average")
    return ((rnk - 1.0) / (n - 1.0) * 2.0 - 1.0).astype(float)


def _zscore(s: pd.Series) -> pd.Series:
    mu = s.mean()
    sd = s.std(ddof=1)
    if sd is None or not np.isfinite(sd) or sd < 1e-12:
        return pd.Series(0.0, index=s.index, dtype=float)
    return ((s - mu) / sd).astype(float)


def momentum_signal(
    returns: pd.DataFrame, lookback: int = 252, skip: int = 21
) -> pd.Series:
    """Time-series momentum: cum return from (t - lookback) to (t - skip)."""
    T = len(returns.index)
    if lookback > T or lookback <= skip:
        return pd.Series(0.0, index=returns.columns, dtype=float)

    end = T - 1
    i_skip = end - skip
    i_lb = end - lookback
    if i_lb < 0 or i_skip < 0 or i_skip <= i_lb:
        return pd.Series(0.0, index=returns.columns, dtype=float)

    scores: dict[str, float] = {}
    for t in returns.columns:
        r = returns[t].astype(float)
        w = (1.0 + r).cumprod()
        scores[str(t)] = float(w.iloc[i_skip] / w.iloc[i_lb] - 1.0)

    return pd.Series(scores, dtype=float)


def cross_sectional_momentum(
    returns: pd.DataFrame, lookback: int = 252, skip: int = 21
) -> pd.Series:
    """Momentum scores rank-normalized to [-1, 1]."""
    raw = momentum_signal(returns, lookback=lookback, skip=skip)
    return _rank_normalize(raw)


def mean_reversion_signal(
    returns: pd.DataFrame, lookback: int = 5
) -> pd.Series:
    """Short-term mean reversion tilt; rank-normalized to [-1, 1]."""
    T = len(returns.index)
    if lookback > T:
        raw = pd.Series(0.0, index=returns.columns, dtype=float)
        return _rank_normalize(raw)

    end = T - 1
    denom_idx = end - lookback
    if denom_idx < 0:
        raw = pd.Series(0.0, index=returns.columns, dtype=float)
        return _rank_normalize(raw)

    scores: dict[str, float] = {}
    for t in returns.columns:
        r = returns[t].astype(float)
        w = (1.0 + r).cumprod()
        cum = float(w.iloc[end] / w.iloc[denom_idx] - 1.0)
        scores[str(t)] = -cum

    raw = pd.Series(scores, dtype=float)
    return _rank_normalize(raw)


def signal_to_expected_returns(
    signal: pd.Series,
    historical_mu: pd.Series,
    signal_weight: float = 0.3,
) -> pd.Series:
    """Blend historical means with a scaled signal."""
    sig = signal.reindex(historical_mu.index).fillna(0.0)
    h = historical_mu.astype(float)
    absm = np.abs(h.to_numpy(dtype=float))
    scale = float(np.nanmean(absm)) if absm.size else 1.0
    if not np.isfinite(scale) or scale < 1e-12:
        scale = 1.0
    signal_scaled = sig * scale
    return ((1.0 - signal_weight) * h + signal_weight * signal_scaled).astype(float)


def combined_signal(
    returns: pd.DataFrame,
    weights: dict | None = None,
) -> pd.Series:
    """Z-score each signal and combine with default or custom weights."""
    if weights is None:
        weights = {
            "momentum": 0.5,
            "cross_sectional": 0.3,
            "mean_reversion": 0.2,
        }
    s_m = _zscore(momentum_signal(returns))
    s_x = _zscore(cross_sectional_momentum(returns))
    s_r = _zscore(mean_reversion_signal(returns))
    idx = returns.columns
    s_m = s_m.reindex(idx).fillna(0.0)
    s_x = s_x.reindex(idx).fillna(0.0)
    s_r = s_r.reindex(idx).fillna(0.0)
    return (
        weights["momentum"] * s_m
        + weights["cross_sectional"] * s_x
        + weights["mean_reversion"] * s_r
    ).astype(float)


if __name__ == "__main__":
    from backend.data.cache import get_returns
    from backend.engine.returns import annualize_returns

    tickers = ["AAPL", "MSFT", "GOOGL", "JPM", "JNJ"]
    start, end = "2020-01-01", "2023-12-31"
    rets = get_returns(tickers, start, end)
    hist_mu = annualize_returns(rets)

    print("=== momentum_signal ===")
    print(momentum_signal(rets).round(6))
    print()

    print("=== cross_sectional_momentum ===")
    print(cross_sectional_momentum(rets).round(6))
    print()

    print("=== mean_reversion_signal ===")
    print(mean_reversion_signal(rets).round(6))
    print()

    comb = combined_signal(rets)
    print("=== combined_signal ===")
    print(comb.round(6))
    print()

    mus_adj = signal_to_expected_returns(comb, hist_mu, signal_weight=0.3)
    print("=== signal_to_expected_returns (combined_signal, weight=0.3) ===")
    print(mus_adj.round(6))
    print()

    cmp = pd.DataFrame({"historical_mu": hist_mu, "adjusted_mu": mus_adj}).round(6)
    print("=== historical vs adjusted expected returns ===")
    print(cmp)
