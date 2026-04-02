import api from './client.js'

export function runOptimize(params) {
  return api.post('/optimize/run', params)
}

export function getMethods() {
  return api.get('/optimize/methods')
}
