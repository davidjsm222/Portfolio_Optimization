"""Fama-French five-factor loadings and portfolio factor analytics."""

from __future__ import annotations

import numpy as np
import pandas as pd
import statsmodels.api as sm

FACTOR_COLS = ["Mkt-RF", "SMB", "HML", "RMW", "CMA"]


def factor_loadings(returns: pd.DataFrame, ff_factors: pd.DataFrame) -> pd.DataFrame:
    """Per-ticker OLS: excess return ~ constant + five FF factors (inner-aligned dates)."""
    idx = returns.index.intersection(ff_factors.index)
    r = returns.loc[idx]
    ff = ff_factors.loc[idx]

    rows: list[dict] = []
    for ticker in returns.columns:
        y = r[ticker] - ff["RF"]
        X = sm.add_constant(ff[FACTOR_COLS])
        ok = y.notna().to_numpy() & np.isfinite(y.to_numpy())
        ok &= X.notna().to_numpy().all(axis=1)
        y_u = y[ok]
        X_u = X[ok]
        if X_u.shape[0] < X_u.shape[1] + 5:
            continue
        try:
            res = sm.OLS(y_u, X_u).fit()
        except Exception:
            continue
        rows.append(
            {
                "ticker": ticker,
                "alpha": float(res.params["const"]),
                **{c: float(res.params[c]) for c in FACTOR_COLS},
                "r_squared": float(res.rsquared),
                "alpha_tstat": float(res.tvalues["const"]),
                "alpha_pval": float(res.pvalues["const"]),
            }
        )

    if not rows:
        return pd.DataFrame(
            columns=[
                "alpha",
                *FACTOR_COLS,
                "r_squared",
                "alpha_tstat",
                "alpha_pval",
            ]
        )
    out = pd.DataFrame(rows).set_index("ticker")
    return out


def portfolio_factor_exposure(weights: pd.Series, loadings: pd.DataFrame) -> pd.Series:
    """Weighted average of factor betas (Mkt-RF … CMA only)."""
    w = weights.reindex(loadings.index).fillna(0.0)
    exp = loadings[FACTOR_COLS].mul(w, axis=0).sum(axis=0)
    return exp.astype(float)


def factor_attribution(
    returns: pd.DataFrame,
    ff_factors: pd.DataFrame,
    weights: pd.Series,
) -> pd.DataFrame:
    """Daily portfolio excess vs factor mimicking return contributions + residual."""
    loadings = factor_loadings(returns, ff_factors)
    exp = portfolio_factor_exposure(weights, loadings)

    idx = returns.index.intersection(ff_factors.index)
    r = returns.loc[idx]
    ff = ff_factors.loc[idx]
    w = weights.reindex(r.columns).fillna(0.0)

    port_excess = (r.sub(ff["RF"], axis=0)).mul(w, axis=1).sum(axis=1)

    out = pd.DataFrame(index=port_excess.index)
    out["portfolio_excess"] = port_excess
    for c in FACTOR_COLS:
        out[c] = ff[c] * float(exp[c])
    out["residual"] = out["portfolio_excess"] - out[FACTOR_COLS].sum(axis=1)
    return out


def factor_correlation(loadings: pd.DataFrame) -> pd.DataFrame:
    """Correlation matrix of factor betas across tickers."""
    return loadings[FACTOR_COLS].corr()


if __name__ == "__main__":
    from backend.data.cache import get_returns
    from backend.data.fetcher import fetch_ff_factors

    tickers = ["AAPL", "MSFT", "GOOGL", "JPM", "JNJ"]
    start, end = "2020-01-01", "2023-12-31"
    rets = get_returns(tickers, start, end)
    ff = fetch_ff_factors(start, end)
    w = pd.Series(0.2, index=tickers)

    ld = factor_loadings(rets, ff)
    print("=== factor_loadings ===")
    print(ld.round(6))
    print()

    exp = portfolio_factor_exposure(w, ld)
    print("=== portfolio_factor_exposure ===")
    print(exp.round(6))
    print()

    attr = factor_attribution(rets, ff, w)
    print("=== factor_attribution (head) ===")
    print(attr.head().round(6))
    print("shape:", attr.shape)
    print()

    corr = factor_correlation(ld)
    print("=== factor_correlation ===")
    print(corr.round(6))
