"""Portfolio optimization API routes."""

from __future__ import annotations

import asyncio
import math
import queue
import threading
from typing import Any, Optional

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from backend.data.cache import get_returns
from backend.engine.optimizer import (
    efficient_frontier,
    max_sharpe,
    min_variance,
    risk_parity,
)
from backend.engine.returns import (
    annualize_returns,
    ledoit_wolf_covariance,
    sample_covariance,
)
from backend.engine.signals import combined_signal, signal_to_expected_returns

from backend.api.routes._utils import sse_data_line

router = APIRouter(prefix="/optimize", tags=["optimize"])

METHODS: list[dict[str, str]] = [
    {
        "id": "min_variance",
        "description": "Minimize portfolio variance subject to weights summing to 1.",
    },
    {
        "id": "max_sharpe",
        "description": "Maximize Sharpe ratio (expected return over volatility), rf=0.",
    },
    {
        "id": "efficient_frontier",
        "description": (
            "Minimize variance at each target return between the min-var portfolio "
            "and max asset return; response includes full frontier and max-Sharpe point."
        ),
    },
    {
        "id": "risk_parity",
        "description": "Equal risk contribution weights (Euler allocation), long-only style bounds.",
    },
]


class OptimizeRequest(BaseModel):
    tickers: list[str]
    start: str
    end: str
    method: str
    allow_short: bool = False
    target_return: Optional[float] = None
    n_points: int = 50
    use_ledoit_wolf: bool = True
    signal_blend: float = 0.0


class OptimizeResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    method: str
    weights: dict[str, float]
    return_: float = Field(alias="return", serialization_alias="return")
    volatility: float
    sharpe: float
    frontier: Optional[list[dict[str, Any]]] = None


def _safe_float(x: Any) -> float:
    v = float(x)
    if math.isnan(v) or math.isinf(v):
        return 0.0
    return v


def _row_to_frontier_dict(row: pd.Series, tickers: list[str]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "return": _safe_float(row["return"]),
        "volatility": _safe_float(row["volatility"]),
        "sharpe": _safe_float(row["sharpe"]),
    }
    for t in tickers:
        out[t] = _safe_float(row[t])
    return out


def _result_to_response(
    method: str,
    result: dict,
    frontier: Optional[list[dict[str, Any]]] = None,
) -> OptimizeResponse:
    w = result.get("weights")
    if w is None or not isinstance(w, pd.Series):
        raise ValueError("optimizer result missing weights")
    weights = {str(k): float(v) for k, v in w.items()}
    ret = result.get("return")
    vol = result.get("volatility")
    sh = result.get("sharpe")
    return OptimizeResponse(
        method=method,
        weights=weights,
        return_=float(ret) if ret is not None and not pd.isna(ret) else 0.0,
        volatility=float(vol) if vol is not None and not pd.isna(vol) else 0.0,
        sharpe=float(sh) if sh is not None and not pd.isna(sh) else 0.0,
        frontier=frontier,
    )


def _compute_optimize(body: OptimizeRequest) -> OptimizeResponse:
    returns_df = get_returns(body.tickers, body.start, body.end)
    if returns_df.empty or returns_df.shape[1] == 0:
        raise ValueError("No return data for given tickers and date range")

    if body.use_ledoit_wolf:
        cov = ledoit_wolf_covariance(returns_df)
    else:
        cov = sample_covariance(returns_df)

    mu = annualize_returns(returns_df)
    if body.signal_blend and body.signal_blend > 0:
        sig = combined_signal(returns_df)
        mu = signal_to_expected_returns(
            sig, mu, signal_weight=body.signal_blend
        )

    method = body.method
    tickers = list(returns_df.columns)

    if method == "min_variance":
        out = min_variance(mu, cov, allow_short=body.allow_short)
        if out is None:
            raise ValueError("min_variance failed")
        return _result_to_response(method, out)

    if method == "max_sharpe":
        out = max_sharpe(mu, cov, rf=0.0, allow_short=body.allow_short)
        if out is None:
            raise ValueError("max_sharpe failed")
        return _result_to_response(method, out)

    if method == "risk_parity":
        out = risk_parity(cov, mu)
        if out is None:
            raise ValueError("risk_parity failed")
        return _result_to_response(method, out)

    if method == "efficient_frontier":
        ef = efficient_frontier(
            mu,
            cov,
            n_points=body.n_points,
            allow_short=body.allow_short,
            min_target_return=body.target_return,
        )
        if ef.empty:
            raise ValueError("efficient_frontier produced no points")

        sharpe_col = ef["sharpe"].replace([np.inf, -np.inf], np.nan)
        if sharpe_col.notna().any():
            idx = sharpe_col.idxmax(skipna=True)
        else:
            idx = ef.index[0]
        best = ef.loc[idx]
        weights = {t: float(best[t]) for t in tickers}
        frontier_list = [_row_to_frontier_dict(ef.loc[i], tickers) for i in ef.index]

        fake: dict[str, Any] = {
            "weights": pd.Series(weights),
            "return": float(best["return"]),
            "volatility": float(best["volatility"]),
            "sharpe": float(best["sharpe"]),
        }
        return _result_to_response(
            method,
            fake,
            frontier=frontier_list,
        )

    raise ValueError(f"Unhandled method {method}")


@router.get("/methods")
def list_methods() -> list[dict[str, str]]:
    return METHODS


@router.post(
    "/run",
    response_model=OptimizeResponse,
    response_model_by_alias=True,
)
def run_optimize(body: OptimizeRequest) -> OptimizeResponse:
    allowed = {m["id"] for m in METHODS}
    if body.method not in allowed:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown method {body.method!r}; choose one of {sorted(allowed)}",
        )
    try:
        return _compute_optimize(body)
    except ValueError as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


