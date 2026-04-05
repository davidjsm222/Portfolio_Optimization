"""Portfolio risk metrics API routes."""

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
from pydantic import BaseModel, Field

from backend.api.routes._utils import sse_data_line
from backend.data.cache import get_returns
from backend.engine.returns import annualize_returns
from backend.engine.risk import (
    cvar_optimize,
    drawdown_series,
    portfolio_returns,
    risk_summary,
)

router = APIRouter(prefix="/risk", tags=["risk"])

RISK_METRICS: list[dict[str, str]] = [
    {
        "id": "var_95",
        "description": "Historical value-at-risk at the configured confidence (left tail of daily portfolio returns).",
    },
    {
        "id": "cvar_95",
        "description": "Historical conditional VaR (expected shortfall): mean of returns strictly worse than VaR.",
    },
    {
        "id": "max_drawdown",
        "description": "Maximum peak-to-trough loss on a simple cumulative wealth index (1+r).",
    },
    {
        "id": "volatility",
        "description": "Annualized volatility of daily portfolio returns (sample std times sqrt(252)).",
    },
    {
        "id": "skew",
        "description": "Skewness of daily portfolio returns.",
    },
    {
        "id": "kurtosis",
        "description": "Excess kurtosis (pandas default) of daily portfolio returns.",
    },
]


class RiskRequest(BaseModel):
    tickers: list[str]
    start: str
    end: str
    weights: Dict[str, float]
    confidence: float = 0.95
    run_cvar_optimize: bool = False
    target_return: Optional[float] = None


def _safe_float(x: Any) -> float:
    v = float(x)
    if math.isnan(v) or math.isinf(v):
        return 0.0
    return v


def _optional_float(x: Any) -> Optional[float]:
    if x is None:
        return None
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    if math.isnan(v) or math.isinf(v):
        return None
    return v


class DrawdownPoint(BaseModel):
    """Single drawdown observation (fractional; negative below prior peak)."""

    date: str
    drawdown: float


class RiskAnalyzeResponse(BaseModel):
    var_95: float
    cvar_95: float
    max_drawdown: float
    volatility: float
    skew: float
    kurtosis: float
    drawdown_series: list[DrawdownPoint] = Field(default_factory=list)
    cvar_optimized_weights: Optional[Dict[str, float]] = None
    cvar_return: Optional[float] = None
    cvar_volatility: Optional[float] = None
    cvar_sharpe: Optional[float] = None
    cvar_var: Optional[float] = None
    cvar_cvar: Optional[float] = None


def _compute_risk(body: RiskRequest) -> RiskAnalyzeResponse:
    returns_df = get_returns(body.tickers, body.start, body.end)
    w = pd.Series(body.weights, dtype=float).reindex(returns_df.columns).fillna(0.0)

    rs = risk_summary(w, returns_df, confidence=body.confidence)

    pr = portfolio_returns(w, returns_df)
    dd_ts = drawdown_series(pr)
    dd_sub = dd_ts.iloc[::5] if len(dd_ts) > 0 else dd_ts
    drawdown_series_out: list[DrawdownPoint] = [
        DrawdownPoint(
            date=pd.Timestamp(idx).strftime("%Y-%m-%d"),
            drawdown=_safe_float(val),
        )
        for idx, val in dd_sub.items()
    ]

    cvar_weights: Optional[Dict[str, float]] = None
    cvar_ret: Optional[float] = None
    cvar_vol: Optional[float] = None
    cvar_sharpe_v: Optional[float] = None
    cvar_var_v: Optional[float] = None
    cvar_cvar_v: Optional[float] = None

    if body.run_cvar_optimize:
        mu = annualize_returns(returns_df)
        cvr = cvar_optimize(
            mu,
            returns_df,
            target_return=body.target_return,
            confidence=body.confidence,
            allow_short=False,
        )
        if cvr is not None:
            cvar_weights = {str(k): float(v) for k, v in cvr["weights"].items()}
            cvar_ret = _optional_float(cvr.get("return"))
            cvar_vol = _optional_float(cvr.get("volatility"))
            cvar_sharpe_v = _optional_float(cvr.get("sharpe"))
            cvar_var_v = _optional_float(cvr.get("var"))
            cvar_cvar_v = _optional_float(cvr.get("cvar"))

    return RiskAnalyzeResponse(
        var_95=_safe_float(rs["var_95"]),
        cvar_95=_safe_float(rs["cvar_95"]),
        max_drawdown=_safe_float(rs["max_drawdown"]),
        volatility=_safe_float(rs["volatility"]),
        skew=_safe_float(rs["skew"]),
        kurtosis=_safe_float(rs["kurtosis"]),
        drawdown_series=drawdown_series_out,
        cvar_optimized_weights=cvar_weights,
        cvar_return=cvar_ret,
        cvar_volatility=cvar_vol,
        cvar_sharpe=cvar_sharpe_v,
        cvar_var=cvar_var_v,
        cvar_cvar=cvar_cvar_v,
    )


