import { useEffect, useMemo, useState } from 'react'
import { PLOTLY_AXIS, PLOTLY_BASE } from '../chartTheme.js'

const loadingStyle = { color: '#444', fontFamily: 'IBM Plex Mono, monospace', fontSize: 11 }

const SHARPE_COLORSCALE = [
  [0, '#2a2a2a'],
  [0.5, '#f0ece4'],
  [1.0, '#4caf7d'],
]

function sceneAxis(title) {
  return {
    title: {
      text: title,
      font: { ...PLOTLY_AXIS.titlefont },
    },
    gridcolor: PLOTLY_AXIS.gridcolor,
    zerolinecolor: PLOTLY_AXIS.zerolinecolor,
    tickfont: { ...PLOTLY_AXIS.tickfont },
    color: PLOTLY_AXIS.color,
    backgroundcolor: '#080808',
  }
}

export default function FrontierSurface3D({ frontier }) {
  const [Plot, setPlot] = useState(null)
  useEffect(() => {
    import('react-plotly.js').then((m) => {
      const C = m.default?.default ?? m.default
      setPlot(() => C)
    })
  }, [])

  const { data, layout } = useMemo(() => {
    if (!Array.isArray(frontier) || frontier.length === 0) {
      return { data: [], layout: {} }
    }

    const rows = [...frontier]
      .map((p) => ({
        return: Number(p.return ?? 0),
        volatility: Number(p.volatility ?? 0),
        sharpe: Number(p.sharpe ?? 0),
      }))
      .sort((a, b) => a.volatility - b.volatility)

    const x = rows.map((r) => r.volatility * 100)
    const y = rows.map((r) => r.return * 100)
    const z = rows.map((r) => r.sharpe)
    const zMin = Math.min(...z)
    const zMax = Math.max(...z)
    const zSpan = zMax - zMin || 1e-9

    let maxSharpeIdx = 0
    let minVolIdx = 0
    for (let i = 1; i < rows.length; i++) {
      if (rows[i].sharpe > rows[maxSharpeIdx].sharpe) maxSharpeIdx = i
      if (rows[i].volatility < rows[minVolIdx].volatility) minVolIdx = i
    }

    const ms = rows[maxSharpeIdx]
    const mv = rows[minVolIdx]

    const traces = [
      {
        type: 'scatter3d',
        mode: 'lines+markers',
        x,
        y,
        z,
        line: {
          width: 4,
          color: z,
          cmin: zMin - 0.05 * zSpan,
          cmax: zMax + 0.05 * zSpan,
          colorscale: SHARPE_COLORSCALE,
        },
        marker: {
          size: 3,
          color: z,
          cmin: zMin - 0.05 * zSpan,
          cmax: zMax + 0.05 * zSpan,
          colorscale: SHARPE_COLORSCALE,
        },
        hovertemplate:
          'Vol: %{x:.2f}%<br>Ret: %{y:.2f}%<br>Sharpe: %{z:.3f}<extra></extra>',
      },
      {
        type: 'scatter3d',
        mode: 'markers+text',
        x: [ms.volatility * 100],
        y: [ms.return * 100],
        z: [ms.sharpe],
        text: ['max sharpe'],
        textposition: 'top center',
        textfont: { family: 'IBM Plex Mono, monospace', size: 10, color: '#4caf7d' },
        marker: {
          symbol: 'diamond',
          size: 10,
          color: '#4caf7d',
          line: { width: 1, color: '#080808' },
        },
        hovertemplate: 'max sharpe<extra></extra>',
      },
      {
        type: 'scatter3d',
        mode: 'markers+text',
        x: [mv.volatility * 100],
        y: [mv.return * 100],
        z: [mv.sharpe],
        text: ['min var'],
        textposition: 'top center',
        textfont: { family: 'IBM Plex Mono, monospace', size: 10, color: '#f0ece4' },
        marker: {
          symbol: 'circle',
          size: 10,
          color: '#f0ece4',
          line: { width: 1, color: '#080808' },
        },
        hovertemplate: 'min var<extra></extra>',
      },
    ]

    const lay = {
      ...PLOTLY_BASE,
      showlegend: false,
      scene: {
        bgcolor: '#080808',
        xaxis: { ...sceneAxis('Vol %') },
        yaxis: { ...sceneAxis('Return %') },
        zaxis: { ...sceneAxis('Sharpe') },
        camera: { eye: { x: 1.4, y: -1.6, z: 0.8 } },
      },
      autosize: true,
    }

    return { data: traces, layout: lay }
  }, [frontier])

  if (!Array.isArray(frontier) || frontier.length === 0) return null

  if (!Plot || typeof Plot !== 'function') {
    return <div style={loadingStyle}>Loading chart...</div>
  }

  return (
    <div>
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
        3D Efficient frontier surface — Volatility × Return × Sharpe
      </div>
      <div
        style={{
          width: '100%',
          height: 400,
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
