"""Convex and numerical portfolio optimizers (cvxpy + scipy)."""

from __future__ import annotations

import cvxpy as cp
import numpy as np
import pandas as pd
from scipy.optimize import minimize


def _warn_failure(name: str, err: BaseException) -> None:
    print(f"WARNING: {name} failed: {err}")


def _align_mu(mu: pd.Series, cov: pd.DataFrame) -> tuple[np.ndarray, list]:
    tickers = list(cov.columns)
    m = mu.reindex(tickers)
    if m.isna().any():
        raise ValueError("mu has NaN after aligning with cov columns")
    return m.to_numpy(dtype=float), tickers


def _clean_weights(w: np.ndarray) -> np.ndarray | None:
    w = np.asarray(w, dtype=float).copy()
    w[np.abs(w) < 1e-4] = 0.0
    s = float(w.sum())
    if s <= 0:
        return None
    return w / s


def _portfolio_metrics(
    w: np.ndarray, mu_arr: np.ndarray, Sigma: np.ndarray, rf: float
) -> tuple[np.ndarray, float, float, float]:
    w = _clean_weights(w)
    if w is None:
        raise ValueError("weights sum to zero after cleanup")
    port_ret = float(w @ mu_arr)
    port_var = float(w @ Sigma @ w)
    vol = float(np.sqrt(max(port_var, 0.0)))
    sharpe = (port_ret - rf) / vol if vol > 1e-12 else float("nan")
    return w, port_ret, vol, float(sharpe)


def _result_dict(
    w: np.ndarray,
    mu_arr: np.ndarray,
    Sigma: np.ndarray,
    labels: list,
    rf: float = 0.0,
) -> dict | None:
    try:
        w, port_ret, vol, sharpe = _portfolio_metrics(w, mu_arr, Sigma, rf)
    except ValueError:
        return None
    return {
        "weights": pd.Series(w, index=labels),
        "return": port_ret,
        "volatility": vol,
        "sharpe": sharpe,
    }


def _cvxpy_ok(problem: cp.Problem, w_var: cp.Variable) -> bool:
    if w_var.value is None:
        return False
    st = problem.status
    return st in {cp.OPTIMAL, cp.OPTIMAL_INACCURATE}


def _solve_min_variance_weights(
    Sigma: np.ndarray, allow_short: bool
) -> np.ndarray | None:
    n = Sigma.shape[0]
    w = cp.Variable(n)
    obj = cp.Minimize(cp.quad_form(w, Sigma))
    cons: list = [cp.sum(w) == 1]
    if not allow_short:
        cons.append(w >= 0)
    prob = cp.Problem(obj, cons)
    try:
        prob.solve(solver=cp.OSQP)
    except Exception as e:
        _warn_failure("min_variance (cvxpy)", e)
        return None
    if not _cvxpy_ok(prob, w):
        _warn_failure(
            "min_variance (cvxpy)",
            RuntimeError(f"status={prob.status}"),
        )
        return None
    return np.asarray(w.value, dtype=float).ravel()


def min_variance(
    mu: pd.Series, cov: pd.DataFrame, allow_short: bool = False
) -> dict | None:
    """Minimum variance portfolio; Sharpe uses rf=0."""
    mu_arr, labels = _align_mu(mu, cov)
    Sigma = cov.to_numpy(dtype=float)
    try:
        w = _solve_min_variance_weights(Sigma, allow_short)
    except Exception as e:
        _warn_failure("min_variance", e)
        return None
    if w is None:
        return None
    return _result_dict(w, mu_arr, Sigma, labels, rf=0.0)


def max_sharpe(
    mu: pd.Series,
    cov: pd.DataFrame,
    rf: float = 0.0,
    allow_short: bool = False,
) -> dict | None:
    """Maximize Sharpe via minimizing its negative (scipy SLSQP)."""
    mu_arr, labels = _align_mu(mu, cov)
    Sigma = cov.to_numpy(dtype=float)
    n = len(mu_arr)

    def neg_sharpe(w: np.ndarray) -> float:
        w = np.asarray(w, dtype=float)
        ex = float(w @ mu_arr - rf)
        var = float(w @ Sigma @ w)
        den = np.sqrt(max(var, 1e-12))
        return -(ex / den)

    x0 = np.full(n, 1.0 / n)
    if not allow_short:
        bounds = [(0.0, 1.0)] * n
    else:
        bounds = [(None, None)] * n
    cons = ({"type": "eq", "fun": lambda w: float(np.sum(w) - 1.0)},)

    try:
        res = minimize(
            neg_sharpe,
            x0,
            method="SLSQP",
            bounds=bounds,
            constraints=cons,
        )
    except Exception as e:
        _warn_failure("max_sharpe", e)
        return None

    if not res.success or res.x is None:
        _warn_failure(
            "max_sharpe",
            RuntimeError(getattr(res, "message", "optimization failed")),
        )
        return None

    return _result_dict(np.asarray(res.x, dtype=float), mu_arr, Sigma, labels, rf=rf)


