import { useCallback, useMemo, useState } from 'react'
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
import { runOptimize } from '../api/optimize.js'
import FrontierSurface3D from '../components/FrontierSurface3D.jsx'
import {
  CHART_AXIS_STROKE,
  CHART_GRID,
  CHART_NEUTRAL,
  CHART_POS,
  CHART_TICK,
  CHART_TOOLTIP_STYLE,
} from '../chartTheme.js'
import './Optimizer.css'

const DEFAULT_TICKERS = ['AAPL', 'MSFT', 'GOOGL', 'JPM', 'JNJ']

const METHOD_OPTIONS = [
  { id: 'min_variance', label: 'Min variance' },
  { id: 'max_sharpe', label: 'Max Sharpe' },
  { id: 'efficient_frontier', label: 'Efficient frontier' },
  { id: 'risk_parity', label: 'Risk parity' },
]

function formatApiError(error) {
  const detail = error.response?.data?.detail
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail)) {
    return detail
      .map((item) =>
        typeof item === 'object' && item?.msg != null ? String(item.msg) : String(item),
      )
      .join('; ')
  }
  if (detail != null && typeof detail === 'object') {
    return JSON.stringify(detail)
  }
  return error.message || 'Request failed'
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
  const [tickers, setTickers] = useState(() => [...DEFAULT_TICKERS])
  const [tickerInput, setTickerInput] = useState('')
  const [startDate, setStartDate] = useState('2020-01-01')
  const [endDate, setEndDate] = useState('2023-12-31')
  const [method, setMethod] = useState('max_sharpe')
  const [useLedoitWolf, setUseLedoitWolf] = useState(true)
  const [signalBlend, setSignalBlend] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  const [frontierResult, setFrontierResult] = useState(null)
  const [frontierView, setFrontierView] = useState('2d')

  const flushTickerInput = useCallback(() => {
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
  }, [tickerInput])

  const removeTicker = useCallback((t) => {
    setTickers((prev) => prev.filter((x) => x !== t))
  }, [])

  const handleRun = async () => {
    setError(null)
    setLoading(true)
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
    try {
      const { data } = await runOptimize(payload)
      setResult(data)
      let frontier = null
      if (method === 'efficient_frontier') {
        frontier = data.frontier ?? null
      } else {
        try {
          const fd = await runOptimize({ ...payload, method: 'efficient_frontier' })
          frontier = fd.data.frontier ?? null
        } catch {
          frontier = null
        }
      }
      setFrontierResult(frontier)
    } catch (err) {
      setResult(null)
      setFrontierResult(null)
      setError(formatApiError(err))
    } finally {
      setLoading(false)
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

  const frontierPoints = useMemo(() => {
    if (!Array.isArray(frontierResult) || frontierResult.length === 0) return []
    return [...frontierResult]
      .map((p) => ({
        vol: Number(p.volatility) * 100,
        ret: Number(p.return) * 100,
        sharpe: p.sharpe,
        raw: p,
      }))
      .sort((a, b) => a.vol - b.vol)
  }, [frontierResult])

  const heatmapTickers = useMemo(() => {
    if (!result?.weights) return tickers
    return Object.keys(result.weights).sort()
  }, [result, tickers])

  const showHeatmap = method === 'efficient_frontier' && frontierPoints.length > 0

  const curVolPct = result ? Number(result.volatility) * 100 : 0
  const curRetPct = result ? Number(result.return) * 100 : 0

  return (
    <main className="page page--optimizer">
      <header className="page-masthead">
        <h1 className="page-masthead__title">Optimizer</h1>
        <p className="page-masthead__dateline">
          {tickers.join(' · ')} · {methodLabel}
        </p>
      </header>
      <div className="optimizer">
        <aside className="optimizer__left">
          <div className="optimizer__section">
            <div className="optimizer__label">Universe</div>
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

        {result ? (
          <section className="optimizer__right">
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
            </div>

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
                  <FrontierSurface3D frontier={frontierResult} />
                )}
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
                      {frontierResult.map((row, i) => {
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
          </section>
        ) : null}
      </div>
      <footer className="page-byline">machAlpha · Portfolio Optimization Engine</footer>
    </main>
  )
}
