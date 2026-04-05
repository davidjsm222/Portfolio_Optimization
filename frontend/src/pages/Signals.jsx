import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { buildSignalsStreamUrl } from '../api/signals.js'
import EngineStreamLoading from '../components/EngineStreamLoading.jsx'
import {
  CHART_AXIS_STROKE,
  CHART_GRID,
  CHART_LEGEND_STYLE,
  CHART_NEG,
  CHART_NEUTRAL,
  CHART_POS,
  CHART_TICK,
  CHART_TOOLTIP_STYLE,
  REF_LINE_STROKE,
} from '../chartTheme.js'
import { SP100_TICKERS, SP50_TICKERS } from '../data/universeTickers.js'
import '../pageUniverse.css'
import './Signals.css'

const DEFAULT_TICKERS = ['AAPL', 'MSFT', 'GOOGL', 'JPM', 'JNJ']

export default function Signals() {
  const [universeMode, setUniverseMode] = useState('Custom')
  const [tickers, setTickers] = useState(() => [...DEFAULT_TICKERS])
  const [tickerInput, setTickerInput] = useState('')
  const [startDate, setStartDate] = useState('2020-01-01')
  const [endDate, setEndDate] = useState('2023-12-31')
  const [signalWeight, setSignalWeight] = useState(0.3)
  const [momentumLookback, setMomentumLookback] = useState(252)
  const [reversionLookback, setReversionLookback] = useState(5)
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

  const signalScoresData = useMemo(() => {
    if (!result) return []
    return tickers.map((t) => ({
      ticker: t,
      momentum: Number(result.momentum?.[t] ?? 0),
      cross_sectional: Number(result.cross_sectional?.[t] ?? 0),
      mean_reversion: Number(result.mean_reversion?.[t] ?? 0),
    }))
  }, [result, tickers])

  const combinedBarData = useMemo(() => {
    if (!result) return []
    return [...tickers]
      .map((t) => ({ ticker: t, combined: Number(result.combined?.[t] ?? 0) }))
      .sort((a, b) => b.combined - a.combined)
  }, [result, tickers])

  const muCompareData = useMemo(() => {
    if (!result) return []
    return tickers.map((t) => ({
      ticker: t,
      historicalPct: Number(result.historical_mu?.[t] ?? 0) * 100,
      adjustedPct: Number(result.adjusted_mu?.[t] ?? 0) * 100,
    }))
  }, [result, tickers])

  const summaryRows = useMemo(() => {
    if (!result) return []
    return [...tickers].sort(
      (a, b) =>
        (Number(result.combined?.[b] ?? 0) - Number(result.combined?.[a] ?? 0)),
    )
  }, [result, tickers])

  const handleRun = () => {
    setError(null)
    setLoading(true)
    setResult(null)
    streamDoneRef.current = false
    setStreamElapsed(0)
    setStreamStep('Connecting…')
    setStreamPct(0)
    const momLb = Math.max(1, parseInt(String(momentumLookback), 10) || 252)
    const revLb = Math.max(1, parseInt(String(reversionLookback), 10) || 5)
    const url = buildSignalsStreamUrl({
      tickers,
      start: startDate,
      end: endDate,
      signal_weight: signalWeight,
      momentum_lookback: momLb,
      reversion_lookback: revLb,
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
        setError(typeof msg.message === 'string' ? msg.message : 'Signal generation failed')
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

  return (
    <main className="page page--signals">
      <header className="page-masthead">
        <h1 className="page-masthead__title">Signals</h1>
      </header>
      <div className="signals">
        <aside className="signals__left">
          <div className="signals__section">
            <div className="signals__label">Universe</div>
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
                <div className="signals__chip-row">
                  {tickers.map((t) => (
                    <span key={t} className="signals__chip">
                      {t}
                      <button
                        type="button"
                        className="signals__chip-remove"
                        aria-label={`Remove ${t}`}
                        onClick={() => removeTicker(t)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
                <input
                  className="signals__input"
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
              </>
            ) : (
              <div className="page-universe-pill" aria-live="polite">
                {universeMode} ·{' '}
                {universeMode === 'SP50' ? SP50_TICKERS.length : SP100_TICKERS.length} tickers
              </div>
            )}
          </div>

          <div className="signals__section">
            <div className="signals__label">Date range</div>
            <div className="signals__date-row">
              <input
                className="signals__date-input"
                type="text"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                aria-label="Start date"
              />
              <input
                className="signals__date-input"
                type="text"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                aria-label="End date"
              />
            </div>
          </div>

          <div className="signals__section">
            <div className="signals__label">
              <span>Signal weight</span>
              <span className="signals__label-value">{signalWeight.toFixed(2)}</span>
            </div>
            <input
              className="signals__slider"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={signalWeight}
              onChange={(e) => setSignalWeight(Number(e.target.value))}
            />
            <p className="signals__hint">Blend weight for signal vs historical returns.</p>
          </div>

          <div className="signals__section">
            <span className="signals__field-label">Momentum lookback · Trading days</span>
            <input
              className="signals__number-input"
              type="number"
              min={1}
              value={momentumLookback}
              onChange={(e) => setMomentumLookback(Number(e.target.value))}
            />
          </div>

          <div className="signals__section">
            <span className="signals__field-label">Reversion lookback · Trading days</span>
            <input
              className="signals__number-input"
              type="number"
              min={1}
              value={reversionLookback}
              onChange={(e) => setReversionLookback(Number(e.target.value))}
            />
          </div>

          <button
            type="button"
            className="signals__run"
            disabled={loading || tickers.length === 0}
            onClick={handleRun}
          >
            {loading && <span className="signals__spinner" aria-hidden />}
            Generate signals
          </button>
          {error ? <div className="signals__error">{error}</div> : null}
        </aside>

        {loading || result ? (
          <section className="signals__right">
            {loading ? (
              <EngineStreamLoading
                title="Signals"
                stepText={streamStep}
                elapsedSec={streamElapsed}
                primaryPct={streamPct}
              />
            ) : (
              <>
            <div className="signals__card">
              <div className="signals__block-title">Signal scores</div>
              <div className="signals__chart-wrap">
                <ResponsiveContainer width="100%" height={340}>
                  <BarChart
                    data={signalScoresData}
                    margin={{ top: 8, right: 16, left: 8, bottom: 8 }}
                    barCategoryGap="25%"
                    barGap={2}
                  >
                    <CartesianGrid {...CHART_GRID} strokeDasharray="" />
                    <XAxis dataKey="ticker" stroke={CHART_AXIS_STROKE} tick={CHART_TICK} />
                    <YAxis
                      domain={[-1, 1]}
                      stroke={CHART_AXIS_STROKE}
                      tick={CHART_TICK}
                      tickFormatter={(v) => v.toFixed(1)}
                    />
                    <ReferenceLine y={0} stroke={REF_LINE_STROKE} strokeWidth={1} />
                    <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
                    <Legend wrapperStyle={CHART_LEGEND_STYLE} />
                    <Bar
                      dataKey="momentum"
                      name="Momentum"
                      fill="#f0ece4"
                      radius={0}
                    />
                    <Bar
                      dataKey="cross_sectional"
                      name="Cross-sectional"
                      fill="#4caf7d"
                      radius={0}
                    />
                    <Bar
                      dataKey="mean_reversion"
                      name="Mean reversion"
                      fill="#e8a020"
                      radius={0}
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="signals__card">
              <div className="signals__block-title">Combined signal</div>
              <div className="signals__chart-wrap">
                <ResponsiveContainer width="100%" height={320}>
                  <BarChart
                    layout="vertical"
                    data={combinedBarData}
                    margin={{ top: 8, right: 24, left: 8, bottom: 8 }}
                  >
                    <CartesianGrid {...CHART_GRID} strokeDasharray="" horizontal={false} />
                    <XAxis type="number" stroke={CHART_AXIS_STROKE} tick={CHART_TICK} />
                    <YAxis
                      type="category"
                      dataKey="ticker"
                      width={56}
                      stroke={CHART_AXIS_STROKE}
                      tick={CHART_TICK}
                    />
                    <ReferenceLine x={0} stroke={REF_LINE_STROKE} strokeWidth={1} />
                    <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
                    <Bar dataKey="combined" radius={0} barSize={16}>
                      {combinedBarData.map((entry) => (
                        <Cell
                          key={entry.ticker}
                          fill={entry.combined >= 0 ? CHART_POS : CHART_NEG}
                        />
                      ))}
                      <LabelList
                        dataKey="combined"
                        position="right"
                        fill="#444"
                        fontSize={10}
                        fontFamily="IBM Plex Mono, monospace"
                        formatter={(v) => Number(v).toFixed(2)}
                      />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="signals__card">
              <div className="signals__block-title">Expected returns comparison</div>
              <div className="signals__chart-wrap">
                <ResponsiveContainer width="100%" height={320}>
                  <BarChart
                    data={muCompareData}
                    margin={{ top: 8, right: 16, left: 8, bottom: 8 }}
                  >
                    <CartesianGrid {...CHART_GRID} strokeDasharray="" />
                    <XAxis dataKey="ticker" stroke={CHART_AXIS_STROKE} tick={CHART_TICK} />
                    <YAxis
                      stroke={CHART_AXIS_STROKE}
                      tick={CHART_TICK}
                      tickFormatter={(v) => `${v.toFixed(1)}%`}
                    />
                    <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
                    <Legend wrapperStyle={CHART_LEGEND_STYLE} />
                    <Bar
                      dataKey="historicalPct"
                      name="Historical μ"
                      fill="#444"
                      radius={0}
                    />
                    <Bar dataKey="adjustedPct" name="Adjusted μ" radius={0}>
                      {muCompareData.map((e, i) => (
                        <Cell
                          key={`adj-${i}`}
                          fill={
                            e.adjustedPct > e.historicalPct
                              ? CHART_POS
                              : e.adjustedPct < e.historicalPct
                                ? CHART_NEG
                                : CHART_NEUTRAL
                          }
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="signals__card">
              <div className="signals__block-title">Signal summary</div>
              <div className="signals__table-scroll">
                <table className="signals__table">
                  <thead>
                    <tr>
                      <th>Ticker</th>
                      <th>Momentum</th>
                      <th>Cross-sec.</th>
                      <th>Mean rev.</th>
                      <th>Combined</th>
                      <th>Hist μ%</th>
                      <th>Adj μ%</th>
                      <th>Delta</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summaryRows.map((t) => {
                      const h = Number(result.historical_mu?.[t] ?? 0)
                      const a = Number(result.adjusted_mu?.[t] ?? 0)
                      const d = a - h
                      const dpp = d * 100
                      return (
                        <tr key={t}>
                          <td>{t}</td>
                          <td>{Number(result.momentum?.[t] ?? 0).toFixed(3)}</td>
                          <td>{Number(result.cross_sectional?.[t] ?? 0).toFixed(3)}</td>
                          <td>{Number(result.mean_reversion?.[t] ?? 0).toFixed(3)}</td>
                          <td>{Number(result.combined?.[t] ?? 0).toFixed(3)}</td>
                          <td>{(h * 100).toFixed(2)}%</td>
                          <td>{(a * 100).toFixed(2)}%</td>
                          <td
                            style={{
                              color:
                              dpp > 0.005
                                ? 'var(--green)'
                                : dpp < -0.005
                                  ? 'var(--red)'
                                  : 'var(--text-primary)',
                            }}
                          >
                            {dpp >= 0 ? '+' : ''}
                            {dpp.toFixed(2)} pp
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
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
