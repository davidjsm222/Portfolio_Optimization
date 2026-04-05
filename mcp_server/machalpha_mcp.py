"""MCP server exposing machAlpha project introspection tools."""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path

from fastmcp import FastMCP

PROJECT_ROOT = Path("/Users/davidsmith/projectHighland/portfolio_optimization").resolve()

IGNORE_DIRS = frozenset({"node_modules", "venv", ".venv", "__pycache__", ".git", "dist"})

KEY_FILES = [
    "backend/engine/backtest.py",
    "backend/engine/optimizer.py",
    "backend/engine/risk.py",
    "backend/engine/factors.py",
    "backend/engine/signals.py",
    "backend/engine/returns.py",
    "backend/data/universe.py",
    "backend/data/fetcher.py",
    "backend/api/routes/backtest.py",
    "backend/api/routes/optimize.py",
    "backend/api/main.py",
    "frontend/src/pages/Backtest.jsx",
    "frontend/src/pages/Optimizer.jsx",
    "frontend/src/pages/Factors.jsx",
    "frontend/src/pages/Risk.jsx",
    "frontend/src/pages/Signals.jsx",
]

_FUNCTION_LINE_RE = re.compile(r"^(async\s+)?def\s+\w+")

mcp = FastMCP("machAlpha")


def _safe_resolve_under_root(rel: str) -> Path | None:
    rel = rel.strip().lstrip("/")
    if not rel or ".." in Path(rel).parts:
        return None
    candidate = (PROJECT_ROOT / rel).resolve()
    try:
        candidate.relative_to(PROJECT_ROOT)
    except ValueError:
        return None
    return candidate


def _prune_walk_dirs(dirs: list[str]) -> None:
    dirs[:] = [d for d in dirs if d not in IGNORE_DIRS]


@mcp.tool
def get_project_structure() -> str:
    """Walk the project tree (from project root), skipping common heavy/ignored dirs. Returns a tree-style string."""
    lines: list[str] = [f"{PROJECT_ROOT}/"]
    root_str = str(PROJECT_ROOT)

    for dirpath, dirnames, filenames in os.walk(root_str, topdown=True):
        _prune_walk_dirs(dirnames)
        current = Path(dirpath).resolve()
        rel_depth = (
            0 if current == PROJECT_ROOT else len(current.relative_to(PROJECT_ROOT).parts)
        )
        indent = "  " * (rel_depth + 1)
        for name in sorted(dirnames):
            lines.append(f"{indent}{name}/")
        for name in sorted(filenames):
            lines.append(f"{indent}{name}")

    return "\n".join(lines)


@mcp.tool
def read_file(relative_path: str) -> str:
    """Read a file by path relative to project root. Returns file text or 'File not found'."""
    path = _safe_resolve_under_root(relative_path)
    if path is None or not path.is_file():
        return "File not found"
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return "File not found"


@mcp.tool
def get_key_files() -> dict[str, str]:
    """Load all canonical engine/API/frontend source files in one response (path -> content, or error message)."""
    out: dict[str, str] = {}
    for rel in KEY_FILES:
        path = PROJECT_ROOT / rel
        if not path.is_file():
            out[rel] = "File not found"
            continue
        try:
            out[rel] = path.read_text(encoding="utf-8", errors="replace")
        except OSError as e:
            out[rel] = f"File not found: {e}"
    return out


@mcp.tool
def search_code(query: str) -> list[dict[str, str | int]]:
    """Search all .py and .jsx files under the project for a literal substring (case-sensitive)."""
    if not query:
        return []

    hits: list[dict[str, str | int]] = []
    for dirpath, dirnames, filenames in os.walk(str(PROJECT_ROOT), topdown=True):
        _prune_walk_dirs(dirnames)
        for fname in filenames:
            if not (fname.endswith(".py") or fname.endswith(".jsx")):
                continue
            fpath = Path(dirpath) / fname
            try:
                text = fpath.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            rel = str(fpath.relative_to(PROJECT_ROOT))
            for i, line in enumerate(text.splitlines(), start=1):
                if query in line:
                    hits.append({"file": rel, "line": i, "content": line.rstrip("\n\r")})
    return hits


@mcp.tool
def get_recent_changes(n_commits: int = 10) -> str:
    """Run `git log -n N --stat --oneline` from the project root and return stdout/stderr text."""
    n = max(1, min(int(n_commits), 500))
    try:
        proc = subprocess.run(
            ["git", "log", f"-{n}", "--stat", "--oneline"],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            timeout=120,
        )
    except (OSError, subprocess.SubprocessError) as e:
        return f"git error: {e}"
    out = (proc.stdout or "").strip()
    err = (proc.stderr or "").strip()
    if proc.returncode != 0:
        return err or out or f"git exited with code {proc.returncode}"
    if err:
        return f"{out}\n{err}" if out else err
    return out or "(no output)"


@mcp.tool
def get_module_summary() -> dict[str, dict[str, object]]:
    """Per key file: line count and list of function-definition lines (def / async def)."""
    summary: dict[str, dict[str, object]] = {}
    for rel in KEY_FILES:
        path = PROJECT_ROOT / rel
        if not path.is_file():
            summary[rel] = {"lines": 0, "functions": []}
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            summary[rel] = {"lines": 0, "functions": []}
            continue
        lines = text.splitlines()
        funcs = [
            line.rstrip("\n\r")
            for line in lines
            if _FUNCTION_LINE_RE.match(line.lstrip())
        ]
        summary[rel] = {"lines": len(lines), "functions": funcs}
    return summary


if __name__ == "__main__":
    mcp.run()
