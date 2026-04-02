"""Stock universes for portfolio optimization — curated S&P 500–style US equities by sector."""

from __future__ import annotations

from collections import Counter

SECTOR_ORDER: tuple[str, ...] = (
    "Technology",
    "Financials",
    "Healthcare",
    "Consumer",
    "Industrials",
    "Energy",
    "Materials",
    "Utilities",
)

# Well-known liquid S&P 500 constituents; no ETFs. Tickers uppercase, sorted per sector.
SECTORS: dict[str, list[str]] = {
    "Technology": sorted(
        [
            "AAPL",
            "ADBE",
            "AMD",
            "AVGO",
            "CRM",
            "CSCO",
            "IBM",
            "INTC",
            "INTU",
            "MSFT",
            "NTNX",
            "NVDA",
            "ORCL",
            "QCOM",
        ]
    ),
    "Financials": sorted(
        [
            "AXP",
            "BAC",
            "BLK",
            "C",
            "COF",
            "GS",
            "JPM",
            "MS",
            "PNC",
            "SCHW",
            "TFC",
            "USB",
            "WFC",
        ]
    ),
    "Healthcare": sorted(
        [
            "ABBV",
            "ABT",
            "AMGN",
            "BMY",
            "CVS",
            "DHR",
            "GILD",
            "JNJ",
            "LLY",
            "MRK",
            "PFE",
            "TMO",
            "UNH",
        ]
    ),
    "Consumer": sorted(
        [
            "COST",
            "DIS",
            "HD",
            "KO",
            "LOW",
            "MCD",
            "MDLZ",
            "NKE",
            "PEP",
            "PG",
            "SBUX",
            "TGT",
            "WMT",
        ]
    ),
    "Industrials": sorted(
        [
            "BA",
            "CAT",
            "CSX",
            "DE",
            "EMR",
            "GD",
            "GE",
            "HON",
            "LMT",
            "MMM",
            "RTX",
            "UNP",
            "UPS",
        ]
    ),
    "Energy": sorted(
        [
            "COP",
            "CVX",
            "DVN",
            "EOG",
            "FANG",
            "HAL",
            "KMI",
            "MPC",
            "OXY",
            "PSX",
            "SLB",
            "VLO",
            "XOM",
        ]
    ),
    "Materials": sorted(
        [
            "ALB",
            "APD",
            "CE",
            "CTVA",
            "DD",
            "DOW",
            "ECL",
            "FCX",
            "LIN",
            "NEM",
            "NUE",
            "PPG",
            "SHW",
        ]
    ),
    "Utilities": sorted(
        [
            "AEP",
            "AWK",
            "D",
            "DUK",
            "ED",
            "ES",
            "EXC",
            "NEE",
            "PEG",
            "SO",
            "SRE",
            "WEC",
            "XEL",
        ]
    ),
}


def _balanced_pick(sectors: dict[str, list[str]], n: int, order: tuple[str, ...]) -> list[str]:
    """Pick ``n`` distinct tickers round-robin across ``order`` until exhausted or count reached."""
    pools = {k: list(sectors[k]) for k in order}
    idx = {k: 0 for k in order}
    out: list[str] = []
    while len(out) < n:
        progressed = False
        for sec in order:
            if len(out) >= n:
                break
            i = idx[sec]
            if i < len(pools[sec]):
                out.append(pools[sec][i])
                idx[sec] += 1
                progressed = True
        if not progressed:
            raise ValueError(
                f"cannot build universe of size {n}: exhausted sector pools "
                f"(picked {len(out)} tickers)"
            )
    return out


SP50: list[str] = _balanced_pick(SECTORS, 50, SECTOR_ORDER)
SP100: list[str] = _balanced_pick(SECTORS, 100, SECTOR_ORDER)

_TICKER_TO_SECTOR: dict[str, str] = {}
for _sector, _tickers in SECTORS.items():
    for _t in _tickers:
        _TICKER_TO_SECTOR[_t] = _sector


def get_universe(name: str = "SP50") -> list[str]:
    """Return a copy of the named universe: ``SP50``, ``SP100``, or a sector name."""
    key = name.strip()
    if not key:
        raise ValueError("universe name must be non-empty")

    upper = key.upper()
    if upper == "SP50":
        return list(SP50)
    if upper == "SP100":
        return list(SP100)

    for sector in SECTOR_ORDER:
        if sector.lower() == key.lower():
            return list(SECTORS[sector])

    raise ValueError(
        f"unknown universe {name!r}; use 'SP50', 'SP100', or one of: "
        + ", ".join(repr(s) for s in SECTOR_ORDER)
    )


def get_sectors() -> dict[str, list[str]]:
    """Return a shallow copy of ``SECTORS`` (new dict and new lists per key)."""
    return {k: list(v) for k, v in SECTORS.items()}


def get_sector_for_ticker(ticker: str) -> str:
    """Return sector label for ``ticker``, or ``\"Unknown\"`` if not in the universe map."""
    t = ticker.strip().upper()
    return _TICKER_TO_SECTOR.get(t, "Unknown")


if __name__ == "__main__":
    u = get_universe("SP50")
    print("SP50 universe:")
    print(u)
    print("length:", len(u))
    breakdown = Counter(get_sector_for_ticker(t) for t in u)
    print("sector breakdown:")
    for sec in SECTOR_ORDER:
        print(f"  {sec}: {breakdown.get(sec, 0)}")
    if breakdown.get("Unknown", 0):
        print("  Unknown:", breakdown["Unknown"])
    assert sum(breakdown[s] for s in SECTOR_ORDER) == len(u)
