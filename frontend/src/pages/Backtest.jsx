import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import { buildBacktestStreamUrl, getRegimes, optimizeThreshold } from '../api/backtest.js'
import { PLOTLY_AXIS, PLOTLY_BASE } from '../chartTheme.js'
import { SP100_TICKERS, SP50_TICKERS } from '../data/universeTickers.js'
import { buildCsvString, downloadCSV } from '../utils/csv.js'
import './Optimizer.css'
import './Backtest.css'

const loadingStyle = {
  color: '#444',
  fontFamily: 'IBM Plex Mono, monospace',
  fontSize: 11,
}

const EQUITY_ORDER = ['min_variance', 'max_sharpe', 'risk_parity', 'cvar', 'equal_weight']

const EQUITY_COLORS = {
  min_variance: '#aaaaaa',
  max_sharpe: '#f0ece4',
  risk_parity: '#4caf7d',
  cvar: '#e8a020',
  equal_weight: '#555555',
}

/** Hardcoded equity chart stress windows — filtered to backtest date range; hover on line for label. */
const REGIME_BOUNDARIES = [
  { id: '.com bubble burst', start: '2000-03-10', end: '2002-10-09', color: '#e05555' },
  { id: '2008 financial crisis', start: '2008-09-15', end: '2009-03-09', color: '#e05555' },
  { id: 'Q4 2018 bear', start: '2018-10-03', end: '2018-12-24', color: '#e05555' },
  { id: 'COVID crash', start: '2020-02-19', end: '2020-04-30', color: '#e05555' },
  { id: 'Rate shock', start: '2022-01-03', end: '2022-12-31', color: '#e05555' },
  { id: 'Liberation Day', start: '2025-04-02', end: '2025-04-08', color: '#e05555' },
]

function regimeOverlapsBacktest(regime, btStart, btEnd) {
  return regime.start <= btEnd && regime.end >= btStart
}

const COVID_START = '2020-02-19'
const COVID_END = '2020-04-30'

const SURFACE_COLORSCALE = [
  [0, '#e05555'],
  [0.5, '#080808'],
  [1.0, '#4caf7d'],
]

const THRESHOLD_SWEEP_DEFAULTS = [0.1, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 5.0]

function methodLabel(id) {
  const m = {
    min_variance: 'Min variance',
    max_sharpe: 'Max Sharpe',
    risk_parity: 'Risk parity',
    cvar: 'CVaR',
    equal_weight: 'Equal weight',
  }
  return m[id] ?? id
}

