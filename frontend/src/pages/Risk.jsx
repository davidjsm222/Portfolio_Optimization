import { useCallback, useMemo, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { analyzeRisk } from '../api/risk.js'
import RollingRiskChart from '../components/RollingRiskChart.jsx'
import {
  CHART_AXIS_STROKE,
  CHART_GRID,
  CHART_NEUTRAL,
  CHART_TICK,
  CHART_TOOLTIP_STYLE,
} from '../chartTheme.js'
import './Risk.css'

const DEFAULT_TICKERS = ['AAPL', 'MSFT', 'GOOGL', 'JPM', 'JNJ']

function equalWeights(tickerList) {
  const n = tickerList.length
  if (n === 0) return {}
  const w = 1 / n
  return Object.fromEntries(tickerList.map((t) => [t, w]))
}

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

function buildRiskInterpretation(r) {
  const parts = []
  const k = Number(r.kurtosis)
  const dd = Number(r.max_drawdown)
  const vol = Number(r.volatility)
  const skew = Number(r.skew)
  if (k > 7) {
    parts.push(
      'Extremely fat-tailed return distribution — variance significantly understates true tail risk.',
    )
  } else if (k > 5) {
    parts.push(
      'Return distribution shows fat tails relative to a normal model — standard deviation alone may understate downside risk.',
    )
  }
  if (dd < -0.3) {
    parts.push(
      'Portfolio experienced severe drawdown over the sample — consider drawdown-constrained optimization.',
    )
  } else if (dd < -0.2) {
    parts.push('Material drawdowns occurred — review concentration and correlations in stress periods.')
  }
  if (vol > 0.28) {
    parts.push('Annualized volatility is elevated — expect large day-to-day swings in portfolio value.')
  }
  if (skew < -0.5) {
    parts.push(
      'Negative skew suggests asymmetric downside — larger adverse moves than a symmetric distribution would imply.',
    )
  }
  if (parts.length === 0) {
    return 'Tail metrics, drawdown, and volatility look moderate for this window and weights — keep monitoring as conditions and exposures change.'
  }
  return parts.slice(0, 3).join(' ')
}

export default function Risk() {
  const [tickers, setTickers] = useState(() => [...DEFAULT_TICKERS])
  const [tickerInput, setTickerInput] = useState('')
  const [startDate, setStartDate] = useState('2020-01-01')
  const [endDate, setEndDate] = useState('2023-12-31')
  const [weights, setWeights] = useState(() => equalWeights(DEFAULT_TICKERS))
  const [confidence, setConfidence] = useState(0.95)
  const [runCvarOptimize, setRunCvarOptimize] = useState(false)
  const [targetReturn, setTargetReturn] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)

  const flushTickerInput = useCallback(() => {
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
  }, [tickerInput])

  const removeTicker = useCallback((t) => {
    setTickers((prev) => {
      const next = prev.filter((x) => x !== t)
      if (next.length !== prev.length) {
        setWeights(equalWeights(next))
      }
      return next
    })
  }, [])

  const setWeightFor = useCallback((t, raw) => {
    const v = raw === '' ? 0 : Number(raw)
    setWeights((prev) => ({ ...prev, [t]: Number.isFinite(v) ? v : 0 }))
  }, [])

  const weightSum = useMemo(
    () => tickers.reduce((s, t) => s + (Number(weights[t]) || 0), 0),
    [tickers, weights],
  )
  const weightsMismatch = Math.abs(weightSum - 1) > 0.02

  const interpretation = useMemo(
    () => (result ? buildRiskInterpretation(result) : ''),
    [result],
  )

  const weightCompareData = useMemo(() => {
    if (!result?.cvar_optimized_weights) return []
    const cvarW = result.cvar_optimized_weights
    return tickers.map((t) => ({
      ticker: t,
      original: Number(weights[t]) || 0,
      cvar: Number(cvarW[t]) || 0,
    }))
  }, [result, tickers, weights])

  const hasCvarPortfolio =
    result &&
    result.cvar_optimized_weights &&
    Object.keys(result.cvar_optimized_weights).length > 0

  const handleRun = async () => {
    setError(null)
    setLoading(true)
    const numericWeights = Object.fromEntries(
      tickers.map((t) => [t, Number(weights[t]) || 0]),
    )
    let target = null
    if (runCvarOptimize && targetReturn.trim() !== '') {
      const tr = Number(targetReturn)
      if (Number.isFinite(tr)) target = tr
    }
    try {
      const { data } = await analyzeRisk({
        tickers,
        start: startDate,
        end: endDate,
        weights: numericWeights,
        confidence,
        run_cvar_optimize: runCvarOptimize,
        target_return: target,
      })
      setResult(data)
    } catch (err) {
      setResult(null)
      setError(formatApiError(err))
    } finally {
      setLoading(false)
    }
  }

  const pctDaily = (x) => `${(Number(x) * 100).toFixed(2)}%`
  const pctAnnual = (x) => `${(Number(x) * 100).toFixed(2)}%`

  return (
    <main className="page page--risk">
      <header className="page-masthead">
        <h1 className="page-masthead__title">Risk</h1>
      </header>
      <div className="risk">
        <aside className="risk__left">
          <div className="risk__section">
            <div className="risk__label">Universe</div>
            <div className="risk__chip-row">
              {tickers.map((t) => (
                <span key={t} className="risk__chip">
                  {t}
                  <button
                    type="button"
                    className="risk__chip-remove"
                    aria-label={`Remove ${t}`}
                    onClick={() => removeTicker(t)}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <input
              className="risk__input"
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
          </div>

          <div className="risk__section">
            <div className="risk__label">Date range</div>
            <div className="risk__date-row">
              <input
                className="risk__date-input"
                type="text"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                aria-label="Start date"
              />
              <input
                className="risk__date-input"
                type="text"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                aria-label="End date"
              />
            </div>
          </div>

          <div className="risk__section">
            <div className="risk__label">Weights</div>
            <div className="risk__weights-grid">
              {tickers.map((t) => (
                <div key={t} className="risk__weight-field">
                  <label htmlFor={`risk-w-${t}`}>{t}</label>
                  <input
                    id={`risk-w-${t}`}
                    className="risk__weight-input"
                    type="number"
                    step="0.01"
                    min="0"
                    value={weights[t] ?? 0}
                    onChange={(e) => setWeightFor(t, e.target.value)}
                  />
                </div>
              ))}
            </div>
            {weightsMismatch ? (
              <p className="risk__weight-warning">
                Weights should sum to 1.0 (currently {weightSum.toFixed(3)}).
              </p>
            ) : null}
          </div>

          <div className="risk__section">
            <div className="risk__label">
              <span>Confidence level</span>
              <span className="risk__label-value">{(confidence * 100).toFixed(0)}%</span>
            </div>
            <input
              className="risk__slider"
              type="range"
              min={0.9}
              max={0.99}
              step={0.01}
              value={confidence}
              onChange={(e) => setConfidence(Number(e.target.value))}
            />
          </div>

          <div className="risk__section risk__toggle-block">
            <label className="risk__toggle">
              <input
                type="checkbox"
                checked={runCvarOptimize}
                onChange={(e) => setRunCvarOptimize(e.target.checked)}
              />
              Run CVaR optimization
            </label>
            {runCvarOptimize ? (
              <div>
                <div className="risk__label">Target return (optional)</div>
                <input
                  className="risk__target-input"
                  type="text"
                  inputMode="decimal"
                  placeholder="e.g. 0.15"
                  value={targetReturn}
                  onChange={(e) => setTargetReturn(e.target.value)}
                />
              </div>
            ) : null}
          </div>

          <button
            type="button"
            className="risk__run"
            disabled={loading || tickers.length === 0}
            onClick={handleRun}
          >
            {loading && <span className="risk__spinner" aria-hidden />}
            Run risk analysis
          </button>
          {error ? <div className="risk__error">{error}</div> : null}
        </aside>

        {result ? (
          <section className="risk__right">
            <div className="risk__stats-grid">
              <div className="risk__stat-card">
                <div className="risk__stat-name">VaR</div>
                <div className="risk__stat-value" style={{ color: 'var(--red)' }}>
                  {pctDaily(result.var_95)}
                </div>
                <p className="risk__stat-desc">
                  Worst-case daily return at your confidence level — more negative means larger
                  left-tail loss.
                </p>
              </div>
              <div className="risk__stat-card">
                <div className="risk__stat-name">CVaR</div>
                <div className="risk__stat-value" style={{ color: 'var(--red)' }}>
                  {pctDaily(result.cvar_95)}
                </div>
                <p className="risk__stat-desc">
                  Average daily return in the tail beyond VaR — severity of outcomes in bad states.
                </p>
              </div>
              <div className="risk__stat-card">
                <div className="risk__stat-name">Max drawdown</div>
                <div className="risk__stat-value" style={{ color: 'var(--amber)' }}>
                  {pctAnnual(result.max_drawdown)}
                </div>
                <p className="risk__stat-desc">
                  Largest peak-to-trough loss on a simple wealth index over the sample.
                </p>
              </div>
              <div className="risk__stat-card">
                <div className="risk__stat-name">Volatility</div>
                <div className="risk__stat-value" style={{ color: 'var(--amber)' }}>
                  {pctAnnual(result.volatility)}
                </div>
                <p className="risk__stat-desc">
                  Annualized volatility of daily portfolio returns — scale of typical moves.
                </p>
              </div>
            </div>

            <RollingRiskChart
              drawdownSeries={result.drawdown_series ?? []}
              maxDrawdown={result.max_drawdown}
            />

            <div className="risk__pairs-row">
              <div className="risk__stat-card">
                <div className="risk__stat-name">Skew</div>
                <div
                  className="risk__stat-value"
                  style={{
                    color:
                      Number(result.skew) < 0
                        ? 'var(--red)'
                        : Number(result.skew) > 0
                          ? 'var(--green)'
                          : 'var(--text-muted)',
                  }}
                >
                  {Number(result.skew).toFixed(3)}
                </div>
                <p className="risk__stat-desc">
                  Asymmetry of daily returns — negative skew means a longer left tail than the
                  right.
                </p>
              </div>
              <div className="risk__stat-card">
                <div className="risk__stat-name">Kurtosis</div>
                <div
                  className="risk__stat-value"
                  style={{
                    color: Number(result.kurtosis) > 5 ? 'var(--red)' : 'var(--text-primary)',
                  }}
                >
                  {Number(result.kurtosis).toFixed(3)}
                </div>
                <p className="risk__stat-desc">
                  Excess kurtosis (pandas) — values above ~5 flag fat tails versus a normal model.
                </p>
              </div>
            </div>

            {hasCvarPortfolio ? (
              <div className="risk__card">
                <div className="risk__block-title">CVaR optimized portfolio</div>
                <div className="risk__cvar-grid">
                  <div className="risk__stat-card">
                    <div className="risk__stat-name">Return</div>
                    <div
                      className="risk__stat-value"
                      style={{
                        color:
                          Number(result.cvar_return ?? 0) >= 0
                            ? 'var(--green)'
                            : 'var(--red)',
                      }}
                    >
                      {pctAnnual(result.cvar_return ?? 0)}
                    </div>
                  </div>
                  <div className="risk__stat-card">
                    <div className="risk__stat-name">Volatility</div>
                    <div className="risk__stat-value" style={{ color: 'var(--amber)' }}>
                      {pctAnnual(result.cvar_volatility ?? 0)}
                    </div>
                  </div>
                  <div className="risk__stat-card">
                    <div className="risk__stat-name">Sharpe</div>
                    <div className="risk__stat-value" style={{ color: 'var(--text-primary)' }}>
                      {Number(result.cvar_sharpe ?? 0).toFixed(2)}
                    </div>
                  </div>
                  <div className="risk__stat-card">
                    <div className="risk__stat-name">CVaR</div>
                    <div className="risk__stat-value" style={{ color: 'var(--red)' }}>
                      {pctDaily(result.cvar_cvar ?? 0)}
                    </div>
                  </div>
                </div>
                <div className="risk__legend">
                  <span className="risk__legend-item">
                    <span
                      className="risk__legend-swatch"
                      style={{ background: 'var(--text-muted)' }}
                    />
                    Original
                  </span>
                  <span className="risk__legend-item">
                    <span className="risk__legend-swatch" style={{ background: '#f0ece4' }} />
                    CVaR optimized
                  </span>
                </div>
                <div className="risk__chart-wrap">
                  <ResponsiveContainer width="100%" height={320}>
                    <BarChart
                      data={weightCompareData}
                      margin={{ top: 8, right: 16, left: 8, bottom: 8 }}
                    >
                      <CartesianGrid {...CHART_GRID} strokeDasharray="" />
                      <XAxis dataKey="ticker" stroke={CHART_AXIS_STROKE} tick={CHART_TICK} />
                      <YAxis
                        stroke={CHART_AXIS_STROKE}
                        tick={CHART_TICK}
                        tickFormatter={(v) => `${(v * 100).toFixed(0)}%`}
                        domain={[0, 'auto']}
                      />
                      <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
                      <Legend wrapperStyle={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 10, color: '#444' }} />
                      <Bar dataKey="original" name="Original" fill="#444" radius={0} />
                      <Bar dataKey="cvar" name="CVaR opt." fill={CHART_NEUTRAL} radius={0} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            ) : null}

            <div className="risk__card">
              <div className="risk__block-title">Risk interpretation</div>
              <p className="risk__interpret">{interpretation}</p>
            </div>
          </section>
        ) : null}
      </div>
      <footer className="page-byline">machAlpha · Portfolio Optimization Engine</footer>
    </main>
  )
}
