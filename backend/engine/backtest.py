"""Rolling-window optimization backtest for research and hypothesis testing."""

from __future__ import annotations

import warnings
from collections.abc import Callable
from typing import Any

import numpy as np
import pandas as pd
from sklearn.covariance import LedoitWolf

from backend.data.cache import get_returns
from backend.data.fetcher import fetch_returns
from backend.engine.optimizer import max_sharpe, min_variance, risk_parity
from backend.engine.returns import annualize_returns, ledoit_wolf_covariance
from backend.engine.risk import calm_max_drawdown, cvar_optimize, max_drawdown
from backend.engine.signals import combined_signal, signal_to_expected_returns

METHODS: tuple[str, ...] = ("min_variance", "max_sharpe", "risk_parity", "cvar")


def _monthly_last_trading_days(index: pd.DatetimeIndex) -> list[pd.Timestamp]:
    """Last available trading day in each calendar month."""
    s = pd.Series(index, index=index, dtype="datetime64[ns]")
    return [pd.Timestamp(v) for v in s.groupby(index.to_period("M")).max().values]


def _buy_and_hold_weights(w0: pd.Series, ret_after: pd.DataFrame) -> pd.Series:
    """Evolve normalized weights through daily simple returns (rows)."""
    cols = ret_after.columns
    v = w0.reindex(cols).fillna(0.0).to_numpy(dtype=float)
    for _, row in ret_after.iterrows():
        r = row.reindex(cols).fillna(0.0).to_numpy(dtype=float)
        v = v * (1.0 + r)
        s = float(v.sum())
        if s <= 1e-15:
            v = np.ones(len(cols), dtype=float) / len(cols)
        else:
            v = v / s
    return pd.Series(v, index=cols)


def _max_weight_drift(
    weights_by_method: dict[str, pd.Series | None],
    returns: pd.DataFrame,
    last_rebal: pd.Timestamp,
    day: pd.Timestamp,
) -> float:
    """Max absolute weight drift vs last rebalanced weights before ``day``."""
    sub = returns.loc[(returns.index > last_rebal) & (returns.index < day)]
    drift = 0.0
    for w0 in weights_by_method.values():
        if w0 is None:
            continue
        if sub.empty:
            continue
        w_bh = _buy_and_hold_weights(w0, sub)
        d = (w_bh - w0.reindex(sub.columns).fillna(0.0)).abs().max()
        if np.isfinite(d):
            drift = max(drift, float(d))
    return drift


def _first_drift_rebalance(
    returns: pd.DataFrame,
    last_rebal: pd.Timestamp,
    m_cap: pd.Timestamp,
    weights_by_method: dict[str, pd.Series | None],
    drift_threshold: float,
) -> pd.Timestamp | None:
    """First trading day in (last_rebal, m_cap] where drift exceeds threshold."""
    idx = returns.index
    mask = (idx > last_rebal) & (idx <= m_cap)
    for d in idx[mask]:
        if _max_weight_drift(weights_by_method, returns, last_rebal, d) > drift_threshold:
            return pd.Timestamp(d)
    return None


def _equal_weights(tickers: list[str]) -> pd.Series:
    n = len(tickers)
    if n == 0:
        return pd.Series(dtype=float)
    w = 1.0 / n
    return pd.Series({t: w for t in tickers}, dtype=float)


