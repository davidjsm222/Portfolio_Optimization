"""Live forecast API: fresh returns, Ledoit-Wolf shrinkage, dynamic signal blend, optimize."""

from __future__ import annotations

import asyncio
import math
import queue
import threading
from typing import Any, Callable, Optional, Union

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sklearn.covariance import LedoitWolf

from backend.api.routes._utils import query_bool, sse_data_line
from backend.data.fetcher import fetch_ff_factors, fetch_returns_live
from backend.engine.factors import factor_loadings, portfolio_factor_exposure
from backend.engine.optimizer import efficient_frontier, max_sharpe, min_variance, risk_parity
from backend.engine.returns import annualize_returns, ledoit_wolf_covariance
from backend.engine.risk import risk_summary
from backend.engine.signals import combined_signal, signal_to_expected_returns

router = APIRouter(prefix="/forecast", tags=["forecast"])

ALLOWED_METHODS = {"min_variance", "max_sharpe", "efficient_frontier", "risk_parity"}

# Position limit: no single asset above this weight in forecast optimization.
FORECAST_MAX_WEIGHT = 0.20


class ForecastRequest(BaseModel):
    tickers: list[str]
    lookback_days: int = 400
    method: str = "max_sharpe"
    use_signal_blend: bool = True


class ForecastResponse(BaseModel):
    weights: dict[str, float]
    expected_return: float
    expected_volatility: float
    expected_sharpe: float
    shrinkage_alpha: float
    confidence_level: str
    signal_weight_used: float
    combined_signal_mean: float
    var_95: float
    cvar_95: float
    max_drawdown: float
    factor_exposures: dict[str, float]
    data_through: str
    tickers_used: list[str]
    tickers_dropped: list[str]
    method: str


def _parse_ticker_query(tickers: str) -> list[str]:
    return [t.strip().upper() for t in tickers.split(",") if t.strip()]


def _safe_float(x: Any) -> float:
    v = float(x)
    if math.isnan(v) or math.isinf(v):
        return 0.0
    return v


def _confidence_level(alpha: float) -> str:
    if alpha < 0.05:
        return "HIGH"
    if alpha <= 0.10:
        return "MEDIUM"
    return "LOW"


def _row_to_best_frontier(
    ef: pd.DataFrame, tickers: list[str]
) -> tuple[dict[str, float], float, float, float]:
    sharpe_col = ef["sharpe"].replace([np.inf, -np.inf], np.nan)
    if sharpe_col.notna().any():
        idx = sharpe_col.idxmax(skipna=True)
    else:
        idx = ef.index[0]
    best = ef.loc[idx]
    weights = {t: float(best[t]) for t in tickers}
    return (
        weights,
        float(best["return"]),
        float(best["volatility"]),
        float(best["sharpe"]),
    )


def _run_optimizer(
    method: str,
    mu: pd.Series,
    cov: pd.DataFrame,
    tickers: list[str],
) -> tuple[pd.Series, float, float, float]:
    if method == "min_variance":
        out = min_variance(
            mu, cov, allow_short=False, max_weight=FORECAST_MAX_WEIGHT
        )
        if out is None:
            raise ValueError("min_variance failed")
        w = out["weights"]
        return w, float(out["return"]), float(out["volatility"]), float(out["sharpe"])

    if method == "max_sharpe":
        out = max_sharpe(
            mu,
            cov,
            rf=0.0,
            allow_short=False,
            max_weight=FORECAST_MAX_WEIGHT,
        )
        if out is None:
            raise ValueError("max_sharpe failed")
        w = out["weights"]
        return w, float(out["return"]), float(out["volatility"]), float(out["sharpe"])

    if method == "risk_parity":
        out = risk_parity(cov, mu, max_weight=FORECAST_MAX_WEIGHT)
        if out is None:
            raise ValueError("risk_parity failed")
        w = out["weights"]
        return w, float(out["return"]), float(out["volatility"]), float(out["sharpe"])

    if method == "efficient_frontier":
        ef = efficient_frontier(
            mu,
            cov,
            n_points=50,
            allow_short=False,
            min_target_return=None,
            max_weight=FORECAST_MAX_WEIGHT,
        )
        if ef.empty:
            raise ValueError("efficient_frontier produced no points")
        weights_d, ret, vol, sh = _row_to_best_frontier(ef, tickers)
        return pd.Series(weights_d), ret, vol, sh

    raise ValueError(f"Unknown method {method!r}")


