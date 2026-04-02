import { useEffect, useMemo, useState } from 'react'
import { PLOTLY_AXIS, PLOTLY_BASE } from '../chartTheme.js'

const loadingStyle = { color: '#444', fontFamily: 'IBM Plex Mono, monospace', fontSize: 11 }

export default function RollingRiskChart({ drawdownSeries, maxDrawdown }) {
  const [Plot, setPlot] = useState(null)
  useEffect(() => {
    import('react-plotly.js').then((m) => {
      const C = m.default?.default ?? m.default
      setPlot(() => C)
    })
  }, [])

  const { data, layout } = useMemo(() => {
    if (!Array.isArray(drawdownSeries) || drawdownSeries.length === 0) {
      return { data: [], layout: {} }
    }

    const dates = drawdownSeries.map((d) => d.date)
    const yPct = drawdownSeries.map((d) => Number(d.drawdown) * 100)

    const ddMin =
      maxDrawdown != null && Number.isFinite(Number(maxDrawdown))
        ? Number(maxDrawdown) * 100
        : Math.min(...yPct)

    const shapes = []
    for (const d of drawdownSeries) {
      const dd = Number(d.drawdown)
      if (dd < -0.15) {
        shapes.push({
          type: 'line',
          xref: 'x',
          yref: 'paper',
          x0: d.date,
          x1: d.date,
          y0: 0,
          y1: 1,
          line: { color: '#e8a020', width: 1, dash: 'dash' },
        })
      }
    }

    const traces = [
      {
        type: 'scatter',
        mode: 'lines',
        x: dates,
        y: yPct,
        fill: 'tozeroy',
        line: { color: '#e05555', width: 1 },
        fillcolor: 'rgba(224, 85, 85, 0.6)',
        hovertemplate: '%{x}<br>Drawdown: %{y:.2f}%<extra></extra>',
      },
      {
        type: 'scatter',
        mode: 'lines',
        x: [dates[0], dates[dates.length - 1]],
        y: [ddMin, ddMin],
        line: { color: '#f0ece4', width: 1, dash: 'dot' },
        hovertemplate: 'Max drawdown: %{y:.2f}%<extra></extra>',
        showlegend: false,
      },
    ]

    const lay = {
      ...PLOTLY_BASE,
      xaxis: {
        title: { text: 'Date', font: { ...PLOTLY_AXIS.titlefont } },
        gridcolor: PLOTLY_AXIS.gridcolor,
        zerolinecolor: PLOTLY_AXIS.zerolinecolor,
        tickfont: { ...PLOTLY_AXIS.tickfont },
        color: PLOTLY_AXIS.color,
      },
      yaxis: {
        title: { text: 'Drawdown %', font: { ...PLOTLY_AXIS.titlefont } },
        gridcolor: PLOTLY_AXIS.gridcolor,
        zerolinecolor: PLOTLY_AXIS.zerolinecolor,
        tickfont: { ...PLOTLY_AXIS.tickfont },
        color: PLOTLY_AXIS.color,
      },
      shapes,
      showlegend: false,
    }

    return { data: traces, layout: lay }
  }, [drawdownSeries, maxDrawdown])

  if (
    drawdownSeries == null ||
    !Array.isArray(drawdownSeries) ||
    drawdownSeries.length === 0
  ) {
    return null
  }

  if (!Plot || typeof Plot !== 'function') {
    return <div style={loadingStyle}>Loading chart...</div>
  }

  return (
    <div className="risk__card" style={{ marginTop: '1.25rem' }}>
      <div
        className="plotly-section-label"
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          color: 'var(--text-muted)',
          letterSpacing: '0.15em',
          textTransform: 'uppercase',
          borderTop: '1px solid var(--border)',
          paddingTop: 6,
          marginBottom: 10,
        }}
      >
        Drawdown series — Portfolio wealth decay
      </div>
      <div
        style={{
          width: '100%',
          height: 280,
          border: '1px solid #1e1e1e',
          background: '#080808',
        }}
      >
        <Plot
          data={data}
          layout={layout}
          config={{ displayModeBar: false, responsive: true }}
          style={{ width: '100%', height: '100%' }}
          useResizeHandler
        />
      </div>
    </div>
  )
}
