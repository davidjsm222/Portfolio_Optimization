import api from './client.js'

export function generateSignals(params) {
  return api.post('/signals/generate', params)
}

export function getSignalsInfo() {
  return api.get('/signals/info')
}
