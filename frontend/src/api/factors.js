import api from './client.js'

export function analyzeFactors(params) {
  return api.post('/factors/analyze', params)
}

export function getFactorDefinitions() {
  return api.get('/factors/definitions')
}

/** @param {{ tickers: string[], start: string, end: string, weights?: Record<string, number> }} params */
export function buildFactorsStreamUrl(params) {
  const { tickers, start, end, weights } = params
  const u = new URL('/api/factors/stream', window.location.origin)
  u.searchParams.set('tickers', tickers.join(','))
  u.searchParams.set('start', start)
  u.searchParams.set('end', end)
  if (weights && typeof weights === 'object' && Object.keys(weights).length > 0) {
    u.searchParams.set('weights', JSON.stringify(weights))
  }
  return u.toString()
}
