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
import { buildFactorsStreamUrl } from '../api/factors.js'
import EngineStreamLoading from '../components/EngineStreamLoading.jsx'
import CorrelationHeatmap from '../components/CorrelationHeatmap.jsx'
import {
  CHART_AXIS_STROKE,
  CHART_GRID,
  CHART_NEG,
  CHART_POS,
  CHART_TICK,
  CHART_TOOLTIP_STYLE,
} from '../chartTheme.js'
import { SP100_TICKERS, SP50_TICKERS } from '../data/universeTickers.js'
import '../pageUniverse.css'
import './Factors.css'

const DEFAULT_TICKERS = ['AAPL', 'MSFT', 'GOOGL', 'JPM', 'JNJ']

const FACTOR_COLS = ['Mkt-RF', 'SMB', 'HML', 'RMW', 'CMA']

const VALUE_EPS = 0.001

function equalWeights(tickerList) {
  const n = tickerList.length
  if (n === 0) return {}
  const w = 1 / n
  return Object.fromEntries(tickerList.map((t) => [t, w]))
}

function signColor(value) {
  if (value > VALUE_EPS) return 'var(--green)'
  if (value < -VALUE_EPS) return 'var(--red)'
  return 'var(--text-muted)'
}

function formatBp(x) {
  const v = Number(x) * 10000
  return `${v.toFixed(2)} bp`
}

