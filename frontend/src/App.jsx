import { Routes, Route, Outlet } from 'react-router-dom'
import '@fontsource/ibm-plex-mono/latin-400.css'

import Sidebar from './components/Sidebar.jsx'
import Backtest from './pages/Backtest'
import Optimizer from './pages/Optimizer.jsx'
import Factors from './pages/Factors.jsx'
import Risk from './pages/Risk.jsx'
import Signals from './pages/Signals.jsx'

function Layout() {
  return (
    <div className="app-shell">
      <Sidebar />
      <div className="app-main">
        <Outlet />
      </div>
    </div>
  )
}

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Optimizer />} />
        <Route path="/factors" element={<Factors />} />
        <Route path="/risk" element={<Risk />} />
        <Route path="/signals" element={<Signals />} />
        <Route path="/backtest" element={<Backtest />} />
      </Route>
    </Routes>
  )
}
