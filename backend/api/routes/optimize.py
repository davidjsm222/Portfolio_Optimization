"""Portfolio optimization API routes."""

from __future__ import annotations

import math
from typing import Any, Optional

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
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
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
