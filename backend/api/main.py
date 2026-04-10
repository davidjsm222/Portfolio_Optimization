"""Portfolio Optimizer FastAPI application."""

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

from backend.api.routes import backtest, factors, forecast, optimize, risk, signals

APP_VERSION = "0.1.0"

# Only watch application code so reload does not scan venv/site-packages (noisy, can crash mid-install).
_BACKEND_SRC = Path(__file__).resolve().parent.parent

app = FastAPI(title="Portfolio Optimizer API", version=APP_VERSION)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(optimize.router, prefix="/api")
app.include_router(factors.router, prefix="/api")
app.include_router(risk.router, prefix="/api")
app.include_router(signals.router, prefix="/api")
app.include_router(backtest.router, prefix="/api")
app.include_router(forecast.router, prefix="/api")


@app.get("/health")
def health():
    return {"status": "ok", "version": APP_VERSION}


@app.get("/")
def root():
    """List registered HTTP endpoints (method + path)."""
    entries: set[str] = set()
    for route in app.routes:
        path = getattr(route, "path", None)
        methods = getattr(route, "methods", None)
        if not path or not methods:
            continue
        for m in methods:
            if m == "HEAD":
                continue
            entries.add(f"{m} {path}")
    return sorted(entries)


if __name__ == "__main__":
    uvicorn.run(
        "backend.api.main:app",
        host="0.0.0.0",
        port=8000,
        reload=True,
        reload_dirs=[str(_BACKEND_SRC)],
    )