def _compute_forecast(
    body: ForecastRequest,
    progress: Optional[Callable[[str, int], None]] = None,
) -> ForecastResponse:
    def prog(step: str, pct: int) -> None:
        if progress:
            progress(step, pct)

    if body.method not in ALLOWED_METHODS:
        raise ValueError(
            f"Unknown method {body.method!r}; choose one of {sorted(ALLOWED_METHODS)}"
        )

    uniq = list(dict.fromkeys(body.tickers))
    if not uniq:
        raise ValueError("tickers must list at least one symbol")

    prog("Fetching live returns (yfinance)", 10)
    returns = fetch_returns_live(uniq, lookback_days=body.lookback_days)
    if returns.empty or returns.shape[1] == 0:
        raise ValueError("No return data from live fetch")

    print(
        f"[forecast] fetched {len(returns)} trading days for {len(returns.columns)} tickers"
    )

    prog("Filtering tickers by data quality", 25)
    n_rows = len(returns)
    min_obs = int(n_rows * 0.8)
    cols_ok = [t for t in returns.columns if returns[t].notna().sum() >= min_obs]
    if len(cols_ok) < 5:
        min_obs = int(n_rows * 0.5)
        cols_ok = [t for t in returns.columns if returns[t].notna().sum() >= min_obs]
    if not cols_ok:
        raise ValueError(
            "No tickers with at least 50% valid observations after quality filters"
        )
    returns = returns[cols_ok]
    tickers_used = [str(c) for c in returns.columns]
    tickers_dropped = [t for t in uniq if t not in returns.columns]

    min_names_for_cap = int(math.ceil(1.0 / FORECAST_MAX_WEIGHT))
    if len(returns.columns) < min_names_for_cap:
        raise ValueError(
            f"At least {min_names_for_cap} tickers required for a {FORECAST_MAX_WEIGHT:.0%} "
            f"position cap; only {len(returns.columns)} passed data quality filters."
        )

    prog("Computing Ledoit–Wolf covariance and shrinkage", 40)
    arr = returns.to_numpy(dtype=float)
    lw = LedoitWolf().fit(arr)
    alpha = float(lw.shrinkage_)
    cov = ledoit_wolf_covariance(returns)

    mu = annualize_returns(returns)
    sig_blend = combined_signal(returns)
    combined_signal_mean = float(np.nanmean(sig_blend.to_numpy(dtype=float)))
    signal_weight_used = 0.0
    if body.use_signal_blend:
        prog("Applying dynamic signal blend", 55)
        w_sig = min(0.5, max(0.1, 1.0 - alpha))
        mu = signal_to_expected_returns(sig_blend, mu, signal_weight=w_sig)
        signal_weight_used = float(w_sig)

    prog(f"Optimizing portfolio ({body.method})", 70)
    tickers = list(returns.columns)
    w_series, exp_ret, exp_vol, exp_sharpe = _run_optimizer(
        body.method, mu, cov, tickers
    )

    prog("Computing historical risk and factor exposures", 90)
    rs = risk_summary(w_series, returns, confidence=0.95)
    data_through_ts = returns.index.max()
    data_through = (
        data_through_ts.date().isoformat()
        if hasattr(data_through_ts, "date")
        else str(data_through_ts)[:10]
    )

    start_ff = returns.index.min()
    end_ff = returns.index.max()
    start_s = start_ff.date().isoformat() if hasattr(start_ff, "date") else str(start_ff)[:10]
    end_s = end_ff.date().isoformat() if hasattr(end_ff, "date") else str(end_ff)[:10]

    ff = fetch_ff_factors(start_s, end_s)
    loadings_df = factor_loadings(returns, ff)
    if loadings_df.empty:
        exposures: dict[str, float] = {}
    else:
        exp_ser = portfolio_factor_exposure(w_series, loadings_df)
        exposures = {str(k): float(v) for k, v in exp_ser.items()}

    weights_out = {str(k): _safe_float(v) for k, v in w_series.items()}

    return ForecastResponse(
        weights=weights_out,
        expected_return=_safe_float(exp_ret),
        expected_volatility=_safe_float(exp_vol),
        expected_sharpe=_safe_float(exp_sharpe),
        shrinkage_alpha=alpha,
        confidence_level=_confidence_level(alpha),
        signal_weight_used=signal_weight_used,
        combined_signal_mean=_safe_float(combined_signal_mean),
        var_95=_safe_float(rs["var_95"]),
        cvar_95=_safe_float(rs["cvar_95"]),
        max_drawdown=_safe_float(rs["max_drawdown"]),
        factor_exposures=exposures,
        data_through=data_through,
        tickers_used=tickers_used,
        tickers_dropped=tickers_dropped,
        method=body.method,
    )


@router.post("/run", response_model=ForecastResponse)
def run_forecast(body: ForecastRequest) -> ForecastResponse:
    try:
        return _compute_forecast(body)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e


@router.get("/stream")
async def stream_forecast(
    tickers: str = Query(..., description="Comma-separated ticker symbols"),
    lookback_days: int = Query(400, ge=21, le=2000),
    method: str = Query("max_sharpe"),
    use_signal_blend: Union[bool, str, None] = Query(True),
) -> StreamingResponse:
    ticker_list = _parse_ticker_query(tickers)
    if not ticker_list:
        raise HTTPException(status_code=400, detail="tickers must list at least one symbol")

    body = ForecastRequest(
        tickers=ticker_list,
        lookback_days=lookback_days,
        method=method,
        use_signal_blend=query_bool(use_signal_blend, True),
    )

    q: queue.Queue[tuple[str, Any]] = queue.Queue()

    def run_in_thread() -> None:
        try:

            def progress_cb(step: str, pct: int) -> None:
                q.put(
                    (
                        "progress",
                        {"type": "progress", "step": step, "pct": pct},
                    )
                )

            resp = _compute_forecast(body, progress=progress_cb)
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
                        return q.get(timeout=600.0)
                    except queue.Empty:
                        return ("timeout", None)

                kind, data = await asyncio.to_thread(_pull)
            except Exception as e:
                yield sse_data_line({"type": "error", "message": str(e)})
                break
            if kind == "timeout":
                yield sse_data_line(
                    {"type": "error", "message": "Stream timeout waiting for forecast"}
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
