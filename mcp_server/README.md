# machAlpha MCP server

Local [Model Context Protocol](https://modelcontextprotocol.io/) server that exposes this repository to supporting clients (tree walk, reads, search, git log, summaries).

## Requirements

- **Python 3.10+** (required by `fastmcp`)

Install the dependency (from project root):

```bash
pip install fastmcp --break-system-packages
```

If your `pip` does not support `--break-system-packages`, use a virtualenv or `pip install --user fastmcp`, or:

```bash
python3 -m pip install fastmcp
```

## Run manually

From the project root:

```bash
python3 mcp_server/machalpha_mcp.py
```

The server uses the default **stdio** transport (for Claude Code, Cursor, and similar MCP hosts).

## Register with Claude Code

From the **project root** (`portfolio_optimization`):

```bash
claude mcp add machalpha python mcp_server/machalpha_mcp.py
```

Use the same `python` interpreter where `fastmcp` is installed. If you use a venv, point `python` at that venv’s binary or use an absolute path.

## Add to Cursor

1. Open or create `~/.cursor/mcp.json`.
2. Merge a `machalpha` entry under `mcpServers` (adjust the Python path and script path if needed):

```json
{
  "mcpServers": {
    "machalpha": {
      "command": "/usr/bin/python3",
      "args": [
        "/Users/davidsmith/projectHighland/portfolio_optimization/mcp_server/machalpha_mcp.py"
      ]
    }
  }
}
```

- **`command`**: Must be a Python **3.10+** that has `fastmcp` installed (conda, Homebrew, `pyenv`, or a venv interpreter).
- **`args`**: Absolute path to `mcp_server/machalpha_mcp.py` is most reliable; the server hardcodes `PROJECT_ROOT` to this repo.

Restart Cursor (or reload MCP) after editing `mcp.json`.

## Available tools

| Tool | Description |
|------|-------------|
| `get_project_structure` | Walks the repo from the hardcoded project root, skips `node_modules`, `venv`, `.venv`, `__pycache__`, `.git`, and `dist`. Returns a formatted tree string. |
| `read_file` | Reads one file by path **relative to project root**; returns UTF-8 text or `File not found`. Traversal outside the repo is rejected. |
| `get_key_files` | Returns a map of path → full file contents for the canonical backend/frontend files (engine, data, API routes, main app, key React pages). Missing files map to `File not found`. |
| `search_code` | Case-sensitive literal substring search across all `.py` and `.jsx` files; skips the same ignored directories as the tree walk. Returns a list of `{ file, line, content }` objects. |
| `get_recent_changes` | Runs `git log -N --stat --oneline` (default `N=10`, clamped 1–500) with cwd at project root; returns combined output text (or git error message). |
| `get_module_summary` | For each key file, returns `{ lines, functions }` where `functions` is the list of lines that look like top-level `def` / `async def` after stripping leading whitespace (Python files; JSX typically has few or none). |

The server name exposed to MCP clients is **machAlpha** (`FastMCP("machAlpha")`).
