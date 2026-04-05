import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  Line,
  LineChart,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { buildOptimizeStreamUrl } from '../api/optimize.js'
import EngineStreamLoading from '../components/EngineStreamLoading.jsx'
import FrontierSurface3D from '../components/FrontierSurface3D.jsx'
import {
  CHART_AXIS_STROKE,
  CHART_GRID,
  CHART_NEUTRAL,
  CHART_POS,
  CHART_TICK,
  CHART_TOOLTIP_STYLE,
} from '../chartTheme.js'
import { SP100_TICKERS, SP50_TICKERS } from '../data/universeTickers.js'
import { downloadCSV } from '../utils/csv.js'
import '../pageUniverse.css'
import './Optimizer.css'

const DEFAULT_TICKERS = ['AAPL', 'MSFT', 'GOOGL', 'JPM', 'JNJ']

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000

const METHOD_OPTIONS = [
  { id: 'min_variance', label: 'Min variance' },
  { id: 'max_sharpe', label: 'Max Sharpe' },
  { id: 'efficient_frontier', label: 'Efficient frontier' },
  { id: 'risk_parity', label: 'Risk parity' },
]

function buildFrontierCsvRows(frontierResult) {
  if (!Array.isArray(frontierResult) || frontierResult.length === 0) return []
  const skip = new Set(['return', 'volatility', 'sharpe'])
  const tickers = Object.keys(frontierResult[0]).filter((k) => !skip.has(k)).sort()
  return frontierResult.map((row) => {
    const o = {
      return: row.return,
      volatility: row.volatility,
      sharpe: row.sharpe,
    }
    for (const t of tickers) {
      o[t] = row[t]
    }
    return o
  })
}

function heatmapCellStyle(weight, rowMax) {
  const t = rowMax > 0 ? weight / rowMax : 0
  const a = 0.06 + 0.35 * Math.min(1, t)
  return {
    backgroundColor: `rgba(240, 236, 228, ${a.toFixed(3)})`,
    color: 'var(--text-primary)',
  }
}

