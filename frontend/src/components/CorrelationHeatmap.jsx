import { useEffect, useState } from 'react'

export default function CorrelationHeatmap({ loadings }) {
  const [Plot, setPlot] = useState(null)

  useEffect(() => {
    import('react-plotly.js').then((m) => {
      const C = m.default?.default ?? m.default
      setPlot(() => C)
    })
  }, [])

  if (!loadings || Object.keys(loadings).length === 0) return null
  if (!Plot || typeof Plot !== 'function') {
    return (
      <div
        style={{
          fontFamily: 'IBM Plex Mono,monospace',
          fontSize: 11,
          color: '#444',
          padding: '20px 0',
        }}
      >
        Loading chart...
      </div>
    )
  }

  const tickers = Object.keys(loadings).sort()
  const factorCols = ['Mkt-RF', 'SMB', 'HML', 'RMW', 'CMA']

  function pearson(a, b) {
    const n = a.length
    const ma = a.reduce((s, v) => s + v, 0) / n
    const mb = b.reduce((s, v) => s + v, 0) / n
    const num = a.reduce((s, v, i) => s + (v - ma) * (b[i] - mb), 0)
    const da = Math.sqrt(a.reduce((s, v) => s + (v - ma) ** 2, 0))
    const db = Math.sqrt(b.reduce((s, v) => s + (v - mb) ** 2, 0))
    return da && db ? num / (da * db) : 0
  }

  const vectors = tickers.map((t) => factorCols.map((f) => Number(loadings[t]?.[f] ?? 0)))
  const z = tickers.map((_, i) =>
    tickers.map((_, j) => +pearson(vectors[i], vectors[j]).toFixed(2)),
  )
  const text = z.map((row) => row.map((v) => v.toFixed(2)))

  const data = [
    {
      type: 'heatmap',
      x: tickers,
      y: tickers,
      z,
      text,
      texttemplate: '%{text}',
      textfont: { family: 'IBM Plex Mono, monospace', size: 10, color: '#f0ece4' },
      colorscale: [
        [0, '#e05555'],
        [0.5, '#080808'],
        [1.0, '#4caf7d'],
      ],
      showscale: false,
      zmin: -1,
      zmax: 1,
    },
  ]

  const layout = {
    paper_bgcolor: '#080808',
    plot_bgcolor: '#080808',
    margin: { l: 60, r: 20, t: 10, b: 60 },
    font: { family: 'IBM Plex Mono, monospace', color: '#444', size: 10 },
    xaxis: {
      tickfont: { family: 'IBM Plex Mono, monospace', size: 10, color: '#888' },
      gridcolor: '#1a1a1a',
      color: '#444',
    },
    yaxis: {
      tickfont: { family: 'IBM Plex Mono, monospace', size: 10, color: '#888' },
      gridcolor: '#1a1a1a',
      color: '#444',
      autorange: 'reversed',
    },
  }

  return (
    <div className="factors__card" style={{ marginTop: '1.25rem' }}>
      <div
        style={{
          fontFamily: 'IBM Plex Mono,monospace',
          fontSize: 9,
          color: '#444',
          letterSpacing: '0.15em',
          textTransform: 'uppercase',
          borderTop: '1px solid #2a2a2a',
          paddingTop: 6,
          marginBottom: 10,
        }}
      >
        Inter-Asset Factor Correlation
      </div>
      <div style={{ border: '1px solid #1e1e1e' }}>
        <Plot
          data={data}
          layout={layout}
          config={{ displayModeBar: false, responsive: true }}
          style={{ width: '100%', height: 320 }}
          useResizeHandler
        />
      </div>
    </div>
  )
}
