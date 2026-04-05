"""Market data fetch and cleaning (yfinance, Fama-French via pandas_datareader).

Dependencies: yfinance, pandas, pandas_datareader, numpy
"""

from __future__ import annotations

import logging
from datetime import date, timedelta
from typing import Optional

import numpy as np
import pandas as pd
import yfinance as yf
from pandas_datareader import data as pdr

_logger = logging.getLogger(__name__)


def _adj_close_from_download(tdf: pd.DataFrame, ticker: str) -> Optional[pd.Series]:
    """Extract a single adjusted-close series from a yfinance DataFrame (flat or MultiIndex)."""
    if tdf.empty:
        return None
    if isinstance(tdf.columns, pd.MultiIndex):
        level0 = tdf.columns.get_level_values(0)
        if "Adj Close" in level0:
            part = tdf.loc[:, tdf.columns.get_level_values(0) == "Adj Close"]
        elif "Close" in level0:
            part = tdf.loc[:, tdf.columns.get_level_values(0) == "Close"]
        else:
            return None
        if part.shape[1] == 1:
            s = part.iloc[:, 0].copy()
        else:
            if ticker in part.columns.get_level_values(1):
                idx = [
                    i
                    for i, c in enumerate(part.columns)
                    if c[1] == ticker or str(c[1]).upper() == ticker.upper()
                ]
                s = part.iloc[:, idx[0]].copy() if idx else part.iloc[:, 0].copy()
            else:
                s = part.iloc[:, 0].copy()
    elif "Adj Close" in tdf.columns:
        s = tdf["Adj Close"].copy()
    elif "Close" in tdf.columns:
        s = tdf["Close"].copy()
    else:
        return None
    s.index = pd.to_datetime(s.index)
    return s


def _collect_price_series(tickers: list[str], start: str, end: str) -> list[pd.Series]:
    """Download one series per ticker; skip failures with a printed warning."""
    columns: list[pd.Series] = []
    for ticker in tickers:
        try:
            tdf = yf.download(
                ticker,
                start=start,
                end=end,
                progress=False,
                auto_adjust=False,
                threads=False,
            )
        except Exception as e:
            _logger.debug("yfinance error for %s: %s", ticker, e)
            print(f"[fetcher] WARNING: skipping {ticker} — no data returned")
            continue
        s = _adj_close_from_download(tdf, ticker)
        if s is None or len(s) == 0:
            print(f"[fetcher] WARNING: skipping {ticker} — no data returned")
            continue
        if s.isna().all():
            print(f"[fetcher] WARNING: skipping {ticker} — no data returned")
            continue
        s.name = ticker
        columns.append(s)
    return columns


def _finalize_price_frame(columns: list[pd.Series], requested: list[str]) -> pd.DataFrame:
    """Align series, apply missing threshold, ffill/bfill; raise if nothing usable."""
    if not columns:
        raise ValueError(
            f"No data returned for any of the requested tickers: {requested}"
        )

    prices = pd.concat(columns, axis=1)
    prices.index = pd.to_datetime(prices.index)
    prices.sort_index(inplace=True)

    keep = prices.isna().mean() <= 0.10
    prices = prices.loc[:, keep]

    if prices.empty or prices.shape[1] == 0:
        raise ValueError(
            f"No data returned for any of the requested tickers after "
            f"missing-data filter: {requested}"
        )

    prices = prices.ffill().bfill()

    if prices.empty:
        raise ValueError(f"No data returned for tickers: {requested}")

    return prices


def fetch_prices(tickers: list[str], start: str, end: str) -> pd.DataFrame:
    """Fetch adjusted close prices, drop bad tickers, then apply 10% NaN threshold."""
    if not tickers:
        raise ValueError("tickers list is empty")

    uniq_order = list(dict.fromkeys(tickers))
    columns = _collect_price_series(uniq_order, start, end)
    return _finalize_price_frame(columns, uniq_order)


def fetch_returns(tickers: list[str], start: str, end: str) -> pd.DataFrame:
    """Daily log returns from adjusted closes. Logs tickers dropped vs requested."""
    uniq_order = list(dict.fromkeys(tickers))
    p = fetch_prices(uniq_order, start, end)
    missing = [t for t in uniq_order if t not in p.columns]
    if missing:
        print(
            f"[fetcher] NOTE: fetch_returns — {len(missing)} ticker(s) not in price "
            f"result (skipped or failed thresholds): {missing}"
        )
    r = np.log(p / p.shift(1))
    return r.iloc[1:]


def fetch_prices_live(tickers: list[str], lookback_days: int = 400) -> pd.DataFrame:
    """
    Fresh yfinance download from (today - lookback_days) through today (inclusive).
    Does not use the SQLite cache.
    """
    if not tickers:
        raise ValueError("tickers list is empty")

    end_d = date.today()
    start_d = end_d - timedelta(days=int(lookback_days))
    start_s = start_d.isoformat()
    # yfinance end date is exclusive; add one day so today's session can appear
    end_excl = (end_d + timedelta(days=1)).isoformat()

    uniq_order = list(dict.fromkeys(tickers))
    columns = _collect_price_series(uniq_order, start_s, end_excl)
    return _finalize_price_frame(columns, uniq_order)


def fetch_returns_live(tickers: list[str], lookback_days: int = 400) -> pd.DataFrame:
    """Log returns from fetch_prices_live; same dropped-ticker logging as fetch_returns."""
    uniq_order = list(dict.fromkeys(tickers))
    p = fetch_prices_live(uniq_order, lookback_days=lookback_days)
    missing = [t for t in uniq_order if t not in p.columns]
    if missing:
        print(
            f"[fetcher] NOTE: fetch_returns_live — {len(missing)} ticker(s) not in price "
            f"result (skipped or failed thresholds): {missing}"
        )
    r = np.log(p / p.shift(1))
    return r.iloc[1:]


def fetch_ff_factors(start: str, end: str) -> pd.DataFrame:
    """Fama-French 5 factors (2x3) daily, decimals not percent."""
    ff = pdr.DataReader(
        "F-F_Research_Data_5_Factors_2x3_daily",
        "famafrench",
        start,
        end,
    )
    df = ff[0].copy()
    for col in df.columns:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df = df.dropna(how="all")
    df = df / 100.0
    return df


if __name__ == "__main__":
    from backend.data.universe import get_universe

    _start, _end = "2020-01-01", "2023-12-31"

    _mixed = ["AAPL", "MSFT", "FAKEXYZ", "GOOGL"]
    print("=== fetch_prices with bad ticker FAKEXYZ ===")
    _prices_mixed = fetch_prices(_mixed, _start, _end)
    print("shape (expect 3 cols):", _prices_mixed.shape)
    print("columns:", list(_prices_mixed.columns))
    print("tail:")
    print(_prices_mixed.tail())
    print()

    print("=== fetch_returns (same list) ===")
    _returns_mixed = fetch_returns(_mixed, _start, _end)
    print("shape:", _returns_mixed.shape)
    print(_returns_mixed.tail(3))
    print()

    _sp50 = get_universe("SP50")
    print("=== fetch_returns_live SP50 (lookback_days=400) ===")
    _r_live = fetch_returns_live(_sp50, lookback_days=400)
    print("shape:", _r_live.shape)
    print("last 5 rows:")
    print(_r_live.tail(5))
    print()

    _ff = fetch_ff_factors(_start, _end)
    print("=== fetch_ff_factors (sanity) ===", _ff.shape)
    print(_ff.head())
