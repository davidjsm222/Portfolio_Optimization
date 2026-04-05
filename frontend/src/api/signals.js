import api from './client.js'

export function generateSignals(params) {
  return api.post('/signals/generate', params)
}

export function getSignalsInfo() {
  return api.get('/signals/info')
}

/** @param {Record<string, unknown>} params */
export function buildSignalsStreamUrl(params) {
  const {
    tickers,
    start,
    end,
    signal_weight: signalWeight = 0.3,
    momentum_lookback: momentumLookback = 252,
    reversion_lookback: reversionLookback = 5,
  } = params
  const u = new URL('/api/signals/stream', window.location.origin)
  u.searchParams.set('tickers', Array.isArray(tickers) ? tickers.join(',') : String(tickers))
  u.searchParams.set('start', String(start))
  u.searchParams.set('end', String(end))
  u.searchParams.set('signal_weight', String(signalWeight))
  u.searchParams.set('momentum_lookback', String(momentumLookback))
  u.searchParams.set('reversion_lookback', String(reversionLookback))
  return u.toString()
}
