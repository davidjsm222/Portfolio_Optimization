"""Fama-French factor analysis API routes."""

from __future__ import annotations

import asyncio
import json
import math
import queue
import threading
from typing import Any, Dict, Optional

import pandas as pd
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from backend.api.routes._utils import sse_data_line
from backend.data.cache import get_returns
from backend.data.fetcher import fetch_ff_factors
from backend.engine.factors import (
    factor_attribution,
    factor_loadings,
    portfolio_factor_exposure,
)

router = APIRouter(prefix="/factors", tags=["factors"])

FACTOR_DEFINITIONS: list[dict[str, str]] = [
    {
        "name": "Mkt-RF",
        "description": "Excess return on the market: value-weight return of all CRSP firms minus the one-month T-bill rate.",
    },
    {
        "name": "SMB",
        "description": "Small minus big: average return on small-cap portfolios minus big-cap portfolios.",
    },
    {
        "name": "HML",
        "description": "High minus low: average return on high book-to-market portfolios minus low book-to-market.",
    },
    {
        "name": "RMW",
        "description": "Robust minus weak: profitable firms minus unprofitable (operating profitability).",
    },
    {
        "name": "CMA",
        "description": "Conservative minus aggressive: firms with conservative investment minus aggressive investment.",
    },
]


class FactorsRequest(BaseModel):
    tickers: list[str]
    start: str
    end: str
    weights: Optional[Dict[str, float]] = None


class FactorsAnalyzeResponse(BaseModel):
    loadings: Dict[str, Dict[str, Any]]
    portfolio_exposure: Optional[Dict[str, float]] = None
    attribution_summary: Optional[Dict[str, Dict[str, float]]] = None


def _loadings_to_nested_dict(ld: pd.DataFrame) -> Dict[str, Dict[str, Any]]:
    if ld.empty:
        return {}
    out: Dict[str, Dict[str, Any]] = {}
    for ticker in ld.index:
        row = ld.loc[ticker]
        out[str(ticker)] = {str(k): _json_float(row[k]) for k in ld.columns}
    return out


def _json_float(x: Any) -> float:
    v = float(x)
    if math.isnan(v) or math.isinf(v):
        return 0.0
    return v


def _attribution_summary(attr: pd.DataFrame) -> Dict[str, Dict[str, float]]:
    summary: Dict[str, Dict[str, float]] = {}
    for col in attr.columns:
        s = attr[col]
        summary[str(col)] = {
            "mean": _json_float(s.mean()),
            "std": _json_float(s.std(ddof=1)) if len(s) > 1 else 0.0,
        }
    return summary


def _compute_factors(body: FactorsRequest) -> FactorsAnalyzeResponse:
    returns_df = get_returns(body.tickers, body.start, body.end)
    ff = fetch_ff_factors(body.start, body.end)

    loadings_df = factor_loadings(returns_df, ff)
    loadings_dict = _loadings_to_nested_dict(loadings_df)

    portfolio_exposure: Optional[Dict[str, float]] = None
    attribution_summary: Optional[Dict[str, Dict[str, float]]] = None

    if body.weights is not None and len(body.weights) > 0:
        w = pd.Series(body.weights, dtype=float)
        if not loadings_df.empty:
            exp = portfolio_factor_exposure(w, loadings_df)
            portfolio_exposure = {str(k): float(v) for k, v in exp.items()}
            attr = factor_attribution(returns_df, ff, w)
            attribution_summary = _attribution_summary(attr)

    return FactorsAnalyzeResponse(
        loadings=loadings_dict,
        portfolio_exposure=portfolio_exposure,
        attribution_summary=attribution_summary,
    )


@router.get("/definitions")
def factor_definitions() -> list[dict[str, str]]:
    return FACTOR_DEFINITIONS


@router.post("/analyze", response_model=FactorsAnalyzeResponse)
def analyze_factors(body: FactorsRequest) -> FactorsAnalyzeResponse:
    try:
        return _compute_factors(body)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


def _parse_tickers(tickers: str) -> list[str]:
    return [t.strip().upper() for t in tickers.split(",") if t.strip()]


@router.get("/stream")
async def stream_factors(
    tickers: str = Query(..., description="Comma-separated tickers"),
    start: str = Query(...),
    end: str = Query(...),
    weights: Optional[str] = Query(
        None,
        description='Optional JSON dict of ticker weights, e.g. {"AAPL":0.2}',
    ),
) -> StreamingResponse:
    ticker_list = _parse_tickers(tickers)
    if not ticker_list:
        raise HTTPException(status_code=400, detail="tickers must list at least one symbol")

    weights_dict: Optional[Dict[str, float]] = None
    if weights and weights.strip():
        try:
            raw = json.loads(weights)
            if not isinstance(raw, dict):
                raise ValueError("weights must be a JSON object")
            weights_dict = {str(k): float(v) for k, v in raw.items()}
        except (json.JSONDecodeError, TypeError, ValueError) as e:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid weights JSON: {e}",
            ) from e

    body = FactorsRequest(
        tickers=ticker_list,
        start=start,
        end=end,
        weights=weights_dict,
    )

    q: queue.Queue[tuple[str, Any]] = queue.Queue()

    def run_in_thread() -> None:
        try:
            q.put(
                (
                    "progress",
                    {
                        "type": "progress",
                        "step": "Fetching returns",
                        "pct": 10,
                    },
                )
            )
            returns_df = get_returns(body.tickers, body.start, body.end)

            q.put(
                (
                    "progress",
                    {
                        "type": "progress",
                        "step": "Fetching FF factors",
                        "pct": 25,
                    },
                )
            )
            ff = fetch_ff_factors(body.start, body.end)

            q.put(
                (
                    "progress",
                    {
                        "type": "progress",
                        "step": "Running factor regressions",
                        "pct": 60,
                    },
                )
            )
            loadings_df = factor_loadings(returns_df, ff)
            loadings_dict = _loadings_to_nested_dict(loadings_df)

            q.put(
                (
                    "progress",
                    {
                        "type": "progress",
                        "step": "Computing portfolio exposure",
                        "pct": 80,
                    },
                )
            )
            portfolio_exposure: Optional[Dict[str, float]] = None
            attribution_summary: Optional[Dict[str, Dict[str, float]]] = None

            if body.weights is not None and len(body.weights) > 0:
                w = pd.Series(body.weights, dtype=float)
                if not loadings_df.empty:
                    exp = portfolio_factor_exposure(w, loadings_df)
                    portfolio_exposure = {str(k): float(v) for k, v in exp.items()}

                    q.put(
                        (
                            "progress",
                            {
                                "type": "progress",
                                "step": "Computing attribution",
                                "pct": 90,
                            },
                        )
                    )
                    attr = factor_attribution(returns_df, ff, w)
                    attribution_summary = _attribution_summary(attr)

            resp = FactorsAnalyzeResponse(
                loadings=loadings_dict,
                portfolio_exposure=portfolio_exposure,
                attribution_summary=attribution_summary,
            )
            q.put(("done", resp.model_dump(mode="json")))
        except Exception as e:
            q.put(("error", str(e)))

    thread = threading.Thread(target=run_in_thread, daemon=True)
    thread.start()

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
                    {"type": "error", "message": "Stream timeout waiting for factor analysis"}
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
