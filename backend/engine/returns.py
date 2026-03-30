"""Return moments and covariance inputs for portfolio optimization."""

from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.covariance import LedoitWolf


def annualize_returns(returns: pd.DataFrame, periods_per_year: int = 252) -> pd.Series:
    """Mean daily log return per ticker, scaled to annual frequency."""
    return returns.mean(axis=0) * periods_per_year


def sample_covariance(returns: pd.DataFrame, periods_per_year: int = 252) -> pd.DataFrame:
    """Sample covariance of returns, annualized."""
    tickers = list(returns.columns)
    cov = returns.cov().to_numpy()
    annual = cov * periods_per_year
    return pd.DataFrame(annual, index=tickers, columns=tickers)


def ledoit_wolf_covariance(returns: pd.DataFrame, periods_per_year: int = 252) -> pd.DataFrame:
    """Ledoit–Wolf shrunk covariance of returns, annualized."""
    tickers = list(returns.columns)
    lw = LedoitWolf().fit(returns)
    annual = lw.covariance_ * periods_per_year
    return pd.DataFrame(annual, index=tickers, columns=tickers)


def compute_correlation(cov_matrix: pd.DataFrame) -> pd.DataFrame:
    """Correlation matrix from a covariance matrix."""
    c = cov_matrix.to_numpy(dtype=float)
    diag = np.sqrt(np.diag(c))
    denom = np.outer(diag, diag)
    with np.errstate(divide="ignore", invalid="ignore"):
        r = c / denom
    return pd.DataFrame(r, index=cov_matrix.index, columns=cov_matrix.columns)


def summary_stats(returns: pd.DataFrame, periods_per_year: int = 252) -> pd.DataFrame:
    """Per-ticker annualized moments and Sharpe (risk-free = 0)."""
    mean_d = returns.mean(axis=0)
    std_d = returns.std(axis=0, ddof=1)
    annual_return = mean_d * periods_per_year
    annual_vol = std_d * np.sqrt(periods_per_year)
    sharpe = (mean_d / std_d * np.sqrt(periods_per_year)).replace(
        [np.inf, -np.inf], np.nan
    )
    skew = returns.skew(axis=0)
    kurtosis = returns.kurtosis(axis=0)
    out = pd.DataFrame(
        {
            "annual_return": annual_return,
            "annual_vol": annual_vol,
            "sharpe": sharpe,
            "skew": skew,
            "kurtosis": kurtosis,
        },
    )
    out.index.name = "ticker"
    return out


if __name__ == "__main__":
    from backend.data.cache import get_returns

    tickers = ["AAPL", "MSFT", "GOOGL"]
    start, end = "2020-01-01", "2023-12-31"
    r = get_returns(tickers, start, end)

    print("=== annualize_returns ===")
    print(annualize_returns(r).round(6))
    print()

    print("=== sample_covariance (annualized) ===")
    print(sample_covariance(r).round(6))
    print()

    print("=== ledoit_wolf_covariance (annualized) ===")
    print(ledoit_wolf_covariance(r).round(6))
    print()

    print("=== compute_correlation (from sample cov) ===")
    cov_s = sample_covariance(r)
    print(compute_correlation(cov_s).round(6))
    print()

    print("=== summary_stats ===")
    print(summary_stats(r).round(6))
