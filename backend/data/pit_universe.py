"""
Point-in-time universe construction for machAlpha.

Data sources:
- sp500_history.csv: S&P 500 membership at each date since 1996 (fja05680/sp500)
- sp500_market_cap_ranks.csv: current market cap rankings for SP50/SP100 derivation

SP500: exact point-in-time membership from history CSV
SP100: intersection of SP500-at-date with current top-100 by market cap (among names in SP500 that day)
SP50: intersection of SP500-at-date with current top-50 by market cap

Limitation: market cap rankings are current, not historical. SP50/SP100 composition may differ from
true historical top-50/100. Disclose in research documentation.
"""

from __future__ import annotations

import re
from pathlib import Path

import pandas as pd

DATA_DIR = Path(__file__).resolve().parent
HISTORY_PATH = DATA_DIR / "sp500_history.csv"
RANKS_PATH = DATA_DIR / "sp500_market_cap_ranks.csv"

_REMOVAL_SUFFIX = re.compile(r"^(.+)-(\d{6}|\d{8})$")

TICKER_MAP = {
    "BRK.B": "BRK-B",
    "BRK.A": "BRK-A",
    "BF.B": "BF-B",
    "BF.A": "BF-A",
    "FB": "META",
    "DWDP": "DOW",
}

_history: pd.DataFrame | None = None
_ranks: pd.DataFrame | None = None


def _strip_listing_suffix(raw: str) -> str:
    """fja05680 uses TICKER-YYYYMM or TICKER-YYYYMMDD for removed names."""
    t = raw.strip()
    if not t:
        return t
    m = _REMOVAL_SUFFIX.match(t)
    if m:
        return m.group(1)
    return t


def _normalize(ticker: str) -> str:
    t = _strip_listing_suffix(ticker).strip().upper()
    if not t:
        return t
    if t in TICKER_MAP:
        return TICKER_MAP[t]
    return t.replace(".", "-")


def _parse_tickers_cell(cell: str) -> list[str]:
    if cell is None or (isinstance(cell, float) and pd.isna(cell)):
        return []
    parts = str(cell).split(",")
    out: list[str] = []
    for p in parts:
        n = _normalize(p)
        if n:
            out.append(n)
    return sorted(set(out))


def _load_history() -> pd.DataFrame:
    global _history
    if _history is not None:
        return _history
    df = pd.read_csv(HISTORY_PATH)
    if "date" not in df.columns or "tickers" not in df.columns:
        raise ValueError(f"{HISTORY_PATH} must have columns 'date' and 'tickers'")
    df = df.copy()
    df["date"] = pd.to_datetime(df["date"])
    df = df.sort_values("date").drop_duplicates(subset=["date"], keep="last")
    df = df.set_index("date")
    _history = df
    return _history


def _load_ranks() -> pd.DataFrame:
    global _ranks
    if _ranks is not None:
        return _ranks
    df = pd.read_csv(RANKS_PATH)
    if "ticker" not in df.columns or "rank" not in df.columns:
        raise ValueError(f"{RANKS_PATH} must include 'ticker' and 'rank'")
    df = df.copy()
    df["ticker"] = df["ticker"].astype(str).apply(_normalize)
    _ranks = df.sort_values("rank").reset_index(drop=True)
    return _ranks


def get_sp500_at(date: str) -> list[str]:
    """Full S&P 500 constituents at a given date (last snapshot on or before date)."""
    df = _load_history()
    target = pd.Timestamp(date)
    valid = df.index[df.index <= target]
    if len(valid) == 0:
        raise ValueError(f"No S&P 500 history on or before {date}")
    row = df.loc[valid[-1]]
    tickers_raw = row["tickers"] if "tickers" in row.index else row.iloc[0]
    return _parse_tickers_cell(tickers_raw)


def get_sp100_at(date: str) -> list[str]:
    """
    Top-100 S&P 500 names at a given date: SP500 membership intersected with current cap rank order,
    taking the first 100 present in the index that day.
    """
    sp500 = set(get_sp500_at(date))
    ranks = _load_ranks()
    ordered = [t for t in ranks["ticker"].tolist() if t in sp500]
    return sorted(ordered[:100])


def get_sp50_at(date: str) -> list[str]:
    """Top-50 S&P 500 names at date by the same rule as get_sp100_at."""
    sp500 = set(get_sp500_at(date))
    ranks = _load_ranks()
    ordered = [t for t in ranks["ticker"].tolist() if t in sp500]
    return sorted(ordered[:50])


def get_pit_universe(date: str, universe: str = "SP500", max_n: int = 500) -> list[str]:
    """
    Point-in-time universe at ``date``.

    universe: "SP50", "SP100", or "SP500"
    """
    u = universe.strip().upper()
    if u == "SP50":
        return get_sp50_at(date)
    if u == "SP100":
        return get_sp100_at(date)
    sp = get_sp500_at(date)
    return sp[: min(max_n, len(sp))]


def collect_pit_ticker_union(start: str, end: str, universe: str = "SP500") -> list[str]:
    """Union of tickers appearing in any daily snapshot between start and end (inclusive)."""
    df = _load_history()
    ts0, ts1 = pd.Timestamp(start), pd.Timestamp(end)
    sub = df.loc[(df.index >= ts0) & (df.index <= ts1)]
    all_tickers: set[str] = set()
    if len(sub) == 0:
        return get_pit_universe(end, universe=universe)
    col = "tickers" if "tickers" in sub.columns else sub.columns[0]
    for val in sub[col].values:
        all_tickers.update(_parse_tickers_cell(val))

    u = universe.strip().upper()
    if u in ("SP50", "SP100"):
        ranks = _load_ranks()
        n = 50 if u == "SP50" else 100
        top_pool = set(ranks.head(n * 2)["ticker"].tolist())
        all_tickers &= top_pool

    print(f"[pit_universe] Union ({u}): {len(all_tickers)} unique tickers", flush=True)
    return sorted(all_tickers)


if __name__ == "__main__":
    print("=== Testing PIT universe ===", flush=True)
    sp500_2010 = get_sp500_at("2010-01-01")
    sp100_2010 = get_sp100_at("2010-01-01")
    sp50_2010 = get_sp50_at("2010-01-01")
    sp50_2020 = get_sp50_at("2020-01-01")
    sp50_2025 = get_sp50_at("2025-01-01")
    print(f"SP500 2010: {len(sp500_2010)} tickers", flush=True)
    print(f"SP100 2010: {len(sp100_2010)} — sample: {sp100_2010[:10]}", flush=True)
    print(f"SP50  2010: {len(sp50_2010)}  — {sp50_2010[:10]}", flush=True)
    print(f"SP50  2020: {len(sp50_2020)}  — {sp50_2020[:10]}", flush=True)
    print(f"SP50  2025: {len(sp50_2025)}  — {sp50_2025[:10]}", flush=True)
    added_50 = set(sp50_2025) - set(sp50_2010)
    removed_50 = set(sp50_2010) - set(sp50_2025)
    print(f"\nSP50 added 2010→2025: {sorted(added_50)}", flush=True)
    print(f"SP50 removed 2010→2025: {sorted(removed_50)}", flush=True)