@router.get("/metrics")
def list_metrics() -> list[dict[str, str]]:
    return RISK_METRICS


@router.post("/analyze", response_model=RiskAnalyzeResponse)
def analyze_risk(body: RiskRequest) -> RiskAnalyzeResponse:
    try:
        return _compute_risk(body)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


def _parse_tickers(tickers: str) -> list[str]:
    return [t.strip().upper() for t in tickers.split(",") if t.strip()]


@router.get("/stream")
async def stream_risk(
    tickers: str = Query(...),
    start: str = Query(...),
    end: str = Query(...),
    weights: str = Query(..., description="JSON dict of ticker weights"),
    confidence: float = Query(0.95, ge=0.9, le=0.999),
    run_cvar_optimize: bool = Query(False),
    target_return: Optional[float] = Query(None),
) -> StreamingResponse:
    ticker_list = _parse_tickers(tickers)
    if not ticker_list:
        raise HTTPException(status_code=400, detail="tickers must list at least one symbol")
    try:
        wd = json.loads(weights)
        if not isinstance(wd, dict):
            raise ValueError("weights must be a JSON object")
        weights_dict = {str(k): float(v) for k, v in wd.items()}
    except (json.JSONDecodeError, TypeError, ValueError) as e:
        raise HTTPException(status_code=400, detail=f"Invalid weights JSON: {e}") from e

    body = RiskRequest(
        tickers=ticker_list,
        start=start,
        end=end,
        weights=weights_dict,
        confidence=confidence,
        run_cvar_optimize=run_cvar_optimize,
        target_return=target_return,
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
            w = pd.Series(body.weights, dtype=float).reindex(returns_df.columns).fillna(0.0)

            q.put(
                (
                    "progress",
                    {
                        "type": "progress",
                        "step": "Computing portfolio returns",
                        "pct": 30,
                    },
                )
            )
            pr = portfolio_returns(w, returns_df)

            q.put(
                (
                    "progress",
                    {
                        "type": "progress",
                        "step": "Computing VaR/CVaR",
                        "pct": 50,
                    },
                )
            )
            rs = risk_summary(w, returns_df, confidence=body.confidence)

            q.put(
                (
                    "progress",
                    {
                        "type": "progress",
                        "step": "Computing drawdown series",
                        "pct": 70,
                    },
                )
            )
            dd_ts = drawdown_series(pr)
            dd_sub = dd_ts.iloc[::5] if len(dd_ts) > 0 else dd_ts
            drawdown_series_out: list[DrawdownPoint] = [
                DrawdownPoint(
                    date=pd.Timestamp(idx).strftime("%Y-%m-%d"),
                    drawdown=_safe_float(val),
                )
                for idx, val in dd_sub.items()
            ]

            cvar_weights: Optional[Dict[str, float]] = None
            cvar_ret: Optional[float] = None
            cvar_vol: Optional[float] = None
            cvar_sharpe_v: Optional[float] = None
            cvar_var_v: Optional[float] = None
            cvar_cvar_v: Optional[float] = None

            if body.run_cvar_optimize:
                q.put(
                    (
                        "progress",
                        {
                            "type": "progress",
                            "step": "Running CVaR optimization",
                            "pct": 85,
                        },
                    )
                )
                mu = annualize_returns(returns_df)
                cvr = cvar_optimize(
                    mu,
                    returns_df,
                    target_return=body.target_return,
                    confidence=body.confidence,
                    allow_short=False,
                )
                if cvr is not None:
                    cvar_weights = {str(k): float(v) for k, v in cvr["weights"].items()}
                    cvar_ret = _optional_float(cvr.get("return"))
                    cvar_vol = _optional_float(cvr.get("volatility"))
                    cvar_sharpe_v = _optional_float(cvr.get("sharpe"))
                    cvar_var_v = _optional_float(cvr.get("var"))
                    cvar_cvar_v = _optional_float(cvr.get("cvar"))

            resp = RiskAnalyzeResponse(
                var_95=_safe_float(rs["var_95"]),
                cvar_95=_safe_float(rs["cvar_95"]),
                max_drawdown=_safe_float(rs["max_drawdown"]),
                volatility=_safe_float(rs["volatility"]),
                skew=_safe_float(rs["skew"]),
                kurtosis=_safe_float(rs["kurtosis"]),
                drawdown_series=drawdown_series_out,
                cvar_optimized_weights=cvar_weights,
                cvar_return=cvar_ret,
                cvar_volatility=cvar_vol,
                cvar_sharpe=cvar_sharpe_v,
                cvar_var=cvar_var_v,
                cvar_cvar=cvar_cvar_v,
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
                    {"type": "error", "message": "Stream timeout waiting for risk analysis"}
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