def _optimize_all(
    mu: pd.Series,
    cov: pd.DataFrame,
    est: pd.DataFrame,
    tickers: list[str],
    signal_blend: bool,
    shrinkage: float,
) -> dict[str, pd.Series]:
    """Run four optimizers; fall back to equal weights on failure."""
    mu_use = mu
    if signal_blend:
        sig = combined_signal(est)
        w_sig = max(0.0, 1.0 - float(shrinkage))
        mu_use = signal_to_expected_returns(sig, mu, signal_weight=w_sig)

    out: dict[str, pd.Series] = {}
    eq = _equal_weights(tickers)

    r = min_variance(mu_use, cov, allow_short=False)
    out["min_variance"] = r["weights"] if r is not None else eq.copy()

    r = max_sharpe(mu_use, cov, rf=0.0, allow_short=False)
    out["max_sharpe"] = r["weights"] if r is not None else eq.copy()

    r = risk_parity(cov, mu_use)
    out["risk_parity"] = r["weights"] if r is not None else eq.copy()

    r = cvar_optimize(mu_use, est, target_return=None, confidence=0.95, allow_short=False)
    out["cvar"] = r["weights"] if r is not None else eq.copy()

    for k in out:
        out[k] = out[k].reindex(tickers).fillna(0.0).astype(float)
        s = float(out[k].sum())
        if s > 1e-12:
            out[k] = out[k] / s
        else:
            out[k] = eq.copy()
    return out


