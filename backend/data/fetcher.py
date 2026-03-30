"""Market data fetch and clean utilities (yfinance, Fama-French via pandas_datareader).

Dependencies: yfinance, pandas, pandas_datareader, numpy
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import yfinance as yf
from pandas_datareader import data as pdr


def fetch_prices(tickers: list[str], start: str, end: str) -> pd.DataFrame:
    """Fetch adjusted close prices, drop illiquid names, fill gaps."""
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
            raise ValueError(f"Failed to fetch data for ticker: {ticker}") from e
        if tdf.empty:
            raise ValueError(f"Failed to fetch data for ticker: {ticker}")
        if "Adj Close" in tdf.columns:
            s = tdf["Adj Close"].copy()
        else:
            s = tdf["Close"].copy()
        s.name = ticker
        columns.append(s)

    prices = pd.concat(columns, axis=1)
    prices.index = pd.to_datetime(prices.index)
    prices.sort_index(inplace=True)

    keep = prices.isna().mean() <= 0.10
    prices = prices.loc[:, keep]

    if prices.empty or prices.shape[1] == 0:
        raise ValueError(f"No data returned for tickers: {tickers}")

    prices = prices.ffill().bfill()

    if prices.empty:
        raise ValueError(f"No data returned for tickers: {tickers}")

    return prices


def fetch_returns(tickers: list[str], start: str, end: str) -> pd.DataFrame:
    """Daily log returns from adjusted closes."""
    p = fetch_prices(tickers, start, end)
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
    _tickers = ["AAPL", "MSFT", "GOOGL"]
    _start, _end = "2020-01-01", "2023-12-31"

    _prices = fetch_prices(_tickers, _start, _end)
    print("fetch_prices", _prices.shape)
    print(_prices.head())
    print()

    _returns = fetch_returns(_tickers, _start, _end)
    print("fetch_returns", _returns.shape)
    print(_returns.head())
    print()

    _ff = fetch_ff_factors(_start, _end)
    print("fetch_ff_factors", _ff.shape)
    print(_ff.head())
