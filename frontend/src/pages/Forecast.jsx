import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { buildForecastStreamUrl } from '../api/forecast.js'
import EngineStreamLoading from '../components/EngineStreamLoading.jsx'
import {
  CHART_AXIS_STROKE,
  CHART_GRID,
  CHART_NEG,
  CHART_NEUTRAL,
  CHART_POS,
  CHART_TICK,
  CHART_TOOLTIP_STYLE,
} from '../chartTheme.js'
import { SP100_TICKERS, SP50_TICKERS } from '../data/universeTickers.js'
import '../pageUniverse.css'
import './Forecast.css'

const DEFAULT_TICKERS = ['AAPL', 'MSFT', 'GOOGL', 'JPM', 'JNJ']

const METHOD_OPTIONS = [
  { id: 'min_variance', label: 'Min variance' },
  { id: 'max_sharpe', label: 'Max Sharpe' },
  { id: 'efficient_frontier', label: 'Efficient frontier' },
  { id: 'risk_parity', label: 'Risk parity' },
]

const LOOKBACK_OPTIONS = [252, 400, 504]

const FACTOR_ORDER = ['Mkt-RF', 'SMB', 'HML', 'RMW', 'CMA']

const STORAGE_SHRINK_MEAN = 'machalpha_backtest_shrinkage_mean'

function methodLabel(id) {
  return METHOD_OPTIONS.find((o) => o.id === id)?.label ?? id
}

