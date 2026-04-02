"""Rolling backtest API (long-running; portfolio equity and regime stats)."""

from __future__ import annotations

import asyncio
import json
import math
import queue
import threading
from typing import Any, Literal

import pandas as pd
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, ConfigDict, Field

from backend.engine.backtest import (
    _monthly_last_trading_days,
    backtest_summary,
    regime_performance,
    run_backtest,
)

router = APIRouter(prefix="/backtest", tags=["backtest"])

BACKTEST_REGIMES: dict[str, tuple[str, str]] = {
    ".com bubble burst": ("2000-03-10", "2002-10-09"),
    "2008 financial crisis": ("2008-09-15", "2009-03-09"),
    "Q4 2018 bear": ("2018-10-03", "2018-12-24"),
    "COVID crash": ("2020-02-19", "2020-04-30"),
    "Rate shock": ("2022-01-03", "2022-12-31"),
    "Liberation Day": ("2025-04-02", "2025-04-08"),
}

REGIME_DEFINITIONS: list[dict[str, str]] = [
    {
        "id": ".com bubble burst",
        "start": "2000-03-10",
        "end": "2002-10-09",
        "description": (
            "Nasdaq peak and multi-year drawdown as technology multiples "
            "collapsed (2000–2002)."
        ),
    },
    {
        "id": "2008 financial crisis",
        "start": "2008-09-15",
        "end": "2009-03-09",
        "description": (
            "Lehman failure, credit freeze, and equity crash into the Mar 2009 low."
        ),
    },
    {
        "id": "Q4 2018 bear",
        "start": "2018-10-03",
        "end": "2018-12-24",
        "description": (
            "Rate hikes and QT; sharp Q4 drawdown into Christmas Eve lows."
        ),
    },
    {
        "id": "COVID crash",
        "start": "2020-02-19",
        "end": "2020-04-30",
        "description": (
            "Equity crash and volatility spike at the onset of COVID-19 "
            "(Feb–Apr 2020)."
        ),
    },
    {
        "id": "Rate shock",
        "start": "2022-01-03",
        "end": "2022-12-31",
        "description": (
            "Aggressive Fed hiking cycle and quantitative tightening (2022)."
        ),
    },
    {
        "id": "Liberation Day",
        "start": "2025-04-02",
        "end": "2025-04-08",
        "description": (
            "Tariff announcement shock and whipsaw around reciprocal levies (Apr 2025)."
        ),
    },
]


class BacktestRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    tickers: list[str]
    start: str
    end: str
    estimation_window: int = 252
    rebalance_freq: Literal["monthly", "threshold"] = "monthly"
    drift_threshold: float = 0.05
    signal_blend: bool = True
    starting_capital: float = Field(default=100_000, gt=0)


class BacktestResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    summary: list[dict[str, Any]]
    equity_curves: dict[str, list[dict[str, Any]]]
    shrinkage: list[dict[str, Any]]
    regime_performance: list[dict[str, Any]]
    rebalance_dates: list[str]
    threshold_trigger_dates: list[str]
    asset_returns: dict[str, list[dict[str, Any]]]
    weights_history: dict[str, dict[str, list[dict[str, Any]]]]
    metadata: dict[str, Any]


def _json_float(x: Any) -> float | None:
    v = float(x)
    if math.isnan(v) or math.isinf(v):
        return None
    return v


def _equity_curve(series: pd.Series, starting_capital: float) -> list[dict[str, Any]]:
    s = series.dropna()
    if s.empty:
        return []
    wealth = (1.0 + s).cumprod() * starting_capital
    out: list[dict[str, Any]] = []
    for dt, val in wealth.items():
        out.append(
            {
                "date": pd.Timestamp(dt).date().isoformat(),
                "value": float(val),
            }
        )
    return out


def _asset_cumulative_sampled(
    raw: pd.DataFrame, step: int = 5
) -> dict[str, list[dict[str, Any]]]:
    """Per-ticker cumulative simple return; every `step`-th row for payload size."""
    if raw.empty:
        return {}
    cum = (1.0 + raw).cumprod() - 1.0
    cum_s = cum.iloc[::step]
    out: dict[str, list[dict[str, Any]]] = {}
    for col in cum_s.columns:
        out[str(col)] = [
            {
                "date": pd.Timestamp(idx).date().isoformat(),
                "cumulative_return": _json_float(v),
            }
            for idx, v in cum_s[col].items()
        ]
    return out


