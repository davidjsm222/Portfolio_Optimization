"""SQLite-backed cache for market data fetchers."""

from __future__ import annotations

import hashlib
import io
import json
import os
import sqlite3

import pandas as pd

from backend.data.fetcher import fetch_ff_factors, fetch_prices, fetch_returns

_DIR = os.path.dirname(os.path.abspath(__file__))
_DB_PATH = os.path.join(_DIR, "market_cache.db")


def _init_db() -> None:
    conn = sqlite3.connect(_DB_PATH)
    try:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS cache (
                key TEXT PRIMARY KEY,
                data BLOB,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.commit()
    finally:
        conn.close()


_init_db()


def _make_key(fn_name: str, tickers: list, start: str, end: str) -> str:
    payload = {
        "tickers": sorted(tickers),
        "start": start,
        "end": end,
    }
    s = json.dumps(payload, sort_keys=True)
    digest = hashlib.md5(s.encode()).hexdigest()
    return f"{fn_name}_{digest}"


def _blob_from_df(df: pd.DataFrame) -> bytes:
    return df.to_json(orient="split", date_format="iso").encode("utf-8")


def _df_from_blob(blob: bytes) -> pd.DataFrame:
    df = pd.read_json(io.BytesIO(blob), orient="split")
    df.index = pd.to_datetime(df.index)
    return df


def _cache_get(key: str) -> pd.DataFrame | None:
    conn = sqlite3.connect(_DB_PATH)
    try:
        cur = conn.execute("SELECT data FROM cache WHERE key = ?", (key,))
        row = cur.fetchone()
        if row is None:
            return None
        return _df_from_blob(row[0])
    finally:
        conn.close()


def _cache_set(key: str, df: pd.DataFrame) -> None:
    conn = sqlite3.connect(_DB_PATH)
    try:
        conn.execute(
            "INSERT OR REPLACE INTO cache (key, data) VALUES (?, ?)",
            (key, _blob_from_df(df)),
        )
        conn.commit()
    finally:
        conn.close()


def get_prices(tickers: list, start: str, end: str) -> pd.DataFrame:
    key = _make_key("fetch_prices", tickers, start, end)
    hit = _cache_get(key)
    if hit is not None:
        print("[cache hit]")
        return hit
    print("[cache miss]")
    df = fetch_prices(tickers, start, end)
    _cache_set(key, df)
    return df


def get_returns(tickers: list, start: str, end: str) -> pd.DataFrame:
    key = _make_key("fetch_returns", tickers, start, end)
    hit = _cache_get(key)
    if hit is not None:
        print("[cache hit]")
        return hit
    print("[cache miss]")
    df = fetch_returns(tickers, start, end)
    _cache_set(key, df)
    return df


def get_ff_factors(start: str, end: str) -> pd.DataFrame:
    key = _make_key("fetch_ff_factors", [], start, end)
    hit = _cache_get(key)
    if hit is not None:
        print("[cache hit]")
        return hit
    print("[cache miss]")
    df = fetch_ff_factors(start, end)
    _cache_set(key, df)
    return df


if __name__ == "__main__":
    _tickers = ["AAPL", "MSFT", "GOOGL"]
    _start, _end = "2020-01-01", "2023-12-31"

    print("first get_prices:")
    _p1 = get_prices(_tickers, _start, _end)
    print("second get_prices (expect cache hit):")
    _p2 = get_prices(_tickers, _start, _end)
    print("shapes:", _p1.shape, _p2.shape)
