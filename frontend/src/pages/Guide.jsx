import './Guide.css'

const PAGES_ROWS = [
  [
    'Optimizer',
    'Single-period portfolio optimization over a user-defined date range',
    'Optimal weights, efficient frontier, factor exposures',
  ],
  [
    'Factors',
    'Fama-French 5-factor regression on individual stocks',
    'Factor loadings, portfolio factor exposure, attribution',
  ],
  [
    'Risk',
    'Tail risk analysis — VaR, CVaR, drawdown',
    'Risk metrics, CVaR-optimized portfolio',
  ],
  [
    'Signals',
    'Quantitative signal generation for expected return estimation',
    'Momentum scores, adjusted expected returns',
  ],
  [
    'Backtest',
    'Rolling window out-of-sample backtesting',
    'Equity curves, regime performance, shrinkage intensity series',
  ],
  [
    'Forecast',
    'Forward allocation based on trailing window + current signals',
    'Recommended weights for next month',
  ],
]

const GLOSSARY_ROWS = [
  [
    'Annualized Return',
    'Mean daily log return × 252',
    '> 10% for equity portfolios',
    'Higher = better absolute performance',
  ],
  [
    'Volatility',
    'Std dev of daily returns × √252',
    '< 20% for diversified portfolio',
    'Lower = smoother ride',
  ],
  [
    'Sharpe Ratio',
    'Ann. return / ann. volatility (rf=0)',
    '> 1.0 excellent, > 0.5 good',
    'Higher = better risk-adjusted return',
  ],
  [
    'Max Drawdown',
    'Largest peak-to-trough loss',
    '> -20% concerning',
    'Closer to 0 = better downside protection',
  ],
  [
    'Calm Drawdown',
    'Max drawdown excluding COVID crash and 2022 rate shock',
    '> -15% concerning',
    'Strategy-specific risk excluding exogenous shocks',
  ],
  [
    'Calmar Ratio',
    'Ann. return / abs(max drawdown)',
    '> 0.5 good',
    'Higher = better return per unit of drawdown risk',
  ],
  [
    'Calmar',
    'Ann. return ÷ |max drawdown|',
    '> 0.5',
    'Return earned per unit of worst-case loss',
  ],
  [
    'VaR 95%',
    'Worst daily loss on 95% of days',
    '< -2% concerning',
    'More negative = larger typical bad day',
  ],
  [
    'CVaR 95%',
    'Average loss on the worst 5% of days',
    '< -3% concerning',
    'More negative = worse tail behavior',
  ],
  [
    'Shrinkage Intensity (α)',
    'How much to distrust the covariance estimate',
    '< 0.05 low, 0.05–0.10 medium, > 0.10 high',
    'Higher = less reliable optimization, more uncertainty',
  ],
  [
    'Factor Loading',
    "Sensitivity of a stock's return to a systematic factor",
    'Varies by factor',
    'Shows what systematic risks you are actually taking',
  ],
  [
    'Momentum Signal',
    'Trailing 12-month cumulative return, skip 1 month',
    '> 0.5 strong positive',
    'Higher = stronger recent outperformance trend',
  ],
]

const FACTOR_ROWS = [
  [
    'Mkt-RF',
    'Market minus risk-free',
    'Excess return on the market: value-weight return of all CRSP firms minus the one-month T-bill rate.',
    'Lower market beta / defensive versus broad equities.',
    'Higher exposure to broad equity risk premium.',
  ],
  [
    'SMB',
    'Small minus big',
    'Average return on small-cap portfolios minus big-cap portfolios.',
    'Tilt toward large-cap names versus the size factor.',
    'Tilt toward small-cap names (size premium).',
  ],
  [
    'HML',
    'High minus low (book-to-market)',
    'Average return on high book-to-market portfolios minus low book-to-market.',
    'Growth / low book-to-market tilt.',
    'Value / high book-to-market tilt.',
  ],
  [
    'RMW',
    'Robust minus weak (profitability)',
    'Profitable firms minus unprofitable (operating profitability).',
    'Tilt toward weaker profitability.',
    'Tilt toward robust profitability.',
  ],
  [
    'CMA',
    'Conservative minus aggressive (investment)',
    'Firms with conservative investment minus aggressive investment.',
    'Tilt toward aggressive asset growth.',
    'Tilt toward conservative investment policies.',
  ],
  [
    'RF',
    'Risk-free rate',
    'One-month Treasury bill rate from Ken French; used to form excess returns in regressions.',
    '—',
    '—',
  ],
]