def _parse_ticker_query(tickers: str) -> list[str]:
    return [t.strip().upper() for t in tickers.split(",") if t.strip()]


@router.get("/stream")
async def stream_optimize(
    tickers: str = Query(..., description="Comma-separated ticker symbols"),
    start: str = Query(...),
    end: str = Query(...),
    method: str = Query(...),
    allow_short: bool = Query(False),
    target_return: Optional[float] = Query(None),
    n_points: int = Query(50, ge=2, le=500),
    use_ledoit_wolf: bool = Query(True),
    signal_blend: float = Query(0.0),
) -> StreamingResponse:
    ticker_list = _parse_ticker_query(tickers)
    if not ticker_list:
        raise HTTPException(status_code=400, detail="tickers must list at least one symbol")

    body = OptimizeRequest(
        tickers=ticker_list,
        start=start,
        end=end,
        method=method,
        allow_short=allow_short,
        target_return=target_return,
        n_points=n_points,
        use_ledoit_wolf=use_ledoit_wolf,
        signal_blend=signal_blend,
    )

    q: queue.Queue[tuple[str, Any]] = queue.Queue()

    def run_in_thread() -> None:
        try:
            allowed = {m["id"] for m in METHODS}
            if body.method not in allowed:
                q.put(("error", f"Unknown method {body.method!r}"))
                return

            q.put(
                (
                    "progress",
                    {
                        "type": "progress",
                        "step": "Fetching returns",
                        "pct": 10,
                        "phase": 1,
                    },
                )
            )
            returns_df = get_returns(body.tickers, body.start, body.end)
            if returns_df.empty or returns_df.shape[1] == 0:
                q.put(("error", "No return data for given tickers and date range"))
                return

            cov_name = "Ledoit-Wolf" if body.use_ledoit_wolf else "sample"
            q.put(
                (
                    "progress",
                    {
                        "type": "progress",
                        "step": f"Computing covariance ({cov_name})",
                        "pct": 30,
                        "phase": 1,
                    },
                )
            )
            if body.use_ledoit_wolf:
                cov = ledoit_wolf_covariance(returns_df)
            else:
                cov = sample_covariance(returns_df)

            mu = annualize_returns(returns_df)
            if body.signal_blend and body.signal_blend > 0:
                q.put(
                    (
                        "progress",
                        {
                            "type": "progress",
                            "step": "Running signal generation",
                            "pct": 50,
                            "phase": 1,
                        },
                    )
                )
                sig = combined_signal(returns_df)
                mu = signal_to_expected_returns(
                    sig, mu, signal_weight=body.signal_blend
                )

            q.put(
                (
                    "progress",
                    {
                        "type": "progress",
                        "step": f"Optimizing portfolio ({body.method})",
                        "pct": 70,
                        "phase": 1,
                    },
                )
            )

            meth = body.method
            tickers = list(returns_df.columns)

            if meth == "min_variance":
                out = min_variance(mu, cov, allow_short=body.allow_short)
                if out is None:
                    q.put(("error", "min_variance failed"))
                    return
                resp = _result_to_response(meth, out)
            elif meth == "max_sharpe":
                out = max_sharpe(mu, cov, rf=0.0, allow_short=body.allow_short)
                if out is None:
                    q.put(("error", "max_sharpe failed"))
                    return
                resp = _result_to_response(meth, out)
            elif meth == "risk_parity":
                out = risk_parity(cov, mu)
                if out is None:
                    q.put(("error", "risk_parity failed"))
                    return
                resp = _result_to_response(meth, out)
            elif meth == "efficient_frontier":
                ef = efficient_frontier(
                    mu,
                    cov,
                    n_points=body.n_points,
                    allow_short=body.allow_short,
                    min_target_return=body.target_return,
                )
                if ef.empty:
                    q.put(("error", "efficient_frontier produced no points"))
                    return
                sharpe_col = ef["sharpe"].replace([np.inf, -np.inf], np.nan)
                if sharpe_col.notna().any():
                    idx = sharpe_col.idxmax(skipna=True)
                else:
                    idx = ef.index[0]
                best = ef.loc[idx]
                weights = {t: float(best[t]) for t in tickers}
                frontier_list = [_row_to_frontier_dict(ef.loc[i], tickers) for i in ef.index]
                fake: dict[str, Any] = {
                    "weights": pd.Series(weights),
                    "return": float(best["return"]),
                    "volatility": float(best["volatility"]),
                    "sharpe": float(best["sharpe"]),
                }
                resp = _result_to_response(meth, fake, frontier=frontier_list)
            else:
                q.put(("error", f"Unhandled method {meth}"))
                return

            if meth != "efficient_frontier":
                q.put(
                    (
                        "progress",
                        {
                            "type": "progress",
                            "step": "Computing efficient frontier",
                            "pct": 85,
                            "phase": 2,
                        },
                    )
                )
                ef2 = efficient_frontier(
                    mu,
                    cov,
                    n_points=body.n_points,
                    allow_short=body.allow_short,
                    min_target_return=body.target_return,
                )
                if ef2.empty:
                    q.put(("error", "efficient_frontier produced no points"))
                    return
                frontier_list = [
                    _row_to_frontier_dict(ef2.loc[i], tickers) for i in ef2.index
                ]
                resp = resp.model_copy(update={"frontier": frontier_list})

            payload = resp.model_dump(by_alias=True, mode="json")
            q.put(("done", payload))
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
                    {"type": "error", "message": "Stream timeout waiting for optimization"}
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
