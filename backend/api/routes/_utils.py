"""Shared helpers for API route handlers (SSE, JSON-safe serialization)."""

from __future__ import annotations

import json
from typing import Any

from pydantic import BaseModel


def json_dumps_sse(obj: Any) -> str:
    """Serialize for SSE payloads; str fallback for non-JSON types."""

    def _default(o: Any) -> Any:
        if isinstance(o, BaseModel):
            return o.model_dump(mode="json")
        raise TypeError(f"Object of type {type(o).__name__} is not JSON serializable")

    try:
        return json.dumps(obj, default=_default)
    except TypeError:
        return json.dumps(obj, default=str)


def sse_data_line(payload: dict[str, Any]) -> str:
    """One Server-Sent Event line (no event: field)."""
    return f"data: {json_dumps_sse(payload)}\n\n"


def query_bool(v: bool | str | None, default: bool = False) -> bool:
    if v is None:
        return default
    if isinstance(v, bool):
        return v
    s = str(v).strip().lower()
    if s in ("true", "1", "yes"):
        return True
    if s in ("false", "0", "no", ""):
        return False
    return default


def query_opt_float(v: float | str | None) -> float | None:
    if v is None or v == "":
        return None
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x
