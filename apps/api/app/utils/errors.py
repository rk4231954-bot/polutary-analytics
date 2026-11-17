"""Consistent JSON errors: {"error": {"code": ..., "message": ..., "fields": {...}}}."""

from __future__ import annotations

from flask import Flask, jsonify
from flask_jwt_extended.exceptions import CSRFError
from werkzeug.exceptions import HTTPException


class ApiError(Exception):
    """Raise from any route/service to return a structured error response."""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        fields: dict[str, str] | None = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.fields = fields or {}
        self.headers = headers or {}


class ValidationError(ApiError):
    def __init__(
        self, fields: dict[str, str], message: str = "Please correct the highlighted fields."
    ) -> None:
        super().__init__(400, "VALIDATION_ERROR", message, fields)


def error_response(status: int, code: str, message: str, fields: dict | None = None, headers=None):
    body: dict = {"error": {"code": code, "message": message}}
    if fields:
        body["error"]["fields"] = fields
    response = jsonify(body)
    response.status_code = status
    for key, value in (headers or {}).items():
        response.headers[key] = value
    return response


HTTP_CODES = {
    400: ("BAD_REQUEST", "The request could not be understood."),
    401: ("AUTH_REQUIRED", "Please sign in to continue."),
    403: ("FORBIDDEN", "You do not have permission to perform this action."),
    404: ("NOT_FOUND", "The requested resource was not found."),
    405: ("METHOD_NOT_ALLOWED", "This method is not allowed for this endpoint."),
    413: ("PAYLOAD_TOO_LARGE", "The request body is too large."),
    415: ("UNSUPPORTED_MEDIA_TYPE", "Send the request body as application/json."),
    429: ("TOO_MANY_REQUESTS", "Too many requests. Please wait and try again."),
}


def register_error_handlers(app: Flask) -> None:
    @app.errorhandler(ApiError)
    def _api_error(error: ApiError):
        return error_response(error.status, error.code, error.message, error.fields, error.headers)

    @app.errorhandler(CSRFError)
    def _csrf_error(_error):
        # 403, not 401: the session is valid, the request just lacks the CSRF header.
        return error_response(
            403, "CSRF_FAILED", "Security token missing or invalid. Reload the page and try again."
        )

    @app.errorhandler(HTTPException)
    def _http_error(error: HTTPException):
        status = error.code or 500
        if status == 404:
            # Distinguishes "no such endpoint" from "no such record" (NOT_FOUND).
            return error_response(404, "ENDPOINT_NOT_FOUND", "This API endpoint does not exist.")
        code, message = HTTP_CODES.get(
            status, (f"HTTP_{status}", error.description or "Request failed.")
        )
        return error_response(status, code, message)

    @app.errorhandler(Exception)
    def _unexpected(error: Exception):
        app.logger.exception("Unhandled error: %s", type(error).__name__)
        return error_response(
            500, "INTERNAL_ERROR", "An unexpected error occurred. Please try again."
        )
