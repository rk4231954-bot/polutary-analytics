"""Request helpers shared by the route modules."""

from __future__ import annotations

from typing import Any

from flask import request

from app.utils.errors import ApiError


def json_body() -> dict[str, Any]:
    """Returns the JSON body.

    Requiring application/json also blocks simple cross-site form posts.
    """
    if not request.is_json:
        raise ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Send the request body as application/json.")
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        raise ApiError(400, "INVALID_JSON", "The request body must be a JSON object.")
    return data


def client_ip() -> str:
    # request.remote_addr is already corrected by ProxyFix when TRUST_PROXY_COUNT > 0.
    return (request.remote_addr or "unknown")[:45]


def user_agent() -> str:
    return (request.user_agent.string or "")[:255]


def query_int(name: str, default: int, *, minimum: int = 1, maximum: int = 1000) -> int:
    raw = request.args.get(name)
    if raw is None or raw == "":
        return default
    try:
        value = int(raw)
    except ValueError as exc:
        raise ApiError(400, "BAD_QUERY", f"Query parameter '{name}' must be a number.") from exc
    return max(minimum, min(maximum, value))


def query_id(name: str) -> int | None:
    """Optional positive integer id from the query string (400 BAD_QUERY if malformed)."""
    raw = request.args.get(name, "").strip()
    if not raw:
        return None
    if not raw.isdigit() or int(raw) < 1:
        raise ApiError(400, "BAD_QUERY", f"Query parameter '{name}' must be a positive id.")
    return int(raw)