export default function Guide() {
  return (
    <main className="page page--guide">
      <article className="guide">
        <header className="guide__masthead">
          <h1 className="guide__masthead-title">Guide</h1>
          <p className="guide__masthead-dateline">machAlpha · reference</p>
        </header>

        <h2 className="guide__section-heading">What is machAlpha</h2>
        <p className="guide__p">
          machAlpha is a quantitative portfolio optimization and backtesting platform built for
          research. It implements five methodologies — mean-variance optimization, Fama-French factor
          analysis, tail risk metrics, signal generation, and rolling backtesting — on a 50 or
          100-stock universe of US equities.
        </p>
        <p className="guide__p">
          The platform was built to support original research into regime-dependent portfolio
          optimization at the University of Michigan IOE. It is not a trading system and does not
          provide investment advice.
        </p>

        <h2 className="guide__section-heading">The pages</h2>
        <div className="guide__table-wrap">
          <table className="guide__table">
            <thead>
              <tr>
                <th>Page</th>
                <th>Purpose</th>
                <th>Key output</th>
              </tr>
            </thead>
            <tbody>
              {PAGES_ROWS.map(([page, purpose, output]) => (
                <tr key={page}>
                  <td className="guide__mono">{page}</td>
                  <td className="guide__serif">{purpose}</td>
                  <td className="guide__serif">{output}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2 className="guide__section-heading">Optimization methods</h2>
        <div className="guide__method-block">
          <div className="guide__method-title">Min variance</div>
          <p className="guide__method-def">
            Minimizes portfolio volatility regardless of return.
          </p>
          <p className="guide__method-when">
            <strong>When to use:</strong> Capital preservation is the priority.
          </p>
        </div>
        <div className="guide__method-block">
          <div className="guide__method-title">Max Sharpe</div>
          <p className="guide__method-def">Maximizes return per unit of risk.</p>
          <p className="guide__method-when">
            <strong>When to use:</strong> Seeking the best risk-adjusted allocation.
          </p>
        </div>
        <div className="guide__method-block">
          <div className="guide__method-title">Risk parity</div>
          <p className="guide__method-def">
            Each asset contributes equally to total portfolio risk.
          </p>
          <p className="guide__method-when">
            <strong>When to use:</strong> You distrust return estimates.
          </p>
        </div>
        <div className="guide__method-block">
          <div className="guide__method-title">CVaR optimization</div>
          <p className="guide__method-def">
            Minimizes expected loss in the worst 5% of scenarios.
          </p>
          <p className="guide__method-when">
            <strong>When to use:</strong> Tail risk is the primary concern.
          </p>
        </div>

        <h2 className="guide__section-heading">Metrics glossary</h2>
        <div className="guide__table-wrap">
          <table className="guide__table">
            <thead>
              <tr>
                <th>Metric</th>
                <th>Definition</th>
                <th>Good value</th>
                <th>What it signals</th>
              </tr>
            </thead>
            <tbody>
              {GLOSSARY_ROWS.map(([metric, def, good, signal]) => (
                <tr key={metric}>
                  <td className="guide__mono">{metric}</td>
                  <td className="guide__serif">{def}</td>
                  <td className="guide__mono">{good}</td>
                  <td className="guide__serif">{signal}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2 className="guide__section-heading">The Fama-French factors</h2>
        <p className="guide__p guide__serif">
          Factor definitions match the engine reference (see{' '}
          <code>backend/engine/ENGINE_REFERENCE.pdf</code>).
        </p>
        <div className="guide__table-wrap">
          <table className="guide__table">
            <thead>
              <tr>
                <th>Factor</th>
                <th>Full name</th>
                <th>What it captures</th>
                <th>Negative loading means</th>
                <th>Positive loading means</th>
              </tr>
            </thead>
            <tbody>
              {FACTOR_ROWS.map(([factor, fullName, captures, neg, pos]) => (
                <tr key={factor}>
                  <td className="guide__mono">{factor}</td>
                  <td className="guide__serif">{fullName}</td>
                  <td className="guide__serif">{captures}</td>
                  <td className="guide__serif">{neg}</td>
                  <td className="guide__serif">{pos}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h2 className="guide__section-heading">Research context</h2>
        <p className="guide__p">
          The core research question is whether <strong>regime-dependent</strong> portfolio rules
          improve out-of-sample performance versus static optimization. Ledoit–Wolf{' '}
          <strong>shrinkage intensity</strong> (α) is treated as a{' '}
          <strong>market uncertainty indicator</strong>: when covariance estimates are less
          reliable, allocation rules and signal weights should adapt rather than chase noisy moments.
        </p>
        <p className="guide__p">
          Empirical work to date follows six hypotheses: <strong>H1</strong> links Ledoit–Wolf
          shrinkage intensity to regime shifts in covariance reliability; <strong>H2</strong>{' '}
          compares optimizer rankings in calm versus stress windows; <strong>H3</strong> tests
          signal-blending rules when α is elevated; <strong>H4</strong> orders methods by tail risk;
          <strong>H5</strong> attributes drawdowns with &ldquo;calm&rdquo; windows that exclude the
          COVID crash and 2022 rate shock; <strong>H6</strong> examines rebalancing and trailing
          window design. Numbers, tables, and interpretation evolve with the working paper.
        </p>
        <p className="guide__p">
          The full research roadmap, bibliography, and current findings are documented in{' '}
          <code>RESEARCH_ROADMAP.pdf</code> in the project root.
        </p>

        <footer className="guide__footer">machAlpha · Portfolio Optimization Engine</footer>
      </article>
    </main>
  )
}