def run_backtest(
    tickers: list[str] | None,
    start: str,
    end: str,
    estimation_window: int = 252,
    rebalance_freq: str = "monthly",
    drift_threshold: float = 0.05,
    signal_blend: bool = True,
    n_jobs: int = 1,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
    returns: pd.DataFrame | None = None,
    use_point_in_time: bool = False,
    pit_universe_type: str = "SP50",
) -> dict[str, Any]:
    """
    Rolling estimation window, periodic rebalancing, four optimizers + equal weight.

    If ``returns`` is provided, it must cover ``start``..``end`` and no fetch is done.

    When ``use_point_in_time`` is True, ``tickers`` may be None; the universe comes from
    ``backend.data.pit_universe`` (membership history + cap ranks). Returns are fetched via
    ``fetch_returns`` (no SQLite cache) when ``returns`` is None.

    Returns dict with keys: returns, raw_returns, weights, shrinkage,
    rebalance_dates, metadata.
    """
    if n_jobs != 1:
        warnings.warn("backtest: n_jobs > 1 not supported yet; running sequentially", stacklevel=2)

    pit_u = str(pit_universe_type).strip().upper()
    if pit_u not in ("SP50", "SP100", "SP500"):
        raise ValueError("pit_universe_type must be SP50, SP100, or SP500")

    pit_union_n = 0
    pit_rebalance_fallback = 50 if pit_u == "SP50" else (100 if pit_u == "SP100" else 500)

    if use_point_in_time:
        from backend.data.pit_universe import collect_pit_ticker_union, get_pit_universe

        union_list = collect_pit_ticker_union(start, end, universe=pit_u)
        pit_union_n = len(union_list)
        if returns is None:
            print(
                f"[backtest] PIT ({pit_u}): fetching returns without cache ({pit_union_n} tickers)",
                flush=True,
            )
            asset_rets = fetch_returns(union_list, start, end).sort_index()
        else:
            asset_rets = returns.copy()
            asset_rets.sort_index(inplace=True)
            cols = [c for c in union_list if c in asset_rets.columns]
            asset_rets = asset_rets[cols]
        meta_tickers = sorted(asset_rets.columns.tolist())

        def cols_at(rebal_date: pd.Timestamp) -> list[str]:
            pit_syms = get_pit_universe(
                rebal_date.date().isoformat(),
                universe=pit_u,
                max_n=500,
            )
            pit_cols = [t for t in pit_syms if t in asset_rets.columns]
            n = len(pit_cols)
            print(
                f"[backtest] {rebal_date.date()}: {n} PIT tickers ({pit_u})",
                flush=True,
            )
            if n < 5:
                pit_cols = list(asset_rets.columns)[: min(pit_rebalance_fallback, len(asset_rets.columns))]
            return pit_cols

    else:
        if not tickers:
            raise ValueError("tickers required when use_point_in_time is False")
        tickers = [str(t).strip().upper() for t in tickers]
        meta_tickers = list(tickers)
        if returns is None:
            asset_rets = get_returns(tickers, start, end).sort_index()
        else:
            asset_rets = returns.copy()
            asset_rets.sort_index(inplace=True)
            cols = [c for c in tickers if c in asset_rets.columns]
            asset_rets = asset_rets[cols]

        def cols_at(_rebal_date: pd.Timestamp) -> list[str]:
            return list(asset_rets.columns)

    if asset_rets.empty or asset_rets.shape[1] == 0:
        raise ValueError("no returns data for backtest")

    monthly = _monthly_last_trading_days(asset_rets.index)
    min_obs = 126
    monthly_ok = [m for m in monthly if len(asset_rets.loc[asset_rets.index < m]) >= min_obs]
    if not monthly_ok:
        raise ValueError("insufficient history for any rebalance date")

    if rebalance_freq not in ("monthly", "threshold"):
        raise ValueError("rebalance_freq must be 'monthly' or 'threshold'")

    rebal_dates: list[pd.Timestamp] = []
    last_rebal: pd.Timestamp | None = None
    w_place: dict[str, pd.Series | None] = {m: None for m in METHODS}
    mi = 0

    while mi < len(monthly_ok):
        m_cap = monthly_ok[mi]
        if last_rebal is None:
            rebal_dates.append(m_cap)
            tc = cols_at(m_cap)
            hist = asset_rets.loc[asset_rets.index < m_cap].tail(estimation_window)[tc]
            if len(hist) < min_obs:
                mi += 1
                continue
            lw_fit = LedoitWolf().fit(hist.to_numpy(dtype=float))
            alpha_t = float(lw_fit.shrinkage_)
            cov = ledoit_wolf_covariance(hist)
            mu = annualize_returns(hist).reindex(tc).fillna(0.0)
            w_place = _optimize_all(mu, cov, hist, tc, signal_blend, alpha_t)
            last_rebal = m_cap
            mi += 1
            continue

        if rebalance_freq == "monthly":
            t_exec = m_cap
        else:
            t_extra = _first_drift_rebalance(
                asset_rets, last_rebal, m_cap, w_place, drift_threshold
            )
            t_exec = (
                t_extra
                if t_extra is not None and t_extra > last_rebal
                else m_cap
            )

        if t_exec <= last_rebal:
            mi += 1
            continue

        rebal_dates.append(t_exec)
        tc = cols_at(t_exec)
        hist = asset_rets.loc[asset_rets.index < t_exec].tail(estimation_window)[tc]
        if len(hist) >= min_obs:
            lw_fit = LedoitWolf().fit(hist.to_numpy(dtype=float))
            alpha_t = float(lw_fit.shrinkage_)
            cov = ledoit_wolf_covariance(hist)
            mu = annualize_returns(hist).reindex(tc).fillna(0.0)
            w_place = _optimize_all(mu, cov, hist, tc, signal_blend, alpha_t)
        last_rebal = t_exec
        if t_exec >= m_cap:
            mi += 1

    seen: set[pd.Timestamp] = set()
    rebal_final: list[pd.Timestamp] = []
    for t in rebal_dates:
        ts = pd.Timestamp(t)
        if ts not in seen:
            seen.add(ts)
            rebal_final.append(ts)
    rebal_dates = rebal_final

    shrinkage_vals: list[float] = []
    weight_store: dict[str, list[tuple[pd.Timestamp, pd.Series]]] = {m: [] for m in METHODS}
    pit_universe_changes: list[dict[str, Any]] = []
    prev_pit_tc: set[str] | None = None

    n_rebalances = len(rebal_dates)
    for i, t in enumerate(rebal_dates):
        tc = cols_at(t)
        hist = asset_rets.loc[asset_rets.index < t].tail(estimation_window)[tc]
        if len(hist) < min_obs:
            print(f"skip rebal {t.date()}: only {len(hist)} obs")
            continue

        tc_set = set(tc)
        if use_point_in_time:
            if prev_pit_tc is None:
                pit_universe_changes.append(
                    {
                        "date": str(t.date()),
                        "n_tickers": len(tc),
                        "joined": sorted(tc_set),
                        "left": [],
                    }
                )
            else:
                pit_universe_changes.append(
                    {
                        "date": str(t.date()),
                        "n_tickers": len(tc),
                        "joined": sorted(tc_set - prev_pit_tc),
                        "left": sorted(prev_pit_tc - tc_set),
                    }
                )
            prev_pit_tc = tc_set

        lw_fit = LedoitWolf().fit(hist.to_numpy(dtype=float))
        alpha_t = float(lw_fit.shrinkage_)
        cov = ledoit_wolf_covariance(hist)
        mu = annualize_returns(hist).reindex(tc).fillna(0.0)

        print(
            f"Rebalancing {i + 1}/{len(rebal_dates)}  date={t.date()}  alpha={alpha_t:.3f}"
        )

        w_dict = _optimize_all(mu, cov, hist, tc, signal_blend, alpha_t)
        shrinkage_vals.append(alpha_t)
        for m in METHODS:
            w_full = w_dict[m].reindex(asset_rets.columns).fillna(0.0)
            weight_store[m].append((t, w_full))

        if progress_callback is not None and n_rebalances > 0:
            progress_callback(
                {
                    "step": i + 1,
                    "total": n_rebalances,
                    "date": str(t.date()),
                    "alpha": round(float(alpha_t), 4),
                    "pct": round((i + 1) / n_rebalances * 100, 1),
                }
            )

    if not shrinkage_vals:
        raise ValueError("no successful rebalance events")

    weights_out: dict[str, pd.DataFrame] = {}
    for m in METHODS:
        rows = weight_store[m]
        idx = [r[0] for r in rows]
        mat = pd.DataFrame(
            [r[1].reindex(asset_rets.columns).fillna(0.0).values for r in rows],
            index=idx,
            columns=list(asset_rets.columns),
        )
        weights_out[m] = mat

    rebal_ts = [
        weight_store["max_sharpe"][j][0] for j in range(len(weight_store["max_sharpe"]))
    ]
    shrink_ser = pd.Series(shrinkage_vals, index=rebal_ts)

    eq_w = _equal_weights(list(asset_rets.columns))

    out_returns = pd.DataFrame(
        index=asset_rets.index,
        columns=list(METHODS) + ["equal_weight"],
        dtype=float,
    )

    for ri, t_r in enumerate(rebal_ts):
        t_next = rebal_ts[ri + 1] if ri + 1 < len(rebal_ts) else None
        if t_next is not None:
            mask = (asset_rets.index >= t_r) & (asset_rets.index < t_next)
        else:
            mask = asset_rets.index >= t_r
        slice_r = asset_rets.loc[mask]
        if slice_r.empty:
            continue
        for meth in METHODS:
            w = weights_out[meth].loc[t_r]
            out_returns.loc[slice_r.index, meth] = (slice_r * w).sum(axis=1)
        out_returns.loc[slice_r.index, "equal_weight"] = (slice_r * eq_w).sum(axis=1)

    metadata: dict[str, Any] = {
        "tickers": meta_tickers,
        "start": start,
        "end": end,
        "estimation_window": estimation_window,
        "rebalance_freq": rebalance_freq,
        "n_rebalances": len(rebal_ts),
        "use_point_in_time": use_point_in_time,
        "pit_universe_type": pit_u if use_point_in_time else None,
    }
    if use_point_in_time:
        metadata["pit_union_n"] = pit_union_n
        metadata["pit_universe_changes"] = pit_universe_changes
    else:
        metadata["pit_universe_changes"] = None

    return {
        "returns": out_returns.astype(float),
        "raw_returns": asset_rets.astype(float),
        "weights": weights_out,
        "shrinkage": shrink_ser,
        "rebalance_dates": [pd.Timestamp(x) for x in rebal_ts],
        "metadata": metadata,
    }


