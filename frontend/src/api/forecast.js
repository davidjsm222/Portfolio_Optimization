import api from './client.js'

export function runForecast(params) {
  return api.post('/forecast/run', params)
}

/** @param {{ tickers: string[], lookback_days?: number, method: string, use_signal_blend: boolean }} params */
export function buildForecastStreamUrl(params) {
  const {
    tickers,
    lookback_days: lookbackDays = 400,
    method,
    use_signal_blend: useSignalBlend,
  } = params
  const u = new URL('/api/forecast/stream', window.location.origin)
  u.searchParams.set('tickers', Array.isArray(tickers) ? tickers.join(',') : String(tickers))
  u.searchParams.set('lookback_days', String(lookbackDays))
  u.searchParams.set('method', String(method))
  u.searchParams.set('use_signal_blend', String(!!useSignalBlend))
  return u.toString()
}
