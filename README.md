# machAlpha — Portfolio Optimization Engine

*A quantitative portfolio optimization and backtesting platform built for research.*

## Overview

machAlpha bundles multi-method portfolio optimization (mean-variance, max Sharpe, risk parity, CVaR), Fama–French-style factor analysis, signal generation, and rolling backtesting with regime analysis in one stack. It is meant to be both a usable tool and a research codebase for an undergraduate quant finance paper at the University of Michigan IOE.

This README is a **draft** and describes the project honestly as work in progress.

## Stack

| Layer | Technologies |
|--------|----------------|
| **Backend** | Python 3.9, FastAPI, CVXPY, SciPy, statsmodels, scikit-learn |
| **Frontend** | React, Vite, Plotly.js, Recharts |
| **Data** | yfinance, pandas-datareader (e.g. Ken French factor data) |

## Setup

**Prerequisites:** Python 3.9+, Node.js 18+

From the **repository root** (the folder that contains `backend/` and `frontend/`):

### Backend

```bash
python3 -m venv venv
source venv/bin/activate   # Windows: venv\Scripts\activate
pip install -r requirements.txt
python -m backend.api.main
```

API base URL: [http://localhost:8000](http://localhost:8000) (e.g. `/api/...`, `/health`).

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

## Pages

| Page | What it covers |
|------|----------------|
| **Optimizer** | Mean-variance, max Sharpe, efficient frontier, risk parity, signal blending |
| **Factors** | Fama–French 5-factor regression, factor attribution |
| **Risk** | VaR, CVaR, max drawdown, CVaR optimization |
| **Signals** | Momentum, cross-sectional momentum, mean reversion |
| **Backtest** | Rolling-window backtest, equity curves, regime analysis, shrinkage intensity |

## Research

The tool supports ongoing work on **regime-dependent portfolio optimization**. For the hypothesis framework and findings so far, see **`RESEARCH_ROADMAP.pdf`** in this repo.

## Status

**Active development — v0.1.0.** This README will be updated as the project matures.

## Author

**David Smith** · University of Michigan IOE · Class of 2029
