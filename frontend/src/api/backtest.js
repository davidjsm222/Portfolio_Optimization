import api from './client.js'

/** @param {Record<string, unknown>} params */
export function buildBacktestStreamUrl(params) {
  const {
    tickers,
    start,
    end,
    estimation_window,
    rebalance_freq,
    drift_threshold,
    signal_blend,
    starting_capital,
    use_point_in_time,
    pit_universe_type,
  } = params
  const u = new URL('/api/backtest/stream', window.location.origin)
  if (!use_point_in_time) {
    u.searchParams.set('tickers', tickers.join(','))
  }
  u.searchParams.set('start', start)
  u.searchParams.set('end', end)
  u.searchParams.set('estimation_window', String(estimation_window))
  u.searchParams.set('rebalance_freq', rebalance_freq)
  u.searchParams.set('drift_threshold', String(drift_threshold))
  u.searchParams.set('signal_blend', String(signal_blend))
  u.searchParams.set('starting_capital', String(starting_capital))
  u.searchParams.set('use_point_in_time', String(Boolean(use_point_in_time)))
  if (use_point_in_time && pit_universe_type) {
    u.searchParams.set('pit_universe_type', String(pit_universe_type))
  }
  return u.toString()
}

export function runBacktest(params) {
  return api.post('/backtest/run', params)
}

export function getRegimes() {
  return api.get('/backtest/regimes')
}

/** @param {Record<string, unknown>} params */
export function optimizeThreshold(params) {
  return api.post('/backtest/optimize-threshold', params)
}