def backtest_summary(backtest_result: dict) -> pd.DataFrame:
    """One row per method: ann return, vol, Sharpe, max DD, calm DD, Calmar, n_rebalances."""
    r = backtest_result["returns"]
    n_reb = int(backtest_result["metadata"].get("n_rebalances", 0))
    rows = []
    for method in r.columns:
        s = r[method].dropna()
        if s.empty:
            continue
        mean_d = float(s.mean())
        std_d = float(s.std(ddof=1)) if len(s) > 1 else 0.0
        ann_r = mean_d * 252.0
        ann_v = std_d * np.sqrt(252.0) if std_d > 0 else 0.0
        sharpe = ann_r / ann_v if ann_v > 1e-12 else float("nan")
        mdd = max_drawdown(s)
        calm_dd = calm_max_drawdown(s)
        calmar = ann_r / abs(mdd) if mdd != 0 and np.isfinite(mdd) else float("nan")
        rows.append(
            {
                "method": method,
                "ann_return": ann_r,
                "ann_vol": ann_v,
                "sharpe": sharpe,
                "max_drawdown": mdd,
                "calm_drawdown": calm_dd,
                "calmar": calmar,
                "n_rebalances": n_reb,
            }
        )
    df = pd.DataFrame(rows).set_index("method")
    print("[backtest_summary] columns:", list(df.columns), flush=True)
    return df


