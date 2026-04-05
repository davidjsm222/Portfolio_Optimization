"""Signals and expected-return tilts API routes."""

from __future__ import annotations

import asyncio
import queue
import threading
from typing import Any, Dict

import pandas as pd
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from backend.api.routes._utils import sse_data_line
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


def _compute_signals(body: SignalsRequest) -> SignalsGenerateResponse:
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


@router.get("/info")
def signals_info() -> list[dict[str, str]]:
    return SIGNAL_INFO


@router.post("/generate", response_model=SignalsGenerateResponse)
def generate_signals(body: SignalsRequest) -> SignalsGenerateResponse:
    try:
        return _compute_signals(body)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


def _parse_tickers(tickers: str) -> list[str]:
    return [t.strip().upper() for t in tickers.split(",") if t.strip()]


@router.get("/stream")
async def stream_signals(
    tickers: str = Query(...),
    start: str = Query(...),
    end: str = Query(...),
    signal_weight: float = Query(0.3, ge=0, le=1),
    momentum_lookback: int = Query(252, ge=1, le=2000),
    reversion_lookback: int = Query(5, ge=1, le=500),
) -> StreamingResponse:
    ticker_list = _parse_tickers(tickers)
    if not ticker_list:
        raise HTTPException(status_code=400, detail="tickers must list at least one symbol")

    body = SignalsRequest(
        tickers=ticker_list,
        start=start,
        end=end,
        signal_weight=signal_weight,
        momentum_lookback=momentum_lookback,
        reversion_lookback=reversion_lookback,
    )

    q: queue.Queue[tuple[str, Any]] = queue.Queue()

    def run_in_thread() -> None:
        try:
            q.put(
                (
                    "progress",
                    {"type": "progress", "step": "Fetching returns", "pct": 10},
                )
            )
            returns_df = get_returns(body.tickers, body.start, body.end)

            q.put(
                (
                    "progress",
                    {
                        "type": "progress",
                        "step": "Computing annualized returns",
                        "pct": 25,
                    },
                )
            )
            hist_mu = annualize_returns(returns_df)

            q.put(
                (
                    "progress",
                    {
                        "type": "progress",
                        "step": "Computing momentum signal",
                        "pct": 45,
                    },
                )
            )
            mom = momentum_signal(
                returns_df,
                lookback=body.momentum_lookback,
                skip=21,
            )

            q.put(
                (
                    "progress",
                    {
                        "type": "progress",
                        "step": "Computing cross-sectional signal",
                        "pct": 60,
                    },
                )
            )
            xmom = cross_sectional_momentum(
                returns_df,
                lookback=body.momentum_lookback,
                skip=21,
            )

            q.put(
                (
                    "progress",
                    {
                        "type": "progress",
                        "step": "Computing mean reversion",
                        "pct": 75,
                    },
                )
            )
            rev = mean_reversion_signal(
                returns_df,
                lookback=body.reversion_lookback,
            )

            q.put(
                (
                    "progress",
                    {
                        "type": "progress",
                        "step": "Blending signals",
                        "pct": 90,
                    },
                )
            )
            comb = combined_signal(returns_df)
            adj = signal_to_expected_returns(
                comb,
                hist_mu,
                signal_weight=body.signal_weight,
            )

            resp = SignalsGenerateResponse(
                momentum=_series_to_dict(mom),
                cross_sectional=_series_to_dict(xmom),
                mean_reversion=_series_to_dict(rev),
                combined=_series_to_dict(comb),
                historical_mu=_series_to_dict(hist_mu),
                adjusted_mu=_series_to_dict(adj),
            )
            q.put(("done", resp.model_dump(mode="json")))
        except Exception as e:
            q.put(("error", str(e)))

    threading.Thread(target=run_in_thread, daemon=True).start()

    async def event_stream():
        while True:
            try:

                def _pull() -> tuple[str, Any]:
                    try:
                        return q.get(timeout=300.0)
                    except queue.Empty:
                        return ("timeout", None)

                kind, data = await asyncio.to_thread(_pull)
            except Exception as e:
                yield sse_data_line({"type": "error", "message": str(e)})
                break
            if kind == "timeout":
                yield sse_data_line(
                    {"type": "error", "message": "Stream timeout waiting for signal generation"}
                )
                break
            if kind == "progress":
                yield sse_data_line(data)
            elif kind == "done":
                yield sse_data_line({"type": "complete", "result": data})
                break
            elif kind == "error":
                yield sse_data_line({"type": "error", "message": data})
                break

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
