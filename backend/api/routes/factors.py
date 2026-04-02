"""Fama-French factor analysis API routes."""

from __future__ import annotations

import math
from typing import Any, Dict, Optional

import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

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


@router.get("/definitions")
def factor_definitions() -> list[dict[str, str]]:
    return FACTOR_DEFINITIONS


@router.post("/analyze", response_model=FactorsAnalyzeResponse)
def analyze_factors(body: FactorsRequest) -> FactorsAnalyzeResponse:
    try:
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
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e
