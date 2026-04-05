import api from './client.js'

export function runOptimize(params) {
  return api.post('/optimize/run', params)
}

export function getMethods() {
  return api.get('/optimize/methods')
}

/** @param {Record<string, unknown>} params */
export function buildOptimizeStreamUrl(params) {
  const {
    tickers,
    start,
    end,
    method,
    allow_short = false,
    target_return: targetReturn,
    n_points: nPoints = 50,
    use_ledoit_wolf: useLedoitWolf = true,
    signal_blend: signalBlend = 0,
  } = params
  const u = new URL('/api/optimize/stream', window.location.origin)
  u.searchParams.set('tickers', Array.isArray(tickers) ? tickers.join(',') : String(tickers))
  u.searchParams.set('start', String(start))
  u.searchParams.set('end', String(end))
  u.searchParams.set('method', String(method))
  u.searchParams.set('allow_short', String(!!allow_short))
  u.searchParams.set('n_points', String(nPoints))
  u.searchParams.set('use_ledoit_wolf', String(!!useLedoitWolf))
  u.searchParams.set('signal_blend', String(signalBlend))
  if (targetReturn != null && targetReturn !== '') {
    u.searchParams.set('target_return', String(targetReturn))
  }
  return u.toString()
}