export default function Factors() {
  const [universeMode, setUniverseMode] = useState('Custom')
  const [tickers, setTickers] = useState(() => [...DEFAULT_TICKERS])
  const [tickerInput, setTickerInput] = useState('')
  const [startDate, setStartDate] = useState('2020-01-01')
  const [endDate, setEndDate] = useState('2023-12-31')
  const [weights, setWeights] = useState(() => equalWeights(DEFAULT_TICKERS))
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
    if (v === 'SP50') {
      setTickers([...SP50_TICKERS])
      setWeights(equalWeights(SP50_TICKERS))
    } else if (v === 'SP100') {
      setTickers([...SP100_TICKERS])
      setWeights(equalWeights(SP100_TICKERS))
    } else {
      setTickers([...DEFAULT_TICKERS])
      setWeights(equalWeights(DEFAULT_TICKERS))
    }
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
      if (next.length !== prev.length) {
        setWeights(equalWeights(next))
      }
      return next
    })
    setTickerInput('')
  }, [tickerInput, universeMode])

  const removeTicker = useCallback((t) => {
    if (universeMode !== 'Custom') return
    setTickers((prev) => {
      const next = prev.filter((x) => x !== t)
      if (next.length !== prev.length) {
        setWeights(equalWeights(next))
      }
      return next
    })
  }, [universeMode])

  const setWeightFor = useCallback((t, raw) => {
    const v = raw === '' ? 0 : Number(raw)
    setWeights((prev) => ({ ...prev, [t]: Number.isFinite(v) ? v : 0 }))
  }, [])

  const weightSum = useMemo(
    () => tickers.reduce((s, t) => s + (Number(weights[t]) || 0), 0),
    [tickers, weights],
  )
  const weightsMismatch =
    universeMode === 'Custom' && Math.abs(weightSum - 1) > 0.02

  const handleRun = () => {
    setError(null)
    setLoading(true)
    setResult(null)
    streamDoneRef.current = false
    setStreamElapsed(0)
    setStreamStep('Connecting…')
    setStreamPct(0)
    const numericWeights =
      universeMode === 'Custom'
        ? Object.fromEntries(tickers.map((t) => [t, Number(weights[t]) || 0]))
        : equalWeights(tickers)
    const url = buildFactorsStreamUrl({
      tickers,
      start: startDate,
      end: endDate,
      weights: numericWeights,
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
        setError(typeof msg.message === 'string' ? msg.message : 'Factor analysis failed')
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

  const exposureChartData = useMemo(() => {
    if (!result?.portfolio_exposure) return []
    return FACTOR_COLS.map((factor) => ({
      factor,
      exposure: Number(result.portfolio_exposure[factor] ?? 0),
    }))
  }, [result])

  const attributionRows = useMemo(() => {
    if (!result?.attribution_summary) return []
    return Object.entries(result.attribution_summary)
      .filter(([key]) => key !== 'portfolio_excess')
      .map(([factor, stats]) => ({
        factor,
        mean: stats.mean ?? 0,
        std: stats.std ?? 0,
      }))
      .sort((a, b) => Math.abs(b.mean) - Math.abs(a.mean))
  }, [result])

  return (
    <main className="page page--factors">
      <header className="page-masthead">
        <h1 className="page-masthead__title">Factors</h1>
      </header>
      <div className="factors">
        <aside className="factors__left">
          <div className="factors__section">
            <div className="factors__label">Universe</div>
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
                <div className="factors__chip-row">
                  {tickers.map((t) => (
                    <span key={t} className="factors__chip">
                      {t}
                      <button
                        type="button"
                        className="factors__chip-remove"
                        aria-label={`Remove ${t}`}
                        onClick={() => removeTicker(t)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
                <input
                  className="factors__input"
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
                <p className="factors__hint">
                  Add tickers with Enter or comma. Weights redistribute equally when the universe changes.
                </p>
              </>
            ) : (
              <div className="page-universe-pill" aria-live="polite">
                {universeMode} ·{' '}
                {universeMode === 'SP50' ? SP50_TICKERS.length : SP100_TICKERS.length} tickers
              </div>
            )}
          </div>

          <div className="factors__section">
            <div className="factors__label">Date range</div>
            <div className="factors__date-row">
              <input
                className="factors__date-input"
                type="text"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                aria-label="Start date"
              />
              <input
                className="factors__date-input"
                type="text"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                aria-label="End date"
              />
            </div>
          </div>

          <div className="factors__section">
            <div className="factors__label">Weights</div>
            {universeMode === 'Custom' ? (
              <div className="factors__weights-grid">
                {tickers.map((t) => (
                  <div key={t} className="factors__weight-field">
                    <label htmlFor={`weight-${t}`}>{t}</label>
                    <input
                      id={`weight-${t}`}
                      className="factors__weight-input"
                      type="number"
                      step="0.01"
                      min="0"
                      value={weights[t] ?? 0}
                      onChange={(e) => setWeightFor(t, e.target.value)}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <p className="page-universe-weights-note">
                Equal weights applied · 1/N per ticker
              </p>
            )}
            {weightsMismatch ? (
              <p className="factors__weight-warning">
                Weights should sum to 1.0 (currently {weightSum.toFixed(3)}).
              </p>
            ) : null}
          </div>

          <button
            type="button"
            className="factors__run"
            disabled={loading || tickers.length === 0}
            onClick={handleRun}
          >
            {loading && <span className="factors__spinner" aria-hidden />}
            Run factor analysis
          </button>
          {error ? <div className="factors__error">{error}</div> : null}
        </aside>

        {loading || result ? (
          <section className="factors__right">
            {loading ? (
              <EngineStreamLoading
                title="Factor analysis"
                stepText={streamStep}
                elapsedSec={streamElapsed}
                primaryPct={streamPct}
              />
            ) : (
              <>
            <div className="factors__card">
              <div className="factors__block-title">Factor loadings</div>
              <div className="factors__table-scroll">
                <table className="factors__table">
                  <thead>
                    <tr>
                      <th>Ticker</th>
                      <th>Alpha</th>
                      <th>Mkt-RF</th>
                      <th>SMB</th>
                      <th>HML</th>
                      <th>RMW</th>
                      <th>CMA</th>
                      <th>R²</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tickers.map((t) => {
                      const row = result.loadings?.[t]
                      if (!row) return null
                      const alpha = Number(row.alpha ?? 0)
                      const tstat = Number(row.alpha_tstat ?? 0)
                      const r2 = Number(row.r_squared ?? 0)
                      return (
                        <tr key={t}>
                          <td>{t}</td>
                          <td className="factors__alpha-cell">
                            <span
                              className="factors__alpha-main"
                              style={{ color: signColor(alpha) }}
                            >
                              {alpha.toFixed(3)}
                            </span>
                            <span className="factors__alpha-tstat">t = {tstat.toFixed(3)}</span>
                          </td>
                          {FACTOR_COLS.map((c) => {
                            const v = Number(row[c] ?? 0)
                            return (
                              <td key={c} style={{ color: signColor(v) }}>
                                {v.toFixed(3)}
                              </td>
                            )
                          })}
                          <td style={{ color: 'var(--text-primary)' }}>
                            {(r2 * 100).toFixed(1)}%
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {exposureChartData.length > 0 ? (
              <div className="factors__card">
                <div className="factors__block-title">Portfolio factor exposure</div>
                <div className="factors__chart-wrap">
                  <ResponsiveContainer width="100%" height={300}>
                    <BarChart
                      layout="vertical"
                      data={exposureChartData}
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
                        {exposureChartData.map((entry) => (
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
              </div>
            ) : null}

            {attributionRows.length > 0 ? (
              <div className="factors__card">
                <div className="factors__block-title">Factor attribution</div>
                <table className="factors__attr-table">
                  <thead>
                    <tr>
                      <th>Factor</th>
                      <th>Mean daily contribution</th>
                      <th>Std dev</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attributionRows.map((r) => (
                      <tr key={r.factor}>
                        <td>{r.factor}</td>
                        <td>{formatBp(r.mean)}</td>
                        <td>{formatBp(r.std)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            {result?.loadings && Object.keys(result.loadings).length > 0 ? (
              <CorrelationHeatmap loadings={result.loadings} />
            ) : null}
              </>
            )}
          </section>
        ) : null}
      </div>
      <footer className="page-byline">machAlpha · Portfolio Optimization Engine</footer>
    </main>
  )
}
