import axios from 'axios'

const api = axios.create({
  baseURL: 'http://localhost:8000/api',
})

api.interceptors.request.use((config) => {
  const method = (config.method || 'get').toUpperCase()
  const path = config.url || ''
  console.log(`[API] ${method} ${path}`)
  return config
})

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const msg = error.response?.data?.detail || error.message || String(error)
    console.error('[API] error:', msg, error.response?.status, error.config?.url)
    return Promise.reject(error)
  },
)

export default api
