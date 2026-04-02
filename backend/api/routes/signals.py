"""Signals and expected-return tilts API routes."""

from __future__ import annotations

from typing import Dict

import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.data.cache import get_returns
from backend.engine.returns import annualize_returns
from backend.engine.signals import (
    combined_signal,
    cross_sectional_momentum,
    mean_reversion_signal,
    momentum_signal,
    signal_to_expected_returns,
)

router = APIRouter(prefix="/signals", tags=["signals"])

SIGNAL_INFO: list[dict[str, str]] = [
    {
        "id": "momentum",
        "description": "Time-series momentum: cumulative return excluding the most recent skip days to reduce reversal bias.",
        "default_momentum_lookback": "252",
        "default_skip": "21",
    },
    {
        "id": "cross_sectional",
        "description": "Same cumulative window as momentum, rank-normalized to [-1, 1] across names.",
        "default_momentum_lookback": "252",
        "default_skip": "21",
    },
    {
        "id": "mean_reversion",
        "description": "Short-horizon reversal tilt: negative of recent cumulative return, rank-normalized.",
        "default_reversion_lookback": "5",
    },
    {
        "id": "combined",
        "description": "Z-scored blend of momentum, cross-sectional momentum, and mean reversion (default weights 0.5 / 0.3 / 0.2).",
    },
    {
        "id": "signal_to_expected_returns",
        "description": "Rescales the composite signal to typical return scale and blends with historical annualized means.",
        "default_signal_weight": "0.3",
    },
]


class SignalsRequest(BaseModel):
    tickers: list[str]
    start: str
    end: str
    signal_weight: float = 0.3
    momentum_lookback: int = 252
    reversion_lookback: int = 5


class SignalsGenerateResponse(BaseModel):
    momentum: Dict[str, float]
    cross_sectional: Dict[str, float]
    mean_reversion: Dict[str, float]
    combined: Dict[str, float]
    historical_mu: Dict[str, float]
    adjusted_mu: Dict[str, float]


def _series_to_dict(s: pd.Series) -> Dict[str, float]:
    s = s.astype(float)
    return {str(k): float(v) for k, v in s.items()}


@router.get("/info")
def signals_info() -> list[dict[str, str]]:
    return SIGNAL_INFO


@router.post("/generate", response_model=SignalsGenerateResponse)
def generate_signals(body: SignalsRequest) -> SignalsGenerateResponse:
    try:
        returns_df = get_returns(body.tickers, body.start, body.end)
        hist_mu = annualize_returns(returns_df)

        mom = momentum_signal(
            returns_df,
            lookback=body.momentum_lookback,
            skip=21,
        )
        xmom = cross_sectional_momentum(
            returns_df,
            lookback=body.momentum_lookback,
            skip=21,
        )
        rev = mean_reversion_signal(
            returns_df,
            lookback=body.reversion_lookback,
        )
        comb = combined_signal(returns_df)
        adj = signal_to_expected_returns(
            comb,
            hist_mu,
            signal_weight=body.signal_weight,
        )

        return SignalsGenerateResponse(
            momentum=_series_to_dict(mom),
            cross_sectional=_series_to_dict(xmom),
            mean_reversion=_series_to_dict(rev),
            combined=_series_to_dict(comb),
            historical_mu=_series_to_dict(hist_mu),
            adjusted_mu=_series_to_dict(adj),
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
