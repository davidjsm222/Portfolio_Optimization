"""Tail risk metrics and CVaR portfolio optimization."""

from __future__ import annotations

import cvxpy as cp
import numpy as np
import pandas as pd


def portfolio_returns(weights: pd.Series, returns: pd.DataFrame) -> pd.Series:
    """Daily portfolio returns as weighted sum of asset returns."""
    w = weights.reindex(returns.columns).fillna(0.0)
    return (returns * w).sum(axis=1)


def historical_var(port_returns: pd.Series, confidence: float = 0.95) -> float:
    """Historical VaR (return space); negative means loss."""
    return float(np.percentile(port_returns.to_numpy(), (1.0 - confidence) * 100.0))


def historical_cvar(port_returns: pd.Series, confidence: float = 0.95) -> float:
    """Mean of returns strictly below the VaR threshold."""
    var = historical_var(port_returns, confidence)
    tail = port_returns[port_returns < var]
    if tail.empty:
        return float("nan")
    return float(tail.mean())


def max_drawdown(port_returns: pd.Series) -> float:
    """Most negative drawdown from a simple cumulative wealth index."""
    wealth = (1.0 + port_returns).cumprod()
    peak = wealth.cummax()
    dd = (wealth - peak) / peak
    return float(dd.min())


def drawdown_series(port_returns: pd.Series) -> pd.Series:
    """Time series of drawdowns."""
    wealth = (1.0 + port_returns).cumprod()
    peak = wealth.cummax()
    return ((wealth - peak) / peak).astype(float)


def risk_summary(
    weights: pd.Series,
    returns: pd.DataFrame,
    confidence: float = 0.95,
) -> dict:
    """Combine VaR, CVaR, drawdown, annual vol, skew, kurtosis for portfolio."""
    pr = portfolio_returns(weights, returns)
    return {
        "var_95": historical_var(pr, confidence),
        "cvar_95": historical_cvar(pr, confidence),
        "max_drawdown": max_drawdown(pr),
        "volatility": float(pr.std(ddof=1) * np.sqrt(252.0)),
        "skew": float(pr.skew()),
        "kurtosis": float(pr.kurtosis()),
    }


def _clean_weights(w: np.ndarray) -> np.ndarray | None:
    w = np.asarray(w, dtype=float).copy()
    w[np.abs(w) < 1e-4] = 0.0
    s = float(w.sum())
    if s <= 0:
        return None
    return w / s


def cvar_optimize(
    mu: pd.Series,
    returns: pd.DataFrame,
    target_return: float | None = None,
    confidence: float = 0.95,
    allow_short: bool = False,
) -> dict | None:
    """Minimize Rockafellar-Uryasev CVaR with scenario matrix of asset returns."""
    labels = list(returns.columns)
    mu_arr = mu.reindex(labels)
    if mu_arr.isna().any():
        return None
    mu_a = mu_arr.to_numpy(dtype=float)
    R = returns.to_numpy(dtype=float)
    T, n = R.shape
    if T == 0 or n == 0:
        return None

    w = cp.Variable(n)
    alpha = cp.Variable()
    u = cp.Variable(T)
    inv = 1.0 / (T * (1.0 - confidence))

    cons: list = [
        u >= -R @ w - alpha,
        u >= 0,
        cp.sum(w) == 1,
    ]
    if not allow_short:
        cons.append(w >= 0)
    if target_return is not None:
        cons.append(mu_a @ w >= float(target_return))

    prob = cp.Problem(cp.Minimize(alpha + inv * cp.sum(u)), cons)
    try:
        prob.solve(solver=cp.ECOS)
    except Exception:
        return None

    if w.value is None or prob.status not in {cp.OPTIMAL, cp.OPTIMAL_INACCURATE}:
        return None

    wv = _clean_weights(np.asarray(w.value, dtype=float).ravel())
    if wv is None:
        return None

    Sigma = returns.cov().to_numpy(dtype=float) * 252.0
    port_ret = float(wv @ mu_a)
    port_var = float(wv @ Sigma @ wv)
    vol = float(np.sqrt(max(port_var, 0.0)))
    sharpe = port_ret / vol if vol > 1e-12 else float("nan")

    return {
        "weights": pd.Series(wv, index=labels),
        "return": port_ret,
        "volatility": vol,
        "sharpe": float(sharpe),
        "var": float(alpha.value) if alpha.value is not None else float("nan"),
        "cvar": float(prob.value) if prob.value is not None else float("nan"),
    }


if __name__ == "__main__":
    from backend.data.cache import get_returns
    from backend.engine.returns import annualize_returns

    tickers = ["AAPL", "MSFT", "GOOGL", "JPM", "JNJ"]
    start, end = "2020-01-01", "2023-12-31"
    rets = get_returns(tickers, start, end)
    mu = annualize_returns(rets)
    w_eq = pd.Series(1.0 / len(tickers), index=tickers)

    print("=== risk_summary (equal weights) ===")
    print(risk_summary(w_eq, rets))
    print()

    print("=== cvar_optimize (no target return) ===")
    print(cvar_optimize(mu, rets))
    print()

    print("=== cvar_optimize (target return 0.15) ===")
    print(cvar_optimize(mu, rets, target_return=0.15))
