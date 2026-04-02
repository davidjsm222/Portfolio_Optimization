import api from './client.js'

export function analyzeFactors(params) {
  return api.post('/factors/analyze', params)
}

export function getFactorDefinitions() {
  return api.get('/factors/definitions')
}