def _summary_records(df: pd.DataFrame, n_reb: int) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for method, row in df.iterrows():
        rows.append(
            {
                "method": str(method),
                "ann_return": _json_float(row["ann_return"]),
                "ann_vol": _json_float(row["ann_vol"]),
                "sharpe": _json_float(row["sharpe"]),
                "max_drawdown": _json_float(row["max_drawdown"]),
                "calm_drawdown": _json_float(
                    row["calm_drawdown"]
                    if "calm_drawdown" in row.index
                    else float("nan")
                ),
                "calmar": _json_float(row["calmar"]),
                "n_rebalances": int(n_reb),
            }
        )
    return rows


def _regime_rows(df: pd.DataFrame) -> list[dict[str, Any]]:
    if df.empty:
        return []
    reset = df.reset_index()
    rows: list[dict[str, Any]] = []
    for _, r in reset.iterrows():
        rows.append(
            {
                "regime": str(r["regime"]),
                "method": str(r["method"]),
                "sharpe": _json_float(r["sharpe"]),
                "max_drawdown": _json_float(r["max_drawdown"]),
            }
        )
    return rows


def _rebalance_date_strings(ts: list[pd.Timestamp]) -> list[str]:
    return [pd.Timestamp(t).date().isoformat() for t in ts]


_WEIGHT_HISTORY_MIN = 0.01  # 1%; only tickers with any allocation strictly above this


def _method_weights_by_ticker(wdf: pd.DataFrame) -> dict[str, list[dict[str, Any]]]:
    """Per-ticker rebalance series; tickers kept if max |weight| > _WEIGHT_HISTORY_MIN."""
    if wdf.empty:
        return {}
    tickers_keep = [
        str(c)
        for c in wdf.columns
        if float(wdf[c].abs().max()) > _WEIGHT_HISTORY_MIN
    ]
    out: dict[str, list[dict[str, Any]]] = {}
    for t in tickers_keep:
        pts: list[dict[str, Any]] = []
        for idx in wdf.index:
            pts.append(
                {
                    "date": pd.Timestamp(idx).date().isoformat(),
                    "weight": float(wdf.loc[idx, t]),
                }
            )
        out[t] = pts
    return out


def _weights_history_nested(
    weights_out: dict[str, pd.DataFrame],
    raw_columns: pd.Index,
    rebal_ts: list[pd.Timestamp],
) -> dict[str, dict[str, list[dict[str, Any]]]]:
    out: dict[str, dict[str, list[dict[str, Any]]]] = {}
    for m, wdf in weights_out.items():
        out[str(m)] = _method_weights_by_ticker(wdf)
    if len(raw_columns) > 0:
        n = len(raw_columns)
        w0 = 1.0 / n
        eq_df = pd.DataFrame(
            [[w0] * len(raw_columns) for _ in rebal_ts],
            index=pd.DatetimeIndex(rebal_ts),
            columns=list(raw_columns),
        )
        out["equal_weight"] = _method_weights_by_ticker(eq_df)
    else:
        out["equal_weight"] = {}
    return out


def _threshold_trigger_dates(
    rebalance_dates: list[pd.Timestamp], raw_index: pd.DatetimeIndex
) -> list[str]:
    monthly = {pd.Timestamp(d).date().isoformat() for d in _monthly_last_trading_days(raw_index)}
    out: list[str] = []
    for t in rebalance_dates:
        ds = pd.Timestamp(t).date().isoformat()
        if ds not in monthly:
            out.append(ds)
    return out