export default function Forecast() {
  const [universeMode, setUniverseMode] = useState('SP50')
  const [tickers, setTickers] = useState(() => [...SP50_TICKERS])
  const [tickerInput, setTickerInput] = useState('')
  const [lookbackDays, setLookbackDays] = useState(400)
  const [method, setMethod] = useState('max_sharpe')
  const [useSignalBlend, setUseSignalBlend] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  const [streamStep, setStreamStep] = useState('')
  const [streamPct, setStreamPct] = useState(0)
  const [streamElapsed, setStreamElapsed] = useState(0)
  const streamDoneRef = useRef(false)

  useEffect(() => {
    if (!loading) return undefined
    const id = setInterval(() => setStreamElapsed((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [loading])

  const onUniverseChange = useCallback((e) => {
    const v = e.target.value
    setUniverseMode(v)
    if (v === 'SP50') setTickers([...SP50_TICKERS])
    else if (v === 'SP100') setTickers([...SP100_TICKERS])
    else setTickers([...DEFAULT_TICKERS])
    setTickerInput('')
  }, [])

  const flushTickerInput = useCallback(() => {
    if (universeMode !== 'Custom') return
    const raw = tickerInput.trim()
    if (!raw) return
    const parts = raw.split(/[,\s;]+/).map((p) => p.trim().toUpperCase()).filter(Boolean)
    setTickers((prev) => {
      const next = [...prev]
      for (const p of parts) {
        if (p && !next.includes(p)) next.push(p)
      }
      return next
    })
    setTickerInput('')
  }, [tickerInput, universeMode])

  const removeTicker = useCallback((t) => {
    if (universeMode !== 'Custom') return
    setTickers((prev) => prev.filter((x) => x !== t))
  }, [universeMode])

  const handleRun = () => {
    setError(null)
    setLoading(true)
    setResult(null)
    streamDoneRef.current = false
    setStreamElapsed(0)
    setStreamStep('Connecting…')
    setStreamPct(0)

    const url = buildForecastStreamUrl({
      tickers,
      lookback_days: lookbackDays,
      method,
      use_signal_blend: useSignalBlend,
    })
    const es = new EventSource(url)

    es.onmessage = (ev) => {
      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        es.close()
        streamDoneRef.current = true
        setError('Invalid stream data from server')
        setLoading(false)
        return
      }
      if (msg.type === 'progress') {
        const pct = Number(msg.pct)
        const step = typeof msg.step === 'string' ? msg.step : ''
        setStreamPct(Number.isFinite(pct) ? pct : 0)
        setStreamStep(step ? `${step}…` : '')
      } else if (msg.type === 'complete') {
        streamDoneRef.current = true
        es.close()
        setResult(msg.result ?? null)
        setLoading(false)
        setStreamStep('')
      } else if (msg.type === 'error') {
        streamDoneRef.current = true
        es.close()
        setResult(null)
        setError(typeof msg.message === 'string' ? msg.message : 'Forecast failed')
        setLoading(false)
        setStreamStep('')
      }
    }

    es.onerror = () => {
      es.close()
      if (streamDoneRef.current) return
      streamDoneRef.current = true
      setLoading(false)
      setError('Stream connection error')
    }
  }

  const barData = useMemo(() => {
    if (!result?.weights) return []
    const pairs = Object.entries(result.weights)
      .map(([ticker, weight]) => ({
        ticker,
        weight: Number(weight),
      }))
      .filter((d) => d.weight > 0.001)
    pairs.sort((a, b) => b.weight - a.weight)
    return pairs
  }, [result])

  const factorChartData = useMemo(() => {
    if (!result?.factor_exposures) return []
    const exp = result.factor_exposures
    return FACTOR_ORDER.filter((f) => f in exp).map((factor) => ({
      factor,
      exposure: Number(exp[factor] ?? 0),
    }))
  }, [result])

  const capSignal =
    result != null
      ? Math.min(0.5, Math.max(0.1, 1 - Number(result.shrinkage_alpha)))
      : null

  const regimeSentence = useMemo(() => {
    if (result == null) return ''
    const a = Number(result.shrinkage_alpha)
    if (!Number.isFinite(a)) return ''
    if (a > 0.1) {
      return `Current alpha of ${a.toFixed(4)} is above the 0.10 high-uncertainty threshold identified in research.`
    }
    return `Current alpha of ${a.toFixed(4)} is below the 0.10 high-uncertainty threshold identified in research.`
  }, [result])

  const forwardSignalRows = useMemo(() => {
    if (!result) return null
    const avg = Number(result.combined_signal_mean ?? 0)
    let momentumLabel = 'NEUTRAL'
    let momentumClass = 'forecast__signal-val--neutral'
    if (avg > 0.2) {
      momentumLabel = 'BULLISH'
      momentumClass = 'forecast__signal-val--bull'
    } else if (avg < -0.2) {
      momentumLabel = 'BEARISH'
      momentumClass = 'forecast__signal-val--bear'
    }

    const alpha = Number(result.shrinkage_alpha)
    let uncertainty = 'MEDIUM'
    let uncertaintyClass = 'forecast__signal-val--unc-medium'
    if (alpha < 0.05) {
      uncertainty = 'LOW'
      uncertaintyClass = 'forecast__signal-val--unc-low'
    } else if (alpha > 0.1) {
      uncertainty = 'HIGH'
      uncertaintyClass = 'forecast__signal-val--unc-high'
    }

    let reliability = 'REDUCED'
    let reliabilityClass = 'forecast__signal-val--rel-reduced'
    if (alpha < 0.05) {
      reliability = 'HIGH'
      reliabilityClass = 'forecast__signal-val--rel-high'
    } else if (alpha > 0.1) {
      reliability = 'LOW'
      reliabilityClass = 'forecast__signal-val--rel-low'
    }

    const conf = result.confidence_level
    let action = 'Monitor — mixed signals'
    if (conf === 'LOW' && momentumLabel === 'BEARISH') {
      action = 'Consider equal weighting or risk parity'
    } else if (conf === 'HIGH' && momentumLabel === 'BULLISH') {
      action = 'Signals support active allocation'
    }

    return [
      {
        key: 'mom',
        label: 'Momentum direction',
        value: momentumLabel,
        valueClass: momentumClass,
      },
      {
        key: 'unc',
        label: 'Uncertainty regime',
        value: uncertainty,
        valueClass: uncertaintyClass,
      },
      {
        key: 'rel',
        label: 'Signal reliability',
        value: reliability,
        valueClass: reliabilityClass,
      },
      {
        key: 'act',
        label: 'Recommended action',
        value: action,
        valueClass: 'forecast__signal-val--action',
      },
    ]
  }, [result])

  const confidenceBanner = useMemo(() => {
    if (!result) return null
    const lvl = result.confidence_level
    const a = Number(result.shrinkage_alpha).toFixed(4)
    if (lvl === 'HIGH') {
      return {
        className: 'forecast__banner forecast__banner--high',
        title: `HIGH CONFIDENCE — Low market uncertainty (α=${a})`,
      }
    }
    if (lvl === 'MEDIUM') {
      return {
        className: 'forecast__banner forecast__banner--medium',
        title: `MEDIUM CONFIDENCE — Elevated uncertainty (α=${a})`,
      }
    }
    return {
      className: 'forecast__banner forecast__banner--low',
      title: `LOW CONFIDENCE — High uncertainty (α=${a}). Consider equal weighting.`,
    }
  }, [result])

  let histShrinkMean = null
  if (typeof sessionStorage !== 'undefined') {
    const v = sessionStorage.getItem(STORAGE_SHRINK_MEAN)
    if (v != null && v !== '') {
      const n = Number(v)
      histShrinkMean = Number.isFinite(n) ? n : null
    }
  }

  return (
    <main className="page page--forecast">
      <header className="page-masthead">
        <h1 className="page-masthead__title">Forecast</h1>
        <p className="page-masthead__dateline">
          Live trailing window · Ledoit-Wolf shrinkage · Dynamic signal blend · 1-month horizon
        </p>
      </header>
      <div className="forecast">
        <aside className="forecast__left">
          <div className="forecast__section">
            <div className="forecast__label">Universe</div>
            <select
              className="page-universe-select"
              value={universeMode}
              onChange={onUniverseChange}
              aria-label="Universe preset"
            >
              <option value="SP50">SP50</option>
              <option value="SP100">SP100</option>
              <option value="Custom">Custom</option>
            </select>
            {universeMode === 'Custom' ? (
              <>
                <div className="forecast__chip-row">
                  {tickers.map((t) => (
                    <span key={t} className="forecast__chip">
                      {t}
                      <button
                        type="button"
                        className="forecast__chip-remove"
                        aria-label={`Remove ${t}`}
                        onClick={() => removeTicker(t)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
                <input
                  className="forecast__input"
                  type="text"
                  placeholder="Ticker, Enter or comma to add"
                  value={tickerInput}
                  onChange={(e) => setTickerInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      flushTickerInput()
                    }
                    if (e.key === ',') {
                      e.preventDefault()
                      flushTickerInput()
                    }
                  }}
                />
                <p className="forecast__hint">
                  Add tickers with Enter or comma. Duplicates are skipped.
                </p>
              </>
            ) : (
              <div className="page-universe-pill" aria-live="polite">
                {universeMode} ·{' '}
                {universeMode === 'SP50' ? SP50_TICKERS.length : SP100_TICKERS.length} tickers
              </div>
            )}
          </div>

          <div className="forecast__section">
            <div className="forecast__label">Lookback window</div>
            <div className="forecast__lookback-row">
              {LOOKBACK_OPTIONS.map((d) => (
                <button
                  key={d}
                  type="button"
                  className={
                    lookbackDays === d
                      ? 'forecast__lookback-btn forecast__lookback-btn--active'
                      : 'forecast__lookback-btn'
                  }
                  onClick={() => setLookbackDays(d)}
                >
                  {d} days
                </button>
              ))}
            </div>
          </div>

          <div className="forecast__section">
            <div className="forecast__label">Method</div>
            <div className="forecast__method-grid">
              {METHOD_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={
                    method === opt.id
                      ? 'forecast__method-btn forecast__method-btn--active'
                      : 'forecast__method-btn'
                  }
                  onClick={() => setMethod(opt.id)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="forecast__section">
            <label className="forecast__toggle-row">
              <input
                type="checkbox"
                checked={useSignalBlend}
                onChange={(e) => setUseSignalBlend(e.target.checked)}
              />
              <span>
                Signal blend{' '}
                <span className="forecast__hint" style={{ display: 'block', marginTop: 4 }}>
                  Dynamic weight = 1 − shrinkage intensity
                </span>
              </span>
            </label>
          </div>

          <button
            type="button"
            className="forecast__run"
            disabled={loading || tickers.length === 0}
            onClick={handleRun}
          >
            {loading && <span className="forecast__spinner" aria-hidden />}
            Generate forecast
          </button>
          <p className="forecast__disclaimer">
            Optimal allocation over the trailing window, adjusted for current momentum signals. Most
            applicable over a 1-month horizon before rebalancing. Not investment advice.
          </p>
          {error ? <div className="forecast__error">{error}</div> : null}
        </aside>

        {loading || result ? (
          <section className="forecast__right">
            {loading ? (
              <EngineStreamLoading
                title="Forecast"
                stepText={streamStep}
                elapsedSec={streamElapsed}
                primaryPct={streamPct}
              />
            ) : (
              <>
                {confidenceBanner ? (
                  <div className={confidenceBanner.className}>
                    <div className="forecast__banner-title">{confidenceBanner.title}</div>
                    <p className="forecast__banner-note">
                      Confidence based on Ledoit-Wolf shrinkage intensity. Higher α = less reliable
                      covariance estimates.
                    </p>
                  </div>
                ) : null}

                <div className="forecast__card">
                  <div className="forecast__block-title">
                    RECOMMENDED WEIGHTS — {methodLabel(result.method)} · {result.data_through}
                  </div>
                  <div className="forecast__chart-wrap">
                    <ResponsiveContainer width="100%" height={300}>
                      <BarChart
                        layout="vertical"
                        data={barData}
                        margin={{ top: 4, right: 56, left: 8, bottom: 4 }}
                      >
                        <CartesianGrid {...CHART_GRID} horizontal={false} strokeDasharray="" />
                        <XAxis
                          type="number"
                          domain={[0, 1]}
                          tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
                          stroke={CHART_AXIS_STROKE}
                          tick={CHART_TICK}
                        />
                        <YAxis
                          type="category"
                          dataKey="ticker"
                          width={72}
                          stroke={CHART_AXIS_STROKE}
                          tick={CHART_TICK}
                        />
                        <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
                        <Bar dataKey="weight" fill={CHART_NEUTRAL} barSize={18} radius={0}>
                          <LabelList
                            dataKey="weight"
                            position="right"
                            fill="#444"
                            fontSize={10}
                            fontFamily="IBM Plex Mono, monospace"
                            formatter={(v) => `${(Number(v) * 100).toFixed(1)}%`}
                          />
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="forecast__meta">
                    Signal blend weight: {(Number(result.signal_weight_used) * 100).toFixed(0)}% · Data
                    through: {result.data_through} · {result.tickers_used?.length ?? 0} tickers
                  </div>
                  {Array.isArray(result.tickers_dropped) && result.tickers_dropped.length > 0 ? (
                    <div className="forecast__warn-dropped">
                      Dropped {result.tickers_dropped.length} ticker(s) due to insufficient data:{' '}
                      {result.tickers_dropped.join(', ')}
                    </div>
                  ) : null}
                </div>

                <div className="forecast__card">
                  <div className="forecast__block-title">
                    TRAILING ESTIMATES (IN-SAMPLE)
                  </div>
                  <div className="forecast__stats-grid">
                    <div className="forecast__stat-card">
                      <div className="forecast__stat-name">Trailing ann. return</div>
                      <div
                        className="forecast__stat-value"
                        style={{
                          color: Number(result.expected_return) >= 0 ? 'var(--green)' : 'var(--red)',
                        }}
                      >
                        {(Number(result.expected_return) * 100).toFixed(2)}%
                      </div>
                    </div>
                    <div className="forecast__stat-card">
                      <div className="forecast__stat-name">Trailing volatility</div>
                      <div className="forecast__stat-value" style={{ color: 'var(--amber)' }}>
                        {(Number(result.expected_volatility) * 100).toFixed(2)}%
                      </div>
                    </div>
                    <div className="forecast__stat-card">
                      <div className="forecast__stat-name">Trailing Sharpe</div>
                      <div className="forecast__stat-value" style={{ color: 'var(--text-primary)' }}>
                        {Number(result.expected_sharpe).toFixed(2)}
                      </div>
                    </div>
                    <div className="forecast__stat-card">
                      <div className="forecast__stat-name">Signal weight used</div>
                      <div className="forecast__stat-value" style={{ color: 'var(--text-muted)' }}>
                        {(Number(result.signal_weight_used) * 100).toFixed(0)}%
                      </div>
                    </div>
                  </div>
                  <div className="forecast__stats-row2">
                    <div className="forecast__stat-card">
                      <div className="forecast__stat-name">VaR 95%</div>
                      <div className="forecast__stat-value" style={{ color: 'var(--red)' }}>
                        {(Number(result.var_95) * 100).toFixed(2)}%
                      </div>
                    </div>
                    <div className="forecast__stat-card">
                      <div className="forecast__stat-name">CVaR 95%</div>
                      <div className="forecast__stat-value" style={{ color: 'var(--red)' }}>
                        {(Number(result.cvar_95) * 100).toFixed(2)}%
                      </div>
                    </div>
                  </div>
                  <p className="forecast__caveat">
                    These metrics reflect annualized performance of the recommended weights over the
                    trailing {lookbackDays}-day estimation window — not forward predictions. The
                    recommended allocation is signal-driven; historical performance of these weights
                    does not imply future results.
                  </p>
                </div>

                {forwardSignalRows ? (
                  <div className="forecast__card">
                    <div className="forecast__block-title">FORWARD SIGNAL SUMMARY</div>
                    <table className="forecast__context-table">
                      <thead>
                        <tr>
                          <th>Indicator</th>
                          <th>Reading</th>
                        </tr>
                      </thead>
                      <tbody>
                        {forwardSignalRows.map((row) => (
                          <tr key={row.key}>
                            <td>{row.label}</td>
                            <td className={row.valueClass}>{row.value}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : null}

                <div className="forecast__card">
                  <div className="forecast__block-title">
                    FACTOR EXPOSURES — CURRENT POSITIONING
                  </div>
                  {factorChartData.length > 0 ? (
                    <div className="forecast__chart-wrap">
                      <ResponsiveContainer width="100%" height={300}>
                        <BarChart
                          layout="vertical"
                          data={factorChartData}
                          margin={{ top: 5, right: 60, left: 10, bottom: 5 }}
                        >
                          <CartesianGrid {...CHART_GRID} horizontal={false} strokeDasharray="" />
                          <XAxis type="number" stroke={CHART_AXIS_STROKE} tick={CHART_TICK} />
                          <YAxis
                            type="category"
                            dataKey="factor"
                            width={70}
                            tickMargin={8}
                            stroke={CHART_AXIS_STROKE}
                            tick={CHART_TICK}
                          />
                          <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
                          <ReferenceLine x={0} stroke="#666" strokeWidth={1} />
                          <Bar dataKey="exposure" barSize={18} radius={0}>
                            {factorChartData.map((entry) => (
                              <Cell
                                key={entry.factor}
                                fill={entry.exposure >= 0 ? CHART_POS : CHART_NEG}
                              />
                            ))}
                            <LabelList
                              dataKey="exposure"
                              position="right"
                              formatter={(v) => v.toFixed(3)}
                              style={{
                                fill: '#888',
                                fontSize: 10,
                                fontFamily: 'IBM Plex Mono, monospace',
                              }}
                            />
                          </Bar>
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <p className="forecast__meta">Insufficient data for factor loadings.</p>
                  )}
                </div>

                <div className="forecast__card">
                  <div className="forecast__block-title">Market context</div>
                  <table className="forecast__context-table">
                    <thead>
                      <tr>
                        <th>Metric</th>
                        <th>Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>Shrinkage intensity (current)</td>
                        <td>{Number(result.shrinkage_alpha).toFixed(4)}</td>
                      </tr>
                      <tr>
                        <td>Historical avg (last Backtest run)</td>
                        <td>
                          {histShrinkMean != null && Number.isFinite(histShrinkMean)
                            ? histShrinkMean.toFixed(4)
                            : '—'}
                          {histShrinkMean == null ? (
                            <span style={{ color: 'var(--text-muted)', marginLeft: 8 }}>
                              Run Backtest to compare
                            </span>
                          ) : null}
                        </td>
                      </tr>
                      <tr>
                        <td>Signal weight (used vs max 100%)</td>
                        <td>
                          {(Number(result.signal_weight_used) * 100).toFixed(1)}% used · cap{' '}
                          {capSignal != null ? `${(capSignal * 100).toFixed(1)}%` : '—'}{' '}
                          <span style={{ color: 'var(--text-muted)' }}>(min 50%, max(10%, 1 − α))</span>
                        </td>
                      </tr>
                      <tr>
                        <td>Max drawdown (historical, lookback)</td>
                        <td>{(Number(result.max_drawdown) * 100).toFixed(2)}%</td>
                      </tr>
                    </tbody>
                  </table>
                  <p className="forecast__context-interpret">{regimeSentence}</p>
                </div>
              </>
            )}
          </section>
        ) : null}
      </div>
      <footer className="page-byline">machAlpha · Portfolio Optimization Engine</footer>
    </main>
  )
}
