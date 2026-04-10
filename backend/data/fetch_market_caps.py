"""
Fetch current market caps for S&P 500 stocks and save as ranking reference.

Run once: ./venv/bin/python -m backend.data.fetch_market_caps
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd
import yfinance as yf


def _market_cap_for_ticker(t: str) -> float:
    tk = yf.Ticker(t)
    try:
        fi = tk.fast_info
        if isinstance(fi, dict):
            mc = fi.get("market_cap") or fi.get("marketCap") or 0
        else:
            mc = getattr(fi, "market_cap", None) or getattr(fi, "marketCap", None) or 0
        if mc:
            return float(mc)
    except Exception:
        pass
    try:
        inf = tk.info or {}
        mc = inf.get("marketCap") or inf.get("totalAssets") or 0
        return float(mc) if mc else 0.0
    except Exception:
        return 0.0


def fetch_and_save() -> None:
    data_dir = Path(__file__).resolve().parent
    current = pd.read_csv(data_dir / "sp500_current.csv")
    tickers = current["Symbol"].astype(str).str.replace(".", "-", regex=False).tolist()
    n = len(tickers)
    print(f"Fetching market caps for {n} tickers...")
    caps: dict[str, float] = {}
    for i, t in enumerate(tickers):
        caps[t] = _market_cap_for_ticker(t)
        if i % 50 == 0:
            print(f"  {i}/{n}...")
    df = pd.DataFrame(list(caps.items()), columns=["ticker", "market_cap"])
    df = df.sort_values("market_cap", ascending=False).reset_index(drop=True)
    df["rank"] = df.index + 1
    out = data_dir / "sp500_market_cap_ranks.csv"
    df.to_csv(out, index=False)
    print(f"Saved {len(df)} tickers to {out}")
    print(f"Top 10: {df.head(10)['ticker'].tolist()}")


if __name__ == "__main__":
    fetch_and_save()