def _serialize_result(
    result: dict[str, Any],
    *,
    starting_capital: float,
    rebalance_freq: str,
    drift_threshold: float,
    signal_blend: bool,
    estimation_window: int,
) -> dict[str, Any]:
    port_rets: pd.DataFrame = result["returns"]
    raw: pd.DataFrame = result["raw_returns"]
    shrink: pd.Series = result["shrinkage"]
    rebal_ts: list[pd.Timestamp] = list(result["rebalance_dates"])

    summ_df = backtest_summary(result)
    n_reb = int(result["metadata"].get("n_rebalances", len(rebal_ts)))

    equity_curves: dict[str, list[dict[str, Any]]] = {}
    for col in port_rets.columns:
        equity_curves[str(col)] = _equity_curve(port_rets[col], starting_capital)

    shrinkage_list = [
        {"date": pd.Timestamp(dt).date().isoformat(), "alpha": float(alpha)}
        for dt, alpha in shrink.items()
    ]

    reg_df = regime_performance(result, BACKTEST_REGIMES)

    rebalance_dates_str = _rebalance_date_strings(rebal_ts)
    if rebalance_freq == "threshold":
        threshold_triggers = _threshold_trigger_dates(rebal_ts, raw.index)
    else:
        threshold_triggers = []

    metadata = {
        **dict(result["metadata"]),
        "starting_capital": starting_capital,
        "rebalance_freq": rebalance_freq,
        "drift_threshold": float(drift_threshold),
        "signal_blend": bool(signal_blend),
        "estimation_window": int(estimation_window),
    }

    weights_history_payload = _weights_history_nested(
        result["weights"],
        raw.columns,
        rebal_ts,
    )

    return BacktestResponse(
        summary=_summary_records(summ_df, n_reb),
        equity_curves=equity_curves,
        shrinkage=shrinkage_list,
        regime_performance=_regime_rows(reg_df),
        rebalance_dates=rebalance_dates_str,
        threshold_trigger_dates=threshold_triggers,
        asset_returns=_asset_cumulative_sampled(raw, step=5),
        weights_history=weights_history_payload,
        metadata=metadata,
    ).model_dump()


@router.post("/run", response_model=BacktestResponse)
def run_backtest_api(body: BacktestRequest) -> BacktestResponse:
    try:
        result = run_backtest(
            tickers=body.tickers,
            start=body.start,
            end=body.end,
            estimation_window=body.estimation_window,
            rebalance_freq=body.rebalance_freq,
            drift_threshold=body.drift_threshold,
            signal_blend=body.signal_blend,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e)) from e

    data = _serialize_result(
        result,
        starting_capital=body.starting_capital,
        rebalance_freq=body.rebalance_freq,
        drift_threshold=body.drift_threshold,
        signal_blend=body.signal_blend,
        estimation_window=body.estimation_window,
    )
    return BacktestResponse.model_validate(data)


@router.get("/stream")
async def stream_backtest(
    tickers: str = Query(..., description="Comma-separated ticker symbols"),
    start: str = Query(...),
    end: str = Query(...),
    estimation_window: int = Query(252, ge=1),
    rebalance_freq: Literal["monthly", "threshold"] = Query("monthly"),
    drift_threshold: float = Query(0.05),
    signal_blend: bool = Query(True),
    starting_capital: float = Query(100_000, gt=0),
) -> StreamingResponse:
    ticker_list = [t.strip().upper() for t in tickers.split(",") if t.strip()]
    if not ticker_list:
        raise HTTPException(status_code=400, detail="tickers must list at least one symbol")

    q: queue.Queue[tuple[str, Any]] = queue.Queue()

    def run_in_thread() -> None:
        try:
            bt_result = run_backtest(
                tickers=ticker_list,
                start=start,
                end=end,
                estimation_window=estimation_window,
                rebalance_freq=rebalance_freq,
                drift_threshold=drift_threshold,
                signal_blend=signal_blend,
                progress_callback=lambda d: q.put(("progress", d)),
            )
            q.put(("done", bt_result))
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
                yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
                break
            if kind == "timeout":
                yield f"data: {json.dumps({'type': 'error', 'message': 'Stream timeout waiting for backtest'})}\n\n"
                break
            if kind == "progress":
                line = json.dumps({"type": "progress", **data})
                yield f"data: {line}\n\n"
            elif kind == "done":
                try:
                    serialized = _serialize_result(
                        data,
                        starting_capital=starting_capital,
                        rebalance_freq=rebalance_freq,
                        drift_threshold=drift_threshold,
                        signal_blend=signal_blend,
                        estimation_window=estimation_window,
                    )
                except Exception as ser_e:
                    yield f"data: {json.dumps({'type': 'error', 'message': str(ser_e)})}\n\n"
                    break
                yield f"data: {json.dumps({'type': 'complete', 'result': serialized})}\n\n"
                break
            elif kind == "error":
                yield f"data: {json.dumps({'type': 'error', 'message': data})}\n\n"
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


@router.get("/regimes")
def get_regime_definitions() -> dict[str, list[dict[str, str]]]:
    return {"regimes": REGIME_DEFINITIONS}
