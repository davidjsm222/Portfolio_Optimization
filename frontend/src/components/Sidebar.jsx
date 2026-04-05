import { NavLink } from 'react-router-dom'
import './Sidebar.css'

const links = [
  { to: '/', label: 'Optimizer' },
  { to: '/factors', label: 'Factors' },
  { to: '/signals', label: 'Signals' },
  { to: '/risk', label: 'Risk' },
  { to: '/backtest', label: 'Backtest' },
  { to: '/forecast', label: 'Forecast' },
  { to: '/guide', label: 'Guide' },
]

export default function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <span className="sidebar__title">machAlpha</span>
        <span className="sidebar__subtitle">Portfolio Engine</span>
      </div>
      <nav className="sidebar__nav">
        {links.map(({ to, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `sidebar__link${isActive ? ' sidebar__link--active' : ''}`
            }
          >
            {label}
          </NavLink>
        ))}
      </nav>
      <div className="sidebar__footer">
        <span className="sidebar__version">v0.1.0</span>
      </div>
    </aside>
  )
}