export default function Optimizer() {
  const [universeMode, setUniverseMode] = useState('Custom')
  const [tickers, setTickers] = useState(() => [...DEFAULT_TICKERS])
  const [tickerInput, setTickerInput] = useState('')
  const [startDate, setStartDate] = useState('2015-01-01')
  const [endDate, setEndDate] = useState('2023-12-31')
  const [method, setMethod] = useState('max_sharpe')
  const [useLedoitWolf, setUseLedoitWolf] = useState(true)
  const [signalBlend, setSignalBlend] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  const [frontierView, setFrontierView] = useState('2d')
  const [streamStep, setStreamStep] = useState('')
  const [streamPct1, setStreamPct1] = useState(0)
  const [streamPct2, setStreamPct2] = useState(0)
  const [streamPhase2, setStreamPhase2] = useState(false)
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
    setStreamPct1(0)
    setStreamPct2(0)
    setStreamPhase2(false)

    const payload = {
      tickers,
      start: startDate,
      end: endDate,
      method,
      allow_short: false,
      use_ledoit_wolf: useLedoitWolf,
      signal_blend: signalBlend,
      n_points: 50,
    }
    const url = buildOptimizeStreamUrl(payload)
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
        const phase = Number(msg.phase) || 1
        const pct = Number(msg.pct)
        const step = typeof msg.step === 'string' ? msg.step : ''
        const twoPhase = method !== 'efficient_frontier'
        if (phase >= 2 && twoPhase) {
          setStreamPhase2(true)
          setStreamPct1(100)
          const p2 =
            Number.isFinite(pct) && pct >= 85
              ? Math.min(100, ((pct - 85) / 15) * 100)
              : 0
          setStreamPct2(p2)
          setStreamStep(`Step 2/2: ${step}…`)
        } else {
          setStreamPhase2(false)
          setStreamPct2(0)
          setStreamPct1(Number.isFinite(pct) ? pct : 0)
          setStreamStep(
            twoPhase ? `Step 1/2: ${step}…` : `${step}…`,
          )
        }
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
        setError(typeof msg.message === 'string' ? msg.message : 'Optimization failed')
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

  const methodLabel = useMemo(
    () => METHOD_OPTIONS.find((o) => o.id === method)?.label ?? method,
    [method],
  )

  const frontierData = useMemo(
    () => (Array.isArray(result?.frontier) ? result.frontier : null),
    [result],
  )

  const frontierPoints = useMemo(() => {
    if (!Array.isArray(frontierData) || frontierData.length === 0) return []
    return [...frontierData]
      .map((p) => ({
        vol: Number(p.volatility) * 100,
        ret: Number(p.return) * 100,
        sharpe: p.sharpe,
        raw: p,
      }))
      .sort((a, b) => a.vol - b.vol)
  }, [frontierData])

  const heatmapTickers = useMemo(() => {
    if (!result?.weights) return tickers
    return Object.keys(result.weights).sort()
  }, [result, tickers])

  const showHeatmap = method === 'efficient_frontier' && frontierPoints.length > 0

  const curVolPct = result ? Number(result.volatility) * 100 : 0
  const curRetPct = result ? Number(result.return) * 100 : 0

  const totalReturnCumulative = useMemo(() => {
    if (!result) return null
    const ann = Number(result.return)
    const t0 = new Date(startDate)
    const t1 = new Date(endDate)
    if (Number.isNaN(t0.getTime()) || Number.isNaN(t1.getTime())) return null
    const nYears = (t1.getTime() - t0.getTime()) / MS_PER_YEAR
    if (!Number.isFinite(ann) || !Number.isFinite(nYears) || nYears <= 0) return null
    const cum = (1 + ann) ** nYears - 1
    return Number.isFinite(cum) ? cum : null
  }, [result, startDate, endDate])

  const dateRangeYears = useMemo(() => {
    const t0 = new Date(startDate)
    const t1 = new Date(endDate)
    if (Number.isNaN(t0.getTime()) || Number.isNaN(t1.getTime())) return null
    return (t1.getTime() - t0.getTime()) / MS_PER_YEAR
  }, [startDate, endDate])

  const showShortRangeWarning =
    dateRangeYears != null && Number.isFinite(dateRangeYears) && dateRangeYears < 2

  return (
    <main className="page page--optimizer">
      <header className="page-masthead">
        <h1 className="page-masthead__title">Optimizer</h1>
        <p className="page-masthead__dateline">
          {universeMode === 'Custom'
            ? `${tickers.slice(0, 6).join(' · ')}${tickers.length > 6 ? ' · …' : ''} · ${methodLabel}`
            : `${universeMode} · ${tickers.length} names · ${methodLabel}`}
        </p>
      </header>
      <div className="optimizer">
        <aside className="optimizer__left">
          <div className="optimizer__section">
            <div className="optimizer__label">Universe</div>
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
                <div className="optimizer__chip-row">
                  {tickers.map((t) => (
                    <span key={t} className="optimizer__chip">
                      {t}
                      <button
                        type="button"
                        className="optimizer__chip-remove"
                        aria-label={`Remove ${t}`}
                        onClick={() => removeTicker(t)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
                <input
                  className="optimizer__input"
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
                <p className="optimizer__hint">
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

          <div className="optimizer__section">
            <div className="optimizer__label">Date range</div>
            <div className="optimizer__date-row">
              <input
                className="optimizer__date-input"
                type="text"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                aria-label="Start date"
              />
              <input
                className="optimizer__date-input"
                type="text"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                aria-label="End date"
              />
            </div>
            {showShortRangeWarning ? (
              <div className="optimizer__warn-banner" role="status">
                Warning: Date range under 2 years — results will be in-sample and unreliable for
                prediction. Use{' '}
                <Link className="optimizer__warn-banner-link" to="/backtest">
                  Backtest
                </Link>{' '}
                for out-of-sample validation.
              </div>
            ) : null}
          </div>

          <div className="optimizer__section">
            <div className="optimizer__label">Method</div>
            <div className="optimizer__method-grid">
              {METHOD_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={
                    method === opt.id
                      ? 'optimizer__method-btn optimizer__method-btn--active'
                      : 'optimizer__method-btn'
                  }
                  onClick={() => setMethod(opt.id)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="optimizer__section">
            <div className="optimizer__label">Covariance</div>
            <div className="optimizer__toggle-row">
              <button
                type="button"
                className={
                  !useLedoitWolf
                    ? 'optimizer__toggle-btn optimizer__toggle-btn--active'
                    : 'optimizer__toggle-btn'
                }
                onClick={() => setUseLedoitWolf(false)}
              >
                Sample
              </button>
              <button
                type="button"
                className={
                  useLedoitWolf
                    ? 'optimizer__toggle-btn optimizer__toggle-btn--active'
                    : 'optimizer__toggle-btn'
                }
                onClick={() => setUseLedoitWolf(true)}
              >
                Ledoit–Wolf
              </button>
            </div>
          </div>

          <div className="optimizer__section">
            <div className="optimizer__label">
              <span>Signal blend</span>
              <span className="optimizer__label-value">{signalBlend.toFixed(2)}</span>
            </div>
            <input
              className="optimizer__slider"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={signalBlend}
              onChange={(e) => setSignalBlend(Number(e.target.value))}
            />
            <p className="optimizer__hint">Blend external signal into expected returns (0 = none).</p>
          </div>

          <button
            type="button"
            className="optimizer__run"
            disabled={loading || tickers.length === 0}
            onClick={handleRun}
          >
            {loading && <span className="optimizer__spinner" aria-hidden />}
            Run optimization
          </button>
          {error ? <div className="optimizer__error">{error}</div> : null}
        </aside>

        {loading || result ? (
          <section className="optimizer__right">
            {loading ? (
              <EngineStreamLoading
                title="Optimization"
                stepText={streamStep}
                elapsedSec={streamElapsed}
                primaryPct={streamPct1}
                showSecondaryBar={method !== 'efficient_frontier'}
                secondaryPct={streamPhase2 ? streamPct2 : 0}
                secondaryCaption="Step 2/2 — Efficient frontier"
              />
            ) : (
              <>
            <div className="optimizer__stats">
              <div className="optimizer__stat-card">
                <div className="optimizer__stat-name">Return</div>
                <div
                  className="optimizer__stat-value"
                  style={{
                    color:
                      Number(result.return) >= 0 ? 'var(--green)' : 'var(--red)',
                  }}
                >
                  {(Number(result.return) * 100).toFixed(2)}%
                </div>
                <div className="optimizer__stat-sublabel">annualized</div>
              </div>
              <div className="optimizer__stat-card">
                <div className="optimizer__stat-name">Volatility</div>
                <div className="optimizer__stat-value" style={{ color: 'var(--amber)' }}>
                  {(Number(result.volatility) * 100).toFixed(2)}%
                </div>
              </div>
              <div className="optimizer__stat-card">
                <div className="optimizer__stat-name">Sharpe</div>
                <div className="optimizer__stat-value" style={{ color: 'var(--text-primary)' }}>
                  {Number(result.sharpe).toFixed(2)}
                </div>
              </div>
              <div className="optimizer__stat-card">
                <div className="optimizer__stat-name">Total return</div>
                <div
                  className="optimizer__stat-value"
                  style={{
                    color:
                      totalReturnCumulative == null
                        ? 'var(--text-muted)'
                        : totalReturnCumulative >= 0
                          ? 'var(--green)'
                          : 'var(--red)',
                  }}
                >
                  {totalReturnCumulative != null
                    ? `${(totalReturnCumulative * 100).toFixed(2)}%`
                    : '—'}
                </div>
                <div className="optimizer__stat-sublabel">cumulative</div>
              </div>
            </div>

            <p className="optimizer__results-note">
              These results are in-sample over the selected date range. For out-of-sample
              performance, see the{' '}
              <Link className="optimizer__results-note-link" to="/backtest">
                Backtest
              </Link>{' '}
              page.
            </p>

            <div className="optimizer__card">
              <div className="optimizer__block-title">Portfolio weights</div>
              <div className="optimizer__chart-wrap optimizer__chart-wrap--bars">
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
            </div>

            {frontierPoints.length > 0 ? (
              <div className="optimizer__card">
                <div className="optimizer__block-title">Efficient frontier</div>
                <div className="optimizer__toggle-row" style={{ marginBottom: 12 }}>
                  <button
                    type="button"
                    className={
                      frontierView === '2d'
                        ? 'optimizer__toggle-btn optimizer__toggle-btn--active'
                        : 'optimizer__toggle-btn'
                    }
                    onClick={() => setFrontierView('2d')}
                  >
                    2D
                  </button>
                  <button
                    type="button"
                    className={
                      frontierView === '3d'
                        ? 'optimizer__toggle-btn optimizer__toggle-btn--active'
                        : 'optimizer__toggle-btn'
                    }
                    onClick={() => setFrontierView('3d')}
                  >
                    3D
                  </button>
                </div>
                {frontierView === '2d' ? (
                  <div className="optimizer__chart-wrap">
                    <ResponsiveContainer width="100%" height={300}>
                      <LineChart
                        data={frontierPoints}
                        margin={{ top: 8, right: 16, left: 0, bottom: 8 }}
                      >
                        <CartesianGrid {...CHART_GRID} strokeDasharray="" />
                        <XAxis
                          type="number"
                          dataKey="vol"
                          name="Volatility"
                          stroke={CHART_AXIS_STROKE}
                          tick={CHART_TICK}
                          tickFormatter={(v) => v.toFixed(1) + '%'}
                          label={{
                            value: 'Volatility %',
                            position: 'bottom',
                            offset: 0,
                            fill: '#444',
                            fontSize: 10,
                            fontFamily: 'IBM Plex Mono, monospace',
                          }}
                        />
                        <YAxis
                          type="number"
                          dataKey="ret"
                          stroke={CHART_AXIS_STROKE}
                          tick={CHART_TICK}
                          tickFormatter={(v) => v.toFixed(1) + '%'}
                          label={{
                            value: 'Return %',
                            angle: -90,
                            position: 'insideLeft',
                            fill: '#444',
                            fontSize: 10,
                            fontFamily: 'IBM Plex Mono, monospace',
                          }}
                        />
                        <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
                        <Line
                          type="monotone"
                          dataKey="ret"
                          stroke={CHART_NEUTRAL}
                          strokeWidth={1.5}
                          dot={false}
                          isAnimationActive={false}
                        />
                        <ReferenceDot
                          x={curVolPct}
                          y={curRetPct}
                          r={7}
                          fill={CHART_POS}
                          stroke="#080808"
                          strokeWidth={1}
                          isFront
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <FrontierSurface3D frontier={frontierData} />
                )}
                {frontierData && frontierData.length > 0 ? (
                  <button
                    type="button"
                    className="optimizer__frontier-csv-btn"
                    onClick={() => {
                      const rows = buildFrontierCsvRows(frontierData)
                      downloadCSV(
                        `machalpha_frontier_${startDate}_${endDate}.csv`,
                        rows,
                      )
                    }}
                  >
                    Export Frontier CSV
                  </button>
                ) : null}
              </div>
            ) : null}

            {showHeatmap ? (
              <div className="optimizer__card">
                <div className="optimizer__block-title">Frontier weights heatmap</div>
                <div className="optimizer__heatmap-scroll">
                  <table className="optimizer__heatmap">
                    <thead>
                      <tr>
                        <th>#</th>
                        {heatmapTickers.map((t) => (
                          <th key={t}>{t}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {frontierData.map((row, i) => {
                        const cells = heatmapTickers.map((t) =>
                          Number(row[t] ?? 0),
                        )
                        const rowMax = Math.max(...cells, 1e-9)
                        return (
                          <tr key={i}>
                            <td>{i + 1}</td>
                            {heatmapTickers.map((t) => {
                              const w = Number(row[t] ?? 0)
                              return (
                                <td key={t} style={heatmapCellStyle(w, rowMax)}>
                                  {(w * 100).toFixed(1)}%
                                </td>
                              )
                            })}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
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