function numOrNull(v) {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function formatPctDecimal(n, digits = 2) {
  if (n == null || !Number.isFinite(n)) return '—'
  return `${(n * 100).toFixed(digits)}%`
}

function formatSharpe(n) {
  if (n == null || !Number.isFinite(n)) return '—'
  return n.toFixed(3)
}

function formatCalmar(n) {
  if (n == null || !Number.isFinite(n)) return '—'
  return n.toFixed(3)
}

function formatDurationSec(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—'
  const s = Math.max(0, Math.round(sec))
  const m = Math.floor(s / 60)
  const r = s % 60
  if (m <= 0) return `${r}s`
  return `${m}m ${r}s`
}

/** Best per column: max return/sharpe/calmar/mdd; min vol and n_rebalances (lower turnover). */
function computeSummaryBests(rows) {
  const pick = (key, mode) => {
    const vals = rows.map((r) => numOrNull(r[key])).filter((v) => v != null)
    if (vals.length === 0) return null
    return mode === 'max' ? Math.max(...vals) : Math.min(...vals)
  }
  return {
    ann_return: pick('ann_return', 'max'),
    ann_vol: pick('ann_vol', 'min'),
    sharpe: pick('sharpe', 'max'),
    max_drawdown: pick('max_drawdown', 'max'),
    calm_drawdown: pick('calm_drawdown', 'max'),
    calmar: pick('calmar', 'max'),
    n_rebalances: pick('n_rebalances', 'min'),
  }
}

function isclose(a, b) {
  if (a == null || b == null) return false
  return Math.abs(a - b) <= 1e-9 * (Math.abs(b) + 1) || Math.abs(a - b) < 1e-12
}

function isBestSummary(val, best, key) {
  if (best == null || val == null) return false
  const v = Number(val)
  const b = Number(best)
  if (!Number.isFinite(v) || !Number.isFinite(b)) return false
  if (key === 'n_rebalances') return v === b
  return isclose(v, b)
}

function computeRegimeBests(rows) {
  const sharpe = rows.map((r) => numOrNull(r.sharpe)).filter((v) => v != null)
  const mdd = rows.map((r) => numOrNull(r.max_drawdown)).filter((v) => v != null)
  return {
    sharpe: sharpe.length ? Math.max(...sharpe) : null,
    max_drawdown: mdd.length ? Math.max(...mdd) : null,
  }
}

function backtestExportSlug(metadata) {
  const start = metadata?.start != null ? String(metadata.start) : 'start'
  const end = metadata?.end != null ? String(metadata.end) : 'end'
  return `${start}_${end}`
}

function buildEquityExportRows(result) {
  const curves = result?.equity_curves
  if (!curves || typeof curves !== 'object') return []
  const dates = new Set()
  for (const key of EQUITY_ORDER) {
    const series = curves[key]
    if (!Array.isArray(series)) continue
    for (const p of series) {
      if (p?.date) dates.add(p.date)
    }
  }
  const sortedDates = [...dates].sort()
  const maps = {}
  for (const key of EQUITY_ORDER) {
    const series = curves[key]
    maps[key] = new Map(
      Array.isArray(series) ? series.map((p) => [p.date, Number(p.value)]) : [],
    )
  }
  return sortedDates.map((date) => {
    const row = { date }
    for (const key of EQUITY_ORDER) {
      const v = maps[key].get(date)
      row[key] = v != null && Number.isFinite(v) ? Number(v.toFixed(2)) : ''
    }
    return row
  })
}

function buildSummaryExportRows(summaryRows) {
  return summaryRows.map((r) => ({
    method: r.method,
    ann_return: r.ann_return,
    volatility: r.ann_vol,
    sharpe: r.sharpe,
    max_drawdown: r.max_drawdown,
    calm_drawdown: r.calm_drawdown,
    calmar: r.calmar,
    n_rebalances: r.n_rebalances,
  }))
}

function buildShrinkageExportRows(result) {
  const s = result?.shrinkage
  if (!Array.isArray(s)) return []
  return s.map((p) => ({ date: p.date, alpha: p.alpha }))
}

function buildRegimeExportRows(regimePerfRows) {
  return regimePerfRows.map((r) => ({
    regime: r.regime,
    method: r.method,
    sharpe: r.sharpe,
    max_drawdown: r.max_drawdown,
  }))
}

function highestAvgWeightTickerMaxSharpe(weightsHistory) {
  const byTicker = weightsHistory?.max_sharpe
  if (!byTicker || typeof byTicker !== 'object') return ''
  let best = ''
  let bestAvg = -1
  for (const [t, pts] of Object.entries(byTicker)) {
    if (!Array.isArray(pts) || pts.length === 0) continue
    const avg = pts.reduce((s, p) => s + Number(p.weight ?? 0), 0) / pts.length
    if (avg > bestAvg) {
      bestAvg = avg
      best = t
    }
  }
  return best
}

function buildSurfaceMatrix(assetReturns) {
  if (!assetReturns || typeof assetReturns !== 'object') return null
  const tickers = Object.keys(assetReturns).sort()
  if (tickers.length === 0) return null
  const dates = (assetReturns[tickers[0]] ?? []).map((p) => p.date)
  const byT = {}
  for (const t of tickers) {
    byT[t] = new Map(
      (assetReturns[t] ?? []).map((p) => [p.date, numOrNull(p.cumulative_return) ?? 0]),
    )
  }
  const z = dates.map((d) => tickers.map((t) => byT[t].get(d) ?? 0))
  return { tickers, dates, z }
}

/** P5/P95 symmetric color domain so 0 maps to colorscale midpoint (black); Plotly uses cmin/cmax/cmid. */
function surfaceColorScaleDomain(zMatrix) {
  const allZ = zMatrix.flat().filter((v) => Number.isFinite(v))
  if (allZ.length === 0) {
    return { cmin: -1e-6, cmax: 1e-6, cmid: 0 }
  }
  allZ.sort((a, b) => a - b)
  const p5 = allZ[Math.floor(allZ.length * 0.05)]
  const p95 = allZ[Math.floor(allZ.length * 0.95)]
  let zBound = Math.max(Math.abs(p5), Math.abs(p95))
  if (zBound < 1e-12) zBound = 1e-6
  return { cmin: -zBound, cmax: zBound, cmid: 0 }
}

function sceneAxis(title) {
  return {
    title: { text: title, font: { ...PLOTLY_AXIS.titlefont } },
    gridcolor: PLOTLY_AXIS.gridcolor,
    zerolinecolor: PLOTLY_AXIS.zerolinecolor,
    tickfont: { ...PLOTLY_AXIS.tickfont },
    color: PLOTLY_AXIS.color,
    backgroundcolor: '#080808',
  }
}

export default function Backtest() {
  const [universeMode, setUniverseMode] = useState('SP50')
  const [tickers, setTickers] = useState(() => [...SP50_TICKERS])
  const [tickerInput, setTickerInput] = useState('')
  const [startDate, setStartDate] = useState('2019-01-01')
  const [endDate, setEndDate] = useState('2023-12-31')
  const [estimationWindow, setEstimationWindow] = useState(252)
  const [rebalanceMode, setRebalanceMode] = useState('monthly')
  const [driftThresholdPercent, setDriftThresholdPercent] = useState(0.5)
  const [signalBlend, setSignalBlend] = useState(true)
  const [usePointInTime, setUsePointInTime] = useState(false)
  const [pitUniverseType, setPitUniverseType] = useState('SP50')
  const [startingCapital, setStartingCapital] = useState(100000)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [result, setResult] = useState(null)
  const [regimeDefs, setRegimeDefs] = useState([])
  const [Plot, setPlot] = useState(null)
  const [weightTickerInput, setWeightTickerInput] = useState('')
  const [weightTickerQuery, setWeightTickerQuery] = useState('')
  const [streamProgress, setStreamProgress] = useState(null)
  const [progressLog, setProgressLog] = useState([])
  const [elapsedSec, setElapsedSec] = useState(0)
  const eventSourceRef = useRef(null)
  const [trainEndDate, setTrainEndDate] = useState('2019-12-31')
  const [thresholdOptimizeFor, setThresholdOptimizeFor] = useState('sharpe')
  const [thresholdOptLoading, setThresholdOptLoading] = useState(false)
  const [thresholdOptError, setThresholdOptError] = useState(null)
  const [thresholdOptResult, setThresholdOptResult] = useState(null)
  const [thresholdOptProgressIx, setThresholdOptProgressIx] = useState(0)

  useEffect(() => {
    import('react-plotly.js').then((m) => {
      const C = m.default?.default ?? m.default
      setPlot(() => C)
    })
  }, [])

  useEffect(() => {
    getRegimes()
      .then(({ data }) => {
        setRegimeDefs(Array.isArray(data?.regimes) ? data.regimes : [])
      })
      .catch(() => setRegimeDefs([]))
  }, [])

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close()
      eventSourceRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!loading) {
      setElapsedSec(0)
      return undefined
    }
    setElapsedSec(0)
    const id = setInterval(() => {
      setElapsedSec((n) => n + 1)
    }, 1000)
    return () => clearInterval(id)
  }, [loading])

  useEffect(() => {
    if (!thresholdOptLoading) {
      setThresholdOptProgressIx(0)
      return undefined
    }
    setThresholdOptProgressIx(0)
    const n = THRESHOLD_SWEEP_DEFAULTS.length
    const id = setInterval(() => {
      setThresholdOptProgressIx((i) => Math.min(i + 1, n - 1))
    }, 135000)
    return () => clearInterval(id)
  }, [thresholdOptLoading])

  useEffect(() => {
    if (!result?.weights_history) return
    let t = highestAvgWeightTickerMaxSharpe(result.weights_history)
    const uni = Array.isArray(result.metadata?.tickers)
      ? result.metadata.tickers.map((x) => String(x).trim().toUpperCase()).filter(Boolean)
      : []
    if (!t && uni.length) t = uni[0]
    setWeightTickerInput(t)
    setWeightTickerQuery(t)
  }, [result])

  const flushTickerInput = useCallback(() => {
    if (universeMode !== 'Custom') return
    const raw = tickerInput.trim()
    if (!raw) return
    const parts = raw
      .split(/[,\s;]+/)
      .map((p) => p.trim().toUpperCase())
      .filter(Boolean)
    setTickers((prev) => {
      const next = [...prev]
      for (const p of parts) {
        if (p && !next.includes(p)) next.push(p)
      }
      return next
    })
    setTickerInput('')
  }, [tickerInput, universeMode])

  const removeTicker = useCallback(
    (t) => {
      if (universeMode !== 'Custom') return
      setTickers((prev) => prev.filter((x) => x !== t))
    },
    [universeMode],
  )

  const onUniverseChange = useCallback((e) => {
    const v = e.target.value
    setUniverseMode(v)
    if (v === 'SP50') setTickers([...SP50_TICKERS])
    else if (v === 'SP100') setTickers([...SP100_TICKERS])
  }, [])

  const streamEtaSec = useMemo(() => {
    if (!loading || !streamProgress) return null
    const step = Number(streamProgress.step)
    const total = Number(streamProgress.total)
    if (!Number.isFinite(step) || !Number.isFinite(total) || step <= 0 || total <= step) {
      return null
    }
    if (elapsedSec <= 0) return null
    const rate = elapsedSec / step
    return Math.max(0, rate * (total - step))
  }, [loading, streamProgress, elapsedSec])

  const handleRun = () => {
    if (!usePointInTime && !tickers.length) {
      setError('Add at least one ticker (switch to Custom or pick a preset universe).')
      return
    }
    setError(null)
    setLoading(true)
    setResult(null)
    setStreamProgress(null)
    setProgressLog([])
    setElapsedSec(0)
    eventSourceRef.current?.close()
    eventSourceRef.current = null

    const payload = {
      tickers,
      start: startDate,
      end: endDate,
      estimation_window: estimationWindow,
      rebalance_freq: rebalanceMode === 'threshold' ? 'threshold' : 'monthly',
      drift_threshold:
        rebalanceMode === 'threshold' ? driftThresholdPercent / 100 : 0.05,
      signal_blend: signalBlend,
      starting_capital: startingCapital,
      use_point_in_time: usePointInTime,
      pit_universe_type: pitUniverseType,
    }

    const url = buildBacktestStreamUrl(payload)
    const es = new EventSource(url)
    eventSourceRef.current = es

    es.onmessage = (ev) => {
      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        es.close()
        eventSourceRef.current = null
        setError('Invalid stream data from server')
        setLoading(false)
        return
      }
      if (msg.type === 'progress') {
        setStreamProgress(msg)
        const hi = Number(msg.alpha) > 0.1 ? ' ⚠ high uncertainty' : ''
        const line = `Rebalancing ${msg.step}/${msg.total} · ${msg.date} · alpha=${msg.alpha}${hi}`
        setProgressLog((prev) => [...prev.slice(-4), line])
      } else if (msg.type === 'complete') {
        es.close()
        eventSourceRef.current = null
        const nextResult = msg.result
        setResult(nextResult)
        setLoading(false)
        setStreamProgress(null)
        const shrink = nextResult?.shrinkage
        if (Array.isArray(shrink) && shrink.length > 0) {
          const sum = shrink.reduce((s, row) => s + Number(row?.alpha ?? 0), 0)
          const mean = sum / shrink.length
          if (typeof sessionStorage !== 'undefined' && Number.isFinite(mean)) {
            sessionStorage.setItem('machalpha_backtest_shrinkage_mean', String(mean))
          }
        }
      } else if (msg.type === 'error') {
        es.close()
        eventSourceRef.current = null
        setError(typeof msg.message === 'string' ? msg.message : 'Backtest failed')
        setLoading(false)
        setStreamProgress(null)
      }
    }

    es.onerror = () => {
      es.close()
      if (eventSourceRef.current === es) {
        eventSourceRef.current = null
      }
      setLoading((still) => {
        if (still) {
          setError('Stream connection error')
        }
        return false
      })
    }
  }

  const pitUniverseChanges = useMemo(() => {
    if (!result?.metadata?.use_point_in_time) return []
    const raw = result.metadata.pit_universe_changes
    if (!Array.isArray(raw)) return []
    return raw.map((row) => ({
      date: String(row.date ?? ''),
      nTickers: Number(row.n_tickers) || 0,
      joined: Array.isArray(row.joined) ? row.joined.map(String) : [],
      left: Array.isArray(row.left) ? row.left.map(String) : [],
    }))
  }, [result])

  /** Flatten PIT steps: total union size, baseline count, per-ticker add/remove dates */
  const pitMembershipHistory = useMemo(() => {
    if (!pitUniverseChanges.length) return null
    const unionN = Number(result?.metadata?.pit_union_n)
    const universeLabel = result?.metadata?.pit_universe_type
      ? String(result.metadata.pit_universe_type)
      : 'PIT'
    const [first, ...later] = pitUniverseChanges
    const additions = []
    later.forEach((row) => {
      row.joined.forEach((ticker) => additions.push({ date: row.date, ticker }))
    })
    const removals = []
    pitUniverseChanges.forEach((row) => {
      row.left.forEach((ticker) => removals.push({ date: row.date, ticker }))
    })
    const byDateTicker = (a, b) =>
      a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker)
    additions.sort(byDateTicker)
    removals.sort(byDateTicker)
    return {
      unionN: Number.isFinite(unionN) ? unionN : null,
      universeLabel,
      baselineDate: first.date,
      baselineCount: first.nTickers,
      additions,
      removals,
    }
  }, [pitUniverseChanges, result])

  const summaryRows = useMemo(() => {
    if (!result?.summary || !Array.isArray(result.summary)) return []
    const order = (m) => {
      const i = EQUITY_ORDER.indexOf(m)
      return i === -1 ? 999 : i
    }
    return [...result.summary]
      .map((r) => ({ ...r }))
      .sort((a, b) => order(a.method) - order(b.method))
  }, [result])

  const summaryBests = useMemo(() => computeSummaryBests(summaryRows), [summaryRows])

  const regimePerfRows = useMemo(() => {
    if (!result?.regime_performance || !Array.isArray(result.regime_performance)) return []
    return result.regime_performance
  }, [result])

  const equityConfig = useMemo(() => {
    if (!result?.equity_curves || typeof result.equity_curves !== 'object') {
      return { data: [], layout: {} }
    }

    const traces = []
    for (const key of EQUITY_ORDER) {
      const series = result.equity_curves[key]
      if (!Array.isArray(series) || series.length === 0) continue
      traces.push({
        type: 'scatter',
        mode: 'lines',
        name: methodLabel(key),
        x: series.map((p) => p.date),
        y: series.map((p) => Number(p.value)),
        line: {
          color: EQUITY_COLORS[key] ?? '#888',
          width: key === 'max_sharpe' ? 2 : 1.5,
          shape: 'linear',
        },
        hovertemplate: '%{x}<br>%{fullData.name}: $%{y:,.0f}<extra></extra>',
      })
    }

    let yMin = Infinity
    let yMax = -Infinity
    for (const tr of traces) {
      for (const v of tr.y) {
        if (Number.isFinite(v)) {
          yMin = Math.min(yMin, v)
          yMax = Math.max(yMax, v)
        }
      }
    }
    const ySpan = Number.isFinite(yMin) && Number.isFinite(yMax) ? Math.max(yMax - yMin, 1) : 1
    const thresholdY =
      Number.isFinite(yMin) && Number.isFinite(yMax) ? yMin - 0.04 * ySpan : null

    const btStart = result.metadata?.start
    const btEnd = result.metadata?.end
    const regimesVisible =
      typeof btStart === 'string' && typeof btEnd === 'string'
        ? REGIME_BOUNDARIES.filter((r) => regimeOverlapsBacktest(r, btStart, btEnd))
        : []

    if (
      regimesVisible.length > 0 &&
      Number.isFinite(yMin) &&
      Number.isFinite(yMax) &&
      traces.length > 0
    ) {
      for (const r of regimesVisible) {
        for (const [edgeLabel, d] of [
          ['Start', r.start],
          ['End', r.end],
        ]) {
          traces.push({
            type: 'scatter',
            mode: 'lines',
            x: [d, d],
            y: [yMin, yMax],
            line: { color: r.color, width: 2, dash: 'dash' },
            hovertemplate: `<b>${r.id}</b><br>${edgeLabel} boundary: %{x}<extra></extra>`,
            showlegend: false,
          })
        }
      }
    }

    const rebalanceFreq = result?.metadata?.rebalance_freq
    const rawTriggers = result?.threshold_trigger_dates
    const thresholdExtras =
      rebalanceFreq === 'threshold' && Array.isArray(rawTriggers)
        ? [...new Set(rawTriggers.filter((d) => typeof d === 'string'))].sort()
        : []
    if (thresholdExtras.length > 0 && thresholdY != null && Number.isFinite(thresholdY)) {
      traces.push({
        type: 'scatter',
        mode: 'markers',
        name: 'Threshold rebalance',
        x: thresholdExtras,
        y: thresholdExtras.map(() => thresholdY),
        marker: {
          symbol: 'diamond',
          size: 8,
          color: '#4caf7d',
          line: { width: 0 },
        },
        hovertemplate: 'Threshold rebalance<br>%{x}<extra></extra>',
        showlegend: true,
      })
    }

    const layout = {
      ...PLOTLY_BASE,
      height: 400,
      showlegend: true,
      legend: {
        font: { family: 'IBM Plex Mono, monospace', size: 9, color: '#666' },
        bgcolor: 'transparent',
      },
      xaxis: {
        type: 'date',
        title: { text: 'Date', font: { ...PLOTLY_AXIS.titlefont } },
        gridcolor: '#1a1a1a',
        zerolinecolor: PLOTLY_AXIS.zerolinecolor,
        tickfont: { ...PLOTLY_AXIS.tickfont },
        color: PLOTLY_AXIS.color,
      },
      yaxis: {
        title: { text: 'Portfolio value', font: { ...PLOTLY_AXIS.titlefont } },
        gridcolor: '#1a1a1a',
        zerolinecolor: PLOTLY_AXIS.zerolinecolor,
        tickfont: { ...PLOTLY_AXIS.tickfont },
        color: PLOTLY_AXIS.color,
        tickprefix: '$',
        tickformat: ',.0f',
      },
    }

    return { data: traces, layout }
  }, [result])

  const shrinkConfig = useMemo(() => {
    if (!result?.shrinkage || !Array.isArray(result.shrinkage) || result.shrinkage.length === 0) {
      return { data: [], layout: {} }
    }

    const pts = result.shrinkage.map((p) => ({
      date: p.date,
      alpha: numOrNull(p.alpha),
    }))
    const covidPts = pts.filter((p) => p.date >= COVID_START && p.date <= COVID_END)
    let spike = null
    if (covidPts.length > 0) {
      spike = covidPts.reduce((a, b) => (b.alpha != null && (a == null || b.alpha > a.alpha) ? b : a), null)
    }

    const traces = [
      {
        type: 'scatter',
        mode: 'lines',
        x: pts.map((p) => p.date),
        y: pts.map((p) => p.alpha),
        fill: 'tozeroy',
        line: { color: '#f0ece4', width: 1 },
        fillcolor: 'rgba(240, 236, 228, 0.12)',
        name: 'Shrinkage',
        hovertemplate: '%{x}<br>α = %{y:.4f}<extra></extra>',
      },
    ]

    const annotations = [
      {
        x: 1,
        y: 0.1,
        xref: 'paper',
        yref: 'y',
        text: 'high uncertainty threshold',
        showarrow: false,
        xanchor: 'right',
        font: { family: 'IBM Plex Mono, monospace', size: 9, color: '#666' },
      },
    ]

    if (spike != null && spike.alpha != null) {
      annotations.push({
        x: spike.date,
        y: spike.alpha,
        xref: 'x',
        yref: 'y',
        text: 'COVID spike',
        showarrow: true,
        arrowhead: 2,
        ax: 40,
        ay: -30,
        font: { family: 'IBM Plex Mono, monospace', size: 9, color: '#e05555' },
        arrowcolor: '#e05555',
      })
    }

    const layout = {
      ...PLOTLY_BASE,
      height: 220,
      annotations,
      shapes: [
        {
          type: 'line',
          xref: 'paper',
          x0: 0,
          x1: 1,
          y0: 0.1,
          y1: 0.1,
          yref: 'y',
          line: { color: '#666', width: 1, dash: 'dot' },
        },
      ],
      xaxis: {
        title: { text: 'Date', font: { ...PLOTLY_AXIS.titlefont } },
        gridcolor: '#1a1a1a',
        zerolinecolor: PLOTLY_AXIS.zerolinecolor,
        tickfont: { ...PLOTLY_AXIS.tickfont },
        color: PLOTLY_AXIS.color,
      },
      yaxis: {
        title: { text: 'α (Ledoit–Wolf)', font: { ...PLOTLY_AXIS.titlefont } },
        gridcolor: '#1a1a1a',
        zerolinecolor: PLOTLY_AXIS.zerolinecolor,
        tickfont: { ...PLOTLY_AXIS.tickfont },
        color: PLOTLY_AXIS.color,
      },
      showlegend: false,
    }

    return { data: traces, layout }
  }, [result])

  const surfaceConfig = useMemo(() => {
    const built = buildSurfaceMatrix(result?.asset_returns)
    if (!built) return { data: [], layout: {} }
    const { tickers: xt, dates: yt, z } = built
    const { cmin, cmax, cmid } = surfaceColorScaleDomain(z)

    const traces = [
      {
        type: 'surface',
        x: xt,
        y: yt,
        z,
        colorscale: SURFACE_COLORSCALE,
        cmin,
        cmax,
        cmid,
        hovertemplate:
          'Ticker: %{x}<br>Date: %{y}<br>Cum. return: %{z:.4f}<extra></extra>',
        colorbar: {
          tickfont: { family: 'IBM Plex Mono, monospace', size: 9, color: '#555' },
          title: {
            text: '',
            font: { family: 'IBM Plex Mono, monospace', size: 9 },
          },
        },
      },
    ]

    const layout = {
      ...PLOTLY_BASE,
      height: 500,
      margin: { l: 0, r: 0, t: 30, b: 0 },
      scene: {
        xaxis: sceneAxis('Ticker'),
        yaxis: sceneAxis('Date'),
        zaxis: sceneAxis('Cumulative return'),
        bgcolor: '#080808',
        camera: { eye: { x: 1.8, y: -1.8, z: 0.8 } },
      },
    }

    return { data: traces, layout }
  }, [result])

  const tickerWeightConfig = useMemo(() => {
    const empty = { data: [], layout: {}, message: null }
    if (!result?.weights_history) return empty
    const q = weightTickerQuery.trim().toUpperCase()
    if (!q) return { ...empty, message: 'Enter a ticker symbol.' }
    const uni = new Set(
      (Array.isArray(result.metadata?.tickers) ? result.metadata.tickers : []).map((x) =>
        String(x).trim().toUpperCase(),
      ),
    )
    if (!uni.has(q)) {
      return { ...empty, message: 'Ticker not in backtest universe' }
    }
    const nUniv = uni.size || 1
    const eqPct = 100 / nUniv
    const traces = []
    for (const method of EQUITY_ORDER) {
      const pts = result.weights_history[method]?.[q]
      if (Array.isArray(pts) && pts.length > 0) {
        traces.push({
          type: 'scatter',
          mode: 'lines',
          name: methodLabel(method),
          x: pts.map((p) => p.date),
          y: pts.map((p) => Number(p.weight) * 100),
          line: {
            color: EQUITY_COLORS[method] ?? '#888',
            width: 1.5,
            shape: 'linear',
          },
          hovertemplate: '%{x}<br>%{fullData.name}: %{y:.2f}%<extra></extra>',
        })
      } else if (method === 'equal_weight' && Array.isArray(result.rebalance_dates)) {
        const dates = result.rebalance_dates
        traces.push({
          type: 'scatter',
          mode: 'lines',
          name: methodLabel('equal_weight'),
          x: dates,
          y: dates.map(() => eqPct),
          line: {
            color: EQUITY_COLORS.equal_weight,
            width: 1.5,
            shape: 'linear',
          },
          hovertemplate: '%{x}<br>%{fullData.name}: %{y:.2f}%<extra></extra>',
        })
      }
    }
    if (traces.length === 0) {
      return { ...empty, message: 'No weight history for this ticker.' }
    }
    const layout = {
      ...PLOTLY_BASE,
      height: 280,
      showlegend: true,
      legend: {
        font: { family: 'IBM Plex Mono, monospace', size: 9, color: '#666' },
        bgcolor: 'transparent',
      },
      xaxis: {
        type: 'date',
        title: { text: 'Date', font: { ...PLOTLY_AXIS.titlefont } },
        gridcolor: '#1a1a1a',
        zerolinecolor: PLOTLY_AXIS.zerolinecolor,
        tickfont: { ...PLOTLY_AXIS.tickfont },
        color: PLOTLY_AXIS.color,
      },
      yaxis: {
        title: { text: 'Weight %', font: { ...PLOTLY_AXIS.titlefont } },
        gridcolor: '#1a1a1a',
        zerolinecolor: PLOTLY_AXIS.zerolinecolor,
        tickfont: { ...PLOTLY_AXIS.tickfont },
        color: PLOTLY_AXIS.color,
        ticksuffix: '%',
      },
    }
    return { data: traces, layout, message: null }
  }, [result, weightTickerQuery])

  const regimeCards = useMemo(() => {
    const defs =
      regimeDefs.length > 0
        ? regimeDefs
        : REGIME_BOUNDARIES.map(({ id, start, end }) => ({ id, start, end }))
    const rowOrder = (m) => {
      const i = EQUITY_ORDER.indexOf(m)
      return i === -1 ? 999 : i
    }
    return defs.map((def) => {
      const id = def.id
      const rows = regimePerfRows
        .filter((r) => r.regime === id)
        .sort((a, b) => rowOrder(a.method) - rowOrder(b.method))
      const bests = computeRegimeBests(rows)
      return { def, rows, bests }
    })
  }, [regimeDefs, regimePerfRows])

  const exportSlug = useMemo(() => backtestExportSlug(result?.metadata), [result])

  const exportEquityCsv = useCallback(() => {
    if (!result) return
    downloadCSV(`machalpha_equity_curves_${exportSlug}.csv`, buildEquityExportRows(result))
  }, [result, exportSlug])

  const exportSummaryCsv = useCallback(() => {
    if (!result) return
    downloadCSV(
      `machalpha_performance_summary_${exportSlug}.csv`,
      buildSummaryExportRows(summaryRows),
    )
  }, [result, exportSlug, summaryRows])

  const exportShrinkageCsv = useCallback(() => {
    if (!result) return
    downloadCSV(
      `machalpha_shrinkage_series_${exportSlug}.csv`,
      buildShrinkageExportRows(result),
    )
  }, [result, exportSlug])

  const exportRegimeCsv = useCallback(() => {
    if (!result) return
    downloadCSV(
      `machalpha_regime_performance_${exportSlug}.csv`,
      buildRegimeExportRows(regimePerfRows),
    )
  }, [result, exportSlug, regimePerfRows])

  const exportAllZip = useCallback(async () => {
    if (!result) return
    const slug = backtestExportSlug(result.metadata)
    const zip = new JSZip()
    zip.file(
      `machalpha_equity_curves_${slug}.csv`,
      buildCsvString(buildEquityExportRows(result)),
    )
    zip.file(
      `machalpha_performance_summary_${slug}.csv`,
      buildCsvString(buildSummaryExportRows(summaryRows)),
    )
    zip.file(
      `machalpha_shrinkage_series_${slug}.csv`,
      buildCsvString(buildShrinkageExportRows(result)),
    )
    zip.file(
      `machalpha_regime_performance_${slug}.csv`,
      buildCsvString(buildRegimeExportRows(regimePerfRows)),
    )
    const blob = await zip.generateAsync({ type: 'blob' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `machalpha_backtest_${slug}.zip`
    a.click()
    URL.revokeObjectURL(url)
  }, [result, summaryRows, regimePerfRows])

  const runThresholdOptimization = useCallback(async () => {
    setThresholdOptError(null)
    setThresholdOptResult(null)
    setThresholdOptLoading(true)
    try {
      const { data } = await optimizeThreshold({
        tickers,
        start: startDate,
        end: endDate,
        train_end: trainEndDate,
        estimation_window: estimationWindow,
        signal_blend: signalBlend,
        starting_capital: startingCapital,
        thresholds: THRESHOLD_SWEEP_DEFAULTS,
        optimize_for: thresholdOptimizeFor,
      })
      setThresholdOptResult(data)
    } catch (err) {
      const d = err.response?.data?.detail
      const msg =
        typeof d === 'string'
          ? d
          : Array.isArray(d)
            ? d.map((x) => (x?.msg != null ? String(x.msg) : String(x))).join('; ')
            : d != null
              ? JSON.stringify(d)
              : err.message || 'Threshold optimization failed'
      setThresholdOptError(msg)
    } finally {
      setThresholdOptLoading(false)
    }
  }, [
    tickers,
    startDate,
    endDate,
    trainEndDate,
    estimationWindow,
    signalBlend,
    startingCapital,
    thresholdOptimizeFor,
  ])

  const thresholdOptChartConfig = useMemo(() => {
    const rows = thresholdOptResult?.results
    if (!Array.isArray(rows) || rows.length === 0) {
      return { data: [], layout: {} }
    }
    const x = rows.map((r) => r.threshold)
    return {
      data: [
        {
          type: 'scatter',
          mode: 'lines+markers',
          name: 'Train Sharpe',
          x,
          y: rows.map((r) => numOrNull(r.train_sharpe)),
          line: { color: '#888888', width: 1.5 },
          marker: { size: 6, color: '#888888' },
          hovertemplate: '%{x}%<br>Train Sharpe: %{y:.4f}<extra></extra>',
        },
        {
          type: 'scatter',
          mode: 'lines+markers',
          name: 'Validation Sharpe',
          x,
          y: rows.map((r) => numOrNull(r.val_sharpe)),
          line: { color: '#f0ece4', width: 1.5 },
          marker: { size: 6, color: '#f0ece4' },
          hovertemplate: '%{x}%<br>Val Sharpe: %{y:.4f}<extra></extra>',
        },
      ],
      layout: {
        ...PLOTLY_BASE,
        height: 280,
        showlegend: true,
        legend: {
          font: { family: 'IBM Plex Mono, monospace', size: 9, color: '#666' },
          bgcolor: 'transparent',
        },
        xaxis: {
          title: { text: 'Drift threshold %', font: { ...PLOTLY_AXIS.titlefont } },
          gridcolor: '#1a1a1a',
          zerolinecolor: PLOTLY_AXIS.zerolinecolor,
          tickfont: { ...PLOTLY_AXIS.tickfont },
          color: PLOTLY_AXIS.color,
        },
        yaxis: {
          title: { text: 'Sharpe ratio', font: { ...PLOTLY_AXIS.titlefont } },
          gridcolor: '#1a1a1a',
          zerolinecolor: PLOTLY_AXIS.zerolinecolor,
          tickfont: { ...PLOTLY_AXIS.tickfont },
          color: PLOTLY_AXIS.color,
        },
      },
    }
  }, [thresholdOptResult])

  const loadingDetail = useMemo(() => {
    const universeLabel =
      universeMode === 'Custom'
        ? `Custom (${tickers.length} tickers)`
        : universeMode
    const rebalanceLabel =
      rebalanceMode === 'threshold' ? 'threshold' : 'monthly'
    return `Running ${universeLabel} · ${estimationWindow}d window · ${rebalanceLabel} rebalancing...`
  }, [universeMode, tickers.length, estimationWindow, rebalanceMode])

  const onDriftPercentChange = (e) => {
    const v = Number(e.target.value)
    if (!Number.isFinite(v)) return
    setDriftThresholdPercent(Math.min(10, Math.max(0.1, v)))
  }

  return (
    <main className="page page--backtest">
      <header className="page-masthead">
        <h1 className="page-masthead__title">Backtest</h1>
        <p className="page-masthead__dateline">
          Rolling optimization · {tickers.length} names · {startDate} → {endDate}
        </p>
      </header>

      <div className="optimizer">
        <aside className="optimizer__left">
          <div className="optimizer__section">
            <div className="optimizer__label">Universe</div>
            <select
              className="backtest__select"
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
                  }}
                />
              </>
            ) : (
              <div className="backtest__universe-pill" aria-live="polite">
                {universeMode} · {universeMode === 'SP50' ? SP50_TICKERS.length : SP100_TICKERS.length}{' '}
                tickers
              </div>
            )}
          </div>

          <div className="optimizer__section">
            <div className="optimizer__label">Point-in-time universe</div>
            <label className="backtest__checkbox-row">
              <input
                type="checkbox"
                checked={usePointInTime}
                onChange={(e) => setUsePointInTime(e.target.checked)}
              />
              Use S&P 500 membership history at each rebalance (fja05680). SP50/SP100 use current
              market-cap ranks as a proxy (see research docs).
            </label>
            {usePointInTime ? (
              <div className="optimizer__method-grid" style={{ marginTop: '10px' }}>
                {['SP50', 'SP100', 'SP500'].map((u) => (
                  <button
                    key={u}
                    type="button"
                    className={`optimizer__method-btn${pitUniverseType === u ? ' optimizer__method-btn--active' : ''}`}
                    onClick={() => setPitUniverseType(u)}
                  >
                    {u}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <div className="optimizer__section">
            <div className="optimizer__label">Date range</div>
            <div className="optimizer__date-row">
              <input
                className="optimizer__date-input"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
              <input
                className="optimizer__date-input"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
          </div>

          <div className="optimizer__section">
            <div className="optimizer__label">Estimation window</div>
            <div className="optimizer__method-grid">
              {[63, 126, 252].map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`optimizer__method-btn${estimationWindow === d ? ' optimizer__method-btn--active' : ''}`}
                  onClick={() => setEstimationWindow(d)}
                >
                  {d} days
                </button>
              ))}
            </div>
          </div>

          <div className="optimizer__section">
            <div className="optimizer__label">Rebalancing</div>
            <div className="optimizer__method-grid">
              <button
                type="button"
                className={`optimizer__method-btn${rebalanceMode === 'monthly' ? ' optimizer__method-btn--active' : ''}`}
                onClick={() => setRebalanceMode('monthly')}
              >
                Monthly
              </button>
              <button
                type="button"
                className={`optimizer__method-btn${rebalanceMode === 'threshold' ? ' optimizer__method-btn--active' : ''}`}
                onClick={() => setRebalanceMode('threshold')}
              >
                Threshold
              </button>
            </div>
            {rebalanceMode === 'threshold' && (
              <div className="backtest__threshold-drift">
                <div className="optimizer__label">
                  Drift threshold %<span className="optimizer__label-value"> {driftThresholdPercent}%</span>
                </div>
                <input
                  className="optimizer__input"
                  type="number"
                  min={0.1}
                  max={10}
                  step={0.1}
                  value={driftThresholdPercent}
                  onChange={onDriftPercentChange}
                  aria-label="Drift threshold percent"
                />
                <p className="optimizer__hint" style={{ marginTop: '8px' }}>
                  Lower = more sensitive. SP50 empirical max drift: 1.3%/month.
                </p>
              </div>
            )}
          </div>

          <div className="optimizer__section">
            <label className="backtest__checkbox-row">
              <input
                type="checkbox"
                checked={signalBlend}
                onChange={(e) => setSignalBlend(e.target.checked)}
              />
              Signal blend
            </label>
          </div>

          <div className="optimizer__section">
            <div className="optimizer__label">Starting capital</div>
            <div className="backtest__capital-row">
              <span className="backtest__capital-prefix">$</span>
              <input
                className="backtest__capital-input"
                type="number"
                min={1}
                step={1000}
                value={startingCapital}
                onChange={(e) => setStartingCapital(Number(e.target.value) || 0)}
              />
            </div>
          </div>

          <button
            type="button"
            className="optimizer__run"
            disabled={loading || (!usePointInTime && tickers.length === 0)}
            onClick={handleRun}
          >
            {loading ? 'Running…' : 'RUN BACKTEST'}
          </button>
          <p className="optimizer__hint">This may take 3-5 minutes for SP50.</p>

          {loading && (
            <div className="backtest__loading">
              <div className="backtest__loading-text">{loadingDetail}</div>
              <div className="backtest__stream-bar-wrap">
                <div
                  className="backtest__stream-bar-fill"
                  style={{
                    width: `${streamProgress && Number.isFinite(Number(streamProgress.pct)) ? Number(streamProgress.pct) : 0}%`,
                  }}
                />
              </div>
              <div className="backtest__stream-status">
                {streamProgress ? (
                  <>
                    <span>
                      Rebalancing {streamProgress.step}/{streamProgress.total} · {streamProgress.date}{' '}
                      · alpha={streamProgress.alpha}
                      {Number(streamProgress.alpha) > 0.1 ? (
                        <span className="backtest__stream-warning"> ⚠ high uncertainty</span>
                      ) : null}
                    </span>
                    <span className="backtest__stream-meta">
                      Elapsed {formatDurationSec(elapsedSec)}
                      {' · '}
                      ETA {formatDurationSec(streamEtaSec)}
                    </span>
                  </>
                ) : (
                  <span className="backtest__stream-meta">Starting backtest…</span>
                )}
              </div>
              <pre className="backtest__stream-log" aria-live="polite">
                {progressLog.length === 0 ? '—' : progressLog.join('\n')}
              </pre>
            </div>
          )}

          {error && <div className="optimizer__error">{error}</div>}

          <div className="optimizer__section backtest__threshold-controls">
            <div className="optimizer__label">THRESHOLD OPTIMIZATION</div>
            <div className="backtest__threshold-train-row">
              <label className="backtest__threshold-mini-label" htmlFor="backtest-train-end">
                TRAIN ENDS
              </label>
              <input
                id="backtest-train-end"
                className="optimizer__date-input"
                type="date"
                value={trainEndDate}
                onChange={(e) => setTrainEndDate(e.target.value)}
                disabled={thresholdOptLoading}
              />
            </div>
            <div className="optimizer__label" style={{ marginTop: '10px' }}>
              Optimize for
            </div>
            <div className="backtest__threshold-opt-grid">
              <button
                type="button"
                className={
                  thresholdOptimizeFor === 'sharpe'
                    ? 'optimizer__method-btn optimizer__method-btn--active'
                    : 'optimizer__method-btn'
                }
                disabled={thresholdOptLoading}
                onClick={() => setThresholdOptimizeFor('sharpe')}
              >
                Sharpe
              </button>
              <button
                type="button"
                className={
                  thresholdOptimizeFor === 'calmar'
                    ? 'optimizer__method-btn optimizer__method-btn--active'
                    : 'optimizer__method-btn'
                }
                disabled={thresholdOptLoading}
                onClick={() => setThresholdOptimizeFor('calmar')}
              >
                Calmar
              </button>
              <button
                type="button"
                className={
                  thresholdOptimizeFor === 'max_drawdown'
                    ? 'optimizer__method-btn optimizer__method-btn--active'
                    : 'optimizer__method-btn'
                }
                disabled={thresholdOptLoading}
                onClick={() => setThresholdOptimizeFor('max_drawdown')}
              >
                Min DD
              </button>
            </div>
            <button
              type="button"
              className="optimizer__run"
              style={{ marginTop: '12px' }}
              disabled={loading || thresholdOptLoading || tickers.length === 0}
              onClick={runThresholdOptimization}
            >
              {thresholdOptLoading ? 'Running…' : 'RUN OPTIMIZATION'}
            </button>
            <p className="optimizer__hint" style={{ marginTop: '8px' }}>
              Runs {THRESHOLD_SWEEP_DEFAULTS.length} backtests — expect 20–40 minutes for SP50.
            </p>
            {thresholdOptLoading && (
              <p className="backtest__threshold-loading" aria-live="polite">
                Testing threshold {THRESHOLD_SWEEP_DEFAULTS[thresholdOptProgressIx] ?? THRESHOLD_SWEEP_DEFAULTS[0]}% —{' '}
                {Math.min(thresholdOptProgressIx + 1, THRESHOLD_SWEEP_DEFAULTS.length)} of{' '}
                {THRESHOLD_SWEEP_DEFAULTS.length}…
              </p>
            )}
          </div>

          {pitMembershipHistory ? (
            <div className="optimizer__section backtest__membership-section">
              <div className="optimizer__label">Membership history</div>
              <p className="optimizer__hint backtest__membership-hint">
                Point-in-time {pitMembershipHistory.universeLabel} — unique symbols in the returns panel and
                membership changes between rebalances.
              </p>
              <ul className="backtest__membership-stats">
                <li>
                  <span className="backtest__membership-k">Total tickers (period)</span>
                  <span className="backtest__membership-v">
                    {pitMembershipHistory.unionN != null ? pitMembershipHistory.unionN : '—'}
                  </span>
                </li>
                <li>
                  <span className="backtest__membership-k">Starting universe</span>
                  <span className="backtest__membership-v">
                    {pitMembershipHistory.baselineCount} on {pitMembershipHistory.baselineDate}
                  </span>
                </li>
              </ul>
              {pitMembershipHistory.additions.length > 0 ? (
                <>
                  <div className="backtest__membership-subhead">Added</div>
                  <div className="backtest__membership-table-wrap">
                    <table className="backtest__membership-table">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Ticker</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pitMembershipHistory.additions.map((r) => (
                          <tr key={`${r.date}-${r.ticker}`}>
                            <td>{r.date}</td>
                            <td>{r.ticker}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : null}
              {pitMembershipHistory.removals.length > 0 ? (
                <>
                  <div className="backtest__membership-subhead">Removed</div>
                  <div className="backtest__membership-table-wrap">
                    <table className="backtest__membership-table">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Ticker</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pitMembershipHistory.removals.map((r) => (
                          <tr key={`${r.date}-${r.ticker}-rm`}>
                            <td>{r.date}</td>
                            <td>{r.ticker}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
        </aside>

        <div className="backtest__right">
          {result && summaryRows.length > 0 && (
            <>
              <div className="backtest__section-heading">Performance summary</div>
              <div className="backtest__summary-wrap">
                <table className="backtest__summary-table">
                  <thead>
                    <tr>
                      <th>Method</th>
                      <th>Ann. return</th>
                      <th>Volatility</th>
                      <th>Sharpe</th>
                      <th>Max drawdown</th>
                      <th className="backtest__th-with-hint">
                        Calm DD
                        <span
                          className="backtest__th-info"
                          title="Max drawdown excluding .com bubble burst, 2008 financial crisis, Q4 2018 bear, COVID crash, and rate shock from the calm window"
                          aria-label="Max drawdown excluding .com bubble burst, 2008 financial crisis, Q4 2018 bear, COVID crash, and rate shock from the calm window"
                          role="img"
                        >
                          ⓘ
                        </span>
                      </th>
                      <th>Calmar</th>
                      <th>Rebalances</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summaryRows.map((row) => {
                      const m = row.method
                      const ar = numOrNull(row.ann_return)
                      const vol = numOrNull(row.ann_vol)
                      const sh = numOrNull(row.sharpe)
                      const dd = numOrNull(row.max_drawdown)
                      const calmDd = numOrNull(row.calm_drawdown)
                      const cal = numOrNull(row.calmar)
                      const nreb = numOrNull(row.n_rebalances)
                      return (
                        <tr key={m}>
                          <td>{methodLabel(m)}</td>
                          <td
                            className={`${ar != null && ar > 0 ? 'backtest__cell--pos' : ''} ${isBestSummary(ar, summaryBests.ann_return, 'ann_return') ? 'backtest__cell--best' : ''}`}
                          >
                            {formatPctDecimal(ar)}
                          </td>
                          <td
                            className={isBestSummary(vol, summaryBests.ann_vol, 'ann_vol') ? 'backtest__cell--best' : ''}
                          >
                            {formatPctDecimal(vol)}
                          </td>
                          <td
                            className={`${sh != null && sh > 0 ? 'backtest__cell--pos' : ''} ${isBestSummary(sh, summaryBests.sharpe, 'sharpe') ? 'backtest__cell--best' : ''}`}
                          >
                            {formatSharpe(sh)}
                          </td>
                          <td
                            className={`backtest__cell--dd ${isBestSummary(dd, summaryBests.max_drawdown, 'max_drawdown') ? 'backtest__cell--best' : ''}`}
                          >
                            {formatPctDecimal(dd)}
                          </td>
                          <td
                            className={`backtest__cell--dd ${isBestSummary(calmDd, summaryBests.calm_drawdown, 'calm_drawdown') ? 'backtest__cell--best' : ''}`}
                          >
                            {formatPctDecimal(calmDd)}
                          </td>
                          <td
                            className={`${cal != null && Number.isFinite(cal) ? 'backtest__cell--calmar' : ''} ${isBestSummary(cal, summaryBests.calmar, 'calmar') ? 'backtest__cell--best' : ''}`}
                          >
                            {formatCalmar(cal)}
                          </td>
                          <td
                            className={isBestSummary(nreb, summaryBests.n_rebalances, 'n_rebalances') ? 'backtest__cell--best' : ''}
                          >
                            {nreb != null ? String(Math.round(nreb)) : '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              <div className="backtest__section-heading">Equity curves</div>
              <div className="backtest__plot-wrap backtest__plot-wrap--equity">
                {!Plot || typeof Plot !== 'function' ? (
                  <div className="backtest__plot-loading" style={loadingStyle}>
                    Loading chart…
                  </div>
                ) : (
                  <Plot
                    data={equityConfig.data}
                    layout={equityConfig.layout}
                    config={{ displayModeBar: false, responsive: true }}
                    style={{ width: '100%', height: '100%' }}
                    useResizeHandler
                  />
                )}
              </div>

              <div className="backtest__surface-title">TICKER WEIGHT ANALYSIS</div>
              <div className="backtest__ticker-weight-row">
                <input
                  className="optimizer__input"
                  type="text"
                  placeholder="Enter ticker symbol"
                  value={weightTickerInput}
                  onChange={(e) => setWeightTickerInput(e.target.value)}
                  aria-label="Ticker symbol for weight chart"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      setWeightTickerQuery(weightTickerInput.trim().toUpperCase())
                    }
                  }}
                />
                <button
                  type="button"
                  className="optimizer__method-btn"
                  onClick={() => setWeightTickerQuery(weightTickerInput.trim().toUpperCase())}
                >
                  Search
                </button>
              </div>
              <div className="backtest__plot-wrap backtest__plot-wrap--weights">
                {!Plot || typeof Plot !== 'function' ? (
                  <div className="backtest__plot-loading" style={loadingStyle}>
                    Loading chart…
                  </div>
                ) : tickerWeightConfig.message ? (
                  <div className="backtest__plot-loading" style={loadingStyle}>
                    {tickerWeightConfig.message}
                  </div>
                ) : (
                  <Plot
                    data={tickerWeightConfig.data}
                    layout={tickerWeightConfig.layout}
                    config={{ displayModeBar: false, responsive: true }}
                    style={{ width: '100%', height: '100%' }}
                    useResizeHandler
                  />
                )}
              </div>

              <div className="backtest__section-heading">Shrinkage intensity</div>
              <div className="backtest__plot-wrap backtest__plot-wrap--shrink">
                {!Plot || typeof Plot !== 'function' ? (
                  <div className="backtest__plot-loading" style={loadingStyle}>
                    Loading chart…
                  </div>
                ) : (
                  <Plot
                    data={shrinkConfig.data}
                    layout={shrinkConfig.layout}
                    config={{ displayModeBar: false, responsive: true }}
                    style={{ width: '100%', height: '100%' }}
                    useResizeHandler
                  />
                )}
              </div>

              <div className="backtest__section-heading">Regime performance</div>
              <div className="backtest__regime-grid">
                {regimeCards.map(({ def, rows, bests }) => (
                  <div key={def.id} className="backtest__regime-card">
                    <div className="backtest__regime-card-title">{def.id}</div>
                    <div className="backtest__regime-card-range">
                      {def.start} — {def.end}
                    </div>
                    <table className="backtest__regime-table">
                      <thead>
                        <tr>
                          <th>Method</th>
                          <th>Sharpe</th>
                          <th>Max drawdown</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row) => {
                          const sh = numOrNull(row.sharpe)
                          const dd = numOrNull(row.max_drawdown)
                          return (
                            <tr key={row.method}>
                              <td>{methodLabel(row.method)}</td>
                              <td
                                className={`${sh != null && sh > 0 ? 'backtest__cell--pos' : ''} ${sh != null && bests.sharpe != null && isclose(sh, bests.sharpe) ? 'backtest__cell--best' : ''}`}
                              >
                                {formatSharpe(sh)}
                              </td>
                              <td
                                className={`backtest__cell--dd ${dd != null && bests.max_drawdown != null && isclose(dd, bests.max_drawdown) ? 'backtest__cell--best' : ''}`}
                              >
                                {formatPctDecimal(dd)}
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>

              <div className="backtest__surface-title">
                3D ASSET RETURN SURFACE — CUMULATIVE RETURNS ACROSS UNIVERSE AND TIME
              </div>
              <div className="backtest__plot-wrap backtest__plot-wrap--surface">
                {!Plot || typeof Plot !== 'function' ? (
                  <div className="backtest__plot-loading" style={loadingStyle}>
                    Loading chart…
                  </div>
                ) : (
                  <Plot
                    data={surfaceConfig.data}
                    layout={surfaceConfig.layout}
                    config={{ displayModeBar: false, responsive: true }}
                    style={{ width: '100%', height: '100%' }}
                    useResizeHandler
                  />
                )}
              </div>

              <div className="backtest__section-heading">EXPORT DATA</div>
              <div className="backtest__export-row">
                <button type="button" className="backtest__export-btn" onClick={exportEquityCsv}>
                  Equity Curves CSV
                </button>
                <button type="button" className="backtest__export-btn" onClick={exportSummaryCsv}>
                  Performance Summary CSV
                </button>
                <button type="button" className="backtest__export-btn" onClick={exportShrinkageCsv}>
                  Shrinkage Series CSV
                </button>
                <button type="button" className="backtest__export-btn" onClick={exportRegimeCsv}>
                  Regime Performance CSV
                </button>
                <button type="button" className="backtest__export-btn" onClick={exportAllZip}>
                  Export All (ZIP)
                </button>
              </div>

              <p className="page-byline">machAlpha backtest · regime overlays and threshold triggers</p>
            </>
          )}

          {thresholdOptError && (
            <div className="optimizer__error backtest__threshold-error">{thresholdOptError}</div>
          )}

          {thresholdOptResult && (
            <>
              <div className="backtest__section-heading">THRESHOLD OPTIMIZATION</div>
              <div className="backtest__plot-wrap backtest__plot-wrap--threshold">
                {!Plot || typeof Plot !== 'function' ? (
                  <div className="backtest__plot-loading" style={loadingStyle}>
                    Loading chart…
                  </div>
                ) : (
                  <Plot
                    data={thresholdOptChartConfig.data}
                    layout={thresholdOptChartConfig.layout}
                    config={{ displayModeBar: false, responsive: true }}
                    style={{ width: '100%', height: '100%' }}
                    useResizeHandler
                  />
                )}
              </div>
              <div className="backtest__threshold-table-wrap">
                <table className="backtest__threshold-table">
                  <thead>
                    <tr>
                      <th>Threshold %</th>
                      <th>Train Sharpe</th>
                      <th>Val Sharpe</th>
                      <th>Train DD</th>
                      <th>Val DD</th>
                      <th>Rebalances</th>
                    </tr>
                  </thead>
                  <tbody>
                    {thresholdOptResult.results.map((row) => {
                      const isOpt =
                        row.threshold != null &&
                        thresholdOptResult.optimal_threshold != null &&
                        Math.abs(Number(row.threshold) - Number(thresholdOptResult.optimal_threshold)) <
                          1e-6
                      return (
                        <tr
                          key={row.threshold}
                          className={isOpt ? 'backtest__threshold-row--optimal' : undefined}
                        >
                          <td>{row.threshold != null ? String(row.threshold) : '—'}</td>
                          <td>{formatSharpe(numOrNull(row.train_sharpe))}</td>
                          <td>{formatSharpe(numOrNull(row.val_sharpe))}</td>
                          <td className="backtest__cell--dd">
                            {formatPctDecimal(numOrNull(row.train_drawdown))}
                          </td>
                          <td className="backtest__cell--dd">
                            {formatPctDecimal(numOrNull(row.val_drawdown))}
                          </td>
                          <td>
                            {row.n_rebalances != null ? String(Math.round(row.n_rebalances)) : '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {(() => {
                const opt = thresholdOptResult.optimal_threshold
                const optRow = thresholdOptResult.results.find(
                  (r) =>
                    r.threshold != null &&
                    opt != null &&
                    Math.abs(Number(r.threshold) - Number(opt)) < 1e-6,
                )
                const vSh = numOrNull(optRow?.val_sharpe)
                return (
                  <div className="backtest__threshold-callout">
                    Optimal threshold: {opt != null ? `${opt}%` : '—'} · Validation Sharpe:{' '}
                    {vSh != null ? vSh.toFixed(3) : '—'} · Recommended for SP50 universe
                  </div>
                )
              })()}
            </>
          )}
        </div>
      </div>
    </main>
  )
}
