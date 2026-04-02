import api from './client.js'

export function analyzeRisk(params) {
  return api.post('/risk/analyze', params)
}

export function getRiskMetrics() {
  return api.get('/risk/metrics')
}