def efficient_frontier(
    mu: pd.Series,
    cov: pd.DataFrame,
    n_points: int = 50,
    allow_short: bool = False,
) -> pd.DataFrame:
    """Minimum variance at each target expected return; skip infeasible targets."""
    mu_arr, labels = _align_mu(mu, cov)
    Sigma = cov.to_numpy(dtype=float)
    n = len(mu_arr)

    w_mv = _solve_min_variance_weights(Sigma, allow_short)
    if w_mv is None:
        return pd.DataFrame()

    r_mv = float(mu_arr @ w_mv)
    r_max = float(mu_arr.max())
    targets = np.linspace(r_mv, r_max, n_points)

    rows: list[dict] = []
    for target_return in targets:
        w = cp.Variable(n)
        obj = cp.Minimize(cp.quad_form(w, Sigma))
        cons: list = [
            cp.sum(w) == 1,
            mu_arr @ w == target_return,
        ]
        if not allow_short:
            cons.append(w >= 0)
        prob = cp.Problem(obj, cons)
        try:
            prob.solve(solver=cp.OSQP)
        except Exception as e:
            _warn_failure("efficient_frontier (cvxpy)", e)
            continue
        if not _cvxpy_ok(prob, w):
            _warn_failure(
                "efficient_frontier (cvxpy)",
                RuntimeError(f"status={prob.status}"),
            )
            continue
        wv = np.asarray(w.value, dtype=float).ravel()
        wc = _clean_weights(wv)
        if wc is None:
            continue
        port_var = float(wc @ Sigma @ wc)
        vol = float(np.sqrt(max(port_var, 0.0)))
        pret = float(wc @ mu_arr)
        sharpe = (pret - 0.0) / vol if vol > 1e-12 else float("nan")
        row = {
            "return": pret,
            "volatility": vol,
            "sharpe": sharpe,
        }
        for i, t in enumerate(labels):
            row[t] = wc[i]
        rows.append(row)

    if not rows:
        return pd.DataFrame()
    return pd.DataFrame(rows)


def _risk_parity_objective(w: np.ndarray, Sigma: np.ndarray) -> float:
    w = np.asarray(w, dtype=float)
    Sw = Sigma @ w
    port_var = float(w @ Sw)
    port_var = max(port_var, 1e-12)
    rc = w * Sw / port_var
    target = 1.0 / len(w)
    return float(np.sum((rc - target) ** 2))


def risk_parity(
    cov: pd.DataFrame,
    mu: pd.Series | None = None,
) -> dict | None:
    """Equal risk contributions; optional mu for return and Sharpe (rf=0)."""
    labels = list(cov.columns)
    Sigma = cov.to_numpy(dtype=float)
    n = Sigma.shape[0]
    x0 = np.full(n, 1.0 / n)
    x0 = np.clip(x0, 0.01, 1.0)
    x0 = x0 / x0.sum()
    bounds = [(0.01, 1.0)] * n
    cons = ({"type": "eq", "fun": lambda w: float(np.sum(w) - 1.0)},)

    try:
        res = minimize(
            _risk_parity_objective,
            x0,
            args=(Sigma,),
            method="SLSQP",
            bounds=bounds,
            constraints=cons,
        )
    except Exception as e:
        _warn_failure("risk_parity", e)
        return None

    if not res.success or res.x is None:
        _warn_failure(
            "risk_parity",
            RuntimeError(getattr(res, "message", "optimization failed")),
        )
        return None

    w = np.asarray(res.x, dtype=float).ravel()
    w = _clean_weights(w)
    if w is None:
        _warn_failure("risk_parity", RuntimeError("weights invalid after cleanup"))
        return None

    port_var = float(w @ Sigma @ w)
    vol = float(np.sqrt(max(port_var, 0.0)))

    out: dict = {
        "weights": pd.Series(w, index=labels),
        "volatility": vol,
    }

    if mu is None:
        out["return"] = None
        out["sharpe"] = None
        return out

    mu_arr, _ = _align_mu(mu, cov)
    pret = float(w @ mu_arr)
    sharpe = (pret - 0.0) / vol if vol > 1e-12 else float("nan")
    out["return"] = pret
    out["sharpe"] = float(sharpe)
    return out


if __name__ == "__main__":
    from backend.data.cache import get_returns
    from backend.engine.returns import annualize_returns, ledoit_wolf_covariance

    tickers = ["AAPL", "MSFT", "GOOGL", "JPM", "JNJ"]
    start, end = "2020-01-01", "2023-12-31"
    rets = get_returns(tickers, start, end)
    mu_s = annualize_returns(rets)
    cov_df = ledoit_wolf_covariance(rets)

    print("=== min_variance ===")
    print(min_variance(mu_s, cov_df))
    print()

    print("=== max_sharpe ===")
    print(max_sharpe(mu_s, cov_df))
    print()

    print("=== efficient_frontier ===")
    ef = efficient_frontier(mu_s, cov_df, n_points=50)
    print("shape:", ef.shape)
    print(ef.head(3).round(6))
    print("...")
    print(ef.tail(3).round(6))
    print()

    print("=== risk_parity (with mu) ===")
    print(risk_parity(cov_df, mu_s))
    print()

    print("=== risk_parity (mu=None) ===")
    print(risk_parity(cov_df, None))