def regime_performance(
    backtest_result: dict,
    regimes: dict[str, tuple[str, str]],
) -> pd.DataFrame:
    """Sharpe and max drawdown per regime and method (MultiIndex: regime, method)."""
    r = backtest_result["returns"]
    out_rows = []
    for regime_name, (rs, re) in regimes.items():
        mask = (r.index >= pd.Timestamp(rs)) & (r.index <= pd.Timestamp(re))
        sub = r.loc[mask]
        for col in sub.columns:
            s = sub[col].dropna()
            if s.empty:
                continue
            mean_d = float(s.mean())
            std_d = float(s.std(ddof=1)) if len(s) > 1 else 0.0
            ann_v = std_d * np.sqrt(252.0) if std_d > 0 else 0.0
            ann_r = mean_d * 252.0
            sharpe = ann_r / ann_v if ann_v > 1e-12 else float("nan")
            mdd = max_drawdown(s)
            out_rows.append(
                {
                    "regime": regime_name,
                    "method": col,
                    "sharpe": sharpe,
                    "max_drawdown": mdd,
                }
            )
    df = pd.DataFrame(out_rows)
    if df.empty:
        return df
    return df.set_index(["regime", "method"])


if __name__ == "__main__":
    from backend.data.universe import SP50

    rng = ("2019-01-01", "2023-12-31")
    regimes = {
        ".com bubble burst": ("2000-03-10", "2002-10-09"),
        "2008 financial crisis": ("2008-09-15", "2009-03-09"),
        "Q4 2018 bear": ("2018-10-03", "2018-12-24"),
        "COVID crash": ("2020-02-19", "2020-04-30"),
        "Rate shock": ("2022-01-03", "2022-12-31"),
        "Liberation Day": ("2025-04-02", "2025-04-08"),
    }

    print("=== Monthly rebalancing ===")
    bt_m = run_backtest(list(SP50), *rng, rebalance_freq="monthly")
    print(backtest_summary(bt_m).round(4))
    print()

    print("=== Threshold rebalancing ===")
    bt_t = run_backtest(list(SP50), *rng, rebalance_freq="threshold", drift_threshold=0.05)
    print(backtest_summary(bt_t).round(4))
    print()

    print("=== Regime performance (monthly) ===")
    print(regime_performance(bt_m, regimes).round(4))
    print()

    print("=== Shrinkage intensity (monthly rebal) ===")
    print(bt_m["shrinkage"].round(4))
