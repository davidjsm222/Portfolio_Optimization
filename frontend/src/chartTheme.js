/** Editorial chart defaults for Recharts (B&W UI, mono ticks). */
export const CHART_GRID = { stroke: '#1e1e1e', strokeWidth: 0.5 }

export const CHART_TICK = {
  fill: '#444',
  fontFamily: 'IBM Plex Mono, monospace',
  fontSize: 10,
}

export const CHART_AXIS_STROKE = '#2a2a2a'

export const CHART_TOOLTIP_STYLE = {
  background: '#0d0d0d',
  border: '1px solid #2a2a2a',
  fontFamily: 'IBM Plex Mono, monospace',
  fontSize: 11,
  color: '#f0ece4',
}

export const CHART_LEGEND_STYLE = {
  fontFamily: 'IBM Plex Mono, monospace',
  fontSize: 10,
  color: '#444',
}

export const CHART_NEUTRAL = '#f0ece4'
export const CHART_POS = '#4caf7d'
export const CHART_NEG = '#e05555'
export const REF_LINE_STROKE = '#2a2a2a'

/** Plotly.js shared layout (editorial dark theme). */
export const PLOTLY_BASE = {
  paper_bgcolor: '#080808',
  plot_bgcolor: '#080808',
  font: { family: 'IBM Plex Mono, monospace', color: '#444', size: 10 },
  margin: { l: 60, r: 40, t: 20, b: 60 },
}

export const PLOTLY_AXIS = {
  gridcolor: '#1a1a1a',
  zerolinecolor: '#2a2a2a',
  tickfont: { family: 'IBM Plex Mono, monospace', size: 9, color: '#444' },
  titlefont: { family: 'IBM Plex Mono, monospace', size: 10, color: '#555' },
  color: '#444',
}
