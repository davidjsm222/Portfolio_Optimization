import api from './client.js'

export function analyzeRisk(params) {
  return api.post('/risk/analyze', params)
}

export function getRiskMetrics() {
  return api.get('/risk/metrics')
}

/** @param {Record<string, unknown>} params */
export function buildRiskStreamUrl(params) {
  const {
    tickers,
    start,
    end,
    weights,
    confidence = 0.95,
    run_cvar_optimize: runCvarOptimize = false,
    target_return: targetReturn,
  } = params
  const u = new URL('/api/risk/stream', window.location.origin)
  u.searchParams.set('tickers', Array.isArray(tickers) ? tickers.join(',') : String(tickers))
  u.searchParams.set('start', String(start))
  u.searchParams.set('end', String(end))
  u.searchParams.set('weights', JSON.stringify(weights ?? {}))
  u.searchParams.set('confidence', String(confidence))
  u.searchParams.set('run_cvar_optimize', String(!!runCvarOptimize))
  if (targetReturn != null && targetReturn !== '') {
    u.searchParams.set('target_return', String(targetReturn))
  }
  return u.toString()
}
